import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { reconcileAccount, unfundedPlatforms } from '@/lib/domain/reconciliation'
import type { Investment, Transaction } from '@/types/database'

function inv(o: Partial<Investment> = {}): Investment {
  return {
    id: 'a', user_id: 'u', name: 'A', ticker: 'A', type: 'ETF', platform: 'DEGIRO', current_price: 10,
    current_value: null, currency: 'EUR', price_last_updated_at: '2026-10-28T20:30:00Z', price_source: 'yahoo',
    notes: null, created_at: '2024-01-01T00:00:00Z', updated_at: '2024-01-01T00:00:00Z', commodity_kind: null,
    quantity_unit: null, ...o,
  }
}
let n = 0
function tx(o: Partial<Transaction>): Transaction {
  n += 1
  return {
    id: `t${n}`, user_id: 'u', investment_id: 'a', type: 'buy', quantity: 10, price_per_unit: 10, amount: 100, fee: 0,
    date: '2026-01-02', notes: null, created_at: `2024-01-01T00:00:${String(n % 60).padStart(2, '0')}Z`,
    price_currency: 'EUR', fee_currency: 'EUR', fx_rate_to_eur: 1, recurring_rule_id: null, is_contribution: false,
    contribution_source: null, source: 'source_migration_degiro', external_id: `k${n}`, ...o,
  }
}
const base = (o: Partial<Parameters<typeof reconcileAccount>[0]> = {}) =>
  reconcileAccount({
    investments: [inv()],
    transactions: [tx({})],
    capitalFlows: [{ platform: 'DEGIRO', direction: 'to_portfolio', amount_eur: 100 }],
    fxRates: { EUR: 1 },
    asOf: '2026-10-29',
    ...o,
  })

describe('reconciliation audit', () => {
  test('consistent books without an official source are "derived" — never green', () => {
    const r = base()
    assert.equal(r.status, 'derived')
    assert.equal(r.platforms[0].positions[0].endQuantity, 10)
    assert.equal(r.platforms[0].impliedCashEur, 0)
  })

  test('a matching official end position, cash and row count are "confirmed"', () => {
    const r = base({
      officialPositions: [{ investmentId: 'a', quantity: 10, asOf: '2026-10-28', source: 'DEGIRO portfolio' }],
      officialCash: [{ platform: 'DEGIRO', amountEur: 0, asOf: '2026-10-28', source: 'DEGIRO account' }],
      sourceFiles: [{ source: 'source_migration_degiro', file: 'Transactions.csv', expectedRows: 1 }],
    })
    assert.equal(r.platforms[0].positions[0].status, 'confirmed')
    assert.equal(r.status, 'confirmed')
  })

  test('an official end position that differs is "blocked"', () => {
    const r = base({ officialPositions: [{ investmentId: 'a', quantity: 9, asOf: '2026-10-28', source: 'statement' }] })
    assert.equal(r.status, 'blocked')
  })

  test('selling more than held is blocked; a floating-point residue is exactly zero', () => {
    const over = base({ transactions: [tx({}), tx({ type: 'sell', quantity: 11, amount: 110, date: '2026-02-01' })] })
    assert.equal(over.status, 'blocked')
    assert.ok(over.platforms[0].positions[0].findings.some((f) => f.check === 'oversell'))

    const residue = base({
      transactions: [tx({ quantity: 0.1 + 0.2, amount: 3 }), tx({ type: 'sell', quantity: 0.3, amount: 3, date: '2026-02-01' })],
    })
    const p = residue.platforms[0].positions[0]
    assert.equal(p.endQuantity, 0)
    assert.notEqual(p.status, 'blocked')
  })

  test('duplicate source keys are blocked; missing keys are a warning', () => {
    assert.equal(base({ transactions: [tx({ external_id: 'x' }), tx({ external_id: 'x' })] }).status, 'blocked')
    assert.equal(base({ transactions: [tx({ external_id: null })] }).status, 'warning')
  })

  test('missing FX or a missing price blocks; unexplained cash is a warning', () => {
    assert.equal(base({ transactions: [tx({ price_currency: 'USD', fee_currency: 'USD', fx_rate_to_eur: null, external_id: 'fx' })] }).status, 'blocked')
    assert.equal(base({ investments: [inv({ current_price: null })] }).status, 'blocked')
    const cash = base({ officialCash: [{ platform: 'DEGIRO', amountEur: 25, asOf: '2026-10-28', source: 'statement' }] })
    assert.equal(cash.platforms[0].findings[0].status, 'warning')
  })

  test('a fee booked twice on the same day is flagged; a row-count mismatch is blocked', () => {
    const fee = (k: string) => tx({ type: 'fee', quantity: null, price_per_unit: null, amount: 2.5, external_id: k })
    const r = base({ transactions: [tx({}), fee('f1'), fee('f2')] })
    assert.ok(r.platforms[0].positions[0].findings.some((f) => f.check === 'possible double booking'))
    assert.equal(base({ sourceFiles: [{ source: 'source_migration_degiro', file: 'x.csv', expectedRows: 2 }] }).status, 'blocked')
  })
})

describe('unfunded purchases', () => {
  test('a purchase without recorded funding is reported as a shortfall (audit only, no cash created)', () => {
    const tr = inv({ id: 'g', platform: 'Trade Republic', ticker: 'ABEC.DE', current_price: 251.7 })
    const order = tx({ investment_id: 'g', quantity: 1.737405, price_per_unit: 252.1, amount: 438, fee: 1, source: 'trade_republic_order_pdf', external_id: 'c366-64d7:002d-5b83' })
    assert.deepEqual(unfundedPlatforms([tr], [order], [], { EUR: 1 }), [{ platform: 'Trade Republic', shortfallEur: 439 }])
    // Recorded funding (a contribution) removes the finding.
    assert.deepEqual(unfundedPlatforms([tr], [order], [{ platform: 'Trade Republic', direction: 'to_portfolio', amount_eur: 439 }], { EUR: 1 }), [])
  })
})
