// DEGIRO capital_flow_entries correction — approved plan, applied 2026-07-26.
// Usage: node --import ./alias-loader.mjs scripts/degiro-cashflow-correction.mjs --user-id=<uuid> [--apply --confirm]
// Replaces the 10 bulk-estimated DEGIRO 2026 capital_flow_entries rows with
// real dated rows from the DEGIRO Account.csv export. Touches ONLY
// capital_flow_entries — no transactions, snapshots, prices, or calculations.

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
  console.error('Usage: node --import ./alias-loader.mjs scripts/degiro-cashflow-correction.mjs --user-id=<uuid> [--apply --confirm]')
  process.exit(1)
}

const env = Object.fromEntries(
  readFileSync('.env.local', 'utf8')
    .split('\n')
    .filter((l) => l.includes('='))
    .map((l) => {
      const i = l.indexOf('=')
      return [l.slice(0, i).trim(), l.slice(i + 1).trim()]
    })
)
const supabase = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY)

const DELETE_TARGETS = [
  { flow_date: '2026-01-01', direction: 'to_portfolio', amount_eur: 769.00 },
  { flow_date: '2026-01-01', direction: 'from_portfolio', amount_eur: 234.63 },
  { flow_date: '2026-02-01', direction: 'to_portfolio', amount_eur: 769.00 },
  { flow_date: '2026-02-01', direction: 'from_portfolio', amount_eur: 234.63 },
  { flow_date: '2026-03-01', direction: 'to_portfolio', amount_eur: 769.00 },
  { flow_date: '2026-03-01', direction: 'from_portfolio', amount_eur: 234.63 },
  { flow_date: '2026-04-01', direction: 'to_portfolio', amount_eur: 769.00 },
  { flow_date: '2026-04-01', direction: 'from_portfolio', amount_eur: 234.63 },
  { flow_date: '2026-05-01', direction: 'to_portfolio', amount_eur: 769.00 },
  { flow_date: '2026-05-01', direction: 'from_portfolio', amount_eur: 234.61 },
]

const NEW_ROWS = [
  { flow_date: '2026-01-07', year: 2026, platform: 'DEGIRO', direction: 'to_portfolio', amount_eur: 1055.00, source: 'degiro_account_export_2026', notes: 'iDEAL Deposit, Account.csv' },
  { flow_date: '2026-01-20', year: 2026, platform: 'DEGIRO', direction: 'to_portfolio', amount_eur: 750.00, source: 'degiro_account_export_2026', notes: 'iDEAL Deposit, Account.csv' },
  { flow_date: '2026-02-03', year: 2026, platform: 'DEGIRO', direction: 'to_portfolio', amount_eur: 870.00, source: 'degiro_account_export_2026', notes: 'iDEAL Deposit, Account.csv' },
  { flow_date: '2026-02-05', year: 2026, platform: 'DEGIRO', direction: 'to_portfolio', amount_eur: 300.00, source: 'degiro_account_export_2026', notes: 'iDEAL Deposit, Account.csv' },
  { flow_date: '2026-02-05', year: 2026, platform: 'DEGIRO', direction: 'from_portfolio', amount_eur: 218.67, source: 'degiro_account_export_2026', notes: 'SEPA Instant Terugstorting, Account.csv' },
  { flow_date: '2026-02-12', year: 2026, platform: 'DEGIRO', direction: 'to_portfolio', amount_eur: 120.00, source: 'degiro_account_export_2026', notes: 'iDEAL Deposit, Account.csv' },
  { flow_date: '2026-03-20', year: 2026, platform: 'DEGIRO', direction: 'to_portfolio', amount_eur: 750.00, source: 'degiro_account_export_2026', notes: 'iDEAL Deposit, Account.csv' },
  { flow_date: '2026-05-26', year: 2026, platform: 'DEGIRO', direction: 'from_portfolio', amount_eur: 954.46, source: 'degiro_account_export_2026', notes: 'SEPA Instant Terugstorting, Account.csv' },
  { flow_date: '2026-06-26', year: 2026, platform: 'DEGIRO', direction: 'from_portfolio', amount_eur: 490.00, source: 'degiro_account_export_2026', notes: 'SEPA Instant Terugstorting, Account.csv' },
  { flow_date: '2026-07-07', year: 2026, platform: 'DEGIRO', direction: 'from_portfolio', amount_eur: 828.54, source: 'degiro_account_export_2026', notes: 'SEPA Instant Terugstorting, Account.csv' },
]

async function loadFxRates() {
  const { data } = await supabase.from('fx_rates').select('currency, eur_per_unit')
  const rates = { EUR: 1 }
  for (const row of data ?? []) rates[row.currency] = Number(row.eur_per_unit)
  return rates
}

async function loadAll() {
  const [{ data: investments }, { data: transactions }, { data: capitalFlows }, { data: snapshots }] = await Promise.all([
    supabase.from('investments').select('*').eq('user_id', USER_ID),
    supabase.from('transactions').select('*').in('investment_id', (await supabase.from('investments').select('id').eq('user_id', USER_ID)).data.map((i) => i.id)),
    supabase.from('capital_flow_entries').select('*').eq('user_id', USER_ID),
    supabase.from('portfolio_snapshots').select('date, total_value_eur').eq('user_id', USER_ID),
  ])
  return { investments, transactions, capitalFlows, snapshots }
}

async function runYearAnalysis(year) {
  const { investments, transactions, capitalFlows, snapshots } = await loadAll()
  const fxRates = await loadFxRates()
  const liveTotalValueEur = computePortfolioMetrics(investments, transactions, fxRates).totalValue
  const assetRows = computeAssetYearRows(investments, transactions, year, fxRates)
  const cfeForYear = capitalFlows.map((f) => ({ year: f.year, flow_date: f.flow_date, direction: f.direction, amount_eur: Number(f.amount_eur) }))
  const summary = computeYearPortfolioSummary(year, assetRows, snapshots, cfeForYear, transactions, liveTotalValueEur)
  return summary
}

console.log(APPLY ? 'MODE: APPLY' : 'MODE: DRY-RUN (pass --apply --confirm to write)')

console.log('\n=== BEFORE: current DEGIRO 2026 capital_flow_entries ===')
const { data: currentDegiro2026 } = await supabase
  .from('capital_flow_entries')
  .select('*')
  .eq('user_id', USER_ID)
  .ilike('platform', '%degiro%')
  .eq('year', 2026)
  .order('flow_date')
for (const r of currentDegiro2026) console.log(JSON.stringify(r))

console.log(`\nFound ${currentDegiro2026.length} rows, expected 10.`)
const matched = DELETE_TARGETS.every((t) =>
  currentDegiro2026.some((r) => r.flow_date === t.flow_date && r.direction === t.direction && Math.abs(Number(r.amount_eur) - t.amount_eur) < 0.005)
)
console.log('All 10 delete targets uniquely matched:', matched)
if (currentDegiro2026.length !== 10 || !matched) {
  console.error('ABORT: row set does not match expected plan exactly.')
  process.exit(1)
}

console.log('\n=== BEFORE: Year Analysis 2026 summary (real domain code) ===')
const before2026 = await runYearAnalysis(2026)
console.log(JSON.stringify(before2026, null, 2))

if (APPLY) {
  console.log('\n=== APPLYING ===')
  const idsToDelete = currentDegiro2026.map((r) => r.id)
  const { error: delErr } = await supabase.from('capital_flow_entries').delete().in('id', idsToDelete)
  if (delErr) throw new Error(`delete: ${delErr.message}`)
  console.log(`deleted ${idsToDelete.length} rows`)

  for (const row of NEW_ROWS) {
    const { error } = await supabase.from('capital_flow_entries').insert({ user_id: USER_ID, ...row })
    if (error) throw new Error(`insert ${row.flow_date} ${row.direction}: ${error.message}`)
  }
  console.log(`inserted ${NEW_ROWS.length} rows`)

  console.log('\n=== AFTER: DEGIRO 2026 capital_flow_entries ===')
  const { data: afterDegiro2026 } = await supabase
    .from('capital_flow_entries')
    .select('*')
    .eq('user_id', USER_ID)
    .ilike('platform', '%degiro%')
    .eq('year', 2026)
    .order('flow_date')
  for (const r of afterDegiro2026) console.log(JSON.stringify(r))

  const deposits = afterDegiro2026.filter((r) => r.direction === 'to_portfolio').reduce((s, r) => s + Number(r.amount_eur), 0)
  const withdrawals = afterDegiro2026.filter((r) => r.direction === 'from_portfolio').reduce((s, r) => s + Number(r.amount_eur), 0)
  console.log('\nDEGIRO 2026 deposits:', deposits.toFixed(2), '(expect 3845.00)')
  console.log('DEGIRO 2026 withdrawals:', withdrawals.toFixed(2), '(expect 2491.67)')
  console.log('DEGIRO 2026 net:', (deposits - withdrawals).toFixed(2), '(expect 1353.33)')

  console.log('\n=== AFTER: Year Analysis 2026 summary (real domain code) ===')
  const after2026 = await runYearAnalysis(2026)
  console.log(JSON.stringify(after2026, null, 2))

  console.log('\n=== Comparison ===')
  console.log('netContributionsEur          before:', before2026.netContributionsEur, ' after:', after2026.netContributionsEur, ' delta:', (after2026.netContributionsEur - before2026.netContributionsEur).toFixed(2))
  console.log('growthExcludingContributionsEur before:', before2026.growthExcludingContributionsEur, ' after:', after2026.growthExcludingContributionsEur)
  console.log('modifiedDietzReturnPercent    before:', before2026.modifiedDietzReturnPercent, ' after:', after2026.modifiedDietzReturnPercent)
  console.log('endValueEur                   before:', before2026.endValueEur, ' after:', after2026.endValueEur, ' (should be identical)')
  console.log('currentUnrealizedPLEur        before:', before2026.currentUnrealizedPLEur, ' after:', after2026.currentUnrealizedPLEur, ' (should be identical)')
  console.log('realizedPLInYearEur           before:', before2026.realizedPLInYearEur, ' after:', after2026.realizedPLInYearEur, ' (should be identical)')

  console.log('\n=== Confirm cash/free-space transactions untouched (spot check count) ===')
  const { data: cashTxs } = await supabase.from('transactions').select('id').eq('user_id', USER_ID).in('investment_id', (await supabase.from('investments').select('id').eq('user_id', USER_ID).ilike('name', '%vrij ruimte%')).data.map((i) => i.id))
  console.log('Vrij ruimte DEGIRO transaction count:', cashTxs.length, '(expect unchanged from before this script ran)')
} else {
  console.log('\n(dry-run only, no writes performed)')
}
