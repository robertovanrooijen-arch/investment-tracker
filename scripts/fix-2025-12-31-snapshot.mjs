// 2025-12-31 frozen snapshot correction — approved plan, applied 2026-07-27.
// Removes €753.46 of Gold Republic cash that had already been withdrawn to
// the bank before 2025-12-31, but was double-counted in total_value_eur.
// Touches ONLY portfolio_snapshots, date=2025-12-31. Does NOT touch
// total_invested_eur or total_unrealized_eur — see conversation for why.
// Usage: node --import ./alias-loader.mjs scripts/fix-2025-12-31-snapshot.mjs --user-id=<uuid> [--apply --confirm]

import { createClient } from '@supabase/supabase-js'
import { readFileSync } from 'node:fs'
import { computeAssetYearRows, computeYearPortfolioSummary } from '@/lib/domain/year-analysis.ts'
import { computePortfolioMetrics } from '@/lib/domain/calculations.ts'

const args = Object.fromEntries(
  process.argv.slice(2).map((a) => {
    const [k, v] = a.replace(/^--/, '').split('=')
    return [k, v ?? true]
  })
)
const USER_ID = args['user-id']
const APPLY = args.apply === true && args.confirm === true
if (!USER_ID) {
  console.error('Usage: node --import ./alias-loader.mjs scripts/fix-2025-12-31-snapshot.mjs --user-id=<uuid> [--apply --confirm]')
  process.exit(1)
}

const env = Object.fromEntries(
  readFileSync('.env.local', 'utf8').split('\n').filter((l) => l.includes('=')).map((l) => {
    const i = l.indexOf('=')
    return [l.slice(0, i).trim(), l.slice(i + 1).trim()]
  })
)
const supabase = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY)

const NEW_VALUE = 7263.20
const NEW_SOURCE_SUFFIX = '+corrected_removed_gold_republic_withdrawn_cash_753_46'

console.log(APPLY ? 'MODE: APPLY' : 'MODE: DRY-RUN (pass --apply --confirm to write)')

console.log('\n=== BEFORE: current row ===')
const { data: before, error: beforeErr } = await supabase
  .from('portfolio_snapshots')
  .select('*')
  .eq('user_id', USER_ID)
  .eq('date', '2025-12-31')
  .single()
if (beforeErr) throw new Error(beforeErr.message)
console.log(JSON.stringify(before, null, 2))

if (Math.abs(Number(before.total_value_eur) - 8016.66) > 0.005) {
  console.error('ABORT: total_value_eur is not 8016.66 as expected — stopping.')
  process.exit(1)
}

const newSource = before.snapshot_source + NEW_SOURCE_SUFFIX
console.log('\n=== Planned update ===')
console.log('total_value_eur:', before.total_value_eur, '->', NEW_VALUE)
console.log('total_invested_eur: unchanged (', before.total_invested_eur, ')')
console.log('total_unrealized_eur: unchanged (', before.total_unrealized_eur, ') — NOT updated, see report')
console.log('snapshot_source:', before.snapshot_source, '->', newSource)

console.log('\n=== Confirm no other snapshot rows touched ===')
const { data: allSnaps } = await supabase.from('portfolio_snapshots').select('date').eq('user_id', USER_ID)
console.log('Total portfolio_snapshots rows for this user:', allSnaps.length, '(only 2025-12-31 will be updated)')

console.log('\n=== Confirm no investment_snapshots exist for this date ===')
const { data: invSnaps, error: invSnapsErr } = await supabase.from('investment_snapshots').select('investment_id').eq('user_id', USER_ID).eq('date', '2025-12-31')
if (invSnapsErr) throw new Error(invSnapsErr.message)
console.log('investment_snapshots for 2025-12-31:', invSnaps.length, '(expect 0; none will be created)')

async function loadFxRates() {
  const { data } = await supabase.from('fx_rates').select('currency, eur_per_unit')
  const rates = { EUR: 1 }
  for (const r of data ?? []) rates[r.currency] = Number(r.eur_per_unit)
  return rates
}

async function runYearAnalysis() {
  const { data: investments } = await supabase.from('investments').select('*').eq('user_id', USER_ID)
  const { data: transactions } = await supabase.from('transactions').select('*').in('investment_id', investments.map((i) => i.id))
  const { data: capitalFlows } = await supabase.from('capital_flow_entries').select('*').eq('user_id', USER_ID)
  const { data: snapshots } = await supabase.from('portfolio_snapshots').select('date, total_value_eur').eq('user_id', USER_ID)
  const fxRates = await loadFxRates()
  const liveTotalValueEur = computePortfolioMetrics(investments, transactions, fxRates).totalValue
  const assetRows2026 = computeAssetYearRows(investments, transactions, 2026, fxRates)
  const cfeForYear = capitalFlows.map((f) => ({ year: f.year, flow_date: f.flow_date, direction: f.direction, amount_eur: Number(f.amount_eur) }))
  const snapList = snapshots.map((s) => ({ date: s.date, total_value_eur: Number(s.total_value_eur) }))
  const summary = computeYearPortfolioSummary(2026, assetRows2026, snapList, cfeForYear, transactions, liveTotalValueEur)
  const wpm = computePortfolioMetrics(investments, transactions, fxRates)
  return { summary, wpm }
}

console.log('\n=== BEFORE: Year Analysis 2026 (real domain code) ===')
const beforeRun = await runYearAnalysis()
console.log('startValueEur:', beforeRun.summary.startValueEur)
console.log('growthExcludingContributionsEur:', beforeRun.summary.growthExcludingContributionsEur)
console.log('modifiedDietzReturnPercent:', beforeRun.summary.modifiedDietzReturnPercent)
console.log('Dashboard all-time P/L:', beforeRun.wpm.totalProfit)
console.log('all-time realized:', beforeRun.wpm.totalRealized)
console.log('all-time unrealized:', beforeRun.wpm.totalUnrealized)

if (APPLY) {
  console.log('\n=== APPLYING ===')
  const { error: updErr } = await supabase
    .from('portfolio_snapshots')
    .update({ total_value_eur: NEW_VALUE, snapshot_source: newSource, updated_at: new Date().toISOString() })
    .eq('user_id', USER_ID)
    .eq('date', '2025-12-31')
  if (updErr) throw new Error(updErr.message)
  console.log('updated total_value_eur and snapshot_source')

  const { data: after } = await supabase.from('portfolio_snapshots').select('*').eq('user_id', USER_ID).eq('date', '2025-12-31').single()
  console.log('\n=== AFTER: row ===')
  console.log(JSON.stringify(after, null, 2))

  console.log('\n=== AFTER: Year Analysis 2026 (real domain code) ===')
  const afterRun = await runYearAnalysis()
  console.log('startValueEur:', afterRun.summary.startValueEur, '(expect 7263.20)')
  console.log('growthExcludingContributionsEur:', afterRun.summary.growthExcludingContributionsEur)
  console.log('modifiedDietzReturnPercent:', afterRun.summary.modifiedDietzReturnPercent)
  console.log('Dashboard all-time P/L:', afterRun.wpm.totalProfit)
  console.log('all-time realized:', afterRun.wpm.totalRealized)
  console.log('all-time unrealized:', afterRun.wpm.totalUnrealized)

  console.log('\n=== Comparison ===')
  console.log('growth delta:', (afterRun.summary.growthExcludingContributionsEur - beforeRun.summary.growthExcludingContributionsEur).toFixed(2), '(expect +753.46)')
  console.log('Dashboard P/L delta (expect 0):', (afterRun.wpm.totalProfit - beforeRun.wpm.totalProfit).toFixed(6))
  console.log('realized delta (expect 0):', (afterRun.wpm.totalRealized - beforeRun.wpm.totalRealized).toFixed(6))
  console.log('unrealized delta (expect 0):', (afterRun.wpm.totalUnrealized - beforeRun.wpm.totalUnrealized).toFixed(6))
} else {
  console.log('\n(dry-run only, no writes performed)')
}
