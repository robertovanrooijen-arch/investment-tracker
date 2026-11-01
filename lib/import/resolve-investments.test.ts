import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { resolveInvestmentForTrade } from '@/lib/import/resolve-investments'
import type { Investment } from '@/types/database'
import type { ParsedBrokerTrade } from '@/lib/import/platform-csv'

const investment = (id: string, name: string, platform = 'DEGIRO', ticker: string | null = null): Investment => ({
  id, user_id: 'u', name, platform, ticker, type: 'stock', currency: 'EUR', current_price: null,
  current_value: null, price_last_updated_at: null, price_source: null, notes: null,
  created_at: '', updated_at: '', commodity_kind: null, quantity_unit: null,
})
const trade = (sourceName: string): ParsedBrokerTrade => ({
  platform: 'degiro', source: 'source_migration_degiro', externalId: 'x', sourceDatetime: null,
  instrumentKey: 'ISIN:x', sourceName, commodityKind: null, type: 'buy', date: '2026-01-01',
  quantity: 1, pricePerUnit: 1, amount: 1, fee: 0, priceCurrency: 'EUR', feeCurrency: 'EUR',
  fxRateToEur: 1, grossAmount: 1, netCashAmount: 1, amountSemantics: 'gross',
  calcMethod: 'source_gross_amount', notes: '',
})

describe('investment resolver', () => {
  test('matches broker naming noise to exactly one existing position', () => {
    const result = resolveInvestmentForTrade(trade('VANGUARD S&P 500 UCITS ETF USD DIS'), [
      investment('v', 'Vanguard S&P 500 UCITS ETF'), investment('m', 'Meta Platforms'),
    ])
    assert.equal(result.ok, true)
    if (result.ok) assert.equal(result.investment.id, 'v')
  })
  test('refuses an unknown instrument instead of guessing', () => {
    assert.equal(resolveInvestmentForTrade(trade('UNKNOWN NEW COMPANY'), [investment('m', 'Meta Platforms')]).ok, false)
  })
})
