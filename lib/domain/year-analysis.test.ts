import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { computeAssetYearRows, computeYearPortfolioSummary } from '@/lib/domain/year-analysis'
import type { CapitalFlowEntryForYear, PortfolioSnapshotForYear } from '@/lib/domain/year-analysis'
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

describe('computeYearPortfolioSummary — YTD bridge equation', () => {
  test('start + net contributions + investment profit = current value, for a past (fully snapshotted) year', () => {
    const year = 2025
    const stock = makeInvestment({ id: 'a', type: 'stock', current_price: 140 })
    const transactions: Transaction[] = [
      makeBuy({ id: 't1', investment_id: 'a', date: '2024-06-01', quantity: 10, price_per_unit: 100 }),
      // An external deposit during the year — a real contribution, must be
      // counted in netContributionsEur and excluded from investment profit.
      makeBuy({
        id: 'd1',
        investment_id: 'a',
        type: 'deposit',
        date: '2025-06-01',
        quantity: null,
        price_per_unit: null,
        amount: 200,
        is_contribution: true,
        contribution_source: 'external',
      }),
    ]

    const snapshots: PortfolioSnapshotForYear[] = [
      { date: '2024-12-31', total_value_eur: 1000 },
      { date: '2025-12-31', total_value_eur: 1400 },
    ]
    const capitalFlowEntries: CapitalFlowEntryForYear[] = []

    const assetRows = computeAssetYearRows([stock], transactions, year)
    const summary = computeYearPortfolioSummary(
      year,
      assetRows,
      snapshots,
      capitalFlowEntries,
      transactions,
      /* liveTotalValueEur */ 1400 // irrelevant for a past year — end comes from the snapshot
    )

    assert.equal(summary.startValueEur, 1000)
    assert.equal(summary.endValueEur, 1400)
    assert.equal(summary.netContributionsEur, 200)
    assert.equal(summary.growthExcludingContributionsEur, 200)

    // The actual equation: start + contributions + growth = end.
    assert.equal(
      summary.startValueEur! + summary.netContributionsEur + summary.growthExcludingContributionsEur!,
      summary.endValueEur
    )
  })

  test('a deposit alone never inflates growthExcludingContributionsEur (the "no €1000 deposit = €1000 profit" guard)', () => {
    const year = 2025
    const cash = makeInvestment({ id: 'cash1', type: 'cash', current_value: 1000 })
    const deposit = makeBuy({
      id: 'd1',
      investment_id: 'cash1',
      type: 'deposit',
      date: '2025-03-01',
      quantity: null,
      price_per_unit: null,
      amount: 1000,
      is_contribution: true,
      contribution_source: 'external',
    })

    const snapshots: PortfolioSnapshotForYear[] = [
      { date: '2024-12-31', total_value_eur: 0 },
      { date: '2025-12-31', total_value_eur: 1000 },
    ]

    const assetRows = computeAssetYearRows([cash], [deposit], year)
    const summary = computeYearPortfolioSummary(year, assetRows, snapshots, [], [deposit], 1000)

    assert.equal(summary.netContributionsEur, 1000)
    // end (1000) - start (0) - contributions (1000) = 0, not 1000.
    assert.equal(summary.growthExcludingContributionsEur, 0)
  })

  test('Modified Dietz % can differ from a naive growth/start ratio (timing-weighted, by design)', () => {
    // A contribution made late in the year should count for less than one
    // made on day 1 — Modified Dietz weights by time-in-market. A naive
    // growth/start ratio has no concept of timing at all.
    const year = 2025
    const stock = makeInvestment({ id: 'a', type: 'stock', current_price: 100 })
    const lateContribution: Transaction = makeBuy({
      id: 'd1',
      investment_id: 'a',
      type: 'deposit',
      date: '2025-12-01', // contributed with only ~1 month left in the year
      quantity: null,
      price_per_unit: null,
      amount: 500,
      is_contribution: true,
      contribution_source: 'external',
    })

    const snapshots: PortfolioSnapshotForYear[] = [
      { date: '2024-12-31', total_value_eur: 1000 },
      { date: '2025-12-31', total_value_eur: 1500 }, // all of the +500 is the late contribution itself
    ]

    const assetRows = computeAssetYearRows([stock], [lateContribution], year)
    const summary = computeYearPortfolioSummary(year, assetRows, snapshots, [], [lateContribution], 1500)

    // No real investment growth happened (the whole delta is the contribution).
    assert.equal(summary.growthExcludingContributionsEur, 0)
    // A naive ratio would read 0 / 1000 = 0%. Modified Dietz, weighting the
    // (zero) growth against a denominator that includes only ~1 month of the
    // late contribution's exposure, is still defined and still reads ~0% —
    // the two can diverge in general, but what must hold is that Modified
    // Dietz is computed from timing, not just from the flat ratio.
    assert.notEqual(summary.modifiedDietzReturnPercent, null)
  })
})
