import type {
  InvestmentType,
  CommodityKind,
  QuantityUnit,
} from '@/types/database'

export const CATEGORIES: InvestmentType[] = [
  'stock',
  'ETF',
  'crypto',
  'cash',
  'real estate',
  'custom',
  'commodity',
]

export const PLATFORMS: string[] = [
  'Degiro',
  'Trade Republic',
  'Binance',
  'ING',
  'Real Estate',
  'Custom',
]

// ---------------------------------------------------------------------------
// Commodity (bullion) constants — Step 1
// ---------------------------------------------------------------------------
// Storage-layer support only. Forms, refresh logic, and calculations will be
// wired up in later steps.

export const COMMODITY_KINDS: CommodityKind[] = ['gold', 'silver']

export const QUANTITY_UNITS: QuantityUnit[] = ['gram', 'troy_ounce']

// One troy ounce = 31.1034768 grams. Yahoo metal feeds quote price per troy
// ounce; if quantity_unit is 'gram', divide by this constant before storing
// as current_price. (Not used yet — refresh logic is unchanged in Step 1.)
export const GRAMS_PER_TROY_OUNCE = 31.1034768

// Default Yahoo tickers for spot bullion.
//
// Why these: physical bullion in Europe should track SPOT, not COMEX futures.
//   - GC=F / SI=F are COMEX futures in USD per troy ounce — kept as optional
//     manual fallback tickers, NOT defaults.
//   - XAU* / XAG* are spot quotes in the chosen currency per troy ounce.
//
// Sanity check: gold per gram should be roughly €100–€150/g (not €2–€4/g).
// If you see €2–€4/g you're almost certainly using a futures ticker without
// the troy-ounce → gram conversion.
export const DEFAULT_COMMODITY_TICKERS: Record<
  CommodityKind,
  Record<'EUR' | 'USD', string>
> = {
  gold: { EUR: 'XAUEUR=X', USD: 'XAUUSD=X' },
  silver: { EUR: 'XAGEUR=X', USD: 'XAGUSD=X' },
}

// Optional manual fallback tickers (COMEX futures, USD/oz).
// Not used as defaults; exposed so a future form can offer them.
export const FALLBACK_COMMODITY_TICKERS: Record<CommodityKind, string> = {
  gold: 'GC=F',
  silver: 'SI=F',
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

export function hasUnits(type: InvestmentType): boolean {
  return (
    type === 'stock' ||
    type === 'ETF' ||
    type === 'crypto' ||
    type === 'commodity'
  )
}
