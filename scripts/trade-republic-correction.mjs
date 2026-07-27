// Trade Republic correction — approved plan, applied 2026-07-27.
// Usage: node --import ./alias-loader.mjs scripts/trade-republic-correction.mjs --user-id=<uuid> [--apply --confirm]
// Touches ONLY Trade Republic investments/transactions and Trade Republic
// capital_flow_entries. Does not touch DEGIRO, Bitvavo, Gold Republic,
// Holland Gold, snapshots, prices, or calculation logic.

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
  console.error('Usage: node --import ./alias-loader.mjs scripts/trade-republic-correction.mjs --user-id=<uuid> [--apply --confirm]')
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

const MSCI_ID = '9ef0db88-128c-4bcf-b6fd-e46b75451461'
const NASDAQ_ID = '628acea5-7e9b-426e-8c8a-711eab4449cb'
const ASML_ID = 'f482c9d1-0f91-47d7-9557-3e47c2e948a1'
const APPLE_ID = '9679928a-ef00-40ab-9bd0-7f6df098bff4'
const DWAVE_ID = 'bbb822f4-fcc4-4dcf-8fbb-070ca68513fa'

const BULK_ID = 'aa1e733b-3ad5-42d1-9fce-bf6eb275306a'
const MERGED_0702_ID = 'd3d1b573-a07b-4835-9b0a-2aca80a06683'
const MERGED_APPLE_ID = '6f3af118-e2cf-410c-bb31-d35547f9b688'
const DATE_FIX_ID = 'b0bb05ea-b87d-4069-8b59-56bcabf35b7c'
const QTY_FIX_ID = 'c156a412-a940-4fd6-ac1f-57133dba8d62'

function row(investmentId, date, qty, price, fee, notes) {
  return {
    investment_id: investmentId,
    type: 'buy',
    date,
    quantity: qty,
    price_per_unit: price,
    amount: Math.round(qty * price * 100) / 100,
    fee,
    price_currency: 'EUR',
    fee_currency: 'EUR',
    fx_rate_to_eur: 1,
    is_contribution: false,
    notes,
  }
}

// 14 real MSCI World buys, 2026-02-23 -> 2026-05-04 (replaces the fake bulk row)
const MSCI_PRE_BULK = [
  ['2026-02-23', 0.016801, 113.68],
  ['2026-03-02', 0.042441, 113.8049],
  ['2026-03-02', 0.439309, 113.8150],
  ['2026-03-09', 0.030590, 111.1450],
  ['2026-03-16', 0.108084, 112.3200],
  ['2026-03-23', 0.082950, 109.9450],
  ['2026-04-02', 0.128084, 109.6150], // reward-funded buy, still a real transaction
  ['2026-04-02', 0.455978, 109.6543],
  ['2026-04-02', 0.028982, 109.7228],
  ['2026-04-09', 0.049541, 112.4300],
  ['2026-04-16', 0.177607, 115.0850],
  ['2026-04-23', 0.066723, 116.9000],
  ['2026-05-04', 0.127399, 117.7400], // reward-funded buy
  ['2026-05-04', 0.201996, 117.8733],
].map(([d, q, p]) => row(MSCI_ID, d, q, p, 0, 'Restored from Trade Republic export — replaces fake 2026-05-05 onboarding buy.'))

const MSCI_MISSING_0723 = [row(MSCI_ID, '2026-07-23', 0.015855, 124.8751, 0, 'Restored — was missing entirely from the app.')]

const MSCI_SPLIT_0702 = [
  row(MSCI_ID, '2026-07-02', 0.151635, 125.6961, 0, 'Split from merged onboarding row into real CSV fill.'),
  row(MSCI_ID, '2026-07-02', 0.397772, 125.7000, 0, 'Split from merged onboarding row into real CSV fill.'),
]

const APPLE_SPLIT = [
  row(APPLE_ID, '2026-06-27', 2.0, 243.30, 1.00, 'Split from merged row into real CSV fill.'),
  row(APPLE_ID, '2026-06-27', 0.013974, 243.30, 0, 'Split from merged row into real CSV fill.'),
]

// 30 real dated capital_flow_entries (non-reward-funded purchases)
const CFE_MSCI = [
  ['2026-02-23', 1.91], ['2026-03-02', 4.83], ['2026-03-02', 50.00], ['2026-03-09', 3.40],
  ['2026-03-16', 12.14], ['2026-03-23', 9.12], ['2026-04-02', 50.00], ['2026-04-02', 3.18],
  ['2026-04-09', 5.57], ['2026-04-16', 20.44], ['2026-04-23', 7.80], ['2026-05-04', 23.81],
  ['2026-05-11', 11.44], ['2026-05-18', 8.23], ['2026-05-25', 14.84], ['2026-06-02', 17.96],
  ['2026-06-02', 50.00], ['2026-06-09', 14.09], ['2026-06-16', 17.02], ['2026-06-23', 12.57],
  ['2026-07-02', 19.06], ['2026-07-02', 50.00], ['2026-07-09', 2.71], ['2026-07-16', 4.42],
  ['2026-07-23', 1.98],
]
const CFE_OTHER = [
  ['2026-06-27', 487.60], ['2026-06-27', 3.40], // Apple, 2 fills
  ['2026-07-07', 831.00], // ASML
  ['2026-07-15', 300.91], // D-Wave
  ['2026-07-16', 50.00], // Nasdaq 100
]
const NEW_CFE = [...CFE_MSCI, ...CFE_OTHER].map(([flow_date, amount_eur]) => ({
  flow_date,
  year: Number(flow_date.slice(0, 4)),
  platform: 'Trade Republic',
  direction: 'to_portfolio',
  amount_eur,
  source: 'trade_republic_transactions_export_2026',
  notes: 'Real dated non-reward-funded security purchase.',
}))

async function loadFxRates() {
  const { data } = await supabase.from('fx_rates').select('currency, eur_per_unit')
  const rates = { EUR: 1 }
  for (const r of data ?? []) rates[r.currency] = Number(r.eur_per_unit)
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
  const metricsFor = (id) => computeInvestmentMetrics(investments.find((i) => i.id === id), transactions, fxRates)
  return {
    summary,
    liveTotalValueEur,
    msci: metricsFor(MSCI_ID),
    nasdaq: metricsFor(NASDAQ_ID),
    asml: metricsFor(ASML_ID),
    apple: metricsFor(APPLE_ID),
    dwave: metricsFor(DWAVE_ID),
  }
}

console.log(APPLY ? 'MODE: APPLY' : 'MODE: DRY-RUN (pass --apply --confirm to write)')

console.log('\n=== BEFORE: rows to delete ===')
for (const id of [BULK_ID, MERGED_0702_ID, MERGED_APPLE_ID]) {
  const { data } = await supabase.from('transactions').select('*').eq('id', id).single()
  console.log(JSON.stringify(data))
}

console.log('\n=== BEFORE: rows to patch (date/qty fix) ===')
const { data: dateFixRow } = await supabase.from('transactions').select('*').eq('id', DATE_FIX_ID).single()
const { data: qtyFixRow } = await supabase.from('transactions').select('*').eq('id', QTY_FIX_ID).single()
console.log('date-fix target:', JSON.stringify(dateFixRow))
console.log('qty-fix target:', JSON.stringify(qtyFixRow))
if (!dateFixRow || Math.abs(dateFixRow.quantity - 0.101089) > 1e-6) { console.error('ABORT: date-fix row mismatch'); process.exit(1) }
if (!qtyFixRow || Math.abs(qtyFixRow.quantity - 0.11428) > 1e-6) { console.error('ABORT: qty-fix row mismatch'); process.exit(1) }

console.log('\n=== BEFORE: all Trade Republic transactions ===')
const { data: allTrTx } = await supabase.from('transactions').select('id').in('investment_id', [MSCI_ID, NASDAQ_ID, ASML_ID, APPLE_ID, DWAVE_ID])
console.log('total count:', allTrTx.length, '(expect 17)')

console.log('\n=== BEFORE: Trade Republic capital_flow_entries ===')
const { data: oldCfe } = await supabase.from('capital_flow_entries').select('*').eq('user_id', USER_ID).eq('platform', 'Trade Republic').order('flow_date')
for (const r of oldCfe) console.log(JSON.stringify(r))
const oldCfeTotal = oldCfe.reduce((s, r) => s + Number(r.amount_eur), 0)
console.log(`Found ${oldCfe.length} rows, total €${oldCfeTotal.toFixed(2)} (expect 5 rows, €255.74)`)

const newCfeTotal = NEW_CFE.reduce((s, f) => s + f.amount_eur, 0)
console.log('\nPlanned new capital_flow_entries:', NEW_CFE.length, 'rows, total €' + newCfeTotal.toFixed(2), '(expect 30 rows, €2089.43)')

console.log('\n=== BEFORE: Year Analysis 2026 + TR metrics (real domain code) ===')
const before = await runYearAnalysis(2026)
console.log('netContributionsEur:', before.summary.netContributionsEur)
console.log('growthExcludingContributionsEur:', before.summary.growthExcludingContributionsEur)
console.log('modifiedDietzReturnPercent:', before.summary.modifiedDietzReturnPercent)
console.log('liveTotalValueEur:', before.liveTotalValueEur)
console.log('msci:', JSON.stringify(before.msci))
console.log('nasdaq:', JSON.stringify(before.nasdaq))
console.log('apple:', JSON.stringify(before.apple))
console.log('asml:', JSON.stringify(before.asml))
console.log('dwave:', JSON.stringify(before.dwave))

if (APPLY) {
  console.log('\n=== APPLYING ===')

  for (const id of [BULK_ID, MERGED_0702_ID, MERGED_APPLE_ID]) {
    const { error } = await supabase.from('transactions').delete().eq('id', id)
    if (error) throw new Error(error.message)
  }
  console.log('deleted 3 rows (bulk, merged 07-02, merged Apple)')

  for (const t of [...MSCI_PRE_BULK, ...MSCI_MISSING_0723, ...MSCI_SPLIT_0702, ...APPLE_SPLIT]) {
    const { error } = await supabase.from('transactions').insert({ user_id: USER_ID, ...t })
    if (error) throw new Error(`insert ${t.date} ${t.quantity}: ${error.message}`)
  }
  console.log(`inserted ${MSCI_PRE_BULK.length + MSCI_MISSING_0723.length + MSCI_SPLIT_0702.length + APPLE_SPLIT.length} transactions`)

  const { error: dateFixErr } = await supabase.from('transactions').update({ date: '2026-06-23' }).eq('id', DATE_FIX_ID)
  if (dateFixErr) throw new Error(dateFixErr.message)
  const { error: qtyFixErr } = await supabase.from('transactions').update({ quantity: 0.114285 }).eq('id', QTY_FIX_ID)
  if (qtyFixErr) throw new Error(qtyFixErr.message)
  console.log('fixed date (06-24->06-23) and Nasdaq quantity (0.11428->0.114285)')

  const { data: remainingTx } = await supabase.from('transactions').select('id').in('investment_id', [MSCI_ID, NASDAQ_ID, ASML_ID, APPLE_ID, DWAVE_ID])
  const { error: contribErr } = await supabase.from('transactions').update({ is_contribution: false }).in('id', remainingTx.map((r) => r.id))
  if (contribErr) throw new Error(contribErr.message)
  console.log(`set is_contribution=false on all ${remainingTx.length} Trade Republic transactions`)

  const { error: delCfeErr } = await supabase.from('capital_flow_entries').delete().in('id', oldCfe.map((r) => r.id))
  if (delCfeErr) throw new Error(delCfeErr.message)
  console.log(`deleted ${oldCfe.length} old capital_flow_entries`)

  for (const f of NEW_CFE) {
    const { error } = await supabase.from('capital_flow_entries').insert({ user_id: USER_ID, ...f })
    if (error) throw new Error(`insert cfe ${f.flow_date}: ${error.message}`)
  }
  console.log(`inserted ${NEW_CFE.length} real dated capital_flow_entries`)

  console.log('\n=== AFTER: Year Analysis 2026 + TR metrics (real domain code) ===')
  const after = await runYearAnalysis(2026)
  console.log('msci:', JSON.stringify(after.msci))
  console.log('nasdaq:', JSON.stringify(after.nasdaq))
  console.log('apple:', JSON.stringify(after.apple))
  console.log('asml:', JSON.stringify(after.asml))
  console.log('dwave:', JSON.stringify(after.dwave))

  console.log('\n=== Comparison ===')
  console.log('MSCI qty          before:', before.msci.quantity, ' after:', after.msci.quantity, '(expect 3.869176)')
  console.log('Nasdaq qty        before:', before.nasdaq.quantity, ' after:', after.nasdaq.quantity, '(expect 0.114285)')
  console.log('Apple qty         before:', before.apple.quantity, ' after:', after.apple.quantity, '(expect 2.013974)')
  console.log('ASML qty          before:', before.asml.quantity, ' after:', after.asml.quantity, '(expect 0.549741)')
  console.log('D-Wave qty        before:', before.dwave.quantity, ' after:', after.dwave.quantity, '(expect 18.844221)')
  console.log('netContributionsEur  before:', before.summary.netContributionsEur, ' after:', after.summary.netContributionsEur)
  console.log('growthExcludingContributionsEur before:', before.summary.growthExcludingContributionsEur, ' after:', after.summary.growthExcludingContributionsEur)
  console.log('modifiedDietzReturnPercent before:', before.summary.modifiedDietzReturnPercent, ' after:', after.summary.modifiedDietzReturnPercent)
  console.log('liveTotalValueEur before:', before.liveTotalValueEur, ' after:', after.liveTotalValueEur, ' delta:', (after.liveTotalValueEur - before.liveTotalValueEur).toFixed(4))

  console.log('\n=== Final checks ===')
  const { data: finalTx } = await supabase.from('transactions').select('is_contribution').in('investment_id', [MSCI_ID, NASDAQ_ID, ASML_ID, APPLE_ID, DWAVE_ID])
  console.log('TR transactions with is_contribution=true (expect 0):', finalTx.filter((t) => t.is_contribution === true).length)
  const { data: finalCfe } = await supabase.from('capital_flow_entries').select('amount_eur').eq('user_id', USER_ID).eq('platform', 'Trade Republic')
  console.log('Final TR capital_flow_entries total:', finalCfe.reduce((s, r) => s + Number(r.amount_eur), 0).toFixed(2), '(expect 2089.43)')
} else {
  console.log('\n(dry-run only, no writes performed)')
}
