import { PrivacyMoney } from '@/components/ui/privacy-value'
import { fmtDate } from '@/lib/format'
import type { ReturnsData } from '@/lib/returns/load-returns'
import type { QualityIssue } from '@/lib/domain/twr-ledger'
import type { ResultColumn } from '@/lib/domain/investment-result'
import { CONTRIBUTION_TOLERANCE } from '@/lib/domain/twr'

function tone(n: number | null | undefined): string {
  if (n === null || n === undefined || !Number.isFinite(n) || Math.abs(n) < 0.005) return 'text-slate-900'
  return n > 0 ? 'text-emerald-700' : 'text-rose-700'
}

export function InvestmentResultBlock({ data }: { data: ReturnsData }) {
  const r = data.investmentResult
  const year = data.endDate.slice(0, 4)
  if (!r) {
    return (
      <section className="rounded-2xl border border-slate-200 bg-white p-5 text-sm text-slate-600">
        <h2 className="text-lg font-semibold text-slate-900">Investment result</h2>
        <p className="mt-1">Not available while a return period is incomplete (see Data quality below).</p>
      </section>
    )
  }
  const rows: { label: string; help: string; pick: (c: ResultColumn) => number; strong?: boolean; sign?: -1 }[] = [
    { label: 'Realised profit/loss', help: 'Net sale proceeds of the units sold − the average cost of those units (incl. fees).', pick: (c) => c.realisedEur },
    {
      label: 'Unrealised profit/loss (change)',
      help: 'Value − remaining cost of what is held at the end, minus the same at the start. Since start, this is simply the unrealised profit/loss now.',
      pick: (c) => c.unrealisedChangeEur,
    },
    { label: 'Dividends and interest', help: 'Gross dividends and interest received. Referral bonuses are not included: they are platform money, not investment income.', pick: (c) => c.dividendsInterestEur },
    {
      label: 'Transaction, storage and other costs',
      help: 'Separate cost rows: storage, exchange connection fees, negative interest. Buy and sell fees are already inside realised/unrealised and are not subtracted twice.',
      pick: (c) => -c.costsEur,
    },
    { label: 'Taxes withheld', help: 'Withholding tax on dividends and interest, and separate tax rows.', pick: (c) => -c.taxesEur },
  ]
  const cols = [
    { title: `${year}`, c: r.period },
    { title: 'Since start', c: r.sinceStart },
  ]
  const allReconciled = r.period.reconciled && r.sinceStart.reconciled
  return (
    <section className="space-y-3 min-w-0">
      <h2 className="text-lg font-semibold">Investment result</h2>
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
        {[
          { label: 'Gross unrealised gains', value: r.grossUnrealisedGainsEur, help: 'Sum of the unrealised profit of every open position that is in profit.' },
          { label: 'Gross unrealised losses', value: r.grossUnrealisedLossesEur, help: 'Sum of the unrealised loss of every open position that is at a loss.' },
          { label: 'Net unrealised profit/loss', value: r.netUnrealisedEur, help: 'Gains + losses: what the open positions are worth above their remaining cost.' },
        ].map((x) => (
          <div key={x.label} className="rounded-2xl border border-slate-200 bg-white p-4" title={x.help}>
            <p className="text-xs uppercase tracking-wide text-slate-500 font-medium">{x.label}</p>
            <p className={`mt-1 text-xl font-semibold tabular-nums ${tone(x.value)}`}>
              <PrivacyMoney value={x.value} signed />
            </p>
            <p className="text-xs text-slate-500">Open positions, {fmtDate(r.asOf)}</p>
          </div>
        ))}
      </div>
      <div className="max-w-full overflow-x-auto rounded-2xl border border-slate-200 bg-white">
        <table className="min-w-full text-sm">
          <thead className="bg-slate-50">
            <tr>
              <th className="px-4 py-2 text-left text-xs font-medium text-slate-500">Where the result comes from</th>
              {cols.map((c) => (
                <th key={c.title} className="px-4 py-2 text-right text-xs font-medium text-slate-500 whitespace-nowrap">{c.title}</th>
              ))}
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {rows.map((row) => (
              <tr key={row.label} title={row.help}>
                <td className="px-4 py-2 text-slate-700">{row.label}</td>
                {cols.map((c) => (
                  <td key={c.title} className={`px-4 py-2 text-right tabular-nums ${tone(row.pick(c.c))}`}>
                    <PrivacyMoney value={row.pick(c.c)} signed />
                  </td>
                ))}
              </tr>
            ))}
            <tr className="bg-slate-50 font-medium" title="Realised + unrealised change + dividends and interest − costs − taxes.">
              <td className="px-4 py-2">Total investment result</td>
              {cols.map((c) => (
                <td key={c.title} className={`px-4 py-2 text-right tabular-nums ${tone(c.c.totalEur)}`}>
                  <PrivacyMoney value={c.c.totalEur} signed />
                </td>
              ))}
            </tr>
            <tr title="End value − start value − net external cash flow (deposits − withdrawals), from the same values as the return.">
              <td className="px-4 py-2 text-xs text-slate-500">Check: value change − net external cash flow</td>
              {cols.map((c) => (
                <td key={c.title} className="px-4 py-2 text-right text-xs tabular-nums text-slate-500">
                  <PrivacyMoney value={c.c.checkEur} signed /> {c.c.reconciled ? <span className="text-emerald-700">✓</span> : <span className="text-rose-700">≠</span>}
                </td>
              ))}
            </tr>
          </tbody>
        </table>
      </div>
      {!allReconciled && (
        <p className="text-sm text-rose-700">
          Calculation error: the result does not match the value change (difference{' '}
          <PrivacyMoney value={r.period.reconciled ? r.sinceStart.differenceEur : r.period.differenceEur} signed />).
        </p>
      )}
      <ul className="list-disc space-y-1 pl-5 text-xs text-slate-600">
        <li><strong>Unrealised</strong> is only about what you still hold today.</li>
        <li><strong>Realised</strong> is about units that were sold. A partly sold position counts once: the sold units here, the rest as unrealised.</li>
        <li>Sale proceeds that were invested again are <strong>not new money</strong>; they stay part of the result.</li>
        <li>The <strong>portfolio return</strong> (%) is not the same as unrealised profit: it also includes realised results, dividends and costs, and is measured over time.</li>
        <li>Buy and sell fees (<PrivacyMoney value={r.sinceStart.transactionFeesIncludedEur} /> since start) are already in realised/unrealised.</li>
      </ul>
    </section>
  )
}

type Category = 'calculation_error' | 'missing_data' | 'estimated_benchmark' | 'officially_confirmed' | 'owner_decision'

const CATEGORY: Record<Category, { title: string; cls: string; help: string }> = {
  calculation_error: { title: 'Calculation error', cls: 'border-rose-200 bg-rose-50 text-rose-900', help: 'Figures that do not add up. None means every check passed.' },
  missing_data: { title: 'Missing data', cls: 'border-amber-200 bg-amber-50 text-amber-900', help: 'Something is not in the records yet.' },
  estimated_benchmark: { title: 'Estimated with a market benchmark', cls: 'border-sky-200 bg-sky-50 text-sky-900', help: 'Valued with a market price (e.g. COMEX) instead of the broker’s own price. Not an error.' },
  officially_confirmed: { title: 'Officially confirmed statement values', cls: 'border-emerald-200 bg-emerald-50 text-emerald-900', help: 'Values taken from broker statements.' },
  owner_decision: { title: 'Owner-approved treatments', cls: 'border-slate-200 bg-white text-slate-700', help: 'Explicit decisions about how records are treated.' },
}

const ISSUE_CATEGORY: Record<QualityIssue['kind'], Category> = {
  metal_benchmark: 'estimated_benchmark',
  cash_shortfall: 'missing_data',
  storage_costs_missing: 'missing_data',
  proposed_flow: 'missing_data',
}

export function DataQualityPanel({ data }: { data: ReturnsData }) {
  const items: Record<Category, string[]> = {
    calculation_error: [], missing_data: [], estimated_benchmark: [], officially_confirmed: [], owner_decision: [],
  }
  const seen = new Set<string>()
  const add = (c: Category, text: string) => {
    if (seen.has(c + text)) return
    seen.add(c + text)
    items[c].push(text)
  }
  for (const p of data.periods) {
    for (const i of p.qualityIssues) add(ISSUE_CATEGORY[i.kind], i.detail)
    if (p.twr.status !== 'ok' || p.twr.truncated) add('missing_data', `${p.label}: ${p.twr.missing[0]?.reason ?? 'data incomplete'}`)
    if (p.twr.status === 'ok' && (p.twr.residual === null || Math.abs(p.twr.residual) > CONTRIBUTION_TOLERANCE)) {
      add('calculation_error', `${p.label}: contributions do not add up to the return.`)
    }
    for (const n of p.notes) if (/reconciled by|paid privately/.test(n)) add('owner_decision', n)
  }
  const r = data.investmentResult
  if (r) {
    for (const [label, c] of [[`${data.endDate.slice(0, 4)}`, r.period], ['Since start', r.sinceStart]] as const) {
      if (c.reconciled) continue
      add('calculation_error', `${label}: the investment result differs ${c.differenceEur >= 0 ? '+' : ''}${c.differenceEur.toFixed(2)} EUR from the value change − net external cash flow.`)
    }
    if (!(r.period.reconciled && r.sinceStart.reconciled)) {
      // A statement replacing a different reconstructed cash balance moves the
      // value without any transaction: the usual cause of such a difference.
      for (const p of data.periods) for (const n of p.notes) if (/records give .* statement/.test(n)) add('calculation_error', `Likely cause: ${n}`)
    }
  }
  if (data.anchorSource) add('officially_confirmed', `Start values on 31 Dec: ${data.anchorSource}.`)

  const order: Category[] = ['calculation_error', 'missing_data', 'estimated_benchmark', 'officially_confirmed', 'owner_decision']
  return (
    <section className="space-y-2 min-w-0">
      <h2 className="text-lg font-semibold">Data quality and sources</h2>
      {items.calculation_error.length === 0 && (
        <p className="text-sm text-emerald-700">No calculation errors: the return, the contributions and the investment result all add up ✓</p>
      )}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-3 [&>*]:min-w-0">
        {order.filter((c) => items[c].length > 0).map((c) => (
          <div key={c} className={`rounded-2xl border p-4 text-sm ${CATEGORY[c].cls}`}>
            <p className="font-medium" title={CATEGORY[c].help}>{CATEGORY[c].title}</p>
            <p className="text-xs opacity-80">{CATEGORY[c].help}</p>
            <ul className="mt-2 list-disc space-y-1 pl-5">
              {items[c].map((t) => <li key={t}>{t}</li>)}
            </ul>
          </div>
        ))}
      </div>
    </section>
  )
}
