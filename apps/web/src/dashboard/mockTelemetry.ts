import {
  CorrectnessHeatCell,
  EventEntry,
  HistogramBin,
  LeaderboardEntry,
  MarketRegime,
  RegimeProfile,
  StressCurvePoint,
  SystemStatus,
  TelemetryPoint,
  TelemetrySnapshot,
} from './types'

type TelemetryListener = (snapshot: TelemetrySnapshot) => void

const regimeProfiles: RegimeProfile[] = [
  { id: 'CALM_MARKET', label: 'Calm Market', volatility: 0.18, cancelIntensity: 0.12, burstiness: 0.18, aggressiveness: 0.22, description: 'Low noise, stable spreads, high fill predictability.' },
  { id: 'VOLATILE_MARKET', label: 'Volatile Market', volatility: 0.58, cancelIntensity: 0.36, burstiness: 0.54, aggressiveness: 0.46, description: 'Fast repricing, widening spreads, intermittent queue churn.' },
  { id: 'FLASH_CRASH', label: 'Flash Crash', volatility: 0.96, cancelIntensity: 0.84, burstiness: 0.9, aggressiveness: 0.92, description: 'Liquidity vanishes abruptly; correctness degrades before throughput recovers.' },
  { id: 'CANCELLATION_STORM', label: 'Cancellation Storm', volatility: 0.74, cancelIntensity: 0.98, burstiness: 0.74, aggressiveness: 0.64, description: 'Order churn dominates the book and stresses matching semantics.' },
  { id: 'LIQUIDITY_DROUGHT', label: 'Liquidity Drought', volatility: 0.66, cancelIntensity: 0.42, burstiness: 0.33, aggressiveness: 0.82, description: 'Sparse liquidity, erratic fills, slower recovery, elevated slippage.' },
]

const engineNames = ['Alpha Pulse', 'Sigma Arbiter', 'Redline Match', 'Vector Queue', 'Strand Trader', 'Pulse Engine', 'Axiom Book', 'Quanta Router', 'Nexus Trader', 'Delta Fabric', 'Muon Engine', 'Prism Route']
const baseLeaderboardSeeds = [0.992, 0.982, 0.975, 0.961, 0.954, 0.944, 0.938, 0.929, 0.918, 0.909, 0.896, 0.885]

const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value))
const fmtTime = () => new Date().toLocaleTimeString([], { hour12: false })

function rng(seed: number) {
  let t = seed + 0x6d2b79f5
  return () => {
    t += 0x6d2b79f5
    let x = Math.imul(t ^ (t >>> 15), 1 | t)
    x ^= x + Math.imul(x ^ (x >>> 7), 61 | x)
    return ((x ^ (x >>> 14)) >>> 0) / 4294967296
  }
}

function jitter(random: () => number, amplitude: number) {
  return (random() - 0.5) * 2 * amplitude
}

function getRegimeProfile(regime: MarketRegime): RegimeProfile {
  return regimeProfiles.find(profile => profile.id === regime) ?? regimeProfiles[0]
}

function systemStatus(correctness: number, stability: number, p99: number): SystemStatus {
  if (correctness < 92 || stability < 84 || p99 > 140) return 'critical'
  if (correctness < 97 || stability < 92 || p99 > 95) return 'degraded'
  return 'healthy'
}

function createEvents(regime: MarketRegime, correctness: number, p99: number, initial = false): EventEntry[] {
  const stamp = `${Date.now()}-${Math.floor(Math.random() * 100000)}`
  const events: EventEntry[] = []
  if (initial) {
    events.push({ id: `init-${stamp}`, timestamp: fmtTime(), level: 'info', message: 'Mock telemetry bridge synchronized' })
  }
  if (regime === 'FLASH_CRASH') {
    events.push({ id: `flash-${stamp}`, timestamp: fmtTime(), level: 'critical', message: 'Flash crash regime activated' })
  }
  if (regime === 'CANCELLATION_STORM') {
    events.push({ id: `storm-${stamp}`, timestamp: fmtTime(), level: 'warn', message: 'Cancellation intensity exceeded 0.95' })
  }
  if (correctness < 95) {
    events.push({ id: `correctness-${stamp}`, timestamp: fmtTime(), level: 'critical', message: 'Correctness dropped below 95%' })
  }
  if (correctness < 98 && p99 > 70) {
    events.push({ id: `priority-${stamp}`, timestamp: fmtTime(), level: 'warn', message: 'Queue-order violation detected' })
  }
  return events
}

function createLeaderboardSnapshot(random: () => number, regime: MarketRegime, previous?: LeaderboardEntry[]) {
  const profile = getRegimeProfile(regime)
  const rows: LeaderboardEntry[] = engineNames.map((name, index) => {
    const baseline = baseLeaderboardSeeds[index]
    const regimePenalty = profile.volatility * 0.04 + profile.cancelIntensity * 0.03
    const stability = clamp(98.7 - profile.volatility * 8.5 - index * 0.12 + jitter(random, 1.8), 61, 99.8)
    const correctness = clamp(99.8 - profile.volatility * 7.5 - profile.cancelIntensity * 6.4 - index * 0.1 + jitter(random, 1.4), 78, 99.9)
    const tps = clamp(11500 * baseline * (1 - regimePenalty) + jitter(random, 480), 2600, 12100)
    const p50 = clamp(1.9 + profile.volatility * 8.2 + index * 0.15 + jitter(random, 0.8), 1.4, 34)
    const p99 = clamp(p50 * 3.7 + profile.volatility * 26 + profile.cancelIntensity * 18 + jitter(random, 3.6), 4, 220)
    const qScore = clamp(correctness * 0.33 + stability * 0.23 + (12000 - p99 * 42) / 180 + tps / 380 + index * 0.2 + jitter(random, 1.8), 0, 100)

    return {
      id: `${name.toLowerCase().replace(/\s+/g, '-')}-${index}`,
      name,
      rank: index + 1,
      previousRank: previous?.find(entry => entry.id === `${name.toLowerCase().replace(/\s+/g, '-')}-${index}`)?.rank ?? index + 1,
      qScore,
      p50LatencyMs: p50,
      p99LatencyMs: p99,
      tps,
      correctness,
      stability,
      regime,
      status: systemStatus(correctness, stability, p99),
      sticky: index < 3,
    }
  })

  rows.sort((left, right) => right.qScore - left.qScore)
  return rows.map((row, index) => ({
    ...row,
    previousRank: previous?.find(entry => entry.id === row.id)?.rank ?? row.previousRank,
    rank: index + 1,
    sticky: index < 3,
  }))
}

function createSeries(random: () => number, profile: RegimeProfile, previous: TelemetryPoint[] = [], tick = 0) {
  const nextTick = previous.length ? previous[previous.length - 1].tick + 1 : tick
  const baseStress = profile.volatility * 0.62 + profile.cancelIntensity * 0.18 + profile.burstiness * 0.16
  const arrivalRate = clamp(8200 + baseStress * 3400 + jitter(random, 480), 2200, 16500)
  const cancelRatio = clamp(0.06 + profile.cancelIntensity * 0.72 + jitter(random, 0.03), 0.01, 0.98)
  const tps = clamp(arrivalRate * (0.86 - profile.cancelIntensity * 0.09) - Math.max(0, cancelRatio - 0.55) * 1500 + jitter(random, 280), 1200, 16000)
  const correctnessBase = 99.7 - profile.volatility * 7.8 - profile.cancelIntensity * 8.2 - profile.burstiness * 4.3
  const correctnessDrop = Math.max(0, (profile.volatility - 0.7) * 11) + Math.max(0, cancelRatio - 0.5) * 8.5
  const correctness = clamp(correctnessBase - correctnessDrop + jitter(random, 0.7), 74, 99.95)
  const p99 = clamp(8 + profile.volatility * 55 + profile.cancelIntensity * 24 + Math.max(0, 100 - correctness) * 1.4 + jitter(random, 4), 4, 240)
  const cpu = clamp(32 + profile.volatility * 32 + profile.burstiness * 18 + jitter(random, 4.5), 11, 99)
  const memory = clamp(38 + profile.aggressiveness * 26 + profile.cancelIntensity * 14 + jitter(random, 2.5), 18, 96)
  const failedOrders = Math.max(0, Math.round((100 - correctness) * 2.1 + cancelRatio * 22 + jitter(random, 5)))
  const fillAccuracy = clamp(100 - Math.max(0, 100 - correctness) * 0.9 - cancelRatio * 6 + jitter(random, 0.6), 66, 99.99)
  const priorityViolations = Math.max(0, Math.round((profile.cancelIntensity + profile.volatility) * 14 + Math.max(0, 97 - correctness) * 1.8 + jitter(random, 2)))
  const replayMismatches = Math.max(0, Math.round((100 - correctness) * 0.75 + profile.burstiness * 6 + jitter(random, 1.5)))
  const bots = clamp(46 + Math.round(profile.burstiness * 26 + profile.aggressiveness * 18 + jitter(random, 2)), 24, 108)

  const nextPoint: TelemetryPoint = {
    tick: nextTick,
    tps,
    p99,
    correctness,
    arrivalRate,
    cancelRatio,
    cpu,
    memory,
    failedOrders,
    fillAccuracy,
    priorityViolations,
    replayMismatches,
    bots,
  }

  const series = [...previous, nextPoint].slice(-72)
  if (previous.length && previous[previous.length - 1].correctness > 95 && nextPoint.correctness <= 95) {
    series[series.length - 1] = {
      ...nextPoint,
      correctness: clamp(nextPoint.correctness - 0.7, 70, 99.95),
    }
  }

  return series
}

function createHistograms(series: TelemetryPoint[], profile: RegimeProfile) {
  const latest = series[series.length - 1]
  const p99 = latest?.p99 ?? 30
  const histogramScale = profile.volatility * 0.8 + profile.cancelIntensity * 0.5
  const latencyHistogram: HistogramBin[] = ['0-5', '5-10', '10-20', '20-40', '40-80', '80-160'].map((label, index) => ({ label, value: clamp((index + 1) * 12 + p99 / 5 + histogramScale * 22 - index * 3 + (index >= 4 ? histogramScale * 18 : 0), 4, 94) }))
  const orderSizeHistogram: HistogramBin[] = ['1', '5', '10', '25', '50', '100', '250'].map((label, index) => ({ label, value: clamp(18 + profile.burstiness * 28 + index * 4 + (index === 2 ? 12 : 0) + jitter(rng(index + 17), 4), 4, 94) }))
  return { latencyHistogram, orderSizeHistogram }
}

function createStressCurve(profile: RegimeProfile, random: () => number): StressCurvePoint[] {
  return Array.from({ length: 11 }, (_, index) => {
    const stress = index * 10
    const stressRatio = stress / 100
    const correctness = clamp(99.8 - stressRatio * (profile.volatility * 12 + profile.cancelIntensity * 15 + profile.burstiness * 8) - Math.max(0, stress - 55) * 0.24 + jitter(random, 0.35), 62, 99.95)
    const tps = clamp(15000 - stressRatio * (profile.volatility * 4600 + profile.cancelIntensity * 3300) - Math.max(0, stress - 70) * 18 + jitter(random, 160), 1800, 16000)
    const latency = clamp(7 + stressRatio * (profile.volatility * 52 + profile.cancelIntensity * 26) + Math.max(0, stress - 50) * 0.65 + jitter(random, 1.2), 4, 220)
    return { stress, correctness, tps, latency }
  })
}

function createHeatmap(profile: RegimeProfile, random: () => number): CorrectnessHeatCell[] {
  return Array.from({ length: 5 }, (_, y) => Array.from({ length: 8 }, (_, x) => {
    const stress = x / 7
    const degradation = y / 4
    const value = clamp(98.9 - stress * (profile.volatility * 11 + profile.cancelIntensity * 13) - degradation * 8.8 + jitter(random, 0.9), 58, 99.9)
    return { x, y, value, label: `stress=${Math.round(stress * 100)}%` }
  })).flat()
}

function buildSnapshot(regime: MarketRegime, previous?: TelemetrySnapshot) {
  const profile = getRegimeProfile(regime)
  const random = rng(Math.floor(Date.now() / 1000) + regime.length * 97 + (previous?.series.length ?? 0))
  const series = createSeries(random, profile, previous?.series ?? [], previous?.series[previous?.series.length ? previous.series.length - 1 : 0]?.tick ?? 0)
  const latest = series[series.length - 1]
  const leaderboard = createLeaderboardSnapshot(random, regime, previous?.leaderboard)
  const { latencyHistogram, orderSizeHistogram } = createHistograms(series, profile)
  const stressCurve = createStressCurve(profile, random)
  const heatmap = createHeatmap(profile, random)
  const activeBots = latest?.bots ?? 48
  const ordersPerSecond = Math.round(latest?.arrivalRate ?? 0)
  const failedOrders = latest?.failedOrders ?? 0
  const fillAccuracy = latest?.fillAccuracy ?? 0
  const priorityViolations = latest?.priorityViolations ?? 0
  const replayMismatches = latest?.replayMismatches ?? 0
  const status = systemStatus(latest?.correctness ?? 100, latest ? 100 - latest.cancelRatio * 10 : 100, latest?.p99 ?? 0)
  const events = [...(previous?.events ?? []).slice(-10), ...createEvents(regime, latest?.correctness ?? 100, latest?.p99 ?? 0, !previous)].slice(-14)

  return { regime, regimeProfile: profile, leaderboard, series, latencyHistogram, orderSizeHistogram, events, stressCurve, heatmap, activeBots, ordersPerSecond, failedOrders, fillAccuracy, priorityViolations, replayMismatches, systemStatus: status }
}

export class MockTelemetryBridge {
  private snapshot: TelemetrySnapshot
  private listeners = new Set<TelemetryListener>()
  private timer: number | null = null

  constructor(initialRegime: MarketRegime = 'VOLATILE_MARKET') {
    this.snapshot = buildSnapshot(initialRegime)
  }

  subscribe(listener: TelemetryListener) {
    this.listeners.add(listener)
    listener(this.snapshot)
    this.ensureRunning()
    return () => {
      this.listeners.delete(listener)
      if (!this.listeners.size) this.stop()
    }
  }

  setRegime(regime: MarketRegime) {
    this.snapshot = buildSnapshot(regime, { ...this.snapshot, regime })
    this.emit()
  }

  getSnapshot() {
    return this.snapshot
  }

  private emit() {
    this.listeners.forEach(listener => listener(this.snapshot))
  }

  private ensureRunning() {
    if (this.timer !== null || typeof window === 'undefined') return
    this.timer = window.setInterval(() => {
      this.snapshot = buildSnapshot(this.snapshot.regime, this.snapshot)
      this.emit()
    }, 1200)
  }

  private stop() {
    if (this.timer !== null) {
      window.clearInterval(this.timer)
      this.timer = null
    }
  }
}

export const REGIME_PROFILES = regimeProfiles
