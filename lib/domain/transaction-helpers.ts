import type { TransactionType } from '@/types/database'

export const TX_TYPES: TransactionType[] = [
  'buy',
  'sell',
  'deposit',
  'withdraw',
  'value update',
]

export function usesUnits(type: TransactionType): boolean {
  return type === 'buy' || type === 'sell'
}

export function usesAmount(type: TransactionType): boolean {
  return type === 'deposit' || type === 'withdraw' || type === 'value update'
}

export function txTypeBadgeClass(type: TransactionType): string {
  switch (type) {
    case 'buy':
      return 'bg-emerald-50 text-emerald-700 border border-emerald-200'
    case 'sell':
      return 'bg-rose-50 text-rose-700 border border-rose-200'
    case 'deposit':
      return 'bg-sky-50 text-sky-700 border border-sky-200'
    case 'withdraw':
      return 'bg-amber-50 text-amber-700 border border-amber-200'
    case 'value update':
      return 'bg-slate-100 text-slate-700 border border-slate-200'
  }
}import type { InvestmentType } from '@/types/database'

export function txTypesForInvestmentType(
  type: InvestmentType
): TransactionType[] {
  if (type === 'stock' || type === 'ETF' || type === 'crypto') {
    return ['buy', 'sell']
  }
  return ['deposit', 'withdraw', 'value update']
}