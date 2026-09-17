// Trade Republic — 2 nieuwe executed buys, approved plan, applied 2026-08-17.
//
// 1. EQQQ Nasdaq 100 USD (Acc), cash savings plan, 2026-08-17, €50.00.
// 2. Core MSCI World USD (Acc), Round Up, 2026-08-10, €3.87.
//
// Volgt exact dezelfde conventie als de meest recente savings-plan/saveback/
// roundup-buys op deze investments (2026-08-03, zie
// scripts/trade-republic-msci-world-buys-2026-08-03.mjs): transaction row
// met is_contribution=false, contribution_source=null, PLUS een losse
// capital_flow_entry (direction=to_portfolio) met een beschrijvende
// per-order source-slug. Dit is een ANDERE conventie dan de oudere bulk-CSV-
// import rows (contribution_source='external' + gedeelde bulk-import
// source) — bewust niet gebruikt hier, want dit zijn losse individuele
// savings-plan/roundup executies, geen CSV-batchimport.
//
// Raakt ALLEEN: transactions (2 nieuwe rows) + capital_flow_entries (2
// nieuwe rows), beide op bestaande Trade Republic investments. Geen andere
// investment, platform, snapshot of berekeningslogica aangeraakt.
//
// Usage: node --import ./alias-loader.mjs scripts/trade-republic-eqqq-msci-buys-2026-08-10-17.mjs --user-id=<uuid> [--apply --confirm]

import { createClient } from '@supabase/supabase-js'
import { readFileSync } from 'node:fs'
import { computeInvestmentMetrics, computePortfolioMetrics } from '@/lib/domain/calculations.ts'
import { computeAssetYearRows, computeYearPortfolioSummary } from '@/lib/domain/year-analysis.ts'
import { loadFxRates } from '@/lib/domain/fx.ts'

const args = Object.fromEntries(
  process.argv.slice(2).map((a) => {
    const [k, v] = a.replace(/^--/, '').split('=')
    return [k, v ?? true]
  })
)
const USER_ID = args['user-id']
const APPLY = args.apply === true && args.confirm === true
if (!USER_ID) {
  console.error(
    'Usage: node --import ./alias-loader.mjs scripts/trade-republic-eqqq-msci-buys-2026-08-10-17.mjs --user-id=<uuid> [--apply --confirm]'
  )
  process.exit(1)
}

const env = Object.fromEntries(
  readFileSync('.env.local', 'utf8').split('\n').filter((l) => l.includes('=')).map((l) => {
    const i = l.indexOf('=')
    return [l.slice(0, i).trim(), l.slice(i + 1).trim()]
  })
)
const supabase = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY)

console.log(APPLY ? 'MODE: APPLY' : 'MODE: DRY-RUN (pass --apply --confirm to write)')

const invRes = await supabase.from('investments').select('*').eq('user_id', USER_ID).eq('platform', 'Trade Republic')
if (invRes.error) throw new Error(invRes.error.message)
const investments = invRes.data

const nasdaq = investments.find((i) => i.name === 'Nasdaq 100')
const msci = investments.find((i) => i.name === 'MSCI World')
if (!nasdaq) throw new Error('Trade Republic Nasdaq 100 investment not found')
if (!msci) throw new Error('Trade Republic MSCI World investment not found')

console.log('\n=== 1. Gevonden investments ===')
console.log(`Nasdaq 100 (Trade Republic): id=${nasdaq.id} ticker=${nasdaq.ticker} currency=${nasdaq.currency}`)
console.log(`MSCI World (Trade Republic): id=${msci.id} ticker=${msci.ticker} currency=${msci.currency}`)

const allInvRes = await supabase.from('investments').select('*').eq('user_id', USER_ID)
const allInvestments = allInvRes.data
const [txRes, fxRes] = await Promise.all([
  supabase.from('transactions').select('*').in('investment_id', allInvestments.map((i) => i.id)),
  loadFxRates(supabase),
])
const transactions = txRes.data
const fxRates = fxRes.rates

console.log('\n=== Huidige quantity (via computeInvestmentMetrics, zelfde als de app) ===')
const nasdaqMetricsBefore = computeInvestmentMetrics(nasdaq, transactions, fxRates)
const msciMetricsBefore = computeInvestmentMetrics(msci, transactions, fxRates)
console.log('Nasdaq 100 (TR) quantity voor:', nasdaqMetricsBefore.quantity)
console.log('MSCI World (TR) quantity voor:', msciMetricsBefore.quantity)

console.log('\n=== 2/3. Duplicate check ===')
const dupNasdaq = transactions.filter((t) => t.investment_id === nasdaq.id && t.date === '2026-08-17')
const dupMsci = transactions.filter((t) => t.investment_id === msci.id && t.date === '2026-08-10')
console.log('Nasdaq 100 (TR) op 2026-08-17:', dupNasdaq.length, '(expect 0)')
console.log('MSCI World (TR) op 2026-08-10:', dupMsci.length, '(expect 0)')
if (dupNasdaq.length > 0 || dupMsci.length > 0) {
  console.error('ABORT: er bestaan al transacties op deze datum voor deze investment — niet doorgaan.')
  process.exit(1)
}

const orders = [
  {
    label: 'EQQQ Nasdaq 100 — cash savings plan',
    investment: nasdaq,
    date: '2026-08-17',
    quantity: 0.112032,
    price: 446.3,
    amountEurGiven: 50.0,
    notes: 'Trade Republic cash savings plan execution 2026-08-17.',
    cfeSource: 'trade_republic_nasdaq_cash_savings_plan_2026_08_17',
  },
  {
    label: 'Core MSCI World — Round Up',
    investment: msci,
    date: '2026-08-10',
    quantity: 0.030068,
    price: 128.71,
    amountEurGiven: 3.87,
    notes: 'Trade Republic Round Up execution 2026-08-10. Treated as an ordinary contribution, not performance.',
    cfeSource: 'trade_republic_msci_round_up_execution_2026_08_10',
  },
]

const buyTxs = []
const cfeRows = []
console.log('\n=== 4. Geplande rows ===')
for (const o of orders) {
  const grossEur = o.quantity * o.price
  console.log(`${o.label}: quantity=${o.quantity} price=${o.price} gross=${grossEur.toFixed(4)} (opgegeven bedrag ${o.amountEurGiven.toFixed(2)})`)

  const tx = {
    user_id: USER_ID,
    investment_id: o.investment.id,
    type: 'buy',
    quantity: o.quantity,
    price_per_unit: o.price,
    amount: grossEur,
    fee: 0,
    date: o.date,
    notes: o.notes,
    price_currency: 'EUR',
    fee_currency: 'EUR',
    fx_rate_to_eur: 1,
    is_contribution: false,
    contribution_source: null,
  }
  buyTxs.push(tx)
  console.log(JSON.stringify(tx, null, 2))

  const cfe = {
    user_id: USER_ID,
    flow_date: o.date,
    year: 2026,
    platform: 'Trade Republic',
    direction: 'to_portfolio',
    amount_eur: o.amountEurGiven,
    source: o.cfeSource,
    notes: o.notes,
  }
  cfeRows.push(cfe)
  console.log(JSON.stringify(cfe, null, 2))
}

async function runSummary(txList) {
  const liveMetrics = computePortfolioMetrics(allInvestments, txList, fxRates)
  const year = 2026
  const assetRows = computeAssetYearRows(allInvestments, txList, year, fxRates)
  const { data: snapshots } = await supabase
    .from('portfolio_snapshots')
    .select('date, total_value_eur, total_realized_eur, total_unrealized_eur, updated_at, snapshot_source')
    .eq('user_id', USER_ID)
  const { data: cfe } = await supabase
    .from('capital_flow_entries')
    .select('year, flow_date, direction, amount_eur')
    .eq('user_id', USER_ID)
  const summary = computeYearPortfolioSummary(year, assetRows, snapshots, cfe, txList, liveMetrics.totalValue)
  return { liveMetrics, summary }
}

console.log('\n=== VOOR: Dashboard + Year Analysis 2026 (echte domain code) ===')
const before = await runSummary(transactions)
console.log('Dashboard totalValue:', before.liveMetrics.totalValue.toFixed(2))
console.log('2026 netContributionsEur:', before.summary.netContributionsEur.toFixed(2))
console.log('2026 growthExcludingContributionsEur:', before.summary.growthExcludingContributionsEur?.toFixed(2))
console.log('2026 modifiedDietzReturnPercent:', before.summary.modifiedDietzReturnPercent?.toFixed(2))

const { count: cfeCountBefore } = await supabase
  .from('capital_flow_entries')
  .select('id', { count: 'exact', head: true })
  .eq('user_id', USER_ID)

if (APPLY) {
  console.log('\n=== APPLYING: 2 transactions + 2 capital_flow_entries invoegen ===')
  const { data: insertedTx, error: txErr } = await supabase.from('transactions').insert(buyTxs).select('*')
  if (txErr) throw new Error(txErr.message)
  console.log('Inserted transaction ids:', insertedTx.map((t) => t.id))

  const { data: insertedCfe, error: cfeErr } = await supabase.from('capital_flow_entries').insert(cfeRows).select('*')
  if (cfeErr) throw new Error(cfeErr.message)
  console.log('Inserted capital_flow_entry ids:', insertedCfe.map((c) => c.id))

  const { data: afterTx } = await supabase.from('transactions').select('*').in('investment_id', allInvestments.map((i) => i.id))
  const nasdaqMetricsAfter = computeInvestmentMetrics(nasdaq, afterTx, fxRates)
  const msciMetricsAfter = computeInvestmentMetrics(msci, afterTx, fxRates)

  console.log('\n=== NA: quantity ===')
  console.log('Nasdaq 100 (TR) quantity na:', nasdaqMetricsAfter.quantity, 'delta:', (nasdaqMetricsAfter.quantity - nasdaqMetricsBefore.quantity).toFixed(6), '(expect +0.112032)')
  console.log('MSCI World (TR) quantity na:', msciMetricsAfter.quantity, 'delta:', (msciMetricsAfter.quantity - msciMetricsBefore.quantity).toFixed(6), '(expect +0.030068)')

  const { count: cfeCountAfter } = await supabase
    .from('capital_flow_entries')
    .select('id', { count: 'exact', head: true })
    .eq('user_id', USER_ID)
  console.log('capital_flow_entries count voor/na:', cfeCountBefore, '/', cfeCountAfter, '(expect +2)')
  console.log('is_contribution op beide nieuwe tx rows:', insertedTx.map((t) => t.is_contribution))
  console.log('contribution_source op beide nieuwe tx rows:', insertedTx.map((t) => t.contribution_source))

  console.log('\n=== NA: Dashboard + Year Analysis 2026 (echte domain code) ===')
  const after = await runSummary(afterTx)
  console.log('Dashboard totalValue:', after.liveMetrics.totalValue.toFixed(2))
  console.log('2026 netContributionsEur:', after.summary.netContributionsEur.toFixed(2))
  console.log('2026 growthExcludingContributionsEur:', after.summary.growthExcludingContributionsEur?.toFixed(2))
  console.log('2026 modifiedDietzReturnPercent:', after.summary.modifiedDietzReturnPercent?.toFixed(2))

  console.log('\n=== Deltas ===')
  console.log('totalValue delta:', (after.liveMetrics.totalValue - before.liveMetrics.totalValue).toFixed(2))
  console.log('netContributionsEur delta:', (after.summary.netContributionsEur - before.summary.netContributionsEur).toFixed(2), '(expect +53.87)')
  console.log(
    'growthExcludingContributionsEur delta:',
    (after.summary.growthExcludingContributionsEur - before.summary.growthExcludingContributionsEur).toFixed(2)
  )

  console.log('\n=== 5. Andere platforms/investments aangeraakt? ===')
  const touchedIds = new Set([...insertedTx.map((t) => t.investment_id)])
  console.log('Aangeraakte investment ids:', [...touchedIds])
} else {
  console.log('\n(dry-run only, geen writes uitgevoerd)')
}
