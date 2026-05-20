'use client'

import { useMemo, useState } from 'react'
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
import type { ChartPoint } from '@/lib/domain/chart-timeline'

type Preset = '7d' | '30d' | '90d' | '1y' | 'all'

const PRESETS: { key: Preset; label: string }[] = [
  { key: '7d', label: '7d' },
  { key: '30d', label: '30d' },
  { key: '90d', label: '90d' },
  { key: '1y', label: '1y' },
  { key: 'all', label: 'All' },
]

const DAYS_FOR_PRESET: Record<Exclude<Preset, 'all'>, number> = {
  '7d': 7,
  '30d': 30,
  '90d': 90,
  '1y': 365,
}

type LineKey = 'value' | 'costBasis' | 'unrealizedPL'

const LINE_META: Record<LineKey, { label: string; color: string; dataKey: keyof ChartPoint; connectNulls: boolean }> = {
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

function todayMinusDaysIso(days: number): string {
  const d = new Date()
  d.setHours(0, 0, 0, 0)
  d.setDate(d.getDate() - days)
  const yyyy = d.getFullYear()
  const mm = String(d.getMonth() + 1).padStart(2, '0')
  const dd = String(d.getDate()).padStart(2, '0')
  return `${yyyy}-${mm}-${dd}`
}

function filterByPreset(points: ChartPoint[], preset: Preset): ChartPoint[] {
  if (preset === 'all') return points
  const cutoff = todayMinusDaysIso(DAYS_FOR_PRESET[preset])
  return points.filter((p) => p.date >= cutoff)
}

function formatAxisDate(date: string): string {
  return new Date(`${date}T00:00:00`).toLocaleDateString(undefined, {
    month: 'short',
    day: 'numeric',
  })
}

function formatLongDate(date: string): string {
  return new Date(`${date}T00:00:00`).toLocaleDateString(undefined, {
    weekday: 'short',
    year: 'numeric',
    month: 'short',
    day: 'numeric',
  })
}

type Props = {
  chartPoints: ChartPoint[]
}

export function InvestmentDetailChart({ chartPoints }: Props) {
  const [preset, setPreset] = useState<Preset>('30d')
  const [visible, setVisible] = useState<Record<LineKey, boolean>>({
    value: true,
    costBasis: true,
    unrealizedPL: false,
  })

  const filtered = useMemo(
    () => filterByPreset(chartPoints, preset),
    [chartPoints, preset],
  )

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

  const hasFiltered = filtered.length > 0
  const start = hasFiltered ? filtered[0] : null
  const end = hasFiltered ? filtered[filtered.length - 1] : null

  // Use value_eur from both ends; fall back to 0 when null (transaction-only point)
  const startValue = start?.value_eur ?? 0
  const endValue = end?.value_eur ?? 0
  const delta = start && end ? endValue - startValue : 0
  const pct = start && end && startValue !== 0 ? delta / startValue : null

  const tone: 'positive' | 'negative' | 'neutral' =
    delta > 0 ? 'positive' : delta < 0 ? 'negative' : 'neutral'

  const visibleLineKeys = LINE_ORDER.filter((k) => visible[k])
  const noLinesVisible = visibleLineKeys.length === 0

  function toggleLine(k: LineKey) {
    setVisible((v) => ({ ...v, [k]: !v[k] }))
  }

  return (
    <div className="space-y-4">
      {/* Header card: stats + preset switcher */}
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
                    {delta >= 0 ? '+' : ''}
                    {money(delta, 'EUR')}
                    {pct !== null && (
                      <>
                        {' '}
                        ({delta >= 0 ? '+' : ''}
                        {(pct * 100).toFixed(2)}%)
                      </>
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

      {/* Chart card: line toggles + chart */}
      <div className="rounded-2xl border border-slate-200 bg-white p-5 md:p-6">
        <div className="mb-4 flex flex-wrap gap-2">
          {LINE_ORDER.map((k) => {
            const meta = LINE_META[k]
            const active = visible[k]
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
                {meta.label}
              </button>
            )
          })}
        </div>

        {filtered.length >= 2 && !noLinesVisible ? (
          <div className="h-72 w-full md:h-96">
            <ResponsiveContainer width="100%" height="100%">
              <LineChart
                data={filtered}
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
                    (dataMin: number) => Math.floor(dataMin * 0.98),
                    (dataMax: number) => Math.ceil(dataMax * 1.02),
                  ]}
                  tickFormatter={(value) => {
                    const n = typeof value === 'number' ? value : Number(value)
                    return money(Number.isFinite(n) ? n : 0, 'EUR')
                  }}
                  tick={{ fontSize: 12, fill: '#64748b' }}
                  stroke="#cbd5e1"
                  width={80}
                />

                <Tooltip
                  formatter={(value, name) => {
                    if (value === null || value === undefined) return ['—', name]
                    const n = typeof value === 'number' ? value : Number(value)
                    return [money(Number.isFinite(n) ? n : 0, 'EUR'), name]
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
                  return (
                    <Line
                      key={k}
                      type="monotone"
                      dataKey={meta.dataKey}
                      name={meta.label}
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
