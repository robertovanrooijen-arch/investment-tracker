import type { Investment, Transaction } from '@/types/database'
import { hasUnits } from '@/lib/domain/constants'
import type { FxRates } from '@/lib/domain/fx'
import { txFeeInEur, txPriceRateToEur } from '@/lib/domain/calculations'
import { allocateSale } from '@/lib/domain/cost-basis'
import { tradeGrossNative } from '@/lib/domain/trade-amounts'

export type ChartPoint = {
  date: string
  // null only when no snapshot AND no price estimate is available for that date
  value_eur: number | null
  cost_basis_eur: number
  unrealized_profit_eur: number | null  // null when value_eur is null
}

// ---------- Internal FX helpers ----------
// Delegates to the shared FX policy in calculations.ts (historical row rate,
// no live rate for imported rows, NaN instead of a silent 1 when missing).

function rateToEur(tx: Transaction, fxRates?: FxRates): number {
  return txPriceRateToEur(tx, fxRates).rate ?? NaN
}

function feeInEur(tx: Transaction, fxRates?: FxRates): number {
  return txFeeInEur(tx, fxRates)
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
 * Value priority per date:
 *   1. today        → currentMetrics.currentValue (matches top-card exactly)
 *   2. has buy/sell → sharesHeld × transaction price (post-tx position visible)
 *   3. has snapshot → snapshot.value_eur (end-of-day market value from cron)
 *   4. carry-fwd    → sharesHeld × last known price (unit asset only)
 *   5. null         → no usable price
 * Cost basis: walked from transactions (avg-cost method, same as calculations.ts).
 * Nothing is written to the database. Display-only.
 *
 * `transactions` is filtered to this investment's own id internally — a
 * caller that accidentally passes a whole portfolio's transactions (instead
 * of pre-scoping them) gets a correct single-investment timeline rather
 * than every other holding's buys replayed into this one's share count and
 * cost basis (a real bug this guard was added to make impossible, not just
 * documented).
 */
export function buildInvestmentChartTimeline(
  investment: Investment,
  transactions: Transaction[],
  snapshots: Array<{ date: string; value_eur: number; quantity?: number | null }>,
  currentMetrics: { currentValue: number; remainingCostBasis: number; unrealizedProfit: number },
  todayIso: string,
  fxRates?: FxRates,
): ChartPoint[] {
  const isUnit = hasUnits(investment.type)
  const ownTransactions = transactions.filter((t) => t.investment_id === investment.id)
  const snapshotMap = new Map(snapshots.map((s) => [s.date, s]))

  const allDates = [
    ...new Set([...snapshotMap.keys(), ...ownTransactions.map((t) => t.date), todayIso]),
  ].sort()

  const sortedTxs = sortChron(ownTransactions)
  let txIdx = 0
  let sharesHeld = 0
  let costBasisEur = 0
  // Tracks the most-recent buy/sell price (EUR per unit) seen so far.
  // Used to estimate value on transaction-only dates that have no snapshot.
  // Priority for value: (1) snapshot, (2) quantity × last known price, (3) null.
  let lastPriceEurPerUnit = 0

  const points: ChartPoint[] = []

  for (const date of allDates) {
    // txPriceEurPerUnit: set when a buy/sell with a price is processed for this
    // exact date. Used to override snapshot value so the chart reflects the
    // post-transaction position (post-buy quantity × buy price) rather than the
    // end-of-day snapshot price, which may differ due to intraday price movement.
    let txPriceEurPerUnit: number | null = null

    // Apply every transaction whose date ≤ this chart date (in chronological order).
    // Because allDates includes every transaction date, all transactions from
    // earlier dates have already been consumed; this loop processes only the
    // transactions for exactly `date`.
    while (txIdx < sortedTxs.length && sortedTxs[txIdx].date <= date) {
      const tx = sortedTxs[txIdx]
      const rate = rateToEur(tx, fxRates)

      if (isUnit) {
        if (tx.type === 'buy' && tx.quantity != null && tx.price_per_unit != null) {
          // grossEur + feeEur — mirrors calculations.ts exactly (exact broker amount)
          costBasisEur += tradeGrossNative(tx) * rate + feeInEur(tx, fxRates)
          sharesHeld += tx.quantity
          const p = tx.price_per_unit * rate
          lastPriceEurPerUnit = p
          txPriceEurPerUnit = p   // record that this date has a transaction price
        } else if (tx.type === 'sell' && tx.quantity != null && sharesHeld > 0) {
          // Same cost-basis rules as calculations.ts (cost-basis.ts).
          const sale = allocateSale(sharesHeld, costBasisEur, costBasisEur, tx.quantity)
          if (sale) {
            costBasisEur -= sale.soldCostEur
            sharesHeld -= sale.quantity
            if (sale.closesPosition) {
              sharesHeld = 0
              costBasisEur = 0
            }
          }
          if (tx.price_per_unit != null) {
            const p = tx.price_per_unit * rate
            lastPriceEurPerUnit = p
            txPriceEurPerUnit = p
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

    // Historical value priority:
    // 1. Transaction date (buy/sell): post-transaction quantity × transaction price.
    //    Snapshot is skipped so the buy/sell effect is visible on that date.
    // 2. Snapshot exists AND quantity matches walked sharesHeld: authoritative
    //    end-of-day market value from the cron.
    //    If the snapshot's stored quantity differs from sharesHeld by more than
    //    0.1%, the snapshot pre-dates a backfilled transaction and is stale —
    //    fall through to carry-forward instead of showing a false drop.
    // 3. Carry forward: unit asset with known price but no (valid) snapshot.
    // 4. null: no usable price data.
    let valueEur: number | null

    if (isUnit && txPriceEurPerUnit !== null && sharesHeld > 0) {
      valueEur = sharesHeld * txPriceEurPerUnit
    } else if (snapshotMap.has(date)) {
      const snap = snapshotMap.get(date)!
      const stale =
        isUnit &&
        snap.quantity != null &&
        sharesHeld > 0 &&
        Math.abs(snap.quantity - sharesHeld) > sharesHeld * 0.001
      if (!stale) {
        valueEur = snap.value_eur
      } else if (sharesHeld > 0 && lastPriceEurPerUnit > 0) {
        valueEur = sharesHeld * lastPriceEurPerUnit
      } else {
        valueEur = null
      }
    } else if (isUnit && sharesHeld > 0 && lastPriceEurPerUnit > 0) {
      valueEur = sharesHeld * lastPriceEurPerUnit
    } else {
      valueEur = null
    }

    points.push({
      date,
      value_eur: valueEur,
      cost_basis_eur: costBasisEur,
      unrealized_profit_eur: valueEur !== null ? valueEur - costBasisEur : null,
    })
  }

  return points
}
