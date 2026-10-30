import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { computeInvestmentMetrics, computePortfolioMetrics } from '@/lib/domain/calculations'
import { allTimeMoneyWeightedReturn, modifiedDietz, positionReturn, xirr, xirrDetailed } from '@/lib/domain/returns'
import { allocateSale, isEffectivelyZero, QUANTITY_EPSILON } from '@/lib/domain/cost-basis'
import { tradeAmounts } from '@/lib/domain/trade-amounts'
import { buildExternalCashFlowRows, externalFlowsForReturns } from '@/lib/domain/contributions'
import type { Investment, Transaction } from '@/types/database'

const EUR = { EUR: 1 }

function inv(o: Partial<Investment> = {}): Investment {
  return {
    id: 'inv', user_id: 'u', name: 'X', ticker: null, type: 'ETF', platform: 'P', current_price: 100,
    current_value: null, currency: 'EUR', price_last_updated_at: null, price_source: null, notes: null,
    created_at: '2024-01-01T00:00:00Z', updated_at: '2024-01-01T00:00:00Z', commodity_kind: null, quantity_unit: null,
    ...o,
  }
}
let n = 0
function tx(o: Partial<Transaction>): Transaction {
  n += 1
  return {
    id: `t${n}`, user_id: 'u', investment_id: 'inv', type: 'buy', quantity: null, price_per_unit: null, amount: null,
    fee: 0, date: '2025-01-01', notes: null, created_at: `2024-01-01T00:00:${String(n % 60).padStart(2, '0')}Z`,
    price_currency: 'EUR', fee_currency: 'EUR', fx_rate_to_eur: 1, recurring_rule_id: null, is_contribution: false,
    contribution_source: null, ...o,
  }
}
type Row = [string, 'buy' | 'sell', number, number, number, number, string]
const rows = (id: string, list: Row[]) =>
  list.map(([date, type, quantity, price, amount, fee, source], i) =>
    tx({ investment_id: id, date, type, quantity, price_per_unit: price, amount, fee, source, external_id: `${id}-${i}`,
      created_at: `2024-01-01T00:00:${String(i).padStart(2, '0')}Z` }))

// Source rows (invoices / statements) of the two silver positions.
const HOLLAND_GOLD_SILVER: Row[] = [
  ['2025-11-01', 'buy', 286.5359, 1.39, 400, 1.72, 'source_migration_holland_gold'],
  ['2025-11-04', 'buy', 255.606, 1.36, 350, 2.38, 'source_migration_holland_gold'],
  ['2025-12-01', 'buy', 46.3944, 1.61, 75, 0.31, 'source_migration_holland_gold'],
  ['2026-01-02', 'buy', 35.9254, 2.08, 75, 0.28, 'source_migration_holland_gold'],
  ['2026-01-13', 'sell', 313.093, 2.41, 750, 4.55, 'source_migration_holland_gold'],
  ['2026-01-30', 'sell', 311.3687, 2.81, 869.8, 5.15, 'source_migration_holland_gold'],
]
const GOLDREPUBLIC_SILVER: Row[] = [
  ['2025-02-03', 'buy', 48.9, 1.00838, 50, 0.690218, 'source_migration_goldrepublic'],
  ['2025-03-03', 'buy', 49.416, 0.99785, 50, 0.6902444, 'source_migration_goldrepublic'],
  ['2025-04-01', 'buy', 47.478, 1.0388, 50, 0.6798536, 'source_migration_goldrepublic'],
  ['2025-05-01', 'buy', 52.16, 0.94479, 50, 0.7197536, 'source_migration_goldrepublic'],
  ['2025-06-02', 'buy', 50.973, 0.96698, 50, 0.71012846, 'source_migration_goldrepublic'],
  ['2025-07-01', 'buy', 48.342, 1.02002, 50, 0.69019316, 'source_migration_goldrepublic'],
  ['2025-08-01', 'buy', 46.693, 1.05648, 50, 0.66977936, 'source_migration_goldrepublic'],
  ['2025-09-01', 'buy', 43.071, 1.14601, 50, 0.64020329, 'source_migration_goldrepublic'],
  ['2025-10-01', 'buy', 37.156, 1.33007, 50, 0.57991908, 'source_migration_goldrepublic'],
  ['2025-12-17', 'sell', 424.189, 1.79198, 752.54, 7.6, 'source_migration_goldrepublic'],
  ['2026-02-05', 'buy', 187.573, 2.20869, 420.14, 5.84939063, 'source_migration_goldrepublic'],
  ['2026-05-26', 'buy', 191.941, 2.18765, 425, 5.10027135, 'source_migration_goldrepublic'],
]
const silver = (id: string, platform: string, pricePerGramEur: number) =>
  inv({ id, platform, type: 'commodity', commodity_kind: 'silver', quantity_unit: 'gram', currency: 'EUR', current_price: pricePerGramEur })

describe('silver validation anchors (exact invoice amounts)', () => {
  test('Holland Gold silver: cost €900.00, net proceeds €1,619.80, +€719.80 (+79.98%), fully closed at exactly 0 g', () => {
    const txs = rows('hg', HOLLAND_GOLD_SILVER)
    const m = computeInvestmentMetrics(silver('hg', 'Holland Gold', 1.5), txs, EUR)
    assert.equal(m.quantity, 0)
    assert.equal(m.isClosed, true)
    assert.ok(Math.abs(m.soldCostBasis - 900) < 1e-9)
    assert.ok(Math.abs(m.saleProceeds - 1619.8) < 1e-9)
    assert.ok(Math.abs(m.tradeRealizedProfit - 719.8) < 1e-9)
    assert.ok(Math.abs((m.realizedReturnPct ?? 0) - 719.8 / 900) < 1e-12)
    assert.equal(m.remainingCostBasis, 0)
    assert.equal(m.currentValue, 0)
    assert.equal(positionReturn(m).basis, 'realized_on_sold_cost')
  })

  test('GoldRepublic silver: first cycle €450.00 → €752.54 (+€302.54, +67.23%); current lot cost €845.14', () => {
    const txs = rows('gr', GOLDREPUBLIC_SILVER)
    // Price chosen so the current value is €594.30 (the 28-10 measurement).
    const grams = 187.573 + 191.941
    const m = computeInvestmentMetrics(silver('gr', 'GoldRepublic', 594.3 / grams), txs, EUR)
    assert.ok(Math.abs(m.soldCostBasis - 450) < 1e-9)
    assert.ok(Math.abs(m.saleProceeds - 752.54) < 1e-9)
    assert.ok(Math.abs(m.tradeRealizedProfit - 302.54) < 1e-9)
    assert.ok(Math.abs((m.realizedReturnPct ?? 0) * 100 - 67.231) < 0.001)
    assert.ok(Math.abs(m.remainingCostBasis - 845.14) < 1e-9)
    assert.ok(Math.abs(m.unrealizedProfit - -250.84) < 1e-9)
    assert.ok(Math.abs((m.unrealizedReturnPct ?? 0) * 100 - -29.68) < 0.01)
    assert.equal(positionReturn(m).basis, 'unrealized_on_remaining_cost')

    // Combined silver: realized €1,022.34, unrealized −€250.84, net +€771.50.
    const hg = computeInvestmentMetrics(silver('hg', 'Holland Gold', 1.5), rows('hg', HOLLAND_GOLD_SILVER), EUR)
    const realized = hg.tradeRealizedProfit + m.tradeRealizedProfit
    assert.ok(Math.abs(realized - 1022.34) < 1e-9)
    assert.ok(Math.abs(realized + m.unrealizedProfit - 771.5) < 1e-9)
  })

  test('invoice totals are leading: net-cash sources use the amount, not quantity × rounded price', () => {
    const [buy] = rows('hg', [HOLLAND_GOLD_SILVER[1]])
    const t = tradeAmounts(buy)!
    assert.equal(t.method, 'source_net_cash_amount')
    assert.equal(t.netCashNative, 350)
    assert.ok(Math.abs(t.grossNative - 347.62) < 1e-9)
    // q × p = 347.62416: the 0.4-cent difference is visible, and within tolerance.
    assert.ok(Math.abs(t.deltaVsQuantityPrice - (347.62 - 255.606 * 1.36)) < 1e-12)
    assert.equal(t.consistent, true)
  })

  test('a source without verified amount semantics falls back to quantity × price and is marked derived', () => {
    const t = tradeAmounts(tx({ type: 'buy', quantity: 2, price_per_unit: 10.5, amount: 99, source: 'unknown_csv' }))!
    assert.equal(t.method, 'quantity_x_price')
    assert.equal(t.quality, 'derived')
    assert.equal(t.grossNative, 21)
  })
})

describe('cost basis (moving average, central)', () => {
  test('a floating-point residue is economically zero and closes the position with all remaining cost', () => {
    assert.ok(isEffectivelyZero(5.68e-14))
    assert.ok(!isEffectivelyZero(1e-6))
    const s = allocateSale(10 + 5.68e-14, 1000, 1000, 10)!
    assert.equal(s.closesPosition, true)
    assert.equal(s.soldCostEur, 1000)
    assert.ok(QUANTITY_EPSILON <= 1e-9)
  })

  test('partial sale with moving average, then a full close realises total proceeds − total cost', () => {
    const txs = [
      tx({ type: 'buy', quantity: 10, price_per_unit: 100, date: '2025-01-02' }),
      tx({ type: 'buy', quantity: 10, price_per_unit: 120, date: '2025-02-02' }),
      tx({ type: 'sell', quantity: 5, price_per_unit: 130, fee: 1, date: '2025-03-02' }),
    ]
    const partial = computeInvestmentMetrics(inv({ current_price: 125 }), txs, EUR)
    // average cost 110 → 5 sold cost 550; proceeds 650 − 1 = 649
    assert.equal(partial.soldCostBasis, 550)
    assert.equal(partial.tradeRealizedProfit, 99)
    assert.equal(partial.remainingCostBasis, 1650)
    assert.equal(partial.unrealizedReturnPct, (15 * 125 - 1650) / 1650)

    const full = computeInvestmentMetrics(
      inv(),
      [...txs, tx({ type: 'sell', quantity: 15, price_per_unit: 90, fee: 2, date: '2025-04-02' })],
      EUR
    )
    assert.equal(full.isClosed, true)
    // total proceeds (649 + 1348) − total cost 2200
    assert.equal(full.tradeRealizedProfit, 649 + 1348 - 2200)
  })

  test('a gram-tracked metal sold partly and then fully', () => {
    const metal = inv({ id: 'm', type: 'commodity', commodity_kind: 'gold', quantity_unit: 'gram', current_price: 120 })
    const buys = [tx({ investment_id: 'm', type: 'buy', quantity: 10, price_per_unit: 100, date: '2025-01-02' })]
    const half = computeInvestmentMetrics(metal, [...buys, tx({ investment_id: 'm', type: 'sell', quantity: 4, price_per_unit: 110, date: '2025-02-01' })], EUR)
    assert.equal(half.quantity, 6)
    assert.equal(half.remainingCostBasis, 600)
    assert.equal(half.currentValue, 720)
    const all = computeInvestmentMetrics(metal, [...buys,
      tx({ investment_id: 'm', type: 'sell', quantity: 4, price_per_unit: 110, date: '2025-02-01' }),
      tx({ investment_id: 'm', type: 'sell', quantity: 6.0000000000001, price_per_unit: 115, date: '2025-03-01' })], EUR)
    assert.equal(all.isClosed, true)
    assert.equal(all.currentValue, 0)
  })
})

describe('portfolio returns', () => {
  test('XIRR matches the reference example (≈ 37.34%) and solves irregular flows', () => {
    const r = xirr([
      { date: '2008-01-01', amount: -10000 },
      { date: '2008-03-01', amount: 2750 },
      { date: '2008-10-30', amount: 4250 },
      { date: '2009-02-15', amount: 3250 },
      { date: '2009-04-01', amount: 2750 },
    ])
    assert.ok(r !== null && Math.abs(r - 0.373362535) < 1e-6)
    assert.ok(Math.abs((xirr([{ date: '2025-01-01', amount: -1000 }, { date: '2026-01-01', amount: 1100 }]) ?? 0) - 0.1) < 1e-9)
  })

  test('no percentage when the flows cannot define one or data is missing', () => {
    assert.equal(xirr([{ date: '2025-01-01', amount: -1000 }]), null)
    assert.equal(xirr([{ date: '2025-01-01', amount: -1000 }, { date: '2026-01-01', amount: -5 }]), null)
    assert.equal(xirr([{ date: '2025-01-01', amount: -1000 }, { date: '2026-01-01', amount: NaN }]), null)
    assert.equal(allTimeMoneyWeightedReturn([{ date: '2025-01-01', amountEur: 1000 }], NaN, '2026-01-01').annualRate, null)
    assert.equal(allTimeMoneyWeightedReturn([{ date: '2025-01-01', amountEur: NaN }], 1100, '2026-01-01').annualRate, null)
    assert.equal(modifiedDietz(null, 1000, [], '2026-01-01', '2026-06-30').returnPercent, null)
  })

  test('Modified Dietz with several deposits and a withdrawal on their real dates', () => {
    // 2026: start 1000, +500 on day 90, −200 on day 270, end 1450 (period 360 days).
    const res = modifiedDietz(1000, 1450, [
      { date: '2026-04-01', amountEur: 500 },
      { date: '2026-09-28', amountEur: -200 },
    ], '2026-01-01', '2026-12-27')
    const days = 360
    const w1 = (days - 90) / days
    const w2 = (days - 270) / days
    const expected = ((1450 - 1000 - 300) / (1000 + 500 * w1 - 200 * w2)) * 100
    assert.ok(Math.abs((res.returnPercent ?? 0) - expected) < 1e-9)
    assert.equal(res.gainEur, 150)
  })

  test('re-investing sale proceeds is not new money: the same euro never enters a return denominator twice', () => {
    const a = inv({ id: 'a', current_price: 0 })
    const b = inv({ id: 'b', current_price: 120 })
    const txs = [
      tx({ investment_id: 'a', type: 'buy', quantity: 10, price_per_unit: 100, date: '2025-01-02' }),
      tx({ investment_id: 'a', type: 'sell', quantity: 10, price_per_unit: 110, date: '2025-07-01' }),
      tx({ investment_id: 'b', type: 'buy', quantity: 10, price_per_unit: 110, date: '2025-07-01' }),
    ]
    const flows = buildExternalCashFlowRows(
      [{ flow_date: '2025-01-02', year: 2025, direction: 'to_portfolio', amount_eur: 1000 }],
      txs
    )
    assert.equal(flows.rows.length, 1) // the €1,100 re-buy is NOT a contribution
    const p = computePortfolioMetrics([a, b], txs, EUR)
    assert.equal(p.totalEverInvested, 2100) // purchase volume counts the euro twice …
    const mwr = allTimeMoneyWeightedReturn(externalFlowsForReturns(flows), p.totalValue, '2026-01-02')
    assert.equal(mwr.netContributionsEur, 1000) // … the return denominator does not
    assert.ok(mwr.annualRate !== null && Math.abs(mwr.annualRate - 0.2) < 1e-9) // 1000 → 1200 in one year
    assert.ok(Math.abs((p.resultVsPurchaseVolumePct ?? 0) - 200 / 2100) < 1e-12) // not a return
  })
})

describe('XIRR uniqueness', () => {
  test('two valid rates → "not unambiguous", never an arbitrary pick', () => {
    // −100, +230, −132 over two years has roots 10% and 20%.
    const flows = [
      { date: '2024-01-01', amount: -100 },
      { date: '2025-01-01', amount: 230 },
      { date: '2026-01-01', amount: -132 },
    ]
    const r = xirrDetailed(flows)
    assert.equal(r.status, 'multiple')
    assert.equal(r.rate, null)
    assert.equal(r.roots.length, 2)
    assert.equal(xirr(flows), null)
    // Same pattern as external flows: deposit 100, withdraw 230, deposit 132, value 0.
    const mwr = allTimeMoneyWeightedReturn(
      [
        { date: '2024-01-01', amountEur: 100 },
        { date: '2025-01-01', amountEur: -230 },
        { date: '2026-01-01', amountEur: 132 },
      ],
      0,
      '2026-01-01'
    )
    assert.equal(mwr.annualRate, null)
    assert.match(mwr.unavailableReason ?? '', /Not unambiguous: these cash flows allow 2 different rates/)
  })

  test('ordinary deposit/withdrawal histories have exactly one root', () => {
    const r = xirrDetailed([
      { date: '2025-01-01', amount: -1000 },
      { date: '2025-06-01', amount: -500 },
      { date: '2025-09-01', amount: 200 },
      { date: '2026-01-01', amount: 1500 },
    ])
    assert.equal(r.status, 'unique')
    assert.equal(r.roots.length, 1)
  })
})

describe('order-PDF amounts', () => {
  test('the Alphabet order PDF row: gross €438.00 + €1.00 fee = cost €439.00 exactly', () => {
    const t = tx({ type: 'buy', quantity: 1.737405, price_per_unit: 252.1, amount: 438, fee: 1, source: 'trade_republic_order_pdf' })
    const a = tradeAmounts(t)!
    assert.equal(a.method, 'source_gross_amount')
    assert.equal(a.grossNative, 438)
    assert.equal(a.netCashNative, 439)
    const m = computeInvestmentMetrics(inv({ current_price: 251.7 }), [t], EUR)
    assert.equal(m.remainingCostBasis, 439)
  })
})
