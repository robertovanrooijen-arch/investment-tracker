import type { Investment, Transaction } from '@/types/database'
import { hasUnits } from '@/lib/domain/constants'

// How one transaction contributes to "total invested" (net cost basis).
// - buys + deposits + fees INCREASE what you've put in
// - sells + withdraws (minus their fees) DECREASE what you've put in
// - value updates do not change what you've invested — they only affect value
export function transactionInvestedImpact(tx: Transaction): number {
  const amount = tx.amount ?? 0
  const fee = tx.fee ?? 0
  switch (tx.type) {
    case 'buy':
    case 'deposit':
      return amount + fee
    case 'sell':
    case 'withdraw':
      return -(amount - fee)
    case 'value update':
      return 0
  }
}

// Net units held (stock/ETF/crypto only).
export function netQuantity(
  investment: Investment,
  transactions: Transaction[]
): number {
  if (!hasUnits(investment.type)) return 0
  let qty = 0
  for (const tx of transactions) {
    if (tx.investment_id !== investment.id) continue
    if (tx.type === 'buy' && tx.quantity !== null) qty += tx.quantity
    else if (tx.type === 'sell' && tx.quantity !== null) qty -= tx.quantity
  }
  return qty
}

export type InvestmentMetrics = {
  currentValue: number
  invested: number
  profit: number
  profitPct: number | null // null when invested is 0
  quantity: number | null  // null for non-unit types
}

export function computeInvestmentMetrics(
  investment: Investment,
  transactions: Transaction[]
): InvestmentMetrics {
  const txForThis = transactions.filter(
    (t) => t.investment_id === investment.id
  )

  const invested = txForThis.reduce(
    (sum, t) => sum + transactionInvestedImpact(t),
    0
  )

  let currentValue = 0
  let quantity: number | null = null

  if (hasUnits(investment.type)) {
    quantity = netQuantity(investment, txForThis)
    const price = investment.current_price ?? 0
    if (quantity > 0 && price > 0) {
      currentValue = quantity * price
    } else {
      // No units yet (or no price): fall back to the manual current_value.
      currentValue = investment.current_value ?? 0
    }
  } else {
    // Cash / real estate / custom: the stored value is the source of truth.
    currentValue = investment.current_value ?? 0
  }

  const profit = currentValue - invested
  const profitPct = invested !== 0 ? profit / invested : null

  return { currentValue, invested, profit, profitPct, quantity }
}

export type PortfolioMetrics = {
  totalValue: number
  totalInvested: number
  totalProfit: number
  totalProfitPct: number | null
}

export function computePortfolioMetrics(
  investments: Investment[],
  transactions: Transaction[]
): PortfolioMetrics {
  let totalValue = 0
  let totalInvested = 0

  for (const inv of investments) {
    const m = computeInvestmentMetrics(inv, transactions)
    totalValue += m.currentValue
    totalInvested += m.invested
  }

  const totalProfit = totalValue - totalInvested
  const totalProfitPct =
    totalInvested !== 0 ? totalProfit / totalInvested : null

  return { totalValue, totalInvested, totalProfit, totalProfitPct }
}

export type AllocationSlice = {
  key: string
  value: number
  pct: number // 0 — 1
}

// Groups investments by a key (category or platform), returns sorted slices.
export function computeAllocation(
  investments: Investment[],
  transactions: Transaction[],
  keyFn: (inv: Investment) => string
): AllocationSlice[] {
  const buckets = new Map<string, number>()
  let total = 0

  for (const inv of investments) {
    const { currentValue } = computeInvestmentMetrics(inv, transactions)
    if (currentValue <= 0) continue
    const k = keyFn(inv)
    buckets.set(k, (buckets.get(k) ?? 0) + currentValue)
    total += currentValue
  }

  const slices: AllocationSlice[] = []
  for (const [key, value] of buckets) {
    slices.push({ key, value, pct: total > 0 ? value / total : 0 })
  }
  slices.sort((a, b) => b.value - a.value)
  return slices
}

export function pct(n: number | null | undefined, digits = 2): string {
  if (n === null || n === undefined || Number.isNaN(n)) return '—'
  return `${(n * 100).toFixed(digits)}%`
}