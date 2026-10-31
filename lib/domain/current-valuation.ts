import type { Investment, Transaction } from '@/types/database'
import type { FxRates } from '@/lib/domain/fx'
import { hasUnits } from '@/lib/domain/constants'
import { txFeeRateToEur, txPriceRateToEur } from '@/lib/domain/calculations'
import type { ReturnFlow } from '@/lib/domain/flow-classification'
import { replayInvestment } from '@/lib/domain/investment-result'
import {
  CASH_NEGATIVE_TOLERANCE_EUR,
  buildRecordEffects,
  isMaterialCashShortfall,
  ledgerPlatforms,
  reconstructCash,
  type AccountingTreatment,
  type EndValue,
  type OfficialAnchor,
} from '@/lib/domain/twr-ledger'
import { quantityOn, type FxSeries, type PriceSeries } from '@/lib/valuation/historical-valuation'
import { OBSERVATION_VALUE_TOLERANCE, viewObservation, type BrokerValueObservation } from '@/lib/domain/broker-observation'
import { dealerFactorOn, dealerFactors, type DealerAnchor } from '@/lib/domain/dealer-anchor'

// ---------------------------------------------------------------------------
// THE current portfolio value. Every page that shows "what is it worth now"
// (Dashboard, Returns, History's last point, Allocation, Profit/Loss, YTD,
// Year Analysis for the current year) and the snapshot writer use this one
// object, and the time-weighted return ends exactly on it.
//
// Per open position (quantity and remaining cost from the same replay as the
// investment result):
//   * shares, ETFs, crypto: quantity × validated current price (not older
//     than LIVE_QUOTE_MAX_AGE_HOURS) × current FX rate (not older than
//     FX_RATE_MAX_AGE_HOURS). No historical statement factor.
//   * dealer metals, in this order:
//       1. an official dealer statement of today's quantity, of TODAY
//          → 'confirmed';
//       2. a consistent owner-reported dealer value of TODAY → 'owner_reported';
//       3. the last dealer value (statement or observation of an earlier
//          day) moved with the COMEX benchmark (lib/domain/dealer-anchor)
//          → 'estimated'. An older dealer value is never frozen: it follows
//          the benchmark, so no market move ends up in a basis adjustment;
//       4. the plain COMEX benchmark → 'estimated'.
//
// Broker cash is reconstructed from the records exactly as in the return
// ledger (`ledgerTotalEur` = positions + cash = where the return ends). How
// it is PRESENTED is a policy (`cashPolicy`): 'in_headline' adds it to the
// shown value; 'separate' shows it apart. Cash within the rounding tolerance
// is a bookkeeping residue; cash above it is never set to zero and, when
// kept apart, is flagged as needing a policy decision.
//
// Fail-closed: when one position, price, FX rate or cash balance cannot be
// valued the TOTALS are null and every gap is listed. Never a partial total.
// ---------------------------------------------------------------------------

export const LIVE_QUOTE_MAX_AGE_HOURS = 36
export const FX_RATE_MAX_AGE_HOURS = 36

export type CurrentValueSource =
  | 'market_quote' | 'official_statement' | 'owner_observation' | 'dealer_anchor_tracked' | 'market_benchmark' | 'manual_value'
// confirmed: official statement · owner_reported: read off by the owner ·
// derived: confirmed quantity × validated market price · estimated: benchmark.
export type CurrentValueQuality = 'confirmed' | 'owner_reported' | 'derived' | 'estimated'

export type CashPolicy = {
  presentation: 'in_headline' | 'separate'
  roundingToleranceEur: number // per platform, absolute
}
export const DEFAULT_CASH_POLICY: CashPolicy = { presentation: 'in_headline', roundingToleranceEur: 0.1 }

export type DataGap = {
  source: 'live_quote' | 'fx_rate' | 'transaction_fx' | 'cash' | 'yahoo_history' | 'ecb_fx' | 'return_period' | 'consistency'
  item: string // ticker, currency, investment or platform
  requestedFrom: string | null
  requestedTo: string
  lastAvailableDate: string | null
  reason: string
}

export type CurrentPosition = {
  investmentId: string
  name: string
  platform: string
  type: Investment['type']
  quantity: number
  remainingCostEur: number
  currency: string
  priceNative: number | null
  priceAsOf: string | null
  fxEurPerUnit: number | null
  valueEur: number | null
  marketValueEur: number | null // the same quantity at the plain market/benchmark price
  unrealisedEur: number | null
  source: CurrentValueSource | null
  quality: CurrentValueQuality | null
  note: string | null
}

export type BrokerCash = {
  presentation: CashPolicy['presentation']
  roundingToleranceEur: number
  totalEur: number | null
  byPlatform: { platform: string; valueEur: number; withinTolerance: boolean }[]
  // Cash above the rounding tolerance that is NOT in the shown value: needs a decision.
  policyDecisionNeeded: boolean
}

export type CurrentValuation = {
  asOf: string // date
  status: 'ok' | 'unavailable'
  totalEur: number | null // THE shown portfolio value (per the cash policy)
  positionsEur: number | null // investment positions only
  cashEur: number | null // reconstructed broker cash (internal)
  ledgerTotalEur: number | null // positions + cash: where the return ledger ends
  costOfOpenPositionsEur: number
  positions: CurrentPosition[]
  cash: { platform: string; valueEur: number }[]
  brokerCash: BrokerCash
  quality: CurrentValueQuality | null // the weakest position quality
  oldestPriceAsOf: string | null
  gaps: DataGap[]
}

export type FxRow = { currency: string; eurPerUnit: number; fetchedAt: string | null }
export type CurrentOfficialValue = { investmentId: string; statementDate: string; valueEur: number; quantity: number | null; source: string }

const QUALITY_ORDER: CurrentValueQuality[] = ['confirmed', 'derived', 'owner_reported', 'estimated']
const HOUR = 3_600_000

function ageHours(nowIso: string, thenIso: string | null): number {
  if (!thenIso) return Infinity
  const t = Date.parse(thenIso)
  return Number.isFinite(t) ? (Date.parse(nowIso) - t) / HOUR : Infinity
}

/** Dealer anchors (metals) from statements of any date and owner observations. */
export function dealerAnchorsFrom(
  investments: Investment[],
  officialValues: CurrentOfficialValue[],
  observations: BrokerValueObservation[],
  now: string
): DealerAnchor[] {
  const metal = new Set(investments.filter((i) => i.type === 'commodity').map((i) => i.id))
  return [
    ...officialValues.filter((o) => metal.has(o.investmentId)).map((o): DealerAnchor => ({
      investmentId: o.investmentId, date: o.statementDate, valueEur: o.valueEur, quantity: o.quantity, source: o.source, kind: 'official_statement',
    })),
    ...observations
      .filter((o) => metal.has(o.investmentId) && o.currency === 'EUR' && o.observedAt <= now && viewObservation(o, now).consistent)
      .map((o): DealerAnchor => ({
        investmentId: o.investmentId, date: o.observedAt.slice(0, 10), valueEur: o.totalValue, quantity: o.quantity, source: o.source, kind: 'owner_observation',
      })),
  ]
}

export function computeCurrentValuation(args: {
  investments: Investment[]
  transactions: Transaction[]
  flows: ReturnFlow[]
  fxRows: FxRow[]
  now: string // ISO date-time of the valuation
  today: string // YYYY-MM-DD
  anchor?: OfficialAnchor
  accountingTreatments?: AccountingTreatment[]
  officialValues?: CurrentOfficialValue[]
  observations?: BrokerValueObservation[]
  // Benchmark history for the dealer anchors of metals (only those dates are used).
  prices?: Map<string, PriceSeries>
  fx?: FxSeries
  cashPolicy?: CashPolicy
}): CurrentValuation {
  const {
    investments, transactions, flows, fxRows, now, today, anchor, accountingTreatments = [], officialValues = [],
    observations = [], prices = new Map(), fx = {}, cashPolicy = DEFAULT_CASH_POLICY,
  } = args
  const gaps: DataGap[] = []
  const gap = (g: Omit<DataGap, 'requestedTo'>) => {
    if (!gaps.some((x) => x.source === g.source && x.reason === g.reason)) gaps.push({ ...g, requestedTo: today })
  }
  const fxRates: FxRates = { EUR: 1, ...Object.fromEntries(fxRows.map((r) => [r.currency, r.eurPerUnit])) }
  const anchors = dealerAnchorsFrom(investments, officialValues, observations, now)

  // Current FX rate, validated for age.
  const fxNow = (currency: string, investment: string): number | null => {
    if (currency === 'EUR') return 1
    const row = fxRows.find((r) => r.currency === currency)
    if (!row || !(row.eurPerUnit > 0) || !Number.isFinite(row.eurPerUnit)) {
      gap({ source: 'fx_rate', item: currency, requestedFrom: null, lastAvailableDate: null, reason: `No current ${currency}→EUR rate (needed for ${investment}).` })
      return null
    }
    if (ageHours(now, row.fetchedAt) > FX_RATE_MAX_AGE_HOURS) {
      gap({
        source: 'fx_rate', item: currency, requestedFrom: null, lastAvailableDate: row.fetchedAt?.slice(0, 10) ?? null,
        reason: `The ${currency}→EUR rate is older than ${FX_RATE_MAX_AGE_HOURS} hours (needed for ${investment}).`,
      })
      return null
    }
    return row.eurPerUnit
  }

  const positions: CurrentPosition[] = []
  for (const inv of investments) {
    const txs = transactions.filter((t) => t.investment_id === inv.id)
    if (!txs.length) continue
    const label = `${inv.name} (${inv.platform})`
    // Historical rows must carry their own FX rate: today's rate is never
    // applied to a past transaction.
    for (const t of txs) {
      const price = txPriceRateToEur(t, fxRates)
      const fee = (t.fee ?? 0) !== 0 ? txFeeRateToEur(t, fxRates) : { rate: 1, basis: 'eur' as const }
      if (price.basis === 'missing' || price.basis === 'live_fallback' || fee.basis === 'missing' || fee.basis === 'live_fallback') {
        gap({
          source: 'transaction_fx', item: `${label} ${t.date}`, requestedFrom: t.date, lastAvailableDate: null,
          reason: `${label}: the ${t.type} on ${t.date} has no exchange rate of its own date.`,
        })
      }
    }
    const replay = replayInvestment(inv, txs, fxRates, today, today)
    const currency = inv.currency ?? 'EUR'
    if (!hasUnits(inv.type)) {
      const v = inv.current_value
      if (v == null || !Number.isFinite(Number(v))) {
        gap({ source: 'live_quote', item: label, requestedFrom: null, lastAvailableDate: null, reason: `${label}: no current value.` })
        continue
      }
      const rate = fxNow(currency, label)
      const valueEur = rate === null ? null : Number(v) * rate
      positions.push({
        investmentId: inv.id, name: inv.name, platform: inv.platform, type: inv.type, quantity: 0, remainingCostEur: replay.cost,
        currency, priceNative: null, priceAsOf: inv.updated_at ?? null, fxEurPerUnit: rate, valueEur, marketValueEur: valueEur,
        unrealisedEur: null, source: 'manual_value', quality: 'derived', note: 'Value entered manually.',
      })
      continue
    }
    const quantity = quantityOn(inv, txs, today)
    if (!(quantity > 1e-9)) continue

    // The validated current market (or benchmark) value of the quantity.
    let marketValueEur: number | null = null
    let priceNative: number | null = null
    let priceAsOf: string | null = null
    let fxEurPerUnit: number | null = null
    let marketGap: Omit<DataGap, 'requestedTo'> | null = null
    const price = inv.current_price == null ? NaN : Number(inv.current_price)
    // Every missing piece is reported, not only the first one.
    const rate = fxNow(currency, label)
    if (!(price > 0) || !Number.isFinite(price)) {
      marketGap = { source: 'live_quote', item: inv.ticker ?? label, requestedFrom: null, lastAvailableDate: null, reason: `${label}: no current price.` }
    } else if (ageHours(now, inv.price_last_updated_at) > LIVE_QUOTE_MAX_AGE_HOURS) {
      marketGap = {
        source: 'live_quote', item: inv.ticker ?? label, requestedFrom: null,
        lastAvailableDate: inv.price_last_updated_at?.slice(0, 10) ?? null,
        reason: `${label}: the current price is older than ${LIVE_QUOTE_MAX_AGE_HOURS} hours.`,
      }
    } else if (rate !== null) {
      priceNative = price
      priceAsOf = inv.price_last_updated_at
      fxEurPerUnit = rate
      marketValueEur = quantity * price * rate
    }

    let valueEur: number | null = null
    let source: CurrentValueSource | null = null
    let quality: CurrentValueQuality | null = null
    let note: string | null = null

    if (inv.type === 'commodity') {
      const official = officialValues
        .filter((o) => o.investmentId === inv.id && o.statementDate <= today)
        .sort((a, b) => (a.statementDate < b.statementDate ? 1 : -1))[0]
      const obs = observations
        .filter((o) => o.investmentId === inv.id && o.observedAt <= now)
        .sort((a, b) => (a.observedAt < b.observedAt ? 1 : -1))[0]
      const view = obs ? viewObservation(obs, now) : null
      if (official && official.statementDate === today && official.quantity != null && Math.abs(official.quantity - quantity) <= 1e-6) {
        valueEur = official.valueEur
        source = 'official_statement'
        quality = 'confirmed'
        priceAsOf = official.statementDate
        note = official.source
      } else if (view && obs!.observedAt.slice(0, 10) === today && view.consistent && Math.abs(obs!.quantity - quantity) <= 1e-6) {
        const rate = fxNow(obs!.currency, label)
        if (rate !== null) {
          valueEur = obs!.totalValue * rate
          source = 'owner_observation'
          quality = 'owner_reported'
          priceAsOf = obs!.observedAt
          note = `${obs!.source}${obs!.evidence === 'none' ? ' (no evidence)' : ` (${obs!.evidence})`}`
        }
      } else if (marketValueEur !== null) {
        const d = dealerFactors(inv, txs, anchors, prices, fx)
        const f = dealerFactorOn(d.factors, today)
        const neededAnchor = anchors.some((a) => a.investmentId === inv.id)
        if (f) {
          valueEur = marketValueEur * f.factor
          source = 'dealer_anchor_tracked'
          quality = 'estimated'
          note = `Dealer value of ${f.date} (${f.source}) moved with the COMEX benchmark.`
        } else if (neededAnchor) {
          // A dealer value exists but its benchmark price is missing: no guess.
          gap({
            source: 'yahoo_history', item: inv.ticker ?? label, requestedFrom: anchors.filter((a) => a.investmentId === inv.id).map((a) => a.date).sort()[0],
            lastAvailableDate: null, reason: `${label}: no benchmark price on the dealer-value date (${d.notes[0] ?? 'missing history'}).`,
          })
        } else {
          valueEur = marketValueEur
          source = 'market_benchmark'
          quality = 'estimated'
          note = 'Market benchmark (COMEX), not the dealer’s own price.'
        }
        if (view && Math.abs(view.observation.quantity - quantity) <= 1e-6 && !view.consistent) {
          note = `${note ?? ''} Observation ignored: quantity × price ≠ its total (±${OBSERVATION_VALUE_TOLERANCE}).`.trim()
        }
      } else if (marketGap) {
        gap(marketGap)
      }
    } else if (marketValueEur !== null) {
      valueEur = marketValueEur
      source = 'market_quote'
      quality = 'derived'
    } else if (marketGap) {
      gap(marketGap)
    }

    positions.push({
      investmentId: inv.id, name: inv.name, platform: inv.platform, type: inv.type, quantity,
      remainingCostEur: replay.cost, currency, priceNative, priceAsOf, fxEurPerUnit, valueEur, marketValueEur,
      unrealisedEur: valueEur === null ? null : valueEur - replay.cost, source, quality, note,
    })
  }

  // Broker cash, exactly as the return ledger reconstructs it.
  const platforms = ledgerPlatforms(investments, transactions, flows, accountingTreatments)
  const rec = buildRecordEffects({ investments, transactions, flows, fxRates, endDate: today, accountingTreatments })
  const cashSeries = reconstructCash({ effects: rec.effects, platforms, startDate: today, endDate: today, anchor })
  const cash = platforms.map((p) => ({ platform: p, valueEur: cashSeries.values[p].get(today) ?? 0 }))
  for (const c of cash) {
    if (!Number.isFinite(c.valueEur)) {
      gap({ source: 'cash', item: c.platform, requestedFrom: null, lastAvailableDate: null, reason: `Cash ${c.platform} cannot be reconstructed (missing FX on a record).` })
    }
  }

  const valued = positions.every((p) => p.valueEur !== null && Number.isFinite(p.valueEur))
  const positionsEur = valued ? positions.reduce((s, p) => s + (p.valueEur as number), 0) : null
  const cashOk = cash.every((c) => Number.isFinite(c.valueEur))
  const cashEur = cashOk ? cash.reduce((s, c) => s + c.valueEur, 0) : null
  if (positionsEur !== null && cashEur !== null) {
    const shortfall = cash.reduce((s, c) => s + (c.valueEur < -CASH_NEGATIVE_TOLERANCE_EUR ? -c.valueEur : 0), 0)
    if (isMaterialCashShortfall(shortfall, positionsEur + cashEur)) {
      for (const c of cash.filter((x) => x.valueEur < -CASH_NEGATIVE_TOLERANCE_EUR)) {
        gap({ source: 'cash', item: c.platform, requestedFrom: null, lastAvailableDate: null, reason: `Cash ${c.platform} is ${c.valueEur.toFixed(2)} EUR: purchases without recorded funding.` })
      }
    }
  }
  const ok = gaps.length === 0 && positionsEur !== null && cashEur !== null
  const byPlatform = cash.map((c) => ({ ...c, withinTolerance: Math.abs(c.valueEur) <= cashPolicy.roundingToleranceEur }))
  const brokerCash: BrokerCash = {
    presentation: cashPolicy.presentation,
    roundingToleranceEur: cashPolicy.roundingToleranceEur,
    totalEur: ok ? cashEur : null,
    byPlatform,
    policyDecisionNeeded: cashPolicy.presentation === 'separate' && byPlatform.some((c) => !c.withinTolerance),
  }
  const qualities = positions.map((p) => p.quality).filter((q): q is CurrentValueQuality => q !== null)
  const priceDates = positions.map((p) => p.priceAsOf).filter((d): d is string => !!d).sort()
  return {
    asOf: today,
    status: ok ? 'ok' : 'unavailable',
    totalEur: ok ? (cashPolicy.presentation === 'in_headline' ? (positionsEur as number) + (cashEur as number) : positionsEur) : null,
    positionsEur: ok ? positionsEur : null,
    cashEur: ok ? cashEur : null,
    ledgerTotalEur: ok ? (positionsEur as number) + (cashEur as number) : null,
    costOfOpenPositionsEur: positions.reduce((s, p) => s + p.remainingCostEur, 0),
    positions,
    cash,
    brokerCash,
    quality: qualities.length ? qualities.reduce((w, q) => (QUALITY_ORDER.indexOf(q) > QUALITY_ORDER.indexOf(w) ? q : w)) : null,
    oldestPriceAsOf: priceDates[0] ?? null,
    gaps,
  }
}

/** The end-date values the return ledger must use: exactly the current valuation. */
export function endValuesFrom(v: CurrentValuation): Map<string, EndValue> {
  const toLedgerQuality = (q: CurrentValueQuality | null): EndValue['quality'] =>
    q === 'confirmed' ? 'confirmed' : q === 'derived' ? 'reconstructed' : 'estimated'
  return new Map(
    v.positions
      .filter((p) => p.valueEur !== null)
      .map((p) => [p.investmentId, {
        valueEur: p.valueEur as number,
        marketValueEur: p.marketValueEur,
        priceNative: p.priceNative,
        fxEurPerUnit: p.fxEurPerUnit,
        currency: p.marketValueEur !== null ? p.currency : null,
        quality: toLedgerQuality(p.quality),
      }])
  )
}

/**
 * Allocation slices (pct = fraction) of the open positions, from the current
 * valuation only; broker cash is not a position and is shown apart. Empty
 * when the valuation is incomplete: one unknown value makes every share wrong.
 */
export function allocationSlices(v: CurrentValuation, key: (p: CurrentPosition) => string): { key: string; value: number; pct: number }[] {
  if (v.status !== 'ok' || v.positionsEur === null) return []
  const m = new Map<string, number>()
  for (const p of v.positions) m.set(key(p), (m.get(key(p)) ?? 0) + (p.valueEur as number))
  const total = v.positionsEur
  return [...m]
    .filter(([, value]) => value > 0)
    .map(([k, value]) => ({ key: k, value, pct: total > 0 ? value / total : 0 }))
    .sort((a, b) => b.value - a.value)
}
