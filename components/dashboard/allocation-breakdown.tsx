import { money } from '@/lib/format'
import { pct } from '@/lib/domain/calculations'
import type { AllocationSlice } from '@/lib/domain/calculations'

type AllocationBreakdownProps = {
  title: string
  slices: AllocationSlice[]
  colorFor: (key: string) => string
  emptyMessage?: string
}

export function AllocationBreakdown({
  title,
  slices,
  colorFor,
  emptyMessage = 'Nothing to show yet.',
}: AllocationBreakdownProps) {
  return (
    <div className="bg-white rounded-2xl border border-slate-200 p-5 md:p-6">
      <h2 className="text-base font-semibold text-slate-900">{title}</h2>
      {slices.length === 0 ? (
        <p className="mt-4 text-sm text-slate-500">{emptyMessage}</p>
      ) : (
        <ul className="mt-4 space-y-3">
          {slices.map((s) => (
            <li key={s.key}>
              <div className="flex items-center justify-between text-sm">
                <div className="flex items-center gap-2 min-w-0">
                  <span
                    className={`inline-block h-2.5 w-2.5 rounded-full ${colorFor(s.key)}`}
                  />
                  <span className="truncate text-slate-700">{s.key}</span>
                </div>
                <div className="flex items-center gap-3 shrink-0">
                  <span className="text-slate-500 tabular-nums">
                    {pct(s.pct)}
                  </span>
                  <span className="font-medium text-slate-900 tabular-nums">
                    {money(s.value)}
                  </span>
                </div>
              </div>
              <div className="mt-1.5 h-1.5 w-full rounded-full bg-slate-100 overflow-hidden">
                <div
                  className={`h-full rounded-full ${colorFor(s.key)}`}
                  style={{ width: `${Math.max(s.pct * 100, 1)}%` }}
                />
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}