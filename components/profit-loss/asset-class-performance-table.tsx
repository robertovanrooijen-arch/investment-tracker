'use client'

/**
 * Both percentages below are pre-scaled (already ×100, e.g. 9.4 meaning
 * 9.4%) — the two source calculations use different scales internally
 * (year-analysis.ts's AssetClassYtd vs. calculations.ts's CategoryPerformance,
 * a 0–1 fraction), so the page normalizes them to one convention before this
 * component ever sees them. Never pass a 0–1 fraction in here.
 */
export type ClassPerformanceRow = {
  key: string
  label: string
  ytdReturnPercent: number | null
  ytdUnavailableReason: string | null
  // Unrealized return on remaining cost of the open positions in this class.
  unrealizedReturnPercent: number | null
}

function fmtPercent(n: number | null): string {
  if (n === null || !Number.isFinite(n)) return '—'
  return `${n >= 0 ? '+' : ''}${n.toFixed(1)}%`
}

function toneClass(n: number | null): string {
  if (n === null) return 'text-slate-400'
  if (n > 0) return 'text-emerald-600'
  if (n < 0) return 'text-rose-600'
  return 'text-slate-900'
}

export function AssetClassPerformanceTable({ rows }: { rows: ClassPerformanceRow[] }) {
  if (rows.length === 0) {
    return <p className="text-sm text-slate-500">No asset classes to show yet.</p>
  }

  return (
    <>
      {/* Desktop table */}
      <table className="hidden sm:table w-full text-sm">
        <thead>
          <tr className="text-left text-xs uppercase tracking-wide text-slate-500">
            <th className="pb-2 font-medium">Asset class</th>
            <th className="pb-2 font-medium text-right">YTD return</th>
            <th className="pb-2 font-medium text-right" title="(value − remaining cost) ÷ remaining cost of open positions">Unrealized on cost</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={row.key} className="border-t border-slate-100">
              <td className="py-2.5 pr-2 font-medium text-slate-900">{row.label}</td>
              <td
                className={`py-2.5 text-right tabular-nums ${toneClass(row.ytdReturnPercent)}`}
                title={row.ytdReturnPercent === null ? (row.ytdUnavailableReason ?? undefined) : undefined}
              >
                {fmtPercent(row.ytdReturnPercent)}
              </td>
              <td className={`py-2.5 text-right tabular-nums ${toneClass(row.unrealizedReturnPercent)}`}>
                {fmtPercent(row.unrealizedReturnPercent)}
              </td>
            </tr>
          ))}
        </tbody>
      </table>

      {/* Mobile cards */}
      <ul className="sm:hidden divide-y divide-slate-100">
        {rows.map((row) => (
          <li key={row.key} className="py-3 flex items-center justify-between gap-3">
            <span className="font-medium text-slate-900">{row.label}</span>
            <div className="text-right text-sm">
              <div
                className={`tabular-nums ${toneClass(row.ytdReturnPercent)}`}
                title={row.ytdReturnPercent === null ? (row.ytdUnavailableReason ?? undefined) : undefined}
              >
                YTD {fmtPercent(row.ytdReturnPercent)}
              </div>
              <div className={`tabular-nums text-xs ${toneClass(row.unrealizedReturnPercent)}`}>
                Unrealized {fmtPercent(row.unrealizedReturnPercent)}
              </div>
            </div>
          </li>
        ))}
      </ul>
    </>
  )
}
