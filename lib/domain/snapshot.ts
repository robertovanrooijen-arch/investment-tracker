import type { SupabaseClient } from '@supabase/supabase-js'
import type {
  InvestmentMetrics,
  PortfolioMetrics,
} from '@/lib/domain/calculations'

export type SnapshotSource = 'manual_refresh' | 'cron'

export type UpsertedSnapshot = {
  date: string
  total_value_eur: number
  total_invested_eur: number
  total_realized_eur: number
  total_unrealized_eur: number
  total_ever_invested_eur: number
  snapshot_source: string
  updated_at: string
}

export type InvestmentSnapshotInput = {
  investmentId: string
  metrics: InvestmentMetrics // already converted to EUR
  currentPriceNative: number | null
  currency: string
}

function todayLocalIso(): string {
  const d = new Date()
  const yyyy = d.getFullYear()
  const mm = String(d.getMonth() + 1).padStart(2, '0')
  const dd = String(d.getDate()).padStart(2, '0')
  return `${yyyy}-${mm}-${dd}`
}

/**
 * Upsert today's portfolio-level snapshot for the given user.
 */
export async function upsertTodaysSnapshot(
  supabase: SupabaseClient,
  userId: string,
  metrics: PortfolioMetrics,
  source: SnapshotSource = 'manual_refresh'
): Promise<{ snapshot: UpsertedSnapshot | null; error: string | null }> {
  const date = todayLocalIso()
  const updatedAt = new Date().toISOString()

  const row = {
    user_id: userId,
    date,
    total_value_eur: metrics.totalValue,
    total_invested_eur: metrics.totalInvested,
    total_realized_eur: metrics.totalRealized,
    total_unrealized_eur: metrics.totalUnrealized,
    total_ever_invested_eur: metrics.totalEverInvested,
    snapshot_source: source,
    updated_at: updatedAt,
  }

  const { data, error } = await supabase
    .from('portfolio_snapshots')
    .upsert(row, { onConflict: 'user_id,date' })
    .select(
      'date, total_value_eur, total_invested_eur, total_realized_eur, total_unrealized_eur, total_ever_invested_eur, snapshot_source, updated_at'
    )
    .single()

  if (error) return { snapshot: null, error: error.message }
  return { snapshot: data as UpsertedSnapshot, error: null }
}

/**
 * Upsert today's per-investment snapshots for the given user.
 * Overwrites within the same day, never duplicates, thanks to the
 * (user_id, investment_id, date) composite primary key.
 */
export async function upsertTodaysInvestmentSnapshots(
  supabase: SupabaseClient,
  userId: string,
  inputs: InvestmentSnapshotInput[],
  source: SnapshotSource = 'manual_refresh'
): Promise<{ upserted: number; error: string | null }> {
  if (inputs.length === 0) return { upserted: 0, error: null }

  const date = todayLocalIso()
  const updatedAt = new Date().toISOString()

  const rows = inputs.map((input) => ({
    user_id: userId,
    investment_id: input.investmentId,
    date,
    value_eur: input.metrics.currentValue,
    remaining_cost_basis_eur: input.metrics.remainingCostBasis,
    realized_profit_eur: input.metrics.realizedProfit,
    unrealized_profit_eur: input.metrics.unrealizedProfit,
    quantity: input.metrics.quantity,
    current_price_native: input.currentPriceNative,
    currency: input.currency,
    snapshot_source: source,
    updated_at: updatedAt,
  }))

  const { error } = await supabase
    .from('investment_snapshots')
    .upsert(rows, { onConflict: 'user_id,investment_id,date' })

  if (error) return { upserted: 0, error: error.message }
  return { upserted: rows.length, error: null }
}