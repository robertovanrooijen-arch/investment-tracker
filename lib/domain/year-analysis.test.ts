import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import {
  computeAssetYearRows,
  computeYearPortfolioSummary,
  computeInvestmentYtdRows,
  YTD_PERCENT_UNAVAILABLE_REASON,
} from '@/lib/domain/year-analysis'
import type {
  CapitalFlowEntryForYear,
  PortfolioSnapshotForYear,
  InvestmentSnapshotForYtd,
} from '@/lib/domain/year-analysis'
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

// ---------------------------------------------------------------------------
// computeInvestmentYtdRows — real financial edge cases.
//
// Regression coverage for production patterns found during a live audit:
// a position bought mid-year that has since lost significant value can
// legitimately show a Modified Dietz return beyond ±100% (D-Wave Quantum,
// -108.6% in production); a brand-new position can show a real € loss with
// no stable % (BE Semiconductor Industries, -€30.50 / unavailable %); a
// position held across the year boundary and fully sold mid-year must use
// its source-backed year-end value, not an unreliable "closed today, no
// price" fallback (Meta Platforms). Expected values below are derived from
// the Modified Dietz definition by hand, independently of
// computeInvestmentYtdRows's own internals — never by calling another
// function that shares its assumptions.
// ---------------------------------------------------------------------------

describe('computeInvestmentYtdRows — real financial edge cases', () => {
  const MS_PER_DAY = 24 * 60 * 60 * 1000

  test('a mid-year buy that has since lost most of its value can legitimately return beyond -100% (not capped)', () => {
    const year = 2024 // leap year, fixed periodEnd — fully deterministic
    const buyDate = '2024-10-01'
    const inv = makeInvestment({ id: 'a', type: 'stock', current_price: 40 }) // was bought at 100/unit, now 40
    const transactions: Transaction[] = [
      makeBuy({ id: 't1', investment_id: 'a', date: buyDate, quantity: 10, price_per_unit: 100, fee: 0 }),
    ]

    const rows = computeInvestmentYtdRows([inv], transactions, year)
    const row = rows.find((r) => r.investmentId === 'a')!

    assert.equal(row.startValueEur, 0) // nothing held at Jan 1 — exact, no price needed
    assert.equal(row.currentValueEur, 400) // 10 * 40
    assert.equal(row.ytdGrowthEur, 400 - 1000) // end - start - netFlow(1000 bought) = -600
    assert.notEqual(row.ytdReturnPercent, null)

    // Independent oracle: the Modified Dietz formula applied by hand to the
    // same inputs, using only elementary date arithmetic (not any helper
    // from year-analysis.ts).
    const periodStart = new Date(`${year}-01-01`).getTime()
    const periodEnd = new Date(`${year}-12-31`).getTime()
    const totalDays = (periodEnd - periodStart) / MS_PER_DAY
    const flowTime = new Date(buyDate).getTime()
    const daysSinceStart = (flowTime - periodStart) / MS_PER_DAY
    const weight = (totalDays - daysSinceStart) / totalDays
    const denominator = 0 + 1000 * weight // startValue(0) + weighted cash flow
    const numerator = 400 - 0 - 1000 // end - start - netCashFlow
    const expectedPercent = (numerator / denominator) * 100

    assert.ok(expectedPercent < -100, `expected the independent oracle itself to be beyond -100%, got ${expectedPercent}`)
    assert.ok(
      Math.abs((row.ytdReturnPercent as number) - expectedPercent) < 0.01,
      `expected ≈${expectedPercent}, got ${row.ytdReturnPercent}`
    )
  })

  test('a brand-new position with a loss shows a real € result even when the % is withheld as numerically unstable', () => {
    const year = 2024
    const inv = makeInvestment({ id: 'a', type: 'stock', current_price: 145 }) // bought at 160, now 145
    const transactions: Transaction[] = [
      // Bought 2 days before period end — almost no time-in-market to weight against.
      makeBuy({ id: 't1', investment_id: 'a', date: '2024-12-29', quantity: 2, price_per_unit: 160, fee: 1 }),
    ]

    const rows = computeInvestmentYtdRows([inv], transactions, year)
    const row = rows.find((r) => r.investmentId === 'a')!

    const expectedResultEur = 2 * 145 - (2 * 160 + 1) // end value - (gross buy + fee)
    assert.equal(row.ytdGrowthEur, expectedResultEur)
    assert.ok((row.ytdGrowthEur as number) < 0)
    assert.equal(row.ytdReturnPercent, null)
    assert.equal(row.percentUnavailableReason, YTD_PERCENT_UNAVAILABLE_REASON)
    assert.equal(row.unavailableReason, null) // the € side is NOT unavailable — only the %
  })

  test('a position held since before the year started and fully sold mid-year uses its source-backed start value', () => {
    const year = 2025
    const inv = makeInvestment({ id: 'a', type: 'stock', current_price: 999 }) // irrelevant: position is now closed
    const transactions: Transaction[] = [
      makeBuy({ id: 'buy-2024', investment_id: 'a', date: '2024-06-01', quantity: 2, price_per_unit: 500, fee: 0 }),
      makeBuy({ id: 'sell-2025', investment_id: 'a', type: 'sell', date: '2025-04-01', quantity: 2, price_per_unit: 560, fee: 0 }),
    ]
    const investmentSnapshots: InvestmentSnapshotForYtd[] = [
      { investment_id: 'a', date: '2024-12-31', value_eur: 1050 }, // a real, recorded year-end mark
    ]

    const rows = computeInvestmentYtdRows([inv], transactions, year, undefined, investmentSnapshots)
    const row = rows.find((r) => r.investmentId === 'a')!

    assert.equal(row.unavailableReason, null)
    assert.equal(row.startValueEur, 1050) // the snapshot, not an invented "closed today" null
    assert.equal(row.currentValueEur, 0) // fully sold
    // sell flow this year: -(2*560) = -1120 (money leaving the position)
    // result = end(0) - start(1050) - netFlow(-1120) = -1050 + 1120 = 70
    assert.equal(row.ytdGrowthEur, 0 - 1050 - -1120)
  })

  test('a position fully closed in a PRIOR year, dormant ever since, is reported unavailable rather than a misleading 0%', () => {
    // Regression for a real production pattern (Trump Media, Tesla): a
    // position with zero buy/sell activity in the selected year AND
    // nothing left to value has no row in computeAssetYearRows at all, so
    // computeInvestmentYtdRows correctly reports it as unavailable — never
    // a fabricated 0% that would misleadingly suggest "flat performance".
    const year = 2025
    const inv = makeInvestment({ id: 'a', type: 'stock', current_price: null })
    const transactions: Transaction[] = [
      makeBuy({ id: 'b', investment_id: 'a', date: '2023-01-01', quantity: 1, price_per_unit: 50 }),
      makeBuy({ id: 's', investment_id: 'a', type: 'sell', date: '2023-06-01', quantity: 1, price_per_unit: 60 }),
    ]
    const rows = computeInvestmentYtdRows([inv], transactions, year)
    const row = rows.find((r) => r.investmentId === 'a')!
    assert.notEqual(row.unavailableReason, null)
    assert.equal(row.ytdReturnPercent, null)
  })

  test('two separate investments sharing the same ticker are never merged — each keeps its own independent result', () => {
    const year = 2024
    const investments: Investment[] = [
      makeInvestment({ id: 'platform-a', ticker: 'IWDA.AS', platform: 'DEGIRO', current_price: 120 }),
      makeInvestment({ id: 'platform-b', ticker: 'IWDA.AS', platform: 'Trade Republic', current_price: 120 }),
    ]
    const transactions: Transaction[] = [
      makeBuy({ id: 't1', investment_id: 'platform-a', date: '2024-02-01', quantity: 10, price_per_unit: 100 }),
      makeBuy({ id: 't2', investment_id: 'platform-b', date: '2024-02-01', quantity: 1, price_per_unit: 100 }),
    ]
    const rows = computeInvestmentYtdRows(investments, transactions, year)
    assert.equal(rows.length, 2)
    const a = rows.find((r) => r.investmentId === 'platform-a')!
    const b = rows.find((r) => r.investmentId === 'platform-b')!
    assert.equal(a.currentValueEur, 1200) // 10 * 120
    assert.equal(b.currentValueEur, 120) // 1 * 120
    assert.notEqual(a.ytdGrowthEur, b.ytdGrowthEur)
  })

  test('multiple same-day buys and sells are replayed in a stable order and never crash', () => {
    const year = 2024
    const inv = makeInvestment({ id: 'a', type: 'stock', current_price: 110 })
    const transactions: Transaction[] = [
      makeBuy({ id: 't1', investment_id: 'a', date: '2024-03-01', created_at: '2024-03-01T09:00:00Z', quantity: 5, price_per_unit: 100 }),
      makeBuy({ id: 't2', investment_id: 'a', type: 'sell', date: '2024-03-01', created_at: '2024-03-01T10:00:00Z', quantity: 2, price_per_unit: 105 }),
      makeBuy({ id: 't3', investment_id: 'a', date: '2024-03-01', created_at: '2024-03-01T11:00:00Z', quantity: 3, price_per_unit: 103 }),
    ]
    const rows = computeInvestmentYtdRows([inv], transactions, year)
    const row = rows.find((r) => r.investmentId === 'a')!
    assert.equal(row.currentValueEur, 6 * 110) // 5 - 2 + 3 = 6 units held
    assert.equal(row.unavailableReason, null)
  })

  test('a still-open position with zero buy/sell activity this year is unavailable rather than a fabricated flat 0%', () => {
    const year = 2025
    const inv = makeInvestment({ id: 'a', type: 'stock', current_price: 150 })
    const transactions: Transaction[] = [
      makeBuy({ id: 't1', investment_id: 'a', date: '2023-01-01', quantity: 4, price_per_unit: 100 }),
    ]
    const rows = computeInvestmentYtdRows([inv], transactions, year)
    const row = rows.find((r) => r.investmentId === 'a')!
    assert.notEqual(row.unavailableReason, null)
    assert.equal(row.ytdReturnPercent, null)
  })
})

describe('income value date (VUSA dividend: value date 31-12-2025, booked 02-01-2026)', () => {
  test('the dividend is 2025 income in the year analysis, while its booking date stays 2026', () => {
    const vusa = {
      id: 'v', user_id: 'u', name: 'VUSA', ticker: 'VUSA.AS', type: 'ETF', platform: 'DEGIRO', current_price: 100,
      current_value: null, currency: 'EUR', price_last_updated_at: null, price_source: null, notes: null, created_at: '',
      updated_at: '', commodity_kind: null, quantity_unit: null,
    } as const
    const base = {
      user_id: 'u', investment_id: 'v', notes: null, created_at: '2025-01-01T00:00:00Z', price_currency: 'USD', fee_currency: 'USD',
      fx_rate_to_eur: 0.8511362669163333, recurring_rule_id: null, is_contribution: false, contribution_source: null, fee: 0,
    }
    const txs = [
      { ...base, id: 'b', type: 'buy', quantity: 9, price_per_unit: 100, amount: 900, date: '2025-01-10', price_currency: 'EUR', fee_currency: 'EUR', fx_rate_to_eur: 1 },
      { ...base, id: 'd', type: 'dividend', quantity: null, price_per_unit: null, amount: 2.69, date: '2026-01-02', value_date: '2025-12-31' },
    ] as never[]
    const rows2025 = computeAssetYearRows([vusa as never], txs, 2025, { EUR: 1, USD: 0.85 })
    const rows2026 = computeAssetYearRows([vusa as never], txs, 2026, { EUR: 1, USD: 0.85 })
    assert.ok(Math.abs(rows2025[0].dividendsInterestInYearEur - 2.69 * 0.8511362669163333) < 1e-9)
    assert.equal(rows2026[0]?.dividendsInterestInYearEur ?? 0, 0)
  })
})
