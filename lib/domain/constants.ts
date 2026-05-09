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

// Default Yahoo Finance tickers for bullion (COMEX futures, USD/troy oz).
// GC=F and SI=F are the tickers that work in Yahoo's API.
// The XAU*/XAG* spot tickers (e.g. XAUEUR=X) return 404 from Yahoo.
export const DEFAULT_COMMODITY_TICKERS: Record<CommodityKind, string> = {
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