import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import type { Investment, Transaction } from '@/types/database'
import { buildTwrLedger, addDays, type OfficialAnchor } from '@/lib/domain/twr-ledger'
import { computeTwr } from '@/lib/domain/twr'
import { computeInvestmentResult } from '@/lib/domain/investment-result'
import type { ReturnFlow } from '@/lib/domain/flow-classification'
import type { PriceSeries } from '@/lib/valuation/historical-valuation'

// The five statement-vs-market differences of 31-12-2025 in the real account
// (together −€18.00 when read as market − statement). A change of valuation
// source is never market performance: with flat prices the return is 0.

function inv(o: Partial<Investment> & { id: string }): Investment {
  return {
    user_id: 'u', name: o.id, ticker: o.id.toUpperCase(), type: 'stock', platform: 'Broker', current_price: null,
    current_value: null, currency: 'EUR', price_last_updated_at: null, price_source: null, notes: null, created_at: '',
    updated_at: '', commodity_kind: null, quantity_unit: null, ...o,
  }
}
let seq = 0
const buy = (id: string, date: string, q: number, p: number): Transaction => {
  seq += 1
  return {
    id: `b${seq}`, user_id: 'u', investment_id: id, type: 'buy', date, quantity: q, price_per_unit: p, amount: q * p, fee: 0,
    notes: null, created_at: `2025-01-01T00:00:${String(seq).padStart(2, '0')}Z`, price_currency: 'EUR', fee_currency: 'EUR',
    fx_rate_to_eur: 1, recurring_rule_id: null, is_contribution: false, contribution_source: null,
    source: 'source_migration_degiro', external_id: `x${seq}`,
  } as Transaction
}
const flat = (symbol: string, close: number, extra: Partial<PriceSeries> = {}): PriceSeries => {
  const closes: { date: string; close: number }[] = []
  for (let d = '2025-06-01'; d <= '2026-03-31'; d = addDays(d, 1)) closes.push({ date: d, close })
  return { symbol, currency: 'EUR', closes, source: 'test', fetchedAt: '', ...extra }
}

const five = [
  { id: 'meta', type: 'stock' as const, q: 2, market: 1123.56, official: 1124.0 },
  { id: 'btc', type: 'crypto' as const, q: 0.00998288, market: 744.59, official: 743.29 },
  { id: 'grgold', type: 'commodity' as const, q: 7.85, market: 932.44, official: 926.06 },
  { id: 'hggold', type: 'commodity' as const, q: 7.4664, market: 886.88, official: 884.46 },
  { id: 'hgsilver', type: 'commodity' as const, q: 588.5363, market: 1129.42, official: 1157.08 },
]
const investments = five.map((f) => inv({
  id: f.id, type: f.type, ticker: f.id.toUpperCase(),
  ...(f.type === 'commodity' ? { commodity_kind: f.id.includes('gold') ? 'gold' : 'silver', quantity_unit: 'gram' } : {}),
}))
// Dealer metals bought at the dealer-basis price (statement ÷ quantity), listed at market.
const transactions = five.map((f) => buy(f.id, '2025-07-01', f.q, (f.type === 'commodity' ? f.official : f.market) / f.q))
const flows: ReturnFlow[] = [{
  id: 'dep', date: '2025-07-01', platform: 'Broker', amountEur: transactions.reduce((s, t) => s + (t.amount ?? 0), 0),
  kind: 'bank_deposit', label: 'deposit', origin: 'capital_flow', proposed: false,
}]
const prices = new Map(five.map((f) => [f.id.toUpperCase(), flat(f.id.toUpperCase(), f.market / f.q, f.type === 'commodity' ? { unit: 'gram' } : {})]))
const anchor: OfficialAnchor = {
  date: '2025-12-31',
  positions: five.map((f) => ({ investmentId: f.id, valueEur: f.official, quantity: f.q, source: 'statement 2025' })),
  cash: [{ platform: 'Broker', amountEur: 0, source: 'statement 2025' }],
}
const run = (start: string, extra: Partial<Parameters<typeof buildTwrLedger>[0]> = {}) => {
  const ledger = buildTwrLedger({ investments, transactions, flows, prices, fx: {}, fxRates: { EUR: 1 }, startDate: start, endDate: '2026-03-31', anchor, ...extra })
  return { ledger, twr: computeTwr(ledger.input) }
}

describe('valuation_basis_adjustment: a change of valuation source is not a return', () => {
  test('the five 31-12 differences (≈ −€18) are not in the TWR, the components or the investment result', () => {
    const total = five.reduce((s, f) => s + (f.market - f.official), 0)
    assert.ok(Math.abs(total - -18.0) < 0.01, `the five differences add up to ${total.toFixed(2)}`)

    const ytd = run('2025-12-31')
    assert.equal(ytd.twr.status, 'ok')
    assert.equal(ytd.twr.startValueEur, five.reduce((s, f) => s + f.official, 0), 'the period starts on the statements')
    assert.ok(Math.abs(ytd.twr.twr!) < 1e-12, `flat prices → no return (got ${ytd.twr.twr})`)
    assert.ok(Math.abs(ytd.twr.gainEur!) < 1e-9, 'no euro result')
    for (const [k, v] of Object.entries(ytd.twr.byComponent)) assert.ok(Math.abs(v) < 1e-12, `${k} component is 0`)
    // Listed instruments switch to market: their difference is a basis adjustment.
    const listed = five.filter((f) => f.type !== 'commodity').reduce((s, f) => s + (f.market - f.official), 0)
    assert.ok(Math.abs(ytd.twr.valuationBasisAdjustmentEur - listed) < 1e-9)
    // Dealer metals stay on the dealer basis: no adjustment, no jump.
    for (const f of five.filter((x) => x.type === 'commodity')) {
      assert.equal(ytd.twr.bySleeve[f.id].basisAdjustmentEur, 0, `${f.id}: follows the benchmark from the dealer value`)
      assert.ok(Math.abs(ytd.twr.bySleeve[f.id].endValueEur - f.official) < 1e-9, `${f.id}: still the dealer value with a flat benchmark`)
    }
    // The investment result: nothing, and it still reconciles.
    const all = run('2025-06-30')
    const r = computeInvestmentResult({ investments, transactions, flows, fxRates: { EUR: 1 }, periodTwr: ytd.twr, sinceStartTwr: all.twr })
    assert.ok(Math.abs(r.period.totalEur) < 1e-9, `period result ${r.period.totalEur}`)
    assert.ok(Math.abs(r.period.valuationBasisAdjustmentEur - listed) < 1e-9)
    assert.equal(r.period.reconciled, true)
    assert.ok(Math.abs(r.period.byInvestment.reduce((s, x) => s + x.totalEur, 0)) < 1e-9, 'every position row is 0')
    assert.ok(ytd.ledger.qualityIssues.some((i) => i.kind === 'valuation_basis_adjustment'), 'shown in the quality notes')
  })

  test('a period running through 31-12 has no artificial jump either', () => {
    const through = run('2025-06-30')
    assert.equal(through.twr.status, 'ok')
    assert.ok(Math.abs(through.twr.twr!) < 1e-12, `got ${through.twr.twr}`)
    assert.equal(through.twr.valuationBasisAdjustmentEur, 0)
  })

  test('a new dealer value re-bases the metal with an adjustment, never a result', () => {
    // An owner-reported dealer value on 2026-02-15, 3% above the 31-12 basis.
    const silver = five.find((f) => f.id === 'hgsilver')!
    const later = { investmentId: 'hgsilver', date: '2026-02-15', valueEur: silver.official * 1.03, quantity: silver.q, source: 'owner', kind: 'owner_observation' as const }
    const { twr, ledger } = run('2025-12-31', { dealerAnchors: [later] })
    assert.ok(Math.abs(twr.twr!) < 1e-12, 'still no return with flat prices')
    assert.ok(Math.abs(twr.bySleeve.hgsilver.basisAdjustmentEur - silver.official * 0.03) < 1e-9)
    assert.ok(Math.abs(twr.bySleeve.hgsilver.endValueEur - later.valueEur) < 1e-9, 'the series ends on the new dealer basis')
    assert.ok(ledger.qualityIssues.some((i) => i.kind === 'valuation_basis_adjustment' && i.from === '2026-02-15'))
  })
})
