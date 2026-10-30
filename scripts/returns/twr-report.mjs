// Time-weighted return report — READ-ONLY.
//
// Reconstructs daily values from the account's records, Yahoo closes and ECB
// FX, anchors them on official statement values, and prints TWR (YTD, 1Y,
// all-time), Modified Dietz, XIRR, the contribution reconciliation and the
// open/closed position overview. Never writes to the database.
//
// Usage:
//   node --import ./scripts/test-register.mjs scripts/returns/twr-report.mjs \
//     --input=<frozen.json> [--official=<official.json>] [--proposed=<flows.json>] [--labels=<labels.json>] \
//     [--end=YYYY-MM-DD] [--out=<report.json>]
// official.json: same format as the valuation dry-run (statement date → positions/cash).
// proposed.json: [{ "id", "date", "platform", "amountEur", "kind", "label" }] — flows the owner
//   described but that are NOT in the database (results using them are never 'confirmed').
// labels.json:   { "<capital flow id>": "reused_sale_proceeds" | ... } — owner-reviewed kinds.

import { readFileSync, writeFileSync } from 'node:fs'
import { buildExternalCashFlowRows } from '@/lib/domain/contributions.ts'
import { classifyReturnFlows, summarizeContributions } from '@/lib/domain/flow-classification.ts'
import { buildTwrLedger, addDays } from '@/lib/domain/twr-ledger.ts'
import { computeTwr } from '@/lib/domain/twr.ts'
import { modifiedDietz, allTimeMoneyWeightedReturn } from '@/lib/domain/returns.ts'
import { buildPositionOverview } from '@/lib/domain/position-overview.ts'
import { fetchPriceHistory, fetchEcbFxHistory } from '@/lib/market/history.ts'
import { hasUnits } from '@/lib/domain/constants.ts'

const args = Object.fromEntries(process.argv.slice(2).map((a) => { const [k, v] = a.replace(/^--/, '').split('='); return [k, v ?? true] }))
if (args.apply) { console.error('REFUSED: read-only report.'); process.exit(2) }
if (!args.input) { console.error('--input=<frozen.json> is required'); process.exit(1) }

const num = (o, ks) => { for (const k of ks) if (o[k] != null) o[k] = Number(o[k]); return o }
const acct = JSON.parse(readFileSync(args.input, 'utf8'))
const investments = acct.investments.map((i) => num({ ...i }, ['current_price', 'current_value']))
const transactions = acct.transactions.map((t) => num({ ...t }, ['quantity', 'price_per_unit', 'amount', 'fee', 'fx_rate_to_eur']))
const capitalFlows = acct.capitalFlowEntries.map((f) => ({ ...f, amount_eur: Number(f.amount_eur) }))
const fxRates = { EUR: 1 }
for (const r of acct.fxRates ?? []) fxRates[r.currency] = Number(r.eur_per_unit)
const endDate = args.end ?? acct.frozenAt.slice(0, 10)
const officialFile = args.official ? JSON.parse(readFileSync(args.official, 'utf8')) : {}
const proposed = args.proposed ? JSON.parse(readFileSync(args.proposed, 'utf8')) : []
const labels = args.labels ? JSON.parse(readFileSync(args.labels, 'utf8')) : {}

const ext = buildExternalCashFlowRows(capitalFlows, transactions, fxRates)
const flows = classifyReturnFlows({ externalRows: [...ext.rows, ...ext.fxMissingRows], transactions, investments, fxRates, labels, proposed })

const firstTx = transactions.map((t) => t.date).sort()[0]
const inception = addDays([firstTx, ...flows.map((f) => f.date)].sort()[0], -1)
const tickers = investments.filter((i) => hasUnits(i.type) && i.ticker).map((i) => i.ticker.trim())
const histFrom = addDays(inception, -20)
const { prices, errors } = await fetchPriceHistory(tickers, histFrom)
const currencies = [...new Set([...prices.values()].map((p) => p.currency))]
const fx = await fetchEcbFxHistory(currencies, histFrom, endDate)

function anchorFor(date) {
  const o = officialFile[date]
  if (!o) return undefined
  const positions = (o.positions ?? []).flatMap((p) => {
    const inv = investments.find((i) => i.platform === p.platform && i.name === p.name)
    return inv ? [{ investmentId: inv.id, valueEur: p.valueEur, quantity: p.quantity ?? null, source: p.source }] : []
  })
  return { date, positions, cash: o.cash ?? [] }
}
const anchorDate = Object.keys(officialFile).sort().pop()
const anchor = anchorDate ? anchorFor(anchorDate) : undefined

// The app's own live quotes (current_price, per unit), for the end date only.
const liveQuotes = new Map(investments.filter((i) => i.current_price != null && i.price_last_updated_at)
  .map((i) => [i.id, { price: i.current_price, currency: i.currency ?? 'EUR', asOf: i.price_last_updated_at }]))
const year = endDate.slice(0, 4)
const periods = [
  { key: 'ytd', label: `YTD ${year}`, start: `${Number(year) - 1}-12-31` },
  { key: '1y', label: '1 jaar', start: addDays(endDate, -365) },
  { key: 'all', label: 'Sinds start', start: inception },
]
const extFlows = flows.map((f) => ({ date: f.date, amountEur: f.amountEur }))
const report = { generatedAt: new Date().toISOString(), endDate, priceErrors: errors, anchor: anchorDate ?? null, periods: {} }
const pct = (x) => (x == null || !Number.isFinite(x) ? '—' : `${x >= 0 ? '+' : ''}${(x * 100).toFixed(2)}%`)
const eur = (x) => (x == null || !Number.isFinite(x) ? '—' : `€${x.toFixed(2)}`)

for (const p of periods) {
  const ledger = buildTwrLedger({ investments, transactions, flows, prices, fx, fxRates, startDate: p.start, endDate, anchor, liveQuotes })
  const twr = computeTwr(ledger.input, { allowTruncation: true })
  const inPeriod = extFlows.filter((f) => f.date > p.start && f.date <= twr.endDate)
  const md = twr.startValueEur != null && twr.endValueEur != null
    ? modifiedDietz(twr.startValueEur, twr.endValueEur, inPeriod, p.start, twr.endDate) : null
  const overview = buildPositionOverview({ investments, transactions, ledger, twr, prices, fxRates, periodStart: p.start, periodEnd: endDate })
  report.periods[p.key] = { label: p.label, twr, md, notes: ledger.notes, qualityIssues: ledger.qualityIssues, anchorFactors: ledger.anchorFactors, overview,
    contributions: summarizeContributions(flows, addDays(p.start, 1), twr.endDate) }

  console.log(`\n=== ${p.label}: ${p.start} → ${twr.endDate}${twr.truncated ? ` (afgekapt; gevraagd ${twr.requestedEndDate})` : ''}`)
  console.log(`TWR ${pct(twr.twr)} [${twr.quality}] | begin ${eur(twr.startValueEur)} eind ${eur(twr.endValueEur)} | in ${eur(twr.externalInEur)} uit ${eur(twr.externalOutEur)} | winst ${eur(twr.gainEur)}`)
  console.log(`Modified Dietz ${md ? pct(md.returnPercent / 100) : '—'} (schatting) | deelperioden ${twr.subPeriods.length}`)
  if (twr.status === 'ok') {
    console.log(`Som bijdragen ${pct(twr.sumOfContributions)} = TWR ${pct(twr.twr)} | rest ${(twr.residual * 100).toExponential(2)} pp | ${twr.reconciled ? 'sluit aan' : 'SLUIT NIET AAN'}`)
    console.log('Per component:', Object.fromEntries(Object.entries(twr.byComponent).map(([k, v]) => [k, pct(v)])))
  }
  for (const m of twr.missing.slice(0, 5)) console.log('  ontbreekt:', m.date, m.sleeve.slice(0, 20), m.reason)
  for (const q of ledger.qualityIssues) console.log(`  estimated-oorzaak [${q.kind}] vanaf ${q.from}: ${q.detail}`)
  for (const n of ledger.notes) console.log('  noot:', n)
}
const allEnd = report.periods.all.twr.endDate
const xirr = allTimeMoneyWeightedReturn(extFlows.filter((f) => f.date <= allEnd), report.periods.all.twr.endValueEur ?? NaN, allEnd)
report.xirr = xirr
console.log(`\nXIRR (geannualiseerd, geldgewogen): ${xirr.annualRate == null ? xirr.unavailableReason ?? '—' : pct(xirr.annualRate)}`)
if (args.out) { writeFileSync(args.out, JSON.stringify(report, null, 2)); console.log('rapport:', args.out) }
