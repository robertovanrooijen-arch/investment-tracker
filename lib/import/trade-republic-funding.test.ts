import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { runTradeRepublicLedger, type TrLedgerEvent } from '@/lib/import/trade-republic-funding'

let n = 0
const at = (day: string, hh = 10) => `${day}T${String(hh).padStart(2, '0')}:00:00.000Z`
// Distributes over the event union so each variant keeps its own fields.
type EventInput = TrLedgerEvent extends infer T ? (T extends unknown ? Omit<T, 'id'> & { id?: string } : never) : never
function ev(e: EventInput): TrLedgerEvent {
  n += 1
  return { id: e.id ?? `e${String(n).padStart(4, '0')}`, ...e } as TrLedgerEvent
}
const contributions = (r: ReturnType<typeof runTradeRepublicLedger>) =>
  r.flows.filter((f) => f.direction === 'to_portfolio').reduce((s, f) => s + f.amountCents, 0)
const outflows = (r: ReturnType<typeof runTradeRepublicLedger>) =>
  r.flows.filter((f) => f.direction === 'from_portfolio').reduce((s, f) => s + f.amountCents, 0)

describe('Trade Republic funding ledger', () => {
  test('1. bank money → ordinary buy: counted once as a contribution', () => {
    const events = [
      ev({ datetime: at('2026-09-22', 14), kind: 'bank_in', amount: 200 }),
      ev({ id: 'buy-0922', datetime: at('2026-09-22', 15), kind: 'buy', amount: 50, buyKind: 'order' }),
    ]
    const r = runTradeRepublicLedger(events)
    assert.equal(r.ok, true)
    assert.deepEqual(r.flows, [{
      externalId: 'tr:buy-0922', sourceEventId: 'buy-0922', date: '2026-09-22', direction: 'to_portfolio',
      amountCents: 5000, flowKind: 'order_payment', status: 'final',
    }])
    // Re-running the same events gives the identical result (idempotent ids).
    assert.deepEqual(runTradeRepublicLedger(events).flows, r.flows)
    // The unspent bank money is NOT a contribution yet.
    assert.equal(r.endPoolsCents.external, 15000)
  })

  test('2. sale → later buy: the reinvested part is not new money', () => {
    const r = runTradeRepublicLedger([
      ev({ datetime: at('2026-01-02'), kind: 'bank_in', amount: 100 }),
      ev({ datetime: at('2026-01-03'), kind: 'buy', amount: 100, buyKind: 'order' }),
      ev({ datetime: at('2026-03-01'), kind: 'sell', amount: 120 }),
      ev({ datetime: at('2026-03-05'), kind: 'buy', amount: 120, buyKind: 'order' }),
    ])
    assert.equal(r.ok, true)
    assert.equal(contributions(r), 10000)
    assert.equal(outflows(r), 0)
  })

  test('3. part sale proceeds + part new money: only the external part is a contribution', () => {
    const r = runTradeRepublicLedger([
      ev({ datetime: at('2026-04-01'), kind: 'sell', amount: 30 }),
      ev({ datetime: at('2026-04-02'), kind: 'bank_in', amount: 50 }),
      ev({ datetime: at('2026-04-03'), kind: 'buy', amount: 70, buyKind: 'order' }),
    ])
    assert.equal(r.ok, true)
    assert.equal(contributions(r), 4000)
    assert.deepEqual(r.endPoolsCents, { external: 1000, reinvest: 0, reward: 0 })
  })

  test('4. Saveback and Round Up count as contributions (labelled), funded by credit / card cash', () => {
    const r = runTradeRepublicLedger([
      ev({ datetime: at('2026-09-01', 0), kind: 'saveback_credit', amount: 8.8 }),
      ev({ datetime: at('2026-09-01', 9), kind: 'bank_in', amount: 20 }),
      ev({ id: 'sb', datetime: at('2026-09-02', 14), kind: 'buy', amount: 8.8, buyKind: 'saveback' }),
      ev({ id: 'ru', datetime: at('2026-09-02', 15), kind: 'buy', amount: 3.64, buyKind: 'round_up' }),
    ])
    assert.equal(r.ok, true)
    assert.deepEqual(r.flows.map((f) => [f.sourceEventId, f.amountCents, f.flowKind]), [['sb', 880, 'saveback'], ['ru', 364, 'round_up']])
    assert.equal(r.endPoolsCents.reward, 0)
  })

  test('4b. a savings plan paid with bank money counts as a contribution; pending kinds keep amount and direction', () => {
    const r = runTradeRepublicLedger([
      ev({ datetime: at('2026-10-01'), kind: 'bank_in', amount: 100 }),
      ev({ id: 'sp', datetime: at('2026-10-02', 14), kind: 'buy', amount: 50, buyKind: 'savings_plan' }),
      ev({ id: 'pc', datetime: at('2026-10-02', 15), kind: 'buy', amount: 5.11, buyKind: 'pending_classification' }),
    ])
    assert.equal(r.ok, true)
    const pending = r.flows.find((f) => f.sourceEventId === 'pc')!
    assert.equal(pending.status, 'pending_classification')
    assert.equal(pending.flowKind, null)
    assert.equal(pending.amountCents, 511)
    assert.equal(pending.direction, 'to_portfolio')
    assert.equal(r.flows.find((f) => f.sourceEventId === 'sp')!.flowKind, 'savings_plan')
  })

  test('5. interest / referral reinvested are realized return, never an extra contribution', () => {
    const r = runTradeRepublicLedger([
      ev({ datetime: at('2026-09-01'), kind: 'interest', amount: 0.14 }),
      ev({ datetime: at('2026-09-05'), kind: 'referral', amount: 10 }),
      ev({ datetime: at('2026-09-10'), kind: 'buy', amount: 10.14, buyKind: 'order' }),
    ])
    assert.equal(r.ok, true)
    assert.equal(contributions(r), 0)
    assert.deepEqual(r.income.map((i) => [i.kind, i.amountCents]), [['interest', 14], ['referral', 1000]])
  })

  test('6. card payment between sale and buy: spending money first, sale proceeds only when it must', () => {
    // a) enough uninvested bank money: the card payment does not touch the proceeds.
    const a = runTradeRepublicLedger([
      ev({ datetime: at('2026-05-01'), kind: 'bank_in', amount: 50 }),
      ev({ datetime: at('2026-05-02'), kind: 'sell', amount: 100 }),
      ev({ datetime: at('2026-05-03'), kind: 'card', amount: 30 }),
      ev({ datetime: at('2026-05-04'), kind: 'buy', amount: 100, buyKind: 'order' }),
    ])
    assert.equal(a.ok, true)
    assert.equal(contributions(a), 0)
    assert.equal(outflows(a), 0)
    assert.deepEqual(a.endPoolsCents, { external: 2000, reinvest: 0, reward: 0 })

    // b) no bank money: the card spends sale proceeds → that part left the portfolio.
    const b = runTradeRepublicLedger([
      ev({ datetime: at('2026-05-02'), kind: 'sell', amount: 100 }),
      ev({ id: 'card', datetime: at('2026-05-03'), kind: 'card', amount: 30 }),
      ev({ datetime: at('2026-05-04'), kind: 'buy', amount: 70, buyKind: 'order' }),
    ])
    assert.equal(b.ok, true)
    assert.deepEqual(b.flows, [{
      externalId: 'tr:card', sourceEventId: 'card', date: '2026-05-03', direction: 'from_portfolio',
      amountCents: 3000, flowKind: 'sale_payout', status: 'final',
    }])
    assert.equal(contributions(b), 0)
  })

  test('7. Apple sale followed by EQQQ purchase: no artificial outflow and no new contribution', () => {
    const r = runTradeRepublicLedger([
      ev({ datetime: at('2026-06-26'), kind: 'bank_in', amount: 490 }),
      ev({ datetime: at('2026-06-26', 11), kind: 'buy', amount: 490, buyKind: 'order' }),
      ev({ datetime: at('2026-07-27', 9), kind: 'sell', amount: 296.51 }),
      ev({ datetime: at('2026-07-27', 10), kind: 'buy', amount: 296.96, buyKind: 'order' }),
    ])
    // The 0.45 gap is not covered by bank money → the export must explain it.
    assert.equal(r.ok, false)
    assert.ok(r.errors.some((e) => e.includes('cash would go negative')))

    const withCash = runTradeRepublicLedger([
      ev({ datetime: at('2026-06-25'), kind: 'bank_in', amount: 500 }),
      ev({ datetime: at('2026-06-26', 11), kind: 'buy', amount: 490, buyKind: 'order' }),
      ev({ datetime: at('2026-07-27', 9), kind: 'sell', amount: 296.51 }),
      ev({ id: 'eqqq', datetime: at('2026-07-27', 10), kind: 'buy', amount: 296.96, buyKind: 'order' }),
    ])
    assert.equal(withCash.ok, true)
    assert.equal(outflows(withCash), 0)
    // Only the 0.45 not covered by the Apple proceeds is new money.
    assert.deepEqual(withCash.flows.map((f) => [f.amountCents, f.direction]), [[49000, 'to_portfolio'], [45, 'to_portfolio']])
  })

  test('a real transfer out of portfolio money is an outflow; of unspent bank money it is not', () => {
    const r = runTradeRepublicLedger([
      ev({ datetime: at('2026-08-01'), kind: 'bank_in', amount: 20 }),
      ev({ datetime: at('2026-08-02'), kind: 'sell', amount: 100 }),
      ev({ id: 'out', datetime: at('2026-08-03'), kind: 'bank_out', amount: 70 }),
    ])
    assert.equal(r.ok, true)
    assert.deepEqual(r.flows.map((f) => [f.sourceEventId, f.direction, f.amountCents, f.flowKind]), [['out', 'from_portfolio', 5000, 'bank_withdrawal']])
  })

  test('the pools are one cash account: a shortfall in one pool is covered by another, never a false error or outflow', () => {
    const r = runTradeRepublicLedger([
      ev({ datetime: at('2026-06-01', 0), kind: 'saveback_credit', amount: 15 }),
      ev({ datetime: at('2026-06-01', 9), kind: 'card', amount: 10 }),
    ])
    assert.equal(r.ok, true)
    assert.equal(r.flows.length, 0)
    assert.equal(r.warnings.length, 1)
    assert.deepEqual(r.endPoolsCents, { external: 0, reinvest: 0, reward: 500 })
  })

  test('cash that would go negative or an end balance that does not match the statement is an error', () => {
    assert.equal(runTradeRepublicLedger([ev({ datetime: at('2026-01-01'), kind: 'card', amount: 5 })]).ok, false)
    const r = runTradeRepublicLedger([ev({ datetime: at('2026-01-01'), kind: 'bank_in', amount: 5 })], { expectedEndCashCents: 400 })
    assert.equal(r.ok, false)
  })
})
