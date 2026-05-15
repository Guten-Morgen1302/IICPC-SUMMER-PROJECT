import { createContext, useContext, useEffect, useMemo, useState } from 'react'
import type { ReactNode } from 'react'
import { AnimatePresence, motion } from 'framer-motion'
import {
  Activity,
  ArrowDown,
  ArrowUp,
  Bot,
  BrainCircuit,
  Braces,
  ChevronRight,
  Database,
  Filter,
  GitBranch,
  LayoutDashboard,
  LineChart as LeaderboardChartIcon,
  MonitorDot,
  RadioTower,
  Search,
  Server,
  ShieldAlert,
  ShieldCheck,
  Signal,
  SlidersHorizontal,
  Timer,
  TriangleAlert,
  Waypoints,
  Waves,
} from 'lucide-react'
import {
  Area,
  AreaChart,
  Bar,
  BarChart,
  CartesianGrid,
  Legend,
  Line,
  LineChart,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts'
import { Navigate, Outlet, Route, Routes, NavLink } from 'react-router-dom'
import { MockTelemetryBridge, REGIME_PROFILES } from './mockTelemetry'
import type { EventEntry, LeaderboardEntry, MarketRegime, TelemetrySnapshot } from './types'
import './dashboard.css'

type TelemetryContextValue = {
  snapshot: TelemetrySnapshot
  setRegime: (regime: MarketRegime) => void
}

const TelemetryContext = createContext<TelemetryContextValue | null>(null)

function useTelemetry() {
  const context = useContext(TelemetryContext)
  if (!context) {
    throw new Error('useTelemetry must be used inside the dashboard telemetry provider')
  }
  return context
}

function formatNumber(value: number, digits = 0) {
  return new Intl.NumberFormat('en-US', { maximumFractionDigits: digits, minimumFractionDigits: digits }).format(value)
}

function formatCompact(value: number) {
  if (Math.abs(value) >= 1000) return `${(value / 1000).toFixed(1)}K`
  return formatNumber(value, value < 10 ? 1 : 0)
}

function statusTone(status: string) {
  if (status === 'critical') return 'critical'
  if (status === 'degraded') return 'warning'
  return 'healthy'
}

function useTelemetryBridge() {
  const bridge = useMemo(() => new MockTelemetryBridge(), [])
  const [snapshot, setSnapshot] = useState(bridge.getSnapshot())

  useEffect(() => bridge.subscribe(setSnapshot), [bridge])

  return { snapshot, setRegime: (regime: MarketRegime) => bridge.setRegime(regime) }
}

function TelemetryProvider({ children }: { children: ReactNode }) {
  return <TelemetryContextProvider>{children}</TelemetryContextProvider>
}

function TelemetryContextProvider({ children }: { children: ReactNode }) {
  const value = useTelemetryBridge()
  return <TelemetryContext.Provider value={value}>{children}</TelemetryContext.Provider>
}

export function SystemHealthBadge({ status }: { status: TelemetrySnapshot['systemStatus'] }) {
  return <span className={`health-badge ${statusTone(status)}`}>{status.replace('_', ' ')}</span>
}

export function MetricCard({ label, value, delta, icon: Icon, tone = 'neutral', subtext }: { label: string; value: string | number; delta?: string; icon: any; tone?: 'neutral' | 'accent' | 'success' | 'warning' | 'critical'; subtext?: string }) {
  return (
    <div className={`metric-card tone-${tone}`}>
      <div className="metric-card-head">
        <span className="metric-label">{label}</span>
        <Icon size={16} />
      </div>
      <div className="metric-value">{value}</div>
      <div className="metric-footer">
        {delta ? <span className="metric-delta">{delta}</span> : <span className="metric-delta dim">live telemetry</span>}
        {subtext ? <span className="metric-subtext">{subtext}</span> : null}
      </div>
    </div>
  )
}

function chartTooltipLabel(label: unknown) {
  return typeof label === 'number' ? `t=${label}` : String(label)
}

export function TelemetryChart({
  title,
  subtitle,
  data,
  lines,
  xKey = 'tick',
  height = 260,
  chartType = 'line',
  yDomain,
}: {
  title: string
  subtitle?: string
  data: Array<Record<string, number | string>>
  lines: Array<{ key: string; name: string; color: string }>
  xKey?: string
  height?: number
  chartType?: 'line' | 'area' | 'bar'
  yDomain?: [number, number]
}) {
  return (
    <section className="panel telemetry-panel">
      <div className="panel-head">
        <div>
          <div className="panel-title">{title}</div>
          {subtitle ? <div className="panel-subtitle">{subtitle}</div> : null}
        </div>
        <Signal size={16} />
      </div>
      <div style={{ height }}>
        <ResponsiveContainer width="100%" height="100%">
          {chartType === 'area' ? (
            <AreaChart data={data}>
              <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.06)" />
              <XAxis dataKey={xKey} tick={{ fill: '#7e8299', fontSize: 12 }} stroke="rgba(255,255,255,0.08)" />
              <YAxis domain={yDomain} tick={{ fill: '#7e8299', fontSize: 12 }} stroke="rgba(255,255,255,0.08)" />
              <Tooltip contentStyle={{ background: 'rgba(8,10,16,0.96)', border: '1px solid rgba(255,255,255,0.08)', borderRadius: 12 }} labelFormatter={chartTooltipLabel} />
              {lines.map(line => (
                <Area key={line.key} type="monotone" dataKey={line.key} name={line.name} stroke={line.color} fill={line.color} fillOpacity={0.12} strokeWidth={2} />
              ))}
            </AreaChart>
          ) : chartType === 'bar' ? (
            <BarChart data={data}>
              <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.06)" />
              <XAxis dataKey={xKey} tick={{ fill: '#7e8299', fontSize: 12 }} stroke="rgba(255,255,255,0.08)" />
              <YAxis tick={{ fill: '#7e8299', fontSize: 12 }} stroke="rgba(255,255,255,0.08)" />
              <Tooltip contentStyle={{ background: 'rgba(8,10,16,0.96)', border: '1px solid rgba(255,255,255,0.08)', borderRadius: 12 }} labelFormatter={chartTooltipLabel} />
              {lines.map(line => (
                <Bar key={line.key} dataKey={line.key} name={line.name} fill={line.color} radius={[6, 6, 0, 0]} />
              ))}
            </BarChart>
          ) : (
            <LineChart data={data}>
              <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.06)" />
              <XAxis dataKey={xKey} tick={{ fill: '#7e8299', fontSize: 12 }} stroke="rgba(255,255,255,0.08)" />
              <YAxis domain={yDomain} tick={{ fill: '#7e8299', fontSize: 12 }} stroke="rgba(255,255,255,0.08)" />
              <Tooltip contentStyle={{ background: 'rgba(8,10,16,0.96)', border: '1px solid rgba(255,255,255,0.08)', borderRadius: 12 }} labelFormatter={chartTooltipLabel} />
              <Legend />
              {lines.map(line => (
                <Line key={line.key} type="monotone" dataKey={line.key} name={line.name} stroke={line.color} strokeWidth={2.2} dot={false} activeDot={{ r: 4 }} />
              ))}
            </LineChart>
          )}
        </ResponsiveContainer>
      </div>
    </section>
  )
}

export function LiveEventFeed({ events }: { events: EventEntry[] }) {
  return (
    <section className="panel">
      <div className="panel-head">
        <div>
          <div className="panel-title">Event Stream</div>
          <div className="panel-subtitle">Live operational logs from the mock telemetry bridge.</div>
        </div>
        <RadioTower size={16} />
      </div>
      <div className="event-feed">
        <AnimatePresence initial={false} mode="popLayout">
          {events.map(event => (
            <motion.div key={event.id} layout initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -8 }} className={`event-row level-${event.level}`}>
              <span className="event-time">[{event.timestamp}]</span>
              <span className="event-message">{event.message}</span>
            </motion.div>
          ))}
        </AnimatePresence>
      </div>
    </section>
  )
}

export function RegimeSwitcher({ selected, onSelect }: { selected: MarketRegime; onSelect: (regime: MarketRegime) => void }) {
  return (
    <div className="regime-grid">
      {REGIME_PROFILES.map(profile => {
        const active = profile.id === selected
        return (
          <button key={profile.id} type="button" className={`regime-card ${active ? 'active' : ''}`} onClick={() => onSelect(profile.id)}>
            <div className="regime-card-top">
              <div>
                <div className="regime-title">{profile.label}</div>
                <div className="regime-id">{profile.id}</div>
              </div>
              <ChevronRight size={16} />
            </div>
            <p className="regime-description">{profile.description}</p>
            <div className="regime-bars">
              <div><span>Volatility</span><i style={{ width: `${profile.volatility * 100}%` }} /></div>
              <div><span>Cancel intensity</span><i style={{ width: `${profile.cancelIntensity * 100}%` }} /></div>
              <div><span>Order burstiness</span><i style={{ width: `${profile.burstiness * 100}%` }} /></div>
              <div><span>Aggressiveness</span><i style={{ width: `${profile.aggressiveness * 100}%` }} /></div>
            </div>
          </button>
        )
      })}
    </div>
  )
}

export function LeaderboardTable({ rows }: { rows: LeaderboardEntry[] }) {
  return (
    <div className="table-shell">
      <table className="dashboard-table">
        <thead>
          <tr>
            <th>Rank</th>
            <th>Contestant</th>
            <th>Q-Score</th>
            <th>p50</th>
            <th>p99</th>
            <th>TPS</th>
            <th>Correctness</th>
            <th>Stability</th>
            <th>Regime</th>
            <th>Status</th>
          </tr>
        </thead>
        <tbody>
          <AnimatePresence initial={false}>
            {rows.map(row => (
              <motion.tr key={row.id} layout initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}>
                <td>
                  <span className={`rank-pill rank-${row.rank <= 3 ? row.rank : 0}`}>
                    {row.previousRank !== row.rank && row.previousRank ? (
                      <>{row.rank}<span className="rank-shift">{row.previousRank > row.rank ? <ArrowUp size={11} /> : <ArrowDown size={11} />}</span></>
                    ) : row.rank}
                  </span>
                </td>
                <td>
                  <div className="leader-name">
                    <span>{row.name}</span>
                    {row.sticky ? <span className="sticky-pill">sticky</span> : null}
                  </div>
                </td>
                <td className="mono strong">{row.qScore.toFixed(2)}</td>
                <td className="mono">{row.p50LatencyMs.toFixed(1)} ms</td>
                <td className="mono">{row.p99LatencyMs.toFixed(1)} ms</td>
                <td className="mono">{formatCompact(row.tps)}</td>
                <td className="mono">{row.correctness.toFixed(2)}%</td>
                <td className="mono">{row.stability.toFixed(1)}%</td>
                <td className="mono regime-pill">{row.regime.replace('_', ' ')}</td>
                <td><span className={`health-badge ${statusTone(row.status)}`}>{row.status}</span></td>
              </motion.tr>
            ))}
          </AnimatePresence>
        </tbody>
      </table>
    </div>
  )
}

function Heatmap({ cells }: { cells: TelemetrySnapshot['heatmap'] }) {
  const min = Math.min(...cells.map(cell => cell.value))
  const max = Math.max(...cells.map(cell => cell.value))
  return (
    <section className="panel">
      <div className="panel-head">
        <div>
          <div className="panel-title">Correctness Heatmap</div>
          <div className="panel-subtitle">Stress intensity vs semantic stability across matching windows.</div>
        </div>
        <BrainCircuit size={16} />
      </div>
      <div className="heatmap-grid">
        {cells.map(cell => {
          const alpha = (cell.value - min) / Math.max(1, max - min)
          return <motion.div key={`${cell.x}-${cell.y}`} className="heat-cell" title={`${cell.label}: ${cell.value.toFixed(1)}%`} animate={{ opacity: 0.72 + alpha * 0.28 }} style={{ background: `rgba(0, 229, 255, ${0.08 + alpha * 0.56})` }} />
        })}
      </div>
      <div className="heatmap-legend"><span>low correctness</span><span>high correctness</span></div>
    </section>
  )
}

function TopologyDiagram() {
  const nodes = [
    { id: 'submission', label: 'Submission API', tone: 'accent' },
    { id: 'sandbox', label: 'Sandbox Containers', tone: 'warning' },
    { id: 'bot', label: 'Bot Fleet', tone: 'success' },
    { id: 'stream', label: 'Redpanda / Kafka', tone: 'accent' },
    { id: 'timescale', label: 'TimescaleDB', tone: 'neutral' },
    { id: 'correctness', label: 'Correctness Oracle', tone: 'critical' },
    { id: 'scoring', label: 'Scoring Engine', tone: 'accent' },
    { id: 'leaderboard', label: 'Leaderboard Service', tone: 'success' },
  ]

  return (
    <section className="panel topology-panel">
      <div className="panel-head">
        <div>
          <div className="panel-title">System Architecture</div>
          <div className="panel-subtitle">Live data path from submission intake to leaderboard publication.</div>
        </div>
        <Waypoints size={16} />
      </div>
      <div className="topology-grid">
        {nodes.map((node, index) => (
          <motion.div key={node.id} className={`topology-node tone-${node.tone}`} initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: index * 0.05 }}>
            <div className="node-label">{node.label}</div>
            <div className="node-subtext">streaming</div>
          </motion.div>
        ))}
        <div className="flow-line flow-a" />
        <div className="flow-line flow-b" />
        <div className="flow-line flow-c" />
        <div className="flow-line flow-d" />
      </div>
    </section>
  )
}

function DashboardHeader({ title, subtitle }: { title: string; subtitle: string }) {
  const { snapshot } = useTelemetry()
  return (
    <div className="page-header">
      <div>
        <div className="eyebrow">Q-Time Research Dashboard</div>
        <h1>{title}</h1>
        <p>{subtitle}</p>
      </div>
      <div className="page-header-right">
        <SystemHealthBadge status={snapshot.systemStatus} />
        <div className="time-box"><span>regime</span><strong>{snapshot.regimeProfile.label}</strong></div>
      </div>
    </div>
  )
}

function ShellNav() {
  return (
    <aside className="sidebar">
      <div className="brand-lockup">
        <div className="brand-glyph">Q</div>
        <div>
          <div className="brand-title">Q-Time</div>
          <div className="brand-subtitle">Correctness-aware benchmarking</div>
        </div>
      </div>
      <div className="sidebar-section">
        <div className="sidebar-heading">Operations</div>
        <NavLink to="stress" className={({ isActive }) => `nav-link ${isActive ? 'active' : ''}`}><LayoutDashboard size={16} /> Live Stress</NavLink>
        <NavLink to="leaderboard" className={({ isActive }) => `nav-link ${isActive ? 'active' : ''}`}><LeaderboardChartIcon size={16} /> Global Leaderboard</NavLink>
        <NavLink to="regimes" className={({ isActive }) => `nav-link ${isActive ? 'active' : ''}`}><SlidersHorizontal size={16} /> Regime Control</NavLink>
        <NavLink to="correctness" className={({ isActive }) => `nav-link ${isActive ? 'active' : ''}`}><ShieldAlert size={16} /> Correctness Analytics</NavLink>
        <NavLink to="architecture" className={({ isActive }) => `nav-link ${isActive ? 'active' : ''}`}><GitBranch size={16} /> Architecture</NavLink>
      </div>
      <div className="sidebar-section compact">
        <div className="sidebar-heading">Research thesis</div>
        <p className="sidebar-copy">Correctness collapses before throughput collapses under flash crash, cancellation storm, and liquidity drought regimes.</p>
      </div>
    </aside>
  )
}

function LiveStressDashboardPage() {
  const { snapshot, setRegime } = useTelemetry()
  const latest = snapshot.series[snapshot.series.length - 1]
  const telemetrySeries = snapshot.series.map(point => ({ tick: point.tick, tps: Math.round(point.tps), p99: Number(point.p99.toFixed(1)), correctness: Number(point.correctness.toFixed(2)), arrivalRate: Math.round(point.arrivalRate), cancelRatio: Number((point.cancelRatio * 100).toFixed(1)), cpu: Number(point.cpu.toFixed(1)), memory: Number(point.memory.toFixed(1)) }))

  return (
    <div className="dashboard-page">
      <DashboardHeader title="Live Stress Test Dashboard" subtitle="Observability console for bot-fleet stress, order flow, and correctness collapse dynamics." />
      <div className="metric-grid">
        <MetricCard label="TPS" value={formatCompact(latest?.tps ?? 0)} delta="streaming" icon={Activity} tone="accent" subtext="throughput" />
        <MetricCard label="p99 Latency" value={`${(latest?.p99 ?? 0).toFixed(1)} ms`} icon={Timer} tone="warning" subtext="tail latency" />
        <MetricCard label="Correctness" value={`${(latest?.correctness ?? 0).toFixed(2)}%`} icon={ShieldCheck} tone="success" subtext="semantic stability" />
        <MetricCard label="Fill Accuracy" value={`${(latest?.fillAccuracy ?? 0).toFixed(1)}%`} icon={Signal} tone="neutral" subtext="execution quality" />
        <MetricCard label="Priority Violations" value={snapshot.priorityViolations} icon={TriangleAlert} tone="critical" subtext="queue semantics" />
        <MetricCard label="Replay Mismatches" value={snapshot.replayMismatches} icon={Braces} tone="critical" subtext="determinism drift" />
      </div>
      <div className="page-grid two-up">
        <TelemetryChart title="Throughput, Latency, and Correctness" subtitle="The stress signature: correctness degrades before throughput fully collapses." data={telemetrySeries} lines={[{ key: 'tps', name: 'TPS', color: '#00e5ff' }, { key: 'p99', name: 'p99 latency', color: '#ff4d00' }, { key: 'correctness', name: 'correctness %', color: '#00ff88' }]} chartType="line" height={300} />
        <TelemetryChart title="Order Flow, Cancel Ratio, and Host Load" subtitle="Bursty traffic, cancellations, and infrastructure pressure under live regime changes." data={telemetrySeries} lines={[{ key: 'arrivalRate', name: 'order arrival rate', color: '#7c8cff' }, { key: 'cancelRatio', name: 'cancel ratio %', color: '#ffd166' }, { key: 'cpu', name: 'CPU %', color: '#ff6b9a' }, { key: 'memory', name: 'memory %', color: '#8bffb0' }]} chartType="area" height={300} />
      </div>
      <div className="page-grid three-up">
        <TelemetryChart title="Latency Distribution" subtitle="Mocked histogram from live tail samples." data={snapshot.latencyHistogram.map(bin => ({ bin: bin.label, value: bin.value }))} lines={[{ key: 'value', name: 'latency samples', color: '#ff4d00' }]} chartType="bar" xKey="bin" height={250} />
        <TelemetryChart title="Order Size Distribution" subtitle="Burst-driven lot sizing under stress." data={snapshot.orderSizeHistogram.map(bin => ({ bin: bin.label, value: bin.value }))} lines={[{ key: 'value', name: 'order sizes', color: '#00e5ff' }]} chartType="bar" xKey="bin" height={250} />
        <LiveEventFeed events={snapshot.events} />
      </div>
      <div className="page-grid split-rail">
        <section className="panel">
          <div className="panel-head"><div><div className="panel-title">Live Metrics</div><div className="panel-subtitle">Active engine and infrastructure counters.</div></div><Database size={16} /></div>
          <div className="mini-metric-grid">
            <MetricCard label="Active bots" value={snapshot.activeBots} icon={Bot} tone="neutral" />
            <MetricCard label="Orders/sec" value={formatCompact(snapshot.ordersPerSecond)} icon={RadioTower} tone="accent" />
            <MetricCard label="Failed orders" value={snapshot.failedOrders} icon={ShieldAlert} tone="critical" />
            <MetricCard label="Priority violations" value={snapshot.priorityViolations} icon={TriangleAlert} tone="warning" />
          </div>
        </section>
        <section className="panel regime-preview">
          <div className="panel-head"><div><div className="panel-title">Regime preview</div><div className="panel-subtitle">Current market state and expected pressure profile.</div></div><Waves size={16} /></div>
          <div className="profile-stack">
            <div className="profile-row"><span>Volatility</span><strong>{(snapshot.regimeProfile.volatility * 100).toFixed(0)}%</strong></div>
            <div className="profile-row"><span>Cancel intensity</span><strong>{(snapshot.regimeProfile.cancelIntensity * 100).toFixed(0)}%</strong></div>
            <div className="profile-row"><span>Burstiness</span><strong>{(snapshot.regimeProfile.burstiness * 100).toFixed(0)}%</strong></div>
            <div className="profile-row"><span>Aggressiveness</span><strong>{(snapshot.regimeProfile.aggressiveness * 100).toFixed(0)}%</strong></div>
          </div>
          <div className="regime-actions">
            {REGIME_PROFILES.map(profile => <button key={profile.id} type="button" className={`regime-chip ${profile.id === snapshot.regime ? 'active' : ''}`} onClick={() => setRegime(profile.id)}>{profile.label}</button>)}
          </div>
        </section>
      </div>
    </div>
  )
}

function GlobalLeaderboardPage() {
  const { snapshot, setRegime } = useTelemetry()
  const [query, setQuery] = useState('')
  const [regimeFilter, setRegimeFilter] = useState<'all' | MarketRegime>('all')
  const [sortKey, setSortKey] = useState<'qScore' | 'correctness' | 'p99' | 'tps'>('qScore')

  const filtered = useMemo(() => {
    return snapshot.leaderboard
      .filter(row => (query ? row.name.toLowerCase().includes(query.toLowerCase()) : true))
      .filter(row => (regimeFilter === 'all' ? true : row.regime === regimeFilter))
      .sort((left, right) => {
        switch (sortKey) {
          case 'correctness': return right.correctness - left.correctness
          case 'p99': return left.p99LatencyMs - right.p99LatencyMs
          case 'tps': return right.tps - left.tps
          case 'qScore':
          default: return right.qScore - left.qScore
        }
      })
      .map((row, index) => ({ ...row, rank: index + 1 }))
  }, [query, regimeFilter, snapshot.leaderboard, sortKey])

  const topThree = filtered.slice(0, 3)

  return (
    <div className="dashboard-page">
      <DashboardHeader title="Global Leaderboard" subtitle="Live ranking of contestant engines with correctness, stability, and latency under stress-aware scoring." />
      <div className="leaderboard-rail">
        {topThree.map(row => <motion.article key={row.id} layout className="podium-card"><div className="podium-rank">#{row.rank}</div><div className="podium-name">{row.name}</div><div className="podium-score">{row.qScore.toFixed(2)}</div><div className="podium-stats"><span>p99 {row.p99LatencyMs.toFixed(1)} ms</span><span>correctness {row.correctness.toFixed(2)}%</span><span>{row.regime.replace('_', ' ')}</span></div></motion.article>)}
      </div>
      <section className="panel control-strip">
        <div className="control-field"><Search size={14} /><input value={query} onChange={event => setQuery(event.target.value)} placeholder="Filter contestant" /></div>
        <div className="control-field compact"><Filter size={14} /><select value={regimeFilter} onChange={event => setRegimeFilter(event.target.value as 'all' | MarketRegime)}><option value="all">All regimes</option>{REGIME_PROFILES.map(profile => <option key={profile.id} value={profile.id}>{profile.label}</option>)}</select></div>
        <div className="control-field compact"><SlidersHorizontal size={14} /><select value={sortKey} onChange={event => setSortKey(event.target.value as typeof sortKey)}><option value="qScore">Q-Score</option><option value="correctness">Correctness</option><option value="p99">p99 latency</option><option value="tps">TPS</option></select></div>
        <button className="ghost-button" type="button" onClick={() => setRegime(snapshot.regime)}>Recenter current regime</button>
      </section>
      <LeaderboardTable rows={filtered} />
    </div>
  )
}

function RegimeControlPage() {
  const { snapshot, setRegime } = useTelemetry()
  return (
    <div className="dashboard-page">
      <DashboardHeader title="Market Regime Control Panel" subtitle="Switch stress regimes and observe how throughput, latency, and correctness evolve in response." />
      <section className="panel"><div className="panel-head"><div><div className="panel-title">Regime switcher</div><div className="panel-subtitle">Trading-simulation control center for research scenarios.</div></div><SlidersHorizontal size={16} /></div><RegimeSwitcher selected={snapshot.regime} onSelect={setRegime} /></section>
      <div className="page-grid two-up">
        <section className="panel"><div className="panel-head"><div><div className="panel-title">Current regime profile</div><div className="panel-subtitle">Telemetry pressure model used by the mock stream.</div></div><Waves size={16} /></div><div className="profile-stack large"><div className="profile-row"><span>Label</span><strong>{snapshot.regimeProfile.label}</strong></div><div className="profile-row"><span>Volatility</span><strong>{(snapshot.regimeProfile.volatility * 100).toFixed(0)}%</strong></div><div className="profile-row"><span>Cancel intensity</span><strong>{(snapshot.regimeProfile.cancelIntensity * 100).toFixed(0)}%</strong></div><div className="profile-row"><span>Burstiness</span><strong>{(snapshot.regimeProfile.burstiness * 100).toFixed(0)}%</strong></div><div className="profile-row"><span>Aggressiveness</span><strong>{(snapshot.regimeProfile.aggressiveness * 100).toFixed(0)}%</strong></div></div></section>
        <TelemetryChart title="Regime Pressure Preview" subtitle="How live telemetry moves as the selected regime intensifies." data={snapshot.stressCurve.map(point => ({ stress: point.stress, correctness: Number(point.correctness.toFixed(2)), tps: Math.round(point.tps), latency: Number(point.latency.toFixed(1)) }))} lines={[{ key: 'correctness', name: 'correctness %', color: '#00ff88' }, { key: 'tps', name: 'TPS', color: '#00e5ff' }, { key: 'latency', name: 'latency', color: '#ff4d00' }]} xKey="stress" height={330} />
      </div>
    </div>
  )
}

function CorrectnessAnalyticsPage() {
  const { snapshot } = useTelemetry()
  const latest = snapshot.series[snapshot.series.length - 1]
  return (
    <div className="dashboard-page">
      <DashboardHeader title="Correctness Analytics" subtitle="Research view for fairness violations, priority drift, replay mismatches, and semantic collapse." />
      <div className="metric-grid">
        <MetricCard label="Fairness violations" value={Math.max(0, Math.round(snapshot.priorityViolations * 0.8))} icon={ShieldAlert} tone="critical" />
        <MetricCard label="Price-time violations" value={snapshot.priorityViolations} icon={TriangleAlert} tone="warning" />
        <MetricCard label="Incorrect fills" value={snapshot.failedOrders} icon={Bot} tone="critical" />
        <MetricCard label="Replay mismatches" value={snapshot.replayMismatches} icon={Braces} tone="warning" />
        <MetricCard label="Semantic consistency" value={`${(latest?.correctness ?? 0).toFixed(2)}%`} icon={ShieldCheck} tone="success" />
        <MetricCard label="Stress level" value={snapshot.regimeProfile.label} icon={BrainCircuit} tone="accent" />
      </div>
      <div className="page-grid two-up">
        <TelemetryChart title="Correctness vs stress intensity" subtitle="The key result: correctness collapses before throughput collapses." data={snapshot.stressCurve.map(point => ({ stress: point.stress, correctness: Number(point.correctness.toFixed(2)), tps: Math.round(point.tps / 100), latency: Number((point.latency / 2).toFixed(1)) }))} lines={[{ key: 'correctness', name: 'correctness %', color: '#00ff88' }, { key: 'tps', name: 'TPS / 100', color: '#00e5ff' }, { key: 'latency', name: 'latency / 2', color: '#ff4d00' }]} xKey="stress" yDomain={[0, 110]} height={330} />
        <Heatmap cells={snapshot.heatmap} />
      </div>
      <section className="panel"><div className="panel-head"><div><div className="panel-title">Anomaly timeline</div><div className="panel-subtitle">Recent correctness deviations under stress.</div></div><ShieldAlert size={16} /></div><div className="anomaly-timeline">{snapshot.events.map(event => <div key={event.id} className={`anomaly-chip level-${event.level}`}><span>{event.timestamp}</span><strong>{event.message}</strong></div>)}</div></section>
      <section className="panel"><div className="panel-head"><div><div className="panel-title">Correctness collapse curve</div><div className="panel-subtitle">Stress intensity indexed against correctness, throughput, and latency.</div></div><Activity size={16} /></div><div style={{ height: 280 }}><ResponsiveContainer width="100%" height="100%"><LineChart data={snapshot.stressCurve.map(point => ({ stress: point.stress, correctness: Number(point.correctness.toFixed(2)), tps: Math.round(point.tps / 100), latency: Number((point.latency / 2).toFixed(1)) }))}><CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.06)" /><XAxis dataKey="stress" tick={{ fill: '#7e8299', fontSize: 12 }} stroke="rgba(255,255,255,0.08)" /><YAxis tick={{ fill: '#7e8299', fontSize: 12 }} stroke="rgba(255,255,255,0.08)" /><Tooltip contentStyle={{ background: 'rgba(8,10,16,0.96)', border: '1px solid rgba(255,255,255,0.08)', borderRadius: 12 }} /><ReferenceLine y={95} stroke="#00ff88" strokeDasharray="4 4" /><Legend /><Line type="monotone" dataKey="correctness" stroke="#00ff88" strokeWidth={2.2} dot={false} /><Line type="monotone" dataKey="tps" stroke="#00e5ff" strokeWidth={2.2} dot={false} /><Line type="monotone" dataKey="latency" stroke="#ff4d00" strokeWidth={2.2} dot={false} /></LineChart></ResponsiveContainer></div></section>
    </div>
  )
}

function ArchitectureViewPage() {
  return (
    <div className="dashboard-page">
      <DashboardHeader title="System Architecture" subtitle="Submission intake, sandboxing, bot fleet execution, scoring, and leaderboard publication topology." />
      <TopologyDiagram />
      <div className="page-grid two-up">
        <section className="panel"><div className="panel-head"><div><div className="panel-title">Execution flow</div><div className="panel-subtitle">Every stage is instrumented and stream-aligned.</div></div><Activity size={16} /></div><div className="flow-list">{['Submission API accepts contestant archive', 'Sandbox containers isolate build and runtime phases', 'Bot fleet executes dynamic market regimes', 'Telemetry lands in Redpanda / Kafka', 'TimescaleDB stores the time-series evidence', 'Correctness oracle validates semantic invariants', 'Scoring engine emits the live Q-Score', 'Leaderboard service publishes ranked results'].map(step => <div key={step} className="flow-item"><ChevronRight size={14} /><span>{step}</span></div>)}</div></section>
        <section className="panel"><div className="panel-head"><div><div className="panel-title">System health overview</div><div className="panel-subtitle">End-to-end monitoring posture for the benchmark stack.</div></div><Server size={16} /></div><div className="health-grid">{['Submission API', 'Sandbox containers', 'Bot fleet', 'Telemetry bus', 'Scoring engine', 'Correctness oracle', 'Leaderboard service'].map(name => <div key={name} className="health-row"><span>{name}</span><SystemHealthBadge status="healthy" /></div>)}</div></section>
      </div>
    </div>
  )
}

function DashboardLayout() {
  const { snapshot } = useTelemetry()
  return (
    <div className="dashboard-shell">
      <ShellNav />
      <main className="dashboard-main">
        <div className="dashboard-topbar">
          <div className="topbar-stats"><span><Bot size={14} /> {snapshot.activeBots} active bots</span><span><Timer size={14} /> {formatCompact(snapshot.ordersPerSecond)} orders/sec</span><span><ShieldAlert size={14} /> {snapshot.failedOrders} failed orders</span></div>
          <div className="topbar-badges"><span className="pill"><MonitorDot size={14} /> native websocket mock</span><span className="pill subtle"><Server size={14} /> realtime telemetry</span></div>
        </div>
        <Outlet />
      </main>
    </div>
  )
}

function DashboardRoutes() {
  return (
    <Routes>
      <Route element={<TelemetryProvider><DashboardLayout /></TelemetryProvider>}>
        <Route index element={<Navigate to="stress" replace />} />
        <Route path="stress" element={<LiveStressDashboardPage />} />
        <Route path="leaderboard" element={<GlobalLeaderboardPage />} />
        <Route path="regimes" element={<RegimeControlPage />} />
        <Route path="correctness" element={<CorrectnessAnalyticsPage />} />
        <Route path="architecture" element={<ArchitectureViewPage />} />
      </Route>
    </Routes>
  )
}

export function DashboardApp() {
  return <DashboardRoutes />
}
