// Gold Republic + Holland Gold correction — approved plan, applied 2026-07-27.
// Usage: node --import ./alias-loader.mjs scripts/gold-republic-holland-gold-correction.mjs --user-id=<uuid> [--apply --confirm]
// Touches ONLY: the combined Gold investment, Silver (GR), a new closed
// Silver (Holland Gold) investment, and GoldRepublic/Holland Gold
// capital_flow_entries. Does not touch DEGIRO, Bitvavo, Trade Republic,
// snapshots, prices, or calculation logic.

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
  console.error('Usage: node --import ./alias-loader.mjs scripts/gold-republic-holland-gold-correction.mjs --user-id=<uuid> [--apply --confirm]')
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

const TROY_OZ = 31.1034768
const GOLD_INV_ID = 'f0376504-9bdb-4beb-943a-d73ea25fae45'
const SILVER_GR_INV_ID = '11c033f3-2860-4bb1-8c52-e074d44e08ba'
const GOLD_BULK_ID = '99a25c78-725c-4e6c-9a58-42176e493870'
const SILVER_BULK_ID = '92788b8a-edf5-4ef8-998a-282e7cc8a7e2'
const GOLD_GRANULAR_ID = '914a9411-4a0b-4291-b5f1-e67809f5b0d0'
const SILVER_GRANULAR_ID = 'db7a5290-5a32-401c-83d3-f06f6ff09461'

function g2oz(grams) { return grams / TROY_OZ }
function round(n, d = 8) { return Math.round(n * 10 ** d) / 10 ** d }

function eurRow(investmentId, date, type, grams, txval, fee, notes) {
  const quantity = round(g2oz(grams), 6)
  const price_per_unit = round(txval / quantity, 4)
  return {
    investment_id: investmentId,
    type,
    date,
    quantity,
    price_per_unit,
    amount: round(txval, 2),
    fee: round(fee, 2),
    price_currency: 'EUR',
    fee_currency: 'EUR',
    fx_rate_to_eur: 1,
    is_contribution: false,
    notes,
  }
}

// ---- Gold Republic 2025 gold buys (9) ----
const GR_GOLD_2025 = [
  { date: '2025-02-06', txval: 49.75, fee: 0.25, vol: 0.559 },
  { date: '2025-03-05', txval: 49.75, fee: 0.25, vol: 0.557 },
  { date: '2025-04-03', txval: 74.63, fee: 0.37, vol: 0.791 },
  { date: '2025-05-06', txval: 74.63, fee: 0.37, vol: 0.805 },
  { date: '2025-06-04', txval: 99.50, fee: 0.50, vol: 1.040 },
  { date: '2025-07-07', txval: 99.50, fee: 0.50, vol: 1.078 },
  { date: '2025-08-06', txval: 99.50, fee: 0.50, vol: 1.058 },
  { date: '2025-09-03', txval: 99.50, fee: 0.50, vol: 1.034 },
  { date: '2025-10-07', txval: 99.50, fee: 0.50, vol: 0.928 },
].map((t) => eurRow(GOLD_INV_ID, t.date, 'buy', t.vol, t.txval, t.fee, 'Restored from Gold Republic 2025 statement.'))

// ---- Holland Gold gold buys (4) ----
const HG_GOLD = [
  { date: '2025-11-01', txval: 349.13, fee: 0.87, vol: 3.0861 },
  { date: '2025-11-04', txval: 398.01, fee: 1.99, vol: 3.5385 },
  { date: '2025-12-01', txval: 99.75, fee: 0.25, vol: 0.8418 },
  { date: '2026-01-02', txval: 74.81, fee: 0.19, vol: 0.6171 },
].map((t) => eurRow(GOLD_INV_ID, t.date, 'buy', t.vol, t.txval, t.fee, 'Restored from Holland Gold invoices.'))

// ---- Gold Republic 2025 silver buys (9) ----
const GR_SILVER_2025 = [
  { date: '2025-02-03', txval: 49.31, fee: 0.25 + 0.44, vol: 48.900 },
  { date: '2025-03-05', txval: 49.31, fee: 0.25 + 0.44, vol: 49.416 },
  { date: '2025-04-03', txval: 49.32, fee: 0.25 + 0.43, vol: 47.478 },
  { date: '2025-05-08', txval: 49.28, fee: 0.25 + 0.47, vol: 52.160 },
  { date: '2025-06-05', txval: 49.29, fee: 0.25 + 0.46, vol: 50.973 },
  { date: '2025-07-09', txval: 49.31, fee: 0.25 + 0.44, vol: 48.342 },
  { date: '2025-08-07', txval: 49.33, fee: 0.25 + 0.42, vol: 46.693 },
  { date: '2025-09-02', txval: 49.36, fee: 0.25 + 0.39, vol: 43.071 },
  { date: '2025-10-14', txval: 49.42, fee: 0.25 + 0.33, vol: 37.156 },
].map((t) => eurRow(SILVER_GR_INV_ID, t.date, 'buy', t.vol, t.txval, t.fee, 'Restored from Gold Republic 2025 statement.'))

// ---- Gold Republic 2025 silver sell (1) ----
const GR_SILVER_SELL = [eurRow(SILVER_GR_INV_ID, '2025-12-17', 'sell', 424.189, 760.14, 7.60, 'Restored from Gold Republic 2025 statement — real realized gain.')]

// ---- Gold Republic Feb 2026 silver buy (1, replaces the fake bulk row's real quantity) ----
const GR_SILVER_FEB2026 = [eurRow(SILVER_GR_INV_ID, '2026-02-10', 'buy', 187.573, 414.29, 4.16 + 1.69, 'Restored real date — was misdated 2026-05-05 in the fake onboarding row.')]

// ---- Holland Gold silver buys (4) + sells (2), for the NEW closed investment ----
// investment_id filled in after the new investment is created
const HG_SILVER_BUYS_RAW = [
  { date: '2025-11-01', type: 'buy', txval: 398.28, fee: 1.00 + 0.72, vol: 286.5359 },
  { date: '2025-11-04', type: 'buy', txval: 347.62, fee: 1.74 + 0.64, vol: 255.6060 },
  { date: '2025-12-01', type: 'buy', txval: 74.69, fee: 0.19 + 0.12, vol: 46.3944 },
  { date: '2026-01-02', type: 'buy', txval: 74.72, fee: 0.19 + 0.09, vol: 35.9254 },
]
const HG_SILVER_SELLS_RAW = [
  { date: '2026-01-13', type: 'sell', txval: 754.55, fee: 3.77 + 0.78, vol: 313.0930 },
  { date: '2026-01-30', type: 'sell', txval: 874.95, fee: 4.37 + 0.78, vol: 311.3687 },
]

// ---- capital_flow_entries ----
const GR_2025_DEPOSITS = [
  { flow_date: '2025-02-03', amount_eur: 100 },
  { flow_date: '2025-03-03', amount_eur: 100 },
  { flow_date: '2025-04-01', amount_eur: 125 },
  { flow_date: '2025-05-01', amount_eur: 125 },
  { flow_date: '2025-06-02', amount_eur: 150 },
  { flow_date: '2025-07-01', amount_eur: 150 },
  { flow_date: '2025-08-01', amount_eur: 150 },
  { flow_date: '2025-09-01', amount_eur: 150 },
  { flow_date: '2025-10-01', amount_eur: 150 },
].map((f) => ({ ...f, year: 2025, platform: 'GoldRepublic', direction: 'to_portfolio', source: 'goldrepublic_statement_2025', notes: 'Real dated savingsplan deposit.' }))

const GR_OTHER_CFE = [
  { flow_date: '2025-12-19', year: 2025, platform: 'GoldRepublic', direction: 'from_portfolio', amount_eur: 753.46, source: 'goldrepublic_statement_2025', notes: 'Client withdrawal after silver sale.' },
  { flow_date: '2026-02-05', year: 2026, platform: 'GoldRepublic', direction: 'to_portfolio', amount_eur: 420.00, source: 'goldrepublic_statement_2026', notes: 'Account deposit.' },
  { flow_date: '2026-05-26', year: 2026, platform: 'GoldRepublic', direction: 'to_portfolio', amount_eur: 955.00, source: 'goldrepublic_statement_2026', notes: 'Account deposit.' },
]

const HG_CFE = [
  { flow_date: '2025-11-01', amount_eur: 350.00, direction: 'to_portfolio', notes: 'Gold order 100223848.' },
  { flow_date: '2025-11-01', amount_eur: 400.00, direction: 'to_portfolio', notes: 'Silver order 100223849.' },
  { flow_date: '2025-11-04', amount_eur: 400.00, direction: 'to_portfolio', notes: 'Gold order 100224839.' },
  { flow_date: '2025-11-04', amount_eur: 350.00, direction: 'to_portfolio', notes: 'Silver order 100224840.' },
  { flow_date: '2025-12-01', amount_eur: 100.00, direction: 'to_portfolio', notes: 'Gold order 100239457.' },
  { flow_date: '2025-12-01', amount_eur: 75.00, direction: 'to_portfolio', notes: 'Silver order 100239458.' },
  { flow_date: '2026-01-02', amount_eur: 75.00, direction: 'to_portfolio', notes: 'Gold order 100271619.' },
  { flow_date: '2026-01-02', amount_eur: 75.00, direction: 'to_portfolio', notes: 'Silver order 100271620.' },
  { flow_date: '2026-01-13', amount_eur: 750.00, direction: 'from_portfolio', notes: 'Silver sale payout to bank, order 100282317.' },
  { flow_date: '2026-01-30', amount_eur: 869.80, direction: 'from_portfolio', notes: 'Silver sale payout to bank, order 100314040.' },
].map((f) => ({ ...f, year: Number(f.flow_date.slice(0, 4)), platform: 'Holland Gold', source: 'holland_gold_invoices_2025_2026' }))

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

  const gold = investments.find((i) => i.id === GOLD_INV_ID)
  const goldMetrics = computeInvestmentMetrics(gold, transactions, fxRates)
  const silverGr = investments.find((i) => i.id === SILVER_GR_INV_ID)
  const silverGrMetrics = computeInvestmentMetrics(silverGr, transactions, fxRates)
  const silverHg = investments.find((i) => i.name === 'Silver (Holland Gold)')
  const silverHgMetrics = silverHg ? computeInvestmentMetrics(silverHg, transactions, fxRates) : null

  return { summary, goldMetrics, silverGrMetrics, silverHgMetrics, liveTotalValueEur }
}

console.log(APPLY ? 'MODE: APPLY' : 'MODE: DRY-RUN (pass --apply --confirm to write)')

console.log('\n=== BEFORE: bulk rows ===')
const { data: goldBulk } = await supabase.from('transactions').select('*').eq('id', GOLD_BULK_ID).single()
const { data: silverBulk } = await supabase.from('transactions').select('*').eq('id', SILVER_BULK_ID).single()
console.log('gold bulk:', JSON.stringify(goldBulk))
console.log('silver bulk:', JSON.stringify(silverBulk))
if (!goldBulk || Math.abs(goldBulk.quantity - 0.512274) > 1e-6) { console.error('ABORT: gold bulk row mismatch.'); process.exit(1) }
if (!silverBulk || Math.abs(silverBulk.quantity - 6.030607) > 1e-6) { console.error('ABORT: silver bulk row mismatch.'); process.exit(1) }

console.log('\n=== BEFORE: granular rows ===')
const { data: goldGranular } = await supabase.from('transactions').select('*').eq('id', GOLD_GRANULAR_ID).single()
const { data: silverGranular } = await supabase.from('transactions').select('*').eq('id', SILVER_GRANULAR_ID).single()
console.log('gold granular:', JSON.stringify(goldGranular))
console.log('silver granular:', JSON.stringify(silverGranular))
if (!goldGranular || Math.abs(goldGranular.quantity - 0.134422) > 1e-6) { console.error('ABORT: gold granular row mismatch.'); process.exit(1) }
if (!silverGranular || Math.abs(silverGranular.quantity - 6.171046) > 1e-6) { console.error('ABORT: silver granular row mismatch.'); process.exit(1) }

console.log('\n=== BEFORE: check no existing "Silver (Holland Gold)" investment ===')
const { data: dupCheck } = await supabase.from('investments').select('id,name').eq('user_id', USER_ID).ilike('name', '%holland gold%')
console.log(dupCheck)
if (dupCheck.some((i) => i.name === 'Silver (Holland Gold)')) { console.error('ABORT: Silver (Holland Gold) already exists.'); process.exit(1) }

console.log('\n=== BEFORE: capital_flow_entries for GoldRepublic + Holland Gold ===')
const { data: currentCfe } = await supabase.from('capital_flow_entries').select('*').eq('user_id', USER_ID).in('platform', ['GoldRepublic', 'Holland Gold']).order('flow_date')
console.log(`Found ${currentCfe.length} rows.`)
const cfeToPortfolioSum = currentCfe.filter((r) => r.direction === 'to_portfolio').reduce((s, r) => s + Number(r.amount_eur), 0)
const cfeFromPortfolioSum = currentCfe.filter((r) => r.direction === 'from_portfolio').reduce((s, r) => s + Number(r.amount_eur), 0)
console.log('Sum to_portfolio:', cfeToPortfolioSum.toFixed(2), '(expect 1200+1375+1675+150=4400.00)')
console.log('Sum from_portfolio:', cfeFromPortfolioSum.toFixed(2), '(expect 753.46+1619.80=2373.26)')

console.log('\n=== BEFORE: Year Analysis 2026 + metals metrics (real domain code) ===')
const before2026 = await runYearAnalysis(2026)
const before2025 = await runYearAnalysis(2025)
console.log('2026 summary:', JSON.stringify(before2026.summary, null, 2))
console.log('2025 realizedPLInYearEur:', before2025.summary.realizedPLInYearEur)
console.log('gold metrics:', JSON.stringify(before2026.goldMetrics))
console.log('silver GR metrics:', JSON.stringify(before2026.silverGrMetrics))

// ---- planned new capital_flow_entries total check ----
const NEW_CFE = [...GR_2025_DEPOSITS, ...GR_OTHER_CFE, ...HG_CFE]
const newTo = NEW_CFE.filter((f) => f.direction === 'to_portfolio').reduce((s, f) => s + f.amount_eur, 0)
const newFrom = NEW_CFE.filter((f) => f.direction === 'from_portfolio').reduce((s, f) => s + f.amount_eur, 0)
console.log('\nPlanned new capital_flow_entries: to_portfolio', newTo.toFixed(2), 'from_portfolio', newFrom.toFixed(2))

const skippedStorageCosts2025 = [0.06, 0.15, 0.21, 0.30, 0.41, 0.52, 0.64, 0.79, 1.02, 1.04].reduce((a, b) => a + b, 0)
const skippedStorageCosts2026 = [0.86, 0.52, 0.77, 0.96, 0.90, 1.06, 1.39].reduce((a, b) => a + b, 0)
console.log('Storage costs SKIPPED (not recorded anywhere), 2025:', skippedStorageCosts2025.toFixed(2), '2026 (through Jul):', skippedStorageCosts2026.toFixed(2), 'total:', (skippedStorageCosts2025 + skippedStorageCosts2026).toFixed(2))

if (APPLY) {
  console.log('\n=== APPLYING ===')

  // 1. Delete bulk gold + silver rows
  await supabase.from('transactions').delete().eq('id', GOLD_BULK_ID)
  await supabase.from('transactions').delete().eq('id', SILVER_BULK_ID)
  console.log('deleted 2 fake bulk rows')

  // 2. Insert real GR gold + HG gold buys
  for (const t of [...GR_GOLD_2025, ...HG_GOLD]) {
    const { error } = await supabase.from('transactions').insert({ user_id: USER_ID, ...t })
    if (error) throw new Error(`insert gold ${t.date}: ${error.message}`)
  }
  console.log(`inserted ${GR_GOLD_2025.length + HG_GOLD.length} gold buys`)

  // 3. Fix granular gold row: fee, date
  const { error: goldFixErr } = await supabase.from('transactions').update({ fee: 4.21, date: '2026-05-27' }).eq('id', GOLD_GRANULAR_ID)
  if (goldFixErr) throw new Error(goldFixErr.message)
  console.log('fixed granular gold row (fee 4.21, date 2026-05-27)')

  // 4. Insert real GR silver buys + sell + Feb2026 buy
  for (const t of [...GR_SILVER_2025, ...GR_SILVER_SELL, ...GR_SILVER_FEB2026]) {
    const { error } = await supabase.from('transactions').insert({ user_id: USER_ID, ...t })
    if (error) throw new Error(`insert silver ${t.date}: ${error.message}`)
  }
  console.log(`inserted ${GR_SILVER_2025.length + GR_SILVER_SELL.length + GR_SILVER_FEB2026.length} GR silver transactions`)

  // 5. Fix granular silver row: fee
  const { error: silverFixErr } = await supabase.from('transactions').update({ fee: 5.10 }).eq('id', SILVER_GRANULAR_ID)
  if (silverFixErr) throw new Error(silverFixErr.message)
  console.log('fixed granular silver row (fee 5.10)')

  // 6. Create new "Silver (Holland Gold)" investment
  const { data: newInv, error: newInvErr } = await supabase
    .from('investments')
    .insert({
      user_id: USER_ID,
      name: 'Silver (Holland Gold)',
      ticker: null,
      type: 'commodity',
      platform: 'Holland Gold',
      currency: 'EUR',
      current_price: null,
      current_value: null,
      notes: 'Closed position — Holland Gold silver, fully sold January 2026. Kept separate from Silver (GR) to keep Gold Republic silver clean.',
      commodity_kind: 'silver',
      quantity_unit: 'troy_ounce',
    })
    .select()
    .single()
  if (newInvErr) throw new Error(newInvErr.message)
  console.log('created Silver (Holland Gold) ->', newInv.id)

  const hgSilverTxs = [...HG_SILVER_BUYS_RAW, ...HG_SILVER_SELLS_RAW].map((t) =>
    eurRow(newInv.id, t.date, t.type, t.vol, t.txval, t.fee, `Restored from Holland Gold invoices (${t.type}).`)
  )
  for (const t of hgSilverTxs) {
    const { error } = await supabase.from('transactions').insert({ user_id: USER_ID, ...t })
    if (error) throw new Error(`insert HG silver ${t.date}: ${error.message}`)
  }
  console.log(`inserted ${hgSilverTxs.length} Holland Gold silver transactions`)

  // 7. Delete old bulk capital_flow_entries, insert real dated ones
  const oldCfeIds = currentCfe.map((r) => r.id)
  const { error: delCfeErr } = await supabase.from('capital_flow_entries').delete().in('id', oldCfeIds)
  if (delCfeErr) throw new Error(delCfeErr.message)
  console.log(`deleted ${oldCfeIds.length} old capital_flow_entries`)

  for (const f of NEW_CFE) {
    const { error } = await supabase.from('capital_flow_entries').insert({ user_id: USER_ID, ...f })
    if (error) throw new Error(`insert cfe ${f.flow_date}: ${error.message}`)
  }
  console.log(`inserted ${NEW_CFE.length} real dated capital_flow_entries`)

  // ---- verify ----
  console.log('\n=== AFTER: Year Analysis + metals metrics (real domain code) ===')
  const after2026 = await runYearAnalysis(2026)
  const after2025 = await runYearAnalysis(2025)
  console.log('gold metrics:', JSON.stringify(after2026.goldMetrics))
  console.log('silver GR metrics:', JSON.stringify(after2026.silverGrMetrics))
  console.log('silver HG (Holland Gold) metrics:', JSON.stringify(after2026.silverHgMetrics))

  console.log('\n=== Comparison ===')
  console.log('Gold quantity        before:', before2026.goldMetrics.quantity, ' after:', after2026.goldMetrics.quantity)
  console.log('GR Silver quantity   before:', before2026.silverGrMetrics.quantity, ' after:', after2026.silverGrMetrics.quantity)
  console.log('HG Silver quantity   after:', after2026.silverHgMetrics?.quantity, '(expect 0)')
  console.log('Realized P/L 2025    before:', before2025.summary.realizedPLInYearEur, ' after:', after2025.summary.realizedPLInYearEur, ' delta:', (after2025.summary.realizedPLInYearEur - before2025.summary.realizedPLInYearEur).toFixed(2))
  console.log('Realized P/L 2026    before:', before2026.summary.realizedPLInYearEur, ' after:', after2026.summary.realizedPLInYearEur, ' delta:', (after2026.summary.realizedPLInYearEur - before2026.summary.realizedPLInYearEur).toFixed(2))
  console.log('netContributionsEur  before:', before2026.summary.netContributionsEur, ' after:', after2026.summary.netContributionsEur)
  console.log('growthExcludingContributionsEur before:', before2026.summary.growthExcludingContributionsEur, ' after:', after2026.summary.growthExcludingContributionsEur)
  console.log('modifiedDietzReturnPercent before:', before2026.summary.modifiedDietzReturnPercent, ' after:', after2026.summary.modifiedDietzReturnPercent)
  console.log('liveTotalValueEur    before:', before2026.liveTotalValueEur, ' after:', after2026.liveTotalValueEur)

  console.log('\n=== is_contribution check ===')
  const { data: allMetalTxs } = await supabase.from('transactions').select('is_contribution, investment_id').in('investment_id', [GOLD_INV_ID, SILVER_GR_INV_ID, newInv.id])
  console.log('rows with is_contribution=true (expect 0):', allMetalTxs.filter((t) => t.is_contribution === true).length)
} else {
  console.log('\n(dry-run only, no writes performed)')
}
