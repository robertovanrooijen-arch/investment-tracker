import { NextResponse } from 'next/server'
import type { SupabaseClient } from '@supabase/supabase-js'
import { createClient } from '@/lib/supabase/server'
import { createAdminClient } from '@/lib/supabase/admin'
import { loadFxRates } from '@/lib/domain/fx'
import { hasUnits } from '@/lib/domain/constants'
import { buildGeneratedTransaction } from '@/lib/domain/recurring'
import type { RecurringTransaction, Investment } from '@/types/database'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

type RuleResult = {
  rule_id: string
  investment_id: string
  investment_name: string
  status: 'generated' | 'skipped' | 'failed'
  due_date?: string
  reason?: string
  error?: string
}

// ---------------------------------------------------------------------------
// Core processing — called by both GET (cron) and POST (manual)
// ---------------------------------------------------------------------------

async function processRules(
  supabase: SupabaseClient,
  rules: RecurringTransaction[],
  fxRates: Record<string, number>,
  todayUTC: Date,
): Promise<{ results: RuleResult[]; generated: number; skipped: number; failed: number }> {
  const results: RuleResult[] = []
  let generated = 0
  let skipped = 0
  let failed = 0

  if (rules.length === 0) return { results, generated, skipped, failed }

  const investmentIds = [...new Set(rules.map((r) => r.investment_id))]

  const { data: investmentsData, error: invError } = await supabase
    .from('investments')
    .select('*')
    .in('id', investmentIds)
    .returns<Investment[]>()

  if (invError) {
    return {
      results: rules.map((r) => ({
        rule_id: r.id,
        investment_id: r.investment_id,
        investment_name: '(unknown)',
        status: 'failed' as const,
        error: `Failed to load investments: ${invError.message}`,
      })),
      generated: 0,
      skipped: 0,
      failed: rules.length,
    }
  }

  const investmentMap = new Map<string, Investment>(
    (investmentsData ?? []).map((inv) => [inv.id, inv]),
  )

  for (const rule of rules) {
    const investment = investmentMap.get(rule.investment_id)

    if (!investment) {
      results.push({
        rule_id: rule.id,
        investment_id: rule.investment_id,
        investment_name: '(not found)',
        status: 'failed',
        error: 'Investment row not found',
      })
      failed++
      continue
    }

    try {
      const result = buildGeneratedTransaction(rule, investment, fxRates, todayUTC)

      if (!result.ok) {
        results.push({
          rule_id: rule.id,
          investment_id: rule.investment_id,
          investment_name: investment.name,
          status: 'skipped',
          reason: result.reason,
        })
        skipped++
        continue
      }

      const { error: insertError } = await supabase
        .from('transactions')
        .insert(result.payload)

      if (insertError) {
        results.push({
          rule_id: rule.id,
          investment_id: rule.investment_id,
          investment_name: investment.name,
          status: 'failed',
          due_date: result.dueDate,
          error: `Insert failed: ${insertError.message}`,
        })
        failed++
        continue
      }

      const { error: ruleUpdateError } = await supabase
        .from('recurring_transactions')
        .update({
          last_generated_date: result.dueDate,
          updated_at: new Date().toISOString(),
        })
        .eq('id', rule.id)

      if (ruleUpdateError) {
        results.push({
          rule_id: rule.id,
          investment_id: rule.investment_id,
          investment_name: investment.name,
          status: 'failed',
          due_date: result.dueDate,
          error: `Transaction inserted but last_generated_date update failed: ${ruleUpdateError.message}`,
        })
        failed++
        continue
      }

      // Cash-flow side-effect: non-unit fee reduces current_value
      if (result.payload.type === 'fee' && !hasUnits(investment.type)) {
        const delta = -(result.payload.amount ?? 0)
        if (delta !== 0) {
          const { data: invRow } = await supabase
            .from('investments')
            .select('current_value')
            .eq('id', investment.id)
            .single()

          if (invRow) {
            await supabase
              .from('investments')
              .update({ current_value: (invRow.current_value ?? 0) + delta })
              .eq('id', investment.id)
          }
        }
      }

      results.push({
        rule_id: rule.id,
        investment_id: rule.investment_id,
        investment_name: investment.name,
        status: 'generated',
        due_date: result.dueDate,
      })
      generated++
    } catch (err) {
      results.push({
        rule_id: rule.id,
        investment_id: rule.investment_id,
        investment_name: investment.name,
        status: 'failed',
        error: err instanceof Error ? err.message : 'Unknown error',
      })
      failed++
    }
  }

  return { results, generated, skipped, failed }
}

// ---------------------------------------------------------------------------
// GET — Vercel cron trigger, runs for ALL users
// Vercel sends: GET /api/cron/generate-recurring
//               Authorization: Bearer <CRON_SECRET>
// ---------------------------------------------------------------------------

export async function GET(req: Request) {
  const expected = process.env.CRON_SECRET
  if (!expected) {
    return NextResponse.json(
      { error: 'CRON_SECRET is not configured on the server.' },
      { status: 500 },
    )
  }
  if (req.headers.get('authorization') !== `Bearer ${expected}`) {
    return NextResponse.json({ error: 'Unauthorized.' }, { status: 401 })
  }

  const startedAt = new Date().toISOString()
  const supabase = createAdminClient()

  const now = new Date()
  const todayUTC = new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()),
  )

  const { rates: fxRates } = await loadFxRates(supabase)

  const { data: rulesData, error: rulesError } = await supabase
    .from('recurring_transactions')
    .select('*')
    .eq('active', true)
    .returns<RecurringTransaction[]>()

  if (rulesError) {
    return NextResponse.json({ error: rulesError.message }, { status: 500 })
  }

  const { results, generated, skipped, failed } = await processRules(
    supabase,
    rulesData ?? [],
    fxRates,
    todayUTC,
  )

  return NextResponse.json({
    ok: true,
    started_at: startedAt,
    finished_at: new Date().toISOString(),
    generated,
    skipped,
    failed,
    results,
  })
}

// ---------------------------------------------------------------------------
// POST — manual trigger for the currently logged-in user only
// ---------------------------------------------------------------------------

export async function POST() {
  const supabase = await createClient()

  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) {
    return NextResponse.json({ error: 'Not authenticated.' }, { status: 401 })
  }

  const now = new Date()
  const todayUTC = new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()),
  )

  const { rates: fxRates } = await loadFxRates(supabase)

  const { data: rulesData, error: rulesError } = await supabase
    .from('recurring_transactions')
    .select('*')
    .eq('user_id', user.id)
    .eq('active', true)
    .returns<RecurringTransaction[]>()

  if (rulesError) {
    return NextResponse.json({ error: rulesError.message }, { status: 500 })
  }

  const { results, generated, skipped, failed } = await processRules(
    supabase,
    rulesData ?? [],
    fxRates,
    todayUTC,
  )

  return NextResponse.json({ ok: true, generated, skipped, failed, results })
}
