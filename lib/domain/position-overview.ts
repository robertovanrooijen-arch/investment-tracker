import type { Investment, Transaction } from '@/types/database'
import type { FxRates } from '@/lib/domain/fx'
import { computeInvestmentMetrics, txFeeInEur, txNativeToEur } from '@/lib/domain/calculations'
import { allocateSale } from '@/lib/domain/cost-basis'
import { tradeGrossNative } from '@/lib/domain/trade-amounts'
import { quantityOn, unitPriceOn, type PriceSeries } from '@/lib/valuation/historical-valuation'
import { feeRowTarget, type LedgerResult } from '@/lib/domain/twr-ledger'
import type { TwrResult } from '@/lib/domain/twr'

// ---------------------------------------------------------------------------
// Position tables next to the portfolio TWR. Every position that was held at
// any time in the period appears: the open ones and the (partly) sold ones,
// so the portfolio return is never explained by today's holdings alone.
// ---------------------------------------------------------------------------

export const PERSONAL_RETURN_EXPLANATION =
  'Your return since you bought = (value now + net sale proceeds + dividends − separate costs − all purchases incl. fees) ÷ all purchases incl. fees — for the current holding, i.e. since it was last opened from zero.'

export type OpenPositionRow = {
  investmentId: string
  name: string
  platform: string
  firstBuyDate: string | null // first purchase of the current holding
  openedInPeriod: boolean // nothing was held at the period start
  quantity: number
  unit: string | null
  currency: string
  startPrice: { price: number; currency: string; date: string } | null // market close at the period start (per unit)
  endPrice: { price: number; currency: string; date: string } | null // market close at the period end
  averageCostEur: number | null // remaining cost basis per unit (EUR, moving average)
  marketReturn: number | null // instrument price change over the period (own currency, excl. dividend)
  totalMarketReturn: null // instrument incl. dividend: no reliable dividend series → not shown
  personalReturn: number | null // see PERSONAL_RETURN_EXPLANATION
  hasRebuysAfterSale: boolean
  unrealizedEur: number
  periodGainEur: number | null // from the TWR ledger (value change + income − costs in the period)
  contribution: number | null // percentage points of the portfolio TWR (fraction)
  ownTwr: number | null
  valueSource: string
  quality: string
}

export type ClosedPositionRow = {
  investmentId: string
  name: string
  platform: string
  fullyClosed: boolean
  buyFrom: string | null
  buyTo: string | null
  sellFrom: string
  sellTo: string
  soldCostEur: number
  netProceedsEur: number
  realizedEur: number
  realizedReturn: number | null
  incomeEur: number // dividends net of withholding, in the period
  costsEur: number // separate position fee rows in the period (storage, dividend tax, ...)
  // Only for fully closed positions; a partly sold position's result and
  // contribution are in the open-positions table (never counted twice).
  periodGainEur: number | null
  contribution: number | null
}

export function buildPositionOverview(args: {
  investments: Investment[]
  transactions: Transaction[]
  ledger: LedgerResult
  twr: TwrResult
  prices: Map<string, PriceSeries>
  fxRates: FxRates
  periodStart: string // valuation date of the start (close)
  periodEnd: string
}): { open: OpenPositionRow[]; closed: ClosedPositionRow[] } {
  const { investments, transactions, twr, prices, fxRates, periodStart, periodEnd, ledger } = args
  const anchored = new Set(ledger.anchorFactors.map((a) => a.investmentId))
  const open: OpenPositionRow[] = []
  const closed: ClosedPositionRow[] = []

  for (const inv of investments) {
    const txs = transactions
      .filter((t) => t.investment_id === inv.id)
      .sort((a, b) => (a.date !== b.date ? (a.date < b.date ? -1 : 1) : a.created_at < b.created_at ? -1 : 1))
    if (!txs.length) continue
    // The TWR may end earlier than the table (truncated at a data gap): a
    // position traded after its end date has no reliable period figures.
    const sleeve = twr.status === 'ok' && !txs.some((t) => t.date > twr.endDate) ? twr.bySleeve[inv.id] : undefined
    const buys = txs.filter((t) => t.type === 'buy')

    // Moving-average replay up to the period end, collecting the sales inside the period.
    let held = 0
    let costEur = 0
    let soldCostEur = 0
    let netProceedsEur = 0
    let incomeEur = 0
    let costsEur = 0
    let sawSale = false
    let hasRebuysAfterSale = false
    const sells: string[] = []
    // The CURRENT holding cycle: since the position was last opened from 0.
    // A position that was fully sold and bought again starts a new cycle;
    // the earlier cycle's result belongs to that earlier holding.
    let cycle = { start: null as string | null, buys: 0, proceeds: 0, income: 0, fees: 0 }
    for (const t of txs) {
      if (t.date > periodEnd) break
      const inPeriod = t.date > periodStart
      if (t.type === 'buy' && t.quantity != null) {
        if (sawSale) hasRebuysAfterSale = true
        if (!(held > 0)) cycle = { start: t.date, buys: 0, proceeds: 0, income: 0, fees: 0 }
        const cost = txNativeToEur(tradeGrossNative(t), t, fxRates) + txFeeInEur(t, fxRates)
        held += t.quantity
        costEur += cost
        cycle.buys += cost
      } else if (t.type === 'sell' && t.quantity != null) {
        sawSale = true
        const sale = allocateSale(held, costEur, costEur, t.quantity)
        if (!sale) continue
        const proceeds = txNativeToEur(tradeGrossNative(t, sale.fractionOfRow), t, fxRates) - txFeeInEur(t, fxRates) * sale.fractionOfRow
        cycle.proceeds += proceeds
        if (inPeriod) {
          soldCostEur += sale.soldCostEur
          netProceedsEur += proceeds
          sells.push(t.date)
        }
        held = sale.closesPosition ? 0 : held - sale.quantity
        costEur = sale.closesPosition ? 0 : costEur - sale.soldCostEur
      } else if (t.type === 'dividend') {
        // Interest is earned on broker cash (see twr-ledger), not by the
        // position it happens to be booked on.
        const net = txNativeToEur(t.amount ?? 0, t, fxRates) - txFeeInEur(t, fxRates)
        cycle.income += net
        if (inPeriod) incomeEur += net
      } else if (t.type === 'fee' && feeRowTarget(t).level === 'position') {
        const amt = txNativeToEur(t.amount ?? 0, t, fxRates)
        cycle.fees += amt
        if (inPeriod) costsEur += amt
      }
    }
    const heldAtStart = quantityOn(inv, txs, periodStart)

    if (sells.length) {
      const buysBefore = buys.filter((b) => b.date <= sells[sells.length - 1])
      closed.push({
        investmentId: inv.id, name: inv.name, platform: inv.platform, fullyClosed: held === 0,
        buyFrom: buysBefore[0]?.date ?? null, buyTo: buysBefore[buysBefore.length - 1]?.date ?? null,
        sellFrom: sells[0], sellTo: sells[sells.length - 1],
        soldCostEur, netProceedsEur, realizedEur: netProceedsEur - soldCostEur,
        realizedReturn: soldCostEur > 0 ? (netProceedsEur - soldCostEur) / soldCostEur : null,
        incomeEur, costsEur,
        periodGainEur: held === 0 ? sleeve?.gainEur ?? null : null,
        contribution: held === 0 ? sleeve?.contribution ?? null : null,
      })
    }
    if (!(held > 0)) continue

    const m = computeInvestmentMetrics(inv, txs, fxRates)
    // Valued like the TWR (same end value), not with a different live price.
    const endValue = sleeve ? sleeve.endValueEur : m.currentValue
    const personalResult = endValue + cycle.proceeds + cycle.income - cycle.fees - cycle.buys
    const startPrice = unitPriceOn(inv, periodStart, prices)
    // Today's exchange close is often not published yet: the app's live quote
    // of the same day is the price "now" (same rule as the TWR ledger).
    const live =
      inv.current_price != null && inv.price_last_updated_at?.slice(0, 10) === periodEnd
        ? { price: Number(inv.current_price), currency: inv.currency ?? 'EUR', date: periodEnd }
        : null
    const endPrice = live ?? unitPriceOn(inv, periodEnd, prices)
    const metal = inv.type === 'commodity'
    open.push({
      investmentId: inv.id,
      name: inv.name,
      platform: inv.platform,
      firstBuyDate: cycle.start,
      openedInPeriod: !(heldAtStart > 0),
      quantity: held,
      unit: inv.quantity_unit ?? null,
      currency: inv.currency ?? 'EUR',
      startPrice,
      endPrice,
      averageCostEur: held > 0 ? costEur / held : null,
      marketReturn: startPrice && endPrice ? endPrice.price / startPrice.price - 1 : null,
      totalMarketReturn: null,
      personalReturn: cycle.buys > 0 && Number.isFinite(personalResult) ? personalResult / cycle.buys : null,
      hasRebuysAfterSale,
      unrealizedEur: endValue - costEur,
      periodGainEur: sleeve?.gainEur ?? null,
      contribution: sleeve?.contribution ?? null,
      ownTwr: sleeve?.ownReturn ?? null,
      valueSource: metal
        ? anchored.has(inv.id) ? 'Statement value + COMEX movement (benchmark)' : 'COMEX benchmark only (estimate)'
        : anchored.has(inv.id) ? 'Statement value + Yahoo closes' : 'Yahoo closes',
      quality: metal && !anchored.has(inv.id) ? 'estimated' : 'reconstructed',
    })
  }
  open.sort((a, b) => (b.contribution ?? -Infinity) - (a.contribution ?? -Infinity))
  closed.sort((a, b) => (b.contribution ?? -Infinity) - (a.contribution ?? -Infinity))
  return { open, closed }
}
