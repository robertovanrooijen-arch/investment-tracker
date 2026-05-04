import { NextResponse } from 'next/server'
import { createAdminClient } from '@/lib/supabase/admin'
import {
  refreshFxRatesGlobal,
  refreshPortfolioForUser,
} from '@/lib/domain/refresh'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

type UserSummary = {
  user_id: string
  ok: boolean
  error?: string
  prices?: {
    total: number
    successful: number
    skipped: number
    failed: number
  }
  snapshot_written?: boolean
  investment_snapshots_upserted?: number
}

// Vercel Cron sends GET. POST is allowed too so you can curl it manually.
export async function GET(req: Request) {
  return handle(req)
}
export async function POST(req: Request) {
  return handle(req)
}

async function handle(req: Request) {
  // 1. Verify CRON_SECRET.
  const expected = process.env.CRON_SECRET
  if (!expected) {
    return NextResponse.json(
      { error: 'CRON_SECRET is not configured on the server.' },
      { status: 500 }
    )
  }
  const auth = req.headers.get('authorization')
  if (auth !== `Bearer ${expected}`) {
    return NextResponse.json({ error: 'Unauthorized.' }, { status: 401 })
  }

  const startedAt = new Date().toISOString()
  const supabase = createAdminClient()

  // 2. Refresh FX once for the whole run.
  const fxResult = await refreshFxRatesGlobal(supabase)

  // 3. List distinct user IDs that have at least one investment (option B).
  const { data: invRows, error: listError } = await supabase
    .from('investments')
    .select('user_id')

  if (listError) {
    return NextResponse.json(
      { error: `Failed to list users: ${listError.message}` },
      { status: 500 }
    )
  }

  const userIds = Array.from(
    new Set(
      (invRows ?? [])
        .map((r) => r.user_id)
        .filter((id): id is string => typeof id === 'string' && id.length > 0)
    )
  )

  // 4. Process each user sequentially; continue on failure.
  const summaries: UserSummary[] = []
  for (const userId of userIds) {
    try {
      const result = await refreshPortfolioForUser(supabase, userId, 'cron')
      summaries.push({
        user_id: userId,
        ok: true,
        prices: {
          total: result.prices.total,
          successful: result.prices.successful,
          skipped: result.prices.skipped,
          failed: result.prices.failed,
        },
        snapshot_written: !!result.snapshot,
        investment_snapshots_upserted: result.investmentSnapshots.upserted,
      })
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Unknown error'
      console.error(`[cron] user ${userId} failed: ${msg}`)
      summaries.push({ user_id: userId, ok: false, error: msg })
    }
  }

  return NextResponse.json({
    ok: true,
    started_at: startedAt,
    finished_at: new Date().toISOString(),
    fx: fxResult,
    users_processed: summaries.length,
    users_succeeded: summaries.filter((s) => s.ok).length,
    users_failed: summaries.filter((s) => !s.ok).length,
    summaries,
  })
}