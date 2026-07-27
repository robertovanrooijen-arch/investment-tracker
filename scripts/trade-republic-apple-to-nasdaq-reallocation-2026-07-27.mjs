// Trade Republic reallocation, 2026-07-27 — approved plan, applied 2026-07-27.
//
// Sold Apple, bought EQQQ Nasdaq 100 USD (Acc) with almost the same proceeds,
// entirely inside Trade Republic. This is a reallocation, not new external
// money: both transactions get is_contribution=false, and NO
// capital_flow_entry is created for either leg (no contribution, no
// withdrawal). The ~€0.45 gap between Apple's net proceeds (€296.51) and the
// Nasdaq buy total (€296.96) is left as-is — tiny existing/rounding cash,
// per the approved plan; Trade Republic cash isn't tracked precisely here.
//
// Touches ONLY the `transactions` table (2 new rows). Does not touch
// investment_snapshots, portfolio_snapshots, capital_flow_entries, or any
// other platform's data.
//
// Usage: node --import ./alias-loader.mjs scripts/trade-republic-apple-to-nasdaq-reallocation-2026-07-27.mjs --user-id=<uuid> [--apply --confirm]

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
    'Usage: node --import ./alias-loader.mjs scripts/trade-republic-apple-to-nasdaq-reallocation-2026-07-27.mjs --user-id=<uuid> [--apply --confirm]'
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

const TRADE_DATE = '2026-07-27'

console.log(APPLY ? 'MODE: APPLY' : 'MODE: DRY-RUN (pass --apply --confirm to write)')

const invRes = await supabase.from('investments').select('*').eq('user_id', USER_ID)
if (invRes.error) throw new Error(invRes.error.message)
const investments = invRes.data

const apple = investments.find((i) => i.platform === 'Trade Republic' && i.name === 'Apple')
const nasdaq = investments.find((i) => i.platform === 'Trade Republic' && i.name === 'Nasdaq 100')
if (!apple) throw new Error('Trade Republic Apple investment not found')
if (!nasdaq) throw new Error('Trade Republic Nasdaq 100 investment not found')
console.log('\nFound investments:')
console.log('  Apple (Trade Republic):', apple.id)
console.log('  Nasdaq 100 (Trade Republic):', nasdaq.id, `(ticker ${nasdaq.ticker})`)

const [txRes, fxRes, cfeCountRes] = await Promise.all([
  supabase.from('transactions').select('*').in('investment_id', investments.map((i) => i.id)),
  loadFxRates(supabase),
  supabase.from('capital_flow_entries').select('id', { count: 'exact', head: true }).eq('user_id', USER_ID),
])
const transactions = txRes.data
const fxRates = fxRes.rates
const cfeCountBefore = cfeCountRes.count

console.log('\n=== BEFORE: quantities (via computeInvestmentMetrics, same as app) ===')
const appleMetricsBefore = computeInvestmentMetrics(apple, transactions, fxRates)
const nasdaqMetricsBefore = computeInvestmentMetrics(nasdaq, transactions, fxRates)
console.log('Apple quantity before:', appleMetricsBefore.quantity)
console.log('Nasdaq 100 (TR) quantity before:', nasdaqMetricsBefore.quantity)

console.log('\n=== Duplicate check: existing transactions on 2026-07-27 for these two investments ===')
const dupCheck = transactions.filter(
  (t) => (t.investment_id === apple.id || t.investment_id === nasdaq.id) && t.date === TRADE_DATE
)
console.log('count:', dupCheck.length, '(expect 0)')
if (dupCheck.length > 0) {
  console.error('ABORT: transactions already exist for this date on these investments — not proceeding.')
  process.exit(1)
}

const appleSellTx = {
  user_id: USER_ID,
  investment_id: apple.id,
  type: 'sell',
  quantity: 1.006987,
  price_per_unit: 295.45,
  amount: 1.006987 * 295.45,
  fee: 1.0,
  date: TRADE_DATE,
  notes: 'Reallocation: sold to fund EQQQ Nasdaq 100 USD (Acc) buy same day.',
  price_currency: 'EUR',
  fee_currency: 'EUR',
  fx_rate_to_eur: 1,
  is_contribution: false,
  contribution_source: null,
}

const nasdaqBuyTx = {
  user_id: USER_ID,
  investment_id: nasdaq.id,
  type: 'buy',
  quantity: 0.703422,
  price_per_unit: 420.75,
  amount: 0.703422 * 420.75,
  fee: 1.0,
  date: TRADE_DATE,
  notes: 'Reallocation: EQQQ Nasdaq 100 USD (Acc), funded by same-day Apple sell.',
  price_currency: 'EUR',
  fee_currency: 'EUR',
  fx_rate_to_eur: 1,
  is_contribution: false,
  contribution_source: null,
}

console.log('\n=== Planned transactions ===')
console.log(JSON.stringify(appleSellTx, null, 2))
console.log(JSON.stringify(nasdaqBuyTx, null, 2))
console.log('\nApple sell net proceeds (amount - fee):', (appleSellTx.amount - appleSellTx.fee).toFixed(2), '(expect ~296.51)')
console.log('Nasdaq buy total (amount + fee):', (nasdaqBuyTx.amount + nasdaqBuyTx.fee).toFixed(2), '(expect ~296.96)')

console.log('\n=== Projected realized P/L on Apple (via computeInvestmentMetrics with the new sell appended) ===')
const appleMetricsAfter = computeInvestmentMetrics(apple, [...transactions, appleSellTx], fxRates)
console.log('Apple realizedProfit before:', appleMetricsBefore.realizedProfit.toFixed(2))
console.log('Apple realizedProfit after (projected):', appleMetricsAfter.realizedProfit.toFixed(2))
console.log(
  'Incremental realized P/L from this sell:',
  (appleMetricsAfter.realizedProfit - appleMetricsBefore.realizedProfit).toFixed(2),
  '(Trade Republic showed €52.01 — app uses average-cost-basis, expect roughly matching, not exact)'
)

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
console.log('Dashboard totalProfit:', before.liveMetrics.totalProfit.toFixed(2))
console.log('2026 netContributionsEur:', before.summary.netContributionsEur.toFixed(2))
console.log('2026 growthExcludingContributionsEur:', before.summary.growthExcludingContributionsEur?.toFixed(2))
console.log('2026 modifiedDietzReturnPercent:', before.summary.modifiedDietzReturnPercent?.toFixed(2))

if (APPLY) {
  console.log('\n=== APPLYING: inserting 2 transactions ===')
  const { data: inserted, error: insErr } = await supabase
    .from('transactions')
    .insert([appleSellTx, nasdaqBuyTx])
    .select('*')
  if (insErr) throw new Error(insErr.message)
  console.log('Inserted ids:', inserted.map((t) => t.id))

  const { data: afterTx } = await supabase.from('transactions').select('*').in('investment_id', investments.map((i) => i.id))
  const appleMetricsFinal = computeInvestmentMetrics(apple, afterTx, fxRates)
  const nasdaqMetricsFinal = computeInvestmentMetrics(nasdaq, afterTx, fxRates)

  console.log('\n=== AFTER: quantities ===')
  console.log('Apple quantity after:', appleMetricsFinal.quantity, '(expect', (appleMetricsBefore.quantity - 1.006987).toFixed(6), ')')
  console.log('Nasdaq 100 (TR) quantity after:', nasdaqMetricsFinal.quantity, '(expect', (nasdaqMetricsBefore.quantity + 0.703422).toFixed(6), ')')
  console.log('Apple quantity delta:', (appleMetricsFinal.quantity - appleMetricsBefore.quantity).toFixed(6), '(expect -1.006987)')
  console.log('Nasdaq 100 quantity delta:', (nasdaqMetricsFinal.quantity - nasdaqMetricsBefore.quantity).toFixed(6), '(expect +0.703422)')

  const { count: cfeCountAfter } = await supabase
    .from('capital_flow_entries')
    .select('id', { count: 'exact', head: true })
    .eq('user_id', USER_ID)
  console.log('\ncapital_flow_entries count before/after:', cfeCountBefore, '/', cfeCountAfter, '(expect equal)')

  console.log('\nis_contribution on both new rows:', inserted.map((t) => t.is_contribution))

  console.log('\n=== AFTER: Dashboard + Year Analysis 2026 (real domain code) ===')
  const after = await runSummary(afterTx)
  console.log('Dashboard totalValue:', after.liveMetrics.totalValue.toFixed(2))
  console.log('Dashboard totalProfit:', after.liveMetrics.totalProfit.toFixed(2))
  console.log('2026 netContributionsEur:', after.summary.netContributionsEur.toFixed(2))
  console.log('2026 growthExcludingContributionsEur:', after.summary.growthExcludingContributionsEur?.toFixed(2))
  console.log('2026 modifiedDietzReturnPercent:', after.summary.modifiedDietzReturnPercent?.toFixed(2))

  console.log('\n=== Deltas ===')
  console.log('totalValue delta:', (after.liveMetrics.totalValue - before.liveMetrics.totalValue).toFixed(2), '(expect ~ -2.00 fees, +/- price moves)')
  console.log('totalProfit delta:', (after.liveMetrics.totalProfit - before.liveMetrics.totalProfit).toFixed(2))
  console.log('netContributionsEur delta:', (after.summary.netContributionsEur - before.summary.netContributionsEur).toFixed(2), '(expect 0.00 — NOT +296.96)')
  console.log(
    'growthExcludingContributionsEur delta:',
    (after.summary.growthExcludingContributionsEur - before.summary.growthExcludingContributionsEur).toFixed(2)
  )
} else {
  console.log('\n(dry-run only, no writes performed)')
}
