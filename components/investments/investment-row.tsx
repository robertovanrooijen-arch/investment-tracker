'use client'

import { useRouter } from 'next/navigation'
import { money, fmtDate } from '@/lib/format'
import { pct } from '@/lib/domain/calculations'
import type { InvestmentMetrics } from '@/lib/domain/calculations'
import type { Investment } from '@/types/database'

export type PrevSnap = { value_eur: number; quantity: number | null }

type Props = {
  inv: Investment
  m: InvestmentMetrics
  dailyChangeEur: number | null
  dailyChangePct: number | null
}

export function InvestmentRow({ inv, m, dailyChangeEur, dailyChangePct }: Props) {
  const router = useRouter()
  const href = `/investments/${inv.id}`

  const showPL = m.totalEverInvested > 0
  const plTone =
    m.totalProfit > 0
      ? 'text-emerald-600'
      : m.totalProfit < 0
        ? 'text-rose-600'
        : 'text-slate-900'

  const dailyTone =
    dailyChangeEur === null
      ? ''
      : dailyChangeEur > 0
        ? 'text-emerald-600'
        : dailyChangeEur < 0
          ? 'text-rose-600'
          : 'text-slate-900'

  function navigate(e: React.MouseEvent | React.KeyboardEvent) {
    const selection = typeof window !== 'undefined' ? window.getSelection() : null
    if (selection && selection.toString().length > 0) return
    if ('metaKey' in e && (e.metaKey || e.ctrlKey)) {
      window.open(href, '_blank')
      return
    }
    router.push(href)
  }

  return (
    <tr
      tabIndex={0}
      onClick={navigate}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault()
          navigate(e)
        }
      }}
      className="border-b last:border-b-0 border-slate-100 hover:bg-slate-50 cursor-pointer focus:bg-slate-50 focus:outline-none focus-visible:ring-2 focus-visible:ring-slate-300 focus-visible:ring-inset"
    >
      <td className="px-6 py-4">
        <div className="font-medium text-slate-900 flex items-center gap-2">
          {inv.name}
          {m.isClosed && (
            <span className="inline-flex items-center rounded-full bg-slate-100 px-2 py-0.5 text-xs font-medium text-slate-500">
              Closed
            </span>
          )}
        </div>
        <div className="text-xs text-slate-500">
          {inv.ticker ? `${inv.ticker} · ` : ''}
          {inv.currency ?? 'EUR'}
        </div>
      </td>

      <td className="px-6 py-4">
        <span className="inline-flex items-center rounded-full bg-slate-100 px-2 py-0.5 text-xs font-medium text-slate-700">
          {inv.type}
        </span>
      </td>

      <td className="px-6 py-4 text-sm text-slate-700">{inv.platform}</td>

      <td className="px-6 py-4 text-right text-sm text-slate-900 tabular-nums">
        {money(m.currentValue, 'EUR')}
      </td>

      <td className={`px-6 py-4 text-right text-sm tabular-nums ${plTone}`}>
        {showPL ? (
          <>
            <div>{money(m.totalProfit, 'EUR')}</div>
            <div className="text-xs">
              {m.totalProfitPct !== null ? pct(m.totalProfitPct) : '—'}
            </div>
          </>
        ) : (
          <span className="text-slate-400">—</span>
        )}
      </td>

      <td className={`px-6 py-4 text-right text-sm tabular-nums ${dailyTone}`}>
        {dailyChangeEur !== null ? (
          <>
            <div>
              {dailyChangeEur >= 0 ? '+' : ''}
              {money(dailyChangeEur, 'EUR')}
            </div>
            <div className="text-xs">
              {dailyChangePct !== null
                ? `${dailyChangePct >= 0 ? '+' : ''}${dailyChangePct.toFixed(2)}%`
                : '—'}
            </div>
          </>
        ) : (
          <span className="text-slate-400">—</span>
        )}
      </td>

      <td className="px-6 py-4 text-sm text-slate-500">
        {fmtDate(inv.updated_at)}
      </td>
    </tr>
  )
}
