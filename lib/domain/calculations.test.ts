import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { computePerformanceByCategory } from '@/lib/domain/calculations'
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

function makeBuy(overrides: Partial<Transaction>): Transaction {
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

describe('computePerformanceByCategory', () => {
  test('groups all-time profit and invested amounts by key', () => {
    const stockA = makeInvestment({ id: 'a', type: 'stock', current_price: 150 })
    const stockB = makeInvestment({ id: 'b', type: 'stock', current_price: 50 })
    const etf = makeInvestment({ id: 'c', type: 'ETF', current_price: 120 })

    const transactions: Transaction[] = [
      makeBuy({ id: 't1', investment_id: 'a', quantity: 1, price_per_unit: 100 }),
      makeBuy({ id: 't2', investment_id: 'b', quantity: 1, price_per_unit: 100 }),
      makeBuy({ id: 't3', investment_id: 'c', quantity: 1, price_per_unit: 100 }),
    ]

    const rows = computePerformanceByCategory(
      [stockA, stockB, etf],
      transactions,
      (inv) => inv.type
    )

    const stockRow = rows.find((r) => r.key === 'stock')!
    const etfRow = rows.find((r) => r.key === 'ETF')!

    // stockA: +50 profit (150-100), stockB: -50 profit (50-100) => net 0
    assert.equal(stockRow.totalProfit, 0)
    assert.equal(stockRow.totalEverInvested, 200)
    assert.equal(stockRow.totalProfitPct, 0)

    // etf: +20 profit on 100 invested => +20%
    assert.equal(etfRow.totalProfit, 20)
    assert.equal(etfRow.totalEverInvested, 100)
    assert.equal(etfRow.totalProfitPct, 0.2)
  })

  test('excludes cash-like holdings from profit, same rule as computePortfolioMetrics', () => {
    const cash = makeInvestment({ id: 'cash1', type: 'cash', current_value: 500 })
    const rows = computePerformanceByCategory([cash], [], (inv) => inv.type)
    assert.equal(rows.length, 0)
  })

  test('a deposit alone never produces positive "profit" for a cash-like row', () => {
    // Guards the exact bug class this feature is meant to avoid: a deposit
    // must never look like investment profit, for any grouping.
    const cash = makeInvestment({ id: 'cash1', type: 'cash', current_value: 1000 })
    const deposit = makeBuy({
      id: 'd1',
      investment_id: 'cash1',
      type: 'deposit',
      quantity: null,
      price_per_unit: null,
      amount: 1000,
    })
    const rows = computePerformanceByCategory([cash], [deposit], (inv) => inv.type)
    // Cash is excluded entirely — never contributes a profit figure.
    assert.equal(rows.length, 0)
  })

  test('returns null percent (not NaN/Infinity) when nothing was ever invested', () => {
    const inv = makeInvestment({ id: 'z', type: 'stock', current_price: 0 })
    const rows = computePerformanceByCategory([inv], [], (i) => i.type)
    assert.equal(rows.length, 1)
    assert.equal(rows[0].totalProfit, 0)
    assert.equal(rows[0].totalEverInvested, 0)
    assert.equal(rows[0].totalProfitPct, null)
  })
})
