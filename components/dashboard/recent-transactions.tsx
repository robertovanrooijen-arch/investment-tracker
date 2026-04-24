import Link from 'next/link'
import { Badge } from '@/components/ui/badge'
import { money, fmtDate } from '@/lib/format'
import { txTypeBadgeClass } from '@/lib/domain/transaction-helpers'
import type { Transaction, InvestmentType } from '@/types/database'

type Row = Transaction & {
  investment: {
    name: string
    ticker: string | null
    type: InvestmentType
  } | null
}

type RecentTransactionsProps = {
  transactions: Row[]
}

export function RecentTransactions({ transactions }: RecentTransactionsProps) {
  return (
    <div className="bg-white rounded-2xl border border-slate-200 overflow-hidden">
      <div className="flex items-center justify-between px-5 md:px-6 py-4 border-b border-slate-100">
        <h2 className="text-base font-semibold text-slate-900">
          Recent transactions
        </h2>
        <Link
          href="/transactions"
          className="text-sm text-slate-600 hover:text-slate-900"
        >
          View all
        </Link>
      </div>
      {transactions.length === 0 ? (
        <div className="p-6 text-sm text-slate-500">No transactions yet.</div>
      ) : (
        <ul className="divide-y divide-slate-100">
          {transactions.map((tx) => (
            <li key={tx.id}>
              <Link
                href={`/transactions/${tx.id}/edit`}
                className="flex items-center justify-between gap-3 px-5 md:px-6 py-4 hover:bg-slate-50"
              >
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
                <div className="text-right shrink-0 text-sm text-slate-900 tabular-nums">
                  {money(tx.amount)}
                </div>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}