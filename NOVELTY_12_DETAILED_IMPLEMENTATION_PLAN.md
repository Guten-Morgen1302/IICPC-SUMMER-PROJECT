# Novelty 12: Byzantine Fault Detection with Causal Consistency
## Detailed Implementation & Experimentation Plan

**Target Venue**: OSDI 2027  
**Implementation Duration**: 3 weeks  
**Generated**: May 23, 2026

---

## 📋 Executive Overview

### Problem Statement
In a multi-tenant benchmarking platform, malicious contestants can coordinate to game the leaderboard:
- **Engine-A** places orders with specific patterns
- **Engine-B** matches them perfectly (both get high scores)
- **Current platform**: No way to detect this collusion
- **Impact**: Leaderboard trust compromised

### Solution: Byzantine Fault Detection Framework
Using **vector clocks** (lamport timestamps) + **causal consistency** + **statistical analysis**, we detect:
1. **Causality violations**: Fills happening out of order
2. **Collusion patterns**: Two engines always matching each other
3. **Coordinated attacks**: Synchronized malicious behavior

### Key Innovation
Unlike traditional Byzantine consensus (PBFT, Raft), we don't require quorum. We detect Byzantine behavior **probabilistically** by analyzing causal consistency violations in the order-fill stream.

---

## 🏗️ Architecture Design

### Layer 1: Vector Clock Injection

**Concept**: Assign logical timestamps to every order and fill to track causality.

```typescript
// Vector Clock Structure
interface VectorClock {
  [engineId: string]: number;
  orderId: number;  // Global order sequence number
  timestamp: number; // Unix nanoseconds
}

// Example evolution:
// T0: Engine-A places Order-100
//     VC-A: { "Engine-A": 1, "Engine-B": 0, "OrderStream": 100 }
//
// T1: Engine-B sees Order-100 (via broadcast)
//     VC-B: { "Engine-A": 1, "Engine-B": 0, "OrderStream": 100 }
//
// T2: Engine-B fills Order-100
//     Fill has VC: { "Engine-A": 1, "Engine-B": 1, "OrderStream": 100 }
//
// Property: If VC-fill[Engine-A] >= VC-fill[Engine-B], then Engine-B 
//           saw all of Engine-A's prior orders
```

**Implementation**:
```typescript
class VectorClockManager {
  private clocks: Map<string, number> = new Map();
  private globalOrderSequence = 0;
  
  constructor(private engineIds: string[]) {
    engineIds.forEach(id => this.clocks.set(id, 0));
  }
  
  // Called when Engine-A places an order
  onOrderPlaced(engineId: string): VectorClock {
    this.clocks.set(engineId, (this.clocks.get(engineId) || 0) + 1);
    this.globalOrderSequence++;
    
    return {
      ...Object.fromEntries(this.clocks),
      orderId: this.globalOrderSequence,
      timestamp: BigInt(Date.now()) * 1_000_000n  // nanoseconds
    };
  }
  
  // Called when Engine-B fills Engine-A's order
  onFillReported(engineId: string, vectorClockFromOrder: VectorClock): VectorClock {
    // Merge: Take max of each engine's clock
    for (const [id, time] of Object.entries(vectorClockFromOrder)) {
      if (id !== 'orderId' && id !== 'timestamp') {
        this.clocks.set(id, Math.max(this.clocks.get(id) || 0, time as number));
      }
    }
    
    // Increment own clock
    this.clocks.set(engineId, (this.clocks.get(engineId) || 0) + 1);
    
    return {
      ...Object.fromEntries(this.clocks),
      orderId: vectorClockFromOrder.orderId,
      timestamp: BigInt(Date.now()) * 1_000_000n
    };
  }
}
```

### Layer 2: Causal Consistency Rules

**Definition**: A fill F2 respects causality with F1 if:
- F1's order was placed before F2's order, **AND**
- F2's vector clock includes all of F1's causal history

```typescript
interface OrderCausalHistory {
  orderId: string;
  engineId: string;
  vectorClock: VectorClock;
  placer: string;
  timestamp: bigint;
  priorOrders: string[];  // Orders that must be filled before this one
}

interface FillCausalHistory {
  fillId: string;
  orderId: string;
  filledBy: string;
  vectorClock: VectorClock;
  timestamp: bigint;
}

// Causality check function
function validateCausality(
  fill: FillCausalHistory,
  orderHistory: Map<string, OrderCausalHistory>,
  fillHistory: Map<string, FillCausalHistory>
): { valid: boolean; violations: string[] } {
  const violations: string[] = [];
  
  const order = orderHistory.get(fill.orderId);
  if (!order) {
    violations.push(`Order ${fill.orderId} not found in history`);
    return { valid: false, violations };
  }
  
  // Check: Fill's vector clock >= Order's vector clock
  // This ensures the filler saw the order before filling
  if (!vectorClockLE(order.vectorClock, fill.vectorClock)) {
    violations.push(
      `Byzantine: Fill ${fill.fillId} has clock ${JSON.stringify(fill.vectorClock)} ` +
      `less than order clock ${JSON.stringify(order.vectorClock)}`
    );
  }
  
  // Check: All prior orders in causal chain are filled
  for (const priorOrderId of order.priorOrders) {
    const priorFill = Array.from(fillHistory.values())
      .find(f => f.orderId === priorOrderId);
    
    if (!priorFill) {
      violations.push(
        `Missing fill for prior order ${priorOrderId} (must fill before ${fill.orderId})`
      );
      continue;
    }
    
    // Prior fill must happen before current fill
    if (priorFill.timestamp > fill.timestamp) {
      violations.push(
        `Causal violation: Prior fill ${priorFill.fillId} (ts=${priorFill.timestamp}) ` +
        `happened after current fill ${fill.fillId} (ts=${fill.timestamp})`
      );
    }
  }
  
  return { valid: violations.length === 0, violations };
}

// Helper: Vector clock comparison (partial order)
function vectorClockLE(vc1: VectorClock, vc2: VectorClock): boolean {
  for (const [key, val1] of Object.entries(vc1)) {
    if (key === 'orderId' || key === 'timestamp') continue;
    const val2 = (vc2 as any)[key] || 0;
    if (val1 > val2) return false;
  }
  return true;
}
```

### Layer 3: Collusion Detection (Statistical Analysis)

**Hypothesis**: Two engines are colluding if:
1. Engine-A's order rate correlates perfectly with Engine-B's fill rate
2. Engine-A's fill rate = Engine-B's order rate (mirrored behavior)
3. Fill times are suspiciously fast (< network latency)
4. Both maintain identical latency profiles across runs

```typescript
interface CorrelationAnalysis {
  enginePair: [string, string];
  orderCorrelation: number;       // Correlation(A_orders, B_fills)
  fillCorrelation: number;        // Correlation(A_fills, B_orders)
  mirrorRatio: number;            // Ratio of mirrored orders
  fastFillPercentage: number;     // % of fills faster than min_network_latency
  latencyProfileSimilarity: number; // DTW distance of latency distributions
  riskScore: number;              // 0-1 (higher = more suspicious)
  recommendation: 'CLEAN' | 'WATCH' | 'DISQUALIFY';
}

class CollusionDetector {
  private engineOrderRates: Map<string, number[]> = new Map();     // [orders/sec over 10s windows]
  private engineFillRates: Map<string, number[]> = new Map();      // [fills/sec over 10s windows]
  private engineLatencies: Map<string, number[]> = new Map();      // Raw latency samples
  
  // Collect metrics during benchmark
  recordOrder(engineId: string, timestamp: number) {
    if (!this.engineOrderRates.has(engineId)) {
      this.engineOrderRates.set(engineId, []);
    }
    // Aggregate into 10-second buckets
  }
  
  recordFill(engineId: string, latency: number, timestamp: number) {
    if (!this.engineLatencies.has(engineId)) {
      this.engineLatencies.set(engineId, []);
    }
    this.engineLatencies.get(engineId)!.push(latency);
  }
  
  // Analyze pairwise correlations
  analyzeEnginesPair(engineA: string, engineB: string): CorrelationAnalysis {
    const ordersA = this.engineOrderRates.get(engineA) || [];
    const fillsB = this.engineFillRates.get(engineB) || [];
    const fillsA = this.engineFillRates.get(engineA) || [];
    const ordersB = this.engineOrderRates.get(engineB) || [];
    
    // Pearson correlation
    const orderCorrelation = pearsonCorrelation(ordersA, fillsB);
    const fillCorrelation = pearsonCorrelation(fillsA, ordersB);
    
    // Mirror detection: Do they always trade with each other?
    const mirrorRatio = Math.min(
      (fillsB.reduce((a, b) => a + b, 0) / Math.max(1, ordersA.reduce((a, b) => a + b, 0))),
      (fillsA.reduce((a, b) => a + b, 0) / Math.max(1, ordersB.reduce((a, b) => a + b, 0)))
    );
    
    // Fast fill detection: Fills faster than ~100μs (impossible over network)
    const MIN_NETWORK_LATENCY_NS = 100_000; // 100 microseconds
    const latenciesA = this.engineLatencies.get(engineA) || [];
    const latenciesB = this.engineLatencies.get(engineB) || [];
    const fastFillPercentageA = latenciesA.filter(l => l < MIN_NETWORK_LATENCY_NS).length / Math.max(1, latenciesA.length);
    const fastFillPercentageB = latenciesB.filter(l => l < MIN_NETWORK_LATENCY_NS).length / Math.max(1, latenciesB.length);
    const fastFillPercentage = Math.max(fastFillPercentageA, fastFillPercentageB);
    
    // Latency profile similarity (DTW)
    const dtwDistance = dynamicTimeWarp(latenciesA, latenciesB);
    const latencyProfileSimilarity = 1.0 / (1.0 + dtwDistance); // Normalize to 0-1
    
    // Risk score (weighted combination)
    const riskScore = 
      0.35 * Math.abs(orderCorrelation) +      // How much do orders/fills sync?
      0.30 * mirrorRatio +                      // Do they trade with each other?
      0.20 * fastFillPercentage +               // Impossibly fast fills?
      0.15 * latencyProfileSimilarity;          // Similar latency distribution?
    
    // Decision threshold
    let recommendation: 'CLEAN' | 'WATCH' | 'DISQUALIFY';
    if (riskScore > 0.80) recommendation = 'DISQUALIFY';
    else if (riskScore > 0.60) recommendation = 'WATCH';
    else recommendation = 'CLEAN';
    
    return {
      enginePair: [engineA, engineB],
      orderCorrelation,
      fillCorrelation,
      mirrorRatio,
      fastFillPercentage,
      latencyProfileSimilarity,
      riskScore,
      recommendation
    };
  }
}

// Helper: Pearson correlation coefficient
function pearsonCorrelation(x: number[], y: number[]): number {
  if (x.length === 0 || y.length === 0 || x.length !== y.length) return 0;
  
  const n = x.length;
  const meanX = x.reduce((a, b) => a + b, 0) / n;
  const meanY = y.reduce((a, b) => a + b, 0) / n;
  
  let numerator = 0, denomX = 0, denomY = 0;
  for (let i = 0; i < n; i++) {
    const dx = x[i] - meanX;
    const dy = y[i] - meanY;
    numerator += dx * dy;
    denomX += dx * dx;
    denomY += dy * dy;
  }
  
  return numerator / Math.sqrt(denomX * denomY);
}

// Helper: Dynamic Time Warping distance (for latency distribution comparison)
function dynamicTimeWarp(x: number[], y: number[]): number {
  // Simplified DTW; full implementation uses dynamic programming
  // For now: Euclidean distance between percentile arrays
  const px = percentiles(x, [25, 50, 75, 99]);
  const py = percentiles(y, [25, 50, 75, 99]);
  return Math.sqrt(
    px.reduce((sum, val, i) => sum + Math.pow(val - py[i], 2), 0)
  );
}
```

### Layer 4: Integration with Scoring Engine

**Modification to scoring formula**:
```typescript
interface ByzantineAnalysisResult {
  byzantineViolations: number;    // Count of causality violations
  collusionRiskScore: number;     // 0-1 (higher = more suspicious)
  disqualificationReason?: string;
}

function computeFinalScore(
  latencyScore: number,
  throughputScore: number,
  correctnessScore: number,
  regimeBonus: number,
  byzantineAnalysis: ByzantineAnalysisResult
): number {
  // Gating rule 1: Correctness must be > 50%
  if (correctnessScore < 0.5) return 0;
  
  // Gating rule 2 (NEW): No Byzantine violations allowed
  if (byzantineAnalysis.byzantineViolations > 0) {
    return 0;  // Automatic disqualification
  }
  
  // Soft penalty: Collusion risk reduces score
  const collusionPenalty = 1.0 - (byzantineAnalysis.collusionRiskScore * 0.5);
  
  // Compute base score
  const baseScore = 
    0.30 * latencyScore +
    0.40 * throughputScore +
    0.30 * correctnessScore;
  
  // Apply regime bonus and collusion penalty
  const finalScore = baseScore * regimeBonus * collusionPenalty;
  
  return Math.max(0, Math.min(1, finalScore));
}
```

---

## 🔧 Implementation Plan (3 Weeks)

### Week 1: Core Vector Clock Implementation

#### File 1: `packages/shared-types/src/vectorClock.ts` (NEW)
```typescript
// Vector clock types and utilities
export interface VectorClock {
  [engineId: string]: number;
}

export interface CausalizedOrder {
  orderId: string;
  engineId: string;
  vectorClock: VectorClock;
  timestamp: bigint;
  priorOrders: string[];
}

export interface CausalizedFill {
  fillId: string;
  orderId: string;
  filledBy: string;
  vectorClock: VectorClock;
  timestamp: bigint;
  latency: number;
}

export class VectorClockManager {
  private clocks: Map<string, number> = new Map();
  private globalOrderSequence = 0;
  
  constructor(engineIds: string[]) {
    engineIds.forEach(id => this.clocks.set(id, 0));
  }
  
  onOrderPlaced(engineId: string): VectorClock { ... }
  onFillReported(engineId: string, vcFromOrder: VectorClock): VectorClock { ... }
  toJSON(): Record<string, number> { ... }
}
```

#### File 2: `apps/byzantine-detector/src/index.ts` (NEW)
```typescript
// Byzantine fault detector service
// Consumes order/fill events from QuestDB
// Outputs Byzantine analysis results

import Fastify from 'fastify';
import axios from 'axios';
import { prisma } from '@benchmark/db';
import { VectorClockManager, CausalizedOrder, CausalizedFill } from '@benchmark/shared-types';

const fastify = Fastify({ logger: true });
const QUESTDB_URL = process.env.QUESTDB_URL || 'http://localhost:9003';

interface ByzantineAnalysis {
  runId: string;
  submissionIds: string[];
  causalityViolations: Array<{
    fillId: string;
    orderId: string;
    reason: string;
  }>;
  collusionAnalysis: CorrelationAnalysis[];
  overallRiskScore: number;
  recommendation: 'PASS' | 'WATCH' | 'DISQUALIFY';
  timestamp: number;
}

fastify.post('/analyze-run/:runId', async (request, reply) => {
  const { runId } = request.params;
  
  // Fetch all orders and fills for this run from QuestDB
  const orders = await fetchOrdersForRun(runId);
  const fills = await fillsForRun(runId);
  
  // Initialize vector clock manager
  const engineIds = [...new Set(orders.map(o => o.engineId))];
  const vcManager = new VectorClockManager(engineIds);
  
  // Assign vector clocks (simulate causality)
  const ordersWithVC = orders.map(o => ({
    ...o,
    vectorClock: vcManager.onOrderPlaced(o.engineId)
  }));
  
  const fillsWithVC = fills.map(f => {
    const order = ordersWithVC.find(o => o.orderId === f.orderId);
    return {
      ...f,
      vectorClock: vcManager.onFillReported(f.filledBy, order?.vectorClock)
    };
  });
  
  // Detect causality violations
  const causalityViolations = detectCausalityViolations(ordersWithVC, fillsWithVC);
  
  // Detect collusion patterns
  const collusionAnalysis = new CollusionDetector()
    .analyzeAllPairs(engineIds, fills);
  
  // Compute risk score
  const overallRiskScore = computeOverallRisk(
    causalityViolations,
    collusionAnalysis
  );
  
  const analysis: ByzantineAnalysis = {
    runId,
    submissionIds: engineIds,
    causalityViolations,
    collusionAnalysis,
    overallRiskScore,
    recommendation: overallRiskScore > 0.8 ? 'DISQUALIFY' : 'PASS',
    timestamp: Date.now()
  };
  
  // Store results
  await prisma.byzantineAnalysis.create({ data: analysis });
  
  return reply.send(analysis);
});

fastify.listen({ port: 3007, host: '0.0.0.0' }, (err, address) => {
  if (err) throw err;
  console.log(`Byzantine detector listening on ${address}`);
});
```

#### Deliverables:
- ✅ VectorClockManager class with VC propagation logic
- ✅ CausalizedOrder and CausalizedFill types
- ✅ Basic Byzantine detector service scaffolding
- ✅ QuestDB query utilities for fetching order/fill events

---

### Week 2: Causality Violation & Collusion Detection

#### File 3: `apps/byzantine-detector/src/causalityValidator.ts` (NEW)
```typescript
// Implement causality rules and violation detection

export function detectCausalityViolations(
  orders: CausalizedOrder[],
  fills: CausalizedFill[]
): CausalityViolation[] {
  const violations: CausalityViolation[] = [];
  const orderMap = new Map(orders.map(o => [o.orderId, o]));
  const fillsByOrder = new Map<string, CausalizedFill[]>();
  
  fills.forEach(f => {
    if (!fillsByOrder.has(f.orderId)) {
      fillsByOrder.set(f.orderId, []);
    }
    fillsByOrder.get(f.orderId)!.push(f);
  });
  
  // Check each fill for causality validity
  for (const fill of fills) {
    const order = orderMap.get(fill.orderId);
    if (!order) {
      violations.push({
        fillId: fill.fillId,
        orderId: fill.orderId,
        reason: 'Order not found (phantom fill)'
      });
      continue;
    }
    
    // Rule 1: Fill must see order first (VC constraint)
    if (!vectorClockLE(order.vectorClock, fill.vectorClock)) {
      violations.push({
        fillId: fill.fillId,
        orderId: fill.orderId,
        reason: `Fill vector clock ${JSON.stringify(fill.vectorClock)} ` +
                `less than order clock ${JSON.stringify(order.vectorClock)}`
      });
    }
    
    // Rule 2: Fill must happen after order placement
    if (fill.timestamp < order.timestamp) {
      violations.push({
        fillId: fill.fillId,
        orderId: fill.orderId,
        reason: `Fill timestamp ${fill.timestamp} before order ${order.timestamp}`
      });
    }
    
    // Rule 3: All prior fills must complete before this fill
    for (const priorOrderId of order.priorOrders) {
      const priorFills = fillsByOrder.get(priorOrderId) || [];
      for (const priorFill of priorFills) {
        if (priorFill.timestamp > fill.timestamp) {
          violations.push({
            fillId: fill.fillId,
            orderId: fill.orderId,
            reason: `Prior fill ${priorFill.fillId} (ts=${priorFill.timestamp}) ` +
                    `after this fill (ts=${fill.timestamp})`
          });
        }
      }
    }
  }
  
  return violations;
}
```

#### File 4: `apps/byzantine-detector/src/collusionDetector.ts` (NEW)
```typescript
// Collusion pattern detection via statistical analysis

export class CollusionDetector {
  analyzeEnginesPair(
    engineA: string,
    engineB: string,
    orders: Order[],
    fills: Fill[]
  ): CorrelationAnalysis {
    // Time-series bucketing: 10-second windows
    const buckets = createBuckets(10_000); // 10 seconds
    
    // Count orders/fills per engine per bucket
    const ordersPerBucket = new Map<number, Map<string, number>>();
    const fillsPerBucket = new Map<number, Map<string, number>>();
    
    orders.forEach(o => {
      const bucket = Math.floor(o.timestamp / 10_000);
      if (!ordersPerBucket.has(bucket)) {
        ordersPerBucket.set(bucket, new Map());
      }
      const count = ordersPerBucket.get(bucket)!.get(o.engineId) || 0;
      ordersPerBucket.get(bucket)!.set(o.engineId, count + 1);
    });
    
    fills.forEach(f => {
      const bucket = Math.floor(f.timestamp / 10_000);
      if (!fillsPerBucket.has(bucket)) {
        fillsPerBucket.set(bucket, new Map());
      }
      const count = fillsPerBucket.get(bucket)!.get(f.filledBy) || 0;
      fillsPerBucket.get(bucket)!.set(f.filledBy, count + 1);
    });
    
    // Extract time-series: Engine-A orders vs Engine-B fills
    const ordersA = Array.from(ordersPerBucket.values())
      .map(m => m.get(engineA) || 0);
    const fillsB = Array.from(fillsPerBucket.values())
      .map(m => m.get(engineB) || 0);
    
    const orderCorrelation = pearsonCorrelation(ordersA, fillsB);
    
    // Similar analysis for B->A
    const ordersB = Array.from(ordersPerBucket.values())
      .map(m => m.get(engineB) || 0);
    const fillsA = Array.from(fillsPerBucket.values())
      .map(m => m.get(engineA) || 0);
    
    const fillCorrelation = pearsonCorrelation(fillsA, ordersB);
    
    // Calculate metrics and risk score
    const latenciesA = fills.filter(f => f.filledBy === engineA).map(f => f.latency);
    const latenciesB = fills.filter(f => f.filledBy === engineB).map(f => f.latency);
    
    const riskScore = computeRiskScore({
      orderCorrelation,
      fillCorrelation,
      latenciesA,
      latenciesB
    });
    
    return {
      enginePair: [engineA, engineB],
      orderCorrelation,
      fillCorrelation,
      riskScore,
      recommendation: riskScore > 0.8 ? 'DISQUALIFY' : 'CLEAN'
    };
  }
  
  analyzeAllPairs(
    engineIds: string[],
    fills: Fill[]
  ): CorrelationAnalysis[] {
    const results: CorrelationAnalysis[] = [];
    
    for (let i = 0; i < engineIds.length; i++) {
      for (let j = i + 1; j < engineIds.length; j++) {
        const analysis = this.analyzeEnginesPair(
          engineIds[i],
          engineIds[j],
          [],  // Pass actual orders
          fills
        );
        results.push(analysis);
      }
    }
    
    return results;
  }
}

function computeRiskScore(metrics: any): number {
  return (
    0.35 * Math.abs(metrics.orderCorrelation) +
    0.30 * Math.abs(metrics.fillCorrelation) +
    0.20 * (metrics.latenciesA.filter(l => l < 100_000).length / Math.max(1, metrics.latenciesA.length)) +
    0.15 * (metrics.latenciesB.filter(l => l < 100_000).length / Math.max(1, metrics.latenciesB.length))
  );
}
```

#### File 5: Update `packages/db/schema.prisma` (NEW TABLES)
```prisma
model ByzantineAnalysis {
  id                    String   @id @default(uuid())
  runId                 String
  benchmarkRun          BenchmarkRun @relation(fields: [runId], references: [id])
  
  causalityViolationCount   Int
  collusionRiskScore        Float
  overallRiskScore          Float
  
  recommendation        String   // "PASS", "WATCH", "DISQUALIFY"
  
  // JSON arrays for detailed results
  violationDetails      Json     // Array of causality violations
  collusionDetails      Json     // Array of pairwise collusion analysis
  
  createdAt             DateTime @default(now())
  
  @@index([runId])
  @@index([recommendation])
}

model CausalityViolation {
  id                    String   @id @default(uuid())
  byzantineAnalysisId   String
  byzantineAnalysis     ByzantineAnalysis @relation(fields: [byzantineAnalysisId], references: [id])
  
  fillId                String
  orderId               String
  reason                String
  severity              String   // "INFO", "WARNING", "CRITICAL"
  
  createdAt             DateTime @default(now())
}

model CollusionAnalysis {
  id                    String   @id @default(uuid())
  byzantineAnalysisId   String
  byzantineAnalysis     ByzantineAnalysis @relation(fields: [byzantineAnalysisId], references: [id])
  
  engineA               String
  engineB               String
  orderCorrelation      Float
  fillCorrelation       Float
  riskScore             Float
  recommendation        String   // "CLEAN", "WATCH", "DISQUALIFY"
  
  createdAt             DateTime @default(now())
  
  @@unique([byzantineAnalysisId, engineA, engineB])
}
```

#### Deliverables:
- ✅ Causality violation detection with vector clock validation
- ✅ Collusion detector with statistical analysis
- ✅ Database schema for storing Byzantine analysis results
- ✅ Pairwise correlation computation
- ✅ Risk scoring algorithm

---

### Week 3: Integration & Scoring System Update

#### File 6: Update `apps/scoring-engine/src/index.ts`
```typescript
// Add Byzantine analysis check before final scoring

// ... (existing imports)
import axios from 'axios';

const BYZANTINE_DETECTOR_URL = 
  process.env.BYZANTINE_DETECTOR_URL || 'http://localhost:3007';

async function computeScoreWithByzantineCheck(
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
    const byzantineResp = await axios.get(
      `${BYZANTINE_DETECTOR_URL}/analysis/${runId}`
    );
    const byzantineAnalysis = byzantineResp.data;
    
    // Gating rule 2: No Byzantine violations allowed
    if (byzantineAnalysis.causalityViolationCount > 0) {
      fastify.log.warn(`Submission ${submissionId} has Byzantine violations`);
      return 0;  // Disqualify
    }
    
    // Soft penalty: Collusion risk
    const collusionPenalty = 1.0 - (byzantineAnalysis.collusionRiskScore * 0.5);
    
    // Compute final score
    const baseScore = 
      0.30 * latencyScore +
      0.40 * throughputScore +
      0.30 * correctnessScore;
    
    const finalScore = baseScore * regimeBonus * collusionPenalty;
    
    return Math.max(0, Math.min(1, finalScore));
  } catch (error) {
    fastify.log.error(`Byzantine analysis failed: ${error}`);
    // Fall back to original scoring if Byzantine detector unavailable
    const baseScore = 
      0.30 * latencyScore +
      0.40 * throughputScore +
      0.30 * correctnessScore;
    return baseScore * regimeBonus;
  }
}
```

#### File 7: Update `apps/leaderboard-api/src/index.ts`
```typescript
// Add Byzantine flags to leaderboard response

fastify.get('/leaderboard/top', async (request) => {
  // ... (existing code)
  
  // Fetch Byzantine analysis for each engine
  for (const engine of results) {
    try {
      const byzantineResp = await axios.get(
        `${BYZANTINE_DETECTOR_URL}/analysis/${engine.benchmarkRunId}`
      );
      engine.byzantineRisk = {
        riskScore: byzantineResp.data.overallRiskScore,
        recommendation: byzantineResp.data.recommendation,
        violationCount: byzantineResp.data.causalityViolationCount
      };
    } catch (error) {
      engine.byzantineRisk = null;
    }
  }
  
  return results;
});
```

#### Deliverables:
- ✅ Integration with scoring engine
- ✅ Leaderboard Byzantine risk flags
- ✅ Disqualification rules
- ✅ Collusion penalty application

---

## 📊 Experiments & Benchmarks (3-Week Research Plan)

### Experiment 1: Byzantine Resilience Testing
**Goal**: Verify that Byzantine detector catches collusion  
**Duration**: 1 week

#### Scenario A: Clean Engines (Baseline)
```bash
# Setup
engines: Engine-Alpha, Engine-Beta, Engine-Gamma
engines: 3 independent, non-colluding engines
scenario: Standard benchmark (60s, normal regime)
iterations: 10 runs

# Expected
- 0 causality violations
- Correlation(Alpha_orders, Beta_fills) ≈ 0.1
- Risk scores < 0.3 (all CLEAN)
```

#### Scenario B: Collusive Pair Detection
```bash
# Setup
engines: Engine-Alpha (colluder), Engine-Beta (colluder), Engine-Gamma (clean)
strategy:
  - Engine-Alpha places order at price 1000, qty 100
  - Engine-Beta immediately matches at same price
  - Repeat 1000 times (same pattern)
iterations: 10 runs

# Expected
- Perfect correlation: Correlation(Alpha_orders, Beta_fills) > 0.95
- Mirror ratio > 0.90
- Fast fill percentage > 50% (fills < 100μs)
- Risk score > 0.85 → DISQUALIFY
- Engine-Gamma remains CLEAN
```

#### Scenario C: Causality Violation Detection
```bash
# Setup
engines: Engine-Byzantine (malicious), Engine-Clean
strategy:
  - Inject out-of-order fills (fill order 100 before order 50)
  - Violate vector clock constraints
  - Report fills with negative latencies
iterations: 10 runs

# Expected
- Causality violations detected: >100
- Vector clock checks fail
- Automatic disqualification
```

#### Scenario D: Adversarial Attack (Fill Spoofing)
```bash
# Setup
engines: Engine-Attacker
strategy:
  - Report fills for orders never placed
  - Report multiple fills for single order
  - Fill quantity > order quantity
iterations: 10 runs

# Expected
- Phantom fill detection: >50
- Fill anomalies caught by correctness engine
- Score impact: -0.5 (correctness penalty)
```

### Experiment 2: Performance Impact Measurement
**Goal**: Measure computational overhead of Byzantine detection  
**Duration**: 1 week

#### Benchmark 1: Throughput Overhead
```bash
# Test: How many orders/fills can Byzantine detector analyze/sec?

# Parameters
- Order count: 10K, 50K, 100K, 500K
- Fill count: 10K, 50K, 100K, 500K
- Engine count: 2, 5, 10, 20

# Metrics
- VC propagation latency (per order)
- Causality check latency (per fill)
- Collusion analysis latency (per pairwise)
- Memory usage

# Expected Results
- VC propagation: <1ms per 1000 orders
- Causality check: <10ms per 1000 fills
- Collusion analysis: <100ms per pairwise (20 engines = 190 pairs)
- Total overhead: <10% of scoring latency
```

#### Benchmark 2: Scalability with Engine Count
```bash
# Test: How does detector scale with number of engines?

# Parameters
- Engine count: 2, 5, 10, 20, 50, 100
- Order count: 10K per engine
- Test duration: 60s

# Metrics
- VC clock size (grows with engine count)
- Pairwise analysis count (N*(N-1)/2)
- Memory per run
- Analysis latency

# Expected (theoretical)
- VC size: O(N) → 100 engines ≈ 400 bytes per VC
- Pairwise pairs: N=100 → 4950 analyses
- Analysis time: ~500ms per run
```

### Experiment 3: Statistical Validation
**Goal**: Validate collision detection algorithm  
**Duration**: 1 week

#### Test 1: ROC Curve (Receiver Operating Characteristic)
```bash
# Generate 100 benchmark runs with varying collusion probability

for each run {
  collusion_probability = random(0.0, 1.0)
  
  # Generate orders/fills with probability of collusion
  if (random() < collusion_probability) {
    # Pair engines for collusion
    Engine-A places order
    Engine-B immediately matches (synchronized)
  } else {
    # Independent engines
    Orders placed randomly
  }
}

# Measure detection accuracy
true_positive_rate = (correctly_detected_collusions / actual_collusions)
false_positive_rate = (incorrectly_flagged_clean / actual_clean_runs)
f1_score = 2 * (precision * recall) / (precision + recall)

# Expected
- AUC (area under ROC curve) > 0.95
- F1 score > 0.90
```

#### Test 2: Correlation Threshold Validation
```bash
# Test: At what correlation level does detector trigger?

for correlation_threshold in [0.5, 0.6, 0.7, 0.8, 0.9, 0.95]:
  for iteration in range(100):
    # Generate synthetic order/fill streams with exact correlation
    orders_A = [1000 + random(-5, 5) for _ in range(1000)]
    fills_B = [o + random(-2, 2) for o in orders_A]  # Correlated
    
    actual_correlation = pearson(orders_A, fills_B)
    detected = detector.analyze(orders_A, fills_B)
    
    record: {
      threshold,
      target_correlation: correlation_threshold,
      actual_correlation,
      detected: detected.risk_score
    }

# Expected
- Detection threshold ≈ 0.85 (balances false positives vs false negatives)
```

#### Test 3: Time-Series Correlation Stability
```bash
# Test: Do correlation metrics remain stable across different time windows?

for window_size in [10s, 30s, 60s, 120s]:
  for engine_pair in all_pairs:
    correlations = []
    for sub_window in split_by_window_size:
      corr = pearson(engine_pair.orders[sub_window],
                     engine_pair.fills[sub_window])
      correlations.append(corr)
    
    # Measure variance
    variance = std_dev(correlations)
    record: { window_size, engine_pair, variance }

# Expected
- Variance < 0.1 across different windows (stable metric)
```

### Experiment 4: Benchmark Suite Design

#### Benchmark Dataset
```bash
# Create public benchmark suite for reproducibility

dataset/
├── runs/
│   ├── run-clean-10k-orders/
│   │   ├── orders.jsonl (10,000 orders from 3 clean engines)
│   │   ├── fills.jsonl (all fills, expected: 10,000)
│   │   ├── ground-truth.json (collusion: NONE)
│   │   └── expected-analysis.json
│   │
│   ├── run-collusive-pair-500k/
│   │   ├── orders.jsonl (500K orders, Engine-A & Engine-B colluding)
│   │   ├── fills.jsonl (perfect correlation)
│   │   ├── ground-truth.json (collusion: Engine-A <→ Engine-B)
│   │   └── expected-analysis.json
│   │
│   ├── run-byzantine-violations-100k/
│   │   ├── orders.jsonl
│   │   ├── fills.jsonl (contains out-of-order fills)
│   │   ├── ground-truth.json (violations: 50)
│   │   └── expected-analysis.json
│   │
│   └── run-mixed-5-engines-stress/
│       ├── orders.jsonl (100K orders, 5 engines, stressed regime)
│       ├── fills.jsonl
│       ├── ground-truth.json (partial collusion: Engine-A & Engine-B)
│       └── expected-analysis.json

# Each run includes:
- Complete order/fill sequences
- Expected vector clocks
- Ground-truth collusion labels
- Expected analysis results
```

### Experiment 5: Real-World Simulation

#### Test: IICPC Competition Simulation
```bash
# Setup: 50 virtual teams submitting engines
# Duration: 8 hours of continuous benchmarking
# Parameters:
#   - 2 collusive teams (undetected initially)
#   - 3 Byzantine attackers (attempting fill spoofing)
#   - 45 clean teams

# Metrics collected:
- Total orders processed: 5M+
- Fills: 2.5M+
- Causality violations detected: X
- Collusive pairs detected: Y
- False positives: Z
- Leaderboard integrity: Before/After Byzantine filtering

# Expected
- 2 collusive teams detected and disqualified
- 3 Byzantine teams caught and excluded
- Leaderboard ranking unchanged for clean teams
- Final rankings trust level: >99%
```

---

## 📈 Detailed Benchmark Metrics

### Metric 1: Detection Accuracy
```
Precision = (True Positives) / (True Positives + False Positives)
Recall = (True Positives) / (True Positives + False Negatives)
F1 = 2 × (Precision × Recall) / (Precision + Recall)

Target: Precision > 0.95, Recall > 0.90, F1 > 0.92
```

### Metric 2: Performance Overhead
```
Baseline: Scoring engine without Byzantine checks
- Latency per run: 100ms

With Byzantine checks:
- VC propagation: +5ms
- Causality check: +8ms
- Collusion analysis: +15ms
- Total: 128ms (+28% overhead)

Target: Overhead < 30%
```

### Metric 3: Scalability
```
Linear scaling: O(N) for N engines
- N=10: Analysis time = 50ms
- N=50: Analysis time = 250ms (Pairwise: 1225 pairs)
- N=100: Analysis time = 500ms (Pairwise: 4950 pairs)

Target: Sub-second analysis for N < 200
```

### Metric 4: False Positive Rate
```
Scenario: 100 clean runs
False Positive Rate = (Incorrectly flagged as Byzantine) / 100

Target: FPR < 2% (< 2 clean runs incorrectly flagged)
```

### Metric 5: Byzantine Detection Rate
```
Scenario: 100 runs with injected collusion
Detection Rate = (Detected collusions) / 100

Target: DR > 98% (detect 98+ cases)
```

---

## 🔬 Research Paper Structure

```
1. Introduction (Novelty of Byzantine detection in benchmarking)
   - Problem: Current benchmarks trust all participants
   - Solution: Causal consistency model detects collusion
   - Impact: Enables trustworthy multi-engine comparison

2. Related Work (Byzantine fault tolerance, benchmarking)
   - PBFT, Raft, Tendermint (consensus without quorum)
   - TPC, SPEC benchmarks (no Byzantine detection)
   - Trading system evaluation (lacks fairness guarantees)

3. Technical Approach (Vector clocks + correlation analysis)
   - 3.1 Vector Clock Model
   - 3.2 Causality Validation Rules
   - 3.3 Collusion Detection Algorithm
   - 3.4 Risk Scoring & Recommendations

4. Experimental Evaluation
   - 4.1 Byzantine Resilience (Scenarios A-D)
   - 4.2 Performance Impact (Benchmarks 1-2)
   - 4.3 Statistical Validation (Tests 1-3)
   - 4.4 Real-World Simulation (8-hour competition)
   - 4.5 Comparative Analysis vs Other Approaches

5. Results & Analysis
   - Detection accuracy: 98%+ precision, 95%+ recall
   - Overhead: <30% performance impact
   - Scalability: Sub-second for N<200 engines
   - False positives: <2%

6. Discussion
   - Limitations: Assumes causal broadcast
   - Future work: Byzantine consensus integration
   - Threat model: Coordinated vs isolated attacks

7. Conclusion
   - Enables trustworthy benchmarking platform
   - Publishable datasets & reproduction code
   - Application to other multi-tenant systems
```

---

## 🚀 Deliverables Summary

### Code (4 files + 3 modifications)
```
NEW:
  ✅ packages/shared-types/src/vectorClock.ts (150 lines)
  ✅ apps/byzantine-detector/src/index.ts (200 lines)
  ✅ apps/byzantine-detector/src/causalityValidator.ts (180 lines)
  ✅ apps/byzantine-detector/src/collusionDetector.ts (280 lines)

MODIFIED:
  ✅ packages/db/schema.prisma (+60 lines, 3 new tables)
  ✅ apps/scoring-engine/src/index.ts (+30 lines, Byzantine check)
  ✅ apps/leaderboard-api/src/index.ts (+25 lines, Byzantine flags)

TOTAL: ~1,000 lines of new/modified code
```

### Experiments (5 comprehensive test suites)
```
1. Byzantine Resilience (4 scenarios)
   - Baseline: Clean engines
   - Collusion detection
   - Causality violations
   - Attack scenarios

2. Performance Overhead (2 benchmarks)
   - Throughput scaling
   - Engine count scalability

3. Statistical Validation (3 tests)
   - ROC curve
   - Correlation thresholds
   - Time-series stability

4. Benchmark Suite (5 reproducible datasets)
   - Public datasets for validation
   - Ground-truth labels

5. Real-World Simulation
   - 50 engines, 8 hours, 5M+ orders
```

### Publication Artifacts
```
- Research paper: ~25 pages (OSDI format)
- Benchmark suite: Public GitHub + Zenodo DOI
- Reproduction code: Full implementation + scripts
- Evaluation scripts: Automated benchmark runner
```

---

## 📅 Timeline

```
Week 1 (May 23-29):
  - Mon-Tue: Vector clock types + VectorClockManager
  - Wed: Byzantine detector service scaffolding
  - Thu: QuestDB integration + order/fill fetching
  - Fri: Testing + documentation

Week 2 (May 30-Jun 5):
  - Mon-Tue: Causality validation logic + tests
  - Wed-Thu: Collusion detector + statistical analysis
  - Fri: Database schema + migration + testing

Week 3 (Jun 6-12):
  - Mon: Scoring engine integration
  - Tue: Leaderboard API updates
  - Wed: Experiment setup + baseline runs
  - Thu: Collusion/Byzantine scenario execution
  - Fri: Data analysis + paper outline
```

---

## ✅ Success Criteria

- ✅ Zero false negatives (detect all Byzantine behavior)
- ✅ <2% false positive rate (don't disqualify clean engines)
- ✅ <30% performance overhead
- ✅ Scales to 100+ engines
- ✅ All experiments reproducible and publishable
- ✅ Paper accepted to OSDI (target: 20+ citations within 2 years)

---

**End of Detailed Plan**
