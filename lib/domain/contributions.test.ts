import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { buildExternalCashFlowRows, txToContribRow, type CapitalFlowLike } from '@/lib/domain/contributions'
import { computeAssetYearRows, computeYearPortfolioSummary } from '@/lib/domain/year-analysis'
import { deriveAvailableYears } from '@/lib/domain/available-years'
import type { Investment, Transaction } from '@/types/database'

let seq = 0
function makeTx(overrides: Partial<Transaction>): Transaction {
  seq += 1
  return {
    id: `tx-${seq}`,
    user_id: 'u1',
    investment_id: 'inv-1',
    type: 'buy',
    quantity: 1,
    price_per_unit: 50,
    amount: null,
    fee: 0,
    date: '2026-09-02',
    notes: null,
    created_at: '2026-09-03T00:00:00Z',
    price_currency: 'EUR',
    fee_currency: 'EUR',
    fx_rate_to_eur: 1,
    recurring_rule_id: null,
    is_contribution: false,
    contribution_source: null,
    ...overrides,
  }
}

function cfe(overrides: Partial<CapitalFlowLike>): CapitalFlowLike {
  return {
    flow_date: '2026-09-02',
    year: 2026,
    platform: 'Trade Republic',
    direction: 'to_portfolio',
    amount_eur: 50,
    ...overrides,
  }
}

const investment: Investment = {
  id: 'inv-1',
  user_id: 'u1',
  name: 'MSCI World',
  ticker: null,
  type: 'ETF',
  platform: 'Trade Republic',
  current_price: 50,
  current_value: null,
  currency: 'EUR',
  price_last_updated_at: null,
  price_source: null,
  notes: null,
  created_at: '2026-01-01T00:00:00Z',
  updated_at: '2026-01-01T00:00:00Z',
  commodity_kind: null,
  quantity_unit: null,
}

function netContributions(flows: CapitalFlowLike[], txs: Transaction[], year = 2026) {
  const rows = computeAssetYearRows([investment], txs, year, { EUR: 1 })
  const ledger = flows.map((f) => ({ ...f, amount_eur: Number(f.amount_eur) }))
  return computeYearPortfolioSummary(year, rows, [{ date: `${year}-01-01`, total_value_eur: 0 }], ledger, txs, 0)
    .netContributionsEur
}

describe('one source for external contributions', () => {
  test('a legacy is_contribution transaction still counts while no capital flow represents it (compatibility)', () => {
    const tx = makeTx({ is_contribution: true })
    const result = buildExternalCashFlowRows([], [tx])
    assert.equal(result.rows.length, 1)
    assert.equal(result.legacyTransactionCount, 1)
    assert.equal(netContributions([], [tx]), 50)
  })

  test('once a capital flow links to the legacy transaction, the same money counts exactly once', () => {
    const tx = makeTx({ is_contribution: true })
    const flow = cfe({ linked_transaction_id: tx.id })
    const result = buildExternalCashFlowRows([flow], [tx])
    assert.equal(result.rows.length, 1)
    assert.equal(result.rows[0].source, 'ledger')
    assert.equal(result.supersededLegacyCount, 1)
    assert.equal(netContributions([flow], [tx]), 50)
  })

  test('migrating the 8 legacy rows to linked capital flows leaves net contributions unchanged (no loss, no double count)', () => {
    const amounts = [8.8, 50, 5.11, 50, 50, 3.16, 3.64, 50]
    const txs = amounts.map((a) => makeTx({ is_contribution: true, quantity: 1, price_per_unit: a }))
    const before = netContributions([], txs)
    const flows = txs.map((t, i) => cfe({ amount_eur: amounts[i], linked_transaction_id: t.id }))
    const after = netContributions(flows, txs)
    assert.ok(Math.abs(before - 220.71) < 1e-9)
    assert.ok(Math.abs(after - before) < 1e-9)
  })

  test('an imported transaction (external_id set) never counts as a contribution, even if flagged', () => {
    const imported = makeTx({ is_contribution: true, source: 'trade_republic_csv', external_id: 'abc' })
    const result = buildExternalCashFlowRows([], [imported])
    assert.equal(result.rows.length, 0)
    assert.equal(result.ignoredImportedCount, 1)
  })

  test('an internal reallocation (sell + buy, no capital flow) creates no artificial outflow or new contribution', () => {
    const txs = [
      makeTx({ type: 'sell', quantity: 1, price_per_unit: 296, date: '2026-07-27' }),
      makeTx({ type: 'buy', quantity: 1, price_per_unit: 296, date: '2026-07-27' }),
    ]
    assert.equal(buildExternalCashFlowRows([], txs).rows.length, 0)
    assert.equal(netContributions([], txs), 0)
  })

  test('sells, dividends and fees never count, even when (wrongly) flagged', () => {
    for (const type of ['sell', 'dividend', 'interest', 'fee', 'value update'] as const) {
      assert.equal(txToContribRow(makeTx({ type, is_contribution: true, amount: 10 })), null)
    }
  })

  test('Saveback and Round Up capital flows count as external inflow like any other capital flow', () => {
    const flows = [
      cfe({ amount_eur: 8.8, notes: 'saveback' }),
      cfe({ amount_eur: 3.64, notes: 'round up' }),
      cfe({ amount_eur: 120, direction: 'from_portfolio', flow_date: '2026-09-23' }),
    ]
    assert.ok(Math.abs(netContributions(flows, []) - (8.8 + 3.64 - 120)) < 1e-9)
  })

  test('a legacy USD buy converts its EUR fee as EUR — never multiplied by the USD rate', () => {
    const tx = makeTx({
      is_contribution: true,
      quantity: 1,
      price_per_unit: 100,
      price_currency: 'USD',
      fee_currency: 'EUR',
      fee: 2,
      fx_rate_to_eur: 0.9,
    })
    const row = txToContribRow(tx)
    assert.ok(row)
    assert.ok(Math.abs(row.amount_eur - 92) < 1e-9)
  })
})

describe('deriveAvailableYears', () => {
  test('derives years from the data and always includes the current year, ascending', () => {
    const today = new Date('2027-02-01T12:00:00Z')
    assert.deepEqual(deriveAvailableYears(['2024-05-01', '2026-01-01', null, '2024-12-31'], today), [2024, 2026, 2027])
  })

  test('ignores malformed dates and never hardcodes a year', () => {
    const today = new Date('2030-06-01T12:00:00Z')
    assert.deepEqual(deriveAvailableYears(['', 'garbage', undefined], today), [2030])
  })
})
