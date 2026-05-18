import type { InvestmentType } from '@/types/database'

export const CATEGORY_COLORS: Record<InvestmentType, string> = {
  stock: 'bg-sky-500',
  ETF: 'bg-indigo-500',
  crypto: 'bg-amber-500',
  cash: 'bg-emerald-500',
  'real estate': 'bg-rose-500',
  custom: 'bg-slate-500',
  commodity: 'bg-yellow-500',
}

export const PLATFORM_COLORS: Record<string, string> = {
  DEGIRO:           'bg-blue-600',
  'Trade Republic': 'bg-slate-800',
  'Gold Republic':  'bg-yellow-600',
  Bitvavo:          'bg-indigo-500',
  Binance:          'bg-yellow-500',
  ING:              'bg-orange-500',
  'Real Estate':    'bg-rose-500',
  Custom:           'bg-slate-500',
}

export function categoryColor(type: InvestmentType | string): string {
  return (CATEGORY_COLORS as Record<string, string>)[type] ?? 'bg-slate-400'
}

export function platformColor(platform: string): string {
  return PLATFORM_COLORS[platform] ?? 'bg-slate-400'
}