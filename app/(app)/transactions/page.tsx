import Link from 'next/link'
import { createClient } from '@/lib/supabase/server'
import { PageHeader } from '@/components/ui/page-header'
import { Badge } from '@/components/ui/badge'
import { money, fmtDate } from '@/lib/format'
import { txTypeBadgeClass } from '@/lib/domain/transaction-helpers'
import type { Transaction, InvestmentType } from '@/types/database'

type TxRow = Transaction & {
  investment: {
    name: string
    ticker: string | null
    type: InvestmentType
  } | null
}

export default async function TransactionsPage() {
  const supabase = await createClient()

  const { data: transactions, error } = await supabase
    .from('transactions')
    .select('*, investment:investments(name, ticker, type)')
    .order('date', { ascending: false })
    .order('created_at', { ascending: false })
    .returns<TxRow[]>()

  return (
    <div className="space-y-6">
      <PageHeader
        title="Transactions"
        subtitle="Every buy, sell, deposit, withdrawal, and value update."
        action={
          <Link
            href="/transactions/new"
            className="inline-flex items-center justify-center rounded-lg bg-slate-900 px-4 py-2 text-sm font-medium text-white hover:bg-slate-800"
          >
            + Add transaction
          </Link>
        }
      />

      {error && (
        <div className="bg-white rounded-2xl border border-rose-200 p-6 text-sm text-rose-600">
          Could not load transactions: {error.message}
        </div>
      )}

      {!error && (!transactions || transactions.length === 0) && (
        <div className="bg-white rounded-2xl border border-slate-200 p-10 text-center">
          <p className="text-slate-900 font-medium">No transactions yet</p>
          <p className="text-sm text-slate-500 mt-1">
            Record your first buy, deposit, or value update to start building your history.
          </p>
          <Link
            href="/transactions/new"
            className="mt-4 inline-flex items-center justify-center rounded-lg bg-slate-900 px-4 py-2 text-sm font-medium text-white hover:bg-slate-800"
          >
            + Add transaction
          </Link>
        </div>
      )}

      {!error && transactions && transactions.length > 0 && (
        <div className="bg-white rounded-2xl border border-slate-200 overflow-hidden">
          {/* Desktop table */}
          <table className="hidden md:table w-full">
            <thead>
              <tr className="text-left text-xs uppercase tracking-wide text-slate-500 border-b border-slate-200">
                <th className="px-6 py-3 font-medium">Date</th>
                <th className="px-6 py-3 font-medium">Investment</th>
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
                    <div className="font-medium text-slate-900">
                      {tx.investment?.name ?? 'Unknown'}
                    </div>
                    {tx.investment?.ticker && (
                      <div className="text-xs text-slate-500">
                        {tx.investment.ticker}
                      </div>
                    )}
                  </td>
                  <td className="px-6 py-4">
                    <Badge className={txTypeBadgeClass(tx.type)}>
                      {tx.type}
                    </Badge>
                  </td>
                  <td className="px-6 py-4 text-right text-sm text-slate-700">
                    {tx.quantity !== null ? tx.quantity : '—'}
                  </td>
                  <td className="px-6 py-4 text-right text-sm text-slate-700">
                    {tx.price_per_unit !== null
                      ? money(tx.price_per_unit)
                      : '—'}
                  </td>
                  <td className="px-6 py-4 text-right text-sm text-slate-900">
                    {money(tx.amount)}
                  </td>
                  <td className="px-6 py-4 text-right text-sm text-slate-500">
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

          {/* Mobile cards */}
          <ul className="md:hidden divide-y divide-slate-100">
            {transactions.map((tx) => (
              <li key={tx.id}>
                <Link
                  href={`/transactions/${tx.id}/edit`}
                  className="block px-5 py-4 hover:bg-slate-50"
                >
                  <div className="flex items-center justify-between gap-3">
                    <div className="min-w-0">
                      <div className="font-medium text-slate-900 truncate">
                        {tx.investment?.name ?? 'Unknown'}
                      </div>
                      <div className="mt-1 flex items-center gap-2 text-xs text-slate-500">
                        <Badge className={txTypeBadgeClass(tx.type)}>
                          {tx.type}
                        </Badge>
                        <span>·</span>
                        <span>{fmtDate(tx.date)}</span>
                      </div>
                    </div>
                    <div className="text-right shrink-0">
                      <div className="text-sm text-slate-900">
                        {money(tx.amount)}
                      </div>
                      {tx.quantity !== null && tx.price_per_unit !== null && (
                        <div className="text-xs text-slate-500">
                          {tx.quantity} × {money(tx.price_per_unit)}
                        </div>
                      )}
                    </div>
                  </div>
                </Link>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  )
}