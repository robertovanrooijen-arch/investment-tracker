import type { Investment, Transaction, InvestmentType, CapitalFlowDirection } from '@/types/database'
import { hasUnits } from '@/lib/domain/constants'
import type { FxRates } from '@/lib/domain/fx'
import {
  computeInvestmentMetrics,
  txAmountInEur,
  txFeeInEur,
  txFeeInPriceCurrency,
} from '@/lib/domain/calculations'
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
 * Cash-like holdings (uninvested broker cash, "free space" balances) don't
 * have a cost basis, so current value minus zero cost basis is not profit —
 * it's just the balance. Matched by type first; the name check is a fallback
 * for cash sitting in a row that wasn't tagged 'cash'.
 */
export function isCashLikeInvestment(investment: Investment): boolean {
  if (investment.type === 'cash') return true
  return /vrije?\s*ruimte|free\s*cash|cash\s*balance/i.test(investment.name)
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
type DatedCashFlow = { date: string; amountEur: number }

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
