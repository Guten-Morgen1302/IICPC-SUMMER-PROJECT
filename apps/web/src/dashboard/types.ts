export type MarketRegime =
  | 'CALM_MARKET'
  | 'VOLATILE_MARKET'
  | 'FLASH_CRASH'
  | 'CANCELLATION_STORM'
  | 'LIQUIDITY_DROUGHT'

export type SystemStatus = 'healthy' | 'degraded' | 'critical'
export type EventLevel = 'info' | 'warn' | 'critical'

export interface RegimeProfile {
  id: MarketRegime
  label: string
  volatility: number
  cancelIntensity: number
  burstiness: number
  aggressiveness: number
  description: string
}

export interface LeaderboardEntry {
  id: string
  name: string
  rank: number
  previousRank: number
  qScore: number
  p50LatencyMs: number
  p99LatencyMs: number
  tps: number
  correctness: number
  stability: number
  regime: MarketRegime
  status: SystemStatus
  sticky: boolean
}

export interface TelemetryPoint {
  tick: number
  tps: number
  p99: number
  correctness: number
  arrivalRate: number
  cancelRatio: number
  cpu: number
  memory: number
  failedOrders: number
  fillAccuracy: number
  priorityViolations: number
  replayMismatches: number
  bots: number
}

export interface HistogramBin {
  label: string
  value: number
}

export interface EventEntry {
  id: string
  timestamp: string
  level: EventLevel
  message: string
}

export interface StressCurvePoint {
  stress: number
  correctness: number
  tps: number
  latency: number
}

export interface CorrectnessHeatCell {
  x: number
  y: number
  value: number
  label: string
}

export interface TelemetrySnapshot {
  regime: MarketRegime
  regimeProfile: RegimeProfile
  leaderboard: LeaderboardEntry[]
  series: TelemetryPoint[]
  latencyHistogram: HistogramBin[]
  orderSizeHistogram: HistogramBin[]
  events: EventEntry[]
  stressCurve: StressCurvePoint[]
  heatmap: CorrectnessHeatCell[]
  activeBots: number
  ordersPerSecond: number
  failedOrders: number
  fillAccuracy: number
  priorityViolations: number
  replayMismatches: number
  systemStatus: SystemStatus
}
