import type { Investment, Transaction } from '@/types/database'
import type { FxRates } from '@/lib/domain/fx'
import { txFeeInEur, txNativeToEur } from '@/lib/domain/calculations'
import { allocateSale } from '@/lib/domain/cost-basis'
import { tradeGrossNative } from '@/lib/domain/trade-amounts'
import { isRewardTransaction, type ReturnFlow } from '@/lib/domain/flow-classification'
import { feeRowTarget } from '@/lib/domain/twr-ledger'
import type { TwrResult } from '@/lib/domain/twr'

// ---------------------------------------------------------------------------
// Investment result: WHY the result is what it is, in euros.
//
// One replay of the transactions (moving average cost, same rules as the
// rest of the app) and the SAME values as the time-weighted return, so that
//
//   realised + change in unrealised + dividends/interest − separate costs − taxes
//     = (value at end − value at start) − net external cash flow
//
// holds exactly (it is the bookkeeping identity of the records). Every sale
// is counted once: the sold units go to "realised" (at their share of the
// cost), the units still held to "unrealised" (at the remaining cost).
//
// Transaction fees are part of the cost (buys) and of the net proceeds
// (sales), so they are already inside realised and unrealised; they are
// reported for information only and never subtracted a second time.
// ---------------------------------------------------------------------------

export type ResultColumn = {
  from: string // valuation date of the start (close)
  to: string
  realisedEur: number // net proceeds of units sold in the period − their moving-average cost
  unrealisedStartEur: number // value − remaining cost of what was held at the start
  unrealisedEndEur: number // value − remaining cost of what is held at the end
  // Change in unrealised from MARKET moves only: the raw change minus the
  // valuation basis adjustments (a change of valuation source is no result).
  unrealisedChangeEur: number
  valuationBasisAdjustmentEur: number
  dividendsInterestEur: number // gross dividends + interest (rewards are external money, not income)
  costsEur: number // separate cost rows: storage, connection fees, negative interest, ...
  taxesEur: number // withheld on dividends/interest + separate tax rows
  transactionFeesIncludedEur: number // buy/sell fees — already inside realised/unrealised
  totalEur: number
  // Check against the values: (end value − start value) − net external cash flow.
  valueStartEur: number
  valueEndEur: number
  netExternalCashFlowEur: number
  checkEur: number
  differenceEur: number
  reconciled: boolean
}

// One position's share of a column; the rows add up to the column exactly.
export type ResultRow = {
  investmentId: string
  heldAtEnd: number
  remainingCostEur: number // moving-average cost of what is held at the end
  soldCostEur: number // moving-average cost of the units sold in the column
  netProceedsEur: number // their net sale proceeds (after fees)
  realisedEur: number
  unrealisedStartEur: number
  unrealisedEndEur: number
  valuationBasisAdjustmentEur: number
  dividendsInterestEur: number
  costsEur: number
  taxesEur: number
  transactionFeesIncludedEur: number
  totalEur: number
}

export type OpenUnrealised = { investmentId: string; unrealisedEur: number }

export type InvestmentResult = {
  asOf: string
  grossUnrealisedGainsEur: number
  grossUnrealisedLossesEur: number // ≤ 0
  netUnrealisedEur: number
  openPositions: OpenUnrealised[]
  period: ResultColumn & { byInvestment: ResultRow[] }
  sinceStart: ResultColumn & { byInvestment: ResultRow[] }
}

export const RESULT_TOLERANCE_EUR = 0.01

export type Replay = {
  heldAtStart: number
  costAtStart: number
  held: number
  cost: number
  soldCostEur: number
  netProceedsEur: number
  realisedEur: number
  dividendsInterestEur: number
  costsEur: number
  taxesEur: number
  transactionFeesEur: number
}

/**
 * Moving-average replay of one investment's records up to and including
 * `to`; everything booked after `from` counts in the period. The single
 * definition of held quantity, remaining cost and realised result used by
 * the investment result and the central current valuation.
 */
export function replayInvestment(inv: Investment, transactions: Transaction[], fxRates: FxRates, from: string, to: string): Replay {
  const txs = transactions
    .filter((t) => t.investment_id === inv.id && t.date <= to)
    .sort((a, b) => (a.date !== b.date ? (a.date < b.date ? -1 : 1) : a.created_at < b.created_at ? -1 : 1))
  const r: Replay = {
    heldAtStart: 0, costAtStart: 0, held: 0, cost: 0, soldCostEur: 0, netProceedsEur: 0, realisedEur: 0,
    dividendsInterestEur: 0, costsEur: 0, taxesEur: 0, transactionFeesEur: 0,
  }
  let passedStart = false
  const markStart = () => {
    if (passedStart) return
    passedStart = true
    r.costAtStart = r.cost
    r.heldAtStart = r.held
  }
  for (const t of txs) {
    if (t.date > from) markStart()
    const inPeriod = t.date > from
    const fee = txFeeInEur(t, fxRates)
    if (t.type === 'buy' && t.quantity != null) {
      r.held += t.quantity
      r.cost += txNativeToEur(tradeGrossNative(t), t, fxRates) + fee
      if (inPeriod) r.transactionFeesEur += fee
    } else if (t.type === 'sell' && t.quantity != null) {
      const sale = allocateSale(r.held, r.cost, r.cost, t.quantity)
      if (!sale) continue
      const proceeds = txNativeToEur(tradeGrossNative(t, sale.fractionOfRow), t, fxRates) - fee * sale.fractionOfRow
      if (inPeriod) {
        r.realisedEur += proceeds - sale.soldCostEur
        r.soldCostEur += sale.soldCostEur
        r.netProceedsEur += proceeds
        r.transactionFeesEur += fee * sale.fractionOfRow
      }
      r.held = sale.closesPosition ? 0 : r.held - sale.quantity
      r.cost = sale.closesPosition ? 0 : r.cost - sale.soldCostEur
    } else if (!inPeriod) {
      continue
    } else if (t.type === 'dividend' || (t.type === 'interest' && !isRewardTransaction(t))) {
      r.dividendsInterestEur += txNativeToEur(t.amount ?? 0, t, fxRates)
      r.taxesEur += fee
    } else if (t.type === 'fee') {
      const amt = txNativeToEur(t.amount ?? 0, t, fxRates)
      if (feeRowTarget(t).component === 'taxes') r.taxesEur += amt
      else r.costsEur += amt
    }
  }
  markStart()
  return r
}

function column(args: {
  investments: Investment[]
  transactions: Transaction[]
  flows: ReturnFlow[]
  fxRates: FxRates
  twr: TwrResult
}): { col: ResultColumn & { byInvestment: ResultRow[] }; open: OpenUnrealised[] } {
  const { investments, transactions, flows, fxRates, twr } = args
  const from = twr.startDate
  const to = twr.endDate
  const open: OpenUnrealised[] = []
  const rows: ResultRow[] = []

  for (const inv of investments) {
    const r = replayInvestment(inv, transactions, fxRates, from, to)
    const sleeve = twr.bySleeve[inv.id]
    const uStart = r.heldAtStart > 0 ? (sleeve?.startValueEur ?? NaN) - r.costAtStart : 0
    const uEnd = r.held > 0 ? (sleeve?.endValueEur ?? NaN) - r.cost : 0
    const basis = sleeve?.basisAdjustmentEur ?? 0
    if (r.held > 0) open.push({ investmentId: inv.id, unrealisedEur: uEnd })
    const row: ResultRow = {
      investmentId: inv.id,
      heldAtEnd: r.held,
      remainingCostEur: r.cost,
      soldCostEur: r.soldCostEur,
      netProceedsEur: r.netProceedsEur,
      realisedEur: r.realisedEur,
      unrealisedStartEur: uStart,
      unrealisedEndEur: uEnd,
      valuationBasisAdjustmentEur: basis,
      dividendsInterestEur: r.dividendsInterestEur,
      costsEur: r.costsEur,
      taxesEur: r.taxesEur,
      transactionFeesIncludedEur: r.transactionFeesEur,
      totalEur: r.realisedEur + (uEnd - uStart - basis) + r.dividendsInterestEur - r.costsEur - r.taxesEur,
    }
    if (Object.entries(row).some(([k, v]) => k !== 'investmentId' && v !== 0)) rows.push(row)
  }
  const sum = (k: keyof Omit<ResultRow, 'investmentId'>) => rows.reduce((s, x) => s + x[k], 0)
  const realised = sum('realisedEur')
  const unrealisedStart = sum('unrealisedStartEur')
  const unrealisedEnd = sum('unrealisedEndEur')
  const income = sum('dividendsInterestEur')
  const costs = sum('costsEur')
  const taxes = sum('taxesEur')
  const txFees = sum('transactionFeesIncludedEur')
  // Cash sleeves can carry no basis adjustment; positions' are in the rows.
  const basisAdj = twr.valuationBasisAdjustmentEur
  const unrealisedChange = unrealisedEnd - unrealisedStart - basisAdj
  const total = realised + unrealisedChange + income - costs - taxes
  const sleeves = Object.values(twr.bySleeve)
  const valueStart = sleeves.reduce((s, v) => s + v.startValueEur, 0)
  const valueEnd = sleeves.reduce((s, v) => s + v.endValueEur, 0)
  const netExternal = flows.filter((f) => f.date > from && f.date <= to).reduce((s, f) => s + f.amountEur, 0)
  // Owner-approved cash reconciliations are external for the TWR but no
  // contribution: they are inside twr.externalIn and must be in the check.
  const ledgerExternal = twr.externalInEur - twr.externalOutEur
  // A change of valuation basis moves the value without any result.
  const check = valueEnd - valueStart - ledgerExternal - basisAdj
  return {
    col: {
      from, to,
      realisedEur: realised,
      unrealisedStartEur: unrealisedStart,
      unrealisedEndEur: unrealisedEnd,
      unrealisedChangeEur: unrealisedChange,
      valuationBasisAdjustmentEur: basisAdj,
      dividendsInterestEur: income,
      costsEur: costs,
      taxesEur: taxes,
      transactionFeesIncludedEur: txFees,
      totalEur: total,
      valueStartEur: valueStart,
      valueEndEur: valueEnd,
      netExternalCashFlowEur: netExternal,
      checkEur: check,
      differenceEur: total - check,
      reconciled: Math.abs(total - check) <= RESULT_TOLERANCE_EUR,
      byInvestment: rows,
    },
    open,
  }
}

/**
 * Both columns use the TWR of their period (same start and end values).
 * `period` is e.g. YTD, `sinceStart` the all-time TWR (start value 0).
 */
export function computeInvestmentResult(args: {
  investments: Investment[]
  transactions: Transaction[]
  flows: ReturnFlow[]
  fxRates: FxRates
  periodTwr: TwrResult
  sinceStartTwr: TwrResult
}): InvestmentResult {
  const period = column({ ...args, twr: args.periodTwr }).col
  const all = column({ ...args, twr: args.sinceStartTwr })
  const gains = all.open.filter((o) => o.unrealisedEur > 0).reduce((s, o) => s + o.unrealisedEur, 0)
  const losses = all.open.filter((o) => o.unrealisedEur < 0).reduce((s, o) => s + o.unrealisedEur, 0)
  return {
    asOf: args.sinceStartTwr.endDate,
    grossUnrealisedGainsEur: gains,
    grossUnrealisedLossesEur: losses,
    netUnrealisedEur: all.col.unrealisedEndEur,
    openPositions: all.open,
    period,
    sinceStart: all.col,
  }
}
