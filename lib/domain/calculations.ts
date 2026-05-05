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

// ---------- Per-transaction currency helpers (internal) ----------

/**
 * Convert a transaction's fee to EUR.
 *  - fee_currency = 'EUR'                → return fee directly.
 *  - fee_currency = price_currency      → use the row's fx_rate_to_eur snapshot.
 *  - other / NULL                        → fall back to the live rate.
 */
function txFeeInEur(tx: Transaction, fxRates?: FxRates): number {
  const feeAmount = tx.fee ?? 0
  if (feeAmount === 0) return 0

  const feeCurrency = tx.fee_currency ?? tx.price_currency ?? 'EUR'
  if (feeCurrency === 'EUR') return feeAmount

  const priceCurrency = tx.price_currency ?? 'EUR'
  if (feeCurrency === priceCurrency && tx.fx_rate_to_eur != null) {
    return feeAmount * tx.fx_rate_to_eur
  }

  const liveRate = fxRates?.[feeCurrency]
  if (liveRate != null && Number.isFinite(liveRate)) {
    return feeAmount * liveRate
  }

  // Best-effort fallback when no rate is known.
  return feeAmount
}

/**
 * Convert a transaction's fee to its price_currency, so it can be added to
 * native cost basis math. Goes via EUR when fee_currency != price_currency.
 */
function txFeeInPriceCurrency(tx: Transaction, fxRates?: FxRates): number {
  const feeAmount = tx.fee ?? 0
  if (feeAmount === 0) return 0

  const feeCurrency = tx.fee_currency ?? tx.price_currency ?? 'EUR'
  const priceCurrency = tx.price_currency ?? 'EUR'

  if (feeCurrency === priceCurrency) return feeAmount

  const feeEur = txFeeInEur(tx, fxRates)
  if (priceCurrency === 'EUR') return feeEur

  const priceToEur = tx.fx_rate_to_eur ?? fxRates?.[priceCurrency] ?? 1
  if (priceToEur === 0) return 0
  return feeEur / priceToEur
}

/**
 * Convert a native (price_currency) amount to EUR using the row's snapshot
 * rate if available, else the live rate.
 */
function txNativeToEur(
  amountNative: number,
  tx: Transaction,
  fxRates?: FxRates
): number {
  const priceCurrency = tx.price_currency ?? 'EUR'
  if (priceCurrency === 'EUR') return amountNative

  const rate = tx.fx_rate_to_eur ?? fxRates?.[priceCurrency] ?? 1
  return amountNative * rate
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
  const priceCurrency = investment.currency ?? 'EUR'
  const wantEur = !!fxRates

  if (hasUnits(investment.type)) {
    let sharesHeld = 0
    let costBasisNative = 0
    let costBasisEur = 0
    let realizedNative = 0
    let realizedEur = 0
    let totalEverInvestedNative = 0
    let totalEverInvestedEur = 0

    for (const tx of txs) {
      if (
        tx.type === 'buy' &&
        tx.quantity !== null &&
        tx.price_per_unit !== null
      ) {
        const grossNative = tx.quantity * tx.price_per_unit
        const feeNative = txFeeInPriceCurrency(tx, fxRates)
        const costNative = grossNative + feeNative

        const grossEur = txNativeToEur(grossNative, tx, fxRates)
        const feeEur = txFeeInEur(tx, fxRates)
        const costEur = grossEur + feeEur

        sharesHeld += tx.quantity
        costBasisNative += costNative
        costBasisEur += costEur
        totalEverInvestedNative += costNative
        totalEverInvestedEur += costEur
      } else if (
        tx.type === 'sell' &&
        tx.quantity !== null &&
        tx.price_per_unit !== null
      ) {
        const sellQty = Math.min(tx.quantity, sharesHeld)
        if (sharesHeld > 0 && sellQty > 0) {
          const avgCostNative = costBasisNative / sharesHeld
          const avgCostEur = costBasisEur / sharesHeld
          const soldCostNative = avgCostNative * sellQty
          const soldCostEur = avgCostEur * sellQty

          const grossNative = sellQty * tx.price_per_unit
          const feeNative = txFeeInPriceCurrency(tx, fxRates)
          const proceedsNative = grossNative - feeNative

          const grossEur = txNativeToEur(grossNative, tx, fxRates)
          const feeEur = txFeeInEur(tx, fxRates)
          const proceedsEur = grossEur - feeEur

          realizedNative += proceedsNative - soldCostNative
          realizedEur += proceedsEur - soldCostEur
          costBasisNative -= soldCostNative
          costBasisEur -= soldCostEur
          sharesHeld -= sellQty
        }
      }
    }

    const priceNative = investment.current_price ?? 0
    const currentValueNative = sharesHeld > 0 ? sharesHeld * priceNative : 0
    const currentRateToEur = fxRates?.[priceCurrency] ?? 1
    const currentValueEur = currentValueNative * currentRateToEur

    const unrealizedNative =
      sharesHeld > 0 ? currentValueNative - costBasisNative : 0
    const unrealizedEur = sharesHeld > 0 ? currentValueEur - costBasisEur : 0

    const totalProfitNative = realizedNative + unrealizedNative
    const totalProfitEur = realizedEur + unrealizedEur

    const totalProfitPctNative =
      totalEverInvestedNative > 0
        ? totalProfitNative / totalEverInvestedNative
        : null
    const totalProfitPctEur =
      totalEverInvestedEur > 0 ? totalProfitEur / totalEverInvestedEur : null

    const isClosed = hasActivity && sharesHeld <= 0
    const averageBuyPriceNative =
      sharesHeld > 0 ? costBasisNative / sharesHeld : null
    const averageBuyPriceEur =
      sharesHeld > 0 ? costBasisEur / sharesHeld : null

    if (wantEur) {
      return {
        quantity: sharesHeld,
        currentValue: currentValueEur,
        remainingCostBasis: costBasisEur,
        realizedProfit: realizedEur,
        unrealizedProfit: unrealizedEur,
        totalProfit: totalProfitEur,
        totalEverInvested: totalEverInvestedEur,
        totalProfitPct: totalProfitPctEur,
        isClosed,
        hasActivity,
        averageBuyPrice: averageBuyPriceEur,
      }
    }

    return {
      quantity: sharesHeld,
      currentValue: currentValueNative,
      remainingCostBasis: costBasisNative,
      realizedProfit: realizedNative,
      unrealizedProfit: unrealizedNative,
      totalProfit: totalProfitNative,
      totalEverInvested: totalEverInvestedNative,
      totalProfitPct: totalProfitPctNative,
      isClosed,
      hasActivity,
      averageBuyPrice: averageBuyPriceNative,
    }
  }

  // Non-unit types: cash / real estate / custom
  let investedNative = 0
  let investedEur = 0
  let totalEverInvestedNative = 0
  let totalEverInvestedEur = 0

  for (const tx of txs) {
    if (tx.type === 'deposit') {
      const amtNative = (tx.amount ?? 0) + txFeeInPriceCurrency(tx, fxRates)
      const amtEur =
        txNativeToEur(tx.amount ?? 0, tx, fxRates) + txFeeInEur(tx, fxRates)
      investedNative += amtNative
      investedEur += amtEur
      totalEverInvestedNative += amtNative
      totalEverInvestedEur += amtEur
    } else if (tx.type === 'withdraw') {
      const amtNative = (tx.amount ?? 0) - txFeeInPriceCurrency(tx, fxRates)
      const amtEur =
        txNativeToEur(tx.amount ?? 0, tx, fxRates) - txFeeInEur(tx, fxRates)
      investedNative -= amtNative
      investedEur -= amtEur
    }
  }

  const currentValueNative = investment.current_value ?? 0
  const currentRateToEur = fxRates?.[priceCurrency] ?? 1
  const currentValueEur = currentValueNative * currentRateToEur

  const unrealizedNative = currentValueNative - investedNative
  const unrealizedEur = currentValueEur - investedEur

  const totalProfitPctNative =
    totalEverInvestedNative > 0
      ? unrealizedNative / totalEverInvestedNative
      : null
  const totalProfitPctEur =
    totalEverInvestedEur > 0 ? unrealizedEur / totalEverInvestedEur : null

  if (wantEur) {
    return {
      quantity: null,
      currentValue: currentValueEur,
      remainingCostBasis: investedEur,
      realizedProfit: 0,
      unrealizedProfit: unrealizedEur,
      totalProfit: unrealizedEur,
      totalEverInvested: totalEverInvestedEur,
      totalProfitPct: totalProfitPctEur,
      isClosed: false,
      hasActivity,
      averageBuyPrice: null,
    }
  }

  return {
    quantity: null,
    currentValue: currentValueNative,
    remainingCostBasis: investedNative,
    realizedProfit: 0,
    unrealizedProfit: unrealizedNative,
    totalProfit: unrealizedNative,
    totalEverInvested: totalEverInvestedNative,
    totalProfitPct: totalProfitPctNative,
    isClosed: false,
    hasActivity,
    averageBuyPrice: null,
  }
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

// ---------- Per-transaction display helpers ----------

/**
 * EUR-equivalent total cash impact for a single transaction. Used by the
 * global transactions list so every row displays a consistent EUR column.
 *
 *  - For unit-priced txs: q × price ± fee (sell subtracts fee, buy adds it),
 *    each component converted to EUR using the row's snapshot rate.
 *  - For amount-based txs: tx.amount converted to EUR (fee shown separately).
 */
export function txAmountInEur(
  tx: Transaction,
  fxRates?: FxRates
): number {
  if (tx.quantity != null && tx.price_per_unit != null) {
    const grossNative = tx.quantity * tx.price_per_unit
    const grossEur = txNativeToEur(grossNative, tx, fxRates)
    const feeEur = txFeeInEur(tx, fxRates)
    if (tx.type === 'sell') return grossEur - feeEur
    return grossEur + feeEur
  }
  return txNativeToEur(tx.amount ?? 0, tx, fxRates)
}

/**
 * Same as txAmountInEur but in the transaction's price_currency. Used by
 * the investment detail page where the page-level context is single-currency.
 */
export function txAmountInPriceCurrency(
  tx: Transaction,
  fxRates?: FxRates
): number {
  if (tx.quantity != null && tx.price_per_unit != null) {
    const grossNative = tx.quantity * tx.price_per_unit
    const feeNative = txFeeInPriceCurrency(tx, fxRates)
    if (tx.type === 'sell') return grossNative - feeNative
    return grossNative + feeNative
  }
  return tx.amount ?? 0
}

// ---------- Formatting ----------

export function pct(n: number | null | undefined, digits = 2): string {
  if (n === null || n === undefined || Number.isNaN(n)) return '—'
  return `${(n * 100).toFixed(digits)}%`
}