import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import type { Investment, Transaction } from '@/types/database'
import { computeCurrentValuation, endValuesFrom, LIVE_QUOTE_MAX_AGE_HOURS } from '@/lib/domain/current-valuation'
import { buildTwrLedger, addDays, type OfficialAnchor } from '@/lib/domain/twr-ledger'
import { computeTwr } from '@/lib/domain/twr'
import type { ReturnFlow } from '@/lib/domain/flow-classification'
import type { PriceSeries } from '@/lib/valuation/historical-valuation'

const NOW = '2026-03-31T10:00:00Z'
const TODAY = '2026-03-31'

function inv(o: Partial<Investment> & { id: string }): Investment {
  return {
    user_id: 'u', name: o.id, ticker: o.id.toUpperCase(), type: 'stock', platform: 'Broker', current_price: 100,
    current_value: null, currency: 'EUR', price_last_updated_at: NOW, price_source: 'yahoo', notes: null, created_at: '',
    updated_at: '', commodity_kind: null, quantity_unit: null, ...o,
  }
}
let seq = 0
function tx(o: Partial<Transaction> & Pick<Transaction, 'investment_id' | 'type' | 'date'>): Transaction {
  seq += 1
  return {
    id: `t${seq}`, user_id: 'u', quantity: null, price_per_unit: null, amount: null, fee: 0, notes: null,
    created_at: `2025-01-01T00:00:${String(seq % 60).padStart(2, '0')}Z`, price_currency: 'EUR', fee_currency: 'EUR',
    fx_rate_to_eur: 1, recurring_rule_id: null, is_contribution: false, contribution_source: null,
    source: 'source_migration_degiro', external_id: `x${seq}`, ...o,
  } as Transaction
}
const buy = (id: string, date: string, q: number, p: number, extra: Partial<Transaction> = {}) =>
  tx({ investment_id: id, type: 'buy', date, quantity: q, price_per_unit: p, amount: q * p, ...extra })
const flow = (date: string, amountEur: number, platform = 'Broker'): ReturnFlow => ({
  id: `f${date}${amountEur}`, date, platform, amountEur, kind: amountEur < 0 ? 'withdrawal' : 'bank_deposit', label: 'f', origin: 'capital_flow', proposed: false,
})
const fxRows = [{ currency: 'USD', eurPerUnit: 0.9, fetchedAt: NOW }]

const silver = inv({ id: 'silver', name: 'Zilver', platform: 'GoldRepublic', type: 'commodity', ticker: 'SI=F', currency: 'USD', commodity_kind: 'silver', quantity_unit: 'gram', current_price: 1.6 })
const silverTx = [buy('silver', '2025-06-02', 100, 1, { source: 'source_migration_goldrepublic', amount: 100 })]
const silverFlows = [flow('2025-06-02', 100, 'GoldRepublic')]

describe('central current valuation', () => {
  test('a market benchmark stays "estimated" (metal without statement or observation)', () => {
    const v = computeCurrentValuation({ investments: [silver], transactions: silverTx, flows: silverFlows, fxRows, now: NOW, today: TODAY })
    assert.equal(v.status, 'ok')
    const p = v.positions[0]
    assert.equal(p.source, 'market_benchmark')
    assert.equal(p.quality, 'estimated')
    assert.equal(v.quality, 'estimated')
    assert.ok(Math.abs((p.valueEur as number) - 100 * 1.6 * 0.9) < 1e-9)
  })

  test('an owner-reported metal value has its own status, different from an official broker statement', () => {
    const observation = {
      investmentId: 'silver', quantity: 100, quantityUnit: 'gram' as const, price: 1500, priceUnit: 'kilogram' as const,
      currency: 'EUR', totalValue: 150, observedAt: '2026-03-31T08:00:00Z', source: 'GoldRepublic website, read by owner', evidence: 'none' as const,
    }
    const owner = computeCurrentValuation({ investments: [silver], transactions: silverTx, flows: silverFlows, fxRows, now: NOW, today: TODAY, observations: [observation] })
    assert.equal(owner.positions[0].source, 'owner_observation')
    assert.equal(owner.positions[0].quality, 'owner_reported')
    assert.equal(owner.positions[0].valueEur, 150)

    const official = computeCurrentValuation({
      investments: [silver], transactions: silverTx, flows: silverFlows, fxRows, now: NOW, today: TODAY, observations: [observation],
      officialValues: [{ investmentId: 'silver', statementDate: '2026-03-31', valueEur: 151.2, quantity: 100, source: 'GoldRepublic statement' }],
    })
    assert.equal(official.positions[0].source, 'official_statement')
    assert.equal(official.positions[0].quality, 'confirmed')
    assert.notEqual(official.positions[0].quality, owner.positions[0].quality)

    // An older dealer value is not frozen: it becomes the anchor and follows
    // the COMEX benchmark (estimated) — the dealer-vs-COMEX gap is kept.
    const closes: { date: string; close: number }[] = []
    for (let d = '2025-12-20'; d <= '2026-03-30'; d = addDays(d, 1)) closes.push({ date: d, close: 1.5 * 31.1034768 })
    const prices = new Map<string, PriceSeries>([['SI=F', { symbol: 'SI=F', currency: 'USD', unit: 'troy_ounce', closes, source: 'test', fetchedAt: '' }]])
    const fx = { USD: closes.map((c) => ({ date: c.date, eurPerUnit: 0.9 })) }
    const tracked = computeCurrentValuation({
      investments: [silver], transactions: silverTx, flows: silverFlows, fxRows, now: NOW, today: TODAY, prices, fx,
      observations: [{ ...observation, observedAt: '2026-03-20T08:00:00Z' }],
    })
    assert.equal(tracked.positions[0].source, 'dealer_anchor_tracked')
    assert.equal(tracked.positions[0].quality, 'estimated')
    // factor = 150 / (100 g × 1.5 USD × 0.9) ; today = 100 g × 1.6 USD × 0.9 × factor
    assert.ok(Math.abs((tracked.positions[0].valueEur as number) - 100 * 1.6 * 0.9 * (150 / (100 * 1.5 * 0.9))) < 1e-9)
    // A year-end statement is not a CURRENT statement: it is the anchor, estimated.
    const yearEnd = computeCurrentValuation({
      investments: [silver], transactions: silverTx, flows: silverFlows, fxRows, now: NOW, today: TODAY, prices, fx,
      officialValues: [{ investmentId: 'silver', statementDate: '2025-12-31', valueEur: 130, quantity: 100, source: 'Jaaroverzicht 2025' }],
    })
    assert.equal(yearEnd.positions[0].quality, 'estimated')
    assert.equal(yearEnd.positions[0].source, 'dealer_anchor_tracked')
    // Without the benchmark price on the dealer-value date: no guess, no total.
    const noHistory = computeCurrentValuation({
      investments: [silver], transactions: silverTx, flows: silverFlows, fxRows, now: NOW, today: TODAY,
      officialValues: [{ investmentId: 'silver', statementDate: '2025-12-31', valueEur: 130, quantity: 100, source: 'Jaaroverzicht 2025' }],
    })
    assert.equal(noHistory.totalEur, null)
    assert.equal(noHistory.gaps[0].source, 'yahoo_history')
  })

  test('a historical statement factor is never applied to the current value (shares, ETFs, crypto)', () => {
    const a = inv({ id: 'a', ticker: 'AAA', current_price: 120 })
    const txs = [buy('a', '2025-07-01', 10, 100)]
    const flows = [flow('2025-07-01', 1000)]
    const closes: { date: string; close: number }[] = []
    for (let d = '2025-06-20'; d <= '2026-03-30'; d = addDays(d, 1)) closes.push({ date: d, close: d <= '2025-12-31' ? 118 : 119 })
    const prices = new Map<string, PriceSeries>([['AAA', { symbol: 'AAA', currency: 'EUR', closes, source: 'test', fetchedAt: '' }]])
    // Statement 1,150 vs market 1,180 on 31-12: factor 0.9746 — must NOT reach today.
    const anchor: OfficialAnchor = { date: '2025-12-31', positions: [{ investmentId: 'a', valueEur: 1150, quantity: 10, source: 'Jaaropgave' }], cash: [] }
    const v = computeCurrentValuation({ investments: [a], transactions: txs, flows, fxRows, now: NOW, today: TODAY, anchor })
    assert.equal(v.positions[0].valueEur, 10 * 120)
    const ledger = buildTwrLedger({
      investments: [a], transactions: txs, flows, prices, fx: {}, fxRates: { EUR: 1 }, startDate: '2025-12-31', endDate: TODAY,
      anchor, endValues: endValuesFrom(v),
    })
    const twr = computeTwr(ledger.input)
    assert.equal(twr.status, 'ok')
    assert.equal(twr.startValueEur, 1150, 'the statement is the start value')
    const day2 = ledger.input.days.find((d) => d.date === '2026-01-02')!.sleeves.find((s) => s.sleeve === 'a')!
    assert.equal(day2.valueEur, 10 * 119, 'the day after the statement: market value, no factor')
    assert.equal(twr.endValueEur, v.totalEur, 'the return ends exactly on the current valuation')
    assert.ok(ledger.qualityIssues.some((i) => i.kind === 'valuation_basis_adjustment'), 'the statement-vs-market difference is reported')
    // A period running THROUGH the statement date is not touched by it at all.
    const through = buildTwrLedger({
      investments: [a], transactions: txs, flows, prices, fx: {}, fxRates: { EUR: 1 }, startDate: '2025-06-30', endDate: TODAY,
      anchor, endValues: endValuesFrom(v),
    })
    assert.equal(through.input.days.find((d) => d.date === '2025-12-31')!.sleeves.find((s) => s.sleeve === 'a')!.valueEur, 10 * 118)
  })

  test('a stale live price, a missing price or a missing FX rate: no total at all, every gap listed', () => {
    const a = inv({ id: 'a', current_price: 120 })
    const b = inv({ id: 'b', currency: 'USD', current_price: 50 })
    const txs = [buy('a', '2025-07-01', 10, 100), buy('b', '2025-07-01', 10, 50, { price_currency: 'USD', fx_rate_to_eur: 0.9, amount: 500 })]
    const flows = [flow('2025-07-01', 1450)]
    const ok = computeCurrentValuation({ investments: [a, b], transactions: txs, flows, fxRows, now: NOW, today: TODAY })
    assert.equal(ok.status, 'ok')

    const staleAt = new Date(Date.parse(NOW) - (LIVE_QUOTE_MAX_AGE_HOURS + 1) * 3_600_000).toISOString()
    const stale = computeCurrentValuation({ investments: [{ ...a, price_last_updated_at: staleAt }, b], transactions: txs, flows, fxRows, now: NOW, today: TODAY })
    assert.equal(stale.status, 'unavailable')
    assert.equal(stale.totalEur, null, 'never a partial total')
    assert.equal(stale.gaps[0].source, 'live_quote')
    assert.equal(stale.gaps[0].lastAvailableDate, staleAt.slice(0, 10))

    const partial = computeCurrentValuation({ investments: [a, { ...b, current_price: null }], transactions: txs, flows, fxRows, now: NOW, today: TODAY })
    assert.equal(partial.totalEur, null)
    assert.equal(partial.positionsEur, null)

    const noFx = computeCurrentValuation({ investments: [a, b], transactions: txs, flows, fxRows: [], now: NOW, today: TODAY })
    assert.equal(noFx.totalEur, null)
    assert.ok(noFx.gaps.some((g) => g.source === 'fx_rate' && g.item === 'USD'))
  })

  test("today's exchange rate is never used for a past transaction", () => {
    const b = inv({ id: 'b', currency: 'USD', current_price: 50 })
    // A manual USD purchase without its own rate would fall back to today's rate.
    const txs = [buy('b', '2025-07-01', 10, 50, { price_currency: 'USD', fx_rate_to_eur: null, external_id: null, source: null, amount: 500 })]
    const v = computeCurrentValuation({ investments: [b], transactions: txs, flows: [flow('2025-07-01', 450)], fxRows, now: NOW, today: TODAY })
    assert.equal(v.status, 'unavailable')
    assert.equal(v.gaps[0].source, 'transaction_fx')
  })
})
