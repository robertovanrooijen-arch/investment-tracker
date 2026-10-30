import type { Investment, Transaction } from '@/types/database'
import { hasUnits } from '@/lib/domain/constants'
import { allocateSale, isEffectivelyZero } from '@/lib/domain/cost-basis'
import {
  investmentPriceUnit,
  normalizeQuote,
  quoteUnitForSymbol,
  type PriceUnit,
} from '@/lib/domain/price-normalization'

// ---------------------------------------------------------------------------
// Historical valuation (pure). Reconstructs, for a valuation date D, what each
// position was worth at the close of D — from transactions, raw historical
// closes and historical FX. No database access, no network.
//
// Rules:
//  * quantity = replay of buys/sells dated ≤ D (moving-average engine's
//    closing rules, so a fully sold position is exactly 0 from its sale);
//  * price = UNADJUSTED close of the last trading day ≤ D and at most
//    MAX_PRICE_AGE_DAYS older than D; Yahoo closes are split-adjusted, so a
//    split dated after the price date is undone (close × split ratio);
//  * the quote is normalised to the investment's unit (gram / troy ounce)
//    and converted to EUR with the FX rate of the PRICE date (≤ that date,
//    at most MAX_FX_AGE_DAYS older);
//  * dividends/interest are income (cash), never part of a holding's market
//    value — so they cannot be counted twice here;
//  * cash / real-estate / custom positions have no historical balance in the
//    data → 'not_reconstructable' (never today's balance);
//  * a portfolio total exists only when EVERY position is complete.
// ---------------------------------------------------------------------------

export const MAX_PRICE_AGE_DAYS = 7
export const MAX_FX_AGE_DAYS = 7

export type DailyClose = { date: string; close: number } // raw (split-adjusted by Yahoo) close
export type PriceSeries = {
  symbol: string
  currency: string // ISO, already normalised (GBp → GBP etc.)
  unit?: PriceUnit // defaults to quoteUnitForSymbol(symbol)
  closes: DailyClose[] // ascending
  splits?: { date: string; ratio: number }[] // ratio = new shares per old share
  source: string
  fetchedAt: string
}
export type FxSeries = Record<string, { date: string; eurPerUnit: number }[]> // per currency, ascending

export type PositionValuationQuality =
  | 'official' // value from an official statement (leading)
  | 'official_quantity_mismatch' // statement quantity ≠ books → not usable until explained
  | 'exact' // exchange close of a listed security (market value, not official)
  | 'benchmark_only' // metals: Yahoo/COMEX benchmark only, never a portfolio value
  | 'closed'
  | 'missing_price'
  | 'stale_price'
  | 'missing_fx'
  | 'unit_unknown'
  | 'not_reconstructable'

export type PositionValuation = {
  investmentId: string
  valuationDate: string
  quantity: number
  unit: PriceUnit | null
  priceNative: number | null // per investment unit, in priceCurrency
  priceCurrency: string | null
  priceDate: string | null
  priceSource: string | null
  splitFactorApplied: number
  fxEurPerUnit: number | null
  fxDate: string | null
  valueEur: number | null
  // Where valueEur comes from. Benchmarks are reported separately and never
  // become a portfolio value.
  valueSource: 'official' | 'market_close' | null
  benchmarkValueEur: number | null
  officialSource: string | null
  quality: PositionValuationQuality
  complete: boolean
  note: string | null
}

export type OfficialValue = { investmentId: string; valueEur: number; quantity?: number | null; source: string }
export type OfficialCash = { platform: string; amountEur: number; source: string }

export type PortfolioValuation = {
  valuationDate: string
  positions: PositionValuation[]
  // Confirmed broker cash from statements (never derived/implied cash).
  officialCash: OfficialCash[]
  // Positions + official cash; null unless every position is complete.
  totalValueEur: number | null
  incompleteCount: number
}

const DAY = 86_400_000
const ageDays = (from: string, to: string) => (Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / DAY

function lastOnOrBefore<T extends { date: string }>(rows: T[], date: string): T | null {
  let best: T | null = null
  for (const r of rows) if (r.date <= date && (best === null || r.date > best.date)) best = r
  return best
}

export function quantityOn(investment: Investment, transactions: Transaction[], date: string): number {
  const txs = transactions
    .filter((t) => t.investment_id === investment.id && t.date <= date)
    .sort((a, b) => (a.date !== b.date ? (a.date < b.date ? -1 : 1) : a.created_at < b.created_at ? -1 : 1))
  let held = 0
  for (const t of txs) {
    if (t.quantity === null) continue
    if (t.type === 'buy') held += t.quantity
    else if (t.type === 'sell') {
      const sale = allocateSale(held, 0, 0, t.quantity)
      if (sale) held = sale.closesPosition ? 0 : held - sale.quantity
    }
  }
  return isEffectivelyZero(held) ? 0 : held
}

export function valuePosition(
  investment: Investment,
  transactions: Transaction[],
  date: string,
  prices: Map<string, PriceSeries>,
  fx: FxSeries,
  official?: OfficialValue
): PositionValuation {
  const base = {
    valueSource: null,
    benchmarkValueEur: null,
    officialSource: null,
    investmentId: investment.id,
    valuationDate: date,
    priceNative: null,
    priceCurrency: null,
    priceDate: null,
    priceSource: null,
    splitFactorApplied: 1,
    fxEurPerUnit: null,
    fxDate: null,
  }
  if (!hasUnits(investment.type)) {
    return { ...base, quantity: 0, unit: null, valueEur: null, quality: 'not_reconstructable', complete: false,
      note: 'No historical balance for a non-unit position.' }
  }
  const unit = investmentPriceUnit(investment)
  const quantity = quantityOn(investment, transactions, date)
  // Official statements are leading for historical values.
  if (official) {
    const mismatch = official.quantity != null && Math.abs(official.quantity - quantity) > 1e-6
    return {
      ...base,
      quantity,
      unit,
      valueEur: mismatch ? null : official.valueEur,
      valueSource: mismatch ? null : 'official',
      officialSource: official.source,
      quality: mismatch ? 'official_quantity_mismatch' : 'official',
      complete: !mismatch,
      note: mismatch ? `Statement quantity ${official.quantity} ≠ books ${quantity}.` : null,
    }
  }
  if (quantity === 0) {
    return { ...base, quantity: 0, unit, valueEur: 0, quality: 'closed', complete: true, note: null }
  }
  if (unit === null) {
    return { ...base, quantity, unit, valueEur: null, quality: 'unit_unknown', complete: false, note: 'Commodity without a unit.' }
  }
  const series = investment.ticker ? prices.get(investment.ticker) : undefined
  const close = series ? lastOnOrBefore(series.closes, date) : null
  if (!series || !close) {
    return { ...base, quantity, unit, valueEur: null, quality: 'missing_price', complete: false, note: 'No close on or before the date.' }
  }
  if (ageDays(close.date, date) > MAX_PRICE_AGE_DAYS) {
    return { ...base, quantity, unit, priceDate: close.date, valueEur: null, quality: 'stale_price', complete: false,
      note: `Last close ${close.date} is older than ${MAX_PRICE_AGE_DAYS} days.` }
  }
  // Undo splits that happened after the price date (Yahoo closes are split-adjusted).
  const splitFactor = (series.splits ?? []).filter((s) => s.date > close.date).reduce((f, s) => f * s.ratio, 1)
  const rawClose = close.close * splitFactor

  const fxRow = series.currency === 'EUR' ? { date: close.date, eurPerUnit: 1 } : lastOnOrBefore(fx[series.currency] ?? [], close.date)
  if (!fxRow || ageDays(fxRow.date, close.date) > MAX_FX_AGE_DAYS) {
    return { ...base, quantity, unit, priceDate: close.date, priceSource: series.source, valueEur: null, quality: 'missing_fx',
      complete: false, note: `No ${series.currency} FX rate for ${close.date}.` }
  }
  const quote = { price: rawClose, currency: series.currency, unit: series.unit ?? quoteUnitForSymbol(series.symbol), priceDate: close.date, priceType: 'close' as const }
  const perUnit = normalizeQuote(quote, { unit, currency: series.currency })
  if (perUnit.price === null) {
    return { ...base, quantity, unit, valueEur: null, quality: 'unit_unknown', complete: false, note: perUnit.reason }
  }
  const marketValueEur = quantity * perUnit.price * fxRow.eurPerUnit
  if (investment.type === 'commodity') {
    // Metals: a futures quote is a market BENCHMARK, not what the metal was
    // worth at the dealer — never presented as a portfolio value.
    return {
      ...base,
      quantity,
      unit,
      priceNative: perUnit.price,
      priceCurrency: series.currency,
      priceDate: close.date,
      priceSource: series.source,
      fxEurPerUnit: fxRow.eurPerUnit,
      fxDate: fxRow.date,
      valueEur: null,
      benchmarkValueEur: marketValueEur,
      quality: 'benchmark_only',
      complete: false,
      note: 'Yahoo/COMEX futures benchmark — not an official value; provide the dealer statement value.',
    }
  }
  return {
    ...base,
    investmentId: investment.id,
    valuationDate: date,
    quantity,
    unit,
    valueSource: 'market_close',
    priceNative: perUnit.price,
    priceCurrency: series.currency,
    priceDate: close.date,
    priceSource: series.source,
    splitFactorApplied: splitFactor,
    fxEurPerUnit: fxRow.eurPerUnit,
    fxDate: fxRow.date,
    valueEur: marketValueEur,
    quality: 'exact',
    complete: true,
    note: splitFactor !== 1 ? `Split-adjusted close × ${splitFactor} (split after ${close.date}).` : null,
  }
}

/**
 * Market close of ONE investment unit (gram, ounce or share) on/before the
 * date, in the quote currency — same freshness, split and unit rules as
 * valuePosition. null when no usable close exists.
 */
export function unitPriceOn(
  investment: Investment,
  date: string,
  prices: Map<string, PriceSeries>
): { price: number; currency: string; date: string } | null {
  const unit = investmentPriceUnit(investment)
  const series = investment.ticker ? prices.get(investment.ticker) : undefined
  const close = series ? lastOnOrBefore(series.closes, date) : null
  if (!series || !close || unit === null || ageDays(close.date, date) > MAX_PRICE_AGE_DAYS) return null
  const splitFactor = (series.splits ?? []).filter((s) => s.date > close.date).reduce((f, s) => f * s.ratio, 1)
  const quote = { price: close.close * splitFactor, currency: series.currency, unit: series.unit ?? quoteUnitForSymbol(series.symbol), priceDate: close.date, priceType: 'close' as const }
  const perUnit = normalizeQuote(quote, { unit, currency: series.currency })
  return perUnit.price === null ? null : { price: perUnit.price, currency: series.currency, date: close.date }
}

export function valuePortfolio(
  investments: Investment[],
  transactions: Transaction[],
  date: string,
  prices: Map<string, PriceSeries>,
  fx: FxSeries,
  options: { official?: OfficialValue[]; officialCash?: OfficialCash[] } = {}
): PortfolioValuation {
  // Only positions that exist by `date` (have a transaction on/before it).
  const officialById = new Map((options.official ?? []).map((o) => [o.investmentId, o]))
  const relevant = investments.filter((i) => transactions.some((t) => t.investment_id === i.id && t.date <= date))
  const positions = relevant.map((i) => valuePosition(i, transactions, date, prices, fx, officialById.get(i.id)))
  const incompleteCount = positions.filter((p) => !p.complete).length
  const officialCash = options.officialCash ?? []
  const cash = officialCash.reduce((s, c) => s + c.amountEur, 0)
  return {
    valuationDate: date,
    positions,
    officialCash,
    incompleteCount,
    totalValueEur: incompleteCount === 0 ? positions.reduce((s, p) => s + (p.valueEur ?? 0), 0) + cash : null,
  }
}

/** Snapshot row PROPOSALS (never written here); method 'reconstructed'. */
export function proposeSnapshotRows(userId: string, valuation: PortfolioValuation, fetchedAt: string) {
  return valuation.positions.map((p) => ({
    user_id: userId,
    investment_id: p.investmentId,
    date: p.valuationDate,
    quantity: p.quantity,
    current_price_native: p.priceNative,
    currency: p.priceCurrency,
    value_eur: p.valueEur,
    price_as_of: p.priceDate,
    fx_eur_per_unit: p.fxEurPerUnit,
    price_status: p.quality === 'exact' || p.quality === 'official' ? 'fresh' : p.quality === 'closed' ? 'not_applicable' : p.quality === 'stale_price' ? 'stale' : 'missing',
    method: p.valueSource === 'official' ? ('statement' as const) : ('reconstructed' as const),
    snapshot_source: p.valueSource === 'official' ? `statement:${p.officialSource}` : `reconstructed:${p.priceSource ?? 'none'}`,
    quality: p.quality,
    fetched_at: fetchedAt,
  }))
}

/** Existing snapshot rows are never overwritten: report every collision. */
export function findSnapshotConflicts(
  proposed: { investment_id: string; date: string; value_eur: number | null }[],
  existing: { investment_id: string; date: string; value_eur: number; snapshot_source: string }[]
) {
  const byKey = new Map(existing.map((e) => [`${e.investment_id}|${e.date}`, e]))
  return proposed
    .map((p) => ({ p, e: byKey.get(`${p.investment_id}|${p.date}`) }))
    .filter((x) => x.e !== undefined)
    .map(({ p, e }) => ({ investmentId: p.investment_id, date: p.date, existingValueEur: e!.value_eur, existingSource: e!.snapshot_source, proposedValueEur: p.value_eur }))
}
