import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import {
  convertPriceUnit,
  investmentPriceUnit,
  marketReturn,
  normalizeQuote,
  quoteUnitForSymbol,
} from '@/lib/domain/price-normalization'
import { computeMarketYtdForInvestment, type HistoricalClose } from '@/lib/domain/market-ytd'
import { GRAMS_PER_TROY_OUNCE } from '@/lib/domain/constants'

describe('units', () => {
  test('gram ↔ troy ounce uses 31.1034768 g', () => {
    assert.equal(GRAMS_PER_TROY_OUNCE, 31.1034768)
    assert.ok(Math.abs((convertPriceUnit(3110.34768, 'troy_ounce', 'gram') ?? 0) - 100) < 1e-12)
    assert.ok(Math.abs((convertPriceUnit(100, 'gram', 'troy_ounce') ?? 0) - 3110.34768) < 1e-9)
    assert.equal(convertPriceUnit(10, 'unit', 'gram'), null)
  })

  test('units come from the investment / symbol, never guessed', () => {
    assert.equal(investmentPriceUnit({ type: 'commodity', quantity_unit: 'gram' }), 'gram')
    assert.equal(investmentPriceUnit({ type: 'commodity', quantity_unit: null }), null)
    assert.equal(investmentPriceUnit({ type: 'ETF', quantity_unit: null }), 'unit')
    assert.equal(quoteUnitForSymbol('GC=F'), 'troy_ounce')
    assert.equal(quoteUnitForSymbol('IWDA.AS'), 'unit')
  })
})

const closeOz = (price: number, currency = 'USD'): HistoricalClose => ({
  closeNative: price, currency, unit: 'troy_ounce', priceType: 'close', asOfDateIso: '2025-12-31',
})

describe('market YTD for metals', () => {
  test('a per-gram live price against a per-ounce year-start close gives the true return, not ~−97%', () => {
    const gold = { type: 'commodity' as const, quantity_unit: 'gram' as const, currency: 'USD', current_price: (2860 / 31.1034768) }
    const r = computeMarketYtdForInvestment(gold, closeOz(2600), '2026-10-28')
    assert.ok(r.percent !== null && Math.abs(r.percent - 10) < 1e-9)
  })

  test('a troy-ounce position compares per ounce', () => {
    const silver = { type: 'commodity' as const, quantity_unit: 'troy_ounce' as const, currency: 'USD', current_price: 33 }
    const r = computeMarketYtdForInvestment(silver, closeOz(30), '2026-10-28')
    assert.ok(r.percent !== null && Math.abs(r.percent - 10) < 1e-9)
  })

  test('no silent fallback: unknown unit or a currency mismatch returns null with a reason', () => {
    const noUnit = computeMarketYtdForInvestment(
      { type: 'commodity', quantity_unit: null, currency: 'USD', current_price: 90 }, closeOz(2600), '2026-10-28')
    assert.equal(noUnit.percent, null)
    assert.ok(noUnit.reason)
    const mismatch = computeMarketYtdForInvestment(
      { type: 'commodity', quantity_unit: 'gram', currency: 'EUR', current_price: 90 }, closeOz(2600, 'USD'), '2026-10-28')
    assert.equal(mismatch.percent, null)
    assert.match(mismatch.reason ?? '', /USD/)
  })
})

describe('currency normalisation with historical and current FX', () => {
  test('a USD price in EUR uses the FX of the price date', () => {
    const q = { price: 100, currency: 'USD', unit: 'unit' as const, priceDate: '2025-12-31', priceType: 'close' as const }
    assert.equal(normalizeQuote(q, { unit: 'unit', currency: 'EUR' }, { USD: 0.9 }).price, 90)
    assert.equal(normalizeQuote(q, { unit: 'unit', currency: 'EUR' }, {}).price, null)
  })

  test('an EUR-based market return uses historical FX for the start and current FX for the end', () => {
    const start = { price: 100, currency: 'USD', unit: 'unit' as const, priceDate: '2025-12-31', priceType: 'close' as const }
    const end = { price: 110, currency: 'USD', unit: 'unit' as const, priceDate: '2026-10-28', priceType: 'live' as const }
    const r = marketReturn(start, end, { unit: 'unit', currency: 'EUR' }, { start: { USD: 0.95 }, end: { USD: 0.86 } })
    assert.ok(r.percent !== null && Math.abs(r.percent - ((110 * 0.86) / (100 * 0.95) - 1) * 100) < 1e-9)
  })

  test('adjusted and unadjusted prices are never mixed', () => {
    const start = { price: 100, currency: 'EUR', unit: 'unit' as const, priceDate: '2025-12-31', priceType: 'adj_close' as const }
    const end = { price: 110, currency: 'EUR', unit: 'unit' as const, priceDate: '2026-10-28', priceType: 'live' as const }
    assert.equal(marketReturn(start, end, { unit: 'unit', currency: 'EUR' }).percent, null)
  })
})
