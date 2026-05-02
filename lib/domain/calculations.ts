import type { Investment, Transaction } from '@/types/database'
import { hasUnits } from '@/lib/domain/constants'
import type { FxRates } from '@/lib/domain/fx'

// ---------- Sorting ----------

function sortChronologically(txs: Transaction[]): Transaction[] {
  return [...txs].sort((a, b) => {
    if (a.date !== b.date) return a.date < b.date ? -1 : 1
    return a.created_at < b.created_at ? -1 : 1
  })
}

// ---------- FX helper ----------

function fxRateFor(investment: Investment, fxRates?: FxRates): number {
  if (!fxRates) return 1
  const currency = investment.currency ?? 'EUR'
  return fxRates[currency] ?? 1
}

function applyFx(m: InvestmentMetrics, rate: number): InvestmentMetrics {
  if (rate === 1) return m

  return {
    quantity: m.quantity,
    currentValue: m.currentValue * rate,
    remainingCostBasis: m.remainingCostBasis * rate,
    realizedProfit: m.realizedProfit * rate,
    unrealizedProfit: m.unrealizedProfit * rate,
    totalProfit: m.totalProfit * rate,
    totalEverInvested: m.totalEverInvested * rate,
    totalProfitPct: m.totalProfitPct,
    isClosed: m.isClosed,
    hasActivity: m.hasActivity,
    averageBuyPrice:
      m.averageBuyPrice !== null ? m.averageBuyPrice * rate : null,
  }
}

// ---------- Per-investment metrics ----------

export type InvestmentMetrics = {
  quantity: number | null
  currentValue: number
  remainingCostBasis: number
  realizedProfit: number
  unrealizedProfit: number
  totalProfit: number
  totalEverInvested: number
  totalProfitPct: number | null
  isClosed: boolean
  hasActivity: boolean
  averageBuyPrice: number | null
}

export function computeInvestmentMetrics(
  investment: Investment,
  transactions: Transaction[],
  fxRates?: FxRates
): InvestmentMetrics {
  const txs = sortChronologically(
    transactions.filter((t) => t.investment_id === investment.id)
  )
  const hasActivity = txs.length > 0

  if (hasUnits(investment.type)) {
    let sharesHeld = 0
    let costBasisHeld = 0
    let realizedProfit = 0
    let totalEverInvested = 0

    for (const tx of txs) {
      if (
        tx.type === 'buy' &&
        tx.quantity !== null &&
        tx.price_per_unit !== null
      ) {
        const cost = tx.quantity * tx.price_per_unit + (tx.fee ?? 0)
        sharesHeld += tx.quantity
        costBasisHeld += cost
        totalEverInvested += cost
      } else if (
        tx.type === 'sell' &&
        tx.quantity !== null &&
        tx.price_per_unit !== null
      ) {
        const sellQty = Math.min(tx.quantity, sharesHeld)

        if (sharesHeld > 0 && sellQty > 0) {
          const avgCost = costBasisHeld / sharesHeld
          const soldCost = avgCost * sellQty
          const proceeds = sellQty * tx.price_per_unit - (tx.fee ?? 0)

          realizedProfit += proceeds - soldCost
          costBasisHeld -= soldCost
          sharesHeld -= sellQty
        }
      }
    }

    const price = investment.current_price ?? 0
    const currentValue = sharesHeld > 0 ? sharesHeld * price : 0
    const unrealizedProfit = sharesHeld > 0 ? currentValue - costBasisHeld : 0
    const totalProfit = realizedProfit + unrealizedProfit
    const totalProfitPct =
      totalEverInvested > 0 ? totalProfit / totalEverInvested : null
    const isClosed = hasActivity && sharesHeld <= 0
    const averageBuyPrice = sharesHeld > 0 ? costBasisHeld / sharesHeld : null

    const native: InvestmentMetrics = {
      quantity: sharesHeld,
      currentValue,
      remainingCostBasis: costBasisHeld,
      realizedProfit,
      unrealizedProfit,
      totalProfit,
      totalEverInvested,
      totalProfitPct,
      isClosed,
      hasActivity,
      averageBuyPrice,
    }

    return applyFx(native, fxRateFor(investment, fxRates))
  }

  // Non-unit types: cash / real estate / custom
  let invested = 0
  let totalEverInvested = 0

  for (const tx of txs) {
    if (tx.type === 'deposit') {
      const amt = (tx.amount ?? 0) + (tx.fee ?? 0)
      invested += amt
      totalEverInvested += amt
    } else if (tx.type === 'withdraw') {
      invested -= (tx.amount ?? 0) - (tx.fee ?? 0)
    }
  }

  const currentValue = investment.current_value ?? 0
  const unrealizedProfit = currentValue - invested
  const totalProfit = unrealizedProfit
  const totalProfitPct =
    totalEverInvested > 0 ? totalProfit / totalEverInvested : null

  const native: InvestmentMetrics = {
    quantity: null,
    currentValue,
    remainingCostBasis: invested,
    realizedProfit: 0,
    unrealizedProfit,
    totalProfit,
    totalEverInvested,
    totalProfitPct,
    isClosed: false,
    hasActivity,
    averageBuyPrice: null,
  }

  return applyFx(native, fxRateFor(investment, fxRates))
}

// ---------- Portfolio-wide metrics ----------

export type PortfolioMetrics = {
  totalValue: number
  totalInvested: number
  totalRealized: number
  totalUnrealized: number
  totalProfit: number
  totalEverInvested: number
  totalProfitPct: number | null
}

export function computePortfolioMetrics(
  investments: Investment[],
  transactions: Transaction[],
  fxRates?: FxRates
): PortfolioMetrics {
  let totalValue = 0
  let totalInvested = 0
  let totalRealized = 0
  let totalUnrealized = 0
  let totalEverInvested = 0

  for (const inv of investments) {
    const m = computeInvestmentMetrics(inv, transactions, fxRates)
    totalValue += m.currentValue
    totalInvested += m.remainingCostBasis
    totalRealized += m.realizedProfit
    totalUnrealized += m.unrealizedProfit
    totalEverInvested += m.totalEverInvested
  }

  const totalProfit = totalRealized + totalUnrealized
  const totalProfitPct =
    totalEverInvested > 0 ? totalProfit / totalEverInvested : null

  return {
    totalValue,
    totalInvested,
    totalRealized,
    totalUnrealized,
    totalProfit,
    totalEverInvested,
    totalProfitPct,
  }
}

// ---------- Allocation ----------

export type AllocationSlice = {
  key: string
  value: number
  pct: number
}

export function computeAllocation(
  investments: Investment[],
  transactions: Transaction[],
  keyFn: (inv: Investment) => string,
  fxRates?: FxRates
): AllocationSlice[] {
  const buckets = new Map<string, number>()
  let total = 0

  for (const inv of investments) {
    const { currentValue } = computeInvestmentMetrics(
      inv,
      transactions,
      fxRates
    )

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

// ---------- Form validation helper ----------

export function heldQuantity(
  investmentId: string,
  transactions: Transaction[],
  excludeTxId?: string
): number {
  let held = 0

  for (const tx of transactions) {
    if (tx.investment_id !== investmentId) continue
    if (excludeTxId && tx.id === excludeTxId) continue

    if (tx.type === 'buy' && tx.quantity !== null) {
      held += tx.quantity
    } else if (tx.type === 'sell' && tx.quantity !== null) {
      held -= tx.quantity
    }
  }

  return held
}

// ---------- Formatting ----------

export function pct(n: number | null | undefined, digits = 2): string {
  if (n === null || n === undefined || Number.isNaN(n)) return '—'
  return `${(n * 100).toFixed(digits)}%`
}