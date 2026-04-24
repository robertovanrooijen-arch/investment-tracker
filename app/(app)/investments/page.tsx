import Link from 'next/link'
import { createClient } from '@/lib/supabase/server'
import { PageHeader } from '@/components/ui/page-header'
import { money, fmtDate } from '@/lib/format'
import {
  computeInvestmentMetrics,
  pct,
} from '@/lib/domain/calculations'
import type { Investment, Transaction } from '@/types/database'

export default async function InvestmentsPage() {
  const supabase = await createClient()

  const [invRes, txRes] = await Promise.all([
    supabase
      .from('investments')
      .select('*')
      .order('updated_at', { ascending: false })
      .returns<Investment[]>(),
    supabase.from('transactions').select('*').returns<Transaction[]>(),
  ])

  const error = invRes.error
  const investments = invRes.data ?? []
  const transactions = txRes.data ?? []

  const rows = investments.map((inv) => ({
    inv,
    m: computeInvestmentMetrics(inv, transactions),
  }))

  return (
    <div className="space-y-6">
      <PageHeader
        title="Investments"
        subtitle="Every position you're tracking."
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
                <th className="px-6 py-3 font-medium text-right">Value</th>
                <th className="px-6 py-3 font-medium text-right">P / L</th>
                <th className="px-6 py-3 font-medium">Updated</th>
                <th className="px-6 py-3" />
              </tr>
            </thead>
            <tbody>
              {rows.map(({ inv, m }) => {
                const hasInvested = m.invested > 0
                const plTone =
                  m.profit > 0
                    ? 'text-emerald-600'
                    : m.profit < 0
                    ? 'text-rose-600'
                    : 'text-slate-900'
                return (
                  <tr
                    key={inv.id}
                    className="border-b last:border-b-0 border-slate-100 hover:bg-slate-50"
                  >
                    <td className="px-6 py-4">
                      <Link href={`/investments/${inv.id}`} className="block">
                        <div className="font-medium text-slate-900">
                          {inv.name}
                        </div>
                        {inv.ticker && (
                          <div className="text-xs text-slate-500">
                            {inv.ticker}
                          </div>
                        )}
                      </Link>
                    </td>
                    <td className="px-6 py-4">
                      <span className="inline-flex items-center rounded-full bg-slate-100 px-2 py-0.5 text-xs font-medium text-slate-700">
                        {inv.type}
                      </span>
                    </td>
                    <td className="px-6 py-4 text-sm text-slate-700">
                      {inv.platform}
                    </td>
                    <td className="px-6 py-4 text-right text-sm text-slate-900 tabular-nums">
                      {money(m.currentValue)}
                    </td>
                    <td
                      className={`px-6 py-4 text-right text-sm tabular-nums ${plTone}`}
                    >
                      {hasInvested ? (
                        <>
                          <div>{money(m.profit)}</div>
                          <div className="text-xs">
                            {m.profitPct !== null ? pct(m.profitPct) : '—'}
                          </div>
                        </>
                      ) : (
                        <span className="text-slate-400">—</span>
                      )}
                    </td>
                    <td className="px-6 py-4 text-sm text-slate-500">
                      {fmtDate(inv.updated_at)}
                    </td>
                    <td className="px-6 py-4 text-right">
                      <Link
                        href={`/investments/${inv.id}`}
                        className="text-sm font-medium text-slate-700 hover:text-slate-900"
                      >
                        View
                      </Link>
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>

          <ul className="md:hidden divide-y divide-slate-100">
            {rows.map(({ inv, m }) => {
              const hasInvested = m.invested > 0
              const plTone =
                m.profit > 0
                  ? 'text-emerald-600'
                  : m.profit < 0
                  ? 'text-rose-600'
                  : 'text-slate-500'
              return (
                <li key={inv.id}>
                  <Link
                    href={`/investments/${inv.id}`}
                    className="flex items-center justify-between px-5 py-4 hover:bg-slate-50"
                  >
                    <div className="min-w-0">
                      <div className="font-medium text-slate-900 truncate">
                        {inv.name}
                      </div>
                      <div className="mt-1 flex items-center gap-2 text-xs text-slate-500">
                        <span>{inv.type}</span>
                        <span>·</span>
                        <span>{inv.platform}</span>
                      </div>
                    </div>
                    <div className="text-right shrink-0">
                      <div className="text-sm text-slate-900 tabular-nums">
                        {money(m.currentValue)}
                      </div>
                      <div className={`text-xs tabular-nums ${plTone}`}>
                        {hasInvested
                          ? m.profitPct !== null
                            ? pct(m.profitPct)
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