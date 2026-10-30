import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import {
  computeAllocation,
  computeInvestmentMetrics,
  computePortfolioMetrics,
  txFeeInEur,
  txFeeInPriceCurrency,
  txNativeToEur,
  txPriceRateToEur,
} from '@/lib/domain/calculations'
import { computeAssetYearRows, computeYearPortfolioSummary } from '@/lib/domain/year-analysis'
import { buildExternalCashFlowRows } from '@/lib/domain/contributions'
import { buildPortfolioAllocation } from '@/lib/domain/allocation'
import type { Investment, Transaction } from '@/types/database'

const YEAR = new Date().getFullYear()

function makeInvestment(overrides: Partial<Investment> = {}): Investment {
  return {
    id: 'inv-1',
    user_id: 'u1',
    name: 'US stock',
    ticker: null,
    type: 'stock',
    platform: 'DEGIRO',
    current_price: 110,
    current_value: null,
    currency: 'USD',
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
    quantity: 10,
    price_per_unit: 100,
    amount: null,
    fee: 0,
    date: `${YEAR}-02-10`,
    notes: null,
    created_at: `2024-01-01T00:00:${String(seq % 60).padStart(2, '0')}Z`,
    price_currency: 'USD',
    fee_currency: 'EUR',
    fx_rate_to_eur: 0.9,
    recurring_rule_id: null,
    is_contribution: false,
    contribution_source: null,
    ...overrides,
  }
}

// Live USD rate deliberately different from the historical 0.9.
const LIVE = { EUR: 1, USD: 0.5 }

describe('historical FX policy', () => {
  test('a USD buy uses its own historical rate for cost basis; only current valuation uses today\'s rate', () => {
    const m = computeInvestmentMetrics(makeInvestment(), [makeTx({ fee: 2 })], LIVE)
    assert.equal(m.remainingCostBasis, 10 * 100 * 0.9 + 2)
    assert.equal(m.currentValue, 10 * 110 * 0.5)
    assert.equal(m.unrealizedProfit, 550 - 902)
    assert.equal(m.fxStatus, 'complete')
  })

  test('a EUR fee on a USD trade is never multiplied by the USD rate', () => {
    const tx = makeTx({ fee: 2 })
    assert.equal(txFeeInEur(tx, LIVE), 2)
    // Native (USD) view converts the EUR fee via the row's own rate.
    assert.ok(Math.abs(txFeeInPriceCurrency(tx, LIVE) - 2 / 0.9) < 1e-12)
  })

  test('an IMPORTED USD transaction without FX is missing — never today\'s rate, never 1; totals fail closed', () => {
    const tx = makeTx({ fx_rate_to_eur: null, source: 'degiro_csv', external_id: 'order-1' })
    assert.equal(txPriceRateToEur(tx, LIVE).basis, 'missing')
    assert.ok(Number.isNaN(txNativeToEur(1000, tx, LIVE)))

    const inv = makeInvestment()
    const m = computeInvestmentMetrics(inv, [tx], LIVE)
    assert.equal(m.fxStatus, 'incomplete')
    assert.ok(Number.isNaN(m.remainingCostBasis))

    // A second, fully known EUR position must NOT turn the unknown P/L into a
    // believable partial total.
    const eurInv = makeInvestment({ id: 'eur', currency: 'EUR', current_price: 10 })
    const eurTx = makeTx({ id: 'eur-buy', investment_id: 'eur', price_currency: 'EUR', fee_currency: 'EUR', fx_rate_to_eur: 1, price_per_unit: 8 })
    const p = computePortfolioMetrics([inv, eurInv], [tx, eurTx], LIVE)
    assert.equal(p.fxIncompleteCount, 1)
    assert.equal(p.complete, false)
    for (const v of [p.totalInvested, p.totalUnrealized, p.totalProfit, p.totalEverInvested]) {
      assert.ok(Number.isNaN(v), 'unknown, never a partial sum')
    }
    // Realized is genuinely known here: nothing was sold.
    assert.equal(p.totalRealized, 0)
    assert.equal(p.resultVsPurchaseVolumePct, null)
    // Today's value IS fully known (live rate for current valuation is allowed).
    assert.equal(p.totalValue, 550 + 100)
  })

  test('a legacy manual USD row without FX keeps the live-rate fallback but is flagged', () => {
    const tx = makeTx({ fx_rate_to_eur: null })
    assert.deepEqual(txPriceRateToEur(tx, LIVE), { rate: 0.5, basis: 'live_fallback' })
    const m = computeInvestmentMetrics(makeInvestment(), [tx], LIVE)
    assert.equal(m.remainingCostBasis, 500)
    assert.equal(m.fxStatus, 'live_rate_fallback')
    assert.equal(computePortfolioMetrics([makeInvestment()], [tx], LIVE).fxLiveFallbackCount, 1)
  })

  test('no rate at all yields no fabricated or too-low result on Dashboard, allocation and Year Analysis', () => {
    const inv = makeInvestment({ currency: 'CHF' })
    const tx = makeTx({ price_currency: 'CHF', fee_currency: 'CHF', fx_rate_to_eur: null, fee: 1 })
    const m = computeInvestmentMetrics(inv, [tx], LIVE)
    assert.equal(m.fxStatus, 'incomplete')
    assert.ok(Number.isNaN(m.currentValue))
    assert.ok(Number.isNaN(m.remainingCostBasis))

    const eurInv = makeInvestment({ id: 'eur', currency: 'EUR', current_price: 10 })
    const eurTx = makeTx({ id: 'eur-buy', investment_id: 'eur', price_currency: 'EUR', fee_currency: 'EUR', fx_rate_to_eur: 1, price_per_unit: 8 })
    const invs = [inv, eurInv]
    const txs = [tx, eurTx]

    const p = computePortfolioMetrics(invs, txs, LIVE)
    assert.ok(Number.isNaN(p.totalValue), 'never the EUR-only 100 as if it were the whole portfolio')
    assert.equal(p.complete, false)
    assert.equal(p.fxIncompleteCount, 1)

    assert.deepEqual(computeAllocation(invs, txs, (i) => i.type, LIVE), [])
    const alloc = buildPortfolioAllocation(invs, txs, LIVE)
    assert.equal(alloc.fxIncompleteCount, 1)
    assert.equal(alloc.categories.length, 0)
    assert.ok(Number.isNaN(alloc.totalValue))

    const rows = computeAssetYearRows(invs, txs, YEAR, LIVE)
    assert.equal(rows.find((r) => r.investmentId === 'inv-1')?.fxIncomplete, true)
    const summary = computeYearPortfolioSummary(
      YEAR, rows, [{ date: `${YEAR}-01-01`, total_value_eur: 0 }], [], txs, p.totalValue
    )
    assert.equal(summary.fxIncompleteCount, 1)
    assert.ok(Number.isNaN(summary.totalPLEur))
    assert.ok(Number.isNaN(summary.totalBuysEur))
    assert.ok(Number.isNaN(summary.endValueEur))
    assert.equal(summary.modifiedDietzReturnPercent, null)
  })

  test('DEGIRO AutoFX booked as a separate EUR fee row is counted once, at face value', () => {
    const inv = makeInvestment()
    const txs = [
      makeTx({ fee: 2 }),
      makeTx({
        type: 'fee',
        quantity: null,
        price_per_unit: null,
        amount: 0.25,
        price_currency: 'EUR',
        fee_currency: 'EUR',
        fx_rate_to_eur: 1,
        notes: 'AutoFX',
      }),
    ]
    const eur = computeInvestmentMetrics(inv, txs, LIVE)
    assert.equal(eur.realizedProfit, -0.25)
    // The trade's own rate already reflects the executed FX; AutoFX does not
    // touch the cost basis.
    assert.equal(eur.remainingCostBasis, 902)

    // Native (USD) view without rates: a EUR fee row carries no USD rate of
    // its own, so its USD amount is unknown — never "0.25 USD".
    const native = computeInvestmentMetrics(inv, txs)
    assert.ok(Number.isNaN(native.realizedProfit))

    const rows = computeAssetYearRows([inv], txs, YEAR, LIVE)
    assert.equal(rows[0].feesPaidInYearEur, 2 + 0.25)
    assert.equal(rows[0].realizedPLInYearEur, -0.25)
  })

  test('a legacy contribution with a missing FX rate makes contribution totals unknown, never smaller', () => {
    const tx = makeTx({ is_contribution: true, fx_rate_to_eur: null, price_currency: 'CHF' })
    const result = buildExternalCashFlowRows([], [tx], LIVE)
    assert.equal(result.rows.length, 0)
    assert.equal(result.fxMissingCount, 1)
    assert.equal(result.fxMissingRows.length, 1)
    assert.ok(Number.isNaN(result.fxMissingRows[0].amount_eur))

    // Year Analysis: a known capital flow plus the unknown legacy row → the
    // year's contributions and time-weighted return are unknown, not 100.
    const known = { year: YEAR, flow_date: `${YEAR}-02-01`, direction: 'to_portfolio' as const, amount_eur: 100 }
    const summary = computeYearPortfolioSummary(
      YEAR, [], [{ date: `${YEAR}-01-01`, total_value_eur: 1000 }], [known], [tx], 1200
    )
    assert.equal(summary.legacyContributionsSkippedFx, 1)
    assert.ok(Number.isNaN(summary.netContributionsEur))
    assert.ok(Number.isNaN(summary.grossContributionsInEur))
    assert.equal(summary.modifiedDietzReturnPercent, null)
  })
})
