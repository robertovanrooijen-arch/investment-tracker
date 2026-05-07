import type { InvestmentType, TransactionType } from '@/types/database'

export const TX_TYPES: TransactionType[] = [
  'buy',
  'sell',
  'dividend',
  'deposit',
  'withdraw',
  'interest',
  'fee',
  'value update',
]

export function usesUnits(type: TransactionType): boolean {
  return type === 'buy' || type === 'sell'
}

export function usesAmount(type: TransactionType): boolean {
  return (
    type === 'deposit' ||
    type === 'withdraw' ||
    type === 'interest' ||
    type === 'fee' ||
    type === 'value update'
  )
}

export function txTypeBadgeClass(type: TransactionType): string {
  switch (type) {
    case 'buy':
      return 'bg-emerald-50 text-emerald-700 border border-emerald-200'
    case 'sell':
      return 'bg-rose-50 text-rose-700 border border-rose-200'
    case 'dividend':
      return 'bg-purple-50 text-purple-700 border border-purple-200'
    case 'deposit':
      return 'bg-sky-50 text-sky-700 border border-sky-200'
    case 'withdraw':
      return 'bg-amber-50 text-amber-700 border border-amber-200'
    case 'interest':
      return 'bg-lime-50 text-lime-700 border border-lime-200'
    case 'fee':
      return 'bg-orange-50 text-orange-700 border border-orange-200'
    case 'value update':
      return 'bg-slate-100 text-slate-700 border border-slate-200'
    default:
      return 'bg-slate-100 text-slate-700 border border-slate-200'
  }
}

export function txTypesForInvestmentType(
  type: InvestmentType
): TransactionType[] {
  if (type === 'stock' || type === 'ETF' || type === 'crypto') {
    return ['buy', 'sell', 'dividend']
  }

  return ['deposit', 'withdraw', 'interest', 'fee', 'value update']
}