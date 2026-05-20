'use client'

import { useMemo, useState } from 'react'
import {
  CartesianGrid,
  Line,
  LineChart,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts'
import { money } from '@/lib/format'
import type { ChartPoint } from '@/lib/domain/chart-timeline'

// ── View mode ──────────────────────────────────────────────────────────────

type ViewMode = 'absolute' | 'change_eur' | 'change_pct'

const VIEW_MODES: { key: ViewMode; label: string }[] = [
  { key: 'absolute',   label: '€'  },
  { key: 'change_eur', label: 'Δ€' },
  { key: 'change_pct', label: 'Δ%' },
]

// ── Presets ────────────────────────────────────────────────────────────────

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

// ── Series ─────────────────────────────────────────────────────────────────

type LineKey = 'value' | 'costBasis' | 'unrealizedPL'

const LINE_META: Record<
  LineKey,
  { label: string; color: string; dataKey: keyof ChartPoint; connectNulls: boolean }
> = {
  value: {
    label: 'Value',
    color: '#0f172a',
    dataKey: 'value_eur',
    connectNulls: true,
  },
  costBasis: {
    label: 'Cost basis',
    color: '#64748b',
    dataKey: 'cost_basis_eur',
    connectNulls: false,
  },
  unrealizedPL: {
    label: 'Unrealized P/L',
    color: '#b45309',
    dataKey: 'unrealized_profit_eur',
    connectNulls: true,
  },
}

const LINE_ORDER: LineKey[] = ['value', 'costBasis', 'unrealizedPL']

// ── Helpers ────────────────────────────────────────────────────────────────

function todayMinusDaysIso(days: number): string {
  const d = new Date()
  d.setHours(0, 0, 0, 0)
  d.setDate(d.getDate() - days)
  const yyyy = d.getFullYear()
  const mm   = String(d.getMonth() + 1).padStart(2, '0')
  const dd   = String(d.getDate()).padStart(2, '0')
  return `${yyyy}-${mm}-${dd}`
}

function filterByPreset(points: ChartPoint[], preset: Preset): ChartPoint[] {
  if (preset === 'all') return points
  const cutoff = todayMinusDaysIso(DAYS_FOR_PRESET[preset])
  return points.filter((p) => p.date >= cutoff)
}

function formatAxisDate(date: string): string {
  return new Date(`${date}T00:00:00`).toLocaleDateString(undefined, {
    month: 'short', day: 'numeric',
  })
}

function formatLongDate(date: string): string {
  return new Date(`${date}T00:00:00`).toLocaleDateString(undefined, {
    weekday: 'short', year: 'numeric', month: 'short', day: 'numeric',
  })
}

// In Δ% mode, the P/L series shows unrealized return (P/L / cost_basis),
// not percentage change of the P/L value itself (which is meaningless when
// P/L is near zero or crosses sign).
function unrealizedLabel(mode: ViewMode): string {
  return mode === 'change_pct' ? 'Unrealized return' : 'Unrealized P/L'
}

function fmtValue(n: number | null | undefined, mode: ViewMode): string {
  if (n === null || n === undefined || !Number.isFinite(n)) return '—'
  if (mode === 'absolute')   return money(n, 'EUR')
  if (mode === 'change_eur') return `${n >= 0 ? '+' : ''}${money(n, 'EUR')}`
  return `${n >= 0 ? '+' : ''}${n.toFixed(2)}%`
}

function fmtYAxis(n: number, mode: ViewMode): string {
  if (!Number.isFinite(n)) return ''
  if (mode === 'absolute')   return money(n, 'EUR')
  if (mode === 'change_eur') return `${n >= 0 ? '+' : ''}${money(n, 'EUR')}`
  return `${n >= 0 ? '+' : ''}${n.toFixed(1)}%`
}

// Display data has the same keys as ChartPoint but values may be transformed
// (change in € or %) instead of absolute EUR amounts.
type DisplayPoint = {
  date: string
  value_eur: number | null
  cost_basis_eur: number | null
  unrealized_profit_eur: number | null
}

// ── Props ──────────────────────────────────────────────────────────────────

type Props = {
  chartPoints: ChartPoint[]
}

// ── Component ──────────────────────────────────────────────────────────────

export function InvestmentDetailChart({ chartPoints }: Props) {
  const [preset,   setPreset]   = useState<Preset>('30d')
  const [viewMode, setViewMode] = useState<ViewMode>('absolute')
  const [visible,  setVisible]  = useState<Record<LineKey, boolean>>({
    value: true, costBasis: true, unrealizedPL: false,
  })

  const filtered = useMemo(
    () => filterByPreset(chartPoints, preset),
    [chartPoints, preset],
  )

  // Apply view-mode transformation relative to the first visible point.
  // Null values stay null; the baseline uses `|| 0` (null → 0) so we never
  // divide by zero or produce NaN. Switching preset changes `filtered[0]`
  // and thus resets the baseline automatically.
  const displayData = useMemo((): DisplayPoint[] => {
    if (viewMode === 'absolute' || filtered.length === 0) {
      return filtered.map((p) => ({
        date: p.date,
        value_eur: p.value_eur,
        cost_basis_eur: p.cost_basis_eur,
        unrealized_profit_eur: p.unrealized_profit_eur,
      }))
    }

    const first = filtered[0]
    const base = {
      value_eur:            Number(first.value_eur)            || 0,
      cost_basis_eur:       Number(first.cost_basis_eur)       || 0,
      unrealized_profit_eur: Number(first.unrealized_profit_eur) || 0,
    }

    function transform(curr: number | null, firstVal: number): number | null {
      if (curr === null) return null
      if (viewMode === 'change_eur') return curr - firstVal
      // change_pct — safe divide
      return firstVal !== 0 ? ((curr / firstVal) - 1) * 100 : 0
    }

    return filtered.map((row) => ({
      date: row.date,
      value_eur:        transform(row.value_eur,        base.value_eur),
      cost_basis_eur:   transform(row.cost_basis_eur,   base.cost_basis_eur),
      // Δ% mode: show unrealized return % = (value - cost) / cost × 100.
      // Using the P/L value's own % change would be misleading when P/L is
      // near zero, negative, or crosses sign.
      unrealized_profit_eur:
        viewMode === 'change_pct'
          ? (row.value_eur !== null && row.cost_basis_eur !== 0
              ? ((row.value_eur - row.cost_basis_eur) / row.cost_basis_eur) * 100
              : null)
          : transform(row.unrealized_profit_eur, base.unrealized_profit_eur),
    }))
  }, [filtered, viewMode])

  // ── Early exits ───────────────────────────────────────────────────────────

  if (chartPoints.length <= 1) {
    return (
      <div className="rounded-2xl border border-slate-200 bg-white p-10 text-center">
        <p className="font-medium text-slate-900">Just one data point so far</p>
        <p className="mt-1 text-sm text-slate-500">
          After tomorrow&apos;s automated refresh you&apos;ll see the trend line.
        </p>
        {chartPoints[0] && (
          <p className="mt-3 text-sm text-slate-700">
            Latest value:{' '}
            <span className="font-semibold">
              {money(chartPoints[0].value_eur, 'EUR')}
            </span>
          </p>
        )}
      </div>
    )
  }

  // ── Header stats (always absolute) ────────────────────────────────────────

  const hasFiltered = filtered.length > 0
  const start = hasFiltered ? filtered[0] : null
  const end   = hasFiltered ? filtered[filtered.length - 1] : null

  const startValue = start?.value_eur ?? 0
  const endValue   = end?.value_eur   ?? 0
  const delta = start && end ? endValue - startValue : 0
  const pct   = start && end && startValue !== 0 ? delta / startValue : null

  const tone: 'positive' | 'negative' | 'neutral' =
    delta > 0 ? 'positive' : delta < 0 ? 'negative' : 'neutral'

  const visibleLineKeys = LINE_ORDER.filter((k) => visible[k])
  const noLinesVisible  = visibleLineKeys.length === 0

  // Show zero reference line in Δ modes always; in € mode when unrealized P/L
  // is enabled or when the data itself dips to/below 0.
  const showZeroLine =
    viewMode !== 'absolute'
    || visible.unrealizedPL
    || displayData.some(
        (p) =>
          (visible.value    && p.value_eur        !== null && p.value_eur        <= 0) ||
          (visible.costBasis && p.cost_basis_eur  !== null && p.cost_basis_eur   <= 0),
      )
  const zeroLineLabel =
    viewMode === 'change_pct' ? '0%' : viewMode === 'change_eur' ? '0' : 'Break-even'

  function toggleLine(k: LineKey) {
    setVisible((v) => ({ ...v, [k]: !v[k] }))
  }

  // ── Render ────────────────────────────────────────────────────────────────

  return (
    <div className="space-y-4">

      {/* Header card: latest value + preset switcher */}
      <div className="rounded-2xl border border-slate-200 bg-white p-5 md:p-6">
        <div className="flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
          <div>
            <p className="text-xs font-medium uppercase tracking-wide text-slate-500">
              Value over time
            </p>
            <p className="mt-1 text-3xl font-semibold tabular-nums text-slate-900">
              {end ? money(end.value_eur, 'EUR') : '—'}
            </p>
            {hasFiltered && start && end ? (
              start.date === end.date ? (
                <p className="mt-2 text-sm text-slate-500">
                  Single snapshot in this timeframe
                </p>
              ) : (
                <p className="mt-2 text-sm text-slate-600">
                  From{' '}
                  <span className="font-medium text-slate-900">
                    {money(startValue, 'EUR')}
                  </span>{' '}
                  on {formatLongDate(start.date)} ·{' '}
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
              <p className="mt-2 text-sm text-slate-500">
                No snapshots in this timeframe
              </p>
            )}
          </div>

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

      {/* Chart card: view mode + series toggles + chart */}
      <div className="rounded-2xl border border-slate-200 bg-white p-5 md:p-6">

        <div className="mb-5 flex flex-wrap items-center gap-3">

          {/* View mode toggle */}
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
            {LINE_ORDER.map((k) => {
              const meta   = LINE_META[k]
              const active = visible[k]
              const label  = k === 'unrealizedPL' ? unrealizedLabel(viewMode) : meta.label
              return (
                <button
                  key={k}
                  type="button"
                  onClick={() => toggleLine(k)}
                  className={`inline-flex items-center gap-2 rounded-md border px-3 py-1.5 text-xs font-medium transition-colors ${
                    active
                      ? 'border-slate-300 bg-white text-slate-900'
                      : 'border-slate-200 bg-slate-50 text-slate-400 hover:text-slate-600'
                  }`}
                  aria-pressed={active}
                >
                  <span
                    className="h-2 w-2 rounded-full"
                    style={{ backgroundColor: active ? meta.color : '#cbd5e1' }}
                  />
                  {label}
                </button>
              )
            })}
          </div>
        </div>

        {displayData.length >= 2 && !noLinesVisible ? (
          <div className="h-72 w-full md:h-96">
            <ResponsiveContainer width="100%" height="100%">
              <LineChart
                data={displayData}
                margin={{ top: 8, right: 8, bottom: 0, left: 0 }}
              >
                <CartesianGrid strokeDasharray="3 3" stroke="#e2e8f0" />

                <XAxis
                  dataKey="date"
                  tickFormatter={formatAxisDate}
                  tick={{ fontSize: 12, fill: '#64748b' }}
                  stroke="#cbd5e1"
                />

                <YAxis
                  domain={[
                    (dataMin: number) => {
                      const n = Number.isFinite(dataMin) ? dataMin : 0
                      return viewMode === 'absolute'
                        ? Math.floor(n * 0.98)
                        : Math.floor(n * 1.05)  // give a little room below 0 in delta modes
                    },
                    (dataMax: number) => {
                      const n = Number.isFinite(dataMax) ? dataMax : 0
                      return viewMode === 'absolute'
                        ? Math.ceil(n * 1.02)
                        : Math.ceil(n * 1.05)
                    },
                  ]}
                  tickFormatter={(value) => {
                    const n = typeof value === 'number' ? value : Number(value)
                    return fmtYAxis(n, viewMode)
                  }}
                  tick={{ fontSize: 12, fill: '#64748b' }}
                  stroke="#cbd5e1"
                  width={90}
                />

                {showZeroLine && (
                  <ReferenceLine
                    y={0}
                    stroke="#94a3b8"
                    strokeDasharray="3 3"
                    strokeWidth={1}
                    label={{
                      value: zeroLineLabel,
                      position: 'insideTopRight',
                      fontSize: 11,
                      fill: '#94a3b8',
                    }}
                  />
                )}

                <Tooltip
                  formatter={(value, name) => {
                    const n = value === null || value === undefined
                      ? null
                      : typeof value === 'number' ? value : Number(value)
                    return [fmtValue(n, viewMode), name]
                  }}
                  labelFormatter={(label) =>
                    typeof label === 'string'
                      ? formatLongDate(label)
                      : String(label ?? '')
                  }
                  contentStyle={{
                    borderRadius: '8px',
                    border: '1px solid #e2e8f0',
                    fontSize: '12px',
                  }}
                />

                {visibleLineKeys.map((k) => {
                  const meta = LINE_META[k]
                  const lineName = k === 'unrealizedPL' ? unrealizedLabel(viewMode) : meta.label
                  return (
                    <Line
                      key={k}
                      type="monotone"
                      dataKey={meta.dataKey}
                      name={lineName}
                      stroke={meta.color}
                      strokeWidth={2}
                      dot={false}
                      activeDot={{ r: 4 }}
                      connectNulls={meta.connectNulls}
                    />
                  )
                })}
              </LineChart>
            </ResponsiveContainer>
          </div>
        ) : (
          <div className="flex h-72 items-center justify-center md:h-96">
            <p className="text-sm text-slate-500">
              {noLinesVisible
                ? 'Toggle on at least one line to see the chart.'
                : filtered.length === 1
                  ? 'Only one snapshot in this timeframe — pick a longer range to see a trend.'
                  : 'No snapshots in this timeframe — pick a longer range.'}
            </p>
          </div>
        )}
      </div>
    </div>
  )
}
