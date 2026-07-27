import type { Investment, Transaction, InvestmentType, CapitalFlowDirection } from '@/types/database'
import { hasUnits, isCashLikeInvestment } from '@/lib/domain/constants'
export { isCashLikeInvestment }
import type { FxRates } from '@/lib/domain/fx'
import {
  computeInvestmentMetrics,
  computePortfolioMetrics,
  txAmountInEur,
  txFeeInEur,
  txFeeInPriceCurrency,
} from '@/lib/domain/calculations'
import type { PortfolioMetrics } from '@/lib/domain/calculations'
import { txToContribRow } from '@/lib/domain/contributions'
import { money } from '@/lib/format'

// ---------------------------------------------------------------------------
// This module is intentionally isolated from calculations.ts: it re-slices
// the same average-cost-basis transaction replay by "did this happen inside
// year Y" vs. "state as of year Y's end", instead of extending the
// general-purpose portfolio calculators (which only ever know "now"). Do not
// merge this back in unless calculations.ts grows year-awareness for
// everyone, not just this page.
//
// Two correctness rules this module exists to enforce:
//  1. Cash-like holdings (type 'cash', or a free-cash-balance name) never get
//     an unrealized/total P&L number — for these, currentValue - costBasis(0)
//     is not profit, it's just the balance. See isCashLikeInvestment.
//  2. A past year's "closing state" (quantity, cost basis, avg price) is
//     computed only from transactions dated on/before that year's end — never
//     from transactions that happened in a later year. Only the *valuation*
//     (current price) is necessarily "today's", since there's no historical
//     price feed; that limitation is surfaced to the UI via
//     YearPortfolioSummary.valuationIsApproximate rather than hidden.
// ---------------------------------------------------------------------------

function sortChronologically(txs: Transaction[]): Transaction[] {
  return [...txs].sort((a, b) => {
    if (a.date !== b.date) return a.date < b.date ? -1 : 1
    return a.created_at < b.created_at ? -1 : 1
  })
}

function inYear(date: string, year: number): boolean {
  return date >= `${year}-01-01` && date <= `${year}-12-31`
}

function todayIso(): string {
  return new Date().toISOString().slice(0, 10)
}

/**
 * Returns numerator/denominator as a percentage, or null when the
 * denominator is missing, zero, or otherwise unreliable — never a fake
 * percentage from a near-zero denominator.
 */
function safePercent(numerator: number | null, denominator: number | null): number | null {
  if (numerator === null || denominator === null) return null
  if (!Number.isFinite(denominator) || Math.abs(denominator) < 0.01) return null
  return (numerator / denominator) * 100
}

/**
 * The last date whose transactions should count toward a year's "closing
 * state" — year-end for a past year, today for the current (or a future)
 * year. Transactions dated after this never happened yet, from this report's
 * point of view.
 */
function closingCutoffDate(year: number): string {
  const currentYear = new Date().getFullYear()
  if (year >= currentYear) return todayIso()
  return `${year}-12-31`
}

/**
 * Years to offer in the year selector: every year with at least one
 * transaction, plus the current year (always available, even if empty).
 */
export function getAvailableYears(transactions: Transaction[]): number[] {
  const years = new Set<number>([new Date().getFullYear()])
  for (const tx of transactions) {
    const y = Number(tx.date.slice(0, 4))
    if (Number.isFinite(y)) years.add(y)
  }
  return Array.from(years).sort((a, b) => b - a)
}

// ---------- Per-asset year row ----------

export type AssetStatus = 'open' | 'closed' | 'cash'

export type AssetYearRow = {
  investmentId: string
  name: string
  ticker: string | null
  platform: string
  type: InvestmentType
  currency: string
  isCashLike: boolean
  quantityBoughtInYear: number | null
  quantitySoldInYear: number | null
  currentQuantity: number | null
  amountBoughtInYearEur: number
  amountSoldInYearEur: number
  dividendsInterestInYearEur: number
  feesPaidInYearEur: number
  realizedPLInYearEur: number
  // null for cash-like rows: current value minus zero cost basis isn't profit.
  currentUnrealizedPLEur: number | null
  totalPLEur: number | null
  currentValueEur: number
  averageBuyPriceNative: number | null
  status: AssetStatus
  hasActivityInYear: boolean
  // Cost basis of the currently-held quantity — null for cash (no cost basis
  // concept applies) or when nothing is held. Denominator for the % fields.
  remainingCostBasisEur: number | null
  // Cost basis of shares actually sold this year — denominator for
  // realizedPLPercentInYear. null when nothing was sold this year.
  costBasisSoldInYearEur: number | null
  // Share of the total value shown in this table. Shown for cash too (useful
  // to see how much sits idle), just never combined with a P/L percentage.
  portfolioWeightPct: number | null
  totalPLPercent: number | null
  unrealizedPLPercent: number | null
  realizedPLPercentInYear: number | null
}

type ReplayResult = {
  // Deltas for transactions dated inside the selected year.
  quantityBoughtInYear: number
  quantitySoldInYear: number
  amountBoughtInYearEur: number
  amountSoldInYearEur: number
  dividendsInterestInYearEur: number
  feesPaidInYearEur: number
  realizedPLInYearEur: number
  hasActivityInYear: boolean
  // Cost basis of the shares sold this year (accumulated as sells are
  // replayed) — denominator for realizedPLPercentInYear. Only meaningful for
  // unit-based types, since only they replay a sell-by-sell cost basis.
  costBasisSoldInYearEur: number
  // Closing state as of `closingCutoffDate(year)` — only populated for
  // unit-based types (stock/ETF/crypto/commodity), since only those have a
  // transaction-derived quantity/cost-basis to replay. null for others.
  closingQuantity: number | null
  closingCostBasisNative: number | null
  closingCostBasisEur: number | null
  hadAnyActivityByCutoff: boolean
}

// Mirrors calculations.ts's private txNativeToEur, applied to an
// already-computed gross native amount (buy/sell math needs the gross figure
// before/after fee separately, so txAmountInEur alone isn't enough here).
function grossToEur(grossNative: number, tx: Transaction, fxRates?: FxRates): number {
  const priceCurrency = tx.price_currency ?? 'EUR'
  if (priceCurrency === 'EUR') return grossNative
  const rate = tx.fx_rate_to_eur ?? fxRates?.[priceCurrency] ?? 1
  return grossNative * rate
}

/**
 * Replays one investment's transaction history up to `closingCutoffDate(year)`
 * — never past it, so a past year's report can't be contaminated by
 * transactions that happened in a later year — while separately accumulating
 * totals for the subset of those transactions dated inside `year`.
 */
function replayInvestment(
  investment: Investment,
  transactions: Transaction[],
  year: number,
  fxRates?: FxRates
): ReplayResult {
  const cutoff = closingCutoffDate(year)
  const txs = sortChronologically(
    transactions.filter((t) => t.investment_id === investment.id && t.date <= cutoff)
  )

  const result: ReplayResult = {
    quantityBoughtInYear: 0,
    quantitySoldInYear: 0,
    amountBoughtInYearEur: 0,
    amountSoldInYearEur: 0,
    dividendsInterestInYearEur: 0,
    feesPaidInYearEur: 0,
    realizedPLInYearEur: 0,
    hasActivityInYear: false,
    costBasisSoldInYearEur: 0,
    closingQuantity: null,
    closingCostBasisNative: null,
    closingCostBasisEur: null,
    hadAnyActivityByCutoff: txs.length > 0,
  }

  if (hasUnits(investment.type)) {
    let sharesHeld = 0
    let costBasisNative = 0
    let costBasisEur = 0

    for (const tx of txs) {
      const txInYear = inYear(tx.date, year)
      if (txInYear) result.hasActivityInYear = true

      if (tx.type === 'buy' && tx.quantity !== null && tx.price_per_unit !== null) {
        const grossNative = tx.quantity * tx.price_per_unit
        const feeNative = txFeeInPriceCurrency(tx, fxRates)
        const costNative = grossNative + feeNative

        const grossEur = grossToEur(grossNative, tx, fxRates)
        const feeEur = txFeeInEur(tx, fxRates)
        const costEur = grossEur + feeEur

        sharesHeld += tx.quantity
        costBasisNative += costNative
        costBasisEur += costEur

        if (txInYear) {
          result.quantityBoughtInYear += tx.quantity
          result.amountBoughtInYearEur += costEur
          result.feesPaidInYearEur += feeEur
        }
      } else if (tx.type === 'sell' && tx.quantity !== null && tx.price_per_unit !== null) {
        const sellQty = Math.min(tx.quantity, sharesHeld)
        if (sharesHeld > 0 && sellQty > 0) {
          const avgCostNative = costBasisNative / sharesHeld
          const avgCostEur = costBasisEur / sharesHeld
          const soldCostNative = avgCostNative * sellQty
          const soldCostEur = avgCostEur * sellQty

          const grossNative = sellQty * tx.price_per_unit
          const grossEur = grossToEur(grossNative, tx, fxRates)
          const feeEur = txFeeInEur(tx, fxRates)
          const proceedsEur = grossEur - feeEur

          const realizedEur = proceedsEur - soldCostEur
          costBasisNative -= soldCostNative
          costBasisEur -= soldCostEur
          sharesHeld -= sellQty

          if (txInYear) {
            result.quantitySoldInYear += sellQty
            result.amountSoldInYearEur += proceedsEur
            result.feesPaidInYearEur += feeEur
            result.realizedPLInYearEur += realizedEur
            result.costBasisSoldInYearEur += soldCostEur
          }
        }
      } else if (tx.type === 'fee') {
        const amtEur = txAmountInEur(tx, fxRates)
        if (txInYear) {
          result.feesPaidInYearEur += amtEur
          result.realizedPLInYearEur -= amtEur
        }
      } else if (tx.type === 'dividend' || tx.type === 'interest') {
        if (txInYear) {
          result.dividendsInterestInYearEur += txAmountInEur(tx, fxRates)
        }
      }
    }

    result.closingQuantity = sharesHeld
    result.closingCostBasisNative = sharesHeld > 0 ? costBasisNative : 0
    result.closingCostBasisEur = sharesHeld > 0 ? costBasisEur : 0
  } else {
    // Non-unit types: cash / real estate / custom. These have no
    // transaction-derived quantity/cost-basis to replay — closing value
    // comes from investment.current_value (always "now"; see
    // isCashLikeInvestment / the past-year valuation caveat in the UI).
    for (const tx of txs) {
      const txInYear = inYear(tx.date, year)
      if (txInYear) result.hasActivityInYear = true

      if (tx.type === 'deposit') {
        if (txInYear) {
          result.amountBoughtInYearEur += txAmountInEur(tx, fxRates)
          result.feesPaidInYearEur += txFeeInEur(tx, fxRates)
        }
      } else if (tx.type === 'withdraw') {
        if (txInYear) {
          result.amountSoldInYearEur += txAmountInEur(tx, fxRates)
          result.feesPaidInYearEur += txFeeInEur(tx, fxRates)
        }
      } else if (tx.type === 'interest' || tx.type === 'dividend') {
        if (txInYear) {
          const amtEur = txAmountInEur(tx, fxRates)
          result.dividendsInterestInYearEur += amtEur
          result.realizedPLInYearEur += amtEur
        }
      } else if (tx.type === 'fee') {
        if (txInYear) {
          const amtEur = txAmountInEur(tx, fxRates)
          result.feesPaidInYearEur += amtEur
          result.realizedPLInYearEur -= amtEur
        }
      }
    }
  }

  return result
}

export function computeAssetYearRows(
  investments: Investment[],
  transactions: Transaction[],
  year: number,
  fxRates?: FxRates
): AssetYearRow[] {
  const rows: AssetYearRow[] = []

  for (const inv of investments) {
    const cashLike = isCashLikeInvestment(inv)
    const unitBased = hasUnits(inv.type)
    const replay = replayInvestment(inv, transactions, year, fxRates)

    let currentQuantity: number | null = null
    let currentValueEur: number
    let averageBuyPriceNative: number | null = null
    let currentUnrealizedPLEur: number | null = null
    let remainingCostBasisEur: number | null = null
    let isOpenPosition: boolean

    if (unitBased) {
      const qty = replay.closingQuantity ?? 0
      currentQuantity = qty
      const priceCurrency = inv.currency ?? 'EUR'
      const priceNative = inv.current_price ?? 0
      const rateToEur = fxRates?.[priceCurrency] ?? 1
      currentValueEur = qty > 0 ? qty * priceNative * rateToEur : 0
      averageBuyPriceNative =
        qty > 0 && replay.closingCostBasisNative !== null
          ? replay.closingCostBasisNative / qty
          : null
      remainingCostBasisEur = qty > 0 ? replay.closingCostBasisEur : 0
      currentUnrealizedPLEur =
        qty > 0 && replay.closingCostBasisEur !== null
          ? currentValueEur - replay.closingCostBasisEur
          : 0
      isOpenPosition = qty > 0
    } else {
      // Cash / real estate / custom: no transaction-derived quantity. Value
      // always reflects investment.current_value (see caveat above).
      const m = computeInvestmentMetrics(inv, transactions, fxRates)
      currentValueEur = m.currentValue
      currentUnrealizedPLEur = cashLike ? null : m.unrealizedProfit
      remainingCostBasisEur = cashLike ? null : m.remainingCostBasis
      isOpenPosition = m.hasActivity || Math.abs(m.currentValue) > 0.005
    }

    if (!replay.hasActivityInYear && !isOpenPosition) continue

    const totalPLEur = cashLike
      ? null
      : replay.realizedPLInYearEur + (currentUnrealizedPLEur ?? 0)

    const status: AssetStatus = cashLike
      ? 'cash'
      : replay.hadAnyActivityByCutoff && !isOpenPosition
        ? 'closed'
        : 'open'

    const costBasisSoldInYearEur =
      unitBased && replay.costBasisSoldInYearEur > 0 ? replay.costBasisSoldInYearEur : null

    rows.push({
      investmentId: inv.id,
      name: inv.name,
      ticker: inv.ticker,
      platform: inv.platform,
      type: inv.type,
      currency: inv.currency ?? 'EUR',
      isCashLike: cashLike,
      quantityBoughtInYear: unitBased ? replay.quantityBoughtInYear : null,
      quantitySoldInYear: unitBased ? replay.quantitySoldInYear : null,
      currentQuantity,
      amountBoughtInYearEur: replay.amountBoughtInYearEur,
      amountSoldInYearEur: replay.amountSoldInYearEur,
      dividendsInterestInYearEur: replay.dividendsInterestInYearEur,
      feesPaidInYearEur: replay.feesPaidInYearEur,
      realizedPLInYearEur: replay.realizedPLInYearEur,
      currentUnrealizedPLEur: cashLike ? null : currentUnrealizedPLEur,
      totalPLEur,
      currentValueEur,
      averageBuyPriceNative: cashLike ? null : averageBuyPriceNative,
      status,
      hasActivityInYear: replay.hasActivityInYear,
      remainingCostBasisEur: cashLike ? null : remainingCostBasisEur,
      costBasisSoldInYearEur: cashLike ? null : costBasisSoldInYearEur,
      // Filled in below, once the table's total value is known.
      portfolioWeightPct: null,
      totalPLPercent: cashLike ? null : safePercent(totalPLEur, remainingCostBasisEur),
      unrealizedPLPercent: cashLike ? null : safePercent(currentUnrealizedPLEur, remainingCostBasisEur),
      realizedPLPercentInYear: cashLike
        ? null
        : safePercent(replay.realizedPLInYearEur, costBasisSoldInYearEur),
    })
  }

  const totalValueEur = rows.reduce((s, r) => s + r.currentValueEur, 0)
  for (const row of rows) {
    row.portfolioWeightPct = totalValueEur > 0 ? (row.currentValueEur / totalValueEur) * 100 : null
  }

  // Default sort: total P/L descending (cash-like/null rows sink to the bottom).
  rows.sort((a, b) => (b.totalPLEur ?? -Infinity) - (a.totalPLEur ?? -Infinity))
  return rows
}

// ---------- Per-investment YTD (year-to-date) ----------
//
// Reuses computeAssetYearRows (for in-year buy/sell/quantity deltas) and the
// same Modified Dietz weighting computeYearPortfolioSummary uses — just
// applied per investment, treating that investment's own buy/sell
// transactions as the "flow" in/out of the position (there is no other
// concept of external cashflow at the single-investment level).
//
// A year-start *value* still requires a year-start *price*, which this app
// has no stored snapshot for (investment_snapshots is empty pre-2026). When
// the position was already open at the start of the year, this falls back to
// today's price — same disclosed approximation as valuationIsApproximate
// elsewhere — and is flagged via isApproximate. When even that isn't
// possible (no live price on a closed position), YTD is left unavailable
// rather than invented.

export type InvestmentYtdRow = {
  investmentId: string
  startValueEur: number | null
  // Same figure as the matching AssetYearRow.currentValueEur; null when
  // unavailable (cash-like, or no computable start value).
  currentValueEur: number | null
  datedFlows: DatedCashFlow[]
  ytdGrowthEur: number | null
  ytdReturnPercent: number | null
  isApproximate: boolean
  unavailableReason: string | null
  // Set only when ytdGrowthEur IS computable but ytdReturnPercent was
  // deliberately withheld — see ytdPercentIsMeaningful below. Distinct from
  // unavailableReason, which means the whole row (EUR included) has nothing.
  percentUnavailableReason: string | null
}

function ytdPeriodEndIso(year: number): string {
  return year >= new Date().getFullYear() ? todayIso() : `${year}-12-31`
}

// A Modified Dietz percentage needs a real capital base to divide by. For a
// position opened and fully closed within the period (start value 0, end
// value 0 — a round trip), or one whose weighted denominator happens to land
// at zero, negative, or tiny relative to the money that actually moved, the
// resulting percentage is numerically unstable even though the EUR result
// (end - start - flows) stays perfectly valid. The shared safePercent() 0.01
// EUR floor (used by computeModifiedDietzReturnPercent, and by the main
// platform-cashflow-based Year Analysis Growth after contributions /
// Modified Dietz) doesn't catch this — a denominator of, say, -€0.37 clears
// it easily while still producing a four-digit percentage.
//
// This guard is intentionally scoped to the bottom-up per-investment /
// per-asset-class YTD views (Investments page Position YTD, Year Analysis
// "YTD by asset class" chart) and does NOT touch computeModifiedDietzReturnPercent
// or safePercent themselves, so the main Year Analysis / Dashboard figures
// are unaffected.
export const YTD_PERCENT_UNAVAILABLE_REASON =
  'YTD % unavailable: no meaningful capital base for a percentage return. EUR result is still shown.'

const MIN_YTD_CAPITAL_BASE_FRACTION = 0.05

function ytdPercentIsMeaningful(
  startValueEur: number,
  endValueEur: number,
  cashFlows: DatedCashFlow[],
  periodStartIso: string,
  periodEndIso: string
): boolean {
  // Start value 0 alone is normal and fine — Modified Dietz is specifically
  // built to weight a position that only started receiving contributions
  // partway through the period (e.g. any holding bought for the first time
  // this year and still held). It only becomes degenerate when the position
  // ALSO ends the period at 0 — bought and fully sold within the same year,
  // so there is no capital base left to express a return against at either
  // end.
  const startIsZero = Math.abs(startValueEur) < 1e-9
  const endIsZero = Math.abs(endValueEur) < 1e-9
  if (startIsZero && endIsZero) return false

  const periodStart = new Date(periodStartIso).getTime()
  const periodEnd = new Date(periodEndIso).getTime()
  const totalDays = (periodEnd - periodStart) / MS_PER_DAY
  if (!Number.isFinite(totalDays) || totalDays <= 0) return false

  let weightedCashFlow = 0
  let grossFlowMagnitude = 0
  for (const flow of cashFlows) {
    const flowTime = new Date(flow.date).getTime()
    if (!Number.isFinite(flowTime)) continue
    const daysSinceStart = Math.min(Math.max((flowTime - periodStart) / MS_PER_DAY, 0), totalDays)
    const weight = (totalDays - daysSinceStart) / totalDays
    weightedCashFlow += flow.amountEur * weight
    grossFlowMagnitude += Math.abs(flow.amountEur)
  }

  const denominator = startValueEur + weightedCashFlow
  if (denominator <= 0) return false

  const capitalBase = Math.max(Math.abs(startValueEur), grossFlowMagnitude)
  if (capitalBase < 1e-9) return false
  return denominator >= MIN_YTD_CAPITAL_BASE_FRACTION * capitalBase
}

export function computeInvestmentYtdRows(
  investments: Investment[],
  transactions: Transaction[],
  year: number,
  fxRates?: FxRates
): InvestmentYtdRow[] {
  const assetRows = computeAssetYearRows(investments, transactions, year, fxRates)
  const assetRowById = new Map(assetRows.map((r) => [r.investmentId, r]))
  const periodStart = `${year}-01-01`
  const periodEnd = ytdPeriodEndIso(year)

  const unavailable = (
    investmentId: string,
    reason: string,
    currentValueEur: number | null = null
  ): InvestmentYtdRow => ({
    investmentId,
    startValueEur: null,
    currentValueEur,
    datedFlows: [],
    ytdGrowthEur: null,
    ytdReturnPercent: null,
    isApproximate: false,
    unavailableReason: reason,
    percentUnavailableReason: null,
  })

  return investments.map((inv) => {
    if (isCashLikeInvestment(inv)) {
      return unavailable(inv.id, 'Cash-like — YTD not applicable.')
    }

    const row = assetRowById.get(inv.id)
    if (!row || !hasUnits(inv.type)) {
      return unavailable(
        inv.id,
        row ? 'YTD unavailable for this investment type.' : `No activity in ${year}.`
      )
    }

    const currentQty = row.currentQuantity ?? 0
    const boughtInYear = row.quantityBoughtInYear ?? 0
    const soldInYear = row.quantitySoldInYear ?? 0
    const startQty = currentQty - boughtInYear + soldInYear

    let startValueEur: number | null
    let isApproximate = false
    if (Math.abs(startQty) < 1e-9) {
      // Nothing was held at the start of the year — no price needed, exact.
      startValueEur = 0
    } else if (Math.abs(currentQty) < 1e-9) {
      // Position is closed today. Its current_price (if any) belongs to
      // whatever the price-refresh cron last fetched for its ticker/commodity
      // class — an asset the position no longer holds — so it's not a usable
      // stand-in for what this position was worth at the start of the year.
      startValueEur = null
    } else if (Math.abs(boughtInYear) < 1e-9 && Math.abs(soldInYear) < 1e-9) {
      // Still open, but zero buy/sell activity in `year`. Falling back to
      // today's price for the start value would make startValue === currentValue
      // by construction (same price, same quantity) — always exactly 0%
      // growth, silently hiding any real price movement rather than
      // approximating it. Unavailable is more honest than a guaranteed-wrong
      // "flat" result.
      startValueEur = null
    } else if (inv.current_price !== null) {
      const priceCurrency = inv.currency ?? 'EUR'
      const rateToEur = fxRates?.[priceCurrency] ?? 1
      startValueEur = startQty * inv.current_price * rateToEur
      isApproximate = true
    } else {
      startValueEur = null
    }

    if (startValueEur === null) {
      return unavailable(
        inv.id,
        'YTD unavailable: missing year-start valuation.',
        row.currentValueEur
      )
    }

    const datedFlows: DatedCashFlow[] = sortChronologically(
      transactions.filter((t) => t.investment_id === inv.id && inYear(t.date, year))
    )
      .filter(
        (t) =>
          (t.type === 'buy' || t.type === 'sell') && t.quantity !== null && t.price_per_unit !== null
      )
      .map((t) => {
        const grossNative = (t.quantity as number) * (t.price_per_unit as number)
        const grossEur = grossToEur(grossNative, t, fxRates)
        const feeEur = txFeeInEur(t, fxRates)
        const amountEur = t.type === 'buy' ? grossEur + feeEur : -(grossEur - feeEur)
        return { date: t.date, amountEur }
      })

    const netFlow = datedFlows.reduce((s, f) => s + f.amountEur, 0)
    const ytdGrowthEur = row.currentValueEur - startValueEur - netFlow
    const percentMeaningful = ytdPercentIsMeaningful(
      startValueEur,
      row.currentValueEur,
      datedFlows,
      periodStart,
      periodEnd
    )
    const ytdReturnPercent = percentMeaningful
      ? computeModifiedDietzReturnPercent(startValueEur, row.currentValueEur, datedFlows, periodStart, periodEnd)
      : null

    return {
      investmentId: inv.id,
      startValueEur,
      currentValueEur: row.currentValueEur,
      datedFlows,
      ytdGrowthEur,
      ytdReturnPercent,
      isApproximate,
      unavailableReason: null,
      percentUnavailableReason: percentMeaningful ? null : YTD_PERCENT_UNAVAILABLE_REASON,
    }
  })
}

// Combines a subset of InvestmentYtdRow (e.g. the currently visible/filtered
// rows on the Investments page) into one weighted YTD result, using the same
// Modified Dietz methodology as each individual row — never a plain average
// of per-row percentages. Rows without a computable YTD are excluded from
// the combination rather than treated as zero.
export function combineInvestmentYtd(
  rows: InvestmentYtdRow[],
  year: number
): { growthEur: number | null; returnPercent: number | null; percentUnavailableReason: string | null } {
  const usable = rows.filter((r) => r.startValueEur !== null && r.currentValueEur !== null)
  if (usable.length === 0) return { growthEur: null, returnPercent: null, percentUnavailableReason: null }

  const startValueEur = usable.reduce((s, r) => s + (r.startValueEur ?? 0), 0)
  const currentValueEur = usable.reduce((s, r) => s + (r.currentValueEur ?? 0), 0)
  const datedFlows = usable.flatMap((r) => r.datedFlows)
  const growthEur = usable.reduce((s, r) => s + (r.ytdGrowthEur ?? 0), 0)

  const periodStart = `${year}-01-01`
  const periodEnd = ytdPeriodEndIso(year)
  const percentMeaningful = ytdPercentIsMeaningful(startValueEur, currentValueEur, datedFlows, periodStart, periodEnd)
  const returnPercent = percentMeaningful
    ? computeModifiedDietzReturnPercent(startValueEur, currentValueEur, datedFlows, periodStart, periodEnd)
    : null

  return {
    growthEur,
    returnPercent,
    percentUnavailableReason: percentMeaningful ? null : YTD_PERCENT_UNAVAILABLE_REASON,
  }
}

// Groups computeInvestmentYtdRows by asset class (same InvestmentType key
// computeAssetClassSummaries uses) and combines each group with
// combineInvestmentYtd — no new formula, just grouping + reuse. Cash-like
// investments are excluded entirely (not just zeroed) since YTD isn't a
// meaningful concept for a cash balance.
export type AssetClassYtd = {
  type: InvestmentType
  growthEur: number | null
  returnPercent: number | null
  // Set only when growthEur IS computable but returnPercent was withheld —
  // see ytdPercentIsMeaningful. Null whenever returnPercent is present, or
  // when there was nothing to combine at all.
  percentUnavailableReason: string | null
  // Count of holdings in this class actually folded into growthEur/returnPercent
  // vs. left out because they had no computable YTD (see InvestmentYtdRow.unavailableReason).
  includedCount: number
  excludedCount: number
}

export function computeAssetClassYtd(
  investments: Investment[],
  transactions: Transaction[],
  year: number,
  fxRates?: FxRates
): AssetClassYtd[] {
  const ytdRows = computeInvestmentYtdRows(investments, transactions, year, fxRates)
  const ytdByInvestmentId = new Map(ytdRows.map((r) => [r.investmentId, r]))

  const byType = new Map<InvestmentType, InvestmentYtdRow[]>()
  for (const inv of investments) {
    if (isCashLikeInvestment(inv)) continue
    const ytd = ytdByInvestmentId.get(inv.id)
    if (!ytd) continue
    const list = byType.get(inv.type) ?? []
    list.push(ytd)
    byType.set(inv.type, list)
  }

  const results: AssetClassYtd[] = []
  for (const [type, rows] of byType) {
    const includedCount = rows.filter((r) => r.startValueEur !== null && r.currentValueEur !== null).length
    const combined = combineInvestmentYtd(rows, year)
    results.push({
      type,
      growthEur: combined.growthEur,
      returnPercent: combined.returnPercent,
      percentUnavailableReason: combined.percentUnavailableReason,
      includedCount,
      excludedCount: rows.length - includedCount,
    })
  }

  results.sort((a, b) => (b.growthEur ?? -Infinity) - (a.growthEur ?? -Infinity))
  return results
}

// ---------- Asset-class summary ----------

export type AssetClassSummary = {
  type: InvestmentType
  isCashClass: boolean
  currentValueEur: number
  pctOfPortfolio: number
  amountBoughtInYearEur: number
  amountSoldInYearEur: number
  realizedPLInYearEur: number | null
  // null when this is the cash class, or every holding in it is cash-like.
  currentUnrealizedPLEur: number | null
  totalPLEur: number | null
  totalPLPercent: number | null
  feesPaidInYearEur: number
  dividendsInterestInYearEur: number
}

export function computeAssetClassSummaries(assetRows: AssetYearRow[]): AssetClassSummary[] {
  const totalValue = assetRows.reduce((s, r) => s + r.currentValueEur, 0)

  const byType = new Map<InvestmentType, AssetYearRow[]>()
  for (const row of assetRows) {
    const list = byType.get(row.type) ?? []
    list.push(row)
    byType.set(row.type, list)
  }

  const summaries: AssetClassSummary[] = []
  for (const [type, rows] of byType) {
    const isCashClass = type === 'cash'
    const currentValueEur = rows.reduce((s, r) => s + r.currentValueEur, 0)
    const nonCashRows = rows.filter((r) => !r.isCashLike)

    const realizedPLInYearEur = isCashClass ? null : rows.reduce((s, r) => s + r.realizedPLInYearEur, 0)
    const currentUnrealizedPLEur =
      !isCashClass && nonCashRows.length > 0
        ? nonCashRows.reduce((s, r) => s + (r.currentUnrealizedPLEur ?? 0), 0)
        : null
    const totalPLEur =
      realizedPLInYearEur !== null ? realizedPLInYearEur + (currentUnrealizedPLEur ?? 0) : null
    const costBasisEur = nonCashRows.reduce((s, r) => s + (r.remainingCostBasisEur ?? 0), 0)

    summaries.push({
      type,
      isCashClass,
      currentValueEur,
      pctOfPortfolio: totalValue > 0 ? (currentValueEur / totalValue) * 100 : 0,
      amountBoughtInYearEur: rows.reduce((s, r) => s + r.amountBoughtInYearEur, 0),
      amountSoldInYearEur: rows.reduce((s, r) => s + r.amountSoldInYearEur, 0),
      realizedPLInYearEur,
      currentUnrealizedPLEur,
      totalPLEur,
      totalPLPercent: isCashClass ? null : safePercent(totalPLEur, costBasisEur > 0 ? costBasisEur : null),
      feesPaidInYearEur: rows.reduce((s, r) => s + r.feesPaidInYearEur, 0),
      dividendsInterestInYearEur: rows.reduce((s, r) => s + r.dividendsInterestInYearEur, 0),
    })
  }

  summaries.sort((a, b) => b.currentValueEur - a.currentValueEur)
  return summaries
}

// ---------- At-a-glance insights ----------

export type YearInsights = {
  bestAsset: AssetYearRow | null
  worstAsset: AssetYearRow | null
  biggestHolding: AssetYearRow | null
  bestAssetClass: AssetClassSummary | null
  highestFeesAsset: AssetYearRow | null
}

/**
 * Pure selection over already-computed rows/classes — picks out the extremes
 * an annual report reader wants first. No new math happens here, so nothing
 * shown here can disagree with the tables below it.
 */
export function computeYearInsights(
  assetRows: AssetYearRow[],
  classSummaries: AssetClassSummary[]
): YearInsights {
  const withPL = assetRows.filter((r): r is AssetYearRow & { totalPLEur: number } => r.totalPLEur !== null)
  const bestAsset =
    withPL.length > 0 ? withPL.reduce((a, b) => (b.totalPLEur > a.totalPLEur ? b : a)) : null
  const worstAsset =
    withPL.length > 0 ? withPL.reduce((a, b) => (b.totalPLEur < a.totalPLEur ? b : a)) : null

  const byValue = assetRows.filter((r) => r.currentValueEur > 0)
  const biggestHolding =
    byValue.length > 0 ? byValue.reduce((a, b) => (b.currentValueEur > a.currentValueEur ? b : a)) : null

  const classesWithPL = classSummaries.filter(
    (c): c is AssetClassSummary & { totalPLEur: number } => c.totalPLEur !== null
  )
  const bestAssetClass =
    classesWithPL.length > 0 ? classesWithPL.reduce((a, b) => (b.totalPLEur > a.totalPLEur ? b : a)) : null

  const feeRows = assetRows.filter((r) => r.feesPaidInYearEur > 0)
  const highestFeesAsset =
    feeRows.length > 0 ? feeRows.reduce((a, b) => (b.feesPaidInYearEur > a.feesPaidInYearEur ? b : a)) : null

  return { bestAsset, worstAsset, biggestHolding, bestAssetClass, highestFeesAsset }
}

// ---------- Portfolio-level year summary ----------

export type YearPortfolioSummary = {
  year: number
  startValueEur: number | null
  startValueDate: string | null
  endValueEur: number
  endValueDate: string
  endValueIsLive: boolean
  netContributionsEur: number
  totalBuysEur: number
  totalSellsEur: number
  dividendsInterestEur: number
  feesPaidEur: number
  realizedPLInYearEur: number
  currentUnrealizedPLEur: number
  totalPLEur: number
  portfolioValueChangeEur: number | null
  startSnapshotMissing: boolean
  endSnapshotMissing: boolean
  // True for any past year: unrealized P/L and cash/real-estate/custom
  // current value are computed at TODAY's prices/balances, not year-end's,
  // because no historical price/valuation feed exists.
  valuationIsApproximate: boolean
  // ── Percentage metrics — all null when startValueEur is unavailable/zero ──
  portfolioValueChangePercent: number | null
  netContributionsPercent: number | null
  // "Growth after contributions": end - start - net contributions, in euros
  // only. Deliberately has no naive "/ startValue" percentage — see
  // modifiedDietzReturnPercent for the time-weighted approximation.
  growthExcludingContributionsEur: number | null
  // Time-weighted approximate return using real cash-flow dates. null when
  // there's no start value or measurable period — never a guessed number.
  modifiedDietzReturnPercent: number | null
  // totalPLEur / (current cost basis of non-cash holdings). null if that
  // cost basis is zero/unavailable.
  totalProfitLossPercent: number | null
  // Monthly breakdown of the exact same cash flows that power
  // netContributionsEur/modifiedDietzReturnPercent above — never a second,
  // independently-derived cashflow calculation.
  monthlyCashflow: MonthlyCashflowRow[]
  // Gross in/out from the same yearCashFlows list as netContributionsEur —
  // split out for the reconciliation audit's cashflow classification check.
  grossContributionsInEur: number
  grossContributionsOutEur: number // positive number = money that left
}

export type MonthlyCashflowRow = {
  month: number // 1–12
  label: string // 'Jan', 'Feb', …
  inflowEur: number
  outflowEur: number // positive number = money that left the portfolio
  netEur: number
}

const MONTH_LABELS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

export type PortfolioSnapshotForYear = { date: string; total_value_eur: number }
export type CapitalFlowEntryForYear = {
  year: number
  flow_date: string
  direction: CapitalFlowDirection
  amount_eur: number
}

// A single dated external cash movement — positive means money entered the
// portfolio, negative means it left. Used both to total net contributions
// and to weight each flow's time-in-market for the Modified Dietz return.
export type DatedCashFlow = { date: string; amountEur: number }

const MS_PER_DAY = 24 * 60 * 60 * 1000

/**
 * Modified Dietz return: accounts for *when* cash entered/left the portfolio
 * during the period, unlike a naive (end - start - flows) / start ratio,
 * which implicitly (and wrongly) assumes every contribution was invested
 * for the entire period. Early contributions get more weight (more time to
 * grow/shrink with the market); late ones get less.
 *
 * Returns null if there's no reliable start value or measurement period —
 * never a number computed from a degenerate denominator.
 */
function computeModifiedDietzReturnPercent(
  startValueEur: number | null,
  endValueEur: number,
  cashFlows: DatedCashFlow[],
  periodStartIso: string,
  periodEndIso: string
): number | null {
  if (startValueEur === null) return null

  const periodStart = new Date(periodStartIso).getTime()
  const periodEnd = new Date(periodEndIso).getTime()
  const totalDays = (periodEnd - periodStart) / MS_PER_DAY
  if (!Number.isFinite(totalDays) || totalDays <= 0) return null

  let netCashFlow = 0
  let weightedCashFlow = 0
  for (const flow of cashFlows) {
    const flowTime = new Date(flow.date).getTime()
    if (!Number.isFinite(flowTime)) continue
    netCashFlow += flow.amountEur
    const daysSinceStart = Math.min(Math.max((flowTime - periodStart) / MS_PER_DAY, 0), totalDays)
    const weight = (totalDays - daysSinceStart) / totalDays
    weightedCashFlow += flow.amountEur * weight
  }

  const numerator = endValueEur - startValueEur - netCashFlow
  const denominator = startValueEur + weightedCashFlow
  return safePercent(numerator, denominator)
}

export function computeYearPortfolioSummary(
  year: number,
  assetRows: AssetYearRow[],
  snapshots: PortfolioSnapshotForYear[],
  capitalFlowEntries: CapitalFlowEntryForYear[],
  transactions: Transaction[],
  liveTotalValueEur: number
): YearPortfolioSummary {
  const currentYear = new Date().getFullYear()
  const yearStart = `${year}-01-01`
  const yearEnd = `${year}-12-31`
  const today = todayIso()

  // Start value: most recent snapshot on/before the year's first day.
  const startCandidates = snapshots
    .filter((s) => s.date <= yearStart)
    .sort((a, b) => (a.date < b.date ? 1 : -1))
  const startSnap = startCandidates[0] ?? null

  let endValueEur: number
  let endValueDate: string
  let endValueIsLive: boolean
  let endSnapshotMissing: boolean

  if (year >= currentYear) {
    // Current (or future, defensively) year: end value is "now".
    endValueEur = liveTotalValueEur
    endValueDate = today
    endValueIsLive = true
    endSnapshotMissing = false
  } else {
    const endCandidates = snapshots
      .filter((s) => s.date <= yearEnd)
      .sort((a, b) => (a.date < b.date ? 1 : -1))
    const endSnap = endCandidates[0] ?? null
    endValueEur = endSnap?.total_value_eur ?? liveTotalValueEur
    endValueDate = endSnap?.date ?? today
    endValueIsLive = endSnap === null
    endSnapshotMissing = endSnap === null
  }

  const startValueEur = startSnap?.total_value_eur ?? null
  const startValueDate = startSnap?.date ?? null
  const startSnapshotMissing = startSnap === null

  const portfolioValueChangeEur =
    startValueEur !== null ? endValueEur - startValueEur : null

  // Net contributions: same definition as the Contributions page — external
  // cash moved to/from the portfolio, not internal buy/sell reallocations.
  // Each flow keeps its real date, so the same list can weight the Modified
  // Dietz return below — no separate, potentially-inconsistent date lookup.
  const yearCashFlows: DatedCashFlow[] = []
  const ledgerRows = capitalFlowEntries.filter((e) => e.year === year)
  for (const e of ledgerRows) {
    yearCashFlows.push({
      date: e.flow_date,
      amountEur: e.direction === 'to_portfolio' ? e.amount_eur : -e.amount_eur,
    })
  }
  for (const tx of transactions) {
    if (!tx.is_contribution || !inYear(tx.date, year)) continue
    const row = txToContribRow(tx as Parameters<typeof txToContribRow>[0])
    if (!row) continue
    yearCashFlows.push({
      date: tx.date,
      amountEur: row.direction === 'to_portfolio' ? row.amount_eur : -row.amount_eur,
    })
  }
  const netContributionsEur = yearCashFlows.reduce((s, f) => s + f.amountEur, 0)
  const grossContributionsInEur = yearCashFlows
    .filter((f) => f.amountEur > 0)
    .reduce((s, f) => s + f.amountEur, 0)
  const grossContributionsOutEur = yearCashFlows
    .filter((f) => f.amountEur < 0)
    .reduce((s, f) => s - f.amountEur, 0)

  // Monthly bucketing of the exact same yearCashFlows list above — same
  // source data as netContributionsEur, just grouped by month instead of
  // summed for the whole year.
  const monthlyCashflow: MonthlyCashflowRow[] = MONTH_LABELS.map((label, i) => ({
    month: i + 1,
    label,
    inflowEur: 0,
    outflowEur: 0,
    netEur: 0,
  }))
  for (const flow of yearCashFlows) {
    const monthIdx = Number(flow.date.slice(5, 7)) - 1
    if (monthIdx < 0 || monthIdx > 11) continue
    if (flow.amountEur >= 0) monthlyCashflow[monthIdx].inflowEur += flow.amountEur
    else monthlyCashflow[monthIdx].outflowEur += -flow.amountEur
    monthlyCashflow[monthIdx].netEur += flow.amountEur
  }

  // Cash deposits/withdrawals are cash movements, not "buying/selling an
  // investment" — excluded here so this figure isn't inflated by topping up
  // a cash balance. Fees and dividends/interest are legitimate either way.
  const investedRows = assetRows.filter((r) => !r.isCashLike)
  const totalBuysEur = investedRows.reduce((s, r) => s + r.amountBoughtInYearEur, 0)
  const totalSellsEur = investedRows.reduce((s, r) => s + r.amountSoldInYearEur, 0)
  const dividendsInterestEur = assetRows.reduce((s, r) => s + r.dividendsInterestInYearEur, 0)
  const feesPaidEur = assetRows.reduce((s, r) => s + r.feesPaidInYearEur, 0)
  const realizedPLInYearEur = assetRows.reduce((s, r) => s + r.realizedPLInYearEur, 0)
  // Cash-like rows contribute null (excluded, not treated as 0-loss).
  const currentUnrealizedPLEur = assetRows
    .filter((r) => !r.isCashLike)
    .reduce((s, r) => s + (r.currentUnrealizedPLEur ?? 0), 0)
  const totalPLEur = realizedPLInYearEur + currentUnrealizedPLEur

  // Percentage metrics — all denominated against start-of-year value, so all
  // require a start snapshot to exist. safePercent() returns null otherwise.
  const portfolioValueChangePercent = safePercent(portfolioValueChangeEur, startValueEur)
  const netContributionsPercent = safePercent(netContributionsEur, startValueEur)
  // "Growth after contributions": the portfolio's value change with net
  // contributions backed out. This is a euro amount only — it deliberately
  // has no simple "/ startValue" percentage attached, since that ratio
  // implicitly (and wrongly) treats every contribution as if it had been
  // invested for the whole year. See modifiedDietzReturnPercent for the
  // time-weighted approximation instead.
  const growthExcludingContributionsEur =
    startValueEur !== null ? endValueEur - startValueEur - netContributionsEur : null
  // Modified Dietz weights each cash flow by how long it was actually
  // invested during the period (real dates from capital_flow_entries /
  // is_contribution transactions) — null if there's no start value or no
  // measurable period, never a guessed number.
  const modifiedDietzReturnPercent = computeModifiedDietzReturnPercent(
    startValueEur,
    endValueEur,
    yearCashFlows,
    startValueDate ?? yearStart,
    endValueDate
  )

  // Cost basis of currently-held, non-cash positions — denominator for
  // totalProfitLossPercent. A closed-out position contributes 0.
  const totalCostBasisEur = assetRows
    .filter((r) => !r.isCashLike)
    .reduce((s, r) => s + (r.remainingCostBasisEur ?? 0), 0)
  const totalProfitLossPercent = safePercent(totalPLEur, totalCostBasisEur > 0 ? totalCostBasisEur : null)

  return {
    year,
    startValueEur,
    startValueDate,
    endValueEur,
    endValueDate,
    endValueIsLive,
    netContributionsEur,
    totalBuysEur,
    totalSellsEur,
    dividendsInterestEur,
    feesPaidEur,
    realizedPLInYearEur,
    currentUnrealizedPLEur,
    totalPLEur,
    portfolioValueChangeEur,
    startSnapshotMissing,
    endSnapshotMissing,
    valuationIsApproximate: year < currentYear,
    portfolioValueChangePercent,
    netContributionsPercent,
    growthExcludingContributionsEur,
    modifiedDietzReturnPercent,
    totalProfitLossPercent,
    monthlyCashflow,
    grossContributionsInEur,
    grossContributionsOutEur,
  }
}

// ---------- Portfolio bridge (waterfall) chart data ----------

export type BridgeStepKey = 'start' | 'contributions' | 'growth' | 'end'

export type BridgeStep = {
  key: BridgeStepKey
  label: string
  // `base` + `value` are the stacked-bar building blocks (base is the
  // invisible offset, value is the visible bar height — recharts' standard
  // waterfall trick). `amount` is the real signed number, for labels/tooltips.
  base: number
  value: number
  amount: number
  isTotal: boolean
  tone: 'positive' | 'negative' | 'neutral'
}

/**
 * Start value → net contributions → growth after contributions → current
 * value, as a 4-step waterfall. Returns null when there's no start-of-year
 * value to bridge from — never a chart built on a guessed starting point.
 */
export function computePortfolioBridgeData(summary: YearPortfolioSummary): BridgeStep[] | null {
  if (summary.startValueEur === null || summary.growthExcludingContributionsEur === null) return null

  const start = summary.startValueEur
  const contributions = summary.netContributionsEur
  const growth = summary.growthExcludingContributionsEur
  const end = summary.endValueEur

  let running = start
  const contribBase = contributions >= 0 ? running : running + contributions
  running += contributions
  const growthBase = growth >= 0 ? running : running + growth
  running += growth

  return [
    {
      key: 'start',
      label: 'Start value',
      base: 0,
      value: start,
      amount: start,
      isTotal: true,
      tone: 'neutral',
    },
    {
      key: 'contributions',
      label: 'Net contributions',
      base: contribBase,
      value: Math.abs(contributions),
      amount: contributions,
      isTotal: false,
      tone: contributions > 0 ? 'positive' : contributions < 0 ? 'negative' : 'neutral',
    },
    {
      key: 'growth',
      label: 'Growth after contributions',
      base: growthBase,
      value: Math.abs(growth),
      amount: growth,
      isTotal: false,
      tone: growth > 0 ? 'positive' : growth < 0 ? 'negative' : 'neutral',
    },
    {
      key: 'end',
      label: 'Current value',
      base: 0,
      value: end,
      amount: end,
      isTotal: true,
      tone: 'neutral',
    },
  ]
}

// ---------- Top winners / losers ranking ----------

export type AssetPnlRankingRow = {
  investmentId: string
  name: string
  platform: string
  type: InvestmentType
  totalPLEur: number
  totalPLPercent: number | null
}

/**
 * Top `limitEachSide` winners and losers by Total P/L, combined into one
 * descending-sorted list. Cash-like rows are excluded (they have no P/L to
 * rank). Identity is investment.id, so the same ticker on two platforms
 * ranks separately.
 */
export function computeAssetPnlRanking(
  assetRows: AssetYearRow[],
  limitEachSide = 5
): AssetPnlRankingRow[] {
  const withPL = assetRows.filter(
    (r): r is AssetYearRow & { totalPLEur: number } => !r.isCashLike && r.totalPLEur !== null
  )
  const descending = [...withPL].sort((a, b) => b.totalPLEur - a.totalPLEur)

  const winners = descending.slice(0, limitEachSide)
  const losers = descending.slice(-limitEachSide)

  const seen = new Set<string>()
  const combined: typeof descending = []
  for (const row of [...winners, ...losers]) {
    if (seen.has(row.investmentId)) continue
    seen.add(row.investmentId)
    combined.push(row)
  }
  combined.sort((a, b) => b.totalPLEur - a.totalPLEur)

  return combined.map((r) => ({
    investmentId: r.investmentId,
    name: r.name,
    platform: r.platform,
    type: r.type,
    totalPLEur: r.totalPLEur,
    totalPLPercent: r.totalPLPercent,
  }))
}

// ---------- Plain-English verdict ----------

function classDisplayName(type: InvestmentType): string {
  if (type === 'ETF') return 'ETF'
  return type.charAt(0).toUpperCase() + type.slice(1)
}

/**
 * A short, deterministic (not AI-generated) summary sentence built only from
 * numbers already computed elsewhere in this module — never a claim the data
 * doesn't support. Falls back to an honest "not enough data" line when
 * there's no start-of-year value to compare against.
 */
export function computeYearVerdict(
  summary: YearPortfolioSummary,
  classSummaries: AssetClassSummary[]
): string {
  if (summary.startValueEur === null || summary.growthExcludingContributionsEur === null) {
    return `Not enough historical data yet to summarize ${summary.year}'s performance — a start-of-year snapshot is needed for a full picture.`
  }

  const contrib = summary.netContributionsEur
  const growth = summary.growthExcludingContributionsEur
  const change = summary.portfolioValueChangeEur ?? growth + contrib
  const contribAbs = Math.abs(contrib)
  const growthAbs = Math.abs(growth)
  const grewOrShrank = change >= 0 ? 'grew' : 'shrank'

  let sentence: string
  if (contribAbs < 0.01 && growthAbs < 0.01) {
    sentence = `Your portfolio value barely changed in ${summary.year}.`
  } else if (contribAbs >= growthAbs * 1.5) {
    sentence = `Your portfolio ${grewOrShrank} mostly because of net contributions (${contrib >= 0 ? '+' : ''}${money(contrib, 'EUR')}); the estimated investment result was modest (${growth >= 0 ? '+' : ''}${money(growth, 'EUR')}).`
  } else if (growthAbs >= contribAbs * 1.5) {
    sentence = `Your portfolio ${grewOrShrank} mainly from investment performance (${growth >= 0 ? '+' : ''}${money(growth, 'EUR')} after contributions), not from money added or withdrawn.`
  } else {
    sentence = `Your portfolio ${grewOrShrank} from a mix of net contributions (${contrib >= 0 ? '+' : ''}${money(contrib, 'EUR')}) and investment performance (${growth >= 0 ? '+' : ''}${money(growth, 'EUR')}).`
  }

  const classesWithPL = classSummaries.filter(
    (c): c is AssetClassSummary & { totalPLEur: number } => c.totalPLEur !== null
  )
  if (classesWithPL.length >= 2) {
    const best = classesWithPL.reduce((a, b) => (b.totalPLEur > a.totalPLEur ? b : a))
    const worst = classesWithPL.reduce((a, b) => (b.totalPLEur < a.totalPLEur ? b : a))
    if (best.type !== worst.type && (best.totalPLEur > 0 || worst.totalPLEur < 0)) {
      const bestName = classDisplayName(best.type).toLowerCase()
      const worstName = classDisplayName(worst.type).toLowerCase()
      sentence += ` Your ${bestName} positions ${best.totalPLEur >= 0 ? 'drove most of the gains' : 'held up best'}, while ${worstName} ${worst.totalPLEur < 0 ? 'dragged performance down' : 'contributed least'}.`
    }
  }

  return sentence
}

// ---------------------------------------------------------------------------
// ---------- Reconciliation audit ----------
//
// Cross-checks Year Analysis's numbers against the exact same
// computeInvestmentMetrics()/computePortfolioMetrics() functions Dashboard
// and History use, so any divergence between the pages is made visible and
// explained instead of silently assumed away. Two known, expected sources of
// divergence exist and are called out explicitly rather than "fixed" here:
//
//  1. computePortfolioMetrics() (calculations.ts) does not exclude cash-like
//     holdings from unrealized P/L — a cash balance with no matching
//     deposit/withdraw transactions reads as pure "unrealized profit" there.
//     Year Analysis deliberately excludes it (see isCashLikeInvestment).
//  2. Year Analysis's "Total P/L" is realizedPLInYearEur (transactions dated
//     in year Y) + currentUnrealizedPLEur (today's snapshot) — a genuinely
//     different metric from History's snapshot-to-snapshot P/L delta, which
//     uses all-time cumulative realized. Neither is wrong; they answer
//     different questions. This audit measures both explicitly rather than
//     forcing them to match.
// ---------------------------------------------------------------------------

export type AuditStatus = 'ok' | 'mismatch' | 'approximate' | 'unavailable'

export type AuditRow = {
  label: string
  value: number | null
  note?: string
}

export type AuditCheck = {
  title: string
  rows: AuditRow[]
  differenceEur: number | null
  status: AuditStatus
  explanation: string
}

export type ReconciliationAudit = {
  portfolioValueBridge: AuditCheck
  profitLossBridge: AuditCheck
  currentPlConsistency: AuditCheck
  costBasisConsistency: AuditCheck
  cashflowClassification: AuditCheck
}

export type SnapshotForAudit = {
  date: string
  total_value_eur: number
  total_realized_eur: number | null
  total_unrealized_eur: number | null
  // When the row was last written. Used only to detect snapshots that
  // predate the cash-exclusion fix below — not used for any date-range
  // filtering.
  updated_at: string | null
  // Used only to detect snapshots that were partially, manually corrected
  // (e.g. total_value_eur fixed from a source document) without their
  // total_realized_eur / total_unrealized_eur being reconstructed. A recent
  // updated_at alone doesn't prove those fields were verified — see
  // VALUE_ONLY_CORRECTION_MARKER below.
  snapshot_source: string | null
}

function auditStatus(diff: number | null, tolerance = 1): AuditStatus {
  if (diff === null) return 'unavailable'
  return Math.abs(diff) <= tolerance ? 'ok' : 'mismatch'
}

// The date computePortfolioMetrics() was fixed to exclude cash-like holdings
// from realized/unrealized P/L (see calculations.ts). Snapshot rows written
// before this still have the OLD, cash-inflated total_realized_eur /
// total_unrealized_eur baked in. Comparing such a snapshot against a
// post-fix live total produces an internally-consistent-looking bridge that
// is nonetheless wrong, since the two sides used different P/L definitions
// for what "realized"/"unrealized" means. Remove this guard (and the
// isPreCashFix logic below) once historical snapshots are backfilled under
// the new definition.
const CASH_EXCLUSION_FIX_ROLLOUT_ISO = '2026-07-22'

// Marker appended to snapshot_source when a snapshot's total_value_eur was
// corrected from an official source document (e.g. removing cash that had
// already been withdrawn) without also reconstructing total_realized_eur /
// total_unrealized_eur under the cash-exclusion methodology. updated_at gets
// bumped by that kind of edit too, so it alone can't be trusted to mean
// "P/L fields verified" — this marker is checked explicitly instead.
const VALUE_ONLY_CORRECTION_MARKER = 'corrected_removed_gold_republic_withdrawn_cash_753_46'

export function computeReconciliationAudit(
  investments: Investment[],
  transactions: Transaction[],
  year: number,
  fxRates: FxRates | undefined,
  assetRows: AssetYearRow[],
  summary: YearPortfolioSummary,
  snapshots: SnapshotForAudit[],
  liveMetrics: PortfolioMetrics
): ReconciliationAudit {
  const yearStart = `${year}-01-01`

  // ---------- 1. Portfolio value bridge ----------
  // By construction, growthExcludingContributionsEur === end - start -
  // netContributions, so this should always land at ~0. A non-zero result
  // here would mean the numbers got wired together wrong somewhere upstream,
  // not a data quality issue.
  const pvbDiff =
    summary.startValueEur !== null && summary.growthExcludingContributionsEur !== null
      ? summary.endValueEur -
        summary.startValueEur -
        summary.netContributionsEur -
        summary.growthExcludingContributionsEur
      : null

  const portfolioValueBridge: AuditCheck = {
    title: 'Portfolio value bridge',
    rows: [
      { label: 'Start portfolio value', value: summary.startValueEur },
      { label: 'Net external contributions', value: summary.netContributionsEur },
      { label: 'Growth after contributions', value: summary.growthExcludingContributionsEur },
      { label: 'Current portfolio value', value: summary.endValueEur },
    ],
    differenceEur: pvbDiff,
    status: summary.startValueEur === null ? 'unavailable' : auditStatus(pvbDiff),
    explanation:
      summary.startValueEur === null
        ? 'No start-of-year snapshot — cannot bridge from a start value.'
        : 'Growth after contributions is defined as end − start − contributions, so this reconciles to ~0 by construction. It is included as a regression guard, not because a mismatch here is expected.',
  }

  // ---------- 2. Profit/Loss bridge (Dashboard/History scope: cash-inclusive, all-time) ----------
  const startCandidates = snapshots
    .filter((s) => s.date <= yearStart)
    .sort((a, b) => (a.date < b.date ? 1 : -1))
  const startSnap = startCandidates[0] ?? null
  const startRealized = startSnap?.total_realized_eur ?? null
  const startUnrealized = startSnap?.total_unrealized_eur ?? null
  const startTotalProfitLoss =
    startRealized !== null && startUnrealized !== null ? startRealized + startUnrealized : null

  const currentTotalProfitLoss = liveMetrics.totalProfit
  const profitLossChangeThisYear =
    startTotalProfitLoss !== null ? currentTotalProfitLoss - startTotalProfitLoss : null
  const realizedPnlSinceSnapshot = startRealized !== null ? liveMetrics.totalRealized - startRealized : null
  const changeInUnrealizedPnl =
    startUnrealized !== null ? liveMetrics.totalUnrealized - startUnrealized : null
  const plBridgeDiff =
    profitLossChangeThisYear !== null && realizedPnlSinceSnapshot !== null && changeInUnrealizedPnl !== null
      ? profitLossChangeThisYear - (realizedPnlSinceSnapshot + changeInUnrealizedPnl)
      : null

  // Dashboard/History's live P/L is now cash-excluded (calculations.ts fix).
  // If the start snapshot was written before that fix shipped, it still
  // carries the old cash-inflated numbers — the bridge below can reconcile
  // arithmetically while still being a meaningless comparison, since "start"
  // and "current" would be using two different P/L definitions.
  const startSnapPreDatesCashFix =
    startSnap !== null && (startSnap.updated_at ?? startSnap.date) < CASH_EXCLUSION_FIX_ROLLOUT_ISO

  // A snapshot can also be *partially* corrected (e.g. total_value_eur fixed
  // from an official statement) without total_realized_eur/total_unrealized_eur
  // being reconstructed. That edit bumps updated_at too, so updated_at alone
  // would wrongly clear startSnapPreDatesCashFix above. Check the explicit
  // marker instead — see VALUE_ONLY_CORRECTION_MARKER.
  const startSnapValueOnlyCorrected =
    startSnap !== null && (startSnap.snapshot_source ?? '').includes(VALUE_ONLY_CORRECTION_MARKER)

  const profitLossBridge: AuditCheck = {
    title: 'Profit/Loss bridge — start snapshot vs live Dashboard/History P/L',
    rows: [
      {
        label: 'Start total P/L (snapshot)',
        value: startTotalProfitLoss,
        note: startSnap
          ? `as of ${startSnap.date}${
              startSnapValueOnlyCorrected
                ? ' — value corrected from official statements; P/L fields not reconstructed'
                : startSnapPreDatesCashFix
                  ? ' — written before the cash-exclusion fix'
                  : ''
            }`
          : 'no snapshot with a realized/unrealized breakdown found',
      },
      {
        label: 'Current total P/L (live)',
        value: currentTotalProfitLoss,
        note: 'same computePortfolioMetrics() call Dashboard/History use — now excludes cash',
      },
      { label: 'P/L change this year', value: profitLossChangeThisYear },
      { label: 'Realized P/L since start snapshot', value: realizedPnlSinceSnapshot },
      { label: 'Change in unrealized P/L', value: changeInUnrealizedPnl },
    ],
    differenceEur: plBridgeDiff,
    status:
      startTotalProfitLoss === null
        ? 'unavailable'
        : startSnapValueOnlyCorrected || startSnapPreDatesCashFix
          ? 'approximate'
          : auditStatus(plBridgeDiff),
    explanation:
      startTotalProfitLoss === null
        ? 'No start-of-year snapshot with a realized/unrealized breakdown — cannot bridge P/L.'
        : startSnapValueOnlyCorrected
          ? 'Start value corrected from official platform statements. Historical snapshot P/L fields for 2025-12-31 are not fully reconstructed.'
          : startSnapPreDatesCashFix
            ? 'Start snapshot uses the old P/L definition; backfill needed for a reliable P/L change. It was written before the cash-exclusion fix, so it may still count a cash balance as profit while the live total (right) now correctly excludes it — "P/L change this year" is not reliable until historical snapshots are backfilled under the new definition.'
            : 'Validates that Dashboard/History\'s own snapshot-vs-live bookkeeping is internally consistent — both sides now use the same cash-excluded P/L definition.',
  }

  // ---------- 3. Current P/L consistency: Dashboard/History vs Year Analysis (non-cash) ----------
  let nonCashCurrentPL = 0
  let cashCurrentPL = 0
  for (const inv of investments) {
    const m = computeInvestmentMetrics(inv, transactions, fxRates)
    if (isCashLikeInvestment(inv)) cashCurrentPL += m.realizedProfit + m.unrealizedProfit
    else nonCashCurrentPL += m.realizedProfit + m.unrealizedProfit
  }
  const dashboardCurrentPL = liveMetrics.totalProfit
  const currentPlDiff = dashboardCurrentPL - nonCashCurrentPL
  const currentPlExplainedByCash = Math.abs(currentPlDiff - cashCurrentPL) <= 1

  const currentPlConsistency: AuditCheck = {
    title: 'Current P/L consistency — Dashboard/History vs Year Analysis',
    rows: [
      { label: 'Dashboard/History total P/L (all-time, incl. cash)', value: dashboardCurrentPL },
      { label: 'Sum of non-cash per-asset P/L (all-time)', value: nonCashCurrentPL },
      { label: "Cash-like holdings' contribution to Dashboard/History P/L", value: cashCurrentPL },
    ],
    differenceEur: currentPlDiff,
    status: Math.abs(currentPlDiff) <= 1 ? 'ok' : currentPlExplainedByCash ? 'approximate' : 'mismatch',
    explanation:
      Math.abs(currentPlDiff) <= 1
        ? 'No cash-driven gap detected — both totals cover the same (all-time, non-cash) scope.'
        : currentPlExplainedByCash
          ? `The €${cashCurrentPL.toFixed(2)} gap is fully explained by cash-like holdings: Dashboard/History's total P/L does not exclude cash, so a cash balance with no matching deposit transactions is counted there as unrealized profit. Year Analysis correctly excludes it. This is expected, not a bug.`
          : `Difference (€${currentPlDiff.toFixed(2)}) is NOT fully explained by cash (€${cashCurrentPL.toFixed(2)}) — the remaining €${(currentPlDiff - cashCurrentPL).toFixed(2)} needs investigation (possible cost-basis or FX mismatch).`,
  }

  // ---------- 4. Cost basis consistency ----------
  let nonCashCostBasis = 0
  let cashCostBasis = 0
  for (const inv of investments) {
    const m = computeInvestmentMetrics(inv, transactions, fxRates)
    if (isCashLikeInvestment(inv)) cashCostBasis += m.remainingCostBasis
    else nonCashCostBasis += m.remainingCostBasis
  }
  const dashboardTotalInvested = liveMetrics.totalInvested
  const costBasisDiff = dashboardTotalInvested - nonCashCostBasis
  const costBasisExplainedByCash = Math.abs(costBasisDiff - cashCostBasis) <= 1

  const costBasisConsistency: AuditCheck = {
    title: 'Cost basis consistency — Dashboard total invested vs Year Analysis',
    rows: [
      { label: 'Dashboard total invested (incl. cash)', value: dashboardTotalInvested },
      { label: 'Sum of non-cash remaining cost basis', value: nonCashCostBasis },
      { label: "Cash-like holdings' cost basis", value: cashCostBasis },
    ],
    differenceEur: costBasisDiff,
    status: Math.abs(costBasisDiff) <= 1 ? 'ok' : costBasisExplainedByCash ? 'approximate' : 'mismatch',
    explanation:
      Math.abs(costBasisDiff) <= 1
        ? 'No cash-driven gap detected.'
        : costBasisExplainedByCash
          ? "The gap matches cash-like holdings' own cost basis (typically €0, since cash balances rarely have deposit/withdraw transactions) — expected, not a bug."
          : `Unexplained gap of €${(costBasisDiff - cashCostBasis).toFixed(2)} beyond cash — investigate further (a wrong cost basis here would produce a wrong P/L).`,
  }

  // ---------- 5. Cashflow classification audit ----------
  const nonCashRows = assetRows.filter((r) => !r.isCashLike)
  const cashRows = assetRows.filter((r) => r.isCashLike)
  const internalBuys = nonCashRows.reduce((s, r) => s + r.amountBoughtInYearEur, 0)
  const internalSells = nonCashRows.reduce((s, r) => s + r.amountSoldInYearEur, 0)
  const cashMovementIn = cashRows.reduce((s, r) => s + r.amountBoughtInYearEur, 0)
  const cashMovementOut = cashRows.reduce((s, r) => s + r.amountSoldInYearEur, 0)
  const cashflowClassificationDiff =
    summary.grossContributionsInEur - summary.grossContributionsOutEur - summary.netContributionsEur

  const cashflowClassification: AuditCheck = {
    title: 'Cashflow classification audit',
    rows: [
      { label: 'External contributions (in)', value: summary.grossContributionsInEur },
      { label: 'External withdrawals (out)', value: -summary.grossContributionsOutEur },
      { label: 'Net external contributions', value: summary.netContributionsEur },
      { label: 'Internal buys (non-cash assets)', value: internalBuys },
      { label: 'Internal sells (non-cash assets)', value: internalSells },
      { label: 'Fees paid', value: summary.feesPaidEur },
      { label: 'Dividends/interest received', value: summary.dividendsInterestEur },
      { label: 'Cash/free-space deposits (into cash rows)', value: cashMovementIn },
      { label: 'Cash/free-space withdrawals (from cash rows)', value: cashMovementOut },
    ],
    differenceEur: cashflowClassificationDiff,
    status: auditStatus(cashflowClassificationDiff),
    explanation:
      'Internal buys/sells and cash/free-space movements are listed separately from external contributions/withdrawals and are never summed into net external contributions. The difference row validates that gross-in minus gross-out reconstructs net contributions exactly — same source list, split into pieces.',
  }

  return {
    portfolioValueBridge,
    profitLossBridge,
    currentPlConsistency,
    costBasisConsistency,
    cashflowClassification,
  }
}
