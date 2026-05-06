import Link from 'next/link'
import { createClient } from '@/lib/supabase/server'
import { PageHeader } from '@/components/ui/page-header'
import { money } from '@/lib/format'
import { computeInvestmentMetrics, pct } from '@/lib/domain/calculations'
import { loadFxRates } from '@/lib/domain/fx'
import { InvestmentRow } from '@/components/investments/investment-row'
import type { Investment, Transaction } from '@/types/database'

export default async function InvestmentsPage() {
  const supabase = await createClient()

  const [invRes, txRes, fxRes] = await Promise.all([
    supabase
      .from('investments')
      .select('*')
      .order('updated_at', { ascending: false })
      .returns<Investment[]>(),
    supabase.from('transactions').select('*').returns<Transaction[]>(),
    loadFxRates(supabase),
  ])

  const error = invRes.error
  const investments = invRes.data ?? []
  const transactions = txRes.data ?? []
  const fxRates = fxRes.rates

  const rows = investments.map((inv) => ({
    inv,
    m: computeInvestmentMetrics(inv, transactions, fxRates),
  }))

  return (
    <div className="space-y-6">
      <PageHeader
        title="Investments"
        subtitle="Every position you're tracking. Values shown in EUR."
        action={
          <Link
            href="/investments/new"
            className="inline-flex items-center justify-center rounded-lg bg-slate-900 px-4 py-2 text-sm font-medium text-white hover:bg-slate-800"
          >
            + Add investment
          </Link>
        }
      />

      {error && (
        <div className="bg-white rounded-2xl border border-rose-200 p-6 text-sm text-rose-600">
          Could not load investments: {error.message}
        </div>
      )}

      {!error && rows.length === 0 && (
        <div className="bg-white rounded-2xl border border-slate-200 p-10 text-center">
          <p className="text-slate-900 font-medium">No investments yet</p>
          <p className="text-sm text-slate-500 mt-1">
            Add your first position to start tracking your portfolio.
          </p>
          <Link
            href="/investments/new"
            className="mt-4 inline-flex items-center justify-center rounded-lg bg-slate-900 px-4 py-2 text-sm font-medium text-white hover:bg-slate-800"
          >
            + Add investment
          </Link>
        </div>
      )}

      {!error && rows.length > 0 && (
        <div className="bg-white rounded-2xl border border-slate-200 overflow-hidden">
          <table className="hidden md:table w-full">
            <thead>
              <tr className="text-left text-xs uppercase tracking-wide text-slate-500 border-b border-slate-200">
                <th className="px-6 py-3 font-medium">Name</th>
                <th className="px-6 py-3 font-medium">Type</th>
                <th className="px-6 py-3 font-medium">Platform</th>
                <th className="px-6 py-3 font-medium text-right">Value EUR</th>
                <th className="px-6 py-3 font-medium text-right">P / L EUR</th>
                <th className="px-6 py-3 font-medium">Updated</th>
              </tr>
            </thead>
            <tbody>
              {rows.map(({ inv, m }) => (
                <InvestmentRow key={inv.id} inv={inv} m={m} />
              ))}
            </tbody>
          </table>

          <ul className="md:hidden divide-y divide-slate-100">
            {rows.map(({ inv, m }) => {
              const showPL = m.totalEverInvested > 0
              const plTone =
                m.totalProfit > 0
                  ? 'text-emerald-600'
                  : m.totalProfit < 0
                    ? 'text-rose-600'
                    : 'text-slate-500'

              return (
                <li key={inv.id}>
                  <Link
                    href={`/investments/${inv.id}`}
                    className="flex items-center justify-between px-5 py-4 hover:bg-slate-50"
                  >
                    <div className="min-w-0">
                      <div className="font-medium text-slate-900 truncate flex items-center gap-2">
                        {inv.name}
                        {m.isClosed && (
                          <span className="inline-flex items-center rounded-full bg-slate-100 px-2 py-0.5 text-xs font-medium text-slate-500">
                            Closed
                          </span>
                        )}
                      </div>

                      <div className="mt-1 flex items-center gap-2 text-xs text-slate-500">
                        <span>{inv.type}</span>
                        <span>·</span>
                        <span>{inv.platform}</span>
                        <span>·</span>
                        <span>{inv.currency ?? 'EUR'}</span>
                      </div>
                    </div>

                    <div className="text-right shrink-0">
                      <div className="text-sm text-slate-900 tabular-nums">
                        {money(m.currentValue, 'EUR')}
                      </div>
                      <div className={`text-xs tabular-nums ${plTone}`}>
                        {showPL
                          ? m.totalProfitPct !== null
                            ? pct(m.totalProfitPct)
                            : '—'
                          : '—'}
                      </div>
                    </div>
                  </Link>
                </li>
              )
            })}
          </ul>
        </div>
      )}
    </div>
  )
}