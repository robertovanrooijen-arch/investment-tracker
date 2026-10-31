import { test, describe, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import type { SupabaseClient } from '@supabase/supabase-js'
import { loadReturns, loadPortfolioState, type ReturnsData } from '@/lib/returns/load-returns'
import { buildAllocationFromValuation } from '@/lib/domain/allocation'
import { addDays } from '@/lib/domain/twr-ledger'
import { writeCentralSnapshots } from '@/lib/domain/central-snapshot'

// End-to-end: the real loader on a small account, with Supabase and the
// market sources (Yahoo, ECB/Frankfurter) replaced by in-memory fakes.

const TODAY = '2026-03-31'
const NOW = '2026-03-31T10:00:00Z'
const realFetch = globalThis.fetch

type Row = Record<string, unknown>
function account(over: { investments?: Row[]; treatments?: Row[]; extraFlows?: Row[]; fx?: Row[] } = {}): Record<string, Row[]> {
  const inv = (o: Row) => ({
    user_id: 'u', current_value: null, price_source: 'yahoo', notes: null, created_at: '', updated_at: '',
    commodity_kind: null, quantity_unit: null, price_last_updated_at: NOW, ...o,
  })
  const tx = (o: Row) => ({
    user_id: 'u', notes: null, fee: 0, price_currency: 'EUR', fee_currency: 'EUR', fx_rate_to_eur: 1, recurring_rule_id: null,
    is_contribution: false, contribution_source: null, source: 'source_migration_degiro', created_at: `2025-01-01T00:00:0${String(o.id).length}Z`, ...o,
  })
  return {
    investments: over.investments ?? [
      inv({ id: 'a', name: 'Alpha ETF', ticker: 'AAA', type: 'ETF', platform: 'DEGIRO', currency: 'EUR', current_price: 120 }),
      inv({ id: 'b', name: 'Beta Inc', ticker: 'BBB', type: 'stock', platform: 'DEGIRO', currency: 'USD', current_price: 55 }),
    ],
    transactions: [
      tx({ id: 't1', investment_id: 'a', type: 'buy', date: '2025-07-01', quantity: 10, price_per_unit: 100, amount: 1000, fee: 1, external_id: 'e1' }),
      tx({ id: 't2', investment_id: 'b', type: 'buy', date: '2025-08-01', quantity: 20, price_per_unit: 50, amount: 1000, price_currency: 'USD', fee_currency: 'USD', fx_rate_to_eur: 0.9, external_id: 'e2' }),
      // Partial sale: 4 of 10 units.
      tx({ id: 't3', investment_id: 'a', type: 'sell', date: '2026-02-02', quantity: 4, price_per_unit: 110, amount: 440, fee: 1, external_id: 'e3' }),
      tx({ id: 't4', investment_id: 'a', type: 'fee', date: '2026-02-23', amount: 2.5, notes: 'DEGIRO Aansluitingskosten 2026', external_id: 'e4' }),
    ],
    capital_flow_entries: [
      { id: 'c1', user_id: 'u', flow_date: '2025-07-01', year: 2025, platform: 'DEGIRO', direction: 'to_portfolio', amount_eur: 1001, source: 'manual', notes: null, created_at: '' },
      { id: 'c2', user_id: 'u', flow_date: '2025-08-01', year: 2025, platform: 'DEGIRO', direction: 'to_portfolio', amount_eur: 900, source: 'manual', notes: null, created_at: '' },
      { id: 'c3', user_id: 'u', flow_date: '2026-02-05', year: 2026, platform: 'DEGIRO', direction: 'from_portfolio', amount_eur: 300, source: 'manual', notes: null, created_at: '' },
      ...(over.extraFlows ?? []),
    ],
    fx_rates: over.fx ?? [{ currency: 'EUR', eur_per_unit: 1, fetched_at: NOW }, { currency: 'USD', eur_per_unit: 0.9, fetched_at: NOW }],
    official_balances: [
      { statement_date: '2025-12-31', platform: 'DEGIRO', kind: 'position', investment_id: 'a', quantity: 10, value_eur: 1150, source_document: 'Jaaropgave 2025' },
      { statement_date: '2025-12-31', platform: 'DEGIRO', kind: 'cash', investment_id: null, quantity: null, value_eur: 0, source_document: 'Jaaropgave 2025' },
    ],
    portfolio_accounting_treatments: over.treatments ?? [],
    broker_value_observations: [],
  }
}

const writes: { table: string; payload: unknown }[] = []
function fakeSupabase(tables: Record<string, Row[]>): SupabaseClient {
  return {
    from: (table: string) => {
      const filters: [string, unknown][] = []
      let range: [number, number] | null = null
      let upsert: unknown = undefined
      const q = {
        select: () => q, order: () => q, in: () => q, returns: () => q, single: () => q,
        eq: (c: string, v: unknown) => { filters.push([c, v]); return q },
        range: (a: number, b: number) => { range = [a, b]; return q },
        upsert: (p: unknown) => { upsert = p; return q },
        then: (resolve: (r: unknown) => void) => {
          if (upsert !== undefined) {
            writes.push({ table, payload: upsert })
            return resolve({ data: Array.isArray(upsert) ? null : upsert, error: null })
          }
          // Tables that do not exist (yet) answer with an error, like PostgREST.
          if (!(table in tables)) return resolve({ data: null, error: { message: `relation ${table} does not exist` } })
          const rows = tables[table].filter((r) => filters.every(([c, v]) => r[c] === v))
          resolve({ data: range ? rows.slice(range[0], range[1] + 1) : rows, error: null })
        },
      }
      return q
    },
  } as unknown as SupabaseClient
}

type Market = { failTicker?: string; emptyTicker?: string; endTicker?: { ticker: string; last: string }; ecbDown?: boolean }
function fakeMarket(m: Market = {}) {
  globalThis.fetch = (async (input: string | URL | Request) => {
    const url = String(input)
    if (url.includes('finance.yahoo.com')) {
      const ticker = decodeURIComponent(url.split('/chart/')[1].split('?')[0])
      if (ticker === m.failTicker) return new Response('Too Many Requests', { status: 429 })
      const last = m.endTicker?.ticker === ticker ? m.endTicker.last : '2026-03-30'
      const ts: number[] = []
      const close: number[] = []
      let i = 0
      for (let d = '2025-06-01'; d <= last && ticker !== m.emptyTicker; d = addDays(d, 1), i += 1) {
        ts.push(Date.parse(`${d}T16:00:00Z`) / 1000)
        close.push(ticker === 'AAA' ? 100 + i * 0.07 : 50 + i * 0.01)
      }
      return Response.json({ chart: { result: [{ timestamp: ts, indicators: { quote: [{ close }] }, meta: { currency: ticker === 'AAA' ? 'EUR' : 'USD' }, events: {} }] } })
    }
    if (url.includes('frankfurter')) {
      if (m.ecbDown) return new Response('down', { status: 503 })
      const rates: Record<string, Record<string, number>> = {}
      for (let d = '2025-06-01'; d <= TODAY; d = addDays(d, 1)) rates[d] = { USD: 1 / 0.9 }
      return Response.json({ rates })
    }
    throw new Error(`unexpected fetch ${url}`)
  }) as typeof fetch
}

async function load(market: Market = {}, over: Parameters<typeof account>[0] = {}): Promise<ReturnsData> {
  fakeMarket(market)
  return loadReturns(fakeSupabase(account(over)), TODAY, { now: NOW })
}

function assertBlocked(d: ReturnsData, source: string) {
  assert.equal(d.availability.ok, false)
  assert.ok(d.availability.gaps.some((g) => g.source === source), `expected a ${source} gap, got ${JSON.stringify(d.availability.gaps)}`)
  for (const p of d.periods) assert.equal(p.twr.twr, null, `${p.key}: no percentage`)
  assert.equal(d.xirr.annualRate, null, 'no XIRR over a shorter period')
  assert.equal(d.investmentResult, null, 'no partial euro result')
  assert.equal(d.headline.twrYtd, null)
  assert.equal(d.headline.xirrAnnualRate, null)
  assert.equal(d.headline.totalResultSinceStartEur, null)
  assert.equal(d.headline.realisedSinceStartEur, null)
  assert.equal(d.headline.unrealisedNowEur, null)
  assert.deepEqual(d.reconstructedHistory, [], 'an incomplete history is not shown as if complete')
  assert.deepEqual(d.open, [])
}

afterEach(() => { globalThis.fetch = realFetch })

describe('central engine: fail-closed', () => {
  test('complete data: every figure is available and ends today', async () => {
    const d = await load()
    assert.equal(d.availability.ok, true, JSON.stringify(d.availability.gaps))
    for (const p of d.periods) {
      assert.equal(p.twr.status, 'ok')
      assert.equal(p.twr.endDate, TODAY)
    }
    assert.notEqual(d.headline.twrYtd, null)
    assert.notEqual(d.headline.xirrAnnualRate, null)
    assert.notEqual(d.investmentResult, null)
  })

  test('a failed broker-observation read stops instead of silently falling back to a benchmark', async () => {
    fakeMarket()
    const tables = account()
    delete tables.broker_value_observations
    await assert.rejects(loadReturns(fakeSupabase(tables), TODAY, { now: NOW }), /Failed to load broker observations/)
  })

  test('1. one Yahoo ticker answers HTTP 429 → no TWR, no XIRR, no euro result', async () => {
    const d = await load({ failTicker: 'BBB' })
    assertBlocked(d, 'yahoo_history')
    const g = d.availability.gaps.find((x) => x.source === 'yahoo_history')!
    assert.equal(g.item, 'BBB')
    assert.equal(g.requestedTo, TODAY)
    assert.match(g.reason, /429/)
  })

  test('one ticker without any historical series → blocked', async () => {
    const d = await load({ emptyTicker: 'AAA' })
    assertBlocked(d, 'yahoo_history')
    assert.equal(d.availability.gaps.find((x) => x.source === 'yahoo_history')!.item, 'AAA')
  })

  test('2. the ECB/Frankfurter route is down → no TWR, no XIRR, no euro result', async () => {
    const d = await load({ ecbDown: true })
    assertBlocked(d, 'ecb_fx')
    assert.match(d.availability.gaps.find((x) => x.source === 'ecb_fx')!.item, /USD/)
  })

  test('3. a series that ends before today (truncated period) → no percentage, last available date given', async () => {
    const d = await load({ endTicker: { ticker: 'BBB', last: '2026-03-10' } })
    assertBlocked(d, 'return_period')
    const g = d.availability.gaps.find((x) => x.source === 'return_period')!
    assert.ok(g.lastAvailableDate !== null && g.lastAvailableDate < TODAY, `last available ${g.lastAvailableDate}`)
    for (const p of d.periods) assert.equal(p.twr.truncated, false, 'never a truncated period')
  })

  test('a live price older than allowed → no current value and no results', async () => {
    const tables = account()
    const stale = new Date(Date.parse(NOW) - 72 * 3_600_000).toISOString()
    const investments = tables.investments.map((i) => (i.id === 'b' ? { ...i, price_last_updated_at: stale } : i))
    const d = await load({}, { investments })
    assertBlocked(d, 'live_quote')
    assert.equal(d.headline.currentValueEur, null)
  })

  test('only part of the portfolio can be valued → no total, no results', async () => {
    const tables = account()
    const investments = tables.investments.map((i) => (i.id === 'b' ? { ...i, current_price: null } : i))
    const d = await load({}, { investments })
    assertBlocked(d, 'live_quote')
    assert.equal(d.valuation.totalEur, null)
    assert.equal(d.valuation.positionsEur, null)
  })

  test('4. no silent fallback: blocked headline figures are null — never another engine’s numbers', async () => {
    const d = await load({ failTicker: 'AAA' })
    const h = d.headline
    for (const k of ['realisedSinceStartEur', 'unrealisedNowEur', 'totalResultSinceStartEur', 'totalResultYtdEur', 'twrYtd', 'xirrAnnualRate'] as const) {
      assert.equal(h[k], null, k)
    }
    assert.ok(h.resultsUnavailableReason && /AAA/.test(h.resultsUnavailableReason))
    // And the pages contain no route back to the old engine for their headline figures.
    const pages = ['dashboard', 'history', 'portfolio/profit-loss', 'portfolio/allocation', 'returns']
    for (const page of pages) {
      const src = readFileSync(`app/(app)/${page}/page.tsx`, 'utf8')
      for (const legacy of ['computePortfolioMetrics', 'computeInvestmentMetrics', 'buildPortfolioAllocation(', 'computeAllocation(', 'computePerformanceByCategory', 'liveMetrics']) {
        assert.ok(!src.includes(legacy), `${page} still uses ${legacy}`)
      }
    }
    // The snapshot writer (cron + manual refresh) uses the central valuation only.
    const writer = readFileSync('lib/domain/refresh.ts', 'utf8') + readFileSync('lib/domain/central-snapshot.ts', 'utf8')
    for (const legacy of ['computePortfolioMetrics', 'computeInvestmentMetrics', 'upsertTodaysSnapshot']) {
      assert.ok(!writer.includes(legacy), `the snapshot writer still uses ${legacy}`)
    }
    for (const page of ['ytd', 'year-analysis', 'portfolio/profit-loss']) {
      const src = readFileSync(`app/(app)/${page}/page.tsx`, 'utf8')
      assert.ok(!/investmentResult\?\.[a-zA-Z.]+ \?\? (summary|yearSummary|liveMetrics)/.test(src), `${page}: fallback to the old engine`)
    }
  })
})

describe('central engine: one current value everywhere', () => {
  test('5. Dashboard, Returns, History, Allocation and P/L use the same current value', async () => {
    const d = await load()
    const v = d.headline.currentValueEur!
    assert.equal(v, d.valuation.totalEur, 'headline = central valuation')
    // The return ledger keeps broker cash inside: it ends on positions + cash.
    for (const p of d.periods) assert.ok(Math.abs((p.twr.endValueEur ?? NaN) - d.valuation.ledgerTotalEur!) <= 1e-9, `Returns ${p.key} ends on the central valuation`)
    assert.equal(v, d.valuation.positionsEur, 'shown value = investment positions (cash kept apart)')
    assert.ok(Math.abs(d.reconstructedHistory.at(-1)!.valueEur - v) <= 1e-9, 'History: last point')
    assert.equal(d.reconstructedHistory.at(-1)!.date, TODAY)
    const alloc = buildAllocationFromValuation(
      Object.entries(d.investmentsMeta).map(([id, m]) => ({ id, ...m, ticker: null, user_id: 'u', current_price: null, current_value: null, currency: 'EUR', price_last_updated_at: null, price_source: null, notes: null, created_at: '', updated_at: '', commodity_kind: null, quantity_unit: null })),
      d.valuation
    )
    assert.ok(Math.abs(alloc.totalValue - v) <= 1e-9, 'Allocation: the holdings are the shown value')
    // P/L: position rows add up to the totals shown on the cards.
    const r = d.investmentResult!
    const sum = (rows: typeof r.sinceStart.byInvestment, k: 'totalEur' | 'realisedEur' | 'unrealisedEndEur') => rows.reduce((s, x) => s + x[k], 0)
    assert.ok(Math.abs(sum(r.sinceStart.byInvestment, 'totalEur') - d.headline.totalResultSinceStartEur!) <= 1e-9)
    assert.ok(Math.abs(sum(r.sinceStart.byInvestment, 'realisedEur') - d.headline.realisedSinceStartEur!) <= 1e-9)
    assert.ok(Math.abs(sum(r.sinceStart.byInvestment, 'unrealisedEndEur') - d.headline.unrealisedNowEur!) <= 1e-9)
    assert.ok(Math.abs(sum(r.period.byInvestment, 'totalEur') - d.headline.totalResultYtdEur!) <= 1e-9)
    // Allocation on its own (lighter loader) gives exactly the same valuation.
    fakeMarket()
    const state = await loadPortfolioState(fakeSupabase(account()), TODAY, NOW)
    assert.equal(state.valuation.totalEur, v)
  })

  test('6. a partly sold position: realised once for the sold units, unrealised once for the rest', async () => {
    const d = await load()
    const row = d.investmentResult!.sinceStart.byInvestment.find((x) => x.investmentId === 'a')!
    // Bought 10 for 1,001 (incl. fee); sold 4 for 440 − 1 = 439 at cost 400.40.
    assert.ok(Math.abs(row.realisedEur - (439 - 400.4)) < 1e-9)
    assert.ok(Math.abs(row.remainingCostEur - 600.6) < 1e-9)
    assert.ok(Math.abs(row.unrealisedEndEur - (6 * 120 - 600.6)) < 1e-9)
    assert.equal(row.heldAtEnd, 6)
    const r = d.investmentResult!.sinceStart
    assert.ok(Math.abs(r.totalEur - (r.realisedEur + r.unrealisedChangeEur + r.dividendsInterestEur - r.costsEur - r.taxesEur)) < 1e-9)
    assert.equal(r.reconciled, true)
  })

  test('7. a small DEGIRO fee overdraft is valid broker cash, not a missing deposit or headline value', async () => {
    const cashToMinus242 = [{
      id: 'cash-to-minus-242', user_id: 'u', flow_date: '2026-03-02', year: 2026, platform: 'DEGIRO',
      direction: 'from_portfolio', amount_eur: 138.92, source: 'manual', notes: null, created_at: '',
    }]
    const d = await load({}, { extraFlows: cashToMinus242 })
    assert.equal(d.availability.ok, true)
    assert.ok(Math.abs(d.valuation.cashEur! + 2.42) < 1e-9, 'the real small overdraft stays in the audit ledger')
    assert.equal(d.headline.currentValueEur, d.valuation.positionsEur, 'broker cash is outside the headline value')
    assert.ok(!d.periods.some((p) => p.qualityIssues.some((i) => i.kind === 'cash_shortfall')))
    assert.equal(d.contributionsAllTime.grossFreshContributionsEur, 1901, 'a broker fee is never a contribution')
  })

  test('8. the 31-12 statement factor is not applied to the current value', async () => {
    const d = await load()
    const a = d.valuation.positions.find((p) => p.investmentId === 'a')!
    assert.equal(a.valueEur, 6 * 120, 'quantity × current price, no statement factor')
    assert.equal(d.periods[0].twr.startValueEur !== null, true)
    assert.ok(d.periods[0].qualityIssues.some((i) => i.kind === 'valuation_basis_adjustment'))
  })
})

// A withdrawal that leaves only a rounding residue (€0.04) at DEGIRO.
const toRounding = [{ id: 'c4', user_id: 'u', flow_date: '2026-03-02', year: 2026, platform: 'DEGIRO', direction: 'from_portfolio', amount_eur: 136.46, source: 'manual', notes: null, created_at: '' }]

describe('broker cash and the shown value', () => {
  test('rounding cash is kept apart: the shown value is the sum of the investment positions', async () => {
    const d = await load({}, { extraFlows: toRounding })
    assert.equal(d.availability.ok, true, JSON.stringify(d.availability.gaps))
    const positions = d.valuation.positions.reduce((s, p) => s + (p.valueEur as number), 0)
    assert.equal(d.headline.currentValueEur, d.valuation.positionsEur)
    assert.ok(Math.abs(d.headline.currentValueEur! - positions) < 1e-9)
    assert.ok(Math.abs(d.valuation.cashEur! - 0.04) < 1e-9, 'the residue still exists in the ledger')
    assert.ok(Math.abs(d.periods[0].twr.endValueEur! - (positions + 0.04)) < 1e-9, 'the return runs through it')
    assert.equal(d.headline.brokerCash.policyDecisionNeeded, false)
    assert.ok(d.headline.brokerCash.byPlatform.every((c) => c.withinTolerance))
  })

  test('material cash is never set to zero: shown apart and flagged for a policy decision', async () => {
    const d = await load()
    assert.ok(Math.abs(d.valuation.cashEur! - 136.5) < 1e-9)
    assert.equal(d.headline.brokerCash.totalEur, d.valuation.cashEur, 'not zeroed')
    assert.equal(d.headline.brokerCash.policyDecisionNeeded, true)
    assert.equal(d.headline.currentValueEur, d.valuation.positionsEur, 'not silently added to the investment value')
  })
})

describe('snapshot writer: the central valuation only', () => {
  const write = async (tables: Record<string, Row[]>, writeQuality = false) => {
    writes.length = 0
    fakeMarket()
    const client = fakeSupabase(tables)
    const state = await loadPortfolioState(client, TODAY, NOW, { userId: 'u' })
    const res = await writeCentralSnapshots(client, state, { userId: 'u', source: 'cron', today: TODAY, now: NOW, writeQuality })
    return { res, state, portfolio: writes.filter((w) => w.table === 'portfolio_snapshots'), positions: writes.filter((w) => w.table === 'investment_snapshots') }
  }

  test('complete valuation → exactly one snapshot, equal to the headline value', async () => {
    const tables = account({ extraFlows: toRounding })
    const { res, portfolio, positions } = await write(tables, true)
    assert.equal(res.quality, 'complete')
    assert.equal(portfolio.length, 1)
    assert.equal(positions.length, 1)
    const row = portfolio[0].payload as Record<string, number>
    const d = await load({}, { extraFlows: toRounding })
    assert.equal(row.total_value_eur, d.headline.currentValueEur, 'snapshot = headline, exactly')
    assert.ok(Math.abs(row.implied_cash_eur - 0.04) < 1e-9, 'rounding cash recorded apart (audit only)')
    assert.equal(row.pl_definition_version, 3)
  })

  test('a missing price → no snapshot at all', async () => {
    const tables = account()
    tables.investments = tables.investments.map((i) => (i.id === 'b' ? { ...i, current_price: null } : i))
    const { res, portfolio, positions } = await write(tables)
    assert.equal(res.snapshot, null)
    assert.equal(res.quality, 'incomplete')
    assert.equal(portfolio.length + positions.length, 0)
  })

  test('a missing FX rate → no snapshot at all', async () => {
    const tables = account({ fx: [{ currency: 'EUR', eur_per_unit: 1, fetched_at: NOW }] })
    const { res, portfolio, positions } = await write(tables)
    assert.equal(res.quality, 'fx_incomplete')
    assert.equal(portfolio.length + positions.length, 0)
  })

  test('a benchmark metal → snapshot with estimated quality', async () => {
    const tables = account({
      extraFlows: [
        { id: 'c5', user_id: 'u', flow_date: '2026-03-02', year: 2026, platform: 'GoldRepublic', direction: 'to_portfolio', amount_eur: 100, source: 'manual', notes: null, created_at: '' },
        ...toRounding,
      ],
    })
    tables.investments = [...tables.investments, {
      id: 's', user_id: 'u', name: 'Zilver', ticker: 'SI=F', type: 'commodity', platform: 'GoldRepublic', currency: 'USD',
      current_price: 1.6, current_value: null, price_source: 'yahoo', notes: null, created_at: '', updated_at: '',
      commodity_kind: 'silver', quantity_unit: 'gram', price_last_updated_at: NOW,
    }]
    tables.transactions = [...tables.transactions, {
      id: 't9', user_id: 'u', investment_id: 's', type: 'buy', date: '2026-03-02', quantity: 62.5, price_per_unit: 1.6, amount: 100,
      fee: 0, price_currency: 'EUR', fee_currency: 'EUR', fx_rate_to_eur: 1, notes: null, recurring_rule_id: null,
      is_contribution: false, contribution_source: null, source: 'source_migration_goldrepublic', created_at: '2026-03-02T00:00:00Z', external_id: 'e9',
    }]
    const { res, positions } = await write(tables, true)
    assert.equal(res.quality, 'complete', JSON.stringify(res.snapshotError))
    assert.equal(res.valuationQuality, 'estimated')
    const rows = positions[0].payload as Record<string, unknown>[]
    assert.equal(rows.find((r) => r.investment_id === 's')!.quality, 'benchmark_only')
    assert.equal(rows.find((r) => r.investment_id === 'a')!.quality, 'exact')
  })
})
