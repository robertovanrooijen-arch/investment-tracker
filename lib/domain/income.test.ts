import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { computeInvestmentMetrics, computePortfolioMetrics } from '@/lib/domain/calculations'
import {
  computeAssetYearRows,
  computeYearPortfolioSummary,
  computeInvestmentYtdRows,
} from '@/lib/domain/year-analysis'
import type { Investment, Transaction } from '@/types/database'

const YEAR = new Date().getFullYear()
const IN_YEAR = `${YEAR}-03-15`

function makeInvestment(overrides: Partial<Investment> = {}): Investment {
  return {
    id: 'inv-1',
    user_id: 'u1',
    name: 'Test',
    ticker: null,
    type: 'stock',
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

let seq = 0
function makeTx(overrides: Partial<Transaction>): Transaction {
  seq += 1
  return {
    id: `tx-${seq}`,
    user_id: 'u1',
    investment_id: 'inv-1',
    type: 'buy',
    quantity: null,
    price_per_unit: null,
    amount: null,
    fee: 0,
    date: IN_YEAR,
    notes: null,
    created_at: `2024-01-01T00:00:${String(seq % 60).padStart(2, '0')}Z`,
    price_currency: 'EUR',
    fee_currency: 'EUR',
    fx_rate_to_eur: 1,
    recurring_rule_id: null,
    is_contribution: false,
    contribution_source: null,
    ...overrides,
  }
}

const buy = (o: Partial<Transaction> = {}) =>
  makeTx({ type: 'buy', quantity: 10, price_per_unit: 100, ...o })

function yearRealized(investments: Investment[], txs: Transaction[], fx = { EUR: 1 } as Record<string, number>) {
  const rows = computeAssetYearRows(investments, txs, YEAR, fx)
  const summary = computeYearPortfolioSummary(YEAR, rows, [], [], txs, 0)
  return { rows, summary }
}

describe('dividend / interest income on unit-based holdings', () => {
  test('a gross dividend without tax is realized profit on Dashboard and Year Analysis', () => {
    const inv = makeInvestment()
    const txs = [buy(), makeTx({ type: 'dividend', amount: 20 })]

    const m = computeInvestmentMetrics(inv, txs, { EUR: 1 })
    assert.equal(m.realizedProfit, 20)
    assert.equal(m.quantity, 10)
    assert.equal(m.remainingCostBasis, 1000)

    const { rows, summary } = yearRealized([inv], txs)
    assert.equal(rows[0].realizedPLInYearEur, 20)
    assert.equal(rows[0].dividendsInterestInYearEur, 20)
    assert.equal(summary.realizedPLInYearEur, 20)
  })

  test('a gross dividend with tax booked as a separate fee row nets to dividend minus tax, once', () => {
    const inv = makeInvestment()
    const txs = [
      buy(),
      makeTx({ type: 'dividend', amount: 20 }),
      makeTx({ type: 'fee', amount: 3, notes: 'Dividend tax' }),
    ]

    const m = computeInvestmentMetrics(inv, txs, { EUR: 1 })
    assert.equal(m.realizedProfit, 17)

    const { rows, summary } = yearRealized([inv], txs)
    assert.equal(rows[0].realizedPLInYearEur, 17)
    // Gross stays visible as information; the tax shows up as a fee.
    assert.equal(rows[0].dividendsInterestInYearEur, 20)
    assert.equal(rows[0].feesPaidInYearEur, 3)
    assert.equal(summary.totalPLEur, summary.realizedPLInYearEur + summary.currentUnrealizedPLEur)
  })

  test('tax withheld on the dividend row itself (fee field) is netted exactly once', () => {
    const inv = makeInvestment()
    const txs = [buy(), makeTx({ type: 'dividend', amount: 20, fee: 3 })]

    assert.equal(computeInvestmentMetrics(inv, txs, { EUR: 1 }).realizedProfit, 17)
    const { rows } = yearRealized([inv], txs)
    assert.equal(rows[0].realizedPLInYearEur, 17)
    assert.equal(rows[0].dividendsInterestInYearEur, 20)
    assert.equal(rows[0].feesPaidInYearEur, 3)
  })

  test('interest/bonus on a crypto holding is realized profit and never changes quantity or cost basis', () => {
    const inv = makeInvestment({ type: 'crypto', current_price: 50000 })
    const txs = [
      buy({ quantity: 0.01, price_per_unit: 50000, fee: 1 }),
      makeTx({ type: 'interest', amount: 10, notes: 'Platform bonus' }),
      makeTx({ type: 'interest', amount: 0.06, notes: 'Rebate' }),
    ]

    const m = computeInvestmentMetrics(inv, txs, { EUR: 1 })
    assert.ok(Math.abs(m.realizedProfit - 10.06) < 1e-9)
    assert.equal(m.quantity, 0.01)
    assert.equal(m.remainingCostBasis, 501)
    assert.equal(m.unrealizedProfit, -1)
  })

  test('a USD dividend uses the row\'s own historical FX rate, gross and withheld tax alike', () => {
    const inv = makeInvestment({ currency: 'USD', current_price: 100 })
    const txs = [
      buy({ price_currency: 'USD', fee_currency: 'EUR', fx_rate_to_eur: 0.9, fee: 2 }),
      makeTx({
        type: 'dividend',
        amount: 2.91,
        fee: 0.44,
        price_currency: 'USD',
        fee_currency: 'USD',
        fx_rate_to_eur: 0.872852,
      }),
    ]
    // A deliberately different live USD rate proves the historical rate is used.
    const fx = { EUR: 1, USD: 0.5 }

    const expectedNetEur = (2.91 - 0.44) * 0.872852
    const m = computeInvestmentMetrics(inv, txs, fx)
    assert.ok(Math.abs(m.realizedProfit - expectedNetEur) < 1e-9)

    // Native (USD) view nets in USD, no FX.
    const native = computeInvestmentMetrics(inv, txs)
    assert.ok(Math.abs(native.realizedProfit - 2.47) < 1e-9)

    const { rows } = yearRealized([inv], txs, fx)
    assert.ok(Math.abs(rows[0].realizedPLInYearEur - expectedNetEur) < 1e-9)
    assert.ok(Math.abs(rows[0].dividendsInterestInYearEur - 2.91 * 0.872852) < 1e-9)
  })

  test('Dashboard and Year Analysis report the same net realized result when every transaction is in the selected year', () => {
    const stock = makeInvestment({ id: 'a', current_price: 120 })
    const crypto = makeInvestment({ id: 'b', type: 'crypto', current_price: 60000 })
    const txs = [
      buy({ investment_id: 'a' }),
      makeTx({ investment_id: 'a', type: 'dividend', amount: 30, fee: 4.5 }),
      makeTx({ investment_id: 'a', type: 'fee', amount: 1.25 }),
      makeTx({ investment_id: 'a', type: 'sell', quantity: 4, price_per_unit: 130, fee: 1, date: `${YEAR}-04-01` }),
      buy({ investment_id: 'b', quantity: 0.02, price_per_unit: 50000, fee: 0.5 }),
      makeTx({ investment_id: 'b', type: 'interest', amount: 10 }),
    ]

    const dashboard = computePortfolioMetrics([stock, crypto], txs, { EUR: 1 })
    const { summary } = yearRealized([stock, crypto], txs)

    assert.ok(Math.abs(dashboard.totalRealized - summary.realizedPLInYearEur) < 1e-9)
    assert.ok(Math.abs(dashboard.totalUnrealized - summary.currentUnrealizedPLEur) < 1e-9)
    assert.ok(Math.abs(dashboard.totalProfit - summary.totalPLEur) < 1e-9)
    // 30 - 4.5 dividend net, -1.25 fee, sell 4×130-1 - 400 = 119, +10 interest
    assert.ok(Math.abs(dashboard.totalRealized - (25.5 - 1.25 + 119 + 10)) < 1e-9)
  })

  test('per-investment YTD growth includes net dividend income (paid out of the position), not the gross', () => {
    const inv = makeInvestment({ current_price: 100 })
    const txs = [
      buy({ date: `${YEAR - 1}-06-01` }),
      makeTx({ type: 'dividend', amount: 20 }),
      makeTx({ type: 'fee', amount: 3 }),
    ]
    const ytd = computeInvestmentYtdRows([inv], txs, YEAR, { EUR: 1 }, [
      { investment_id: 'inv-1', date: `${YEAR}-01-01`, value_eur: 1000 },
    ])
    // Price unchanged (start 1000, end 1000) → growth is exactly the net income.
    assert.equal(ytd[0].ytdGrowthEur, 17)
  })
})
