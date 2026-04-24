import type { InvestmentType } from '@/types/database'

export const CATEGORIES: InvestmentType[] = [
  'stock',
  'ETF',
  'crypto',
  'cash',
  'real estate',
  'custom',
]

export const PLATFORMS: string[] = [
  'Degiro',
  'Trade Republic',
  'Binance',
  'ING',
  'Real Estate',
  'Custom',
]

export function hasUnits(type: InvestmentType): boolean {
  return type === 'stock' || type === 'ETF' || type === 'crypto'
}