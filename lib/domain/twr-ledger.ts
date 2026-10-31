import type { Investment, Transaction } from '@/types/database'
import type { FxRates } from '@/lib/domain/fx'
import { hasUnits } from '@/lib/domain/constants'
import { txFeeInEur, txNativeToEur } from '@/lib/domain/calculations'
import { tradeGrossNative } from '@/lib/domain/trade-amounts'
import { isRewardTransaction, type ReturnFlow } from '@/lib/domain/flow-classification'
import { quantityOn, valuePosition, type FxSeries, type OfficialValue, type PriceSeries } from '@/lib/valuation/historical-valuation'
import { dealerFactorOn, dealerFactors, type DealerAnchor, type DealerFactor } from '@/lib/domain/dealer-anchor'
import type { GainComponent, SleeveDay, SleeveStart, TwrDay, TwrInput, ValueQuality } from '@/lib/domain/twr'

// ---------------------------------------------------------------------------
// Builds the daily TWR input (see twr.ts) for one account from its records.
//
// Boundary: every position + the cash held at each broker. Money moving
// between them (buying, selling, dividends paid out, fees) is internal.
// External flows: deposits, withdrawals, Round Ups, Saveback, rewards.
//
// Values per day (close):
//  * positions: quantity × exchange close × FX of the price date
//    (lib/valuation/historical-valuation).
//    - Listed shares, ETFs, crypto: market values. When a period STARTS on
//      the date of an official statement, that statement is the start value;
//      from the next day market values apply again. No factor is carried.
//    - Dealer metals: on the dealer's basis (lib/domain/dealer-anchor): the
//      last dealer value × the relative move of the COMEX benchmark.
//  * valuation_basis_adjustment: whenever the valuation BASIS of a held
//    position changes (statement → market for listed instruments; a new
//    dealer value for metals) the step is recorded per sleeve and day as a
//    basis adjustment. It is not a flow, not a contribution and not a gain:
//    the TWR, the components and the investment result exclude it.
//  * end date: the CENTRAL current valuation (lib/domain/current-valuation)
//    when given, so the return ends at exactly the value every page shows.
//  * cash: reconstructed from the records, day by day; on the anchor date
//    the confirmed statement balance replaces it (the gap is reported).
//    A negative balance that recovers within the normal settlement window is
//    treated as booking order, not as missing money. A persistent negative
//    balance means purchases without recorded funding (a missing deposit).
//    Inside this boundary that only shifts the LEVEL (cash −X, position +X:
//    no gain appears), but it understates the invested capital. A small
//    persistent shortfall (≤ max(€25, 1% of the portfolio)) is accepted as
//    'estimated'; a larger one makes that day's cash unknown — no percentage.
// ---------------------------------------------------------------------------

// Small broker overdrafts caused by fees/settlement are valid cash, not proof
// of a missing deposit. They stay in the ledger but do not lower data quality.
export const CASH_NEGATIVE_TOLERANCE_EUR = 5
export const CASH_SHORTFALL_ABS_EUR = 25
export const CASH_SHORTFALL_FRACTION = 0.01
export const CASH_SETTLEMENT_WINDOW_DAYS = 3

export type OfficialAnchor = {
  date: string
  positions: OfficialValue[]
  cash: { platform: string; amountEur: number; source: string }[]
}

export type QualityIssue = {
  kind: 'metal_benchmark' | 'cash_shortfall' | 'storage_costs_missing' | 'proposed_flow' | 'valuation_basis_adjustment'
  from: string
  detail: string
}

// Explicit owner decisions that change how the reconstructed cash ledger is
// interpreted. These are separate from real external cash flows: a cash
// reconciliation balances an immaterial bookkeeping gap for TWR, but is never
// presented as personal or platform-funded money.
export type AccountingTreatment =
  | { kind: 'storage_costs_paid_privately'; platform: string; effectiveDate: string; amountEur: null; notes: string }
  | { kind: 'cash_reconciliation'; platform: string; effectiveDate: string; amountEur: number; notes: string }

// Storage costs are charged monthly (the month after). When none is booked
// for longer than this after the last one while metal is still held, the
// source period may be incomplete: never treated as €0, the affected days
// are 'estimated'.
export const STORAGE_COST_GAP_DAYS = 45

export type SleeveInfo =
  | { kind: 'position'; investmentId: string; platform: string; name: string; currency: string }
  | { kind: 'cash'; platform: string; name: string }

export type LedgerResult = {
  input: TwrInput
  sleeves: Record<string, SleeveInfo>
  anchorFactors: { investmentId: string; factor: number; officialEur: number; marketEur: number; source: string }[]
  notes: string[]
  // Every reason why the result is only 'estimated', listed separately.
  qualityIssues: QualityIssue[]
  cashByPlatform: Record<string, { date: string; valueEur: number }[]>
}

const DAY = 86_400_000
export function addDays(iso: string, n: number): string {
  return new Date(Date.parse(`${iso}T00:00:00Z`) + n * DAY).toISOString().slice(0, 10)
}

export const cashSleeve = (platform: string) => `cash:${platform}`

type Effect = { inflow: number; comps: Partial<Record<Exclude<GainComponent, 'market'>, number>> }
const addComp = (e: Effect, k: Exclude<GainComponent, 'market'>, v: number) => {
  e.comps[k] = (e.comps[k] ?? 0) + v
}

// Separate fee rows: dividend tax → taxes on the position; negative interest
// and exchange-connection costs belong to the broker account (cash); other
// fees (e.g. metal storage) to the position they are booked on.
export function feeRowTarget(tx: Transaction): { level: 'position' | 'cash'; component: 'fees' | 'taxes' | 'income' } {
  const n = tx.notes ?? ''
  if (/belasting|withholding|\btax\b/i.test(n)) return { level: 'position', component: 'taxes' }
  if (/negatieve rente|negative interest/i.test(n)) return { level: 'cash', component: 'income' }
  if (/aansluitingskosten|connection/i.test(n)) return { level: 'cash', component: 'fees' }
  return { level: 'position', component: 'fees' }
}

// The value of a position on the end date, from the central current valuation.
export type EndValue = {
  valueEur: number
  // The plain market/benchmark value of the same quantity at the same price
  // (no dealer factor); the basis adjustment on the end date is measured
  // against it. null when no current market price exists.
  marketValueEur: number | null
  priceNative: number | null
  fxEurPerUnit: number | null
  currency: string | null
  quality: ValueQuality
}

/** Broker accounts with a cash sleeve: every platform with records, flows or treatments. */
export function ledgerPlatforms(
  investments: Investment[],
  transactions: Transaction[],
  flows: ReturnFlow[],
  accountingTreatments: AccountingTreatment[] = []
): string[] {
  const withTx = new Set(transactions.map((t) => t.investment_id))
  return [...new Set([
    ...investments.filter((i) => withTx.has(i.id)).map((i) => i.platform),
    ...flows.map((f) => f.platform),
    ...accountingTreatments.map((t) => t.platform),
  ])].sort()
}

export type RecordEffects = {
  effects: Map<string, Map<string, Effect>> // date → sleeve → effect
  externalByDate: Map<string, number>
  grossByDate: Map<string, { in: number; out: number }>
  notes: string[]
}

/** Per-day effects of transactions, external flows and cash reconciliations on every sleeve. */
export function buildRecordEffects(args: {
  investments: Investment[]
  transactions: Transaction[]
  flows: ReturnFlow[]
  fxRates: FxRates
  endDate: string
  accountingTreatments?: AccountingTreatment[]
}): RecordEffects {
  const { investments, transactions, flows, fxRates, endDate, accountingTreatments = [] } = args
  const invById = new Map(investments.map((i) => [i.id, i]))
  const notes: string[] = []
  const effects = new Map<string, Map<string, Effect>>()
  const externalByDate = new Map<string, number>()
  const grossByDate = new Map<string, { in: number; out: number }>()
  const effectOf = (date: string, sleeve: string): Effect => {
    let m = effects.get(date)
    if (!m) effects.set(date, (m = new Map()))
    let e = m.get(sleeve)
    if (!e) m.set(sleeve, (e = { inflow: 0, comps: {} }))
    return e
  }
  for (const t of transactions) {
    const inv = invById.get(t.investment_id)
    if (!inv || isRewardTransaction(t)) continue
    const pos = effectOf(t.date, inv.id)
    const cash = effectOf(t.date, cashSleeve(inv.platform))
    const fee = txFeeInEur(t, fxRates)
    if (t.type === 'buy') {
      const cost = txNativeToEur(tradeGrossNative(t), t, fxRates) + fee
      pos.inflow += cost
      cash.inflow -= cost
      addComp(pos, 'fees', -fee)
    } else if (t.type === 'sell') {
      const proceeds = txNativeToEur(tradeGrossNative(t), t, fxRates) - fee
      pos.inflow -= proceeds
      cash.inflow += proceeds
      addComp(pos, 'fees', -fee)
    } else if (t.type === 'dividend') {
      const gross = txNativeToEur(t.amount ?? 0, t, fxRates)
      pos.inflow -= gross - fee
      cash.inflow += gross - fee
      addComp(pos, 'income', gross)
      addComp(pos, 'taxes', -fee)
    } else if (t.type === 'interest') {
      // Interest is earned on cash: a gain of the cash sleeve, no move.
      const gross = txNativeToEur(t.amount ?? 0, t, fxRates)
      addComp(cash, 'income', gross)
      addComp(cash, 'taxes', -fee)
    } else if (t.type === 'fee') {
      const amt = txNativeToEur(t.amount ?? 0, t, fxRates)
      const target = feeRowTarget(t)
      if (target.level === 'position') {
        pos.inflow += amt
        cash.inflow -= amt
        addComp(pos, target.component, -amt)
      } else {
        addComp(cash, target.component, -amt)
      }
    } else {
      // deposit / withdraw / value updates on non-unit positions: no
      // historical balance can be reconstructed from them.
      pos.inflow = NaN
    }
  }
  for (const f of flows) {
    const e = effectOf(f.date, cashSleeve(f.platform))
    e.inflow += f.amountEur
    externalByDate.set(f.date, (externalByDate.get(f.date) ?? 0) + f.amountEur)
    const g = grossByDate.get(f.date) ?? { in: 0, out: 0 }
    if (f.amountEur >= 0) g.in += f.amountEur
    else g.out -= f.amountEur
    grossByDate.set(f.date, g)
  }
  for (const treatment of accountingTreatments) {
    if (treatment.kind !== 'cash_reconciliation' || treatment.effectiveDate > endDate) continue
    const e = effectOf(treatment.effectiveDate, cashSleeve(treatment.platform))
    e.inflow += treatment.amountEur
    externalByDate.set(
      treatment.effectiveDate,
      (externalByDate.get(treatment.effectiveDate) ?? 0) + treatment.amountEur
    )
    const g = grossByDate.get(treatment.effectiveDate) ?? { in: 0, out: 0 }
    g.in += treatment.amountEur
    grossByDate.set(treatment.effectiveDate, g)
    notes.push(
      `Cash ${treatment.platform} reconciled by ${treatment.amountEur.toFixed(2)} EUR on ${treatment.effectiveDate}; ` +
      'used for return calculation only, not counted as a contribution.'
    )
  }
  return { effects, externalByDate, grossByDate, notes }
}

const gainOf = (e: Effect | undefined) => (e ? Object.values(e.comps).reduce((t, v) => t + (v ?? 0), 0) : 0)

/**
 * Cash per platform per day, from the very first record, with the official
 * balance replacing the reconstruction on the anchor date.
 */
export function reconstructCash(args: {
  effects: RecordEffects['effects']
  platforms: string[]
  startDate: string
  endDate: string
  anchor?: OfficialAnchor
}): { values: Record<string, Map<string, number>>; notes: string[] } {
  const { effects, platforms, startDate, endDate, anchor } = args
  const notes: string[] = []
  const allDates = [...effects.keys()].sort()
  const firstDate = allDates[0] && allDates[0] < startDate ? allDates[0] : startDate
  const values: Record<string, Map<string, number>> = {}
  const officialCash = new Map((anchor?.cash ?? []).map((c) => [c.platform, c]))
  for (const p of platforms) {
    const series = new Map<string, number>()
    let v = 0
    for (let d = addDays(firstDate, -1); d <= endDate; d = addDays(d, 1)) {
      const e = effects.get(d)?.get(cashSleeve(p))
      v += (e?.inflow ?? 0) + gainOf(e)
      if (anchor && d === anchor.date && officialCash.has(p)) {
        const off = officialCash.get(p)!.amountEur
        if (Math.abs(off - v) > 0.01) notes.push(`Cash ${p} on ${d}: records give ${v.toFixed(2)}, statement ${off.toFixed(2)} (statement used).`)
        v = off
      }
      series.set(d, v)
    }
    values[p] = series
  }
  return { values, notes }
}

/** A persistent shortfall larger than this makes the cash (and the day's value) unknown. */
export function isMaterialCashShortfall(shortfallEur: number, portfolioTotalEur: number): boolean {
  return shortfallEur > Math.max(CASH_SHORTFALL_ABS_EUR, CASH_SHORTFALL_FRACTION * Math.abs(portfolioTotalEur))
}

export function buildTwrLedger(args: {
  investments: Investment[]
  transactions: Transaction[]
  flows: ReturnFlow[]
  prices: Map<string, PriceSeries>
  fx: FxSeries
  fxRates: FxRates
  startDate: string
  endDate: string
  anchor?: OfficialAnchor
  accountingTreatments?: AccountingTreatment[]
  // The central current valuation per investment, used ONLY for the end date
  // (exchange closes for "today" are often not published yet). When given, a
  // held position without an entry here has no end value: no return.
  endValues?: Map<string, EndValue>
  // Dealer values of metals (official statements of any date, owner-reported
  // observations): the anchors of the dealer basis.
  dealerAnchors?: DealerAnchor[]
}): LedgerResult {
  const {
    investments, transactions, flows, prices, fx, fxRates, startDate, endDate, anchor,
    accountingTreatments = [], endValues, dealerAnchors = [],
  } = args
  const notes: string[] = []
  const invById = new Map(investments.map((i) => [i.id, i]))
  const txByInv = new Map<string, Transaction[]>()
  for (const t of transactions) {
    if (!invById.has(t.investment_id)) continue
    const l = txByInv.get(t.investment_id) ?? []
    l.push(t)
    txByInv.set(t.investment_id, l)
  }
  const sleeves: Record<string, SleeveInfo> = {}
  const relevantInv = investments.filter((i) => (txByInv.get(i.id) ?? []).length > 0)
  for (const i of relevantInv) {
    sleeves[i.id] = { kind: 'position', investmentId: i.id, platform: i.platform, name: i.name, currency: i.currency ?? 'EUR' }
  }
  const platforms = ledgerPlatforms(investments, transactions, flows, accountingTreatments)
  for (const p of platforms) sleeves[cashSleeve(p)] = { kind: 'cash', platform: p, name: `Cash ${p}` }

  // ---- anchor factors (official value / market value on the anchor date)
  const factor = new Map<string, number>()
  const anchorFactors: LedgerResult['anchorFactors'] = []
  if (anchor) {
    for (const o of anchor.positions) {
      const inv = invById.get(o.investmentId)
      if (!inv || inv.type === 'commodity') continue // metals: dealer anchors below
      const txs = txByInv.get(inv.id) ?? []
      const q = quantityOn(inv, txs, anchor.date)
      if (o.quantity != null && Math.abs(o.quantity - q) > 1e-6) {
        notes.push(`${inv.platform} ${inv.name}: statement quantity ${o.quantity} ≠ books ${q} on ${anchor.date}; statement not used.`)
        continue
      }
      const v = valuePosition(inv, txs, anchor.date, prices, fx)
      const market = v.valueEur ?? v.benchmarkValueEur
      if (market && market > 0) {
        factor.set(inv.id, o.valueEur / market)
        anchorFactors.push({ investmentId: inv.id, factor: o.valueEur / market, officialEur: o.valueEur, marketEur: market, source: o.source })
      } else {
        notes.push(`${inv.platform} ${inv.name}: no market value on ${anchor.date} to anchor the statement value.`)
      }
    }
  }
  // Listed instruments: the statement value applies on the anchor date only,
  // and only as the START of a period beginning on that date. A period
  // running through the anchor date stays on market values.
  const anchorIsStart = !!anchor && anchor.date === startDate
  // Dealer metals: the year-end statement plus every other dealer value.
  const metalAnchors: DealerAnchor[] = [
    ...(anchor?.positions ?? [])
      .filter((o) => invById.get(o.investmentId)?.type === 'commodity')
      .map((o): DealerAnchor => ({ investmentId: o.investmentId, date: anchor!.date, valueEur: o.valueEur, quantity: o.quantity ?? null, source: o.source, kind: 'official_statement' })),
    ...dealerAnchors.filter((a) => !(anchor && a.date === anchor.date && a.kind === 'official_statement' && anchor.positions.some((o) => o.investmentId === a.investmentId))),
  ]
  const dealer = new Map<string, DealerFactor[]>()
  for (const inv of relevantInv.filter((i) => i.type === 'commodity')) {
    const d = dealerFactors(inv, txByInv.get(inv.id) ?? [], metalAnchors, prices, fx)
    notes.push(...d.notes)
    if (d.factors.length) dealer.set(inv.id, d.factors)
  }
  // The factor on the close of `date` (1 = plain market/benchmark).
  const factorOn = (inv: Investment, date: string): number => {
    if (inv.type === 'commodity') return dealerFactorOn(dealer.get(inv.id) ?? [], date)?.factor ?? 1
    return anchorIsStart && date === startDate ? factor.get(inv.id) ?? 1 : 1
  }

  type PosValue = {
    valueEur: number | null
    marketEur: number | null // the same quantity at the plain market/benchmark price
    priceNative: number | null
    fxEurPerUnit: number | null
    currency: string | null
    quality: ValueQuality
    reason?: string
  }
  const valueOn = (inv: Investment, date: string): PosValue => {
    const txs = txByInv.get(inv.id) ?? []
    if (!hasUnits(inv.type)) {
      return { valueEur: null, marketEur: null, priceNative: null, fxEurPerUnit: null, currency: null, quality: 'estimated', reason: 'No historical balance for a non-unit position.' }
    }
    const v = valuePosition(inv, txs, date, prices, fx)
    if (v.quality === 'closed') return { valueEur: 0, marketEur: 0, priceNative: null, fxEurPerUnit: null, currency: null, quality: 'reconstructed' }
    if (endValues && date === endDate) {
      const ev = endValues.get(inv.id)
      if (ev) return { ...ev, marketEur: ev.marketValueEur }
      return { valueEur: null, marketEur: null, priceNative: null, fxEurPerUnit: null, currency: null, quality: 'estimated', reason: `${inv.name}: no validated current value.` }
    }
    const k = factorOn(inv, date)
    const market = v.quality === 'exact' ? v.valueEur : v.quality === 'benchmark_only' ? v.benchmarkValueEur : null
    if (market === null) {
      return { valueEur: null, marketEur: null, priceNative: null, fxEurPerUnit: null, currency: null, quality: 'estimated', reason: `${inv.name}: ${v.note ?? v.quality}` }
    }
    // Metals stay 'estimated': even on the dealer basis the daily move is COMEX.
    const quality: ValueQuality = v.quality === 'benchmark_only' ? 'estimated' : 'reconstructed'
    return { valueEur: market * k, marketEur: market, priceNative: v.priceNative, fxEurPerUnit: v.fxEurPerUnit, currency: v.priceCurrency, quality }
  }

  // ---- per-day effects of transactions and flows
  const rec = buildRecordEffects({ investments, transactions, flows, fxRates, endDate, accountingTreatments })
  const { effects, externalByDate, grossByDate } = rec
  notes.push(...rec.notes)
  // ---- cash per platform (statement replaces the reconstruction on the anchor date)
  const cash = reconstructCash({ effects, platforms, startDate, endDate, anchor })
  const cashValues = cash.values
  notes.push(...cash.notes)
  const officialCash = new Map((anchor?.cash ?? []).map((c) => [c.platform, c]))
  // ---- start values
  const startValues: SleeveStart[] = []
  const prevPos = new Map<string, PosValue>()
  for (const i of relevantInv) {
    const pv = valueOn(i, startDate)
    prevPos.set(i.id, pv)
    const official = (anchor && anchor.date === startDate && factor.has(i.id)) ||
      (i.type === 'commodity' && (dealer.get(i.id) ?? []).some((f) => f.date === startDate && f.kind === 'official_statement'))
    startValues.push({ sleeve: i.id, valueEur: pv.valueEur, quality: official ? 'confirmed' : pv.quality, missingReason: pv.reason })
  }
  for (const p of platforms) {
    const v = cashValues[p].get(startDate) ?? 0
    const confirmed = anchor?.date === startDate && officialCash.has(p)
    startValues.push({ sleeve: cashSleeve(p), valueEur: v, quality: confirmed ? 'confirmed' : 'reconstructed' })
  }

  // ---- days
  const days: TwrDay[] = []
  const shortfallNoted = new Set<string>()
  const qualityIssues: QualityIssue[] = []
  const issueSeen = new Set<string>()
  const addIssue = (key: string, issue: QualityIssue) => {
    if (issueSeen.has(key)) return
    issueSeen.add(key)
    qualityIssues.push(issue)
  }
  // Last booked storage cost per platform → from when storage costs are missing.
  const storageGapFrom = new Map<string, { from: string; last: string }>()
  const privateStorageFrom = new Map(
    accountingTreatments
      .filter((t): t is Extract<AccountingTreatment, { kind: 'storage_costs_paid_privately' }> =>
        t.kind === 'storage_costs_paid_privately')
      .map((t) => [t.platform, t.effectiveDate])
  )
  for (const p of platforms) {
    const rows = transactions
      .filter((t) => t.type === 'fee' && /opslag|storage/i.test(t.notes ?? '') && invById.get(t.investment_id)?.platform === p)
      .map((t) => t.date)
      .sort()
    if (rows.length < 2) continue
    const last = rows[rows.length - 1]
    const from = addDays(last, STORAGE_COST_GAP_DAYS)
    const paidPrivatelyFrom = privateStorageFrom.get(p)
    if (paidPrivatelyFrom && paidPrivatelyFrom <= from) {
      notes.push(`${p}: storage costs are paid privately from ${paidPrivatelyFrom} and excluded from the portfolio.`)
      continue
    }
    if (from <= endDate) storageGapFrom.set(p, { from, last })
  }
  const proposedOn = new Map<string, ReturnFlow[]>()
  for (const f of flows) if (f.proposed) proposedOn.set(`${f.date}|${f.platform}`, [...(proposedOn.get(`${f.date}|${f.platform}`) ?? []), f])
  const isTransientCashShortfall = (platform: string, date: string) => {
    for (let n = 1; n <= CASH_SETTLEMENT_WINDOW_DAYS; n += 1) {
      const futureDate = addDays(date, n)
      if (futureDate > endDate) break
      if ((cashValues[platform].get(futureDate) ?? 0) >= -CASH_NEGATIVE_TOLERANCE_EUR) return true
    }
    return false
  }
  for (let d = addDays(startDate, 1); d <= endDate; d = addDays(d, 1)) {
    const dayEffects = effects.get(d)
    const sl: SleeveDay[] = []
    for (const i of relevantInv) {
      const pv = valueOn(i, d)
      const before = prevPos.get(i.id)!
      const e = dayEffects?.get(i.id)
      const comps = { ...(e?.comps ?? {}) }
      // FX effect on what was held overnight: q × price today × (fx today − fx yesterday).
      const qPrev = quantityOn(i, txByInv.get(i.id) ?? [], addDays(d, -1))
      const qNow = quantityOn(i, txByInv.get(i.id) ?? [], d)
      const kNow = pv.valueEur !== null && pv.marketEur ? pv.valueEur / pv.marketEur : factorOn(i, d)
      if (qPrev > 0 && pv.currency && pv.currency !== 'EUR' && pv.priceNative !== null && pv.fxEurPerUnit !== null && before.fxEurPerUnit !== null) {
        comps.fx = (comps.fx ?? 0) + qPrev * kNow * pv.priceNative * (pv.fxEurPerUnit - before.fxEurPerUnit)
      }
      // A change of valuation basis on what was held overnight: not a gain.
      const kPrev = d === addDays(startDate, 1) ? factorOn(i, startDate) : factorOn(i, addDays(d, -1))
      let basisAdjustmentEur = 0
      if (qPrev > 0 && qNow > 0 && pv.marketEur !== null && Math.abs(kNow - kPrev) > 1e-12) {
        basisAdjustmentEur = pv.marketEur * (Math.min(qPrev, qNow) / qNow) * (kNow - kPrev)
        if (Math.abs(basisAdjustmentEur) >= 0.005) {
          addIssue(`basis:${i.id}:${d}`, {
            kind: 'valuation_basis_adjustment', from: d,
            detail: `${i.name} (${i.platform}): valuation basis changed on ${d} (${i.type === 'commodity' ? 'new dealer value' : 'statement value → market value'}); ` +
              `${basisAdjustmentEur >= 0 ? '+' : ''}${basisAdjustmentEur.toFixed(2)} EUR is a valuation basis adjustment, not a result.`,
          })
        }
      }
      let quality = pv.quality
      const held = (pv.valueEur ?? 0) !== 0 || qPrev > 0
      if (held && i.type === 'commodity' && pv.quality === 'estimated' && pv.valueEur !== null) {
        const f = dealerFactorOn(dealer.get(i.id) ?? [], d)
        addIssue(`metal:${i.id}`, {
          kind: 'metal_benchmark', from: d,
          detail: f
            ? `${i.name} (${i.platform}): dealer value of ${f.date} (${f.source}) moved with the COMEX benchmark.`
            : `${i.name} (${i.platform}): no dealer value — COMEX benchmark only.`,
        })
      }
      const gap = storageGapFrom.get(i.platform)
      if (held && i.type === 'commodity' && gap && d >= gap.from) {
        quality = 'estimated'
        addIssue(`storage:${i.platform}`, {
          kind: 'storage_costs_missing', from: gap.from,
          detail: `${i.platform}: no storage costs booked after ${gap.last} while metal is still held — source period may be incomplete (not treated as €0).`,
        })
      }
      sl.push({ sleeve: i.id, valueEur: pv.valueEur, netInflowEur: e?.inflow ?? 0, basisAdjustmentEur, components: comps, quality, missingReason: pv.reason })
      prevPos.set(i.id, pv)
    }
    // Unfunded purchases (negative cash): material or not?
    const positionsTotal = sl.reduce((t, s) => t + (s.valueEur ?? 0), 0)
    const cashToday = platforms.map((p) => cashValues[p].get(d) ?? 0)
    const persistentNegative = platforms.map((p, idx) =>
      cashToday[idx] < -CASH_NEGATIVE_TOLERANCE_EUR && !isTransientCashShortfall(p, d)
    )
    const shortfall = cashToday.reduce((t, v, idx) => t + (persistentNegative[idx] ? -v : 0), 0)
    const total = positionsTotal + cashToday.reduce((t, v) => t + v, 0)
    const material = isMaterialCashShortfall(shortfall, total)
    platforms.forEach((p, idx) => {
      const e = dayEffects?.get(cashSleeve(p))
      const v = cashToday[idx]
      const negative = persistentNegative[idx]
      if (negative && !shortfallNoted.has(p)) {
        shortfallNoted.add(p)
        notes.push(`Cash ${p} is ${v.toFixed(2)} EUR on ${d}: purchases without recorded funding${material ? ' (material: cash unknown)' : ' (small: estimated)'}.`)
        if (!material) {
          addIssue(`cash:${p}`, { kind: 'cash_shortfall', from: d, detail: `Cash ${p} is ${v.toFixed(2)} EUR from ${d}: a small cost or deposit seems to be missing in the records.` })
        }
      }
      const proposed = proposedOn.get(`${d}|${p}`) ?? []
      for (const f of proposed) {
        addIssue(`proposed:${f.id}`, { kind: 'proposed_flow', from: d, detail: `Uses a flow that is not recorded yet: ${f.label} (${f.amountEur.toFixed(2)} EUR, ${d}).` })
      }
      sl.push({
        sleeve: cashSleeve(p),
        valueEur: negative && material ? null : v,
        netInflowEur: e?.inflow ?? 0,
        components: e?.comps,
        quality: negative || proposed.length ? 'estimated' : 'reconstructed',
        missingReason: negative && material
          ? `Cash ${p} is ${v.toFixed(2)} EUR: purchases without recorded funding (missing deposit?).`
          : undefined,
      })
    })
    days.push({
      date: d, externalFlowEur: externalByDate.get(d) ?? 0, sleeves: sl,
      grossInEur: grossByDate.get(d)?.in ?? 0, grossOutEur: grossByDate.get(d)?.out ?? 0,
    })
  }

  const cashByPlatform: LedgerResult['cashByPlatform'] = {}
  for (const p of platforms) {
    cashByPlatform[p] = [...cashValues[p].entries()].filter(([d]) => d >= startDate).map(([date, valueEur]) => ({ date, valueEur }))
  }
  return { input: { startDate, startValues, days }, sleeves, anchorFactors, notes, qualityIssues, cashByPlatform }
}
