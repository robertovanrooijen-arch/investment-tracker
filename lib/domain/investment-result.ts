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
  unrealisedChangeEur: number
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

export type OpenUnrealised = { investmentId: string; unrealisedEur: number }

export type InvestmentResult = {
  asOf: string
  grossUnrealisedGainsEur: number
  grossUnrealisedLossesEur: number // ≤ 0
  netUnrealisedEur: number
  openPositions: OpenUnrealised[]
  period: ResultColumn
  sinceStart: ResultColumn
}

export const RESULT_TOLERANCE_EUR = 0.01

function column(args: {
  investments: Investment[]
  transactions: Transaction[]
  flows: ReturnFlow[]
  fxRates: FxRates
  twr: TwrResult
}): { col: ResultColumn; open: OpenUnrealised[] } {
  const { investments, transactions, flows, fxRates, twr } = args
  const from = twr.startDate
  const to = twr.endDate
  let realised = 0
  let unrealisedStart = 0
  let unrealisedEnd = 0
  let income = 0
  let costs = 0
  let taxes = 0
  let txFees = 0
  const open: OpenUnrealised[] = []

  for (const inv of investments) {
    const txs = transactions
      .filter((t) => t.investment_id === inv.id && t.date <= to)
      .sort((a, b) => (a.date !== b.date ? (a.date < b.date ? -1 : 1) : a.created_at < b.created_at ? -1 : 1))
    let held = 0
    let cost = 0
    let costAtStart = 0
    let heldAtStart = 0
    let passedStart = false
    const markStart = () => {
      if (passedStart) return
      passedStart = true
      costAtStart = cost
      heldAtStart = held
    }
    for (const t of txs) {
      if (t.date > from) markStart()
      const inPeriod = t.date > from
      const fee = txFeeInEur(t, fxRates)
      if (t.type === 'buy' && t.quantity != null) {
        held += t.quantity
        cost += txNativeToEur(tradeGrossNative(t), t, fxRates) + fee
        if (inPeriod) txFees += fee
      } else if (t.type === 'sell' && t.quantity != null) {
        const sale = allocateSale(held, cost, cost, t.quantity)
        if (!sale) continue
        const proceeds = txNativeToEur(tradeGrossNative(t, sale.fractionOfRow), t, fxRates) - fee * sale.fractionOfRow
        if (inPeriod) {
          realised += proceeds - sale.soldCostEur
          txFees += fee * sale.fractionOfRow
        }
        held = sale.closesPosition ? 0 : held - sale.quantity
        cost = sale.closesPosition ? 0 : cost - sale.soldCostEur
      } else if (!inPeriod) {
        continue
      } else if (t.type === 'dividend' || (t.type === 'interest' && !isRewardTransaction(t))) {
        income += txNativeToEur(t.amount ?? 0, t, fxRates)
        taxes += fee
      } else if (t.type === 'fee') {
        const amt = txNativeToEur(t.amount ?? 0, t, fxRates)
        if (feeRowTarget(t).component === 'taxes') taxes += amt
        else costs += amt
      }
    }
    markStart()
    const sleeve = twr.bySleeve[inv.id]
    if (heldAtStart > 0) unrealisedStart += (sleeve?.startValueEur ?? NaN) - costAtStart
    if (held > 0) {
      const u = (sleeve?.endValueEur ?? NaN) - cost
      unrealisedEnd += u
      open.push({ investmentId: inv.id, unrealisedEur: u })
    }
  }
  const unrealisedChange = unrealisedEnd - unrealisedStart
  const total = realised + unrealisedChange + income - costs - taxes
  const sleeves = Object.values(twr.bySleeve)
  const valueStart = sleeves.reduce((s, v) => s + v.startValueEur, 0)
  const valueEnd = sleeves.reduce((s, v) => s + v.endValueEur, 0)
  const netExternal = flows.filter((f) => f.date > from && f.date <= to).reduce((s, f) => s + f.amountEur, 0)
  // Owner-approved cash reconciliations are external for the TWR but no
  // contribution: they are inside twr.externalIn and must be in the check.
  const ledgerExternal = twr.externalInEur - twr.externalOutEur
  const check = valueEnd - valueStart - ledgerExternal
  return {
    col: {
      from, to,
      realisedEur: realised,
      unrealisedStartEur: unrealisedStart,
      unrealisedEndEur: unrealisedEnd,
      unrealisedChangeEur: unrealisedChange,
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
