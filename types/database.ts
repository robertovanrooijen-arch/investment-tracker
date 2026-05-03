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
    currency: string
    price_last_updated_at: string | null
    price_source: string | null
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
    currency: string
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
  currency: string
  price_last_updated_at: string | null
  price_source: string | null
}
export type FxRate = {
  currency: string
  eur_per_unit: number
  fetched_at: string
}

export type PortfolioSnapshot = {
  user_id: string
  date: string                  // 'YYYY-MM-DD'
  total_value_eur: number
  total_invested_eur: number
  total_realized_eur: number
  total_unrealized_eur: number
  total_ever_invested_eur: number
  snapshot_source: string
  created_at: string
  updated_at: string
}
