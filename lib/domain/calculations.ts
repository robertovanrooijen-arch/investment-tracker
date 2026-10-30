import type { Investment, Transaction } from '@/types/database'
import { hasUnits, isCashLikeInvestment } from '@/lib/domain/constants'
import type { FxRates } from '@/lib/domain/fx'
import { allocateSale, isEffectivelyZero } from '@/lib/domain/cost-basis'
import { tradeGrossNative } from '@/lib/domain/trade-amounts'

// ---------- Sorting ----------

function sortChronologically(txs: Transaction[]): Transaction[] {
  return [...txs].sort((a, b) => {
    if (a.date !== b.date) return a.date < b.date ? -1 : 1
    return a.created_at < b.created_at ? -1 : 1
  })
}

// ---------- FX policy ----------
//
// Historical amounts (cost basis, proceeds, fees, income, contributions) are
// converted with the rate that applied WHEN the transaction happened:
//   1. EUR needs no conversion.
//   2. Otherwise the row's own fx_rate_to_eur (the broker's executed rate).
//   3. An IMPORTED row (external_id set) without its own rate is 'missing' —
//      today's rate is never substituted for an old imported transaction.
//   4. A legacy, manually-entered row without its own rate falls back to the
//      live rate (unchanged behaviour), but that is reported as
//      'live_fallback' so the UI can flag the figure as approximate.
//   5. No usable rate at all is 'missing' — never a silent 1.
// Fees use their OWN fee_currency: a EUR fee is never multiplied by a USD
// price rate. A missing conversion yields NaN, which every aggregator below
// skips and counts instead of turning into a made-up number.
// Current valuation (quantity × today's price) legitimately uses today's rate.

export type FxBasis = 'eur' | 'transaction' | 'live_fallback' | 'missing'
export type FxStatus = 'complete' | 'live_rate_fallback' | 'incomplete'

type RateResult = { rate: number | null; basis: FxBasis }

const MISSING: RateResult = { rate: null, basis: 'missing' }

function validRate(rate: number | null | undefined): rate is number {
  return rate != null && Number.isFinite(rate) && rate > 0
}

export function isImportedTransaction(tx: Transaction): boolean {
  return tx.external_id != null
}

/** Today's EUR rate for a currency (EUR = 1), or null when unknown. */
export function currentRateToEur(currency: string, fxRates?: FxRates): number | null {
  if (currency === 'EUR') return 1
  const rate = fxRates?.[currency]
  return validRate(rate) ? rate : null
}

function liveFallback(tx: Transaction, currency: string, fxRates?: FxRates): RateResult {
  if (isImportedTransaction(tx)) return MISSING
  const live = currentRateToEur(currency, fxRates)
  return live === null ? MISSING : { rate: live, basis: 'live_fallback' }
}

/** Rate for the row's price_currency amounts (quantity × price, amount). */
export function txPriceRateToEur(tx: Transaction, fxRates?: FxRates): RateResult {
  const priceCurrency = tx.price_currency ?? 'EUR'
  if (priceCurrency === 'EUR') return { rate: 1, basis: 'eur' }
  if (validRate(tx.fx_rate_to_eur)) return { rate: tx.fx_rate_to_eur, basis: 'transaction' }
  return liveFallback(tx, priceCurrency, fxRates)
}

/** Rate for the row's fee, which may be in a different currency than its price. */
export function txFeeRateToEur(tx: Transaction, fxRates?: FxRates): RateResult {
  const feeCurrency = tx.fee_currency ?? tx.price_currency ?? 'EUR'
  if (feeCurrency === 'EUR') return { rate: 1, basis: 'eur' }
  if (feeCurrency === (tx.price_currency ?? 'EUR')) return txPriceRateToEur(tx, fxRates)
  return liveFallback(tx, feeCurrency, fxRates)
}

/** Convert a transaction's fee to EUR (NaN when its rate is missing). */
export function txFeeInEur(tx: Transaction, fxRates?: FxRates): number {
  const feeAmount = tx.fee ?? 0
  if (feeAmount === 0) return 0
  const { rate } = txFeeRateToEur(tx, fxRates)
  return rate === null ? NaN : feeAmount * rate
}

/**
 * Convert a transaction's fee to its price_currency, so it can be added to
 * native cost basis math. Goes via EUR when fee_currency != price_currency.
 */
export function txFeeInPriceCurrency(tx: Transaction, fxRates?: FxRates): number {
  const feeAmount = tx.fee ?? 0
  if (feeAmount === 0) return 0

  const feeCurrency = tx.fee_currency ?? tx.price_currency ?? 'EUR'
  const priceCurrency = tx.price_currency ?? 'EUR'
  if (feeCurrency === priceCurrency) return feeAmount

  const feeEur = txFeeInEur(tx, fxRates)
  const { rate: priceToEur } = txPriceRateToEur(tx, fxRates)
  return priceToEur === null ? NaN : feeEur / priceToEur
}

/**
 * Convert a native (price_currency) amount to EUR with the row's historical
 * rate (see FX policy above). NaN when the rate is missing.
 */
export function txNativeToEur(
  amountNative: number,
  tx: Transaction,
  fxRates?: FxRates
): number {
  if (amountNative === 0) return 0
  const { rate } = txPriceRateToEur(tx, fxRates)
  return rate === null ? NaN : amountNative * rate
}

/**
 * An amount-based row (fee/dividend/interest) expressed in the INVESTMENT's
 * currency, for the native-currency view. Usually the row is booked in that
 * currency already; a row booked in another currency (e.g. a EUR AutoFX fee on
 * a USD position) is converted via EUR. NaN when a rate is missing.
 */
function txAmountInInvestmentCurrency(
  amount: number,
  tx: Transaction,
  investmentCurrency: string,
  fxRates?: FxRates
): number {
  if (amount === 0) return 0
  if ((tx.price_currency ?? 'EUR') === investmentCurrency) return amount
  const eur = txNativeToEur(amount, tx, fxRates)
  if (investmentCurrency === 'EUR') return eur
  const investmentRate =
    tx.price_currency === investmentCurrency && validRate(tx.fx_rate_to_eur)
      ? tx.fx_rate_to_eur
      : currentRateToEur(investmentCurrency, fxRates)
  return investmentRate === null ? NaN : eur / investmentRate
}

/** Every FX conversion a transaction needs, for status reporting. */
function txFxBases(tx: Transaction, fxRates?: FxRates): FxBasis[] {
  const bases: FxBasis[] = []
  const hasPriceAmount =
    (tx.quantity != null && tx.price_per_unit != null && tx.quantity * tx.price_per_unit !== 0) ||
    (tx.amount != null && tx.amount !== 0)
  if (hasPriceAmount) bases.push(txPriceRateToEur(tx, fxRates).basis)
  if ((tx.fee ?? 0) !== 0) bases.push(txFeeRateToEur(tx, fxRates).basis)
  return bases
}

/**
 * FX completeness of one investment's figures:
 *  - 'incomplete'          a historical or current conversion is missing;
 *  - 'live_rate_fallback'  some legacy row was converted at today's rate;
 *  - 'complete'            every conversion used a known rate.
 */
export function investmentFxStatus(
  investment: Investment,
  transactions: Transaction[],
  fxRates: FxRates | undefined,
  needsCurrentValuation: boolean
): FxStatus {
  let fallback = false
  for (const tx of transactions) {
    if (tx.investment_id !== investment.id) continue
    for (const basis of txFxBases(tx, fxRates)) {
      if (basis === 'missing') return 'incomplete'
      if (basis === 'live_fallback') fallback = true
    }
  }
  if (needsCurrentValuation && fxRates && currentRateToEur(investment.currency ?? 'EUR', fxRates) === null) {
    return 'incomplete'
  }
  return fallback ? 'live_rate_fallback' : 'complete'
}

// ---------- Income (dividend / interest) ----------

/** The date an income row belongs to: its value date when known, else the booking date. */
export function incomeDate(tx: Pick<Transaction, 'date' | 'value_date'>): string {
  return tx.value_date ?? tx.date
}

export function isIncomeTransaction(tx: Transaction): boolean {
  return tx.type === 'dividend' || tx.type === 'interest'
}

/**
 * EUR value of an income row (dividend, or interest such as a staking reward
 * or platform bonus). `amount` is the GROSS income in the row's
 * price_currency; anything withheld on the same row (e.g. dividend tax
 * recorded in `fee`) is netted out. Tax booked as a separate 'fee'
 * transaction is NOT seen here — it reduces realized P/L through the 'fee'
 * branch instead, so it is never subtracted twice.
 *
 * Shared by computeInvestmentMetrics (Dashboard, History, Profit/Loss,
 * snapshots) and year-analysis.ts (Year Analysis, YTD) so both always book
 * the exact same net income.
 */
export function txIncomeInEur(
  tx: Transaction,
  fxRates?: FxRates
): { grossEur: number; feeEur: number; netEur: number } {
  const grossEur = txNativeToEur(tx.amount ?? 0, tx, fxRates)
  const feeEur = txFeeInEur(tx, fxRates)
  return { grossEur, feeEur, netEur: grossEur - feeEur }
}

// ---------- Per-investment metrics ----------

export type InvestmentMetrics = {
  quantity: number | null
  currentValue: number
  remainingCostBasis: number
  // Realized P/L = tradeRealizedProfit + net income − separate fee rows.
  realizedProfit: number
  unrealizedProfit: number
  totalProfit: number
  // Sum of every purchase cost ever (re-bought money counted again). Kept for
  // reference only — NOT a return denominator (see resultVsPurchaseVolumePct).
  totalEverInvested: number
  // totalProfit / totalEverInvested. NOT a return: money that is sold and
  // re-bought is counted again in the denominator. Show only with that label.
  resultVsPurchaseVolumePct: number | null
  // ── Realized return on what was sold (moving average, see cost-basis.ts) ──
  saleProceeds: number        // net proceeds of all sales (gross − fee)
  soldCostBasis: number       // cost basis assigned to those sales
  tradeRealizedProfit: number // saleProceeds − soldCostBasis
  // tradeRealizedProfit / soldCostBasis; null when nothing was sold.
  realizedReturnPct: number | null
  // ── Unrealized return on what is still held ──
  // unrealizedProfit / remainingCostBasis; null when nothing is held.
  unrealizedReturnPct: number | null
  // Net dividend/interest and separate fee rows (already inside realizedProfit).
  incomeNet: number
  separateFees: number
  isClosed: boolean
  hasActivity: boolean
  averageBuyPrice: number | null
  // EUR completeness of the figures above (always 'complete' in the native,
  // no-fxRates view). 'incomplete' figures contain NaN where a rate is
  // missing; aggregators skip and count them rather than invent a value.
  fxStatus: FxStatus
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
    let totalEverInvestedNative = 0
    let totalEverInvestedEur = 0
    let proceedsNative = 0
    let proceedsEur = 0
    let soldCostNative = 0
    let soldCostEur = 0
    let incomeNative = 0
    let incomeEur = 0
    let feesNative = 0
    let feesEur = 0

    for (const tx of txs) {
      if (tx.type === 'buy' && tx.quantity !== null && tx.price_per_unit !== null) {
        // Exact broker/invoice gross where the source defines it (trade-amounts.ts).
        const grossNative = tradeGrossNative(tx)
        const costNative = grossNative + txFeeInPriceCurrency(tx, fxRates)
        const costEur = txNativeToEur(grossNative, tx, fxRates) + txFeeInEur(tx, fxRates)

        sharesHeld += tx.quantity
        costBasisNative += costNative
        costBasisEur += costEur
        totalEverInvestedNative += costNative
        totalEverInvestedEur += costEur
      } else if (tx.type === 'sell' && tx.quantity !== null && tx.price_per_unit !== null) {
        const sale = allocateSale(sharesHeld, costBasisNative, costBasisEur, tx.quantity)
        if (sale) {
          const grossNative = tradeGrossNative(tx, sale.fractionOfRow)
          const feeShare = sale.fractionOfRow
          const netNative = grossNative - txFeeInPriceCurrency(tx, fxRates) * feeShare
          const netEur = txNativeToEur(grossNative, tx, fxRates) - txFeeInEur(tx, fxRates) * feeShare

          proceedsNative += netNative
          proceedsEur += netEur
          soldCostNative += sale.soldCostNative
          soldCostEur += sale.soldCostEur
          costBasisNative -= sale.soldCostNative
          costBasisEur -= sale.soldCostEur
          sharesHeld -= sale.quantity
          if (sale.closesPosition) {
            // Economically zero: no floating-point residue may remain.
            sharesHeld = 0
            costBasisNative = 0
            costBasisEur = 0
          }
        }
      } else if (tx.type === 'fee') {
        // A separate fee row (e.g. dividend tax, an AutoFX charge booked in
        // EUR on a USD position) reduces realized P/L in its own currency.
        feesNative += txAmountInInvestmentCurrency(tx.amount ?? 0, tx, priceCurrency, fxRates)
        feesEur += txNativeToEur(tx.amount ?? 0, tx, fxRates)
      } else if (isIncomeTransaction(tx)) {
        // Dividend / interest on a unit-based holding is realized profit. It
        // never changes quantity or cost basis.
        incomeNative +=
          txAmountInInvestmentCurrency(tx.amount ?? 0, tx, priceCurrency, fxRates) -
          txAmountInInvestmentCurrency(txFeeInPriceCurrency(tx, fxRates), tx, priceCurrency, fxRates)
        incomeEur += txIncomeInEur(tx, fxRates).netEur
      }
    }

    const held = sharesHeld > 0 && !isEffectivelyZero(sharesHeld)
    if (!held) sharesHeld = Math.max(0, sharesHeld)

    const priceNative = investment.current_price ?? 0
    const currentValueNative = held ? sharesHeld * priceNative : 0
    // Current valuation: today's rate is correct here; unknown → NaN, not 1.
    const currentValueEur =
      currentValueNative === 0
        ? 0
        : currentValueNative * (currentRateToEur(priceCurrency, fxRates) ?? NaN)
    const fxStatus: FxStatus = wantEur
      ? investmentFxStatus(investment, txs, fxRates, held)
      : 'complete'

    const tradeRealizedNative = proceedsNative - soldCostNative
    const tradeRealizedEur = proceedsEur - soldCostEur
    const realizedNative = tradeRealizedNative + incomeNative - feesNative
    const realizedEur = tradeRealizedEur + incomeEur - feesEur

    const unrealizedNative = held ? currentValueNative - costBasisNative : 0
    const unrealizedEur = held ? currentValueEur - costBasisEur : 0

    const ratio = (num: number, den: number) => (Number.isFinite(num) && den > 0 ? num / den : null)
    const isClosed = hasActivity && !held

    const pick = <T,>(eur: T, native: T) => (wantEur ? eur : native)
    return {
      quantity: held ? sharesHeld : 0,
      currentValue: pick(currentValueEur, currentValueNative),
      remainingCostBasis: held ? pick(costBasisEur, costBasisNative) : 0,
      realizedProfit: pick(realizedEur, realizedNative),
      unrealizedProfit: pick(unrealizedEur, unrealizedNative),
      totalProfit: pick(realizedEur + unrealizedEur, realizedNative + unrealizedNative),
      totalEverInvested: pick(totalEverInvestedEur, totalEverInvestedNative),
      resultVsPurchaseVolumePct: pick(
        ratio(realizedEur + unrealizedEur, totalEverInvestedEur),
        ratio(realizedNative + unrealizedNative, totalEverInvestedNative)
      ),
      saleProceeds: pick(proceedsEur, proceedsNative),
      soldCostBasis: pick(soldCostEur, soldCostNative),
      tradeRealizedProfit: pick(tradeRealizedEur, tradeRealizedNative),
      realizedReturnPct: pick(ratio(tradeRealizedEur, soldCostEur), ratio(tradeRealizedNative, soldCostNative)),
      unrealizedReturnPct: held
        ? pick(ratio(unrealizedEur, costBasisEur), ratio(unrealizedNative, costBasisNative))
        : null,
      incomeNet: pick(incomeEur, incomeNative),
      separateFees: pick(feesEur, feesNative),
      isClosed,
      hasActivity,
      averageBuyPrice: held ? pick(costBasisEur, costBasisNative) / sharesHeld : null,
      fxStatus,
    }
  }

 // Non-unit types: cash / real estate / custom
 let investedNative = 0
 let investedEur = 0
 let incomeNative = 0
 let incomeEur = 0
 let feesNative = 0
 let feesEur = 0
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
   } else if (isIncomeTransaction(tx)) {
     // Interest/dividend is realized income; doesn't change cost basis.
     incomeNative += (tx.amount ?? 0) - txFeeInPriceCurrency(tx, fxRates)
     incomeEur += txIncomeInEur(tx, fxRates).netEur
   } else if (tx.type === 'fee') {
     // Fee transactions reduce realized profit; don't change cost basis.
     feesNative += txAmountInInvestmentCurrency(tx.amount ?? 0, tx, priceCurrency, fxRates)
     feesEur += txNativeToEur(tx.amount ?? 0, tx, fxRates)
   }
 }
 const realizedNative = incomeNative - feesNative
 const realizedEur = incomeEur - feesEur

 const currentValueNative = investment.current_value ?? 0
 const currentValueEur =
   currentValueNative === 0
     ? 0
     : currentValueNative * (currentRateToEur(priceCurrency, fxRates) ?? NaN)
 const nonUnitFxStatus: FxStatus = wantEur
   ? investmentFxStatus(investment, txs, fxRates, currentValueNative !== 0)
   : 'complete'

 // Unrealized = the gap between actual current value and what we've already
 // accounted for via cost basis + realized income. Subtracting realized
 // prevents double-counting interest that was auto-added to current_value.
 const unrealizedNative = currentValueNative - investedNative - realizedNative
 const unrealizedEur = currentValueEur - investedEur - realizedEur

 const ratio = (num: number, den: number) => (Number.isFinite(num) && den > 0 ? num / den : null)
 const pick = <T,>(eur: T, native: T) => (wantEur ? eur : native)
 return {
   quantity: null,
   currentValue: pick(currentValueEur, currentValueNative),
   remainingCostBasis: pick(investedEur, investedNative),
   realizedProfit: pick(realizedEur, realizedNative),
   unrealizedProfit: pick(unrealizedEur, unrealizedNative),
   totalProfit: pick(realizedEur + unrealizedEur, realizedNative + unrealizedNative),
   totalEverInvested: pick(totalEverInvestedEur, totalEverInvestedNative),
   resultVsPurchaseVolumePct: pick(
     ratio(realizedEur + unrealizedEur, totalEverInvestedEur),
     ratio(realizedNative + unrealizedNative, totalEverInvestedNative)
   ),
   saleProceeds: 0,
   soldCostBasis: 0,
   tradeRealizedProfit: 0,
   realizedReturnPct: null,
   unrealizedReturnPct: pick(ratio(unrealizedEur, investedEur), ratio(unrealizedNative, investedNative)),
   incomeNet: pick(incomeEur, incomeNative),
   separateFees: pick(feesEur, feesNative),
   isClosed: false,
   hasActivity,
   averageBuyPrice: null,
   fxStatus: nonUnitFxStatus,
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
  // totalProfit / totalEverInvested — NOT a portfolio return (sold-and-re-bought
  // money is counted again in the denominator). Show only with that label;
  // use allTimeMoneyWeightedReturn (XIRR) / modifiedDietz for returns.
  resultVsPurchaseVolumePct: number | null
  // Positions whose EUR figures could not be fully converted (missing FX).
  // FAIL-CLOSED: an unknown position figure makes the matching total unknown
  // (NaN → shown as '—'); a partial sum is never presented as the total.
  fxIncompleteCount: number
  // True only when every total above is a known, complete number.
  complete: boolean
  // Positions with at least one legacy row converted at today's rate.
  fxLiveFallbackCount: number
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
  let fxIncompleteCount = 0
  let fxLiveFallbackCount = 0

  for (const inv of investments) {
    const m = computeInvestmentMetrics(inv, transactions, fxRates)
    // Cash-like holdings (uninvested broker cash, "free space" balances)
    // still count toward portfolio value/invested — they're real money in
    // the portfolio. They're excluded from realized/unrealized P/L: a cash
    // balance with no matching deposit/withdraw transactions has no cost
    // basis, so currentValue - 0 is not profit, it's just the balance.
    //
    // totalEverInvested is excluded here too — it's the denominator of
    // resultVsPurchaseVolumePct below, and that numerator (totalProfit) already
    // excludes cash. Including cash's deposit/withdrawal history only in
    // the denominator silently understated the real cost-basis return,
    // since a cash account's own totalEverInvested can be large (every
    // historical deposit/withdrawal) while contributing zero profit.
    if (m.fxStatus === 'incomplete') fxIncompleteCount++
    else if (m.fxStatus === 'live_rate_fallback') fxLiveFallbackCount++

    // Plain sums on purpose: NaN (unknown) propagates, so an incomplete
    // portfolio never shows a believable-but-too-low total.
    totalValue += m.currentValue
    totalInvested += m.remainingCostBasis
    if (!isCashLikeInvestment(inv)) {
      totalRealized += m.realizedProfit
      totalUnrealized += m.unrealizedProfit
      totalEverInvested += m.totalEverInvested
    }
  }

  const totalProfit = totalRealized + totalUnrealized
  const resultVsPurchaseVolumePct =
    Number.isFinite(totalProfit) && totalEverInvested > 0 ? totalProfit / totalEverInvested : null
  const complete =
    fxIncompleteCount === 0 &&
    [totalValue, totalInvested, totalRealized, totalUnrealized, totalEverInvested].every(Number.isFinite)

  return {
    totalValue,
    totalInvested,
    totalRealized,
    totalUnrealized,
    totalProfit,
    totalEverInvested,
    resultVsPurchaseVolumePct,
    fxIncompleteCount,
    fxLiveFallbackCount,
    complete,
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
    // Fail-closed: one unknown value makes every percentage wrong, so no
    // allocation is returned at all (the page shows the FX notice instead).
    if (Number.isNaN(currentValue)) return []
    if (!(currentValue > 0)) continue

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

// ---------- Performance by category (all-time, since inception) ----------

export type CategoryPerformance = {
  key: string
  totalProfit: number
  totalEverInvested: number
  // Same caveat as PortfolioMetrics.resultVsPurchaseVolumePct: not a return.
  resultVsPurchaseVolumePct: number | null
}

/**
 * All-time (since-inception) P/L grouped by an arbitrary key — same
 * cash-exclusion rule as computePortfolioMetrics (a cash balance has no cost
 * basis, so it never contributes fake profit/loss), and the same
 * computeInvestmentMetrics values the Dashboard's totals come from. This is
 * deliberately NOT the same metric as a year-scoped AssetClassYtd row (see
 * lib/domain/year-analysis.ts) — this is "since inception", that is
 * "selected calendar year" — both are legitimate, different questions.
 */
export function computePerformanceByCategory(
  investments: Investment[],
  transactions: Transaction[],
  keyFn: (inv: Investment) => string,
  fxRates?: FxRates
): CategoryPerformance[] {
  const buckets = new Map<string, { totalProfit: number; totalEverInvested: number }>()

  for (const inv of investments) {
    if (isCashLikeInvestment(inv)) continue
    // An unknown figure makes that bucket unknown (NaN), never a partial sum.
    const m = computeInvestmentMetrics(inv, transactions, fxRates)

    const k = keyFn(inv)
    const bucket = buckets.get(k) ?? { totalProfit: 0, totalEverInvested: 0 }
    bucket.totalProfit += m.totalProfit
    bucket.totalEverInvested += m.totalEverInvested
    buckets.set(k, bucket)
  }

  const rows: CategoryPerformance[] = []
  for (const [key, b] of buckets) {
    rows.push({
      key,
      totalProfit: b.totalProfit,
      totalEverInvested: b.totalEverInvested,
      resultVsPurchaseVolumePct:
        Number.isFinite(b.totalProfit) && b.totalEverInvested > 0 ? b.totalProfit / b.totalEverInvested : null,
    })
  }

  rows.sort((a, b) => b.totalProfit - a.totalProfit)
  return rows
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
    const grossNative = tradeGrossNative(tx)
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
    const grossNative = tradeGrossNative(tx)
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