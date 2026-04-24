import { notFound } from 'next/navigation'
import Link from 'next/link'
import { createClient } from '@/lib/supabase/server'
import { PageHeader } from '@/components/ui/page-header'
import { Badge } from '@/components/ui/badge'
import { StatCard } from '@/components/ui/stat-card'
import { money, fmtDate } from '@/lib/format'
import { computeInvestmentMetrics, pct } from '@/lib/domain/calculations'
import { txTypeBadgeClass } from '@/lib/domain/transaction-helpers'
import { hasUnits } from '@/lib/domain/constants'
import type { Investment, Transaction } from '@/types/database'

export default async function InvestmentDetailPage({
  params,
}: {
  params: Promise<{ id: string }>
}) {
  const { id } = await params
  const supabase = await createClient()

  const [invRes, txRes] = await Promise.all([
    supabase.from('investments').select('*').eq('id', id).single<Investment>(),
    supabase
      .from('transactions')
      .select('*')
      .eq('investment_id', id)
      .order('date', { ascending: false })
      .order('created_at', { ascending: false })
      .returns<Transaction[]>(),
  ])

  if (invRes.error || !invRes.data) {
    notFound()
  }

  const investment = invRes.data
  const transactions = txRes.data ?? []
  const metrics = computeInvestmentMetrics(investment, transactions)
  const profitTone: 'positive' | 'negative' | 'neutral' =
    metrics.profit > 0
      ? 'positive'
      : metrics.profit < 0
      ? 'negative'
      : 'neutral'

  return (
    <div className="space-y-6">
      <div>
        <Link
          href="/investments"
          className="text-sm text-slate-500 hover:text-slate-700"
        >
          ← Back to investments
        </Link>
      </div>

      <PageHeader
        title={investment.name}
        subtitle={
          investment.ticker
            ? `${investment.ticker} · ${investment.type} · ${investment.platform}`
            : `${investment.type} · ${investment.platform}`
        }
        action={
          <div className="flex items-center gap-2">
            <Link
              href={`/transactions/new?investment=${investment.id}`}
              className="inline-flex items-center justify-center rounded-lg border border-slate-300 bg-white px-4 py-2 text-sm font-medium text-slate-900 hover:bg-slate-50"
            >
              + Add transaction
            </Link>
            <Link
              href={`/investments/${investment.id}/edit`}
              className="inline-flex items-center justify-center rounded-lg bg-slate-900 px-4 py-2 text-sm font-medium text-white hover:bg-slate-800"
            >
              Edit
            </Link>
          </div>
        }
      />

<div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
        <StatCard label="Current value" value={money(metrics.currentValue)} />
        <StatCard label="Total invested" value={money(metrics.invested)} />
        <StatCard
          label="Profit / loss"
          value={metrics.invested > 0 ? money(metrics.profit) : '—'}
          hint={
            metrics.invested > 0 && metrics.profitPct !== null
              ? pct(metrics.profitPct)
              : 'Add a transaction to start tracking gains'
          }
          tone={metrics.invested > 0 ? profitTone : 'neutral'}
        />
      </div>

      {hasUnits(investment.type) && (
        <div className="bg-white rounded-2xl border border-slate-200 p-5 md:p-6">
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-4 text-sm">
            <div>
              <p className="text-xs uppercase tracking-wide text-slate-500 font-medium">
                Quantity held
              </p>
              <p className="mt-1 text-base text-slate-900 tabular-nums">
                {metrics.quantity ?? 0}
              </p>
            </div>
            <div>
              <p className="text-xs uppercase tracking-wide text-slate-500 font-medium">
                Current price
              </p>
              <p className="mt-1 text-base text-slate-900 tabular-nums">
                {investment.current_price !== null
                  ? money(investment.current_price)
                  : '—'}
              </p>
            </div>
            <div>
              <p className="text-xs uppercase tracking-wide text-slate-500 font-medium">
                Last updated
              </p>
              <p className="mt-1 text-base text-slate-900">
                {fmtDate(investment.updated_at)}
              </p>
            </div>
          </div>
        </div>
      )}

      {investment.notes && (
        <div className="bg-white rounded-2xl border border-slate-200 p-5 md:p-6">
          <h2 className="text-base font-semibold text-slate-900">Notes</h2>
          <p className="mt-2 text-sm text-slate-700 whitespace-pre-wrap">
            {investment.notes}
          </p>
        </div>
      )}

      <div className="bg-white rounded-2xl border border-slate-200 overflow-hidden">
        <div className="flex items-center justify-between px-5 md:px-6 py-4 border-b border-slate-100">
          <h2 className="text-base font-semibold text-slate-900">
            Transaction history
          </h2>
          <Link
            href={`/transactions/new?investment=${investment.id}`}
            className="text-sm text-slate-600 hover:text-slate-900"
          >
            + Add transaction
          </Link>
        </div>

        {transactions.length === 0 ? (
          <div className="p-6 text-sm text-slate-500">
            No transactions yet for this investment.
          </div>
        ) : (
          <>
            <table className="hidden md:table w-full">
              <thead>
                <tr className="text-left text-xs uppercase tracking-wide text-slate-500 border-b border-slate-200">
                  <th className="px-6 py-3 font-medium">Date</th>
                  <th className="px-6 py-3 font-medium">Type</th>
                  <th className="px-6 py-3 font-medium text-right">Quantity</th>
                  <th className="px-6 py-3 font-medium text-right">Price</th>
                  <th className="px-6 py-3 font-medium text-right">Amount</th>
                  <th className="px-6 py-3 font-medium text-right">Fee</th>
                  <th className="px-6 py-3" />
                </tr>
              </thead>
              <tbody>
                {transactions.map((tx) => (
                  <tr
                    key={tx.id}
                    className="border-b last:border-b-0 border-slate-100 hover:bg-slate-50"
                  >
                    <td className="px-6 py-4 text-sm text-slate-700 whitespace-nowrap">
                      {fmtDate(tx.date)}
                    </td>
                    <td className="px-6 py-4">
                      <Badge className={txTypeBadgeClass(tx.type)}>
                        {tx.type}
                      </Badge>
                    </td>
                    <td className="px-6 py-4 text-right text-sm text-slate-700 tabular-nums">
                      {tx.quantity !== null ? tx.quantity : '—'}
                    </td>
                    <td className="px-6 py-4 text-right text-sm text-slate-700 tabular-nums">
                      {tx.price_per_unit !== null
                        ? money(tx.price_per_unit)
                        : '—'}
                    </td>
                    <td className="px-6 py-4 text-right text-sm text-slate-900 tabular-nums">
                      {money(tx.amount)}
                    </td>
                    <td className="px-6 py-4 text-right text-sm text-slate-500 tabular-nums">
                      {tx.fee > 0 ? money(tx.fee) : '—'}
                    </td>
                    <td className="px-6 py-4 text-right">
                      <Link
                        href={`/transactions/${tx.id}/edit`}
                        className="text-sm font-medium text-slate-700 hover:text-slate-900"
                      >
                        Edit
                      </Link>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>

            <ul className="md:hidden divide-y divide-slate-100">
              {transactions.map((tx) => (
                <li key={tx.id}>
                  <Link
                    href={`/transactions/${tx.id}/edit`}
                    className="block px-5 py-4 hover:bg-slate-50"
                  >
                    <div className="flex items-center justify-between gap-3">
                      <div>
                        <Badge className={txTypeBadgeClass(tx.type)}>
                          {tx.type}
                        </Badge>
                        <div className="mt-1 text-xs text-slate-500">
                          {fmtDate(tx.date)}
                        </div>
                      </div>
                      <div className="text-right">
                        <div className="text-sm text-slate-900 tabular-nums">
                          {money(tx.amount)}
                        </div>
                        {tx.quantity !== null && tx.price_per_unit !== null && (
                          <div className="text-xs text-slate-500 tabular-nums">
                            {tx.quantity} × {money(tx.price_per_unit)}
                          </div>
                        )}
                      </div>
                    </div>
                  </Link>
                </li>
              ))}
            </ul>
          </>
        )}
      </div>
    </div>
  )
}