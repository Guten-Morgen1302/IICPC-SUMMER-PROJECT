# Novelty 12: Quick Start Guide - Experiments & Benchmarks

**Status**: Ready to implement  
**Estimated Time**: 3 weeks (implementation) + 2 weeks (experiments)  
**OSDI Submission Target**: Oct 2026

---

## 🎯 30-Second Summary

Byzantine Fault Detection catches colluding engines using:
1. **Vector clocks** - Track causal ordering of orders/fills
2. **Causality validation** - Detect out-of-order fills
3. **Statistical analysis** - Detect correlated order/fill patterns
4. **Risk scoring** - Disqualify Byzantine engines

---

## 📊 Experiments Checklisted (Run in This Order)

### Phase 1: Baseline & Clean Scenario (Week 3-4)

#### Experiment 1.1: Clean Engines Baseline
```bash
# What: Verify detector doesn't false-positive on honest engines
# When: First thing after code is working
# Duration: ~30 min

Setup:
  - 3 independent engines (Alpha, Beta, Gamma)
  - Standard benchmark: 60 seconds, normal regime
  - Run 10 times

Metrics to collect:
  - Causality violations: Should be 0
  - Order correlation (Alpha→Beta): Should be ~0.1-0.3 (random)
  - Risk score: Should be <0.3 (CLEAN)
  
Success Criteria:
  ✅ All engines rated CLEAN
  ✅ Zero false positives
  ✅ Risk scores <0.3
```

#### Experiment 1.2: Performance Baseline
```bash
# What: Measure Byzantine detector overhead
# When: After baseline is CLEAN
# Duration: ~1 hour

Setup:
  - Same 3 clean engines
  - Measure: Scoring time WITH and WITHOUT Byzantine detector
  - Parameters: 10K orders, 50K orders, 100K orders

Metrics to collect:
  - Scoring latency without Byzantine: X ms
  - Scoring latency with Byzantine: Y ms
  - Overhead % = (Y-X)/X * 100
  
Success Criteria:
  ✅ Overhead <30%
  ✅ Sub-second analysis for 100K orders
```

---

### Phase 2: Collusion Detection (Week 4-5)

#### Experiment 2.1: Perfect Collusion Pair
```bash
# What: Detect coordinated order-fill pattern
# When: After 1.1 PASS
# Duration: ~45 min

Setup:
  - Engine-Alpha places orders at price 1000, qty 100
  - Engine-Beta matches them perfectly (same price/qty)
  - Repeat 500 times in 60-second window
  - Run 5 times

Expected behavior:
  - Engine-Alpha: Places Order[1..500]
  - Engine-Beta: Fills Order[1..500] in same sequence
  - Timing: ~10ms between order placement and fill

Metrics to collect:
  - Order correlation (Alpha orders → Beta fills): Should be >0.95
  - Fill correlation (Alpha fills → Beta orders): Should be >0.95
  - Mirror ratio: Should be >0.90
  - Fast fill %: Should be >50% (fills <100μs)
  - Risk score: Should be >0.85

Success Criteria:
  ✅ Correctly identified as DISQUALIFY
  ✅ Correlation >0.95
  ✅ Reason: "Coordinated fill pattern detected"
```

#### Experiment 2.2: Weak Collusion (Edge Case)
```bash
# What: Can detector distinguish collusion from coincidence?
# When: After 2.1 PASS
# Duration: ~1 hour

Setup:
  - Engine-A: Honest
  - Engine-B: Matches only 70% of A's orders (weak collusion)
  - Run multiple times with varying correlation: 0.6, 0.7, 0.8, 0.9

Metrics to collect:
  - Risk score vs correlation curve
  - ROC curve (true positive rate vs false positive rate)
  - Detection threshold: At what correlation does WATCH→DISQUALIFY trigger?

Success Criteria:
  ✅ Threshold identified at ~0.80-0.85 correlation
  ✅ Below threshold: CLEAN
  ✅ Above threshold: DISQUALIFY
```

---

### Phase 3: Byzantine Attacks (Week 5-6)

#### Experiment 3.1: Causality Violations
```bash
# What: Detect out-of-order fills (Byzantine attacker)
# When: After 2.1-2.2 PASS
# Duration: ~45 min

Setup:
  - Engine-Attacker reports fill for Order#100
  - Before Order#100 is placed
  - Or: Report fill for Order#100 before Order#99
  - Run 10 times with 50 violation injections each

Metrics to collect:
  - Causality violations detected: Should be ~50
  - Vector clock violations: Should be 100%
  - Engine rating: Should be DISQUALIFY

Success Criteria:
  ✅ 100% violation detection
  ✅ All violations caught
  ✅ Engine disqualified automatically
```

#### Experiment 3.2: Phantom Fills
```bash
# What: Detect fills without corresponding orders
# When: After 3.1 PASS
# Duration: ~30 min

Setup:
  - Engine-Attacker reports 100 fills
  - But only 80 orders were placed
  - 20 phantom fills (no backing order)

Metrics to collect:
  - Phantom fills detected: Should be 20
  - Detection rate: Should be 100%
  - Recommendation: Should be DISQUALIFY

Success Criteria:
  ✅ All 20 phantom fills detected
  ✅ Correctness engine catches this
  ✅ Score reduced to 0
```

#### Experiment 3.3: Fill Spoofing
```bash
# What: Fill quantity exceeds order quantity
# When: After 3.2 PASS
# Duration: ~30 min

Setup:
  - Order placed: qty=100
  - Multiple fills reported: total qty=150
  - Run 10 times

Metrics to collect:
  - Oversized fills detected: Should be yes
  - Correctness ratio: Should be penalized

Success Criteria:
  ✅ Detected as correctness violation
  ✅ Score penalized proportionally
```

---

### Phase 4: Statistical Validation (Week 6-7)

#### Experiment 4.1: ROC Curve
```bash
# What: Measure detector accuracy across all scenarios
# When: After Phase 3 PASS
# Duration: ~2 hours

Setup:
  - Generate 100 benchmark runs
  - Vary collusion probability: 0%, 10%, 20%, ..., 100%
  - For each: Measure detection accuracy

Metrics to collect:
  - True Positive Rate (TPR): % of collusions detected
  - False Positive Rate (FPR): % of clean runs flagged
  - ROC AUC: Area under curve

Success Criteria:
  ✅ AUC > 0.95 (excellent discrimination)
  ✅ TPR > 95% (catch 95% of collusions)
  ✅ FPR < 2% (false alarm rate < 2%)
```

#### Experiment 4.2: Correlation Threshold Validation
```bash
# What: Find optimal detection threshold
# When: After 4.1 PASS
# Duration: ~1 hour

Setup:
  - Create synthetic order/fill streams with known correlation
  - Vary correlation: 0.5, 0.6, 0.7, 0.8, 0.9, 0.95
  - For each: Run detector 20 times

Metrics to collect:
  - Detection rate vs correlation (sigmoid curve)
  - Optimal threshold: Where detection switches from 0% to 100%
  - Margin: How much tolerance around threshold?

Success Criteria:
  ✅ Threshold identified (~0.80-0.85)
  ✅ Sharp transition (low tolerance = more discriminating)
```

#### Experiment 4.3: Time-Series Stability
```bash
# What: Verify correlation metric doesn't drift
# When: After 4.2 PASS
# Duration: ~1 hour

Setup:
  - Take 1 clean engine pair: Alpha & Beta
  - Measure correlation over different time windows:
    - 10s windows
    - 30s windows
    - 60s windows
  - Run 50 times

Metrics to collect:
  - Correlation variance per window size
  - Coefficient of variation (CV)
  - Stability over time

Success Criteria:
  ✅ CV < 0.1 (low variance, stable metric)
  ✅ Consistent across window sizes
```

---

### Phase 5: Real-World Competition Simulation (Week 7-8)

#### Experiment 5.1: IICPC Competition Simulation
```bash
# What: Full-scale simulation with 50 engines
# When: After all Phase 1-4 tests PASS
# Duration: ~8 hours (background run) + 2 hours analysis

Setup:
  - Simulate 50 teams submitting engines
  - Distribution:
    * 45 clean engines
    * 2 colluding pairs (4 engines)
    * 3 Byzantine attackers
  - Duration: 8 hours of continuous benchmarking
  - Scenario: Stressed regime (toxicity > 0.5)

Metrics to collect:
  - Total orders: Expected ~5M
  - Total fills: Expected ~2.5M
  - Causality violations: X
  - Collusive pairs detected: Y (expected: 2)
  - Byzantine detections: Z (expected: 3)
  - False positives: FP (expected: 0-1)
  
Final Leaderboard (Before Byzantine filtering):
  1. [Colluder-A]  0.920
  2. [Colluder-B]  0.915
  3. [Byzantine-1] 0.888
  4. [Clean-1]     0.756
  5. [Clean-2]     0.743
  ...
  
Final Leaderboard (After Byzantine filtering):
  1. [Clean-1]     0.756
  2. [Clean-2]     0.743
  3. [Clean-3]     0.741
  ...
  Note: Colluders & Byzantine removed

Success Criteria:
  ✅ Collusive pairs detected: 2/2 (100%)
  ✅ Byzantine attackers detected: 3/3 (100%)
  ✅ False positives: 0 (no clean engines disqualified)
  ✅ Clean leaderboard integrity: Top 10 unchanged
```

---

## 📈 Benchmark Metrics to Track

### Core Metrics
```
1. Detection Accuracy
   - Precision = TP / (TP + FP)        Target: >0.95
   - Recall = TP / (TP + FN)           Target: >0.90
   - F1 = 2×(P×R)/(P+R)                Target: >0.92

2. Performance Overhead
   - Baseline scoring: X ms
   - With Byzantine: Y ms
   - Overhead = (Y-X)/X × 100          Target: <30%

3. Scalability
   - Analysis time vs engine count
   - Memory usage vs order count
   - Target: Sub-second for N<200

4. False Positive Rate
   - Clean runs incorrectly flagged / total clean  Target: <2%

5. Detection Rate
   - Actual collusions detected / total colluding  Target: >98%
```

### Per-Experiment Metrics
```
Exp 1.1: Risk score range (should be 0.0-0.3)
Exp 2.1: Correlation values (should be >0.95)
Exp 3.1: Violation count (should be >99)
Exp 4.1: ROC AUC (should be >0.95)
Exp 5.1: Detection rate (should be 100%)
```

---

## 🔄 Feedback Loop & Refinement

### If Detection Rate Too Low
```
Problem: Missing some colluding engines
Solutions:
  1. Lower risk threshold from 0.80 to 0.75
  2. Add more statistical features:
     - Fill timing variance
     - Order size patterns
     - Price deviation analysis
  3. Increase correlation window from 10s to 30s
```

### If False Positive Rate Too High
```
Problem: Flagging honest engines as Byzantine
Solutions:
  1. Increase threshold from 0.80 to 0.85
  2. Require multiple violations (not just one metric)
  3. Add whitelist for known legitimate patterns
```

### If Performance Overhead Unacceptable
```
Problem: Detector takes >30% overhead
Solutions:
  1. Implement incremental VC updates (not full recompute)
  2. Cache collusion analysis results
  3. Run detector asynchronously (off-critical-path)
  4. Sample fills instead of analyzing all (95% sampling = ~19% speedup)
```

---

## 📊 Expected Results Table

| Experiment | Expected Accuracy | Success Metric |
|------------|-------------------|---|
| 1.1: Clean baseline | 100% | 0 false positives |
| 1.2: Performance | <30% overhead | Sub-second latency |
| 2.1: Collusion pair | 100% detection | Risk >0.85 → DISQUALIFY |
| 2.2: Weak collusion | 95% accuracy | ROC AUC >0.95 |
| 3.1: Causality violation | 100% detection | All violations caught |
| 3.2: Phantom fills | 100% detection | All phantoms caught |
| 3.3: Fill spoofing | 100% detection | Correctness penalty |
| 4.1: ROC curve | AUC >0.95 | F1 > 0.92 |
| 4.2: Threshold validation | Stable threshold | Identified at 0.80-0.85 |
| 4.3: Time-series stability | CV < 0.1 | Metric is stable |
| 5.1: Competition sim | 100% / 0 FP | 2/2 collusions, 0 false flags |

---

## 📝 Paper Writing Timeline (After Experiments)

```
Week 9 (Aug 20-26):
  - Write Introduction + Related Work
  - Draft Technical Approach section

Week 10 (Aug 27-Sep 2):
  - Write Experimental Evaluation section
  - Prepare figures and tables from results

Week 11 (Sep 3-9):
  - Write Results & Analysis
  - Create ROC curves, comparison graphs

Week 12 (Sep 10-16):
  - Write Discussion & Conclusions
  - Submit to OSDI (typically deadline ~Oct 1)
```

---

## 🚀 How to Start (Monday Morning)

```
Step 1: Create new service
  mkdir -p apps/byzantine-detector/src
  
Step 2: Create types
  touch packages/shared-types/src/vectorClock.ts
  
Step 3: Implement vector clock manager
  // Copy from NOVELTY_12_DETAILED_IMPLEMENTATION_PLAN.md
  
Step 4: Create Byzantine detector service
  touch apps/byzantine-detector/src/index.ts
  
Step 5: Update database schema
  // Add 3 new tables per plan
  npx prisma migrate dev

Step 6: Run Experiment 1.1 (clean baseline)
  npm run test:byzantine-clean
  
Step 7: Iterate through experiments sequentially
```

---

**This is your complete roadmap to OSDI publication.**

Start with **Experiment 1.1** tomorrow morning.

Good luck! 🚀
