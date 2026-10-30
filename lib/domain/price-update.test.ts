import { test, describe, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { normalizeQuoteCurrency, priceForStorage, priceStatusFor } from '@/lib/domain/price-update'
import { refreshPortfolioForUser, snapshotQualityColumnsEnabled } from '@/lib/domain/refresh'
import { upsertTodaysSnapshot } from '@/lib/domain/snapshot'
import {
  getAvailableYears,
  isEstimatedCapitalFlowSource,
  isLiveSnapshotSource,
} from '@/lib/domain/year-analysis'
import type { SupabaseClient } from '@supabase/supabase-js'
import type { Investment, Transaction } from '@/types/database'

describe('Yahoo quote currency validation', () => {
  test('GBp (pence) is normalised to GBP pounds, never stored 100× too high', () => {
    assert.deepEqual(normalizeQuoteCurrency(1234, 'GBp'), { price: 12.34, currency: 'GBP' })
    assert.deepEqual(normalizeQuoteCurrency(1234, 'GBX'), { price: 12.34, currency: 'GBP' })
  })

  test('unknown, missing or malformed currencies and bad prices are rejected, not guessed', () => {
    assert.equal(normalizeQuoteCurrency(10, null), null)
    assert.equal(normalizeQuoteCurrency(10, 'usd'), null)
    assert.equal(normalizeQuoteCurrency(10, 'XXXX'), null)
    assert.equal(normalizeQuoteCurrency(-1, 'USD'), null)
    assert.equal(normalizeQuoteCurrency(Number.NaN, 'USD'), null)
  })

  test('a quote in a different currency than the investment is rejected (investments.currency is the truth)', () => {
    const r = priceForStorage(100, 'USD', { type: 'ETF', currency: 'EUR', quantity_unit: null })
    assert.equal(r.ok, false)
  })

  test('a GBp quote for a GBP investment is accepted in pounds', () => {
    const r = priceForStorage(250, 'GBp', { type: 'stock', currency: 'GBP', quantity_unit: null })
    assert.deepEqual(r, { ok: true, price: 2.5, currency: 'GBP' })
  })

  test('gram-tracked commodities get the per-troy-ounce quote converted to per gram', () => {
    const r = priceForStorage(3110.34768, 'USD', { type: 'commodity', currency: 'USD', quantity_unit: 'gram' })
    assert.ok(r.ok)
    assert.ok(Math.abs(r.price - 100) < 1e-9)
    const oz = priceForStorage(3110.34768, 'USD', { type: 'commodity', currency: 'USD', quantity_unit: 'troy_ounce' })
    assert.ok(oz.ok && oz.price === 3110.34768)
  })
})

describe('price status', () => {
  test('fresh / stale / missing / not_applicable', () => {
    assert.equal(priceStatusFor({ isUnitBased: true, isOpen: true, currentPrice: 10, refreshedThisRun: true }), 'fresh')
    assert.equal(priceStatusFor({ isUnitBased: true, isOpen: true, currentPrice: 10, refreshedThisRun: false }), 'stale')
    assert.equal(priceStatusFor({ isUnitBased: true, isOpen: true, currentPrice: null, refreshedThisRun: false }), 'missing')
    assert.equal(priceStatusFor({ isUnitBased: true, isOpen: false, currentPrice: 10, refreshedThisRun: false }), 'not_applicable')
    assert.equal(priceStatusFor({ isUnitBased: false, isOpen: true, currentPrice: null, refreshedThisRun: false }), 'not_applicable')
  })
})

describe('years and data-quality markers come from the data', () => {
  test('available years include transaction, capital-flow and snapshot years plus the current year', () => {
    const tx = { date: '2025-03-01' } as Transaction
    const years = getAvailableYears([tx], ['2024-12-31', '2023-06-01', null])
    const current = new Date().getFullYear()
    assert.deepEqual(years, [...new Set([current, 2025, 2024, 2023])].sort((a, b) => b - a))
  })

  test('estimated capital-flow sources and non-live snapshot sources are recognised', () => {
    assert.equal(isEstimatedCapitalFlowSource('manual_abn_import_2025_2026_even_monthly_v1'), true)
    assert.equal(isEstimatedCapitalFlowSource('degiro_account_export_2026'), false)
    assert.equal(isEstimatedCapitalFlowSource(null), false)
    assert.equal(isLiveSnapshotSource('cron'), true)
    assert.equal(isLiveSnapshotSource('source_backed_2025_12_31_year_end'), false)
  })
})

// ---------------------------------------------------------------------------
// refreshPortfolioForUser against an in-memory fake Supabase client.
// ---------------------------------------------------------------------------

type Op = { table: string; kind: 'select' | 'update' | 'upsert'; payload?: unknown }

function fakeSupabase(tables: Record<string, unknown[]>, failing: Record<string, string> = {}) {
  const ops: Op[] = []
  function builder(table: string) {
    let kind: Op['kind'] = 'select'
    let payload: unknown
    const q = {
      select: () => q,
      eq: () => q,
      in: () => q,
      order: () => q,
      range: () => q,
      returns: () => q,
      single: () => q,
      maybeSingle: () => q,
      update: (p: unknown) => { kind = 'update'; payload = p; return q },
      upsert: (p: unknown) => { kind = 'upsert'; payload = p; return q },
      then: (resolve: (v: unknown) => void) => {
        ops.push({ table, kind, payload })
        const data = kind === 'select' ? tables[table] ?? [] : kind === 'upsert' && !Array.isArray(payload) ? payload : null
        if (kind === 'select' && failing[table]) return resolve({ data: null, error: { message: failing[table] } })
        resolve({ data, error: null })
      },
    }
    return q
  }
  return { client: { from: builder } as unknown as SupabaseClient, ops }
}

const realFetch = globalThis.fetch
afterEach(() => { globalThis.fetch = realFetch })

function mockYahoo(quotes: Record<string, { price: number; currency: string }>) {
  globalThis.fetch = (async (input: string | URL | Request) => {
    const url = String(input)
    const ticker = decodeURIComponent(url.split('/chart/')[1]?.split('?')[0] ?? '')
    const q = quotes[ticker]
    if (!q) return new Response('not found', { status: 404 })
    return new Response(
      JSON.stringify({ chart: { result: [{ meta: { regularMarketPrice: q.price, currency: q.currency, regularMarketTime: 1761600000 } }] } }),
      { status: 200 }
    )
  }) as typeof fetch
}

function inv(o: Partial<Investment>): Investment {
  return {
    id: 'x', user_id: 'u1', name: 'X', ticker: null, type: 'ETF', platform: 'DEGIRO',
    current_price: 100, current_value: null, currency: 'EUR', price_last_updated_at: '2026-10-01T00:00:00Z',
    price_source: 'yahoo', notes: null, created_at: '2024-01-01T00:00:00Z', updated_at: '2024-01-01T00:00:00Z',
    commodity_kind: null, quantity_unit: null, ...o,
  }
}

function buyTx(investment_id: string, o: Partial<Transaction> = {}): Transaction {
  return {
    id: `t-${investment_id}`, user_id: 'u1', investment_id, type: 'buy', quantity: 1, price_per_unit: 100,
    amount: null, fee: 0, date: '2026-01-02', notes: null, created_at: '2026-01-02T00:00:00Z',
    price_currency: 'EUR', fee_currency: 'EUR', fx_rate_to_eur: 1,
    recurring_rule_id: null, is_contribution: false, contribution_source: null, ...o,
  }
}

describe('refreshPortfolioForUser — prices and snapshots', () => {
  test('a quote in an unexpected currency is not saved; the position is reported stale; currency is never overwritten', async () => {
    mockYahoo({ OK: { price: 110, currency: 'EUR' }, WRONG: { price: 50, currency: 'USD' } })
    const investments = [
      inv({ id: 'ok', ticker: 'OK' }),
      inv({ id: 'wrong', ticker: 'WRONG', current_price: 40 }),
    ]
    const { client, ops } = fakeSupabase({
      investments,
      transactions: [buyTx('ok'), buyTx('wrong')],
      fx_rates: [{ currency: 'EUR', eur_per_unit: 1, fetched_at: '2026-10-27T00:00:00Z' }],
    })

    const summary = await refreshPortfolioForUser(client, 'u1', 'cron')

    const updates = ops.filter((o) => o.table === 'investments' && o.kind === 'update')
    assert.equal(updates.length, 1, 'only the valid quote is written')
    for (const u of updates) assert.equal(Object.hasOwn(u.payload as object, 'currency'), false)
    assert.equal(summary.prices.failed, 1)
    assert.equal(summary.priceStatusCounts.fresh, 1)
    assert.equal(summary.priceStatusCounts.stale, 1)
  })

  test('a missing FX rate writes NO snapshot at all (no partial historical snapshot) and reports fx_incomplete', async () => {
    mockYahoo({})
    const { client, ops } = fakeSupabase({
      investments: [inv({ id: 'eur' }), inv({ id: 'chf', currency: 'CHF' })],
      transactions: [buyTx('eur'), buyTx('chf', { price_currency: 'CHF', fee_currency: 'CHF', fx_rate_to_eur: 0.95 })],
      fx_rates: [{ currency: 'EUR', eur_per_unit: 1, fetched_at: '2026-10-27T00:00:00Z' }],
    })

    const summary = await refreshPortfolioForUser(client, 'u1', 'cron')

    assert.equal(summary.quality, 'fx_incomplete')
    assert.equal(summary.snapshot, null)
    assert.match(summary.snapshotError ?? '', /missing FX/)
    assert.equal(summary.investmentSnapshots.upserted, 0)
    const writes = ops.filter((o) => o.kind === 'upsert' && (o.table === 'portfolio_snapshots' || o.table === 'investment_snapshots'))
    assert.equal(writes.length, 0, 'not even the known EUR position is snapshotted on its own')
  })

  test('a complete portfolio writes both snapshots without quality columns while the flag is off', async () => {
    // Default deploy (no migration M7 yet): the flag is unset → off.
    assert.equal(process.env.SNAPSHOT_QUALITY_COLUMNS, undefined)
    assert.equal(snapshotQualityColumnsEnabled(), false)
    mockYahoo({})
    const { client, ops } = fakeSupabase({
      investments: [inv({ id: 'eur' })],
      transactions: [buyTx('eur')],
      fx_rates: [{ currency: 'EUR', eur_per_unit: 1, fetched_at: '2026-10-27T00:00:00Z' }],
    })
    const summary = await refreshPortfolioForUser(client, 'u1', 'cron')
    assert.equal(summary.quality, 'complete')
    const inv1 = ops.find((o) => o.table === 'investment_snapshots' && o.kind === 'upsert')
    const port = ops.find((o) => o.table === 'portfolio_snapshots' && o.kind === 'upsert')
    assert.ok(inv1 && port)
    const row = (inv1.payload as Record<string, unknown>[])[0]
    for (const col of ['price_status', 'method', 'pl_definition_version']) {
      assert.equal(Object.hasOwn(row, col), false)
      assert.equal(Object.hasOwn(port.payload as object, col), false)
    }
  })

  test('upsertTodaysSnapshot itself refuses incomplete metrics (defence in depth)', async () => {
    const { client, ops } = fakeSupabase({})
    const metrics = {
      totalValue: 100, totalInvested: NaN, totalRealized: 0, totalUnrealized: NaN, totalProfit: NaN,
      totalEverInvested: NaN, resultVsPurchaseVolumePct: null, fxIncompleteCount: 1, fxLiveFallbackCount: 0, complete: false,
    }
    const res = await upsertTodaysSnapshot(client, 'u1', metrics, 'cron')
    assert.equal(res.snapshot, null)
    assert.ok(res.error)
    assert.equal(ops.length, 0)
  })

  test('a failed read of transactions throws; it never becomes an empty portfolio with a €0 snapshot', async () => {
    mockYahoo({})
    const { client, ops } = fakeSupabase({
      investments: [inv({ id: 'eur' })],
      fx_rates: [{ currency: 'EUR', eur_per_unit: 1, fetched_at: '2026-10-27T00:00:00Z' }],
    }, { transactions: 'permission denied' })
    await assert.rejects(refreshPortfolioForUser(client, 'u1', 'cron'), /Failed to load transactions/)
    assert.equal(ops.some((o) => o.kind === 'upsert'), false)
  })
})
