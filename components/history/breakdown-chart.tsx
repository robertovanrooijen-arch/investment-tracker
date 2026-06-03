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

// ── Public types ───────────────────────────────────────────────────────────

export type BreakdownSnapshot = {
  date: string
  entity_id: string
  value_eur: number
  cost_basis_eur: number
  pl_eur: number
}

export type BreakdownEntity = {
  id: string
  label: string
  color: string
}

// ── Internal types ─────────────────────────────────────────────────────────

type MetricMode = 'value' | 'cost_basis' | 'pl' | 'pl_pct'

const METRIC_MODES: { key: MetricMode; label: string }[] = [
  { key: 'value',      label: 'Value'      },
  { key: 'cost_basis', label: 'Cost basis' },
  { key: 'pl',         label: 'P&L €'     },
  { key: 'pl_pct',     label: 'P&L %'     },
]

const PRESETS: { key: Preset; label: string }[] = [
  { key: '7d',  label: '7d'  },
  { key: '30d', label: '30d' },
  { key: '90d', label: '90d' },
  { key: '1y',  label: '1y'  },
  { key: 'all', label: 'All' },
]

// ── Helpers ────────────────────────────────────────────────────────────────

type RawSnap = { value_eur: number; cost_basis_eur: number; pl_eur: number }

function getMetricValue(snap: RawSnap, mode: MetricMode): number {
  switch (mode) {
    case 'value':      return snap.value_eur
    case 'cost_basis': return snap.cost_basis_eur
    case 'pl':         return snap.pl_eur
    case 'pl_pct':
      return snap.cost_basis_eur !== 0 ? (snap.pl_eur / snap.cost_basis_eur) * 100 : 0
  }
}

function fmtTooltipValue(n: number, mode: MetricMode): string {
  if (!Number.isFinite(n)) return '—'
  if (mode === 'pl_pct') return `${n >= 0 ? '+' : ''}${n.toFixed(2)}%`
  return money(n, 'EUR')
}

function fmtYAxis(n: number, mode: MetricMode): string {
  if (!Number.isFinite(n)) return '—'
  if (mode === 'pl_pct') return `${n.toFixed(1)}%`
  return money(n, 'EUR')
}

function fmtLongDate(date: string): string {
  return new Date(`${date}T00:00:00`).toLocaleDateString(undefined, {
    weekday: 'short', year: 'numeric', month: 'short', day: 'numeric',
  })
}

// ── Tooltip ────────────────────────────────────────────────────────────────

type TooltipPayloadEntry = { dataKey: string; name: string; value: unknown; stroke: string }

function BreakdownTooltip({
  active,
  payload,
  label,
  metricMode,
  colorMap,
}: {
  active?: boolean
  payload?: TooltipPayloadEntry[]
  label?: string
  metricMode: MetricMode
  colorMap: Map<string, string>
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
                  style={{ backgroundColor: colorMap.get(entry.dataKey) ?? entry.stroke }}
                />
                <span className="text-slate-600">{entry.name}</span>
              </div>
              <span className="tabular-nums font-medium text-slate-900">
                {fmtTooltipValue(val, metricMode)}
              </span>
            </div>
          )
        })}
      </div>
    </div>
  )
}

// ── Main component ─────────────────────────────────────────────────────────

type Props = {
  heading: string
  subtitle: string
  entities: BreakdownEntity[]
  snapshots: BreakdownSnapshot[]
  defaultVisibleCount?: number
}

export function BreakdownChart({
  heading,
  subtitle,
  entities,
  snapshots,
  defaultVisibleCount = 5,
}: Props) {
  const [preset,     setPreset]     = useState<Preset>('30d')
  const [metricMode, setMetricMode] = useState<MetricMode>('value')
  const [visibleEntities, setVisibleEntities] = useState<Set<string>>(
    () => new Set(entities.slice(0, defaultVisibleCount).map((e) => e.id)),
  )

  function toggleEntity(id: string) {
    setVisibleEntities((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  const colorMap = useMemo(
    () => new Map(entities.map((e) => [e.id, e.color])),
    [entities],
  )

  // Step 1: filter snapshots by date range
  const filtered = useMemo(() => {
    if (preset === 'all') return snapshots
    const cutoff = cutoffDateIso(preset)
    return snapshots.filter((s) => s.date >= cutoff)
  }, [snapshots, preset])

  // Step 2: downsample dates consistently across all entities
  const sampledDates = useMemo(() => {
    const allDates = [...new Set(filtered.map((s) => s.date))].sort()
    const dummy = allDates.map((date) => ({ date }))
    return new Set(downsampleForPreset(dummy, preset).map((d) => d.date))
  }, [filtered, preset])

  // Step 3: build chart rows — one column per entity per sampled date
  const chartData = useMemo(() => {
    const byDateEntity = new Map<string, Map<string, RawSnap>>()
    for (const snap of filtered) {
      if (!sampledDates.has(snap.date)) continue
      let entityMap = byDateEntity.get(snap.date)
      if (!entityMap) { entityMap = new Map(); byDateEntity.set(snap.date, entityMap) }
      entityMap.set(snap.entity_id, {
        value_eur: snap.value_eur,
        cost_basis_eur: snap.cost_basis_eur,
        pl_eur: snap.pl_eur,
      })
    }

    const sortedDates = [...sampledDates].sort()
    return sortedDates.map((date) => {
      const entityMap = byDateEntity.get(date) ?? new Map<string, RawSnap>()
      const row: Record<string, string | number> = { date }
      for (const entity of entities) {
        const snap = entityMap.get(entity.id)
        row[entity.id] = snap != null ? getMetricValue(snap, metricMode) : 0
      }
      return row
    })
  }, [filtered, sampledDates, entities, metricMode])

  const chartDates = useMemo(() => chartData.map((d) => d.date as string), [chartData])
  const chartTicks = useMemo(() => getChartTicks(chartDates), [chartDates])
  const tickFmt    = useMemo(() => getTickFormatter(chartDates), [chartDates])

  const renderTooltip = useCallback(
    (props: object) => (
      <BreakdownTooltip
        {...(props as { active?: boolean; payload?: TooltipPayloadEntry[]; label?: string })}
        metricMode={metricMode}
        colorMap={colorMap}
      />
    ),
    [metricMode, colorMap],
  )

  if (snapshots.length === 0) {
    return (
      <div className="rounded-2xl border border-slate-200 bg-white p-10 text-center">
        <p className="font-medium text-slate-900">No history yet</p>
        <p className="mt-1 text-sm text-slate-500">
          Click <span className="font-medium">Refresh portfolio</span> on the dashboard to start
          tracking.
        </p>
      </div>
    )
  }

  return (
    <div className="rounded-2xl border border-slate-200 bg-white p-5 md:p-6 space-y-5">

      {/* Section header + preset selector */}
      <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <h2 className="text-base font-semibold text-slate-900">{heading}</h2>
          <p className="mt-0.5 text-sm text-slate-500">{subtitle}</p>
        </div>
        <div className="inline-flex rounded-lg border border-slate-200 bg-slate-50 p-1 shrink-0">
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

      {/* Metric toggle + entity pills */}
      <div className="flex flex-wrap items-center gap-3">
        <div className="inline-flex rounded-lg border border-slate-200 bg-slate-50 p-1 shrink-0">
          {METRIC_MODES.map((m) => (
            <button
              key={m.key}
              type="button"
              onClick={() => setMetricMode(m.key)}
              className={`rounded-md px-3 py-1 text-xs font-medium transition-colors ${
                metricMode === m.key
                  ? 'bg-white text-slate-900 shadow-sm'
                  : 'text-slate-500 hover:text-slate-700'
              }`}
            >
              {m.label}
            </button>
          ))}
        </div>

        <div className="hidden sm:block h-5 w-px bg-slate-200 shrink-0" />

        <div className="flex flex-wrap gap-2">
          {entities.map((entity) => {
            const visible = visibleEntities.has(entity.id)
            return (
              <button
                key={entity.id}
                type="button"
                onClick={() => toggleEntity(entity.id)}
                className={`inline-flex items-center gap-1.5 rounded-full border px-3 py-1 text-xs font-medium transition-colors ${
                  visible
                    ? 'border-slate-200 bg-slate-50 text-slate-700'
                    : 'border-slate-200 bg-white text-slate-400'
                }`}
              >
                <span
                  className="inline-block h-2 w-2 shrink-0 rounded-full"
                  style={{ backgroundColor: visible ? entity.color : '#cbd5e1' }}
                />
                {entity.label}
              </button>
            )
          })}
        </div>
      </div>

      {/* Chart */}
      {chartData.length >= 2 ? (
        <div className="h-72 w-full md:h-96">
          <ResponsiveContainer width="100%" height="100%">
            <LineChart data={chartData} margin={{ top: 8, right: 8, bottom: 0, left: 0 }}>
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
                tickFormatter={(v) => fmtYAxis(typeof v === 'number' ? v : Number(v), metricMode)}
                tick={{ fontSize: 12, fill: '#64748b' }}
                stroke="#cbd5e1"
                width={90}
              />
              <Tooltip content={renderTooltip} />
              {entities.map((entity) =>
                !visibleEntities.has(entity.id) ? null : (
                  <Line
                    key={entity.id}
                    type="monotone"
                    dataKey={entity.id}
                    name={entity.label}
                    stroke={entity.color}
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
            {chartData.length === 1
              ? 'Only one snapshot in this timeframe — pick a longer range to see a trend.'
              : 'No snapshots in this timeframe — pick a longer range.'}
          </p>
        </div>
      )}
    </div>
  )
}
