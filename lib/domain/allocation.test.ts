import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { buildPortfolioAllocation } from '@/lib/domain/allocation'
import type { Investment, Transaction } from '@/types/database'

function makeInvestment(overrides: Partial<Investment>): Investment {
  return {
    id: 'inv-1',
    user_id: 'u1',
    name: 'Test',
    ticker: null,
    type: 'ETF',
    platform: 'DEGIRO',
    current_price: 100,
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
    price_currency: 'EUR',
    fee_currency: 'EUR',
    fx_rate_to_eur: 1,
    recurring_rule_id: null,
    is_contribution: false,
    contribution_source: null,
    ...overrides,
  }
}

describe('buildPortfolioAllocation — economic-identifier dedupe', () => {
  test('merges the same ticker held across two separate Investment rows (e.g. two brokers)', () => {
    // Mirrors the real bug: "Nasdaq 100 · EQQB.DE" existed as two Investment
    // rows (Trade Republic + DEGIRO) and showed up twice on the allocation
    // page instead of as one combined holding.
    const tradeRepublic = makeInvestment({ id: 'a', name: 'Nasdaq 100', ticker: 'EQQB.DE', platform: 'Trade Republic', current_price: 450 })
    const degiro = makeInvestment({ id: 'b', name: 'Nasdaq 100', ticker: 'EQQB.DE', platform: 'DEGIRO', current_price: 450 })

    const transactions: Transaction[] = [
      makeBuy({ id: 't1', investment_id: 'a', quantity: 10, price_per_unit: 300 }),
      makeBuy({ id: 't2', investment_id: 'b', quantity: 2, price_per_unit: 300 }),
    ]

    const allocation = buildPortfolioAllocation([tradeRepublic, degiro], transactions)
    const etfCategory = allocation.categories.find((c) => c.type === 'ETF')!

    assert.equal(etfCategory.holdings.length, 1, 'the two rows must collapse into one holding')
    assert.equal(etfCategory.holdings[0].value, 10 * 450 + 2 * 450)
    assert.equal(etfCategory.holdings[0].name, 'Nasdaq 100')
  })

  test('does not merge different tickers, even with the same name', () => {
    const a = makeInvestment({ id: 'a', name: 'Fund X', ticker: 'AAA', current_price: 100 })
    const b = makeInvestment({ id: 'b', name: 'Fund X', ticker: 'BBB', current_price: 100 })
    const transactions: Transaction[] = [
      makeBuy({ id: 't1', investment_id: 'a', quantity: 1, price_per_unit: 100 }),
      makeBuy({ id: 't2', investment_id: 'b', quantity: 1, price_per_unit: 100 }),
    ]

    const allocation = buildPortfolioAllocation([a, b], transactions)
    const etfCategory = allocation.categories.find((c) => c.type === 'ETF')!
    assert.equal(etfCategory.holdings.length, 2)
  })

  test('falls back to name when neither row has a ticker', () => {
    const a = makeInvestment({ id: 'a', name: 'Solid Power', ticker: null, type: 'stock', current_price: 10 })
    const b = makeInvestment({ id: 'b', name: 'Solid Power', ticker: null, type: 'stock', current_price: 10 })
    const transactions: Transaction[] = [
      makeBuy({ id: 't1', investment_id: 'a', quantity: 5, price_per_unit: 10 }),
      makeBuy({ id: 't2', investment_id: 'b', quantity: 3, price_per_unit: 10 }),
    ]

    const allocation = buildPortfolioAllocation([a, b], transactions)
    const stockCategory = allocation.categories.find((c) => c.type === 'stock')!
    assert.equal(stockCategory.holdings.length, 1)
    assert.equal(stockCategory.holdings[0].value, 80)
  })

  test('chart and list derive from the same holdings array (categoryPct/portfolioPct recomputed from the merged value)', () => {
    const a = makeInvestment({ id: 'a', ticker: 'EQQB.DE', current_price: 100 })
    const b = makeInvestment({ id: 'b', ticker: 'EQQB.DE', current_price: 100 })
    const other = makeInvestment({ id: 'c', ticker: 'OTHER', current_price: 100 })
    const transactions: Transaction[] = [
      makeBuy({ id: 't1', investment_id: 'a', quantity: 1, price_per_unit: 100 }),
      makeBuy({ id: 't2', investment_id: 'b', quantity: 1, price_per_unit: 100 }),
      makeBuy({ id: 't3', investment_id: 'c', quantity: 2, price_per_unit: 100 }),
    ]

    const allocation = buildPortfolioAllocation([a, b, other], transactions)
    const etfCategory = allocation.categories.find((c) => c.type === 'ETF')!
    const merged = etfCategory.holdings.find((h) => h.name === 'Test')!

    // merged value = 100 + 100 = 200; category total = 200 + 200 (other) = 400
    assert.equal(merged.value, 200)
    assert.equal(merged.categoryPct, 200 / 400)
    assert.equal(merged.portfolioPct, 200 / 400)
  })

  test('gold/silver commodity rows are still merged by metal, unaffected by the ticker dedupe path', () => {
    const gold1 = makeInvestment({ id: 'g1', name: 'Gold', type: 'commodity', commodity_kind: 'gold', ticker: 'GC=F', current_price: 100 })
    const gold2 = makeInvestment({ id: 'g2', name: 'test gold', type: 'commodity', commodity_kind: 'gold', ticker: 'GC=F', current_price: 100 })
    const transactions: Transaction[] = [
      makeBuy({ id: 't1', investment_id: 'g1', quantity: 1, price_per_unit: 100 }),
      makeBuy({ id: 't2', investment_id: 'g2', quantity: 1, price_per_unit: 100 }),
    ]
    const allocation = buildPortfolioAllocation([gold1, gold2], transactions)
    const commodityCategory = allocation.categories.find((c) => c.type === 'commodity')!
    assert.equal(commodityCategory.holdings.length, 1)
    assert.equal(commodityCategory.holdings[0].name, 'Gold')
    assert.equal(commodityCategory.holdings[0].value, 200)
  })
})
