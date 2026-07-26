#!/usr/bin/env node
// ---------------------------------------------------------------------------
// Dry-run (and, with --apply --confirm, real) correction of portfolio_snapshots
// P/L fields under the cash-exclusion fix in
// lib/domain/calculations.ts:computePortfolioMetrics().
//
// Background: computePortfolioMetrics() used to sum unrealized/realized P/L
// across ALL investments, including cash-like ones (uninvested broker cash /
// "free space" balances with no cost basis) — so a cash balance with no
// matching deposit/withdraw transaction read as pure "unrealized profit".
// That was fixed to exclude cash-like holdings from P/L (they still count
// toward portfolio value). Snapshot rows written by the OLD aggregation still
// have the inflated numbers baked in.
//
// Method: for each portfolio_snapshots row, sum that SAME DATE's
// investment_snapshots rows (which were always computed correctly at the
// per-investment level, bug or no bug) two ways — with and without cash-like
// investments — and compare both reconstructions against the stored
// total_realized_eur/total_unrealized_eur:
//   - matches the cash-INCLUSIVE sum  -> written by the old aggregation,
//     propose subtracting cash's own recorded contribution for that exact
//     date (never today's price/value) -> exact correction.
//   - matches the cash-EXCLUSIVE sum  -> already written under the fixed
//     definition -> no change needed.
//   - matches neither, or no investment_snapshots exist for that date at all
//     (e.g. manually-imported historical rows that predate per-investment
//     tracking) -> cannot verify -> NOT proposed for update.
//
// Never touches total_value_eur, total_invested_eur, total_ever_invested_eur,
// snapshot_source, or any other table (transactions, capital_flow_entries,
// investments). portfolio_snapshots has no separate id column — its natural
// key is (user_id, date).
//
// Usage:
//   node scripts/backfill-snapshot-pl-dry-run.mjs --user-id=<uuid>
//   node scripts/backfill-snapshot-pl-dry-run.mjs --user-id=<uuid> --apply --confirm
//
// --user-id is required and scopes every query — this never operates across
// more than one user in a single run, to preserve per-user ownership even
// though the service-role key bypasses RLS.
//
// Requires .env.local with NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY.
// ---------------------------------------------------------------------------

import { readFileSync } from 'node:fs'
import { createClient } from '@supabase/supabase-js'

// Mirrors lib/domain/constants.ts:isCashLikeInvestment() exactly.
// Keep this in sync if that function ever changes.
function isCashLikeInvestment(investment) {
  if (investment.type === 'cash') return true
  return /vrije?\s*ruimte|free\s*cash|cash\s*balance/i.test(investment.name)
}

const TOLERANCE_EUR = 0.05

function loadEnv() {
  const env = Object.fromEntries(
    readFileSync('.env.local', 'utf8')
      .split('\n')
      .filter((l) => l.includes('=') && !l.startsWith('#'))
      .map((l) => {
        const i = l.indexOf('=')
        return [l.slice(0, i).trim(), l.slice(i + 1).trim()]
      })
  )
  if (!env.NEXT_PUBLIC_SUPABASE_URL || !env.SUPABASE_SERVICE_ROLE_KEY) {
    throw new Error('.env.local is missing NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY')
  }
  return env
}

function parseArgs(argv) {
  const args = { apply: false, confirm: false, userId: null }
  for (const a of argv) {
    if (a === '--apply') args.apply = true
    else if (a === '--confirm') args.confirm = true
    else if (a.startsWith('--user-id=')) args.userId = a.slice('--user-id='.length)
  }
  return args
}

function fmt(n) {
  return n === null ? '—' : n.toFixed(2)
}

async function main() {
  const args = parseArgs(process.argv.slice(2))
  if (!args.userId) {
    console.error('Usage: node scripts/backfill-snapshot-pl-dry-run.mjs --user-id=<uuid> [--apply --confirm]')
    process.exit(1)
  }

  const env = loadEnv()
  const supabase = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY)

  const [{ data: snapshots, error: snapErr }, { data: invSnapshots, error: isnapErr }, { data: investments, error: invErr }] =
    await Promise.all([
      supabase.from('portfolio_snapshots').select('*').eq('user_id', args.userId).order('date'),
      supabase.from('investment_snapshots').select('*').eq('user_id', args.userId).order('date'),
      supabase.from('investments').select('id, name, type, created_at').eq('user_id', args.userId),
    ])

  if (snapErr || isnapErr || invErr) {
    console.error('Query failed:', snapErr ?? isnapErr ?? invErr)
    process.exit(1)
  }
  if (!snapshots || snapshots.length === 0) {
    console.log('No portfolio_snapshots found for this user_id. Nothing to do.')
    return
  }

  const cashInvestments = (investments ?? []).filter(isCashLikeInvestment)
  const cashIds = new Set(cashInvestments.map((c) => c.id))

  const invSnapsByDate = new Map()
  for (const s of invSnapshots ?? []) {
    if (!invSnapsByDate.has(s.date)) invSnapsByDate.set(s.date, [])
    invSnapsByDate.get(s.date).push(s)
  }

  const rows = []
  for (const snap of snapshots) {
    const dayRows = invSnapsByDate.get(snap.date) ?? []
    let allRealized = 0
    let allUnrealized = 0
    let cashRealized = 0
    let cashUnrealized = 0
    for (const r of dayRows) {
      const realized = Number(r.realized_profit_eur)
      const unrealized = Number(r.unrealized_profit_eur)
      allRealized += realized
      allUnrealized += unrealized
      if (cashIds.has(r.investment_id)) {
        cashRealized += realized
        cashUnrealized += unrealized
      }
    }

    const oldRealized = Number(snap.total_realized_eur)
    const oldUnrealized = Number(snap.total_unrealized_eur)
    const cashExistedByThisDate = cashInvestments.some(
      (c) => new Date(c.created_at) <= new Date(`${snap.date}T23:59:59Z`)
    )

    let classification
    let exact
    let correctedRealized
    let correctedUnrealized
    let reason

    if (dayRows.length === 0) {
      classification = 'NO_BREAKDOWN_DATA'
      exact = false
      correctedRealized = null
      correctedUnrealized = null
      reason =
        'No investment_snapshots exist for this date — likely a manually-imported historical row that predates per-investment tracking. Cannot verify or correct.'
    } else if (!cashExistedByThisDate) {
      classification = 'NO_CASH_YET'
      exact = true
      correctedRealized = oldRealized
      correctedUnrealized = oldUnrealized
      reason = 'No cash-like investment existed yet on this date — nothing to correct.'
    } else {
      const matchesOldRegime =
        Math.abs(oldRealized - allRealized) <= TOLERANCE_EUR && Math.abs(oldUnrealized - allUnrealized) <= TOLERANCE_EUR
      const matchesNewRegime =
        Math.abs(oldRealized - (allRealized - cashRealized)) <= TOLERANCE_EUR &&
        Math.abs(oldUnrealized - (allUnrealized - cashUnrealized)) <= TOLERANCE_EUR
      const cashContributed = Math.abs(cashRealized) > TOLERANCE_EUR || Math.abs(cashUnrealized) > TOLERANCE_EUR

      if (matchesOldRegime && cashContributed) {
        classification = 'PRE_FIX_NEEDS_CORRECTION'
        exact = true
        correctedRealized = oldRealized - cashRealized
        correctedUnrealized = oldUnrealized - cashUnrealized
        reason =
          'Stored total matches the sum of ALL investment_snapshots (cash included) for this date — written by the pre-fix aggregation. Corrected by subtracting cash-like holdings\' own recorded contribution for this exact date (not today\'s value).'
      } else if (matchesOldRegime) {
        classification = 'MATCHES_BUT_NO_CASH_CONTRIBUTION'
        exact = true
        correctedRealized = oldRealized
        correctedUnrealized = oldUnrealized
        reason = 'Matches the full breakdown sum, but cash-like holdings contributed ~€0 on this date — no correction needed.'
      } else if (matchesNewRegime) {
        classification = 'ALREADY_CORRECT'
        exact = true
        correctedRealized = oldRealized
        correctedUnrealized = oldUnrealized
        reason = 'Stored total already matches the non-cash sum for this date — already written under the cash-excluded definition. No change needed.'
      } else {
        classification = 'UNVERIFIABLE'
        exact = false
        correctedRealized = null
        correctedUnrealized = null
        reason = `Stored total doesn't cleanly match either the cash-inclusive (€${allRealized.toFixed(2)}/€${allUnrealized.toFixed(2)}) or cash-exclusive (€${(allRealized - cashRealized).toFixed(2)}/€${(allUnrealized - cashUnrealized).toFixed(2)}) reconstruction. Needs manual review before any correction.`
      }
    }

    const oldTotalPL = oldRealized + oldUnrealized
    const correctedTotalPL =
      correctedRealized !== null && correctedUnrealized !== null ? correctedRealized + correctedUnrealized : null
    const difference = correctedTotalPL !== null ? oldTotalPL - correctedTotalPL : null

    rows.push({
      date: snap.date,
      source: snap.snapshot_source,
      oldRealized,
      oldUnrealized,
      oldTotalPL,
      correctedRealized,
      correctedUnrealized,
      correctedTotalPL,
      difference,
      exact,
      classification,
      reason,
    })
  }

  // ---- Report ----
  console.log(`\nDry-run: portfolio_snapshots P/L backfill for user ${args.userId}`)
  console.log(`Snapshots inspected: ${rows.length}\n`)

  for (const r of rows) {
    console.log(
      `${r.date} | src=${r.source} | old real=${fmt(r.oldRealized)} unreal=${fmt(r.oldUnrealized)} total=${fmt(r.oldTotalPL)} | ` +
        `new real=${fmt(r.correctedRealized)} unreal=${fmt(r.correctedUnrealized)} total=${fmt(r.correctedTotalPL)} | ` +
        `diff=${fmt(r.difference)} | ${r.exact ? 'exact' : 'approximate'} | ${r.classification}`
    )
  }

  const needsCorrection = rows.filter((r) => r.classification === 'PRE_FIX_NEEDS_CORRECTION')
  const alreadyFine = rows.filter(
    (r) => r.classification === 'ALREADY_CORRECT' || r.classification === 'MATCHES_BUT_NO_CASH_CONTRIBUTION'
  )
  const noCashYet = rows.filter((r) => r.classification === 'NO_CASH_YET')
  const cannotVerify = rows.filter((r) => !r.exact)

  console.log('\n=== Summary ===')
  console.log(`Total snapshots inspected:               ${rows.length}`)
  console.log(`Needs correction (exact):                ${needsCorrection.length}`)
  console.log(`Already correct / no cash contribution:   ${alreadyFine.length}`)
  console.log(`No cash-like investment existed yet:      ${noCashYet.length}`)
  console.log(`Cannot verify (not proposed for update):  ${cannotVerify.length}`)

  if (needsCorrection.length > 0) {
    const amounts = [...new Set(needsCorrection.map((r) => r.difference.toFixed(2)))]
    console.log(
      `Cash P/L contribution removed per corrected row: €${needsCorrection[0].difference.toFixed(2)}` +
        (amounts.length > 1 ? ' (varies by row — see table above)' : ' (identical across every corrected row)')
    )
  }

  if (cannotVerify.length > 0) {
    console.log('\nRows requiring manual review (NOT proposed for update):')
    for (const r of cannotVerify) console.log(`  - ${r.date}: ${r.reason}`)
  }

  if (!args.apply) {
    console.log(
      '\nDry-run only — no rows were updated. Re-run with --apply --confirm to write corrections for PRE_FIX_NEEDS_CORRECTION rows only.'
    )
    return
  }

  if (!args.confirm) {
    console.error('\n--apply requires --confirm as well. Refusing to write without both flags.')
    process.exit(1)
  }

  console.log(`\nApplying corrections to ${needsCorrection.length} row(s)...`)
  for (const r of needsCorrection) {
    const { error } = await supabase
      .from('portfolio_snapshots')
      .update({ total_realized_eur: r.correctedRealized, total_unrealized_eur: r.correctedUnrealized })
      .eq('user_id', args.userId)
      .eq('date', r.date)
    if (error) {
      console.error(`FAILED to update ${r.date}:`, error.message)
    } else {
      console.log(`Updated ${r.date}: unrealized ${fmt(r.oldUnrealized)} -> ${fmt(r.correctedUnrealized)}`)
    }
  }
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
