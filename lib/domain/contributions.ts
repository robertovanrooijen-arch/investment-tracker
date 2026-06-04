import type { Transaction } from '@/types/database'

export type ContribRow = {
  id: string
  flow_date: string          // 'YYYY-MM-DD'
  monthKey: string           // 'YYYY-MM' — derived from flow_date, timezone-safe
  year: number
  platform: string
  direction: 'to_portfolio' | 'from_portfolio'
  amount_eur: number
  // 'ledger' = manual capital_flow_entries row
  // 'transaction' = derived from transactions table
  source: 'ledger' | 'transaction'
  notes: string | null
  created_at: string
}

type TxWithPlatform = Transaction & { investment: { platform: string } | null }

export function txToContribRow(tx: TxWithPlatform): ContribRow | null {
  const rate = tx.fx_rate_to_eur ?? 1

  let direction: ContribRow['direction']
  let amount_eur: number

  if (tx.type === 'buy') {
    direction = 'to_portfolio'
    amount_eur = (tx.quantity ?? 0) * (tx.price_per_unit ?? 0) * rate + tx.fee * rate
  } else if (tx.type === 'deposit') {
    direction = 'to_portfolio'
    amount_eur = (tx.amount ?? 0) * rate + tx.fee * rate
  } else if (tx.type === 'withdraw') {
    direction = 'from_portfolio'
    amount_eur = (tx.amount ?? 0) * rate
  } else {
    // sell, dividend, interest, fee, value update — never affect contributions
    return null
  }

  return {
    id: tx.id,
    flow_date: tx.date,
    monthKey: tx.date.slice(0, 7),
    year: Number(tx.date.slice(0, 4)),
    platform: tx.investment?.platform ?? 'Unknown',
    direction,
    amount_eur,
    source: 'transaction',
    notes: tx.notes,
    created_at: tx.created_at,
  }
}

export function getMonthKey(date: string): string {
  return date.slice(0, 7)
}
