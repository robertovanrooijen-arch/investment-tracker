// Source-backed 2025-12-31 per-investment snapshots — approved plan, applied 2026-07-27.
//
// Inserts one investment_snapshots row per investment (19 total) for
// date=2025-12-31, using official platform year-end source documents
// (DEGIRO Jaaropgave 2025 portfolio overview, Gold Republic / Holland Gold
// bullion statements, Bitvavo balance, Trade Republic account-opened-2026
// fact). value_eur is the only field these come from an external source for;
// remaining_cost_basis_eur / realized_profit_eur are derived by replaying
// this investment's REAL transactions (date <= 2025-12-31) through the
// app's own computeInvestmentMetrics average-cost-basis logic — same
// methodology used everywhere else in the app, just cut off at year-end
// instead of "today". unrealized_profit_eur = value_eur - remainingCostBasis
// (cash: remainingCostBasis = value_eur, realized/unrealized = 0 — cash has
// no P&L concept here). current_price_native is left null throughout: we
// were not given a source-confirmed per-unit native price for this date,
// and backing one out via today's FX rate would be an invented number.
//
// Sum of all 19 value_eur MUST equal the source-corrected whole-portfolio
// 2025-12-31 snapshot total (7263.20) — checked before any write.
//
// Usage: node --import ./alias-loader.mjs scripts/backfill-2025-12-31-investment-snapshots.mjs --user-id=<uuid> [--apply --confirm]

import { createClient } from '@supabase/supabase-js'
import { readFileSync } from 'node:fs'
import { computeInvestmentMetrics } from '@/lib/domain/calculations.ts'

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
    'Usage: node --import ./alias-loader.mjs scripts/backfill-2025-12-31-investment-snapshots.mjs --user-id=<uuid> [--apply --confirm]'
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

const SNAPSHOT_DATE = '2025-12-31'
const SNAPSHOT_SOURCE = 'source_backed_2025_12_31_year_end'

// name -> { value_eur, quantity }. Matched to investment ids at runtime by
// (platform, name) to avoid hardcoding ids that could silently drift.
const OFFICIAL = [
  { platform: 'DEGIRO', name: 'MSCI WORLD', value_eur: 1338.36, quantity: 12 },
  { platform: 'DEGIRO', name: 'S&P500', value_eur: 999.57, quantity: 9 },
  { platform: 'DEGIRO', name: 'Meta Platforms', value_eur: 1124.0, quantity: 2 },
  { platform: 'DEGIRO', name: 'Vrij ruimte DEGIRO', value_eur: 90.38, quantity: null },
  { platform: 'DEGIRO', name: 'Nasdaq 100', value_eur: 0, quantity: 0 },
  { platform: 'DEGIRO', name: 'Solid Power', value_eur: 0, quantity: 0 },
  { platform: 'DEGIRO', name: 'Soundhound', value_eur: 0, quantity: 0 },
  { platform: 'DEGIRO', name: 'Take Two', value_eur: 0, quantity: 0 },
  { platform: 'DEGIRO', name: 'Tesla', value_eur: 0, quantity: 0 },
  { platform: 'DEGIRO', name: 'Trump Media', value_eur: 0, quantity: 0 },
  { platform: 'Gold Republic', name: 'Gold (Holland Gold + Gold Republic)', value_eur: 1810.52, quantity: 0.492434 },
  { platform: 'Gold Republic', name: 'Silver (GR)', value_eur: 0, quantity: 0 },
  { platform: 'Holland Gold', name: 'Silver (Holland Gold)', value_eur: 1157.08, quantity: 18.921881 },
  { platform: 'Bitvavo', name: 'Bitcoin', value_eur: 743.29, quantity: null },
  { platform: 'Trade Republic', name: 'Apple', value_eur: 0, quantity: 0 },
  { platform: 'Trade Republic', name: 'Asml', value_eur: 0, quantity: 0 },
  { platform: 'Trade Republic', name: 'D wave quantum', value_eur: 0, quantity: 0 },
  { platform: 'Trade Republic', name: 'MSCI World', value_eur: 0, quantity: 0 },
  { platform: 'Trade Republic', name: 'Nasdaq 100', value_eur: 0, quantity: 0 },
]

const expectedTotal = OFFICIAL.reduce((s, r) => s + r.value_eur, 0)
console.log('Sum of OFFICIAL values_eur:', expectedTotal.toFixed(2), '(expect 7263.20)')
if (Math.abs(expectedTotal - 7263.2) > 0.005) {
  console.error('ABORT: OFFICIAL values do not sum to 7263.20 — stopping.')
  process.exit(1)
}

console.log(APPLY ? 'MODE: APPLY' : 'MODE: DRY-RUN (pass --apply --confirm to write)')

const { data: investments, error: invErr } = await supabase.from('investments').select('*').eq('user_id', USER_ID)
if (invErr) throw new Error(invErr.message)
console.log(`\nInvestments for user: ${investments.length} (expect 19)`)

const { data: transactions, error: txErr } = await supabase
  .from('transactions')
  .select('*')
  .in('investment_id', investments.map((i) => i.id))
if (txErr) throw new Error(txErr.message)

const { data: fxRows } = await supabase.from('fx_rates').select('currency, eur_per_unit')
const fxRates = { EUR: 1 }
for (const r of fxRows ?? []) fxRates[r.currency] = Number(r.eur_per_unit)

console.log('\n=== Matching OFFICIAL rows to investment ids ===')
const rows = []
for (const o of OFFICIAL) {
  const inv = investments.find((i) => i.platform === o.platform && i.name === o.name)
  if (!inv) {
    console.error(`ABORT: no investment found for platform=${o.platform} name="${o.name}"`)
    process.exit(1)
  }

  const txsUpToDate = transactions.filter((t) => t.investment_id === inv.id && t.date <= SNAPSHOT_DATE)

  let remainingCostBasisEur
  let realizedProfitEur
  if (inv.type === 'cash') {
    remainingCostBasisEur = o.value_eur
    realizedProfitEur = 0
  } else {
    const metrics = computeInvestmentMetrics(inv, txsUpToDate, fxRates)
    remainingCostBasisEur = metrics.remainingCostBasis
    realizedProfitEur = metrics.realizedProfit
  }
  const unrealizedProfitEur = inv.type === 'cash' ? 0 : o.value_eur - remainingCostBasisEur

  rows.push({
    user_id: USER_ID,
    investment_id: inv.id,
    date: SNAPSHOT_DATE,
    value_eur: o.value_eur,
    quantity: o.quantity,
    currency: inv.currency ?? 'EUR',
    current_price_native: null,
    remaining_cost_basis_eur: remainingCostBasisEur,
    realized_profit_eur: realizedProfitEur,
    unrealized_profit_eur: unrealizedProfitEur,
    snapshot_source: SNAPSHOT_SOURCE,
  })

  console.log(
    `${inv.platform.padEnd(16)} ${inv.name.padEnd(20)} value_eur=${o.value_eur.toFixed(2).padStart(9)} qty=${o.quantity ?? 'null'} costBasis=${remainingCostBasisEur.toFixed(2)} realized=${realizedProfitEur.toFixed(2)} unrealized=${unrealizedProfitEur.toFixed(2)}`
  )
}

console.log(`\nMatched ${rows.length} / ${investments.length} investments (must be all 19, 1:1)`)
if (rows.length !== investments.length) {
  console.error('ABORT: row count does not match investment count — an investment was missed or double-matched.')
  process.exit(1)
}

const rowsSum = rows.reduce((s, r) => s + r.value_eur, 0)
console.log('Sum of matched rows value_eur:', rowsSum.toFixed(2), '(expect 7263.20)')

console.log('\n=== Confirm no existing 2025-12-31 investment_snapshots rows ===')
const { data: existing, error: existErr } = await supabase
  .from('investment_snapshots')
  .select('investment_id')
  .eq('user_id', USER_ID)
  .eq('date', SNAPSHOT_DATE)
if (existErr) throw new Error(existErr.message)
console.log('Existing rows for this date:', existing.length, '(expect 0)')
if (existing.length > 0 && !APPLY) {
  console.log('(would need to decide overwrite vs skip before applying)')
}

if (APPLY) {
  if (existing.length > 0) {
    console.error('ABORT: rows already exist for this date — not overwriting automatically.')
    process.exit(1)
  }
  console.log('\n=== APPLYING: inserting 19 rows ===')
  const { error: insErr } = await supabase.from('investment_snapshots').insert(rows)
  if (insErr) throw new Error(insErr.message)

  const { data: after, error: afterErr } = await supabase
    .from('investment_snapshots')
    .select('*')
    .eq('user_id', USER_ID)
    .eq('date', SNAPSHOT_DATE)
  if (afterErr) throw new Error(afterErr.message)
  const afterSum = after.reduce((s, r) => s + Number(r.value_eur), 0)
  console.log(`\n=== AFTER: ${after.length} rows inserted, sum=${afterSum.toFixed(2)} (expect 7263.20) ===`)
  if (Math.abs(afterSum - 7263.2) > 0.005) {
    console.error('WARNING: inserted sum does not match 7263.20 — investigate before trusting this data.')
  }
} else {
  console.log('\n(dry-run only, no writes performed)')
}
