import type { SupabaseClient } from '@supabase/supabase-js'
import type { PortfolioMetrics } from '@/lib/domain/calculations'

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

function todayLocalIso(): string {
  // Use local calendar date so the snapshot matches the user's day.
  const d = new Date()
  const yyyy = d.getFullYear()
  const mm = String(d.getMonth() + 1).padStart(2, '0')
  const dd = String(d.getDate()).padStart(2, '0')
  return `${yyyy}-${mm}-${dd}`
}

/**
 * Upsert today's portfolio snapshot for the given user.
 * Multiple calls on the same day overwrite the row, not duplicate it,
 * thanks to the (user_id, date) composite primary key.
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
