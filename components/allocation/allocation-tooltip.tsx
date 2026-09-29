import { money } from '@/lib/format'
import { pct } from '@/lib/domain/calculations'

export type AllocationTooltipPayload = {
  name: string
  value: number
  contextPct: number
  portfolioPct?: number
  contextLabel: string
}

/**
 * Shared recharts tooltip content for every donut on the allocation page —
 * keeps the "name / value / % of category / % of portfolio" shape identical
 * across the overview chart and every per-category chart.
 */
export function AllocationTooltip({
  active,
  payload,
}: {
  active?: boolean
  payload?: { payload: AllocationTooltipPayload }[]
}) {
  if (!active || !payload?.length) return null
  const { name, value, contextPct, portfolioPct, contextLabel } = payload[0].payload

  return (
    <div className="min-w-[200px] max-w-[240px] rounded-xl border border-slate-200 bg-white px-4 py-3 shadow-lg">
      <p className="text-sm font-medium text-slate-700 truncate">{name}</p>
      <p className="mt-1 text-base font-semibold text-slate-900 tabular-nums leading-tight">
        {money(value, 'EUR')}
      </p>
      <div className="mt-1.5 space-y-1 text-xs leading-snug text-slate-500">
        <p className="whitespace-nowrap tabular-nums">
          {pct(contextPct)} of {contextLabel}
        </p>
        {portfolioPct !== undefined && (
          <p className="whitespace-nowrap tabular-nums">{pct(portfolioPct)} of portfolio</p>
        )}
      </div>
    </div>
  )
}
