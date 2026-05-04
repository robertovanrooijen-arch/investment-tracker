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
  // Phase 1 (mixed-currency support):
  // - For backfilled rows, price_currency and fee_currency equal the
  //   investment's currency (single-currency assumption preserved).
  // - For new rows inserted before Phase 2 ships, these are NULL — calculations
  //   fall back to investment.currency, which is the same behaviour as today.
  // - fx_rate_to_eur is NULL until Phase 2 starts snapshotting it on save.
  price_currency: string | null
  fee_currency: string | null
  fx_rate_to_eur: number | null
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

export type InvestmentSnapshot = {
  user_id: string
  investment_id: string
  date: string
  value_eur: number
  remaining_cost_basis_eur: number
  realized_profit_eur: number
  unrealized_profit_eur: number
  quantity: number | null
  current_price_native: number | null
  currency: string
  snapshot_source: string
  created_at: string
  updated_at: string
}