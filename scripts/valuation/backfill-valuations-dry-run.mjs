// Historical valuation backfill — DRY RUN ONLY.
//
// Reconstructs position and portfolio values on chosen dates from the
// account's transactions, raw historical closes (Yahoo chart, interval 1d,
// with split events) and historical ECB FX (Frankfurter). It NEVER writes to
// the database: it reads (GET only, or a local JSON export), computes, and
// writes a local JSON report with snapshot-row PROPOSALS and conflicts with
// existing snapshots. `--apply` is refused until the snapshot-quality
// migration (M7) exists and the report has been reviewed.
//
// Usage:
//   node --import ./scripts/test-register.mjs scripts/valuation/backfill-valuations-dry-run.mjs \
//     --user-id=<uuid> [--input=<frozen.json>] [--dates=2025-12-31,2024-12-31] [--monthly]
//     [--official=<official.json>] --out=<report.json>
// official.json: { "2025-12-31": { "positions": [{ "platform", "name", "valueEur", "quantity"?, "source" }],
//                                  "cash": [{ "platform", "amountEur", "source" }] } }
// Official statement values are LEADING; metals without one only get a labelled
// Yahoo/COMEX benchmark (never a portfolio value); derived cash is audit info only.
// Without --input the account is read with the service-role key from .env.local (GET only).

import { readFileSync, writeFileSync } from 'node:fs'
import {
  valuePortfolio,
  proposeSnapshotRows,
  findSnapshotConflicts,
} from '@/lib/valuation/historical-valuation.ts'
import { normalizeQuoteCurrency } from '@/lib/domain/price-update.ts'
import { hasUnits } from '@/lib/domain/constants.ts'
import { impliedPlatformCash } from '@/lib/domain/reconciliation.ts'

const args = Object.fromEntries(process.argv.slice(2).map((a) => { const [k, v] = a.replace(/^--/, '').split('='); return [k, v ?? true] }))
if (args.apply) {
  console.error('REFUSED: this tool is dry-run only. Apply requires migration M7, a reviewed report and an explicit, separate write step.')
  process.exit(2)
}
const userId = args['user-id']
if (!userId || !/^[0-9a-f-]{36}$/.test(userId)) { console.error('--user-id=<uuid> is required'); process.exit(1) }
if (!args.out) { console.error('--out=<report.json> is required'); process.exit(1) }

async function loadAccount() {
  if (args.input) return JSON.parse(readFileSync(args.input, 'utf8'))
  const env = Object.fromEntries(readFileSync('.env.local', 'utf8').split('\n').filter((l) => l.includes('=')).map((l) => { const i = l.indexOf('='); return [l.slice(0, i).trim(), l.slice(i + 1).trim()] }))
  const H = { apikey: env.SUPABASE_SERVICE_ROLE_KEY, Authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}` }
  const all = async (path) => { const o = []; for (let f = 0; ; f += 1000) { const r = await fetch(`${env.NEXT_PUBLIC_SUPABASE_URL}/rest/v1/${path}`, { headers: { ...H, Range: `${f}-${f + 999}` } }); if (!r.ok) throw new Error(`${path.split('?')[0]}: ${r.status}`); const j = await r.json(); o.push(...j); if (j.length < 1000) break } return o }
  const q = `user_id=eq.${userId}`
  return {
    investments: await all(`investments?select=*&${q}&order=id.asc`),
    transactions: await all(`transactions?select=*&${q}&order=id.asc`),
    investmentSnapshots: await all(`investment_snapshots?select=investment_id,date,value_eur,snapshot_source&${q}&order=date.asc,investment_id.asc`),
    capitalFlowEntries: await all(`capital_flow_entries?select=*&${q}&order=id.asc`),
  }
}

const num = (o, ks) => { for (const k of ks) if (o[k] != null) o[k] = Number(o[k]); return o }
const acct = await loadAccount()
const investments = acct.investments.map((i) => num({ ...i }, ['current_price', 'current_value']))
const transactions = acct.transactions.map((t) => num({ ...t }, ['quantity', 'price_per_unit', 'amount', 'fee', 'fx_rate_to_eur']))

// Valuation dates: given, or every 31 Dec from the first transaction's year
// up to last year (the close of 31 Dec = the value at the start of 1 Jan).
const firstYear = Number(transactions.map((t) => t.date).sort()[0].slice(0, 4))
const thisYear = new Date().getUTCFullYear()
let dates = args.dates ? String(args.dates).split(',') : Array.from({ length: thisYear - firstYear }, (_, i) => `${firstYear + i}-12-31`)
if (args.monthly) {
  const start = `${firstYear}-01-31`
  for (let d = new Date(`${start}T00:00:00Z`); d < new Date(); d = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 2, 0))) dates.push(d.toISOString().slice(0, 10))
}
dates = [...new Set(dates)].sort()
const fetchedAt = new Date().toISOString()
const minDate = new Date(Date.parse(`${dates[0]}T00:00:00Z`) - 20 * 86400000).toISOString().slice(0, 10)
const maxDate = dates[dates.length - 1]

// Raw closes + splits per ticker (public Yahoo chart endpoint, read-only).
const tickers = [...new Set(investments.filter((i) => hasUnits(i.type) && i.ticker).map((i) => i.ticker.trim()))]
const prices = new Map()
const priceErrors = {}
for (const ticker of tickers) {
  const p1 = Math.floor(Date.parse(`${minDate}T00:00:00Z`) / 1000)
  const p2 = Math.floor(Date.now() / 1000)
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(ticker)}?interval=1d&period1=${p1}&period2=${p2}&events=split`
  try {
    const r = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0 (compatible; InvestmentTracker/1.0)' } })
    if (!r.ok) throw new Error(`HTTP ${r.status}`)
    const res = (await r.json())?.chart?.result?.[0]
    const ts = res?.timestamp ?? []
    const closes = res?.indicators?.quote?.[0]?.close ?? []
    const rawCurrency = res?.meta?.currency ?? null
    const scale = normalizeQuoteCurrency(1, rawCurrency)
    if (!scale) throw new Error(`unusable currency "${rawCurrency}"`)
    const series = ts.map((t, i) => ({ date: new Date(t * 1000).toISOString().slice(0, 10), close: closes[i] }))
      .filter((x) => typeof x.close === 'number' && x.close > 0)
      .map((x) => ({ date: x.date, close: x.close * scale.price }))
    const splits = Object.values(res?.events?.splits ?? {}).map((s) => ({ date: new Date(s.date * 1000).toISOString().slice(0, 10), ratio: s.numerator / s.denominator }))
    prices.set(ticker, { symbol: ticker, currency: scale.currency, closes: series, splits, source: 'yahoo_chart_1d_close', fetchedAt })
  } catch (e) {
    priceErrors[ticker] = e.message
  }
}

// Historical ECB FX (Frankfurter), EUR per unit of each needed currency.
const currencies = [...new Set([...prices.values()].map((p) => p.currency).filter((c) => c !== 'EUR'))]
const fx = {}
if (currencies.length) {
  const r = await fetch(`https://api.frankfurter.app/${minDate}..${maxDate}?from=EUR&to=${currencies.join(',')}`)
  const j = await r.json()
  for (const c of currencies) fx[c] = Object.entries(j.rates ?? {}).map(([date, rates]) => ({ date, eurPerUnit: 1 / rates[c] })).filter((x) => Number.isFinite(x.eurPerUnit)).sort((a, b) => (a.date < b.date ? -1 : 1))
}

const officialFile = args.official ? JSON.parse(readFileSync(args.official, 'utf8')) : {}
function officialFor(date) {
  const o = officialFile[date] ?? { positions: [], cash: [] }
  const unmatched = []
  const official = (o.positions ?? []).flatMap((p) => {
    const inv = investments.find((i) => i.platform === p.platform && i.name === p.name)
    if (!inv) { unmatched.push(`${p.platform}/${p.name}`); return [] }
    return [{ investmentId: inv.id, valueEur: p.valueEur, quantity: p.quantity ?? null, source: p.source }]
  })
  return { official, officialCash: o.cash ?? [], unmatched }
}
const report = { userId, generatedAt: fetchedAt, mode: 'dry-run', dates: [], priceErrors, splits: {} }
for (const [t, s] of prices) if (s.splits.length) report.splits[t] = s.splits
const existing = (acct.investmentSnapshots ?? []).map((s) => ({ ...s, value_eur: Number(s.value_eur) }))
for (const date of dates) {
  const off = officialFor(date)
  if (off.unmatched.length) console.log(`   UNMATCHED official rows (no position with that platform/name): ${off.unmatched.join(', ')}`)
  const v = valuePortfolio(investments, transactions, date, prices, fx, { official: off.official, officialCash: off.officialCash })
  // Broker cash is NOT a market price: derived from the books as of `date`,
  // reported separately and labelled 'derived' (compare with statements).
  const flows = (acct.capitalFlowEntries ?? []).map((f) => ({ ...f, amount_eur: Number(f.amount_eur) }))
  const platforms = [...new Set([...investments.map((i) => i.platform), ...flows.map((f) => f.platform)])]
  const fxNow = Object.fromEntries([['EUR', 1], ...Object.entries(fx).map(([c, rows]) => [c, rows.filter((r) => r.date <= date).at(-1)?.eurPerUnit])])
  const cash = Object.fromEntries(platforms.map((pl) => [pl, Math.round(impliedPlatformCash(pl, investments, transactions, flows, fxNow, date) * 100) / 100]))
  const cashTotal = Object.values(cash).reduce((a, b) => a + b, 0)
  const rows = proposeSnapshotRows(userId, v, fetchedAt)
  report.dates.push({
    date,
    totalValueEur: v.totalValueEur,
    officialCash: v.officialCash,
    impliedCashAuditOnly: { quality: 'derived', byPlatform: cash, total: cashTotal },
    benchmarks: v.positions.filter((p) => p.benchmarkValueEur !== null).map((p) => ({ investmentId: p.investmentId, benchmarkValueEur: p.benchmarkValueEur, source: p.priceSource, priceDate: p.priceDate, unit: p.unit })),
    incompleteCount: v.incompleteCount,
    positions: v.positions.map((p) => ({ ...p, name: investments.find((i) => i.id === p.investmentId)?.name })),
    proposals: rows,
    conflicts: findSnapshotConflicts(rows, existing),
  })
  console.log(`${date}: TOTAL (positions + official cash) ${v.totalValueEur === null ? `— (${v.incompleteCount} incomplete)` : `€${v.totalValueEur.toFixed(2)}`} | official cash €${v.officialCash.reduce((a, c) => a + c.amountEur, 0).toFixed(2)} | implied cash (audit only) €${cashTotal.toFixed(2)}`)
  for (const p of v.positions.filter((x) => x.quality !== 'closed')) {
    const name = investments.find((i) => i.id === p.investmentId)?.name
    const shown = p.valueEur !== null ? '€' + p.valueEur.toFixed(2) : p.benchmarkValueEur !== null ? `— (benchmark €${p.benchmarkValueEur.toFixed(2)})` : '—'
    console.log(`   ${p.quality.padEnd(26)} ${name}: qty ${+p.quantity.toFixed(6)} = ${shown}${p.officialSource ? ' [' + p.officialSource + ']' : p.priceDate ? ` [${p.priceSource} ${p.priceDate}]` : ''}${p.note ? ' (' + p.note + ')' : ''}`)
  }
}
if (Object.keys(priceErrors).length) console.log('PRICE ERRORS:', priceErrors)
if (Object.keys(report.splits).length) console.log('SPLITS FOUND (quantities in the books may need corporate-action review):', report.splits)
writeFileSync(args.out, JSON.stringify(report, null, 2))
console.log(`Report written to ${args.out} (dry-run; nothing written to the database).`)
