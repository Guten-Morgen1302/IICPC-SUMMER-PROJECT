# IICPC Trading Infrastructure Benchmarking Platform - Implementation Status

**Generated**: May 13, 2026  
**Architecture Reference**: CompleteBuild Strategy & Research Dossier (F2 - Strong Hackathon Architecture)  
**Current State**: 60% Complete - Early Integration Phase

---

## Executive Summary

| Module | Status | Completeness | Risk |
|--------|--------|--------------|------|
| **B1: Submission Pipeline** | 🟡 Partial | 60% | Medium |
| **B2: Sandbox Isolation** | 🔴 Not Started | 5% | High |
| **B3: Orchestration** | 🟡 Partial | 40% | High |
| **B4: Endpoint Contract** | 🔴 Not Started | 0% | High |
| **B5: Bot Fleet** | 🟡 Partial | 30% | High |
| **B6: Telemetry Ingestion** | 🟡 Partial | 40% | Medium |
| **B7: Correctness Validation** | 🔴 Stub | 10% | Medium |
| **B8: Scoring Model** | 🟡 Partial | 50% | Medium |
| **B9: Leaderboard UI** | 🟡 Partial | 40% | Low |
| **B10-12: Storage/IaC** | 🟡 Partial | 70% | Low |

---

## Detailed Module Status

### B1: Submission Pipeline ✅ 60% Complete

**What's Done:**
- ✅ FastAPI/Fastify REST endpoint for file upload (`/submit`)
- ✅ Multipart form parsing (userEmail + file archive)
- ✅ MinIO object storage integration (S3-compatible)
- ✅ User/Submission database record creation
- ✅ BullMQ job dispatch (switched from direct orchestration)
- ✅ Build job queuing to Redis

**What's Missing:**
- ❌ Dockerfile detection/validation in archive
- ❌ Manifest parsing from submitted tarball
- ❌ Pre-submission validation (archive format, size limits)
- ❌ Error recovery and retry logic
- ❌ Webhook/callback to notify submission status

**Code Location**: [apps/submission-api/src/index.ts](apps/submission-api/src/index.ts#L1)

**Next Action**: Enhance `/submit` endpoint to validate archive contents and parse optional Dockerfile.

---

### B2: Sandbox Isolation ❌ 5% Complete (CRITICAL)

**What's Done:**
- ✅ Docker Compose infrastructure defined
- ✅ Basic Docker service definitions

**What's Missing (BLOCKING):**
- ❌ Docker runtime swap to `gVisor (runsc)` - **REQUIRED for security**
- ❌ cgroup v2 resource limits (`--cpus`, `--memory`, `--pids-limit`)
- ❌ seccomp profiles (`--security-opt seccomp=default`)
- ❌ Linux capability dropping (`--cap-drop ALL`)
- ❌ Network isolation (`--network=none` or isolated bridge)
- ❌ CPU pinning (`--cpuset-cpus`)
- ❌ Per-contestant Kubernetes Namespace + NetworkPolicy
- ❌ ResourceQuota enforcement

**Risk Level**: 🔴 **CRITICAL**  
Untrusted code execution without isolation = kernel escape vulnerability (CVE-2024-29021 class)

**Arch Doc Reference**: Section C2 - Sandbox Container Isolation  
**Recommended Implementation**: 
1. **Week 1**: Docker + seccomp + cgroup limits (fast, feasible)
2. **Stretch**: Add gVisor as runtime (impressive, adds security)

---

### B3: Deployment / Orchestration 🟡 40% Complete

**What's Done:**
- ✅ Docker Compose scaffolding (postgres, redis, redpanda, questdb)
- ✅ Service definitions for most components
- ✅ BullMQ queue infrastructure (Redis)

**What's Missing:**
- ❌ Kubernetes (k3s) deployment manifests
- ❌ Per-contestant namespace isolation
- ❌ NetworkPolicy YAML definitions
- ❌ ResourceQuota + LimitRange per namespace
- ❌ HorizontalPodAutoscaler for bot fleet
- ❌ Helm chart packaging
- ❌ Service discovery and DNS routing

**Code Location**: [docker-compose.yml](docker-compose.yml#L1)

**Next Action**: Create `k8s/` directory with namespace, RBAC, and service manifests (can reuse Docker Compose for MVP).

---

### B4: Endpoint Contract Layer ❌ 0% Complete (BLOCKING)

**What's Done:**
- ❌ Nothing

**What's Missing (BLOCKING):**
- ❌ OpenAPI specification (`POST /api/v1/orders`, `DELETE /api/v1/orders/{id}`, `GET /api/v1/orderbook`, `WS /ws/stream`)
- ❌ Request/response schema validation
- ❌ Reverse proxy layer (Envoy/Nginx/FastAPI)
- ❌ Timestamp injection on every request
- ❌ Response schema validation
- ❌ Error handling and standardized error codes

**Risk Level**: 🔴 **BLOCKING**  
Contestants won't know what API to implement without this spec.

**Arch Doc Reference**: Section C4  
**Recommended Implementation**: Create OpenAPI 3.0 schema + implement reverse proxy in FastAPI with middleware for timestamp injection (2-3 hours).

---

### B5: Distributed Bot Fleet 🟡 30% Complete

**What's Done:**
- ✅ Basic load-generator stub (Node.js socket-based)
- ✅ load-generator-controller service skeleton
- ✅ Stress test script (`stress-test.js`)

**What's Missing (CRITICAL FOR LOAD TESTING):**
- ❌ k6 + k6-operator Kubernetes integration
- ❌ xk6 custom extension for HdrHistogram collection
- ❌ WebSocket client implementation (k6 xk6-websockets)
- ❌ Distributed coordination (bot controller → K8s Job dispatch)
- ❌ Order generation logic (Limit orders, Market orders, Cancels with randomized mix)
- ❌ Concurrent connection pooling (1000+ concurrent connections per pod)
- ❌ Latency measurement in bot workers
- ❌ Metrics publishing to Redpanda topic

**Code Location**: [apps/load-generator/](apps/load-generator/)

**Next Action**: 
1. Replace Node.js bot with k6 scripts (JavaScript)
2. Integrate k6-operator CRD for distributed scaling
3. Implement bot payload generation logic

---

### B6: Telemetry Ingestion 🟡 40% Complete

**What's Done:**
- ✅ QuestDB service in Docker Compose
- ✅ Redpanda (Kafka-compatible) in Docker Compose
- ✅ telemetry-ingestor service structure
- ✅ Basic scoring query against QuestDB (skeleton)

**What's Missing:**
- ❌ Stream consumer from Redpanda → QuestDB (ILP ingestion)
- ❌ Kafka consumer group + offset management
- ❌ Batch write optimization to QuestDB
- ❌ Event schema (raw telemetry format: `order_id, send_ts, ack_ts, status, contestant_id, latency_ns`)
- ❌ Data retention/cleanup policies
- ❌ High-write path optimization (HdrHistogram pre-aggregation from bots)
- ❌ Error handling and replay on failure

**Code Location**: [apps/telemetry-ingestor/](apps/telemetry-ingestor/)

**Recommended Stack**: Go consumer using `segmentio/kafka-go` + QuestDB Go client, 5K+ events/sec throughput target.

---

### B7: Correctness Validation 🔴 10% Complete (STUB)

**What's Done:**
- ✅ correctness-engine service skeleton
- ✅ Basic function structure

**What's Missing (HIGH IMPACT):**
- ❌ Deterministic PRNG seeding for workload generation
- ❌ Reference oracle integration (`0x5487/matching-engine` Go binary)
- ❌ Order stream replay execution
- ❌ Fill log collection from contestant service (WebSocket listener)
- ❌ Price-time priority validation logic
- ❌ Fill quantity and timing verification
- ❌ Correctness ratio computation
- ❌ Partial credit scoring (correct price, wrong time)
- ❌ Integration tests with mock fills

**Arch Doc Reference**: Section I - Correctness Validation Strategy  
**Critical Code Path**: 
```python
ref_fills = run_reference_oracle(seeded_orders)
contestant_fills = collect_ws_fills(contestant_ws_url)
correctness_ratio = validate_fills(ref_fills, contestant_fills)
```

**Next Action**: Integrate `0x5487/matching-engine` Go binary as subprocess, implement fill collection via WebSocket, write validation logic.

---

### B8: Scoring Model 🟡 50% Complete

**What's Done:**
- ✅ Basic score computation scaffold in scoring-engine
- ✅ QuestDB query for latency (p95, p99)
- ✅ Throughput calculation
- ✅ Composite score formula (partial)
- ✅ Redis ZADD for leaderboard ranking

**What's Missing:**
- ❌ Complete composite score formula:
  - ❌ Latency normalization (ceiling: e.g., 100ms → p99_score = max(0, 1 - latency/100))
  - ❌ Throughput normalization (target: e.g., 10K TPS → throughput_score = min(1, tps/10000))
  - ❌ Correctness multiplier (gating: if C < 0.5 → final_score = 0)
  - ❌ Weighted combination (suggested: 30% latency, 40% throughput, 30% correctness)
- ❌ Stability penalty (completion_ratio adjustment)
- ❌ Rate-limiting on score API
- ❌ Score history and trend tracking

**Code Location**: [apps/scoring-engine/src/index.ts](apps/scoring-engine/src/index.ts#L1)

**Formula Reference** (from arch doc):
```
final_score = {
  0,                                  if correctness < 0.5
  latency_score × 0.30 +
  throughput_score × 0.40 +           otherwise
  correctness_score × 0.30
}
```

---

### B9: Real-Time Leaderboard UI 🟡 40% Complete

**What's Done:**
- ✅ React + Vite scaffold
- ✅ leaderboard-api HTTP endpoints (`/overview`, `/leaderboard/top`)
- ✅ Redis Sorted Set rankings
- ✅ Metadata join queries (Prisma)

**What's Missing:**
- ❌ WebSocket push integration (Centrifugo or native Socket.io)
- ❌ Live score update subscriptions
- ❌ Animated rank transitions (framer-motion)
- ❌ Leaderboard grid UI components
- ❌ Engine detail view (per-contestant metrics)
- ❌ Real-time graph/chart rendering (latency over time)
- ❌ Contest timeline display

**Code Location**: [apps/web/src/](apps/web/src/)

**Recommended**: Use native WebSocket client (simpler) or Socket.io. Leverage [kelvin-bz/redis-leaderboard](https://github.com/kelvin-bz/redis-leaderboard) as reference.

---

### B10-12: Storage / IaC ✅ 70% Complete

**What's Done:**
- ✅ PostgreSQL + Prisma ORM setup
- ✅ Redis configuration
- ✅ Redpanda (Kafka-compatible)
- ✅ QuestDB time-series database
- ✅ MinIO object storage (S3-compatible)
- ✅ Docker Compose orchestration
- ✅ pnpm monorepo + Turbo build
- ✅ TypeScript + Fastify stack

**What's Missing:**
- ❌ Kubernetes manifests (YAML for all services)
- ❌ Helm charts for easy redeployment
- ❌ Terraform IaC for cloud provisioning (optional stretch)
- ❌ Database migration scripts (Prisma migrations auto-generated)
- ❌ Environment variable documentation

---

## Implementation Roadmap (Revised)

### Week 1: Stabilize Foundation (May 13–19)

**Goals**: Core infrastructure working; basic pipeline end-to-end.

| Task | Owner | Priority | Effort |
|------|-------|----------|--------|
| Fix B4: Implement OpenAPI spec + reverse proxy contract layer | A | 🔴 CRITICAL | 4h |
| Fix B2: Add Docker gVisor runtime + seccomp + cgroup limits | B | 🔴 CRITICAL | 6h |
| Enhance B1: Validate archive contents, parse Dockerfile | A | 🟡 HIGH | 3h |
| Complete B5: Replace load-generator with k6 script | C | 🟡 HIGH | 4h |
| Complete B6: Redpanda → QuestDB consumer pipeline | C | 🟡 HIGH | 5h |
| **Milestone**: Upload sample engine → Build → Deploy → Send 100 requests manually, see metrics in QuestDB |

### Week 2: Distribute Load & Measure (May 20–26)

**Goals**: Bot fleet working; latency metrics flowing; leaderboard updating.

| Task | Owner | Priority | Effort |
|------|-------|----------|--------|
| Integrate k6-operator for distributed bot scaling | C | 🟡 HIGH | 5h |
| Implement HdrHistogram collection in k6 | C | 🟡 HIGH | 4h |
| Complete B7: Reference oracle integration + fill validation | B | 🟡 HIGH | 6h |
| Complete B8: Composite score formula + gating rule | A | 🟡 HIGH | 3h |
| Complete B9: WebSocket leaderboard push + React UI | A | 🟡 HIGH | 6h |
| **Milestone**: Run 1000 concurrent bots, watch leaderboard update live |

### Week 3: Correctness & Security (May 27–June 2)

**Goals**: Full pipeline end-to-end; correctness validation working; security hardened.

| Task | Owner | Priority | Effort |
|------|-------|----------|--------|
| Finalize B7: Correctness validation with edge cases | B | 🟡 HIGH | 5h |
| Create K8s manifests (namespace, NetworkPolicy, ResourceQuota) | A | 🟡 HIGH | 4h |
| Write end-to-end integration tests | C | 🟡 HIGH | 5h |
| Security audit + gVisor validation | B | 🟡 HIGH | 3h |
| Create architecture documentation + design rationale | All | 🟡 HIGH | 6h |
| **Milestone**: Submit buggy engine, verify correctness < 0.5 → score = 0 |

### Week 4: Polish & Submission (June 3–10)

**Goals**: Production-ready; demo-able; fully documented.

| Task | Owner | Priority | Effort |
|------|-------|----------|--------|
| `docker compose up` cold-start test on clean machine | A | 🟡 HIGH | 2h |
| Performance tuning + bottleneck profiling | C | 🟡 HIGH | 3h |
| Write README + setup instructions | All | 🟡 HIGH | 2h |
| Create demo video (submission → build → test → score) | A | 🟡 HIGH | 2h |
| Final architecture blueprint PDF | All | 🟡 HIGH | 3h |
| **Submission**: Code + IaC + Architecture Doc + Demo Video |

---

## Critical Gaps & Blockers

### 🔴 BLOCKING (Fix by End of Week 1)

1. **Endpoint Contract Not Defined** (B4)
   - Contestants can't implement services without knowing the API
   - **Fix**: Define OpenAPI 3.0 spec for `/api/v1/orders`, `/api/v1/orderbook`, `WS /ws/stream`
   - **Time**: 2-3 hours

2. **No Sandbox Isolation** (B2)
   - Untrusted code running with full kernel access = security hole
   - **Fix**: Add gVisor runtime OR Docker seccomp + cgroup limits
   - **Time**: 4-6 hours

3. **Bot Fleet Not Distributed** (B5)
   - Current load-generator is single-node stub
   - **Fix**: Implement k6 + k6-operator for distributed scaling
   - **Time**: 5-7 hours

### 🟡 HIGH PRIORITY (Fix by End of Week 2)

4. **Correctness Validation Incomplete** (B7)
   - Platform can measure speed but not correctness yet
   - **Fix**: Integrate reference oracle, implement fill validation
   - **Time**: 6-8 hours

5. **Scoring Formula Incomplete** (B8)
   - Current scoring is placeholder
   - **Fix**: Implement full normalized weighted formula with gating rule
   - **Time**: 3-4 hours

6. **Telemetry Pipeline Incomplete** (B6)
   - Metrics ingestion not fully wired
   - **Fix**: Build Redpanda → QuestDB consumer
   - **Time**: 5-6 hours

---

## Repository References & Quick Wins

### Direct Reuse (Copy-Paste Ready)

| Component | Repo | Integration Time | Status |
|-----------|------|------------------|--------|
| **k6-operator** | `grafana/k6-operator` | 2-3h | Can start now |
| **Reference Oracle** | `0x5487/matching-engine` | 3-4h | Can start now |
| **Leaderboard Starter** | `kelvin-bz/redis-leaderboard` | 2h | Can start now |
| **Correctness Examples** | `tigeryant/order-matching-engine` | 1h | Study first |

### Adaptation (Needs Customization)

| Component | Repo | Integration Time | Status |
|-----------|------|------------------|--------|
| **HdrHistogram** | `HdrHistogram/hdrhistogram-go` | 4-5h | In progress |
| **k6 WebSocket** | `xk6-websockets` | 3-4h | To start |
| **Prometheus/Grafana** | Standard images | 2-3h | Can integrate week 2 |

---

## Team Assignment Recommendation

**Assuming 3-person team:**

- **Person A (Backend/API)**: B1, B4, B8, B9, IaC
- **Person B (Security/Sandbox)**: B2, B3, B7, correctness oracle integration
- **Person C (Performance/Telemetry)**: B5, B6, load testing, monitoring

---

## Known Issues & Risks

| Issue | Severity | Mitigation |
|-------|----------|-----------|
| gVisor incompatibility with contestant code | Medium | Fall back to seccomp + AppArmor |
| k6-operator K8s setup takes too long | Medium | Use Docker Compose bot fleet as fallback |
| Correctness validator has false positives | Medium | Extensive unit tests against known fills |
| Redpanda consumer lagging at high load | Low | Buffer in Redis, batch writes to QuestDB |
| Floating-point price comparison bugs | Medium | Store prices as integers (cents) |

---

## Next Immediate Actions (Priority Order)

### **TODAY (May 13):**
1. ✅ Review this status document with team
2. ✅ Assign week 1 tasks by person
3. ⏳ **Start**: Define OpenAPI spec for endpoint contract (B4) — blocking other work
4. ⏳ **Start**: Add gVisor to Docker runtime (B2) — security critical

### **Tomorrow (May 14):**
5. **Validate** endpoint contract spec with sample contestant code
6. **Integrate** reference oracle (`0x5487/matching-engine`)
7. **Prototype** k6 bot script with WebSocket

### **By May 19 (End of Week 1):**
- [x] B1: Submission pipeline enhanced
- [x] B2: Sandbox isolated + hardened
- [x] B4: Endpoint contract defined + reverse proxy implemented
- [x] B5: k6 bot fleet prototype working
- [x] B6: Telemetry pipeline flowing to QuestDB
- [x] B8: Composite score formula implemented
- **Milestone**: End-to-end pipeline working (upload → build → deploy → test → score)

---

## Additional Context for Your Secondary Plan

**You mentioned: "I also have another plan"**

Please share your secondary plan/approach:
- Are you thinking of architectural changes?
- New technologies to evaluate?
- Scale targets or performance targets?
- Timeline/deadline changes?

I can incorporate this into the roadmap and provide targeted guidance.

---

**Generated**: May 13, 2026 | **Last Reviewed**: Commit `40154a8` (BullMQ migration)
