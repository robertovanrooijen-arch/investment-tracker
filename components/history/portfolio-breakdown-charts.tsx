'use client'

import { useCallback } from 'react'
import {
  PieChart,
  Pie,
  Cell,
  Tooltip,
  ResponsiveContainer,
} from 'recharts'
import { money } from '@/lib/format'
import { pct } from '@/lib/domain/calculations'
import type { AllocationSlice, PortfolioMetrics } from '@/lib/domain/calculations'

// ── Color maps (hex for Recharts) ──────────────────────────────────────────

const CATEGORY_HEX: Record<string, string> = {
  stock:          '#0ea5e9',  // sky-500
  ETF:            '#6366f1',  // indigo-500
  crypto:         '#f59e0b',  // amber-500
  cash:           '#10b981',  // emerald-500
  'real estate':  '#ef4444',  // rose-500
  custom:         '#6b7280',  // slate-500
  commodity:      '#eab308',  // yellow-500
}

const PLATFORM_HEX: Record<string, string> = {
  DEGIRO:           '#2563eb',  // blue-600
  'Trade Republic': '#1e293b',  // slate-800
  'Gold Republic':  '#d97706',  // amber-600
  Bitvavo:          '#6366f1',  // indigo-500
  Binance:          '#eab308',  // yellow-500
  ING:              '#f97316',  // orange-500
  'Real Estate':    '#ef4444',  // rose-500
  Custom:           '#6b7280',  // slate-500
}

const FALLBACK_HEX = '#9ca3af'

function colorFor(map: Record<string, string>, key: string): string {
  return map[key] ?? FALLBACK_HEX
}

// ── Pie tooltip ────────────────────────────────────────────────────────────

type TooltipEntry = {
  name: string
  value: number
}

function PieTooltipContent({
  active,
  payload,
  total,
}: {
  active?: boolean
  payload?: TooltipEntry[]
  total: number
}) {
  if (!active || !payload?.length) return null
  const { name, value } = payload[0]
  const share = total > 0 ? (value / total) * 100 : 0
  return (
    <div className="min-w-[140px] rounded-xl border border-slate-200 bg-white px-3 py-2 shadow-lg text-xs">
      <p className="font-medium text-slate-700">{name}</p>
      <p className="tabular-nums text-slate-900">{money(value, 'EUR')}</p>
      <p className="text-slate-500">{share.toFixed(1)}%</p>
    </div>
  )
}

// ── Donut chart card ───────────────────────────────────────────────────────

function AllocationDonut({
  title,
  slices,
  colorMap,
}: {
  title: string
  slices: AllocationSlice[]
  colorMap: Record<string, string>
}) {
  const total = slices.reduce((s, x) => s + x.value, 0)

  const renderTooltip = useCallback(
    (props: object) =>
      <PieTooltipContent {...(props as { active?: boolean; payload?: TooltipEntry[] })} total={total} />,
    [total],
  )

  if (slices.length === 0) {
    return (
      <div className="bg-white rounded-2xl border border-slate-200 p-5 md:p-6">
        <h2 className="text-base font-semibold text-slate-900">{title}</h2>
        <p className="mt-4 text-sm text-slate-500">No value in your portfolio yet.</p>
      </div>
    )
  }

  return (
    <div className="bg-white rounded-2xl border border-slate-200 p-5 md:p-6">
      <h2 className="text-base font-semibold text-slate-900 mb-1">{title}</h2>

      <div className="h-44">
        <ResponsiveContainer width="100%" height="100%">
          <PieChart>
            <Pie
              data={slices.map((s) => ({ ...s, name: s.key }))}
              cx="50%"
              cy="50%"
              innerRadius={46}
              outerRadius={74}
              paddingAngle={2}
              dataKey="value"
            >
              {slices.map((s) => (
                <Cell key={s.key} fill={colorFor(colorMap, s.key)} />
              ))}
            </Pie>
            <Tooltip content={renderTooltip} />
          </PieChart>
        </ResponsiveContainer>
      </div>

      <ul className="mt-2 space-y-2">
        {slices.map((s) => (
          <li key={s.key} className="flex items-center justify-between text-sm">
            <div className="flex items-center gap-2 min-w-0">
              <span
                className="inline-block h-2.5 w-2.5 shrink-0 rounded-full"
                style={{ backgroundColor: colorFor(colorMap, s.key) }}
              />
              <span className="truncate text-slate-700">{s.key}</span>
            </div>
            <div className="flex items-center gap-3 shrink-0">
              <span className="text-slate-500 tabular-nums">{pct(s.pct)}</span>
              <span className="font-medium text-slate-900 tabular-nums">{money(s.value)}</span>
            </div>
          </li>
        ))}
      </ul>
    </div>
  )
}

// ── Profit / loss breakdown card ───────────────────────────────────────────

function tone(n: number): string {
  if (n > 0) return 'text-emerald-700'
  if (n < 0) return 'text-rose-700'
  return 'text-slate-900'
}

function barColor(n: number): string {
  if (n > 0) return '#10b981'  // emerald-500
  if (n < 0) return '#ef4444'  // rose-500
  return '#94a3b8'             // slate-400
}

function ProfitLossBreakdown({ metrics }: { metrics: PortfolioMetrics }) {
  const { totalRealized, totalUnrealized, totalProfit, totalEverInvested } = metrics
  // Avoid divide-by-zero; if both are 0 show zero bars
  const absTotal = Math.abs(totalRealized) + Math.abs(totalUnrealized) || 1

  function barWidth(n: number): string {
    return `${Math.min((Math.abs(n) / absTotal) * 100, 100)}%`
  }

  const profitTone = totalProfit > 0 ? 'text-emerald-700' : totalProfit < 0 ? 'text-rose-700' : 'text-slate-900'

  return (
    <div className="bg-white rounded-2xl border border-slate-200 p-5 md:p-6">
      <h2 className="text-base font-semibold text-slate-900 mb-4">Profit / loss breakdown</h2>

      <div className="space-y-4">
        {/* Unrealized */}
        <div>
          <div className="flex items-center justify-between text-sm mb-1.5">
            <span className="text-slate-600">Unrealized</span>
            <span className={`font-medium tabular-nums ${tone(totalUnrealized)}`}>
              {totalUnrealized >= 0 ? '+' : ''}{money(totalUnrealized, 'EUR')}
            </span>
          </div>
          <div className="h-1.5 w-full rounded-full bg-slate-100 overflow-hidden">
            <div
              className="h-full rounded-full transition-all"
              style={{ width: barWidth(totalUnrealized), backgroundColor: barColor(totalUnrealized) }}
            />
          </div>
        </div>

        {/* Realized */}
        <div>
          <div className="flex items-center justify-between text-sm mb-1.5">
            <span className="text-slate-600">Realized</span>
            <span className={`font-medium tabular-nums ${tone(totalRealized)}`}>
              {totalRealized >= 0 ? '+' : ''}{money(totalRealized, 'EUR')}
            </span>
          </div>
          <div className="h-1.5 w-full rounded-full bg-slate-100 overflow-hidden">
            <div
              className="h-full rounded-full transition-all"
              style={{ width: barWidth(totalRealized), backgroundColor: barColor(totalRealized) }}
            />
          </div>
        </div>

        {/* Total */}
        <div className="pt-3 border-t border-slate-100 flex items-center justify-between">
          <span className="text-sm font-medium text-slate-900">Total profit / loss</span>
          <div className="text-right">
            <span className={`text-base font-semibold tabular-nums ${profitTone}`}>
              {totalProfit >= 0 ? '+' : ''}{money(totalProfit, 'EUR')}
            </span>
            {totalEverInvested > 0 && (
              <span className="ml-2 text-xs text-slate-500 tabular-nums">
                ({totalProfit >= 0 ? '+' : ''}{((totalProfit / totalEverInvested) * 100).toFixed(2)}%)
              </span>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}

// ── Main export ────────────────────────────────────────────────────────────

type Props = {
  byCategory: AllocationSlice[]
  byPlatform: AllocationSlice[]
  liveMetrics: PortfolioMetrics
}

export function PortfolioBreakdownCharts({ byCategory, byPlatform, liveMetrics }: Props) {
  return (
    <div className="space-y-4">
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        <AllocationDonut title="By category" slices={byCategory} colorMap={CATEGORY_HEX} />
        <AllocationDonut title="By platform" slices={byPlatform} colorMap={PLATFORM_HEX} />
      </div>
      <ProfitLossBreakdown metrics={liveMetrics} />
    </div>
  )
}
