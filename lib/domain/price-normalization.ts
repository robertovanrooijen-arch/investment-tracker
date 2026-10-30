import { GRAMS_PER_TROY_OUNCE } from '@/lib/domain/constants'
import type { Investment } from '@/types/database'

// ---------------------------------------------------------------------------
// Before ANY price comparison (market return, historical valuation) both
// sides are brought to the same quantity unit, currency, price date basis and
// price type. A comparison that cannot be normalised returns null — never a
// silent fallback to a wrong unit (e.g. a per-gram price against a per-troy-
// ounce close, which produced impossible ~−97% "returns").
// ---------------------------------------------------------------------------

export type PriceUnit = 'unit' | 'gram' | 'troy_ounce'

// 'close' = unadjusted exchange close; 'adj_close' = dividend/split adjusted;
// 'live' = the current (unadjusted) market price.
export type PriceType = 'close' | 'adj_close' | 'live'

export type PriceQuote = {
  price: number
  currency: string // ISO-4217 major currency
  unit: PriceUnit
  priceDate: string // trading day the price belongs to (YYYY-MM-DD)
  priceType: PriceType
}

export type NormalizeResult = { price: number; reason: null } | { price: null; reason: string }

/** Unit in which an investment's quantity (and stored current_price) is expressed. */
export function investmentPriceUnit(inv: Pick<Investment, 'type' | 'quantity_unit'>): PriceUnit | null {
  if (inv.type !== 'commodity') return 'unit'
  if (inv.quantity_unit === 'gram') return 'gram'
  if (inv.quantity_unit === 'troy_ounce') return 'troy_ounce'
  return null // a commodity without a unit is never guessed
}

/**
 * Unit of the quotes a market-data symbol returns. Precious-metal futures
 * (COMEX GC=F / SI=F) quote per troy ounce; everything else per unit/share.
 */
export function quoteUnitForSymbol(symbol: string | null): PriceUnit {
  if (symbol && /^(GC|SI|PL|PA)=F$/i.test(symbol.trim())) return 'troy_ounce'
  return 'unit'
}

/** Price per `from` unit → price per `to` unit. null for incompatible units. */
export function convertPriceUnit(price: number, from: PriceUnit, to: PriceUnit): number | null {
  if (from === to) return price
  if (from === 'troy_ounce' && to === 'gram') return price / GRAMS_PER_TROY_OUNCE
  if (from === 'gram' && to === 'troy_ounce') return price * GRAMS_PER_TROY_OUNCE
  return null
}

/**
 * Express a quote in a target unit and currency. `eurPerUnit` must be the FX
 * rates valid on the quote's own priceDate (historical FX for a historical
 * price, current FX for a live price). Same currency needs no FX.
 */
export function normalizeQuote(
  quote: PriceQuote,
  target: { unit: PriceUnit; currency: string },
  eurPerUnit?: Record<string, number>
): NormalizeResult {
  if (!Number.isFinite(quote.price) || quote.price <= 0) return { price: null, reason: 'No usable price.' }
  const perTargetUnit = convertPriceUnit(quote.price, quote.unit, target.unit)
  if (perTargetUnit === null) {
    return { price: null, reason: `Cannot convert a price per ${quote.unit} to a price per ${target.unit}.` }
  }
  if (quote.currency === target.currency) return { price: perTargetUnit, reason: null }
  const from = quote.currency === 'EUR' ? 1 : eurPerUnit?.[quote.currency]
  const to = target.currency === 'EUR' ? 1 : eurPerUnit?.[target.currency]
  if (!(from && from > 0) || !(to && to > 0)) {
    return { price: null, reason: `No ${quote.priceDate} FX rate to convert ${quote.currency} to ${target.currency}.` }
  }
  return { price: (perTargetUnit * from) / to, reason: null }
}

export type MarketReturn = { percent: number | null; reason: string | null }

/**
 * Pure price return between two quotes, after normalising both to the same
 * unit and currency. Unadjusted and adjusted prices are never mixed.
 */
export function marketReturn(
  start: PriceQuote,
  end: PriceQuote,
  target: { unit: PriceUnit; currency: string },
  fx: { start?: Record<string, number>; end?: Record<string, number> } = {}
): MarketReturn {
  const adjusted = (t: PriceType) => t === 'adj_close'
  if (adjusted(start.priceType) !== adjusted(end.priceType)) {
    return { percent: null, reason: 'Adjusted and unadjusted prices cannot be compared.' }
  }
  const a = normalizeQuote(start, target, fx.start)
  if (a.price === null) return { percent: null, reason: a.reason }
  const b = normalizeQuote(end, target, fx.end)
  if (b.price === null) return { percent: null, reason: b.reason }
  return { percent: (b.price / a.price - 1) * 100, reason: null }
}
