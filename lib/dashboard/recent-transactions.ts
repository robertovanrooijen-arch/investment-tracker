import type { Investment, InvestmentType, Transaction } from '@/types/database'

export type RecentTransaction = Transaction & {
  investment: {
    name: string
    ticker: string | null
    type: InvestmentType
  } | null
}

/**
 * Builds the dashboard list from the already-loaded account rows.
 *
 * Keeping this join in memory avoids a second PostgREST relationship query.
 * `transactions` has both a direct and an owner-safe foreign key to
 * `investments`, so an unqualified embedded select is ambiguous.
 */
export function buildRecentTransactions(
  transactions: Transaction[],
  investments: Pick<Investment, 'id' | 'name' | 'ticker' | 'type'>[],
  limit = 5
): RecentTransaction[] {
  const byId = new Map(investments.map((investment) => [investment.id, investment]))
  return [...transactions]
    .sort((a, b) =>
      b.date.localeCompare(a.date)
      || b.created_at.localeCompare(a.created_at)
      || b.id.localeCompare(a.id)
    )
    .slice(0, Math.max(0, limit))
    .map((transaction) => {
      const investment = byId.get(transaction.investment_id)
      return {
        ...transaction,
        investment: investment
          ? { name: investment.name, ticker: investment.ticker, type: investment.type }
          : null,
      }
    })
}
