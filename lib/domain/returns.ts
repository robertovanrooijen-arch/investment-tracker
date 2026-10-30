import type { InvestmentMetrics } from '@/lib/domain/calculations'

// ---------------------------------------------------------------------------
// Return definitions. Each is a different question; never interchange them.
//
// 1. Realized return (per position): what was SOLD.
//      numerator   = net sale proceeds − cost basis assigned to the sales
//      denominator = cost basis assigned to the sales (moving average)
// 2. Unrealized return (per open position): what is still HELD.
//      numerator   = current value − remaining cost basis
//      denominator = remaining cost basis
// 3. Portfolio YTD return: Modified Dietz on EXTERNAL cash flows only.
//      numerator   = end value − start value − net external flows
//      denominator = start value + time-weighted external flows
// 4. All-time money-weighted return: XIRR (annualised) on EXTERNAL cash
//    flows: deposits negative, withdrawals positive, current value positive
//    at the valuation date.
//
// "Result / cumulative purchase volume" (totalProfit / totalEverInvested) is
// NOT a return: money that is sold and re-invested enters its denominator
// again, so the same euro is counted several times.
// ---------------------------------------------------------------------------

export type DatedAmount = { date: string; amount: number }

const MS_PER_DAY = 86_400_000

function daysBetween(fromIso: string, toIso: string): number {
  return (Date.parse(`${toIso.slice(0, 10)}T00:00:00Z`) - Date.parse(`${fromIso.slice(0, 10)}T00:00:00Z`)) / MS_PER_DAY
}

export type XirrResult =
  | { status: 'unique'; rate: number; roots: number[] }
  | { status: 'none'; rate: null; roots: number[] }
  | { status: 'multiple'; rate: null; roots: number[] }
  | { status: 'invalid'; rate: null; roots: number[] }

/**
 * All real XIRR roots: rates r with Σ amount_i / (1 + r)^(days_i / 365) = 0
 * (actual/365 day count, days from the earliest flow). Amounts are signed
 * from the investor's view: money in negative, money out (and the final
 * value) positive.
 *
 * The NPV is scanned on a dense grid of ln(1 + r) from r ≈ −99.99% to
 * +10,000%, every sign change is refined by bisection, and the result is
 * classified. With more than one root the rate is NOT unambiguous and no
 * percentage is returned — never an arbitrary pick.
 */
export function xirrDetailed(flows: DatedAmount[]): XirrResult {
  const valid = flows.filter((f) => f.amount !== 0)
  if (valid.length < 2 || !valid.every((f) => Number.isFinite(f.amount) && Number.isFinite(Date.parse(f.date)))) {
    return { status: 'invalid', rate: null, roots: [] }
  }
  if (!valid.some((f) => f.amount < 0) || !valid.some((f) => f.amount > 0)) return { status: 'none', rate: null, roots: [] }
  const first = valid.reduce((m, f) => (f.date < m ? f.date : m), valid[0].date)
  const terms = valid.map((f) => ({ t: daysBetween(first, f.date) / 365, a: f.amount }))
  if (terms.every((x) => x.t === 0)) return { status: 'invalid', rate: null, roots: [] }

  // NPV as a function of x = ln(1 + r): Σ a · e^(−x·t). Smooth and finite on the grid.
  const npvX = (x: number) => terms.reduce((s, k) => s + k.a * Math.exp(-x * k.t), 0)
  const LO = Math.log(1e-4) // r ≈ −99.99%
  const HI = Math.log(101) // r = +10,000%
  const STEPS = 4000
  const roots: number[] = []
  let px = LO
  let pv = npvX(px)
  for (let i = 1; i <= STEPS; i++) {
    const x = LO + ((HI - LO) * i) / STEPS
    const v = npvX(x)
    if (pv === 0) roots.push(Math.exp(px) - 1)
    else if (pv * v < 0) {
      let a = px
      let b = x
      let fa = pv
      for (let k = 0; k < 200 && b - a > 1e-15; k++) {
        const m = (a + b) / 2
        const fm = npvX(m)
        if (fa * fm <= 0) b = m
        else {
          a = m
          fa = fm
        }
      }
      roots.push(Math.exp((a + b) / 2) - 1)
    }
    px = x
    pv = v
  }
  if (roots.length === 1) return { status: 'unique', rate: roots[0], roots }
  if (roots.length === 0) return { status: 'none', rate: null, roots }
  return { status: 'multiple', rate: null, roots }
}

/** The XIRR rate when it is unique; null otherwise (no root, several roots, invalid input). */
export function xirr(flows: DatedAmount[]): number | null {
  return xirrDetailed(flows).rate
}

export type ExternalFlow = { date: string; amountEur: number } // + into the portfolio, − out of it

export type MoneyWeightedReturn = {
  // Annualised XIRR as a fraction (0.223 = 22.3% per year), or null.
  annualRate: number | null
  netContributionsEur: number
  grossInEur: number
  grossOutEur: number
  firstFlowDate: string | null
  valuationDate: string
  valuationEur: number
  unavailableReason: string | null
}

/**
 * All-time money-weighted return on EXTERNAL flows only (capital flows /
 * legacy contribution rows — never buys, sells or reinvestments).
 */
export function allTimeMoneyWeightedReturn(
  externalFlows: ExternalFlow[],
  valuationEur: number,
  valuationDate: string
): MoneyWeightedReturn {
  const grossInEur = externalFlows.filter((f) => f.amountEur > 0).reduce((s, f) => s + f.amountEur, 0)
  const grossOutEur = externalFlows.filter((f) => f.amountEur < 0).reduce((s, f) => s - f.amountEur, 0)
  const base = {
    netContributionsEur: grossInEur - grossOutEur,
    grossInEur,
    grossOutEur,
    firstFlowDate: externalFlows.length ? externalFlows.reduce((m, f) => (f.date < m ? f.date : m), externalFlows[0].date) : null,
    valuationDate,
    valuationEur,
  }
  if (!Number.isFinite(valuationEur)) {
    return { ...base, annualRate: null, unavailableReason: 'Current portfolio value is incomplete (missing FX or price).' }
  }
  if (externalFlows.some((f) => !Number.isFinite(f.amountEur))) {
    return { ...base, annualRate: null, unavailableReason: 'An external cash flow has no known EUR amount.' }
  }
  if (grossInEur <= 0) {
    return { ...base, annualRate: null, unavailableReason: 'No external contributions recorded.' }
  }
  const result = xirrDetailed([
    ...externalFlows.map((f) => ({ date: f.date, amount: -f.amountEur })),
    { date: valuationDate, amount: valuationEur },
  ])
  return {
    ...base,
    annualRate: result.rate,
    unavailableReason:
      result.status === 'unique'
        ? null
        : result.status === 'multiple'
          ? `Not unambiguous: these cash flows allow ${result.roots.length} different rates (${result.roots.map((r) => `${(r * 100).toFixed(1)}%`).join(', ')}).`
          : 'The cash flows do not define a rate.',
  }
}

export type ModifiedDietzResult = {
  // Return in PERCENT (15.5 = 15.5%), or null.
  returnPercent: number | null
  gainEur: number | null
  averageCapitalEur: number | null
}

/**
 * Modified Dietz for one period. Flows are external flows (+ in, − out);
 * each is weighted by the fraction of the period it was invested.
 * null when the start value is unknown, the period is empty or the average
 * capital is ~0 / not finite.
 */
export function modifiedDietz(
  startValueEur: number | null,
  endValueEur: number,
  flows: ExternalFlow[],
  periodStartIso: string,
  periodEndIso: string
): ModifiedDietzResult {
  const none = { returnPercent: null, gainEur: null, averageCapitalEur: null }
  if (startValueEur === null || !Number.isFinite(startValueEur) || !Number.isFinite(endValueEur)) return none
  const totalDays = daysBetween(periodStartIso, periodEndIso)
  if (!Number.isFinite(totalDays) || totalDays <= 0) return none

  let net = 0
  let weighted = 0
  for (const f of flows) {
    const d = daysBetween(periodStartIso, f.date)
    if (!Number.isFinite(d)) continue
    net += f.amountEur
    const w = (totalDays - Math.min(Math.max(d, 0), totalDays)) / totalDays
    weighted += f.amountEur * w
  }
  const gainEur = endValueEur - startValueEur - net
  const averageCapitalEur = startValueEur + weighted
  if (!Number.isFinite(gainEur) || !Number.isFinite(averageCapitalEur) || Math.abs(averageCapitalEur) < 0.01) {
    return { returnPercent: null, gainEur: Number.isFinite(gainEur) ? gainEur : null, averageCapitalEur: null }
  }
  return { returnPercent: (gainEur / averageCapitalEur) * 100, gainEur, averageCapitalEur }
}

export type PositionReturn = {
  // Fraction (0.1 = 10%), or null.
  pct: number | null
  basis: 'unrealized_on_remaining_cost' | 'realized_on_sold_cost' | null
  // Plain-language numerator / denominator for the UI.
  explanation: string
}

/** The return shown for one position: unrealized while held, realized once closed. */
export function positionReturn(m: InvestmentMetrics): PositionReturn {
  if (!m.isClosed && m.unrealizedReturnPct !== null) {
    return {
      pct: m.unrealizedReturnPct,
      basis: 'unrealized_on_remaining_cost',
      explanation: 'Unrealized: (current value − remaining cost) ÷ remaining cost of what you still hold.',
    }
  }
  if (m.isClosed && m.realizedReturnPct !== null) {
    return {
      pct: m.realizedReturnPct,
      basis: 'realized_on_sold_cost',
      explanation: 'Realized: (net sale proceeds − cost of what was sold) ÷ cost of what was sold.',
    }
  }
  return { pct: null, basis: null, explanation: 'No return: nothing held or sold.' }
}
