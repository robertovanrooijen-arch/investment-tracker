import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
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

// POST is used so it cannot be triggered by a browser prefetch or link click.
// Later, when the Vercel cron fires this as a GET, we can add a GET handler
// guarded by CRON_SECRET.
export async function POST() {
  const supabase = await createClient()

  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) {
    return NextResponse.json({ error: 'Not authenticated.' }, { status: 401 })
  }

  // UTC midnight for today — consistent with the date arithmetic in recurring.ts.
  const now = new Date()
  const todayUTC = new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate())
  )

  // ── 1. Load active recurring rules ────────────────────────────────────────
  const { data: rulesData, error: rulesError } = await supabase
    .from('recurring_transactions')
    .select('*')
    .eq('user_id', user.id)
    .eq('active', true)
    .returns<RecurringTransaction[]>()

  if (rulesError) {
    return NextResponse.json({ error: rulesError.message }, { status: 500 })
  }

  const rules = rulesData ?? []

  if (rules.length === 0) {
    return NextResponse.json({ ok: true, generated: 0, skipped: 0, failed: 0, results: [] })
  }

  // ── 2. Load investments referenced by these rules ─────────────────────────
  const investmentIds = [...new Set(rules.map((r) => r.investment_id))]

  const { data: investmentsData, error: invError } = await supabase
    .from('investments')
    .select('*')
    .in('id', investmentIds)
    .returns<Investment[]>()

  if (invError) {
    return NextResponse.json({ error: invError.message }, { status: 500 })
  }

  const investmentMap = new Map<string, Investment>(
    (investmentsData ?? []).map((inv) => [inv.id, inv])
  )

  // ── 3. Load FX rates ──────────────────────────────────────────────────────
  const { rates: fxRates } = await loadFxRates(supabase)

  // ── 4. Process each rule — one failure must not abort the rest ────────────
  const results: RuleResult[] = []
  let generated = 0
  let skipped = 0
  let failed = 0

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

      // ── skip ───────────────────────────────────────────────────────────────
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

      // ── insert transaction ─────────────────────────────────────────────────
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

      // ── advance last_generated_date ────────────────────────────────────────
      // Must happen immediately after insert. If this fails, the next run will
      // attempt to insert the same period again (duplicate risk). Logged as
      // failed so the user can investigate.
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

      // ── cash-flow side-effect for non-unit fee transactions ────────────────
      // For cash / real estate / custom investments, a fee transaction reduces
      // current_value (mirrors the transaction form's auto-update behaviour).
      // Unit assets (stock/ETF/crypto/commodity) derive value from
      // quantity × current_price, so current_value is not touched there.
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

  return NextResponse.json({
    ok: true,
    generated,
    skipped,
    failed,
    results,
  })
}
