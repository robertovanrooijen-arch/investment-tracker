// ---------------------------------------------------------------------------
// Time-weighted return (TWR) — pure engine.
//
// Question answered: how well did the investments themselves perform over a
// period, regardless of when or how much money was added or withdrawn?
//
// Method: the period is split at every external cash flow into sub-periods;
// each sub-period return is (value just before the next flow) / (value just
// after the previous flow) − 1, and the sub-period returns are linked
// geometrically: TWR = (1 + r1) × (1 + r2) × … × (1 + rn) − 1.
//
// With daily valuations this is computed day by day (between two flows the
// daily factors telescope to exactly that sub-period's factor).
//
// CONVENTION (one, everywhere): an external flow dated D is available at the
// START of day D. The return of day D is
//     r_D = V_D / (V_{D−1} + F_D) − 1
// with V the portfolio value at the close of the day and F the net external
// flow of that day (+ in, − out). Purchases and sales inside the portfolio are
// internal moves (cash ↔ position) and never flows.
//
// The portfolio is a set of "sleeves" (one per position, one per broker cash
// account). Every euro moving between sleeves is recorded as an inflow of one
// sleeve and an outflow of another, so for every day
//     Σ sleeve inflows = external flow,   Σ sleeve gains = portfolio gain.
// Contribution of sleeve i on day D: c_iD = gain_iD / (V_{D−1} + F_D), so
// Σ_i c_iD = r_D exactly. Daily contributions are compounded with the return
// earned BEFORE them:  C_i = Σ_D c_iD × Π_{k<D} (1 + r_k).  Then
// Σ_i C_i = Π (1 + r_D) − 1 = TWR exactly (telescoping) — no smoothing, no
// unexplained residual other than floating-point rounding.
//
// No partial results: a single missing value (position, price, FX, cash) on a
// day makes that day unknown. The TWR is then 'unavailable', or — only when
// the caller allows it — reported up to the last complete day before the gap.
// ---------------------------------------------------------------------------

export type ReturnQuality = 'confirmed' | 'reconstructed' | 'estimated' | 'unavailable'
export type ValueQuality = Exclude<ReturnQuality, 'unavailable'>

// Parts of a sleeve's daily gain. 'market' is the remainder (price movement
// in the instrument's own currency, incl. the difference between trade price
// and close on a trading day).
export type GainComponent = 'market' | 'fx' | 'income' | 'fees' | 'taxes'
export const GAIN_COMPONENTS: GainComponent[] = ['market', 'fx', 'income', 'fees', 'taxes']

export type SleeveDay = {
  sleeve: string
  valueEur: number | null // value at the close of the day; null = unknown
  netInflowEur: number // money moved INTO the sleeve during the day (− = out)
  components?: Partial<Record<Exclude<GainComponent, 'market'>, number>>
  quality: ValueQuality
  missingReason?: string
}

export type TwrDay = {
  date: string
  externalFlowEur: number // net external flow of the day (+ in, − out)
  // Gross amounts of that day; when omitted the net flow is used.
  grossInEur?: number
  grossOutEur?: number
  sleeves: SleeveDay[]
}

export type SleeveStart = { sleeve: string; valueEur: number | null; quality: ValueQuality; missingReason?: string }

export type TwrInput = {
  startDate: string // valuation date of the start values (close of that day)
  startValues: SleeveStart[]
  days: TwrDay[] // consecutive, ascending, all after startDate
}

export type SleeveResult = {
  contribution: number // fraction of the portfolio TWR (0.01 = 1 percentage point)
  gainEur: number
  // The sleeve's own time-weighted return over the days it was held.
  ownReturn: number | null
  startValueEur: number
  endValueEur: number
}

export type TwrResult = {
  status: 'ok' | 'unavailable'
  quality: ReturnQuality
  startDate: string
  endDate: string // last day included (earlier than requested when truncated)
  requestedEndDate: string
  truncated: boolean
  twr: number | null // fraction, NOT annualised
  startValueEur: number | null
  endValueEur: number | null
  externalInEur: number
  externalOutEur: number
  gainEur: number | null
  subPeriods: { from: string; to: string; return: number }[]
  bySleeve: Record<string, SleeveResult>
  byComponent: Record<GainComponent, number>
  sumOfContributions: number | null
  residual: number | null
  reconciled: boolean
  missing: { date: string; sleeve: string; reason: string }[]
  daily: { date: string; valueEur: number; externalFlowEur: number; return: number }[]
}

// Σ contributions must match the TWR within this tolerance (0.01 percentage
// point); otherwise the reconciliation is shown as NOT matching.
export const CONTRIBUTION_TOLERANCE = 0.0001
// Inflows between sleeves must balance to the external flow within a cent.
const BALANCE_TOLERANCE_EUR = 0.01
// A day whose opening capital is (near) zero has no return of its own.
const ZERO_CAPITAL_EUR = 0.005

const QUALITY_RANK: Record<ValueQuality, number> = { confirmed: 0, reconstructed: 1, estimated: 2 }
const worse = (a: ValueQuality, b: ValueQuality): ValueQuality => (QUALITY_RANK[a] >= QUALITY_RANK[b] ? a : b)

const emptyComponents = (): Record<GainComponent, number> => ({ market: 0, fx: 0, income: 0, fees: 0, taxes: 0 })

/** Geometric linking of sub-period returns (fractions). */
export function linkReturns(returns: number[]): number {
  return returns.reduce((f, r) => f * (1 + r), 1) - 1
}

export function computeTwr(input: TwrInput, options: { allowTruncation?: boolean } = {}): TwrResult {
  const requestedEndDate = input.days.length ? input.days[input.days.length - 1].date : input.startDate
  const missing: TwrResult['missing'] = []
  const unavailable = (endDate: string): TwrResult => ({
    status: 'unavailable', quality: 'unavailable', startDate: input.startDate, endDate, requestedEndDate,
    truncated: false, twr: null, startValueEur: null, endValueEur: null, externalInEur: 0, externalOutEur: 0,
    gainEur: null, subPeriods: [], bySleeve: {}, byComponent: emptyComponents(), sumOfContributions: null,
    residual: null, reconciled: false, missing, daily: [],
  })

  for (const s of input.startValues) {
    if (s.valueEur === null || !Number.isFinite(s.valueEur)) {
      missing.push({ date: input.startDate, sleeve: s.sleeve, reason: s.missingReason ?? 'Start value unknown.' })
    }
  }
  if (missing.length) return unavailable(input.startDate)

  // First day that cannot be valued completely (or does not balance).
  let firstBadIndex = -1
  input.days.forEach((day, idx) => {
    const bad: TwrResult['missing'] = []
    for (const s of day.sleeves) {
      if (s.valueEur === null || !Number.isFinite(s.valueEur) || !Number.isFinite(s.netInflowEur)) {
        bad.push({ date: day.date, sleeve: s.sleeve, reason: s.missingReason ?? 'Value unknown.' })
      }
    }
    const inflows = day.sleeves.reduce((t, s) => t + s.netInflowEur, 0)
    if (!Number.isFinite(day.externalFlowEur)) {
      bad.push({ date: day.date, sleeve: '(external flows)', reason: 'External flow amount unknown (missing FX).' })
    } else if (Number.isFinite(inflows) && Math.abs(inflows - day.externalFlowEur) > BALANCE_TOLERANCE_EUR) {
      bad.push({ date: day.date, sleeve: '(ledger)', reason: `Internal moves do not balance: ${(inflows - day.externalFlowEur).toFixed(2)} EUR.` })
    }
    if (bad.length && firstBadIndex === -1) firstBadIndex = idx
    missing.push(...bad)
  })

  let days = input.days
  let truncated = false
  if (firstBadIndex !== -1) {
    if (!options.allowTruncation || firstBadIndex === 0) return unavailable(input.days[firstBadIndex]?.date ?? input.startDate)
    days = input.days.slice(0, firstBadIndex)
    truncated = true
  }

  let quality: ValueQuality = 'confirmed'
  const prev = new Map<string, number>()
  for (const s of input.startValues) {
    prev.set(s.sleeve, s.valueEur as number)
    quality = worse(quality, s.quality)
  }
  const startValueEur = [...prev.values()].reduce((t, v) => t + v, 0)

  const sleeves: Record<string, SleeveResult & { growth: number; held: boolean }> = {}
  const sleeveOf = (id: string) =>
    (sleeves[id] ??= { contribution: 0, gainEur: 0, ownReturn: null, startValueEur: prev.get(id) ?? 0, endValueEur: 0, growth: 1, held: false })
  for (const id of prev.keys()) sleeveOf(id)

  const byComponent = emptyComponents()
  const daily: TwrResult['daily'] = []
  const subPeriods: TwrResult['subPeriods'] = []
  let growth = 1 // Π (1 + r) of the days before the current one
  let periodStart = input.startDate
  let periodGrowth = 1
  let externalInEur = 0
  let externalOutEur = 0
  let prevTotal = startValueEur

  for (const day of days) {
    const flow = day.externalFlowEur
    if (day.grossInEur !== undefined || day.grossOutEur !== undefined) {
      externalInEur += day.grossInEur ?? 0
      externalOutEur += day.grossOutEur ?? 0
    } else if (flow > 0) externalInEur += flow
    else externalOutEur -= flow
    if (flow !== 0 && daily.length) {
      // A flow at the start of this day closes the sub-period that ended at
      // the previous close.
      const lastClose = daily[daily.length - 1].date
      subPeriods.push({ from: periodStart, to: lastClose, return: periodGrowth - 1 })
      periodStart = lastClose
      periodGrowth = 1
    }
    const capital = prevTotal + flow
    let total = 0
    const gains: { id: string; gain: number; comps: Record<GainComponent, number> }[] = []
    for (const s of day.sleeves) {
      const before = prev.get(s.sleeve) ?? 0
      const value = s.valueEur as number
      const gain = value - before - s.netInflowEur
      const comps = emptyComponents()
      let explained = 0
      for (const [k, v] of Object.entries(s.components ?? {}) as [Exclude<GainComponent, 'market'>, number][]) {
        comps[k] += v
        explained += v
      }
      comps.market = gain - explained
      gains.push({ id: s.sleeve, gain, comps })
      total += value
      quality = worse(quality, s.quality)
      // The sleeve's own return: same start-of-day convention for money put
      // into it; money taken out leaves at the close.
      const r = sleeveOf(s.sleeve)
      const base = before + Math.max(s.netInflowEur, 0)
      if (base > ZERO_CAPITAL_EUR) {
        r.growth *= 1 + gain / base
        r.held = true
      }
      prev.set(s.sleeve, value)
    }
    // Sleeves not reported today keep their value (no gain).
    for (const [id, v] of prev) if (!day.sleeves.some((s) => s.sleeve === id)) total += v

    const gainTotal = total - prevTotal - flow
    let r: number
    if (capital > ZERO_CAPITAL_EUR) r = gainTotal / capital
    else if (Math.abs(gainTotal) <= BALANCE_TOLERANCE_EUR) r = 0
    else {
      missing.push({ date: day.date, sleeve: '(portfolio)', reason: 'Gain on a day without invested capital (purchase before its funding).' })
      return unavailable(day.date)
    }
    if (capital > ZERO_CAPITAL_EUR) {
      for (const g of gains) {
        const c = (g.gain / capital) * growth
        const res = sleeveOf(g.id)
        res.contribution += c
        res.gainEur += g.gain
        for (const k of GAIN_COMPONENTS) byComponent[k] += (g.comps[k] / capital) * growth
      }
    } else {
      for (const g of gains) sleeveOf(g.id).gainEur += g.gain
    }
    growth *= 1 + r
    periodGrowth *= 1 + r
    prevTotal = total
    daily.push({ date: day.date, valueEur: total, externalFlowEur: flow, return: r })
  }
  const endDate = daily.length ? daily[daily.length - 1].date : input.startDate
  if (daily.length) subPeriods.push({ from: periodStart, to: endDate, return: periodGrowth - 1 })

  const twr = growth - 1
  const bySleeve: Record<string, SleeveResult> = {}
  let sum = 0
  for (const [id, s] of Object.entries(sleeves)) {
    bySleeve[id] = {
      contribution: s.contribution,
      gainEur: s.gainEur,
      ownReturn: s.held ? s.growth - 1 : null,
      startValueEur: s.startValueEur,
      endValueEur: prev.get(id) ?? 0,
    }
    sum += s.contribution
  }
  const residual = twr - sum
  return {
    status: 'ok',
    quality,
    startDate: input.startDate,
    endDate,
    requestedEndDate,
    truncated,
    twr,
    startValueEur,
    endValueEur: prevTotal,
    externalInEur,
    externalOutEur,
    gainEur: prevTotal - startValueEur - (externalInEur - externalOutEur),
    subPeriods,
    bySleeve,
    byComponent,
    sumOfContributions: sum,
    residual,
    reconciled: Math.abs(residual) <= CONTRIBUTION_TOLERANCE,
    missing,
    daily,
  }
}
