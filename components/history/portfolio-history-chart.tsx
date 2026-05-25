'use client'

import { useMemo, useState, useCallback } from 'react'
import {
  CartesianGrid,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts'
import { money } from '@/lib/format'
import { getChartTicks, getTickFormatter } from '@/lib/domain/chart-ticks'
import { downsampleForPreset, cutoffDateIso } from '@/lib/domain/chart-series'
import type { Preset } from '@/lib/domain/chart-series'
import type { InvestmentType } from '@/types/database'

// ── Prop types ─────────────────────────────────────────────────────────────

export type PortfolioSnapshot = {
  date: string
  total_value_eur: number
  total_invested_eur: number
  total_unrealized_eur: number
  total_realized_eur: number
  snapshot_source: string
}

export type InvSnapshot = {
  date: string
  value_eur: number
  remaining_cost_basis_eur: number
  type: InvestmentType
}

export type LivePoint = {
  date: string
  totalValue: number
  totalInvested: number    // ALL investments incl. cash
  totalUnrealized: number
  totalRealized: number
  byType: { type: InvestmentType; value: number }[]
}

type Props = {
  portfolioSnapshots: PortfolioSnapshot[]
  invSnapshots: InvSnapshot[]
  livePoint?: LivePoint
}

// ── View mode ──────────────────────────────────────────────────────────────

type ViewMode = 'absolute' | 'change_eur' | 'change_pct'

const VIEW_MODES: { key: ViewMode; label: string }[] = [
  { key: 'absolute',   label: '€'  },
  { key: 'change_eur', label: 'Δ€' },
  { key: 'change_pct', label: 'Δ%' },
]

// ── Time presets ───────────────────────────────────────────────────────────

const PRESETS: { key: Preset; label: string }[] = [
  { key: '7d',  label: '7d'  },
  { key: '30d', label: '30d' },
  { key: '90d', label: '90d' },
  { key: '1y',  label: '1y'  },
  { key: 'all', label: 'All' },
]

function filterByPreset(snaps: PortfolioSnapshot[], preset: Preset): PortfolioSnapshot[] {
  if (preset === 'all') return snaps
  const cutoff = cutoffDateIso(preset)
  return snaps.filter((s) => s.date >= cutoff)
}

// ── Series metadata ────────────────────────────────────────────────────────

const TYPE_ORDER: Exclude<InvestmentType, 'cash'>[] = [
  'stock', 'ETF', 'crypto', 'commodity', 'real estate', 'custom',
]

const TYPE_COLORS: Record<string, string> = {
  stock:          '#3b82f6',
  ETF:            '#8b5cf6',
  crypto:         '#f59e0b',
  commodity:      '#d97706',
  'real estate':  '#ef4444',
  custom:         '#6b7280',
}

const TYPE_LABELS: Record<string, string> = {
  stock:         'Stocks',
  ETF:           'ETF',
  crypto:        'Crypto',
  commodity:     'Commodity',
  'real estate': 'Real estate',
  custom:        'Custom',
}

// Main series always read from portfolio_snapshots — accuracy guaranteed.
// Breakdown series (cash, per-type) from investment_snapshots — optional, may
// be absent for historical imported dates.
const STATIC_SERIES = [
  {
    key: 'total_value_eur',
    label: 'Total value',
    color: '#0f172a',
    strokeWidth: 2.5,
    strokeDasharray: undefined as string | undefined,
  },
  {
    key: 'cost_basis_eur',
    label: 'Cost basis',
    color: '#64748b',
    strokeWidth: 1.5,
    strokeDasharray: '5 3',
  },
  {
    key: 'total_profit_eur',
    label: 'Profit / loss',
    color: '#16a34a',
    strokeWidth: 1.5,
    strokeDasharray: undefined as string | undefined,
  },
  {
    key: 'invested_assets_eur',
    label: 'Invested assets',
    color: '#3730a3',
    strokeWidth: 1.5,
    strokeDasharray: undefined as string | undefined,
  },
  {
    key: 'cash_value_eur',
    label: 'Cash',
    color: '#10b981',
    strokeWidth: 1.5,
    strokeDasharray: undefined as string | undefined,
  },
] as const

// ── Date formatters ────────────────────────────────────────────────────────

function fmtLongDate(date: string): string {
  return new Date(`${date}T00:00:00`).toLocaleDateString(undefined, {
    weekday: 'short', year: 'numeric', month: 'short', day: 'numeric',
  })
}

// ── Value formatters ───────────────────────────────────────────────────────

function fmtValue(n: number, mode: ViewMode): string {
  if (!Number.isFinite(n)) return '—'
  if (mode === 'absolute')   return money(n, 'EUR')
  if (mode === 'change_eur') return `${n >= 0 ? '+' : ''}${money(n, 'EUR')}`
  return `${n >= 0 ? '+' : ''}${n.toFixed(2)}%`
}

function fmtYAxis(n: number, mode: ViewMode): string {
  if (!Number.isFinite(n)) return '—'
  if (mode === 'absolute')   return money(n, 'EUR')
  if (mode === 'change_eur') return `${n >= 0 ? '+' : ''}${money(n, 'EUR')}`
  return `${n >= 0 ? '+' : ''}${n.toFixed(1)}%`
}

// ── Color lookup ───────────────────────────────────────────────────────────

function colorForKey(dataKey: string): string {
  const s = STATIC_SERIES.find((x) => x.key === dataKey)
  if (s) return s.color
  return TYPE_COLORS[dataKey] ?? '#9ca3af'
}

// ── Custom tooltip ─────────────────────────────────────────────────────────

type TooltipEntry = { dataKey: string; name: string; value: unknown }

function ChartTooltip({
  active,
  payload,
  label,
  viewMode,
}: {
  active?: boolean
  payload?: TooltipEntry[]
  label?: string
  viewMode: ViewMode
}) {
  if (!active || !payload?.length) return null

  return (
    <div className="min-w-[200px] rounded-xl border border-slate-200 bg-white px-4 py-3 shadow-lg text-xs">
      <p className="mb-2 font-medium text-slate-700">{fmtLongDate(label ?? '')}</p>
      <div className="space-y-1">
        {payload.map((entry) => {
          const val = typeof entry.value === 'number' ? entry.value : Number(entry.value)
          return (
            <div key={entry.dataKey} className="flex items-center justify-between gap-4">
              <div className="flex items-center gap-1.5">
                <span
                  className="inline-block h-2 w-2 shrink-0 rounded-full"
                  style={{ backgroundColor: colorForKey(entry.dataKey) }}
                />
                <span className="text-slate-600">{entry.name}</span>
              </div>
              <span className="tabular-nums font-medium text-slate-900">
                {fmtValue(val, viewMode)}
              </span>
            </div>
          )
        })}
      </div>
    </div>
  )
}

// ── Main component ─────────────────────────────────────────────────────────

// Total value, cost basis, and profit/loss are always on.
// Breakdown series (invested assets, cash, per-type) are off by default
// because they may be absent for imported historical dates.
const DEFAULT_VISIBLE = new Set([
  'total_value_eur',
  'cost_basis_eur',
  'total_profit_eur',
])

export function PortfolioHistoryChart({ portfolioSnapshots, invSnapshots, livePoint }: Props) {
  const [preset,       setPreset]       = useState<Preset>('30d')
  const [viewMode,     setViewMode]     = useState<ViewMode>('absolute')
  const [visibleSeries, setVisibleSeries] = useState<Set<string>>(new Set(DEFAULT_VISIBLE))

  function toggleSeries(key: string) {
    setVisibleSeries((prev) => {
      const next = new Set(prev)
      if (next.has(key)) next.delete(key)
      else next.add(key)
      return next
    })
  }

  // Types (excl. cash) present in any investment_snapshot or livePoint
  const activeTypes = useMemo<Exclude<InvestmentType, 'cash'>[]>(() => {
    const seen = new Set<string>()
    for (const row of invSnapshots) {
      if (row.type !== 'cash') seen.add(row.type)
    }
    if (livePoint) {
      for (const { type } of livePoint.byType) {
        if (type !== 'cash') seen.add(type)
      }
    }
    return TYPE_ORDER.filter((t) => seen.has(t))
  }, [invSnapshots, livePoint])

  // Step 1: date-range filter
  const filtered = useMemo(
    () => filterByPreset(portfolioSnapshots, preset),
    [portfolioSnapshots, preset],
  )

  // Step 2: downsample to one representative point per calendar bucket.
  // This prevents annual anchors (2024-12-31, 2025-12-31) from appearing
  // side-by-side with 25+ daily May points in the "All" view.
  const sampled = useMemo(
    () => downsampleForPreset(filtered, preset),
    [filtered, preset],
  )

  // Step 3: build chart rows.
  //   Main series  → ALWAYS portfolio_snapshots (total_value, cost_basis, profit).
  //   Breakdown    → investment_snapshots or livePoint.byType (per-type, cash).
  //
  // This guarantees cost_basis and profit match Dashboard on every date,
  // regardless of whether investment_snapshots exist for that date.
  const chartData = useMemo(() => {
    const sampledDates = new Set(sampled.map((s) => s.date))

    type Agg = { value: number }
    const invByDate = new Map<string, Map<string, Agg>>()

    for (const row of invSnapshots) {
      if (!sampledDates.has(row.date)) continue
      if (livePoint && row.date === livePoint.date) continue
      let typeMap = invByDate.get(row.date)
      if (!typeMap) { typeMap = new Map(); invByDate.set(row.date, typeMap) }
      const prev = typeMap.get(row.type) ?? { value: 0 }
      typeMap.set(row.type, { value: prev.value + row.value_eur })
    }

    return sampled.map((snap) => {
      const isToday = livePoint != null && snap.date === livePoint.date

      // Gather per-type values for breakdown series
      const typeValues = new Map<string, number>()
      if (isToday && livePoint) {
        for (const { type, value } of livePoint.byType) {
          typeValues.set(type, (typeValues.get(type) ?? 0) + value)
        }
      } else {
        const typeMap = invByDate.get(snap.date)
        if (typeMap) {
          for (const [type, agg] of typeMap) {
            typeValues.set(type, agg.value)
          }
        }
      }

      let cashValue  = 0
      let assetValue = 0
      for (const [type, value] of typeValues) {
        if (type === 'cash') cashValue += value
        else assetValue += value
      }
      // When no investment_snapshots: best-effort — all value assumed non-cash
      if (typeValues.size === 0) {
        assetValue = snap.total_value_eur
      }

      const row: Record<string, number | string> = {
        date:                snap.date,
        // Main series: portfolio_snapshots only — always matches Dashboard
        total_value_eur:     snap.total_value_eur,
        cost_basis_eur:      snap.total_invested_eur,
        total_profit_eur:    snap.total_realized_eur + snap.total_unrealized_eur,
        // Breakdown series: investment_snapshots / livePoint
        invested_assets_eur: assetValue,
        cash_value_eur:      cashValue,
      }

      for (const type of activeTypes) {
        row[type] = typeValues.get(type) ?? 0
      }

      return row
    })
  }, [sampled, invSnapshots, activeTypes, livePoint])

  // Apply view-mode transformation relative to first visible data point
  const displayData = useMemo(() => {
    if (viewMode === 'absolute' || chartData.length === 0) return chartData

    const numericKeys: string[] = [
      ...STATIC_SERIES.map((s) => s.key),
      ...activeTypes,
    ]
    const first = chartData[0]

    return chartData.map((row) => {
      const out: Record<string, number | string> = { date: row.date as string }
      for (const key of numericKeys) {
        const firstVal = Number(first[key]) || 0
        const currVal  = Number(row[key])   || 0
        if (viewMode === 'change_eur') {
          out[key] = currVal - firstVal
        } else {
          out[key] = firstVal !== 0 ? ((currVal / firstVal) - 1) * 100 : 0
        }
      }
      return out
    })
  }, [chartData, viewMode, activeTypes])

  // X-axis: time-aware tick boundaries snapped to actual data points
  const chartDates = useMemo(
    () => displayData.map((d) => d.date as string),
    [displayData],
  )
  const chartTicks = useMemo(() => getChartTicks(chartDates), [chartDates])
  const tickFmt    = useMemo(() => getTickFormatter(chartDates), [chartDates])

  const renderTooltip = useCallback(
    (props: object) => <ChartTooltip {...(props as { active?: boolean; payload?: TooltipEntry[]; label?: string })} viewMode={viewMode} />,
    [viewMode],
  )

  // ── Empty / single-point states ────────────────────────────────────────

  if (portfolioSnapshots.length === 0) {
    return (
      <div className="rounded-2xl border border-slate-200 bg-white p-10 text-center">
        <p className="font-medium text-slate-900">No history yet</p>
        <p className="mt-1 text-sm text-slate-500">
          Click <span className="font-medium">Refresh portfolio</span> on the
          dashboard to start tracking your portfolio over time.
        </p>
      </div>
    )
  }

  if (portfolioSnapshots.length === 1) {
    return (
      <div className="rounded-2xl border border-slate-200 bg-white p-10 text-center">
        <p className="font-medium text-slate-900">Just one data point so far</p>
        <p className="mt-1 text-sm text-slate-500">
          Come back tomorrow after another refresh to see your trend.
        </p>
        <p className="mt-3 text-sm text-slate-700">
          Latest value:{' '}
          <span className="font-semibold">
            {money(portfolioSnapshots[0].total_value_eur, 'EUR')}
          </span>
        </p>
      </div>
    )
  }

  // ── Summary header stats ───────────────────────────────────────────────

  const hasSampled = sampled.length > 0
  const startSnap  = hasSampled ? sampled[0] : null
  const endSnap    = hasSampled ? sampled[sampled.length - 1] : null
  const delta      = startSnap && endSnap ? endSnap.total_value_eur - startSnap.total_value_eur : 0
  const headerPct  = startSnap && endSnap && startSnap.total_value_eur !== 0
    ? delta / startSnap.total_value_eur
    : null
  const tone = delta > 0 ? 'positive' : delta < 0 ? 'negative' : 'neutral'

  // ── Render ─────────────────────────────────────────────────────────────

  return (
    <div className="space-y-4">

      {/* Header card */}
      <div className="rounded-2xl border border-slate-200 bg-white p-5 md:p-6">
        <div className="flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
          <div>
            <p className="text-xs font-medium uppercase tracking-wide text-slate-500">
              Portfolio value
            </p>
            <p className="mt-1 text-3xl font-semibold tabular-nums text-slate-900">
              {endSnap ? money(endSnap.total_value_eur, 'EUR') : '—'}
            </p>
            {hasSampled && startSnap && endSnap ? (
              startSnap.date === endSnap.date ? (
                <p className="mt-2 text-sm text-slate-500">Single snapshot in this timeframe</p>
              ) : (
                <p className="mt-2 text-sm text-slate-600">
                  From{' '}
                  <span className="font-medium text-slate-900">
                    {money(startSnap.total_value_eur, 'EUR')}
                  </span>{' '}
                  on {fmtLongDate(startSnap.date)} ·{' '}
                  <span
                    className={
                      tone === 'positive'
                        ? 'font-medium text-emerald-700'
                        : tone === 'negative'
                          ? 'font-medium text-rose-700'
                          : 'text-slate-600'
                    }
                  >
                    {delta >= 0 ? '+' : ''}{money(delta, 'EUR')}
                    {headerPct !== null && (
                      <> ({delta >= 0 ? '+' : ''}{(headerPct * 100).toFixed(2)}%)</>
                    )}
                  </span>
                </p>
              )
            ) : (
              <p className="mt-2 text-sm text-slate-500">No snapshots in this timeframe</p>
            )}
          </div>

          {/* Time-range presets */}
          <div className="inline-flex rounded-lg border border-slate-200 bg-slate-50 p-1">
            {PRESETS.map((p) => (
              <button
                key={p.key}
                type="button"
                onClick={() => setPreset(p.key)}
                className={`rounded-md px-3 py-1.5 text-xs font-medium transition-colors ${
                  preset === p.key
                    ? 'bg-white text-slate-900 shadow-sm'
                    : 'text-slate-600 hover:text-slate-900'
                }`}
              >
                {p.label}
              </button>
            ))}
          </div>
        </div>
      </div>

      {/* Chart card */}
      <div className="rounded-2xl border border-slate-200 bg-white p-5 md:p-6">

        {/* View-mode toggle + series pills */}
        <div className="mb-5 flex flex-wrap items-center gap-3">

          {/* View mode */}
          <div className="inline-flex rounded-lg border border-slate-200 bg-slate-50 p-1 shrink-0">
            {VIEW_MODES.map((m) => (
              <button
                key={m.key}
                type="button"
                onClick={() => setViewMode(m.key)}
                className={`rounded-md px-3 py-1 text-xs font-medium transition-colors ${
                  viewMode === m.key
                    ? 'bg-white text-slate-900 shadow-sm'
                    : 'text-slate-500 hover:text-slate-700'
                }`}
              >
                {m.label}
              </button>
            ))}
          </div>

          {/* Divider */}
          <div className="hidden sm:block h-5 w-px bg-slate-200 shrink-0" />

          {/* Series toggles */}
          <div className="flex flex-wrap gap-2">
            {STATIC_SERIES.map((s) => {
              const visible = visibleSeries.has(s.key)
              return (
                <button
                  key={s.key}
                  type="button"
                  onClick={() => toggleSeries(s.key)}
                  className={`inline-flex items-center gap-1.5 rounded-full border px-3 py-1 text-xs font-medium transition-colors ${
                    visible
                      ? 'border-slate-200 bg-slate-50 text-slate-700'
                      : 'border-slate-200 bg-white text-slate-400'
                  }`}
                >
                  <span
                    className="inline-block h-2 w-2 shrink-0 rounded-full"
                    style={{ backgroundColor: visible ? s.color : '#cbd5e1' }}
                  />
                  {s.label}
                </button>
              )
            })}

            {activeTypes.map((type) => {
              const visible = visibleSeries.has(type)
              const color   = TYPE_COLORS[type] ?? '#9ca3af'
              return (
                <button
                  key={type}
                  type="button"
                  onClick={() => toggleSeries(type)}
                  className={`inline-flex items-center gap-1.5 rounded-full border px-3 py-1 text-xs font-medium transition-colors ${
                    visible
                      ? 'border-slate-200 bg-slate-50 text-slate-700'
                      : 'border-slate-200 bg-white text-slate-400'
                  }`}
                >
                  <span
                    className="inline-block h-2 w-2 shrink-0 rounded-full"
                    style={{ backgroundColor: visible ? color : '#cbd5e1' }}
                  />
                  {TYPE_LABELS[type] ?? type}
                </button>
              )
            })}
          </div>
        </div>

        {/* Chart */}
        {displayData.length >= 2 ? (
          <div className="h-72 w-full md:h-96">
            <ResponsiveContainer width="100%" height="100%">
              <LineChart data={displayData} margin={{ top: 8, right: 8, bottom: 0, left: 0 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="#e2e8f0" />

                <XAxis
                  dataKey="date"
                  ticks={chartTicks}
                  tickFormatter={tickFmt}
                  interval={0}
                  tick={{ fontSize: 12, fill: '#64748b' }}
                  stroke="#cbd5e1"
                />

                <YAxis
                  tickFormatter={(v) => fmtYAxis(
                    typeof v === 'number' ? v : Number(v),
                    viewMode,
                  )}
                  tick={{ fontSize: 12, fill: '#64748b' }}
                  stroke="#cbd5e1"
                  width={90}
                />

                <Tooltip content={renderTooltip} />

                {STATIC_SERIES.map((s) =>
                  !visibleSeries.has(s.key) ? null : (
                    <Line
                      key={s.key}
                      type="monotone"
                      dataKey={s.key}
                      name={s.label}
                      stroke={s.color}
                      strokeWidth={s.strokeWidth}
                      strokeDasharray={s.strokeDasharray}
                      dot={false}
                      activeDot={{ r: 4 }}
                      connectNulls
                    />
                  ),
                )}

                {activeTypes.map((type) =>
                  !visibleSeries.has(type) ? null : (
                    <Line
                      key={type}
                      type="monotone"
                      dataKey={type}
                      name={TYPE_LABELS[type] ?? type}
                      stroke={TYPE_COLORS[type] ?? '#9ca3af'}
                      strokeWidth={1.5}
                      dot={false}
                      activeDot={{ r: 3 }}
                      connectNulls
                    />
                  ),
                )}
              </LineChart>
            </ResponsiveContainer>
          </div>
        ) : (
          <div className="flex h-72 items-center justify-center md:h-96">
            <p className="text-sm text-slate-500">
              {displayData.length === 1
                ? 'Only one snapshot in this timeframe — pick a longer range to see a trend.'
                : 'No snapshots in this timeframe — pick a longer range.'}
            </p>
          </div>
        )}
      </div>
    </div>
  )
}
