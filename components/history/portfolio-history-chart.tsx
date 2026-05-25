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
import type { InvestmentType } from '@/types/database'

// ── Prop types ─────────────────────────────────────────────────────────────

export type PortfolioSnapshot = {
  date: string
  total_value_eur: number
  total_invested_eur: number
  total_unrealized_eur: number
}

export type InvSnapshot = {
  date: string
  value_eur: number
  remaining_cost_basis_eur: number
  type: InvestmentType
}

type Props = {
  portfolioSnapshots: PortfolioSnapshot[]
  invSnapshots: InvSnapshot[]
}

// ── View mode ──────────────────────────────────────────────────────────────

type ViewMode = 'absolute' | 'change_eur' | 'change_pct'

const VIEW_MODES: { key: ViewMode; label: string }[] = [
  { key: 'absolute',   label: '€'  },
  { key: 'change_eur', label: 'Δ€' },
  { key: 'change_pct', label: 'Δ%' },
]

// ── Time presets ───────────────────────────────────────────────────────────

type Preset = '7d' | '30d' | '90d' | '1y' | 'all'

const PRESETS: { key: Preset; label: string }[] = [
  { key: '7d',  label: '7d'  },
  { key: '30d', label: '30d' },
  { key: '90d', label: '90d' },
  { key: '1y',  label: '1y'  },
  { key: 'all', label: 'All' },
]

const DAYS_FOR_PRESET: Record<Exclude<Preset, 'all'>, number> = {
  '7d': 7, '30d': 30, '90d': 90, '1y': 365,
}

function cutoffDateIso(days: number): string {
  const d = new Date()
  d.setUTCHours(0, 0, 0, 0)
  d.setUTCDate(d.getUTCDate() - days)
  return d.toISOString().slice(0, 10)
}

function filterByPreset(snaps: PortfolioSnapshot[], preset: Preset): PortfolioSnapshot[] {
  if (preset === 'all') return snaps
  const cutoff = cutoffDateIso(DAYS_FOR_PRESET[preset])
  return snaps.filter((s) => s.date >= cutoff)
}

// ── Series metadata ────────────────────────────────────────────────────────

// Type breakdown order (cash excluded — it gets its own dedicated series)
const TYPE_ORDER: Exclude<InvestmentType, 'cash'>[] = [
  'stock', 'ETF', 'crypto', 'commodity', 'real estate', 'custom',
]

const TYPE_COLORS: Record<string, string> = {
  stock:          '#3b82f6',  // blue-500
  ETF:            '#8b5cf6',  // violet-500
  crypto:         '#f59e0b',  // amber-500
  commodity:      '#d97706',  // amber-600
  'real estate':  '#ef4444',  // red-500
  custom:         '#6b7280',  // slate-500
}

const TYPE_LABELS: Record<string, string> = {
  stock:         'Stocks',
  ETF:           'ETF',
  crypto:        'Crypto',
  commodity:     'Commodity',
  'real estate': 'Real estate',
  custom:        'Custom',
}

// Static derived series — always computed, togglable
const STATIC_SERIES = [
  {
    key: 'total_value_eur',
    label: 'Total value',
    color: '#0f172a',
    strokeWidth: 2.5,
    strokeDasharray: undefined as string | undefined,
  },
  {
    key: 'invested_assets_eur',
    label: 'Invested assets value',
    color: '#3730a3',
    strokeWidth: 1.5,
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
    label: 'Unrealized profit',
    color: '#16a34a',
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

type StaticKey = typeof STATIC_SERIES[number]['key']

// ── Date formatters ────────────────────────────────────────────────────────

function fmtAxisDate(date: string): string {
  return new Date(`${date}T00:00:00`).toLocaleDateString(undefined, {
    month: 'short', day: 'numeric',
  })
}

function fmtLongDate(date: string): string {
  return new Date(`${date}T00:00:00`).toLocaleDateString(undefined, {
    weekday: 'short', year: 'numeric', month: 'short', day: 'numeric',
  })
}

// ── Value formatters ───────────────────────────────────────────────────────

function fmtValue(n: number, mode: ViewMode): string {
  if (!Number.isFinite(n)) return '—'
  if (mode === 'absolute') return money(n, 'EUR')
  if (mode === 'change_eur') {
    return `${n >= 0 ? '+' : ''}${money(n, 'EUR')}`
  }
  // change_pct
  return `${n >= 0 ? '+' : ''}${n.toFixed(2)}%`
}

function fmtYAxis(n: number, mode: ViewMode): string {
  if (!Number.isFinite(n)) return '—'
  if (mode === 'absolute') return money(n, 'EUR')
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

// Series visible by default. Type breakdown series and Cash are off by default.
const DEFAULT_VISIBLE = new Set([
  'total_value_eur',
  'invested_assets_eur',
  'cost_basis_eur',
  'total_profit_eur',
])

export function PortfolioHistoryChart({ portfolioSnapshots, invSnapshots }: Props) {
  const [preset,    setPreset]    = useState<Preset>('30d')
  const [viewMode,  setViewMode]  = useState<ViewMode>('absolute')
  const [visibleSeries, setVisibleSeries] = useState<Set<string>>(new Set(DEFAULT_VISIBLE))

  function toggleSeries(key: string) {
    setVisibleSeries((prev) => {
      const next = new Set(prev)
      if (next.has(key)) next.delete(key)
      else next.add(key)
      return next
    })
  }

  // Types (excl. cash) that appear in any snapshot — stable across preset changes
  const activeTypes = useMemo<Exclude<InvestmentType, 'cash'>[]>(() => {
    const seen = new Set<string>()
    for (const row of invSnapshots) {
      if (row.type !== 'cash') seen.add(row.type)
    }
    return TYPE_ORDER.filter((t) => seen.has(t))
  }, [invSnapshots])

  const filtered = useMemo(
    () => filterByPreset(portfolioSnapshots, preset),
    [portfolioSnapshots, preset],
  )

  // Build chart rows: merge portfolio total with per-type aggregates from investment_snapshots
  const chartData = useMemo(() => {
    const filteredDates = new Set(filtered.map((s) => s.date))

    // date → type → { value, cost }
    type Agg = { value: number; cost: number }
    const invByDate = new Map<string, Map<string, Agg>>()

    for (const row of invSnapshots) {
      if (!filteredDates.has(row.date)) continue
      let typeMap = invByDate.get(row.date)
      if (!typeMap) { typeMap = new Map(); invByDate.set(row.date, typeMap) }
      const prev = typeMap.get(row.type) ?? { value: 0, cost: 0 }
      typeMap.set(row.type, {
        value: prev.value + row.value_eur,
        cost:  prev.cost  + row.remaining_cost_basis_eur,
      })
    }

    return filtered.map((snap) => {
      const typeMap = invByDate.get(snap.date) ?? new Map<string, Agg>()

      let cashValue      = 0
      let investedValue  = 0
      let investedCost   = 0

      for (const [type, agg] of typeMap) {
        if (type === 'cash') {
          cashValue += agg.value
        } else {
          investedValue += agg.value
          investedCost  += agg.cost
        }
      }

      // For dates with no investment_snapshots (e.g. annual historical anchors),
      // fall back to portfolio-level totals stored in portfolio_snapshots.
      // invested_assets_eur stays 0 — no per-type breakdown available.
      const hasInvSnaps = typeMap.size > 0
      const costBasis       = hasInvSnaps ? investedCost               : snap.total_invested_eur
      const unrealizedProfit = hasInvSnaps ? investedValue - investedCost : snap.total_unrealized_eur

      const row: Record<string, number | string> = {
        date:                snap.date,
        total_value_eur:     snap.total_value_eur,
        invested_assets_eur: investedValue,
        cost_basis_eur:      costBasis,
        total_profit_eur:    unrealizedProfit,
        cash_value_eur:      cashValue,
      }

      for (const type of activeTypes) {
        row[type] = typeMap.get(type)?.value ?? 0
      }

      return row
    })
  }, [filtered, invSnapshots, activeTypes])

  // Apply view-mode transformation (relative to first visible data point)
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
        const currVal  = Number(row[key])  || 0
        if (viewMode === 'change_eur') {
          out[key] = currVal - firstVal
        } else {
          // change_pct: avoid divide-by-zero; 0 baseline → show 0
          out[key] = firstVal !== 0 ? ((currVal / firstVal) - 1) * 100 : 0
        }
      }
      return out
    })
  }, [chartData, viewMode, activeTypes])

  // Tooltip content — needs viewMode in closure
  const renderTooltip = useCallback(
    (props: object) => <ChartTooltip {...(props as any)} viewMode={viewMode} />,
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

  // ── Summary header stats (always in absolute EUR) ──────────────────────

  const hasFiltered = filtered.length > 0
  const start = hasFiltered ? filtered[0] : null
  const end   = hasFiltered ? filtered[filtered.length - 1] : null
  const delta = start && end ? end.total_value_eur - start.total_value_eur : 0
  const pct   = start && end && start.total_value_eur !== 0
    ? delta / start.total_value_eur
    : null
  const tone  = delta > 0 ? 'positive' : delta < 0 ? 'negative' : 'neutral'

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
              {end ? money(end.total_value_eur, 'EUR') : '—'}
            </p>
            {hasFiltered && start && end ? (
              start.date === end.date ? (
                <p className="mt-2 text-sm text-slate-500">Single snapshot in this timeframe</p>
              ) : (
                <p className="mt-2 text-sm text-slate-600">
                  From{' '}
                  <span className="font-medium text-slate-900">
                    {money(start.total_value_eur, 'EUR')}
                  </span>{' '}
                  on {fmtLongDate(start.date)} ·{' '}
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
                    {pct !== null && (
                      <> ({delta >= 0 ? '+' : ''}{(pct * 100).toFixed(2)}%)</>
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
                  tickFormatter={fmtAxisDate}
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

                {/* Static derived series */}
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

                {/* Per-type breakdown (cash excluded) */}
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
