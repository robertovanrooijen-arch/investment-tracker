'use client'

import { useMemo } from 'react'
import { Bar, BarChart, CartesianGrid, Cell, ReferenceLine, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts'
import type { PerformanceRow } from './performance-table'

type Row = { name: string; value: number; asOfDate: string | null }

function ChartTooltip({ active, payload }: { active?: boolean; payload?: { payload: Row }[] }) {
  if (!active || !payload?.length) return null
  const row = payload[0].payload
  return (
    <div className="min-w-[180px] rounded-xl border border-slate-200 bg-white px-4 py-3 shadow-lg text-xs">
      <p className="mb-1 font-medium text-slate-700">{row.name}</p>
      <p className={`font-semibold tabular-nums ${row.value >= 0 ? 'text-emerald-600' : 'text-rose-600'}`}>
        {row.value >= 0 ? '+' : ''}
        {row.value.toFixed(1)}%
      </p>
      {row.asOfDate && <p className="mt-1 text-slate-400">vs. close on {row.asOfDate}</p>}
    </div>
  )
}

export function MarketYtdBarChart({ rows }: { rows: PerformanceRow[] }) {
  // Scoped to positions with activity this year — a security you no longer
  // hold at all isn't part of "how are my current holdings doing", even
  // though its own price history is real.
  const relevantRows = useMemo(() => rows.filter((r) => r.hasActivityThisYear), [rows])

  const data = useMemo<Row[]>(
    () =>
      relevantRows
        .filter((r) => r.marketYtdPercent !== null)
        .map((r) => ({ name: r.inv.name, value: r.marketYtdPercent as number, asOfDate: r.marketYtdAsOfDate }))
        .sort((a, b) => b.value - a.value),
    [relevantRows]
  )

  const unavailableCount = relevantRows.length - data.length

  return (
    <div className="bg-white rounded-2xl border border-slate-200 p-5 md:p-6">
      <div className="flex items-baseline justify-between gap-3">
        <h2 className="text-base font-semibold text-slate-900">Market YTD by investment</h2>
        <p className="text-xs text-slate-400">Price return, native currency</p>
      </div>

      {data.length === 0 ? (
        <p className="mt-4 text-sm text-slate-500">
          Market YTD unavailable for every holding — could not fetch a historical price for any ticker.
        </p>
      ) : (
        <>
          <div className="mt-4" style={{ height: Math.max(data.length * 36, 120) }}>
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={data} layout="vertical" margin={{ top: 4, right: 24, bottom: 4, left: 4 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="#e2e8f0" horizontal={false} />
                <XAxis
                  type="number"
                  tickFormatter={(v) => `${v >= 0 ? '+' : ''}${v}%`}
                  tick={{ fontSize: 12, fill: '#64748b' }}
                  stroke="#cbd5e1"
                />
                <YAxis
                  type="category"
                  dataKey="name"
                  width={140}
                  tick={{ fontSize: 12, fill: '#334155' }}
                  stroke="#cbd5e1"
                />
                <ReferenceLine x={0} stroke="#94a3b8" />
                <Tooltip content={<ChartTooltip />} />
                <Bar dataKey="value" radius={[0, 4, 4, 0]} maxBarSize={18}>
                  {data.map((row) => (
                    <Cell key={row.name} fill={row.value >= 0 ? '#16a34a' : '#dc2626'} />
                  ))}
                </Bar>
              </BarChart>
            </ResponsiveContainer>
          </div>
          {unavailableCount > 0 && (
            <p className="mt-3 text-xs text-slate-400">
              {unavailableCount} holding{unavailableCount !== 1 ? 's' : ''} not shown — Market YTD unavailable (no historical price fetched).
            </p>
          )}
        </>
      )}
    </div>
  )
}
