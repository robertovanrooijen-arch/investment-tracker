// Bitvavo transaction + cashflow correction — approved plan, applied 2026-07-27.
// Usage: node --import ./alias-loader.mjs scripts/bitvavo-correction.mjs --user-id=<uuid> [--apply --confirm]
// Touches ONLY Bitvavo: the "Bitcoin" investment's transactions and Bitvavo
// capital_flow_entries. Does not touch DEGIRO, Trade Republic, Gold Republic,
// snapshots, prices, or any calculation logic.

import { createClient } from '@supabase/supabase-js'
import { readFileSync } from 'node:fs'
import { computeAssetYearRows, computeYearPortfolioSummary } from '@/lib/domain/year-analysis.ts'
import { computePortfolioMetrics, computeInvestmentMetrics } from '@/lib/domain/calculations.ts'

const args = Object.fromEntries(
  process.argv.slice(2).map((a) => {
    const [k, v] = a.replace(/^--/, '').split('=')
    return [k, v ?? true]
  })
)
const USER_ID = args['user-id']
const APPLY = args.apply === true && args.confirm === true
if (!USER_ID) {
  console.error('Usage: node --import ./alias-loader.mjs scripts/bitvavo-correction.mjs --user-id=<uuid> [--apply --confirm]')
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

const BITCOIN_INV_ID = 'e70c5260-bef3-4fe7-9737-202860c2218b'
const BULK_BUY_ID = 'd7b815e6-7c3b-46e2-9937-30c7c126aa87'

// The 41 real buys covering 2025-05-29 -> 2026-05-05 (replaces the bulk row).
const REAL_ONBOARDING_BUYS = [
  { date: '2025-05-30', quantity: 0.00021306, price_per_unit: 93635, fee: 0.0501269 },
  { date: '2025-06-13', quantity: 0.00021833, price_per_unit: 91373, fee: 0.05053291 },
  { date: '2025-06-27', quantity: 0.00021858, price_per_unit: 91267, fee: 0.05085914 },
  { date: '2025-07-11', quantity: 0.0001985, price_per_unit: 100500, fee: 0.05075 },
  { date: '2025-07-25', quantity: 0.00020146, price_per_unit: 99025, fee: 0.0504235 },
  { date: '2025-08-08', quantity: 0.00029842, price_per_unit: 100260, fee: 0.0804108 },
  { date: '2025-08-22', quantity: 0.00030902, price_per_unit: 96822, fee: 0.08006556 },
  { date: '2025-09-05', quantity: 0.00031508, price_per_unit: 94958, fee: 0.08063336 },
  { date: '2025-09-19', quantity: 0.00030127, price_per_unit: 99312, fee: 0.08027376 },
  { date: '2025-09-26', quantity: 0.00073609, price_per_unit: 93550, fee: 0.1787805 },
  { date: '2025-09-26', quantity: 0.0021427, price_per_unit: 93550, fee: 0.500415 },
  { date: '2025-10-03', quantity: 0.00029182, price_per_unit: 102526, fee: 0.08086268 },
  { date: '2025-10-17', quantity: 0.0002, price_per_unit: 90660, fee: 0.048 },
  { date: '2025-10-17', quantity: 0.00012992, price_per_unit: 90669, fee: 0.03028352 },
  { date: '2025-10-31', quantity: 0.00048004, price_per_unit: 93491, fee: 0.12058036 },
  { date: '2025-11-14', quantity: 0.00053742, price_per_unit: 83510, fee: 0.1200558 },
  { date: '2025-11-25', quantity: 0.00145607, price_per_unit: 75415, fee: 0.28048095 },
  { date: '2025-11-28', quantity: 0.0005719, price_per_unit: 78474, fee: 0.1207194 },
  { date: '2025-12-12', quantity: 0.00056897, price_per_unit: 78879, fee: 0.12021537 },
  { date: '2025-12-26', quantity: 0.00059423, price_per_unit: 75526, fee: 0.12018502 },
  { date: '2026-01-09', quantity: 0.00057452, price_per_unit: 78117, fee: 0.12022116 },
  { date: '2026-01-23', quantity: 0.00058936, price_per_unit: 76150, fee: 0.120236 },
  { date: '2026-02-03', quantity: 0.0006754, price_per_unit: 66449, fee: 0.1203454 },
  { date: '2026-02-06', quantity: 0.00081797, price_per_unit: 54867, fee: 0.12044001 },
  { date: '2026-02-08', quantity: 0.00165893, price_per_unit: 60129, fee: 0.25019803 },
  { date: '2026-02-10', quantity: 0.0007749, price_per_unit: 57917, fee: 0.1201167 },
  { date: '2026-02-17', quantity: 0.00078495, price_per_unit: 57175, fee: 0.12048375 },
  { date: '2026-02-20', quantity: 0.00078156, price_per_unit: 57423, fee: 0.12048012 },
  { date: '2026-02-24', quantity: 0.00083075, price_per_unit: 54023, fee: 0.12039275 },
  { date: '2026-03-06', quantity: 0.00073616, price_per_unit: 60965, fee: 0.1200056 },
  { date: '2026-03-10', quantity: 0.00074836, price_per_unit: 59971, fee: 0.12010244 },
  { date: '2026-03-17', quantity: 0.00069228, price_per_unit: 64829, fee: 0.12017988 },
  { date: '2026-03-20', quantity: 0.0007349, price_per_unit: 61069, fee: 0.1203919 },
  { date: '2026-03-24', quantity: 0.00073973, price_per_unit: 60670, fee: 0.1205809 },
  { date: '2026-03-31', quantity: 0.00076412, price_per_unit: 58734, fee: 0.12017592 },
  { date: '2026-04-03', quantity: 0.00077356, price_per_unit: 58017, fee: 0.12036948 },
  { date: '2026-04-14', quantity: 0.00071101, price_per_unit: 63121, fee: 0.12033779 },
  { date: '2026-04-28', quantity: 0.00068261, price_per_unit: 65747, fee: 0.12044033 },
  { date: '2026-05-01', quantity: 0.00000033, price_per_unit: 66817, fee: 0.00795039 },
  { date: '2026-05-01', quantity: 0.00067119, price_per_unit: 66821, fee: 0.11041301 },
  { date: '2026-05-05', quantity: 0.00065188, price_per_unit: 68846, fee: 0.12066952 },
].map((t) => ({
  investment_id: BITCOIN_INV_ID,
  type: 'buy',
  date: t.date,
  quantity: t.quantity,
  price_per_unit: t.price_per_unit,
  amount: Math.round(t.quantity * t.price_per_unit * 1e8) / 1e8,
  fee: t.fee,
  price_currency: 'EUR',
  fee_currency: 'EUR',
  fx_rate_to_eur: 1,
  is_contribution: false,
  notes: 'Restored from Bitvavo full history export — replaces fake 2026-05-05 onboarding buy.',
}))

// The 12 existing granular rows: correct fee, fix one date, force is_contribution=false.
const GRANULAR_UPDATES = [
  { matchQty: 0.00064985, fee: 0.1200593 },
  { matchQty: 0.0006573, fee: 0.1202133 },
  { matchQty: 0.00067926, fee: 0.12061254 },
  { matchQty: 0.00067954, fee: 0.12046024 },
  { matchQty: 0.00075945, fee: 0.12030225 },
  { matchQty: 0.0008398, fee: 0.1202482 },
  { matchQty: 0.00081702, fee: 0.12027438 },
  { matchQty: 0.00086724, fee: 0.12033, dateFix: '2026-06-26' },
  { matchQty: 0.00086173, fee: 0.12023987 },
  { matchQty: 0.00080867, fee: 0.12043234 },
  { matchQty: 0.00081412, fee: 0.12000676 },
  { matchQty: 0.00078493, fee: 0.12005739 },
]

const DELETE_CFE_TARGETS = [
  ...['2025-01-01', '2025-02-01', '2025-03-01', '2025-04-01', '2025-05-01', '2025-06-01', '2025-07-01', '2025-08-01', '2025-09-01', '2025-10-01', '2025-11-01'].map((d) => ({ flow_date: d, amount_eur: 72.92 })),
  { flow_date: '2025-12-01', amount_eur: 72.89 },
  ...['2026-01-01', '2026-02-01', '2026-03-01', '2026-04-01', '2026-05-01'].map((d) => ({ flow_date: d, amount_eur: 227 })),
]

const REAL_DEPOSITS = [
  { date: '2025-05-29', amount: 0.01 },
  { date: '2025-05-29', amount: 50 },
  { date: '2025-07-10', amount: 40 },
  { date: '2025-08-01', amount: 90 },
  { date: '2025-09-16', amount: 90 },
  { date: '2025-09-25', amount: 270 },
  { date: '2025-10-27', amount: 100 },
  { date: '2025-11-24', amount: 100 },
  { date: '2025-11-25', amount: 45 },
  { date: '2025-12-11', amount: 45 },
  { date: '2025-12-24', amount: 45 },
  { date: '2026-01-06', amount: 45 },
  { date: '2026-01-20', amount: 45 },
  { date: '2026-02-02', amount: 300 },
  { date: '2026-02-20', amount: 25 },
  { date: '2026-02-23', amount: 45 },
  { date: '2026-03-03', amount: 90 },
  { date: '2026-03-10', amount: 150 },
  { date: '2026-03-26', amount: 100 },
  { date: '2026-04-13', amount: 20 },
  { date: '2026-04-21', amount: 100 },
  { date: '2026-05-02', amount: 35 },
  { date: '2026-05-11', amount: 45 },
  { date: '2026-05-14', amount: 45 },
  { date: '2026-05-19', amount: 45 },
  { date: '2026-05-25', amount: 45 },
  { date: '2026-06-02', amount: 45 },
  { date: '2026-06-06', amount: 45 },
  { date: '2026-06-09', amount: 45 },
  { date: '2026-06-24', amount: 90 },
  { date: '2026-07-04', amount: 90 },
  { date: '2026-07-20', amount: 45 },
].map((d) => ({
  year: Number(d.date.slice(0, 4)),
  platform: 'Bitvavo',
  direction: 'to_portfolio',
  amount_eur: d.amount,
  flow_date: d.date,
  source: 'bitvavo_full_history_export',
  notes: 'Real dated deposit, Full history (6).csv',
}))

const INCOME_ROWS = [
  { date: '2025-05-29', type: 'interest', amount: 10.0, notes: 'Bitvavo campaign_new_user_incentive — platform bonus, not a contribution.' },
  { date: '2025-05-30', type: 'interest', amount: 0.06, notes: 'Bitvavo rebate — platform income, not a contribution.' },
].map((r) => ({
  investment_id: BITCOIN_INV_ID,
  type: r.type,
  date: r.date,
  quantity: null,
  price_per_unit: null,
  amount: r.amount,
  fee: 0,
  price_currency: 'EUR',
  fee_currency: 'EUR',
  fx_rate_to_eur: 1,
  is_contribution: false,
  notes: r.notes,
}))

async function loadFxRates() {
  const { data } = await supabase.from('fx_rates').select('currency, eur_per_unit')
  const rates = { EUR: 1 }
  for (const row of data ?? []) rates[row.currency] = Number(row.eur_per_unit)
  return rates
}

async function loadAll() {
  const { data: invIds } = await supabase.from('investments').select('id').eq('user_id', USER_ID)
  const [{ data: investments }, { data: transactions }, { data: capitalFlows }, { data: snapshots }] = await Promise.all([
    supabase.from('investments').select('*').eq('user_id', USER_ID),
    supabase.from('transactions').select('*').in('investment_id', invIds.map((i) => i.id)),
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
  const btc = investments.find((i) => i.id === BITCOIN_INV_ID)
  const btcMetrics = computeInvestmentMetrics(btc, transactions, fxRates)
  const bitvavoFlows = capitalFlows.filter((f) => f.platform === 'Bitvavo')
  const bitvavoNet = bitvavoFlows.reduce((s, f) => s + (f.direction === 'to_portfolio' ? Number(f.amount_eur) : -Number(f.amount_eur)), 0)
  return { summary, btcMetrics, bitvavoNet, liveTotalValueEur }
}

console.log(APPLY ? 'MODE: APPLY' : 'MODE: DRY-RUN (pass --apply --confirm to write)')

console.log('\n=== BEFORE: bulk buy row ===')
const { data: bulkRow } = await supabase.from('transactions').select('*').eq('id', BULK_BUY_ID).single()
console.log(JSON.stringify(bulkRow))
if (!bulkRow || bulkRow.investment_id !== BITCOIN_INV_ID || Math.abs(bulkRow.quantity - 0.02537735) > 1e-8) {
  console.error('ABORT: bulk buy row does not match expected plan.')
  process.exit(1)
}

console.log('\n=== BEFORE: 12 granular rows (matched by quantity) ===')
const { data: granularCandidates } = await supabase.from('transactions').select('*').eq('investment_id', BITCOIN_INV_ID).eq('type', 'buy').neq('id', BULK_BUY_ID)
const granularMatched = []
for (const g of GRANULAR_UPDATES) {
  const matches = granularCandidates.filter((r) => Math.abs(r.quantity - g.matchQty) < 1e-8)
  if (matches.length !== 1) {
    console.error(`ABORT: quantity ${g.matchQty} matched ${matches.length} rows, expected exactly 1.`)
    process.exit(1)
  }
  console.log(JSON.stringify(matches[0]))
  granularMatched.push({ id: matches[0].id, before: matches[0], plan: g })
}
console.log(`All 12 granular rows uniquely matched by quantity.`)
if (granularCandidates.length !== 12) {
  console.error(`ABORT: expected exactly 12 non-bulk buy rows, found ${granularCandidates.length}.`)
  process.exit(1)
}

console.log('\n=== BEFORE: Bitvavo capital_flow_entries ===')
const { data: currentBitvavoFlows } = await supabase.from('capital_flow_entries').select('*').eq('user_id', USER_ID).eq('platform', 'Bitvavo').order('flow_date')
for (const r of currentBitvavoFlows) console.log(JSON.stringify(r))
console.log(`Found ${currentBitvavoFlows.length} rows, expected 17.`)
const flowsMatched = DELETE_CFE_TARGETS.every((t) =>
  currentBitvavoFlows.some((r) => r.flow_date === t.flow_date && Math.abs(Number(r.amount_eur) - t.amount_eur) < 0.005 && r.direction === 'to_portfolio')
)
console.log('All 17 delete targets uniquely matched:', flowsMatched)
if (currentBitvavoFlows.length !== 17 || !flowsMatched) {
  console.error('ABORT: capital_flow_entries row set does not match expected plan.')
  process.exit(1)
}

console.log('\n=== BEFORE: Year Analysis 2026 + Bitcoin metrics (real domain code) ===')
const before = await runYearAnalysis(2026)
console.log(JSON.stringify(before, null, 2))

if (APPLY) {
  console.log('\n=== APPLYING ===')

  const { error: delBulkErr } = await supabase.from('transactions').delete().eq('id', BULK_BUY_ID)
  if (delBulkErr) throw new Error(`delete bulk buy: ${delBulkErr.message}`)
  console.log('deleted bulk onboarding buy')

  for (const t of REAL_ONBOARDING_BUYS) {
    const { error } = await supabase.from('transactions').insert({ user_id: USER_ID, ...t })
    if (error) throw new Error(`insert onboarding buy ${t.date}: ${error.message}`)
  }
  console.log(`inserted ${REAL_ONBOARDING_BUYS.length} real onboarding buys`)

  for (const g of granularMatched) {
    const patch = { fee: g.plan.fee, is_contribution: false }
    if (g.plan.dateFix) patch.date = g.plan.dateFix
    const { error } = await supabase.from('transactions').update(patch).eq('id', g.id)
    if (error) throw new Error(`update granular ${g.id}: ${error.message}`)
  }
  console.log(`updated ${granularMatched.length} granular buy rows (fee, is_contribution, 1 date fix)`)

  const cfeIds = currentBitvavoFlows.map((r) => r.id)
  const { error: delCfeErr } = await supabase.from('capital_flow_entries').delete().in('id', cfeIds)
  if (delCfeErr) throw new Error(`delete capital_flow_entries: ${delCfeErr.message}`)
  console.log(`deleted ${cfeIds.length} bulk capital_flow_entries`)

  for (const d of REAL_DEPOSITS) {
    const { error } = await supabase.from('capital_flow_entries').insert({ user_id: USER_ID, ...d })
    if (error) throw new Error(`insert deposit ${d.flow_date}: ${error.message}`)
  }
  console.log(`inserted ${REAL_DEPOSITS.length} real dated deposits`)

  for (const r of INCOME_ROWS) {
    const { error } = await supabase.from('transactions').insert({ user_id: USER_ID, ...r })
    if (error) throw new Error(`insert income row ${r.date}: ${error.message}`)
  }
  console.log(`inserted ${INCOME_ROWS.length} income rows (rebate + incentive)`)

  console.log('\n=== AFTER: Year Analysis 2026 + Bitcoin metrics (real domain code) ===')
  const after = await runYearAnalysis(2026)
  console.log(JSON.stringify(after, null, 2))

  console.log('\n=== Comparison ===')
  console.log('BTC quantity            before:', before.btcMetrics.quantity, ' after:', after.btcMetrics.quantity)
  console.log('BTC cost basis          before:', before.btcMetrics.remainingCostBasis.toFixed(2), ' after:', after.btcMetrics.remainingCostBasis.toFixed(2))
  console.log('BTC unrealized P/L      before:', before.btcMetrics.unrealizedProfit.toFixed(2), ' after:', after.btcMetrics.unrealizedProfit.toFixed(2))
  console.log('Bitvavo net cashflow    before:', before.bitvavoNet.toFixed(2), ' after:', after.bitvavoNet.toFixed(2))
  console.log('Whole-portfolio net contributions  before:', before.summary.netContributionsEur.toFixed(2), ' after:', after.summary.netContributionsEur.toFixed(2))
  console.log('Growth after contributions          before:', before.summary.growthExcludingContributionsEur.toFixed(2), ' after:', after.summary.growthExcludingContributionsEur.toFixed(2))
  console.log('Modified Dietz %                    before:', before.summary.modifiedDietzReturnPercent?.toFixed(4), ' after:', after.summary.modifiedDietzReturnPercent?.toFixed(4))
  console.log('Live total portfolio value          before:', before.liveTotalValueEur.toFixed(2), ' after:', after.liveTotalValueEur.toFixed(2), '(should be identical)')

  console.log('\n=== Final quantity check ===')
  const { data: finalTxs } = await supabase.from('transactions').select('quantity, type, is_contribution').eq('investment_id', BITCOIN_INV_ID)
  const finalQty = finalTxs.filter((t) => t.type === 'buy').reduce((s, t) => s + Number(t.quantity), 0)
  console.log('Final BTC quantity:', finalQty.toFixed(8), '(expect 0.03459626)')
  const badContrib = finalTxs.filter((t) => (t.type === 'buy') && t.is_contribution === true)
  console.log('Buy rows still is_contribution=true (expect 0):', badContrib.length)
} else {
  console.log('\n(dry-run only, no writes performed)')
}
