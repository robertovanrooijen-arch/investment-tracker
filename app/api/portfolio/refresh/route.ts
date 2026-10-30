import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { createAdminClient } from '@/lib/supabase/admin'
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

  // Refresh FX once for this run, then this user's portfolio. fx_rates is
  // global data: it is written only by trusted server code (service role),
  // never with the signed-in user's session — so the pending migration can
  // revoke user write access without breaking this route.
  const fxResult = await refreshFxRatesGlobal(createAdminClient())

  let result
  try {
    result = await refreshPortfolioForUser(supabase, user.id, 'manual_refresh')
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'Refresh failed.' },
      { status: 500 }
    )
  }

  // ok:false (with quality + snapshot_error) when the snapshot was refused
  // because of missing FX — the refresh button lists it as an issue.
  return NextResponse.json({
    ok: result.quality === 'complete',
    quality: result.quality,
    prices: result.prices,
    fx: fxResult,
    snapshot: result.snapshot,
    snapshot_error: result.snapshotError,
    investment_snapshots: result.investmentSnapshots,
    price_status: result.priceStatusCounts,
    skipped_incomplete_snapshots: result.skippedIncompleteSnapshots,
    fetched_at: result.fetchedAt,
  })
}