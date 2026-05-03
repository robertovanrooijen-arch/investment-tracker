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

type Snapshot = {
  date: string
  total_value_eur: number
}

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

function todayMinusDaysIso(days: number): string {
  const d = new Date()
  d.setHours(0, 0, 0, 0)
  d.setDate(d.getDate() - days)

  const yyyy = d.getFullYear()
  const mm = String(d.getMonth() + 1).padStart(2, '0')
  const dd = String(d.getDate()).padStart(2, '0')

  return `${yyyy}-${mm}-${dd}`
}

function filterByPreset(snapshots: Snapshot[], preset: Preset): Snapshot[] {
  if (preset === 'all') return snapshots

  const cutoff = todayMinusDaysIso(DAYS_FOR_PRESET[preset])
  return snapshots.filter((s) => s.date >= cutoff)
}

function formatAxisDate(date: string): string {
  const d = new Date(`${date}T00:00:00`)
  return d.toLocaleDateString(undefined, {
    month: 'short',
    day: 'numeric',
  })
}

function formatLongDate(date: string): string {
  const d = new Date(`${date}T00:00:00`)
  return d.toLocaleDateString(undefined, {
    weekday: 'short',
    year: 'numeric',
    month: 'short',
    day: 'numeric',
  })
}

type Props = {
  snapshots: Snapshot[]
}

export function PortfolioHistoryChart({ snapshots }: Props) {
  const [preset, setPreset] = useState<Preset>('30d')

  const filtered = useMemo(
    () => filterByPreset(snapshots, preset),
    [snapshots, preset]
  )

  if (snapshots.length === 0) {
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

  if (snapshots.length === 1) {
    return (
      <div className="rounded-2xl border border-slate-200 bg-white p-10 text-center">
        <p className="font-medium text-slate-900">Just one data point so far</p>
        <p className="mt-1 text-sm text-slate-500">
          Come back tomorrow after another refresh to see your trend.
        </p>
        <p className="mt-3 text-sm text-slate-700">
          Latest value:{' '}
          <span className="font-semibold">
            {money(snapshots[0].total_value_eur, 'EUR')}
          </span>
        </p>
      </div>
    )
  }

  const hasFiltered = filtered.length > 0
  const start = hasFiltered ? filtered[0] : null
  const end = hasFiltered ? filtered[filtered.length - 1] : null

  const delta = start && end ? end.total_value_eur - start.total_value_eur : 0
  const pct =
    start && end && start.total_value_eur !== 0
      ? delta / start.total_value_eur
      : null

  const tone: 'positive' | 'negative' | 'neutral' =
    delta > 0 ? 'positive' : delta < 0 ? 'negative' : 'neutral'

  return (
    <div className="space-y-4">
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
                <p className="mt-2 text-sm text-slate-500">
                  Single snapshot in this timeframe
                </p>
              ) : (
                <p className="mt-2 text-sm text-slate-600">
                  From{' '}
                  <span className="font-medium text-slate-900">
                    {money(start.total_value_eur, 'EUR')}
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

      <div className="rounded-2xl border border-slate-200 bg-white p-5 md:p-6">
        {filtered.length >= 2 ? (
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
                  formatter={(value) => {
                    const n = typeof value === 'number' ? value : Number(value)
                    return [money(Number.isFinite(n) ? n : 0, 'EUR'), 'Value']
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

                <Line
                  type="monotone"
                  dataKey="total_value_eur"
                  stroke="#0f172a"
                  strokeWidth={2}
                  dot={false}
                  activeDot={{ r: 4 }}
                />
              </LineChart>
            </ResponsiveContainer>
          </div>
        ) : (
          <div className="flex h-72 items-center justify-center md:h-96">
            <p className="text-sm text-slate-500">
              {filtered.length === 1
                ? 'Only one snapshot in this timeframe — pick a longer range to see a trend.'
                : 'No snapshots in this timeframe — pick a longer range.'}
            </p>
          </div>
        )}
      </div>
    </div>
  )
}