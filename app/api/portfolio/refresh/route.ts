import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import {
  refreshFxRatesGlobal,
  refreshPortfolioForUser,
} from '@/lib/domain/refresh'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function POST() {
  const supabase = await createClient()

  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) {
    return NextResponse.json({ error: 'Not authenticated.' }, { status: 401 })
  }

  // Refresh FX once for this run, then this user's portfolio.
  const fxResult = await refreshFxRatesGlobal(supabase)

  let result
  try {
    result = await refreshPortfolioForUser(supabase, user.id, 'manual_refresh')
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'Refresh failed.' },
      { status: 500 }
    )
  }

  return NextResponse.json({
    ok: true,
    prices: result.prices,
    fx: fxResult,
    snapshot: result.snapshot,
    snapshot_error: result.snapshotError,
    investment_snapshots: result.investmentSnapshots,
    fetched_at: result.fetchedAt,
  })
}