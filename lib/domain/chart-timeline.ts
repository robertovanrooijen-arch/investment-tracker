import type { Investment, Transaction } from '@/types/database'
import { hasUnits } from '@/lib/domain/constants'
import type { FxRates } from '@/lib/domain/fx'

export type ChartPoint = {
  date: string
  value_eur: number | null        // null on transaction-only dates (no snapshot)
  cost_basis_eur: number
  unrealized_profit_eur: number | null  // null when value_eur is null
}

// ---------- Internal FX helpers ----------
// Mirrors the logic in calculations.ts without touching that module.

function rateToEur(tx: Transaction, fxRates?: FxRates): number {
  const ccy = tx.price_currency ?? 'EUR'
  if (ccy === 'EUR') return 1
  if (tx.fx_rate_to_eur != null) return tx.fx_rate_to_eur
  return fxRates?.[ccy] ?? 1
}

function feeInEur(tx: Transaction, fxRates?: FxRates): number {
  const fee = tx.fee ?? 0
  if (fee === 0) return 0
  const feeCcy = tx.fee_currency ?? tx.price_currency ?? 'EUR'
  if (feeCcy === 'EUR') return fee
  const priceCcy = tx.price_currency ?? 'EUR'
  if (feeCcy === priceCcy) return fee * rateToEur(tx, fxRates)
  return fee * (fxRates?.[feeCcy] ?? 1)
}

function sortChron(txs: Transaction[]): Transaction[] {
  return [...txs].sort((a, b) => {
    if (a.date !== b.date) return a.date < b.date ? -1 : 1
    return a.created_at < b.created_at ? -1 : 1
  })
}

// ---------- Timeline builder ----------

/**
 * Builds a display-only chart timeline for a single investment.
 *
 * Dates included: all snapshot dates + all transaction dates + today.
 * Value: snapshot value for historical dates with a snapshot, null otherwise,
 *        live currentMetrics.currentValue for today.
 * Cost basis: walked from transactions using the same avg-cost method as
 *             computeInvestmentMetrics. Overridden by currentMetrics for today.
 * Unrealized P/L: value_eur − cost_basis_eur (null when value_eur is null).
 *
 * Nothing is written to the database. Display-only.
 */
export function buildInvestmentChartTimeline(
  investment: Investment,
  transactions: Transaction[],
  snapshots: Array<{ date: string; value_eur: number }>,
  currentMetrics: { currentValue: number; remainingCostBasis: number; unrealizedProfit: number },
  todayIso: string,
  fxRates?: FxRates,
): ChartPoint[] {
  const isUnit = hasUnits(investment.type)
  const snapshotMap = new Map(snapshots.map((s) => [s.date, s.value_eur]))

  const allDates = [
    ...new Set([...snapshotMap.keys(), ...transactions.map((t) => t.date), todayIso]),
  ].sort()

  const sortedTxs = sortChron(transactions)
  let txIdx = 0
  let sharesHeld = 0
  let costBasisEur = 0

  const points: ChartPoint[] = []

  for (const date of allDates) {
    // Apply every transaction whose date ≤ this chart date (in chronological order).
    while (txIdx < sortedTxs.length && sortedTxs[txIdx].date <= date) {
      const tx = sortedTxs[txIdx]
      const rate = rateToEur(tx, fxRates)

      if (isUnit) {
        if (tx.type === 'buy' && tx.quantity != null && tx.price_per_unit != null) {
          // grossEur + feeEur — mirrors calculations.ts exactly
          costBasisEur += tx.quantity * tx.price_per_unit * rate + feeInEur(tx, fxRates)
          sharesHeld += tx.quantity
        } else if (tx.type === 'sell' && tx.quantity != null && sharesHeld > 0) {
          const sellQty = Math.min(tx.quantity, sharesHeld)
          if (sellQty > 0) {
            // Reduce cost basis by avg cost × sold qty (FIFO avg-cost)
            costBasisEur -= (costBasisEur / sharesHeld) * sellQty
            sharesHeld -= sellQty
          }
        }
      } else {
        // Non-unit (cash, real estate, custom): deposits/withdrawals drive cost basis
        if (tx.type === 'deposit') {
          costBasisEur += (tx.amount ?? 0) * rate + feeInEur(tx, fxRates)
        } else if (tx.type === 'withdraw') {
          costBasisEur -= (tx.amount ?? 0) * rate - feeInEur(tx, fxRates)
        }
      }

      txIdx++
    }

    // Today: always use the authoritative live-computed metrics.
    if (date === todayIso) {
      const valueEur = currentMetrics.currentValue
      const cb = currentMetrics.remainingCostBasis
      points.push({
        date,
        value_eur: valueEur,
        cost_basis_eur: cb,
        unrealized_profit_eur: valueEur - cb,
      })
      continue
    }

    // Historical date: snapshot value if available, else null.
    const valueEur = snapshotMap.get(date) ?? null
    points.push({
      date,
      value_eur: valueEur,
      cost_basis_eur: costBasisEur,
      unrealized_profit_eur: valueEur !== null ? valueEur - costBasisEur : null,
    })
  }

  return points
}
