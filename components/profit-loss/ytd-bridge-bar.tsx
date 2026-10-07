'use client'

import { money } from '@/lib/format'
import { PrivacyGate } from '@/components/ui/privacy-value'

export type YtdBridgeAmounts = {
  startValueEur: number
  netContributionsEur: number
  /** end - start - netContributions — real investment return, contributions already backed out. */
  investmentProfitEur: number
  endValueEur: number
}

function fmtSignedMoney(n: number): string {
  return `${n >= 0 ? '+' : ''}${money(n, 'EUR')}`
}

function fmtSignedPct(n: number): string {
  return `${n >= 0 ? '+' : ''}${n.toFixed(1)}%`
}

function fmtIndexPct(n: number): string {
  return `${n.toFixed(1)}%`
}

/**
 * Horizontal stacked bar: start-of-year value + net contributions +
 * investment profit, tiled left to right. Segment widths are proportional
 * to each amount's magnitude (not a signed waterfall) — simpler to read at
 * a glance, and the sign/color on each number still makes a loss or a
 * withdrawal-heavy year obvious. Privacy mode swaps every euro figure for
 * its share of the start-of-year value, so the same relative story
 * ("where did this year's change come from") still reads without leaking
 * any absolute amount.
 */
export function YtdBridgeBar({ amounts }: { amounts: YtdBridgeAmounts }) {
  const { startValueEur, netContributionsEur, investmentProfitEur, endValueEur } = amounts

  const scale =
    Math.abs(startValueEur) + Math.abs(netContributionsEur) + Math.abs(investmentProfitEur) || 1
  const pctOfStart = startValueEur !== 0 ? (n: number) => (n / startValueEur) * 100 : null

  const segments = [
    {
      key: 'start',
      label: 'Start of year',
      amount: startValueEur,
      color: '#e2e8f0', // slate-200
      textClass: 'text-slate-700',
      amountText: money(startValueEur, 'EUR'),
      privacyText: pctOfStart ? fmtIndexPct(pctOfStart(startValueEur)) : '—',
    },
    {
      key: 'contributions',
      label: 'Net contributions',
      amount: netContributionsEur,
      color: netContributionsEur >= 0 ? '#86efac' : '#fca5a5', // emerald-300 / rose-300
      textClass: netContributionsEur >= 0 ? 'text-emerald-700' : 'text-rose-700',
      amountText: fmtSignedMoney(netContributionsEur),
      privacyText: pctOfStart ? fmtSignedPct(pctOfStart(netContributionsEur)) : '—',
    },
    {
      key: 'profit',
      label: 'Investment profit',
      amount: investmentProfitEur,
      color: investmentProfitEur >= 0 ? '#059669' : '#dc2626', // emerald-600 / rose-600
      textClass: investmentProfitEur >= 0 ? 'text-emerald-700' : 'text-rose-700',
      amountText: fmtSignedMoney(investmentProfitEur),
      privacyText: pctOfStart ? fmtSignedPct(pctOfStart(investmentProfitEur)) : '—',
    },
  ]

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-4 text-sm">
        {segments.map((s) => (
          <div key={s.key}>
            <div className="flex items-center gap-1.5 text-xs text-slate-500">
              <span className="inline-block h-2 w-2 shrink-0 rounded-full" style={{ backgroundColor: s.color }} />
              {s.label}
            </div>
            <div className={`mt-0.5 font-medium tabular-nums ${s.textClass}`}>
              <PrivacyValueOrFallback amountText={s.amountText} privacyText={s.privacyText} />
            </div>
          </div>
        ))}
        <div>
          <div className="text-xs text-slate-500">Current value</div>
          <div className="mt-0.5 font-semibold text-slate-900 tabular-nums">
            <PrivacyValueOrFallback
              amountText={money(endValueEur, 'EUR')}
              privacyText={pctOfStart ? fmtIndexPct(pctOfStart(endValueEur)) : '—'}
            />
          </div>
        </div>
      </div>

      <div className="flex h-3 w-full overflow-hidden rounded-full bg-slate-100" role="img" aria-label="Start of year, net contributions, and investment profit, proportional to their size">
        {segments.map((s) => (
          <div
            key={s.key}
            style={{ width: `${(Math.abs(s.amount) / scale) * 100}%`, backgroundColor: s.color }}
          />
        ))}
      </div>

      <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-slate-500">
        {segments.map((s) => (
          <span key={s.key} className="inline-flex items-center gap-1.5">
            <span className="inline-block h-2 w-2 shrink-0 rounded-full" style={{ backgroundColor: s.color }} />
            {s.label}
          </span>
        ))}
      </div>
    </div>
  )
}

function PrivacyValueOrFallback({ amountText, privacyText }: { amountText: string; privacyText: string }) {
  return (
    <PrivacyGate fallback={privacyText}>
      <>{amountText}</>
    </PrivacyGate>
  )
}
