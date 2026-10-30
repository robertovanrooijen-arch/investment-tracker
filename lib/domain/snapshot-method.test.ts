import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import {
  CURRENT_PL_DEFINITION_VERSION,
  findPlDefinitionBreaks,
  plDefinitionVersionOf,
  plSeriesKey,
} from '@/lib/domain/snapshot-method'
import { computePortfolioMetrics } from '@/lib/domain/calculations'
import {
  computeAssetYearRows,
  computeReconciliationAudit,
  computeYearPortfolioSummary,
  type SnapshotForAudit,
} from '@/lib/domain/year-analysis'
import type { Investment, Transaction } from '@/types/database'

describe('P/L definition versions', () => {
  test('rows written before versioning are v1; the current definition is v2', () => {
    assert.equal(CURRENT_PL_DEFINITION_VERSION, 2)
    assert.equal(plDefinitionVersionOf({}), 1)
    assert.equal(plDefinitionVersionOf({ pl_definition_version: null }), 1)
    assert.equal(plDefinitionVersionOf({ pl_definition_version: 2 }), 2)
  })

  test('the first date of a new definition is reported as a method break', () => {
    const rows = [
      { date: '2026-10-25', version: 1 },
      { date: '2026-10-26', version: 1 },
      { date: '2026-10-27', version: 2 },
      { date: '2026-10-28', version: 2 },
    ]
    assert.deepEqual(findPlDefinitionBreaks(rows), [{ date: '2026-10-27', from: 1, to: 2 }])
    assert.deepEqual(findPlDefinitionBreaks(rows.slice(2)), [])
    assert.deepEqual(findPlDefinitionBreaks([]), [])
  })

  test('different definitions land in different chart series, so they are never connected', () => {
    assert.equal(plSeriesKey('total_profit_eur', 2), 'total_profit_eur')
    assert.equal(plSeriesKey('total_profit_eur', 1), 'total_profit_eur__v1')
    assert.notEqual(plSeriesKey('total_profit_eur', 1), plSeriesKey('total_profit_eur', 2))
  })
})

describe('P/L bridge across a definition change', () => {
  const year = new Date().getFullYear()
  const inv: Investment = {
    id: 'inv-1', user_id: 'u1', name: 'S&P500', ticker: null, type: 'ETF', platform: 'DEGIRO',
    current_price: 100, current_value: null, currency: 'EUR', price_last_updated_at: null, price_source: null,
    notes: null, created_at: '2024-01-01T00:00:00Z', updated_at: '2024-01-01T00:00:00Z',
    commodity_kind: null, quantity_unit: null,
  }
  const txs: Transaction[] = [
    {
      id: 'b', user_id: 'u1', investment_id: 'inv-1', type: 'buy', quantity: 10, price_per_unit: 100, amount: null,
      fee: 0, date: `${year - 1}-06-01`, notes: null, created_at: '2024-01-01T00:00:00Z', price_currency: 'EUR',
      fee_currency: 'EUR', fx_rate_to_eur: 1, recurring_rule_id: null, is_contribution: false, contribution_source: null,
    },
    {
      id: 'd', user_id: 'u1', investment_id: 'inv-1', type: 'dividend', quantity: null, price_per_unit: null, amount: 12.6,
      fee: 0, date: `${year - 1}-07-02`, notes: null, created_at: '2024-01-01T00:00:00Z', price_currency: 'EUR',
      fee_currency: 'EUR', fx_rate_to_eur: 1, recurring_rule_id: null, is_contribution: false, contribution_source: null,
    },
  ]

  function audit(startVersion: number | undefined) {
    const fx = { EUR: 1 }
    const live = computePortfolioMetrics([inv], txs, fx)
    const rows = computeAssetYearRows([inv], txs, year, fx)
    // Start snapshot as the OLD code wrote it: realized excluded the 12.60.
    const snap: SnapshotForAudit = {
      date: `${year - 1}-12-31`,
      total_value_eur: 1000,
      total_realized_eur: startVersion === 2 ? 12.6 : 0,
      total_unrealized_eur: 0,
      updated_at: new Date().toISOString(),
      snapshot_source: 'cron',
      pl_definition_version: startVersion,
    }
    const summary = computeYearPortfolioSummary(year, rows, [snap], [], txs, live.totalValue)
    return computeReconciliationAudit([inv], txs, year, fx, rows, summary, [snap], live).profitLossBridge
  }

  test('a v1 start snapshot against the v2 live total is labelled a method change, not reconciled as exact', () => {
    const bridge = audit(undefined)
    assert.equal(bridge.status, 'approximate')
    assert.match(bridge.explanation, /method change/i)
  })

  test('a start snapshot on the current definition is checked normally', () => {
    const bridge = audit(2)
    assert.notEqual(bridge.status, 'approximate')
    assert.doesNotMatch(bridge.explanation, /method change/i)
  })
})
