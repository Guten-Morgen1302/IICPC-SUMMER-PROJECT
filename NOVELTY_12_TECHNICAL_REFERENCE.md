# Novelty 12: Technical Architecture & Code Reference

**Quick Reference for Implementation**  
**3 Main Components, 7 Key Files, 1000 LOC**

---

## 🏗️ System Architecture Overview

```
┌─────────────────────────────────────────────────────────────────┐
│                    Benchmark Run Execution                       │
│                                                                   │
│  [Contestant Engines] → Orders & Fills → Telemetry Events       │
└─────────────────────────────────────────────────────────────────┘
                              ↓
┌─────────────────────────────────────────────────────────────────┐
│            Telemetry Ingestion (EXISTING)                        │
│                                                                   │
│  Redpanda Topic: telemetry.raw                                  │
│  ↓ [Batches of events]                                          │
│  QuestDB: Time-series storage                                   │
│  (stores: order_id, fill_id, latency, timestamps)              │
└─────────────────────────────────────────────────────────────────┘
                              ↓
┌─────────────────────────────────────────────────────────────────┐
│         NEW: Byzantine Detector Service                          │
│                                                                   │
│  1. Fetch orders/fills from QuestDB                             │
│     ↓                                                             │
│  2. Assign Vector Clocks (VectorClockManager)                   │
│     ↓                                                             │
│  3. Validate Causality (CausalityValidator)                     │
│     ↓ Detect causality violations                               │
│     ↓ Flag out-of-order fills                                   │
│     ↓                                                             │
│  4. Detect Collusion (CollusionDetector)                        │
│     ↓ Calculate correlations                                     │
│     ↓ Compute risk scores                                        │
│     ↓ Identify suspicious pairs                                  │
│     ↓                                                             │
│  5. Output: ByzantineAnalysis                                   │
│     ├─ causalityViolationCount                                  │
│     ├─ collusionRiskScore                                       │
│     ├─ recommendation (PASS/WATCH/DISQUALIFY)                  │
│     └─ Store in Postgres                                        │
└─────────────────────────────────────────────────────────────────┘
                              ↓
┌─────────────────────────────────────────────────────────────────┐
│          Scoring Engine (MODIFIED)                               │
│                                                                   │
│  For each submission:                                            │
│    1. Calculate latency/throughput/correctness scores           │
│    2. Query Byzantine analysis from detector                    │
│    3. Apply gating rules:                                       │
│       - If correctness < 0.5 → score = 0                        │
│       - If causality_violations > 0 → score = 0               │
│    4. Apply collusion penalty:                                  │
│       - final_score *= (1 - collusion_risk_score × 0.5)        │
│    5. Publish final score to Redis                             │
└─────────────────────────────────────────────────────────────────┘
                              ↓
┌─────────────────────────────────────────────────────────────────┐
│          Leaderboard API (MODIFIED)                              │
│                                                                   │
│  GET /leaderboard/top                                            │
│    → Returns top engines + Byzantine risk flags                  │
│    ├─ Position + Score (after filtering)                        │
│    ├─ Byzantine Risk: { riskScore, recommendation, violations}  │
│    └─ Clean engines ranked higher than WATCH/DISQUALIFY        │
└─────────────────────────────────────────────────────────────────┘
```

---

## 📂 File Structure (NEW COMPONENTS)

```
packages/
├── shared-types/
│   └── src/
│       ├── index.ts (existing)
│       └── vectorClock.ts (NEW - 150 LOC)
│           ├── VectorClock interface
│           ├── CausalizedOrder interface
│           ├── CausalizedFill interface
│           └── VectorClockManager class

apps/
├── byzantine-detector/ (NEW SERVICE)
│   ├── src/
│   │   ├── index.ts (200 LOC - Main service)
│   │   │   ├── Fastify setup
│   │   │   ├── /analyze-run/:runId endpoint
│   │   │   ├── QuestDB integration
│   │   │   └── Result persistence
│   │   │
│   │   ├── causalityValidator.ts (180 LOC)
│   │   │   ├── detectCausalityViolations()
│   │   │   ├── vectorClockLE() helper
│   │   │   └── Validation rules
│   │   │
│   │   └── collusionDetector.ts (280 LOC)
│   │       ├── CollusionDetector class
│   │       ├── analyzeEnginesPair()
│   │       ├── pearsonCorrelation()
│   │       ├── dynamicTimeWarp()
│   │       └── computeRiskScore()
│   │
│   ├── package.json (NEW)
│   └── tsconfig.json (NEW)

├── scoring-engine/
│   └── src/
│       └── index.ts (MODIFIED +30 LOC)
│           ├── Import Byzantine detector
│           └── Add Byzantine check in computeScore()

├── leaderboard-api/
│   └── src/
│       └── index.ts (MODIFIED +25 LOC)
│           └── Add Byzantine flags to response

packages/
└── db/
    └── schema.prisma (MODIFIED +60 LOC)
        ├── ByzantineAnalysis model
        ├── CausalityViolation model
        └── CollusionAnalysis model
```

---

## 🔑 Key Data Structures

### 1. Vector Clock (In-Memory)
```typescript
// Represents logical time for ordering events
interface VectorClock {
  "Engine-A": 5,      // Engine A's event count
  "Engine-B": 3,      // Engine B's event count
  "Engine-C": 7,      // Engine C's event count
}

// Example evolution:
// Order placed by A: VC = { A: 1, B: 0, C: 0 }
// Order seen by B: VC = { A: 1, B: 1, C: 0 }  (B increments)
// Fill by C: VC = { A: 1, B: 1, C: 1 }        (C increments)
```

### 2. Causalized Order (DB)
```typescript
{
  orderId: "order-123",
  engineId: "Engine-A",
  side: "BUY",
  price: 1000,
  quantity: 100,
  
  // NEW FIELDS:
  vectorClock: { "Engine-A": 5, "Engine-B": 3, ... },
  timestamp: 1621234567890000000n,  // nanoseconds
  priorOrders: ["order-122", "order-121"],  // causal chain
}
```

### 3. Causalized Fill (DB)
```typescript
{
  fillId: "fill-456",
  orderId: "order-123",
  filledBy: "Engine-B",
  filledQuantity: 50,
  filledPrice: 1000,
  
  // NEW FIELDS:
  vectorClock: { "Engine-A": 5, "Engine-B": 4, ... },
  timestamp: 1621234567891234567n,  // nanoseconds
  latency: 1234567n,  // nanoseconds (ack_ts - send_ts)
}
```

### 4. Byzantine Analysis Result (DB)
```typescript
{
  id: "uuid",
  runId: "run-xyz",
  
  // Causality violations
  causalityViolationCount: 0,
  violationDetails: [
    {
      fillId: "fill-999",
      orderId: "order-888",
      reason: "Fill timestamp before order timestamp"
    }
  ],
  
  // Collusion analysis
  collusionRiskScore: 0.42,  // 0-1
  collusionDetails: [
    {
      engineA: "Engine-X",
      engineB: "Engine-Y",
      orderCorrelation: 0.92,
      fillCorrelation: 0.88,
      riskScore: 0.45,
      recommendation: "WATCH"  // or CLEAN, DISQUALIFY
    }
  ],
  
  // Final recommendation
  overallRiskScore: 0.42,
  recommendation: "WATCH",  // or PASS, DISQUALIFY
  
  timestamp: 1621234567000,
  createdAt: "2026-05-23T12:34:56Z"
}
```

---

## 🔗 Integration Points

### Integration 1: Scoring Engine Modification

**File**: `apps/scoring-engine/src/index.ts`

```typescript
// BEFORE (existing code):
function computeCompositeScore(
  latencyScore: number,
  throughputScore: number,
  correctnessScore: number,
  regimeBonus: number
): number {
  if (correctnessScore < 0.5) return 0;
  
  return (0.30 * latencyScore + 
          0.40 * throughputScore + 
          0.30 * correctnessScore) * regimeBonus;
}

// AFTER (with Byzantine check):
async function computeCompositeScore(
  latencyScore: number,
  throughputScore: number,
  correctnessScore: number,
  regimeBonus: number,
  submissionId: string,
  runId: string
): Promise<number> {
  // Gating rule 1: Correctness
  if (correctnessScore < 0.5) return 0;
  
  // NEW: Fetch Byzantine analysis
  try {
    const response = await axios.get(
      `http://localhost:3007/analysis/${runId}`
    );
    const byzantine = response.data;
    
    // Gating rule 2: No causality violations
    if (byzantine.causalityViolationCount > 0) {
      fastify.log.warn(`Submission ${submissionId} has Byzantine violations`);
      return 0;
    }
    
    // Soft penalty: Collusion risk
    const collusionPenalty = 1.0 - (byzantine.collusionRiskScore * 0.5);
    
    // Compute score with penalty
    const baseScore = (0.30 * latencyScore + 
                       0.40 * throughputScore + 
                       0.30 * correctnessScore) * regimeBonus;
    
    return Math.max(0, Math.min(1, baseScore * collusionPenalty));
  } catch (error) {
    fastify.log.error(`Byzantine detector unavailable: ${error}`);
    // Fallback: Use original scoring
    const baseScore = (0.30 * latencyScore + 
                       0.40 * throughputScore + 
                       0.30 * correctnessScore) * regimeBonus;
    return Math.max(0, Math.min(1, baseScore));
  }
}
```

### Integration 2: Leaderboard API Modification

**File**: `apps/leaderboard-api/src/index.ts`

```typescript
// BEFORE:
fastify.get('/leaderboard/top', async (request) => {
  const limit = parseInt((request.query as any).limit || '10', 10);
  const topData = await redis.zrevrange('leaderboard:overall', 0, limit - 1, 'WITHSCORES');
  
  const results = [];
  for (let i = 0; i < topData.length; i += 2) {
    results.push({
      submissionId: topData[i],
      score: parseFloat(topData[i + 1])
    });
  }
  return results;
});

// AFTER:
fastify.get('/leaderboard/top', async (request) => {
  const limit = parseInt((request.query as any).limit || '10', 10);
  const topData = await redis.zrevrange('leaderboard:overall', 0, limit - 1, 'WITHSCORES');
  
  const results = [];
  for (let i = 0; i < topData.length; i += 2) {
    const submissionId = topData[i];
    const score = parseFloat(topData[i + 1]);
    
    // Fetch Byzantine analysis
    const submission = await prisma.submission.findUnique({
      where: { id: submissionId },
      include: { benchmarkRuns: { orderBy: { createdAt: 'desc' }, take: 1 } }
    });
    
    const runId = submission?.benchmarkRuns[0]?.id;
    let byzantineRisk = null;
    
    if (runId) {
      try {
        const response = await axios.get(
          `http://localhost:3007/analysis/${runId}`
        );
        byzantineRisk = {
          riskScore: response.data.overallRiskScore,
          recommendation: response.data.recommendation,
          violationCount: response.data.causalityViolationCount,
          collusionCount: response.data.collusionDetails?.length || 0
        };
      } catch (error) {
        // Byzantine detector unavailable
      }
    }
    
    results.push({
      submissionId,
      score,
      byzantineRisk,
      position: i / 2 + 1
    });
  }
  return results;
});
```

### Integration 3: Database Schema Addition

**File**: `packages/db/schema.prisma`

```prisma
// Add to existing schema

model ByzantineAnalysis {
  id                    String   @id @default(uuid())
  runId                 String   @unique
  benchmarkRun          BenchmarkRun @relation(fields: [runId], references: [id])
  
  causalityViolationCount   Int     @default(0)
  collusionRiskScore        Float   @default(0)
  overallRiskScore          Float   @default(0)
  
  recommendation        String   // "PASS", "WATCH", "DISQUALIFY"
  
  violationDetails      Json     // CausalityViolation[]
  collusionDetails      Json     // CollusionAnalysis[]
  
  createdAt             DateTime @default(now())
  updatedAt             DateTime @updatedAt
  
  @@index([runId])
  @@index([recommendation])
  @@index([createdAt])
}

// Add to BenchmarkRun model:
model BenchmarkRun {
  // ... existing fields ...
  byzantineAnalysis     ByzantineAnalysis?
}
```

---

## 🎯 Algorithm Reference

### Algorithm 1: Vector Clock Propagation
```
Input: Order or Fill event
Output: Updated vector clock

OnOrderPlaced(engineId):
  1. vector_clock[engineId] += 1
  2. Return current_vector_clock

OnFillReported(engineId, vector_clock_from_order):
  1. For each engine E in vector_clock:
       vector_clock[E] = max(vector_clock[E], vector_clock_from_order[E])
  2. vector_clock[engineId] += 1
  3. Return current_vector_clock

Property: If VC_fill >= VC_order, then filler saw order before filling
```

### Algorithm 2: Causality Validation
```
Input: Order, Fill, OrderHistory, FillHistory
Output: List of violations

ValidateCausality(order, fill):
  violations = []
  
  // Rule 1: Fill's VC must be >= Order's VC
  if NOT VectorClockLE(order.vc, fill.vc):
    violations.append("Byzantine: Fill VC < Order VC")
  
  // Rule 2: Fill must happen after order
  if fill.timestamp < order.timestamp:
    violations.append("Byzantine: Fill before order")
  
  // Rule 3: Prior fills must complete first
  for prior_order_id in order.prior_orders:
    prior_fills = FillHistory[prior_order_id]
    for prior_fill in prior_fills:
      if prior_fill.timestamp > fill.timestamp:
        violations.append("Byzantine: Prior fill after current fill")
  
  return violations

Helper: VectorClockLE(vc1, vc2):
  for each engine E:
    if vc1[E] > vc2[E]:
      return False
  return True
```

### Algorithm 3: Collusion Detection
```
Input: Orders, Fills (for engine pair A, B)
Output: Correlation analysis + risk score

AnalyzeEnginesPair(engineA, engineB, orders, fills):
  
  // 1. Bucketing: Aggregate orders/fills into 10-second windows
  for each 10s window:
    orders_A = count(orders by engineA in window)
    fills_B = count(fills by engineB in window)
    orders_B = count(orders by engineB in window)
    fills_A = count(fills by engineA in window)
  
  // 2. Compute correlations
  order_correlation = Pearson(orders_A[], fills_B[])
  fill_correlation = Pearson(fills_A[], orders_B[])
  
  // 3. Analyze latency distributions
  latencies_A = [fill.latency for fill in fills if fill.filledBy == A]
  latencies_B = [fill.latency for fill in fills if fill.filledBy == B]
  latency_similarity = DTW(latencies_A, latencies_B)
  
  // 4. Compute risk score (weighted combination)
  risk_score = (
    0.35 * |order_correlation| +
    0.30 * |fill_correlation| +
    0.20 * FastFillPercentage(latencies_A) +
    0.15 * FastFillPercentage(latencies_B)
  )
  
  // 5. Decision
  if risk_score > 0.80:
    recommendation = "DISQUALIFY"
  else if risk_score > 0.60:
    recommendation = "WATCH"
  else:
    recommendation = "CLEAN"
  
  return {
    enginePair: [engineA, engineB],
    orderCorrelation,
    fillCorrelation,
    riskScore: risk_score,
    recommendation
  }

Helper: Pearson(x[], y[]):
  n = len(x)
  mean_x = sum(x) / n
  mean_y = sum(y) / n
  
  numerator = sum((x[i] - mean_x) * (y[i] - mean_y))
  denom_x = sqrt(sum((x[i] - mean_x)^2))
  denom_y = sqrt(sum((y[i] - mean_y)^2))
  
  return numerator / (denom_x * denom_y)

Helper: FastFillPercentage(latencies):
  MIN_NETWORK_LATENCY = 100_000 ns (100 microseconds)
  return count(latencies < MIN_NETWORK_LATENCY) / len(latencies)
```

---

## 🚀 Deployment & Configuration

### Environment Variables
```bash
# .env
# Byzantine Detector
BYZANTINE_DETECTOR_URL=http://localhost:3007

# QuestDB (for detector to query)
QUESTDB_URL=http://localhost:9003

# Scoring Engine
REDIS_URL=redis://localhost:6379
DATABASE_URL=postgresql://user:password@localhost:5432/iicpc

# Byzantine Detector Database
KAFKA_BROKERS=localhost:9092
```

### Docker Compose Addition
```yaml
# Add to docker-compose.yml

byzantine-detector:
  image: node:18-alpine
  working_dir: /app
  volumes:
    - ./apps/byzantine-detector:/app
    - ./packages:/packages
  environment:
    - QUESTDB_URL=http://questdb:9003
    - REDIS_URL=redis://redis:6379
    - DATABASE_URL=postgresql://postgres:postgres@postgres:5432/iicpc
  ports:
    - "3007:3007"
  depends_on:
    - questdb
    - redis
    - postgres
  command: npm run dev
```

### Service Start Order
```
1. Start infrastructure: postgres, redis, questdb, redpanda
2. Start Byzantine Detector (listens on :3007)
3. Start Scoring Engine (calls Byzantine Detector on :3007)
4. Start Leaderboard API
5. Start Telemetry Ingestor
6. Run benchmark → Generates events → Detector analyzes → Scores computed
```

---

## ✅ Checklist to Implement

- [ ] Create `packages/shared-types/src/vectorClock.ts`
- [ ] Create `apps/byzantine-detector/src/index.ts`
- [ ] Create `apps/byzantine-detector/src/causalityValidator.ts`
- [ ] Create `apps/byzantine-detector/src/collusionDetector.ts`
- [ ] Update `packages/db/schema.prisma`
- [ ] Update `apps/scoring-engine/src/index.ts`
- [ ] Update `apps/leaderboard-api/src/index.ts`
- [ ] Run `npx prisma migrate dev`
- [ ] Update `docker-compose.yml`
- [ ] Test: Experiment 1.1 (Clean Baseline)
- [ ] Test: Experiment 2.1 (Collusion Detection)
- [ ] Test: Experiment 3.1 (Causality Violation)
- [ ] Run full experiment suite
- [ ] Generate plots & analysis
- [ ] Write research paper

---

**Ready to start? Begin with creating the VectorClockManager class in `packages/shared-types/src/vectorClock.ts`**
