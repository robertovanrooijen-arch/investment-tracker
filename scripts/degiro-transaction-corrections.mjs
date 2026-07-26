// DEGIRO transaction correction — approved plan, applied 2026-07-23.
// Usage: node scripts/degiro-transaction-corrections.mjs --user-id=<uuid> [--apply --confirm]
// Without --apply, only prints the current state of the target rows (safe to rerun anytime).
//
// Scope (see conversation for full derivation from DEGIRO CSV exports):
//   - Add Meta / Tesla / Trump Media (closed positions) with real buy+sell history.
//   - Replace fake 2026-05-05 VUSA/IWDA onboarding rows with real multi-lot history.
//   - Fix fee_currency (USD -> EUR) + fx_rate_to_eur precision on SoundHound/Solid Power/Take-Two.
// Does NOT touch capital_flow_entries, portfolio_snapshots, investment_snapshots, current prices.

import { createClient } from '@supabase/supabase-js'
import { readFileSync } from 'node:fs'

const args = Object.fromEntries(
  process.argv.slice(2).map((a) => {
    const [k, v] = a.replace(/^--/, '').split('=')
    return [k, v ?? true]
  })
)
const USER_ID = args['user-id']
const APPLY = args.apply === true && args.confirm === true
if (!USER_ID) {
  console.error('Usage: node scripts/degiro-transaction-corrections.mjs --user-id=<uuid> [--apply --confirm]')
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

// ---- Known investment IDs (DEGIRO, user 9c401c6a...) ----
const INV = {
  vusa: '3c8f7cd8-1a0f-4919-8526-84faba608d40',
  iwda: '54dcd480-6842-41f5-a5c1-978334f03a3c',
  soundhound: 'f1443db4-8115-40e5-9080-32d73f0de560',
  solidPower: 'd079c9e2-98b4-475c-b110-1a2f3b726b18',
  takeTwo: '2d5dc741-8ba5-4108-ab09-99ed61cd3057',
  nasdaq100: '5a604b13-67f7-4480-b3ea-e3d69dda7e57',
}

const DELETE_TX_IDS = {
  vusaFake: '06e29f5c-a41c-4641-9a74-766978f3356b',
  iwdaFake: '82a18385-0858-42c1-87b9-8fad3aa8ef73',
}

const UPDATE_TX = [
  { id: 'fdbb15d1-a323-4bd5-b953-205a09195e81', label: 'SoundHound buy', patch: { fee: 2, fee_currency: 'EUR', fx_rate_to_eur: 0.849942, amount: 348.22 } },
  { id: '1ba3f46b-97af-4da7-8114-ef93bdd5554f', label: 'SoundHound sell', patch: { fee: 2, fee_currency: 'EUR', fx_rate_to_eur: 0.851478, amount: 230.00 } },
  { id: '23107bef-0f5e-4f30-86b5-ec9c142f7d6a', label: 'Solid Power buy', patch: { fee: 2, fee_currency: 'EUR', fx_rate_to_eur: 0.844999, amount: 141.96 } },
  { id: '671c384b-a556-4a8c-b562-c3811cf6e611', label: 'Take-Two buy', patch: { fee: 2, fee_currency: 'EUR', fx_rate_to_eur: 0.858751, amount: 480.00 } },
]

const VUSA_INSERTS = [
  { date: '2024-08-19', type: 'buy', quantity: 1, price_per_unit: 95.628, fee: 1 },
  { date: '2024-09-19', type: 'buy', quantity: 1, price_per_unit: 97.172, fee: 1 },
  { date: '2024-10-15', type: 'buy', quantity: 1, price_per_unit: 101.80, fee: 1 },
  { date: '2024-10-24', type: 'buy', quantity: 3, price_per_unit: 102.00, fee: 3 },
  { date: '2025-01-10', type: 'buy', quantity: 3, price_per_unit: 108.00, fee: 1 },
].map((t) => ({ ...t, investment_id: INV.vusa, amount: round2(t.quantity * t.price_per_unit), price_currency: 'EUR', fee_currency: 'EUR', fx_rate_to_eur: 1, is_contribution: false, notes: 'Restored from real DEGIRO transaction export — replaces fake 2026-05-05 onboarding buy.' }))

const IWDA_INSERTS = [
  { date: '2024-09-03', type: 'buy', quantity: 1, price_per_unit: 94.50, fee: 1 },
  { date: '2024-12-10', type: 'buy', quantity: 2, price_per_unit: 105.715, fee: 1 },
  { date: '2025-01-27', type: 'buy', quantity: 3, price_per_unit: 105.515, fee: 1 },
  { date: '2025-03-27', type: 'buy', quantity: 8, price_per_unit: 99.40, fee: 1 },
  { date: '2025-06-23', type: 'buy', quantity: 8, price_per_unit: 98.80, fee: 1 },
  { date: '2025-09-25', type: 'sell', quantity: 10, price_per_unit: 107.00, fee: 1 },
].map((t) => ({ ...t, investment_id: INV.iwda, amount: round2(t.quantity * t.price_per_unit), price_currency: 'EUR', fee_currency: 'EUR', fx_rate_to_eur: 1, is_contribution: false, notes: 'Restored from real DEGIRO transaction export — replaces fake 2026-05-05 onboarding buy.' }))

function round2(n) { return Math.round(n * 100) / 100 }

const NEW_INVESTMENTS = [
  {
    key: 'meta',
    investment: { name: 'Meta Platforms', ticker: 'META', type: 'stock', platform: 'DEGIRO', currency: 'USD', current_price: null, current_value: null, notes: 'Closed position, reconstructed from real DEGIRO transaction export.', commodity_kind: null, quantity_unit: null },
    txs: [
      { date: '2025-11-04', type: 'buy', quantity: 2, price_per_unit: 635, fee: 2, fx_rate_to_eur: 0.873110 },
      { date: '2026-04-27', type: 'sell', quantity: 2, price_per_unit: 675, fee: 2, fx_rate_to_eur: 0.849089 },
    ],
  },
  {
    key: 'tesla',
    investment: { name: 'Tesla', ticker: 'TSLA', type: 'stock', platform: 'DEGIRO', currency: 'USD', current_price: null, current_value: null, notes: 'Closed position, reconstructed from real DEGIRO transaction export.', commodity_kind: null, quantity_unit: null },
    txs: [
      { date: '2025-03-10', type: 'buy', quantity: 3, price_per_unit: 252.25, fee: 2, fx_rate_to_eur: 0.924400 },
      { date: '2025-05-13', type: 'sell', quantity: 3, price_per_unit: 323.71, fee: 2, fx_rate_to_eur: 0.895349 },
    ],
  },
  {
    key: 'trumpMedia',
    investment: { name: 'Trump Media', ticker: 'DJT', type: 'stock', platform: 'DEGIRO', currency: 'USD', current_price: null, current_value: null, notes: 'Closed position, reconstructed from real DEGIRO transaction export.', commodity_kind: null, quantity_unit: null },
    txs: [
      { date: '2024-09-04', type: 'buy', quantity: 3, price_per_unit: 17.60, fee: 2, fx_rate_to_eur: 0.905682 },
      { date: '2024-10-18', type: 'sell', quantity: 3, price_per_unit: 30.06, fee: 2, fx_rate_to_eur: 0.918053 },
    ],
  },
].map((e) => ({
  ...e,
  txs: e.txs.map((t) => ({ ...t, amount: round2(t.quantity * t.price_per_unit), price_currency: 'USD', fee_currency: 'EUR', is_contribution: false, notes: 'Restored from real DEGIRO transaction export.' })),
}))

async function showCurrentState() {
  console.log('=== BEFORE: rows targeted for delete ===')
  for (const id of Object.values(DELETE_TX_IDS)) {
    const { data } = await supabase.from('transactions').select('*').eq('id', id).single()
    console.log(JSON.stringify(data))
  }
  console.log('\n=== BEFORE: rows targeted for update ===')
  for (const u of UPDATE_TX) {
    const { data } = await supabase.from('transactions').select('*').eq('id', u.id).single()
    console.log(u.label, JSON.stringify(data))
  }
}

async function apply() {
  console.log('\n=== APPLYING ===')

  // 1. New investments + their transactions
  for (const entry of NEW_INVESTMENTS) {
    const { data: invRow, error: invErr } = await supabase
      .from('investments')
      .insert({ user_id: USER_ID, ...entry.investment })
      .select()
      .single()
    if (invErr) throw new Error(`insert investment ${entry.key}: ${invErr.message}`)
    console.log(`inserted investment ${entry.key} ->`, invRow.id)

    for (const t of entry.txs) {
      const { error: txErr } = await supabase
        .from('transactions')
        .insert({ user_id: USER_ID, investment_id: invRow.id, ...t })
      if (txErr) throw new Error(`insert tx for ${entry.key} ${t.date}: ${txErr.message}`)
    }
    console.log(`  inserted ${entry.txs.length} transactions for ${entry.key}`)
  }

  // 2. Delete fake VUSA/IWDA rows
  for (const [label, id] of Object.entries(DELETE_TX_IDS)) {
    const { error } = await supabase.from('transactions').delete().eq('id', id)
    if (error) throw new Error(`delete ${label}: ${error.message}`)
    console.log(`deleted ${label} (${id})`)
  }

  // 3. Insert real VUSA/IWDA history
  for (const t of VUSA_INSERTS) {
    const { error } = await supabase.from('transactions').insert({ user_id: USER_ID, ...t })
    if (error) throw new Error(`insert VUSA ${t.date}: ${error.message}`)
  }
  console.log(`inserted ${VUSA_INSERTS.length} VUSA transactions`)
  for (const t of IWDA_INSERTS) {
    const { error } = await supabase.from('transactions').insert({ user_id: USER_ID, ...t })
    if (error) throw new Error(`insert IWDA ${t.date}: ${error.message}`)
  }
  console.log(`inserted ${IWDA_INSERTS.length} IWDA transactions`)

  // 4. Update fee/fx rows
  for (const u of UPDATE_TX) {
    const { error } = await supabase.from('transactions').update(u.patch).eq('id', u.id)
    if (error) throw new Error(`update ${u.label}: ${error.message}`)
    console.log(`updated ${u.label} (${u.id})`)
  }
}

async function verify() {
  console.log('\n=== AFTER: full re-verification ===')
  const { data: invs } = await supabase.from('investments').select('*').eq('user_id', USER_ID).eq('platform', 'DEGIRO')
  const invIds = invs.map((i) => i.id)
  const { data: txs } = await supabase.from('transactions').select('*').in('investment_id', invIds).order('date')

  function replay(name, investmentId) {
    const rows = txs.filter((t) => t.investment_id === investmentId && (t.type === 'buy' || t.type === 'sell')).sort((a, b) => a.date < b.date ? -1 : 1)
    let qty = 0, costEur = 0
    const realizedByYear = {}
    for (const t of rows) {
      const feeEur = t.fee_currency === 'EUR' ? t.fee : t.fee * (t.fx_rate_to_eur ?? 1)
      const grossEur = t.price_currency === 'EUR' ? t.quantity * t.price_per_unit : t.quantity * t.price_per_unit * (t.fx_rate_to_eur ?? 1)
      if (t.type === 'buy') {
        qty += t.quantity
        costEur += grossEur + feeEur
      } else {
        const sellQty = Math.min(t.quantity, qty)
        const avgCost = qty > 0 ? costEur / qty : 0
        const soldCost = avgCost * sellQty
        const proceedsEur = grossEur - feeEur
        const gain = proceedsEur - soldCost
        const year = t.date.slice(0, 4)
        realizedByYear[year] = (realizedByYear[year] || 0) + gain
        qty -= sellQty
        costEur -= soldCost
      }
    }
    return { name, qty: round2(qty), remainingCostBasis: round2(costEur), realizedByYear }
  }

  const results = []
  for (const inv of invs) {
    if (inv.type === 'cash') continue
    results.push(replay(inv.name, inv.id))
  }
  for (const r of results) console.log(JSON.stringify(r))

  const expectedQty = { Soundhound: 23, 'S&P500': 9, 'Nasdaq 100': 6, 'Take Two': 2, 'Solid Power': 39, 'MSCI WORLD': 12, 'Meta Platforms': 0, Tesla: 0, 'Trump Media': 0 }
  console.log('\n=== Quantity check ===')
  for (const r of results) {
    const exp = expectedQty[r.name]
    console.log(r.name, 'expected', exp, 'actual', r.qty, exp === r.qty ? 'OK' : 'MISMATCH')
  }

  console.log('\n=== Realized P/L by year (all DEGIRO stock/ETF positions) ===')
  const totalsByYear = {}
  for (const r of results) {
    for (const [year, val] of Object.entries(r.realizedByYear)) {
      totalsByYear[year] = (totalsByYear[year] || 0) + val
    }
  }
  for (const [year, val] of Object.entries(totalsByYear).sort()) {
    console.log(year, round2(val))
  }

  console.log('\n=== is_contribution check on all new/changed rows ===')
  const changedIds = [
    ...VUSA_INSERTS, ...IWDA_INSERTS,
  ]
  const { data: allNewTxs } = await supabase.from('transactions').select('is_contribution, investment_id, date, type').in('investment_id', invIds)
  const badContrib = allNewTxs.filter((t) => t.is_contribution === true)
  console.log('rows with is_contribution=true (should be empty):', badContrib.length)
}

console.log(APPLY ? 'MODE: APPLY' : 'MODE: DRY-RUN (pass --apply --confirm to write)')
await showCurrentState()
if (APPLY) {
  await apply()
  await verify()
} else {
  console.log('\n(dry-run only, no writes performed)')
}
