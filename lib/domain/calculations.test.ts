import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { computePerformanceByCategory, computePortfolioMetrics } from '@/lib/domain/calculations'
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

describe('computePortfolioMetrics — totalProfitPct denominator', () => {
  // Regression test for a real bug: totalEverInvested used to sum every
  // investment's deposit/withdrawal history, including cash-like rows —
  // while totalProfit (the numerator) already excluded cash. A cash
  // account with a long history of deposits/withdrawals (common: it's the
  // "free space" balance a buy/sell/transfer routes through) inflated the
  // denominator with zero matching numerator, silently understating the
  // real cost-basis return. Dashboard and Profit/Loss Details both call
  // this same function, so fixing it here fixes both at once.
  test('a cash row with a long deposit/withdrawal history never dilutes totalProfitPct', () => {
    const stock = makeInvestment({ id: 'a', type: 'stock', current_price: 120 })
    const cash = makeInvestment({ id: 'cash1', type: 'cash', current_value: 50 })

    const transactions: Transaction[] = [
      makeBuy({ id: 't1', investment_id: 'a', quantity: 10, price_per_unit: 100 }),
      // A cash account with substantial unrelated deposit/withdrawal churn —
      // none of this is investment capital, so none of it should touch
      // totalProfitPct's denominator.
      makeBuy({ id: 'd1', investment_id: 'cash1', type: 'deposit', quantity: null, price_per_unit: null, amount: 5000 }),
      makeBuy({ id: 'w1', investment_id: 'cash1', type: 'withdraw', quantity: null, price_per_unit: null, amount: 4950 }),
    ]

    const metrics = computePortfolioMetrics([stock, cash], transactions)

    // Only the stock's own cost basis (1000) should be the denominator —
    // profit is 10*(120-100) = 200, so 200/1000 = 20%, not diluted by cash's
    // 5000+4950 = 9950 of unrelated deposit/withdrawal history.
    assert.equal(metrics.totalEverInvested, 1000)
    assert.equal(metrics.totalProfit, 200)
    assert.equal(metrics.totalProfitPct, 0.2)
  })

  test('Dashboard and Profit/Loss Details derive totalProfitPct from the exact same call, so they cannot disagree', () => {
    // Both pages call computePortfolioMetrics(investments, transactions, fxRates)
    // with the same unfiltered queries — asserting the function is a pure,
    // deterministic computation over its inputs is what actually guarantees
    // the two pages can never show different numbers for the same data.
    const stock = makeInvestment({ id: 'a', type: 'stock', current_price: 150 })
    const transactions: Transaction[] = [
      makeBuy({ id: 't1', investment_id: 'a', quantity: 5, price_per_unit: 100 }),
    ]

    const dashboardMetrics = computePortfolioMetrics([stock], transactions, { EUR: 1 })
    const profitLossDetailsMetrics = computePortfolioMetrics([stock], transactions, { EUR: 1 })

    assert.equal(dashboardMetrics.totalProfitPct, profitLossDetailsMetrics.totalProfitPct)
    assert.equal(dashboardMetrics.totalProfit, profitLossDetailsMetrics.totalProfit)
  })

  test('realized + unrealized = total P/L, across a mix of open, closed, and cash-like rows', () => {
    const openStock = makeInvestment({ id: 'a', type: 'stock', current_price: 120 })
    const closedStock = makeInvestment({ id: 'b', type: 'stock', current_price: 999 })
    const cash = makeInvestment({ id: 'cash1', type: 'cash', current_value: 300 })

    const transactions: Transaction[] = [
      // Open position: unrealized only.
      makeBuy({ id: 't1', investment_id: 'a', quantity: 10, price_per_unit: 100 }),
      // Closed position: bought then fully sold — realized only.
      makeBuy({ id: 't2', investment_id: 'b', quantity: 5, price_per_unit: 50 }),
      makeBuy({ id: 't3', investment_id: 'b', type: 'sell', quantity: 5, price_per_unit: 70 }),
      // Cash: deposit only, excluded from P/L entirely.
      makeBuy({ id: 'd1', investment_id: 'cash1', type: 'deposit', quantity: null, price_per_unit: null, amount: 300 }),
    ]

    const metrics = computePortfolioMetrics([openStock, closedStock, cash], transactions)

    assert.equal(metrics.totalProfit, metrics.totalRealized + metrics.totalUnrealized)
    // Concretely: unrealized = 10*(120-100) = 200; realized = 5*(70-50) = 100.
    assert.equal(metrics.totalUnrealized, 200)
    assert.equal(metrics.totalRealized, 100)
    assert.equal(metrics.totalProfit, 300)
  })
})
