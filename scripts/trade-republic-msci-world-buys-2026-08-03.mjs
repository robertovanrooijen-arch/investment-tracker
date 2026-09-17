// Trade Republic MSCI World — 3 executed buys, 2026-08-03 — approved plan,
// applied 2026-08-03.
//
// Cash savings plan (€50), Saveback (€15), Round Up (€11.29) — all treated
// as ordinary contributions funding the existing Trade Republic Core MSCI
// World investment (IE00B4L5Y983). Each gets its own buy transaction
// (is_contribution=false, per the app's convention that contribution status
// lives on the capital_flow_entry, not the transaction) AND its own
// capital_flow_entry (direction=to_portfolio) — explicitly requested so
// Saveback/Round Up read as contributions, not investment performance.
//
// Touches ONLY: transactions (3 new rows) + capital_flow_entries (3 new
// rows), all Trade Republic / this one investment. No other platform,
// snapshot, or historical row touched.
//
// Usage: node --import ./alias-loader.mjs scripts/trade-republic-msci-world-buys-2026-08-03.mjs --user-id=<uuid> [--apply --confirm]

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
    'Usage: node --import ./alias-loader.mjs scripts/trade-republic-msci-world-buys-2026-08-03.mjs --user-id=<uuid> [--apply --confirm]'
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

const TRADE_DATE = '2026-08-03'
const PRICE = 125.9164

console.log(APPLY ? 'MODE: APPLY' : 'MODE: DRY-RUN (pass --apply --confirm to write)')

const invRes = await supabase.from('investments').select('*').eq('user_id', USER_ID)
if (invRes.error) throw new Error(invRes.error.message)
const investments = invRes.data

const msci = investments.find((i) => i.platform === 'Trade Republic' && i.name === 'MSCI World')
if (!msci) throw new Error('Trade Republic MSCI World investment not found')
console.log('\n=== 1. Found investment ===')
console.log('MSCI World (Trade Republic):', msci.id, `ticker=${msci.ticker}`)

const [txRes, fxRes] = await Promise.all([
  supabase.from('transactions').select('*').in('investment_id', investments.map((i) => i.id)),
  loadFxRates(supabase),
])
const transactions = txRes.data
const fxRates = fxRes.rates

console.log('\n=== 2. Current quantity (via computeInvestmentMetrics, same as app) ===')
const msciMetricsBefore = computeInvestmentMetrics(msci, transactions, fxRates)
console.log('MSCI World (TR) quantity before:', msciMetricsBefore.quantity)

console.log('\n=== 3. Duplicate check: existing 2026-08-03 buys on this investment ===')
const existingOnDate = transactions.filter((t) => t.investment_id === msci.id && t.date === TRADE_DATE)
console.log('count:', existingOnDate.length, '(expect 0)')
for (const t of existingOnDate) console.log(JSON.stringify(t))
if (existingOnDate.length > 0) {
  console.error('ABORT: transactions already exist for this date on this investment — not proceeding.')
  process.exit(1)
}

const orders = [
  {
    label: 'Order 1 — Cash savings plan',
    quantity: 0.397088,
    amountEurGiven: 50.0,
    cfeSource: 'trade_republic_msci_cash_savings_plan_2026_08_03',
    notes: 'Trade Republic cash savings plan execution 2026-08-03.',
  },
  {
    label: 'Order 2 — Saveback',
    quantity: 0.119126659,
    amountEurGiven: 15.0,
    cfeSource: 'trade_republic_msci_saveback_execution_2026_08_03',
    notes: 'Trade Republic Saveback execution 2026-08-03 (created 2026-08-01, executed 2026-08-03). Treated as an ordinary contribution, not performance.',
  },
  {
    label: 'Order 3 — Round Up',
    quantity: 0.089662665,
    amountEurGiven: 11.29,
    cfeSource: 'trade_republic_msci_round_up_execution_2026_08_03',
    notes: 'Trade Republic Round Up execution 2026-08-03. Treated as an ordinary contribution, not performance.',
  },
]

const buyTxs = []
const cfeRows = []
console.log('\n=== 4. Planned rows ===')
for (const o of orders) {
  const grossEur = o.quantity * PRICE
  console.log(`${o.label}: quantity=${o.quantity} price=${PRICE} gross=${grossEur.toFixed(4)} (given amount ${o.amountEurGiven.toFixed(2)})`)

  const tx = {
    user_id: USER_ID,
    investment_id: msci.id,
    type: 'buy',
    quantity: o.quantity,
    price_per_unit: PRICE,
    amount: grossEur,
    fee: 0,
    date: TRADE_DATE,
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
    flow_date: TRADE_DATE,
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

const totalContribution = orders.reduce((s, o) => s + o.amountEurGiven, 0)
console.log('\nTotal contribution across 3 orders:', totalContribution.toFixed(2), '(expect 76.29)')
const totalQty = orders.reduce((s, o) => s + o.quantity, 0)
console.log('Total quantity across 3 orders:', totalQty.toFixed(9), '(expect 0.605877324)')

async function runSummary(txList) {
  const liveMetrics = computePortfolioMetrics(investments, txList, fxRates)
  const year = 2026
  const assetRows = computeAssetYearRows(investments, txList, year, fxRates)
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

console.log('\n=== BEFORE: Dashboard + Year Analysis 2026 (real domain code) ===')
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
  console.log('\n=== APPLYING: inserting 3 transactions + 3 capital_flow_entries ===')
  const { data: insertedTx, error: txErr } = await supabase.from('transactions').insert(buyTxs).select('*')
  if (txErr) throw new Error(txErr.message)
  console.log('Inserted transaction ids:', insertedTx.map((t) => t.id))

  const { data: insertedCfe, error: cfeErr } = await supabase.from('capital_flow_entries').insert(cfeRows).select('*')
  if (cfeErr) throw new Error(cfeErr.message)
  console.log('Inserted capital_flow_entry ids:', insertedCfe.map((c) => c.id))

  const { data: afterTx } = await supabase.from('transactions').select('*').in('investment_id', investments.map((i) => i.id))
  const msciMetricsAfter = computeInvestmentMetrics(msci, afterTx, fxRates)

  console.log('\n=== AFTER: quantity ===')
  console.log('MSCI World (TR) quantity after:', msciMetricsAfter.quantity)
  console.log('Quantity delta:', (msciMetricsAfter.quantity - msciMetricsBefore.quantity).toFixed(9), '(expect 0.605877324)')

  const { count: cfeCountAfter } = await supabase
    .from('capital_flow_entries')
    .select('id', { count: 'exact', head: true })
    .eq('user_id', USER_ID)
  console.log('capital_flow_entries count before/after:', cfeCountBefore, '/', cfeCountAfter, '(expect +3)')

  console.log('is_contribution on all 3 new tx rows:', insertedTx.map((t) => t.is_contribution))

  console.log('\n=== AFTER: Dashboard + Year Analysis 2026 (real domain code) ===')
  const after = await runSummary(afterTx)
  console.log('Dashboard totalValue:', after.liveMetrics.totalValue.toFixed(2))
  console.log('2026 netContributionsEur:', after.summary.netContributionsEur.toFixed(2))
  console.log('2026 growthExcludingContributionsEur:', after.summary.growthExcludingContributionsEur?.toFixed(2))
  console.log('2026 modifiedDietzReturnPercent:', after.summary.modifiedDietzReturnPercent?.toFixed(2))

  console.log('\n=== Deltas ===')
  console.log('totalValue delta:', (after.liveMetrics.totalValue - before.liveMetrics.totalValue).toFixed(2))
  console.log('netContributionsEur delta:', (after.summary.netContributionsEur - before.summary.netContributionsEur).toFixed(2), '(expect +76.29)')
  console.log(
    'growthExcludingContributionsEur delta:',
    (after.summary.growthExcludingContributionsEur - before.summary.growthExcludingContributionsEur).toFixed(2),
    '(expect ~0, since new money in should not itself count as growth)'
  )

  console.log('\n=== 5. Other platforms untouched — investment ids touched this run ===')
  console.log('Only investment_id touched:', msci.id, '(', msci.platform, msci.name, ')')
} else {
  console.log('\n(dry-run only, no writes performed)')
}
