import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import {
  findSnapshotConflicts,
  proposeSnapshotRows,
  quantityOn,
  valuePortfolio,
  valuePosition,
  type PriceSeries,
} from '@/lib/valuation/historical-valuation'
import type { Investment, Transaction } from '@/types/database'

function inv(o: Partial<Investment>): Investment {
  return {
    id: 'a', user_id: 'u', name: 'A', ticker: 'A.AS', type: 'ETF', platform: 'P', current_price: 1, current_value: null,
    currency: 'EUR', price_last_updated_at: null, price_source: null, notes: null, created_at: '', updated_at: '',
    commodity_kind: null, quantity_unit: null, ...o,
  }
}
let n = 0
function tx(o: Partial<Transaction>): Transaction {
  n += 1
  return {
    id: `t${n}`, user_id: 'u', investment_id: 'a', type: 'buy', quantity: 10, price_per_unit: 10, amount: 100, fee: 0,
    date: '2025-06-01', notes: null, created_at: `2025-01-01T00:00:${String(n % 60).padStart(2, '0')}Z`,
    price_currency: 'EUR', fee_currency: 'EUR', fx_rate_to_eur: 1, recurring_rule_id: null, is_contribution: false,
    contribution_source: null, ...o,
  }
}
const series = (o: Partial<PriceSeries> & { symbol: string }): PriceSeries => ({
  currency: 'EUR', closes: [], source: 'yahoo_chart_1d', fetchedAt: '2026-10-29T00:00:00Z', ...o,
})

describe('historical valuation', () => {
  test('values the quantity held at the close of the last trading day on/before the date', () => {
    const a = inv({})
    const txs = [tx({}), tx({ type: 'sell', quantity: 4, date: '2025-12-31' })]
    const prices = new Map([['A.AS', series({ symbol: 'A.AS', closes: [{ date: '2025-12-30', close: 12 }, { date: '2026-01-02', close: 13 }] })]])
    const p = valuePosition(a, txs, '2026-01-01', prices, {})
    assert.equal(p.quantity, 6)
    assert.equal(p.priceDate, '2025-12-30')
    assert.equal(p.valueEur, 72)
    assert.equal(p.quality, 'exact')
  })

  test('a fully sold position is exactly zero from its sale date, even with a float residue', () => {
    const a = inv({})
    const txs = [tx({ quantity: 0.1 + 0.2 }), tx({ type: 'sell', quantity: 0.3, date: '2025-09-01' })]
    assert.equal(quantityOn(a, txs, '2025-08-31'), 0.1 + 0.2)
    assert.equal(quantityOn(a, txs, '2025-09-01'), 0)
    assert.equal(valuePosition(a, txs, '2026-01-01', new Map(), {}).quality, 'closed')
  })

  test('gram-tracked gold is valued per gram from a per-ounce USD close with that day\'s FX', () => {
    const g = inv({ id: 'g', ticker: 'GC=F', type: 'commodity', commodity_kind: 'gold', quantity_unit: 'gram', currency: 'USD' })
    const txs = [tx({ investment_id: 'g', quantity: 31.1034768 })]
    const prices = new Map([['GC=F', series({ symbol: 'GC=F', currency: 'USD', closes: [{ date: '2025-12-31', close: 2600 }] })]])
    const fx = { USD: [{ date: '2025-12-31', eurPerUnit: 0.9 }, { date: '2026-10-28', eurPerUnit: 0.86 }] }
    const p = valuePosition(g, txs, '2025-12-31', prices, fx)
    // One ounce at the historical FX — but only as a labelled BENCHMARK.
    assert.ok(Math.abs((p.benchmarkValueEur ?? 0) - 2600 * 0.9) < 1e-9)
    assert.equal(p.valueEur, null)
    assert.equal(p.quality, 'benchmark_only')
    assert.equal(p.complete, false)
    assert.equal(p.fxDate, '2025-12-31')
  })

  test('official statement values are leading; a quantity mismatch is never accepted silently', () => {
    const g = inv({ id: 'g', ticker: 'SI=F', type: 'commodity', commodity_kind: 'silver', quantity_unit: 'gram', currency: 'USD' })
    const txs = [tx({ investment_id: 'g', quantity: 588.5363 })]
    const ok = valuePosition(g, txs, '2025-12-31', new Map(), {}, { investmentId: 'g', valueEur: 1157.08, quantity: 588.5363, source: 'Holland Gold jaaropgave 2025' })
    assert.equal(ok.quality, 'official')
    assert.equal(ok.valueEur, 1157.08)
    assert.equal(ok.valueSource, 'official')
    const bad = valuePosition(g, txs, '2025-12-31', new Map(), {}, { investmentId: 'g', valueEur: 1157.08, quantity: 500, source: 'statement' })
    assert.equal(bad.quality, 'official_quantity_mismatch')
    assert.equal(bad.valueEur, null)
  })

  test('the portfolio total = official/market positions + OFFICIAL cash only (never implied cash)', () => {
    const a = inv({})
    const prices = new Map([['A.AS', series({ symbol: 'A.AS', closes: [{ date: '2025-12-31', close: 11 }] })]])
    const v = valuePortfolio([a], [tx({})], '2025-12-31', prices, {}, {
      officialCash: [{ platform: 'DEGIRO', amountEur: 90.38, source: 'DEGIRO jaaroverzicht 2025' }],
    })
    assert.ok(Math.abs((v.totalValueEur ?? 0) - (110 + 90.38)) < 1e-9)
    const noCash = valuePortfolio([a], [tx({})], '2025-12-31', prices, {})
    assert.equal(noCash.totalValueEur, 110)
  })

  test('a split after the price date is undone (Yahoo closes are split-adjusted)', () => {
    const a = inv({})
    const prices = new Map([['A.AS', series({ symbol: 'A.AS', closes: [{ date: '2025-12-31', close: 50 }], splits: [{ date: '2026-03-01', ratio: 2 }] })]])
    const p = valuePosition(a, [tx({})], '2025-12-31', prices, {})
    assert.equal(p.splitFactorApplied, 2)
    assert.equal(p.valueEur, 10 * 100)
  })

  test('missing price, stale price, missing FX and cash never get a fabricated value; the total is withheld', () => {
    const a = inv({})
    const usd = inv({ id: 'u', ticker: 'U', currency: 'USD' })
    const cash = inv({ id: 'c', ticker: null, type: 'cash', current_value: 500 })
    const txs = [tx({}), tx({ investment_id: 'u' }), tx({ investment_id: 'c', type: 'deposit', quantity: null, amount: 500 })]
    const stale = new Map([['A.AS', series({ symbol: 'A.AS', closes: [{ date: '2025-11-01', close: 9 }] })],
      ['U', series({ symbol: 'U', currency: 'USD', closes: [{ date: '2025-12-31', close: 9 }] })]])
    const v = valuePortfolio([a, usd, cash], txs, '2025-12-31', stale, {})
    const q = Object.fromEntries(v.positions.map((p) => [p.investmentId, p.quality]))
    assert.deepEqual(q, { a: 'stale_price', u: 'missing_fx', c: 'not_reconstructable' })
    assert.equal(v.totalValueEur, null)
    assert.equal(v.incompleteCount, 3)
    assert.equal(valuePosition(a, txs, '2025-12-31', new Map(), {}).quality, 'missing_price')
  })

  test('proposals are deterministic and existing snapshots are reported, never overwritten', () => {
    const a = inv({})
    const prices = new Map([['A.AS', series({ symbol: 'A.AS', closes: [{ date: '2025-12-31', close: 11 }] })]])
    const v = valuePortfolio([a], [tx({})], '2025-12-31', prices, {})
    const rows = proposeSnapshotRows('u', v, '2026-10-29T00:00:00Z')
    assert.deepEqual(proposeSnapshotRows('u', v, '2026-10-29T00:00:00Z'), rows)
    assert.equal(rows[0].method, 'reconstructed')
    const conflicts = findSnapshotConflicts(rows, [{ investment_id: 'a', date: '2025-12-31', value_eur: 100, snapshot_source: 'statement' }])
    assert.deepEqual(conflicts, [{ investmentId: 'a', date: '2025-12-31', existingValueEur: 100, existingSource: 'statement', proposedValueEur: 110 }])
  })
})
