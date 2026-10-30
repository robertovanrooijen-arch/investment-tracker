import { GRAMS_PER_TROY_OUNCE } from '@/lib/domain/constants'
import type { InvestmentType, QuantityUnit } from '@/types/database'

// Yahoo quotes some markets in MINOR units (pence, cents, agorot). Those are
// normalised to the ISO major currency before anything is stored, so a
// London listing in "GBp" can never be valued 100× too high.
const MINOR_UNIT_CURRENCIES: Record<string, { major: string; divisor: number }> = {
  GBp: { major: 'GBP', divisor: 100 },
  GBX: { major: 'GBP', divisor: 100 },
  ZAc: { major: 'ZAR', divisor: 100 },
  ILA: { major: 'ILS', divisor: 100 },
}

export type NormalizedQuote = { price: number; currency: string }

/**
 * Normalises a raw Yahoo quote to an ISO-4217 major currency.
 * Returns null for a currency that is missing or not a recognisable code —
 * an unknown unit is rejected rather than guessed.
 */
export function normalizeQuoteCurrency(price: number, currency: string | null | undefined): NormalizedQuote | null {
  if (!Number.isFinite(price) || price <= 0) return null
  if (!currency) return null
  const minor = MINOR_UNIT_CURRENCIES[currency]
  if (minor) return { price: price / minor.divisor, currency: minor.major }
  if (/^[A-Z]{3}$/.test(currency)) return { price, currency }
  return null
}

export type PriceForStorage =
  | { ok: true; price: number; currency: string }
  | { ok: false; reason: string }

/**
 * Validates a fetched quote against the investment it is about to update and
 * returns the price to store in investments.current_price.
 *
 * - The stored investments.currency is the source of truth and is NEVER
 *   overwritten by Yahoo: a quote in a different currency is rejected (the
 *   old price stays, and the caller reports it as failed/stale).
 * - Commodity positions tracked in grams get the per-troy-ounce quote
 *   converted to a per-gram price.
 */
export function priceForStorage(
  rawPrice: number,
  rawCurrency: string | null | undefined,
  investment: { type: InvestmentType; currency: string | null; quantity_unit: QuantityUnit | null }
): PriceForStorage {
  const quote = normalizeQuoteCurrency(rawPrice, rawCurrency)
  if (!quote) {
    return { ok: false, reason: `Unusable quote (price ${rawPrice}, currency "${rawCurrency ?? ''}").` }
  }
  const expected = investment.currency ?? 'EUR'
  if (quote.currency !== expected) {
    return {
      ok: false,
      reason: `Quote is in ${quote.currency} but this investment is priced in ${expected}; price not saved.`,
    }
  }
  const price =
    investment.type === 'commodity' && investment.quantity_unit === 'gram'
      ? quote.price / GRAMS_PER_TROY_OUNCE
      : quote.price
  return { ok: true, price, currency: quote.currency }
}

// ---------------------------------------------------------------------------
// Per-position price quality, recorded with each snapshot (once the pending
// investment_snapshots.price_status column exists).
// ---------------------------------------------------------------------------

export type PriceStatus = 'fresh' | 'stale' | 'missing' | 'not_applicable'

/**
 * - not_applicable: no market price involved (cash, real estate, custom, or a
 *   unit position that is fully closed).
 * - missing: an open unit position with no usable price at all.
 * - fresh: price successfully refreshed in this run.
 * - stale: an open unit position still valued with an older price (this run's
 *   refresh failed, was skipped, or never happened).
 */
export function priceStatusFor(input: {
  isUnitBased: boolean
  isOpen: boolean
  currentPrice: number | null
  refreshedThisRun: boolean
}): PriceStatus {
  if (!input.isUnitBased || !input.isOpen) return 'not_applicable'
  if (input.currentPrice === null || !(input.currentPrice > 0)) return 'missing'
  return input.refreshedThisRun ? 'fresh' : 'stale'
}
