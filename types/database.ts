export type InvestmentType =
  | 'stock'
  | 'ETF'
  | 'crypto'
  | 'cash'
  | 'real estate'
  | 'custom'

export type Investment = {
  id: string
  user_id: string
  name: string
  ticker: string | null
  type: InvestmentType
  platform: string
  current_price: number | null
  current_value: number | null
  notes: string | null
  created_at: string
  updated_at: string
}

export type InvestmentInput = {
  name: string
  ticker: string | null
  type: InvestmentType
  platform: string
  current_price: number | null
  current_value: number | null
  notes: string | null
}

export type TransactionType =
  | 'buy'
  | 'sell'
  | 'deposit'
  | 'withdraw'
  | 'value update'

export type Transaction = {
  id: string
  user_id: string
  investment_id: string
  type: TransactionType
  quantity: number | null
  price_per_unit: number | null
  amount: number | null
  fee: number
  date: string
  notes: string | null
  created_at: string
}