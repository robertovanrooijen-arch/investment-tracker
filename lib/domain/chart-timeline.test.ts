import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { buildInvestmentChartTimeline } from '@/lib/domain/chart-timeline'
import type { Investment, Transaction } from '@/types/database'

function makeInvestment(overrides: Partial<Investment>): Investment {
  return {
    id: 'inv-1',
    user_id: 'u1',
    name: 'Test',
    ticker: null,
    type: 'stock',
    platform: 'DEGIRO',
    current_price: 0,
    current_value: null,
    currency: 'EUR',
    price_last_updated_at: null,
    price_source: null,
    notes: null,
    created_at: '2024-01-01T00:00:00Z',
    updated_at: '2024-01-01T00:00:00Z',
    commodity_kind: null,
    quantity_unit: null,
    ...overrides,
  }
}

function makeTx(overrides: Partial<Transaction>): Transaction {
  return {
    id: 'tx-1',
    user_id: 'u1',
    investment_id: 'inv-1',
    type: 'buy',
    quantity: 1,
    price_per_unit: 100,
    amount: null,
    fee: 0,
    date: '2024-01-01',
    notes: null,
    created_at: '2024-01-01T00:00:00Z',
    currency: 'EUR',
    price_last_updated_at: null,
    price_source: null,
    price_currency: 'EUR',
    fee_currency: 'EUR',
    fx_rate_to_eur: 1,
    recurring_rule_id: null,
    is_contribution: false,
    contribution_source: null,
    ...overrides,
  }
}

describe('buildInvestmentChartTimeline — cross-investment contamination guard', () => {
  // Regression test for a real production bug: a caller passed the WHOLE
  // portfolio's transactions (instead of pre-scoping to one investment) and
  // every other holding's buys got replayed into this investment's share
  // count and cost basis — observed as a single small stock position's
  // chart spiking into the millions of euros. The function must be
  // self-defending against this, not rely on every caller filtering first.
  test('a huge buy belonging to a DIFFERENT investment never leaks into this chart', () => {
    const thisInvestment = makeInvestment({ id: 'small-stock', current_price: 6 })
    const transactions: Transaction[] = [
      // This investment's own, real, small history.
      makeTx({ id: 't1', investment_id: 'small-stock', date: '2024-09-04', quantity: 3, price_per_unit: 17.6 }),
      makeTx({ id: 't2', investment_id: 'small-stock', type: 'sell', date: '2024-10-18', quantity: 3, price_per_unit: 30.06 }),
      // A totally unrelated, huge buy on a DIFFERENT investment — must be
      // completely invisible to this chart.
      makeTx({ id: 'huge', investment_id: 'crypto-whale', date: '2026-01-01', quantity: 100, price_per_unit: 72000 }),
    ]

    const points = buildInvestmentChartTimeline(
      thisInvestment,
      transactions,
      [],
      { currentValue: 0, remainingCostBasis: 0, unrealizedProfit: 0 },
      '2026-01-02'
    )

    const maxAbsValue = Math.max(...points.map((p) => Math.abs(p.value_eur ?? 0)), 0)
    const maxAbsCostBasis = Math.max(...points.map((p) => Math.abs(p.cost_basis_eur ?? 0)), 0)
    // The unrelated buy is 100 * 72000 = 7,200,000 — if it leaked in, these
    // would be in the millions. The real history here never exceeds ~€90.
    assert.ok(maxAbsValue < 200, `expected < 200, got ${maxAbsValue}`)
    assert.ok(maxAbsCostBasis < 200, `expected < 200, got ${maxAbsCostBasis}`)
  })

  test('the unrelated huge transaction date does not even appear as a chart point for this investment', () => {
    const thisInvestment = makeInvestment({ id: 'small-stock', current_price: 6 })
    const transactions: Transaction[] = [
      makeTx({ id: 't1', investment_id: 'small-stock', date: '2024-09-04', quantity: 3, price_per_unit: 17.6 }),
      makeTx({ id: 'huge', investment_id: 'crypto-whale', date: '2026-01-01', quantity: 100, price_per_unit: 72000 }),
    ]
    const points = buildInvestmentChartTimeline(
      thisInvestment,
      transactions,
      [],
      { currentValue: 18, remainingCostBasis: 52.8, unrealizedProfit: -34.8 },
      '2026-01-02'
    )
    assert.ok(!points.some((p) => p.date === '2026-01-01'))
  })
})

describe('buildInvestmentChartTimeline — closed position behaviour', () => {
  test('a fully sold position reports null (not a fabricated zero) the day it closes, when no snapshot exists', () => {
    const inv = makeInvestment({ id: 'a', current_price: 6 })
    const transactions: Transaction[] = [
      makeTx({ id: 't1', investment_id: 'a', date: '2024-09-04', quantity: 3, price_per_unit: 17.6 }),
      makeTx({ id: 't2', investment_id: 'a', type: 'sell', date: '2024-10-18', quantity: 3, price_per_unit: 30.06 }),
    ]
    const points = buildInvestmentChartTimeline(
      inv,
      transactions,
      [],
      { currentValue: 0, remainingCostBasis: 0, unrealizedProfit: 0 },
      '2024-10-19'
    )
    const closeDay = points.find((p) => p.date === '2024-10-18')
    assert.equal(closeDay?.value_eur, null)
  })

  test("today's point always uses the live currentMetrics, never a stale snapshot", () => {
    const inv = makeInvestment({ id: 'a', current_price: 50 })
    const transactions: Transaction[] = [
      makeTx({ id: 't1', investment_id: 'a', date: '2024-01-01', quantity: 2, price_per_unit: 10 }),
    ]
    const staleSnapshot = [{ date: '2026-01-02', value_eur: 999999, quantity: 2 }]
    const points = buildInvestmentChartTimeline(
      inv,
      transactions,
      staleSnapshot,
      { currentValue: 100, remainingCostBasis: 20, unrealizedProfit: 80 },
      '2026-01-02'
    )
    const today = points.find((p) => p.date === '2026-01-02')
    assert.equal(today?.value_eur, 100)
  })
})
