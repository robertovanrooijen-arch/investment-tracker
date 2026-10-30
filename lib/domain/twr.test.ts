import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import type { Investment, Transaction } from '@/types/database'
import { computeTwr, linkReturns, CONTRIBUTION_TOLERANCE } from '@/lib/domain/twr'
import { buildTwrLedger, addDays, cashSleeve, type OfficialAnchor } from '@/lib/domain/twr-ledger'
import { summarizeContributions, type FlowKind, type ReturnFlow } from '@/lib/domain/flow-classification'
import { buildPositionOverview } from '@/lib/domain/position-overview'
import { modifiedDietz } from '@/lib/domain/returns'
import type { FxSeries, PriceSeries } from '@/lib/valuation/historical-valuation'

// ---------------------------------------------------------------------------
// Fixtures: EUR instruments with explicit daily closes, so every expected
// number can be checked by hand.
// ---------------------------------------------------------------------------

function inv(o: Partial<Investment> & { id: string }): Investment {
  return {
    user_id: 'u', name: o.id, ticker: o.id.toUpperCase(), type: 'stock', platform: 'Broker', current_price: null,
    current_value: null, currency: 'EUR', price_last_updated_at: null, price_source: null, notes: null, created_at: '',
    updated_at: '', commodity_kind: null, quantity_unit: null, ...o,
  }
}
let seq = 0
function tx(o: Partial<Transaction> & Pick<Transaction, 'investment_id' | 'type' | 'date'>): Transaction {
  seq += 1
  return {
    id: `t${seq}`, user_id: 'u', quantity: null, price_per_unit: null, amount: null, fee: 0, notes: null,
    created_at: `2026-01-01T00:00:${String(seq % 60).padStart(2, '0')}Z`, price_currency: 'EUR', fee_currency: 'EUR',
    fx_rate_to_eur: 1, recurring_rule_id: null, is_contribution: false, contribution_source: null,
    source: 'source_migration_degiro', external_id: `x${seq}`, ...o,
  } as Transaction
}
const buy = (investment_id: string, date: string, quantity: number, price: number, fee = 0) =>
  tx({ investment_id, type: 'buy', date, quantity, price_per_unit: price, amount: quantity * price, fee })
const sell = (investment_id: string, date: string, quantity: number, price: number, fee = 0) =>
  tx({ investment_id, type: 'sell', date, quantity, price_per_unit: price, amount: quantity * price, fee })

let fseq = 0
const flow = (date: string, amountEur: number, kind: FlowKind = amountEur < 0 ? 'withdrawal' : 'bank_deposit', platform = 'Broker'): ReturnFlow => ({
  id: `f${++fseq}`, date, platform, amountEur, kind, label: kind, origin: 'capital_flow', proposed: false,
})

// Daily closes: carry the last given close forward to every calendar day.
function series(symbol: string, points: Record<string, number>, from: string, to: string, extra: Partial<PriceSeries> = {}): PriceSeries {
  const closes: { date: string; close: number }[] = []
  let last: number | undefined
  for (let d = from; d <= to; d = addDays(d, 1)) {
    if (points[d] !== undefined) last = points[d]
    if (last !== undefined) closes.push({ date: d, close: last })
  }
  return { symbol, currency: 'EUR', closes, source: 'test', fetchedAt: '', ...extra }
}

function run(args: {
  investments: Investment[]
  transactions: Transaction[]
  flows: ReturnFlow[]
  prices: PriceSeries[]
  start: string
  end: string
  anchor?: OfficialAnchor
  fx?: FxSeries
  allowTruncation?: boolean
}) {
  const prices = new Map(args.prices.map((p) => [p.symbol, p]))
  const ledger = buildTwrLedger({
    investments: args.investments, transactions: args.transactions, flows: args.flows, prices, fx: args.fx ?? {},
    fxRates: { EUR: 1 }, startDate: args.start, endDate: args.end, anchor: args.anchor,
  })
  const twr = computeTwr(ledger.input, { allowTruncation: args.allowTruncation })
  const overview = buildPositionOverview({
    investments: args.investments, transactions: args.transactions, ledger, twr, prices, fxRates: { EUR: 1 },
    periodStart: args.start, periodEnd: twr.endDate,
  })
  return { ledger, twr, overview }
}

const close = (a: number | null | undefined, b: number, eps = 1e-9) => {
  assert.ok(a !== null && a !== undefined && Math.abs(a - b) <= eps, `expected ${b}, got ${a}`)
}

describe('TWR engine', () => {
  test('linking: (1 + r1) × (1 + r2) − 1', () => {
    close(linkReturns([0.1, 0.1]), 0.21)
    close(linkReturns([]), 0)
  })

  test('1. €500 in a share → €550 → sold → €550 in gold → €600: TWR 20%, share 10%, gold 9.09%, inleg €500', () => {
    const share = inv({ id: 'share' })
    const gold = inv({ id: 'gold', name: 'Goud' })
    const txs = [buy('share', '2026-01-02', 5, 100), sell('share', '2026-01-04', 5, 110), buy('gold', '2026-01-04', 5.5, 100)]
    const flows = [flow('2026-01-02', 500)]
    const { twr, overview } = run({
      investments: [share, gold], transactions: txs, flows, start: '2026-01-01', end: '2026-01-05',
      prices: [
        series('SHARE', { '2026-01-01': 100, '2026-01-03': 110 }, '2025-12-20', '2026-01-05'),
        series('GOLD', { '2026-01-01': 100, '2026-01-05': 600 / 5.5 }, '2025-12-20', '2026-01-05'),
      ],
    })
    assert.equal(twr.status, 'ok')
    close(twr.twr, 0.2)
    close(twr.gainEur, 100, 1e-9)
    close(twr.bySleeve.share.ownReturn, 0.1)
    close(twr.bySleeve.gold.ownReturn, 50 / 550)
    // Contributions add up to the TWR: share 10 pp, gold 50/550 × 1.10 = 10 pp.
    close(twr.bySleeve.share.contribution, 0.1)
    close(twr.bySleeve.gold.contribution, 0.1)
    assert.ok(twr.reconciled)
    const c = summarizeContributions(flows)
    assert.equal(c.grossFreshContributionsEur, 500, 'buying gold with the sale proceeds is not new money')
    assert.equal(c.grossOwnContributionsEur, 500)
    assert.equal(c.reusedSaleProceedsEur, 0)
    assert.equal(overview.closed[0].realizedEur, 50)
    close(overview.open[0].personalReturn, 50 / 550)
  })

  test('2. a deposit halfway changes the money-weighted figure, never the TWR', () => {
    const s = inv({ id: 's' })
    // +20% in the first half, −10% in the second: TWR = 1.2 × 0.9 − 1 = 8%.
    const prices = [series('S', { '2026-01-01': 100, '2026-06-30': 120, '2026-12-31': 108 }, '2025-12-20', '2026-12-31')]
    const base = [buy('s', '2026-01-01', 10, 100)]
    const without = run({ investments: [s], transactions: base, flows: [flow('2026-01-01', 1000)], prices, start: '2025-12-31', end: '2026-12-31' })
    const withDeposit = run({
      investments: [s], transactions: [...base, buy('s', '2026-07-01', 10, 120)],
      flows: [flow('2026-01-01', 1000), flow('2026-07-01', 1200)], prices, start: '2025-12-31', end: '2026-12-31',
    })
    close(without.twr.twr, 0.08)
    close(withDeposit.twr.twr, 0.08)
    // More money during the losing half: the money-weighted figure is lower.
    const md = modifiedDietz(0, withDeposit.twr.endValueEur!, [{ date: '2026-01-01', amountEur: 1000 }, { date: '2026-07-01', amountEur: 1200 }], '2025-12-31', '2026-12-31')
    assert.ok((md.returnPercent ?? 0) / 100 < 0.08 - 0.01, 'Modified Dietz does depend on the deposit')
  })

  test('3. sale proceeds withdrawn and later deposited again: correct boundary flows, no new personal money', () => {
    const a = inv({ id: 'a' })
    const b = inv({ id: 'b' })
    const txs = [buy('a', '2026-01-02', 5, 100), sell('a', '2026-01-05', 5, 110), buy('b', '2026-01-10', 5.5, 100)]
    const flows = [flow('2026-01-02', 500), flow('2026-01-06', -550), flow('2026-01-10', 550, 'reused_sale_proceeds')]
    const { twr } = run({
      investments: [a, b], transactions: txs, flows, start: '2026-01-01', end: '2026-01-12',
      prices: [
        series('A', { '2026-01-01': 100, '2026-01-05': 110 }, '2025-12-20', '2026-01-12'),
        series('B', { '2026-01-01': 100, '2026-01-12': 105 }, '2025-12-20', '2026-01-12'),
      ],
    })
    close(twr.twr, 1.1 * 1.05 - 1)
    assert.equal(twr.externalInEur, 1050)
    assert.equal(twr.externalOutEur, 550)
    const c = summarizeContributions(flows)
    assert.equal(c.ownBankEur, 500)
    assert.equal(c.reusedSaleProceedsEur, 550)
    assert.equal(c.grossFreshContributionsEur, 500, 'the re-deposited proceeds are not new money')
    assert.equal(c.grossWithdrawalsEur, 550)
    assert.equal(c.netExternalCashFlowEur, 500)
  })

  test('3b. only PART of an earlier withdrawal is deposited again: that part is never new money', () => {
    const flows = [
      flow('2026-01-02', 1000),
      flow('2026-03-01', -800), // sale proceeds withdrawn
      flow('2026-04-01', 300, 'reused_sale_proceeds'), // only €300 of it comes back
      flow('2026-05-01', 200), // fresh salary money
    ]
    const c = summarizeContributions(flows)
    assert.equal(c.grossFreshContributionsEur, 1200)
    assert.equal(c.reusedSaleProceedsEur, 300)
    assert.equal(c.grossWithdrawalsEur, 800)
    assert.equal(c.netExternalCashFlowEur, 700)
    assert.notEqual(c.grossFreshContributionsEur, c.netExternalCashFlowEur)
    // No field mixes the re-used €300 into new money.
    assert.equal(c.grossOwnContributionsEur + c.grossPlatformContributionsEur, c.grossFreshContributionsEur)
  })

  test('3c. changing only the contribution LABEL of a flow never changes the TWR or the contributions', () => {
    const a = inv({ id: 'a' })
    const b = inv({ id: 'b' })
    const txs = [buy('a', '2026-01-02', 5, 100), sell('a', '2026-01-05', 5, 110), buy('b', '2026-01-10', 5.5, 100)]
    const prices = [
      series('A', { '2026-01-01': 100, '2026-01-05': 110 }, '2025-12-20', '2026-01-12'),
      series('B', { '2026-01-01': 100, '2026-01-12': 105 }, '2025-12-20', '2026-01-12'),
    ]
    const base = [flow('2026-01-02', 500), flow('2026-01-06', -550)]
    const asOwn = run({ investments: [a, b], transactions: txs, flows: [...base, flow('2026-01-10', 550, 'bank_deposit')], prices, start: '2026-01-01', end: '2026-01-12' })
    const asReused = run({ investments: [a, b], transactions: txs, flows: [...base, flow('2026-01-10', 550, 'reused_sale_proceeds')], prices, start: '2026-01-01', end: '2026-01-12' })
    assert.equal(asOwn.twr.twr, asReused.twr.twr)
    assert.equal(asOwn.twr.sumOfContributions, asReused.twr.sumOfContributions)
    for (const id of Object.keys(asOwn.twr.bySleeve)) assert.equal(asOwn.twr.bySleeve[id].contribution, asReused.twr.bySleeve[id].contribution)
  })

  test('4. fully closed position with a profit', () => {
    const a = inv({ id: 'a' })
    const { twr, overview } = run({
      investments: [a], transactions: [buy('a', '2026-01-02', 10, 100, 2), sell('a', '2026-02-02', 10, 120, 2)],
      flows: [flow('2026-01-02', 1002)], start: '2026-01-01', end: '2026-02-05',
      prices: [series('A', { '2026-01-01': 100, '2026-02-02': 120 }, '2025-12-20', '2026-02-05')],
    })
    const row = overview.closed[0]
    assert.equal(row.fullyClosed, true)
    assert.equal(row.soldCostEur, 1002)
    assert.equal(row.netProceedsEur, 1198)
    assert.equal(row.realizedEur, 196)
    close(row.realizedReturn, 196 / 1002)
    close(row.contribution, twr.twr!)
    close(twr.twr, 1198 / 1002 - 1)
    assert.equal(overview.open.length, 0)
  })

  test('5. partial sale and reinvestment: average cost, contributions counted once, sum = TWR', () => {
    const a = inv({ id: 'a' })
    const b = inv({ id: 'b' })
    const txs = [
      buy('a', '2026-01-02', 10, 100), buy('a', '2026-01-03', 10, 110),
      sell('a', '2026-01-06', 5, 120), buy('b', '2026-01-06', 6, 100),
    ]
    const { twr, overview } = run({
      investments: [a, b], transactions: txs, flows: [flow('2026-01-02', 1000), flow('2026-01-03', 1100)],
      start: '2026-01-01', end: '2026-01-10',
      prices: [
        series('A', { '2026-01-01': 100, '2026-01-03': 110, '2026-01-06': 120, '2026-01-09': 115 }, '2025-12-20', '2026-01-10'),
        series('B', { '2026-01-01': 100, '2026-01-09': 102 }, '2025-12-20', '2026-01-10'),
      ],
    })
    const openA = overview.open.find((r) => r.investmentId === 'a')!
    close(openA.averageCostEur, 105) // moving average: (1000 + 1100) / 20
    assert.equal(openA.quantity, 15)
    const closedA = overview.closed.find((r) => r.investmentId === 'a')!
    assert.equal(closedA.fullyClosed, false)
    assert.equal(closedA.realizedEur, 5 * 120 - 5 * 105)
    assert.equal(closedA.contribution, null, 'a partly sold position contributes once, in the open table')
    const sum = Object.values(twr.bySleeve).reduce((t, s) => t + s.contribution, 0)
    assert.ok(Math.abs(sum - twr.twr!) < CONTRIBUTION_TOLERANCE)
    assert.ok(twr.reconciled)
  })

  test('6. dividend, interest, fees and taxes are in the return and in their own component', () => {
    const a = inv({ id: 'a' })
    const txs = [
      buy('a', '2026-01-02', 10, 100, 1),
      tx({ investment_id: 'a', type: 'dividend', date: '2026-01-05', amount: 10, fee: 1.5 }),
      tx({ investment_id: 'a', type: 'fee', date: '2026-01-05', amount: 0.5, notes: 'Dividendbelasting' }),
      tx({ investment_id: 'a', type: 'fee', date: '2026-01-06', amount: 1, notes: 'Bewaarkosten' }),
      tx({ investment_id: 'a', type: 'interest', date: '2026-01-07', amount: 2 }),
    ]
    const { twr } = run({
      investments: [a], transactions: txs, flows: [flow('2026-01-02', 1001)], start: '2026-01-01', end: '2026-01-08',
      prices: [series('A', { '2026-01-01': 100 }, '2025-12-20', '2026-01-08')],
    })
    // Price unchanged: the whole result is income − costs. Capital stays ≈ €1,001.
    const cap = 1001
    close(twr.byComponent.income, (10 + 2) / cap, 1e-4)
    close(twr.byComponent.taxes, -(1.5 + 0.5) / cap, 1e-4)
    close(twr.byComponent.fees, -(1 + 1) / cap, 1e-4)
    close(twr.gainEur, 10 - 1.5 - 0.5 - 1 + 2 - 1, 1e-9)
    assert.ok(twr.reconciled)
    // Interest belongs to the broker cash, dividend to the position.
    assert.ok(twr.bySleeve[cashSleeve('Broker')].gainEur > 1.99)
  })

  test('7. a missing historical close or FX rate: unavailable — never a partial or too-high return', () => {
    const a = inv({ id: 'a' })
    const u = inv({ id: 'u', currency: 'USD' })
    const txs = [buy('a', '2026-01-02', 10, 100)]
    const gap = run({
      investments: [a], transactions: txs, flows: [flow('2026-01-02', 1000)], start: '2026-01-01', end: '2026-01-30',
      prices: [series('A', { '2026-01-01': 100, '2026-01-10': 150 }, '2025-12-20', '2026-01-10')], // nothing after the 10th
    })
    assert.equal(gap.twr.status, 'unavailable')
    assert.equal(gap.twr.twr, null)
    assert.ok(gap.twr.missing.length > 0)
    const truncated = run({
      investments: [a], transactions: txs, flows: [flow('2026-01-02', 1000)], start: '2026-01-01', end: '2026-01-30',
      prices: [series('A', { '2026-01-01': 100, '2026-01-10': 150 }, '2025-12-20', '2026-01-10')], allowTruncation: true,
    })
    assert.equal(truncated.twr.truncated, true)
    assert.ok(truncated.twr.endDate < '2026-01-30')
    const noFx = run({
      investments: [u], transactions: [buy('u', '2026-01-02', 1, 100)].map((t) => ({ ...t, price_currency: 'USD', fx_rate_to_eur: 0.9 })),
      flows: [flow('2026-01-02', 90)], start: '2026-01-01', end: '2026-01-05',
      prices: [series('U', { '2026-01-01': 100 }, '2025-12-20', '2026-01-05', { currency: 'USD' })],
    })
    assert.equal(noFx.twr.status, 'unavailable')
  })

  test('8. Google bought with earlier S&P 500 sale proceeds: blocked without its funding, never free value', () => {
    const spx = inv({ id: 'spx', platform: 'DEGIRO' })
    const goog = inv({ id: 'goog', platform: 'Trade Republic' })
    const txs = [
      buy('spx', '2026-01-02', 9, 100),
      sell('spx', '2026-10-06', 9, 131.75, 3),
      { ...buy('goog', '2026-10-29', 1.737405, 252.1, 1), source: 'trade_republic_order_pdf', amount: 438 },
    ]
    const prices = [
      series('SPX', { '2026-01-01': 100, '2026-10-06': 131.75 }, '2025-12-20', '2026-10-30'),
      series('GOOG', { '2026-10-01': 260, '2026-10-29': 251.7 }, '2025-12-20', '2026-10-30'),
    ]
    const base = [flow('2026-01-02', 900, 'bank_deposit', 'DEGIRO'), flow('2026-10-08', -1182.75, 'withdrawal', 'DEGIRO')]
    const unfunded = run({ investments: [spx, goog], transactions: txs, flows: base, prices, start: '2025-12-31', end: '2026-10-29', allowTruncation: true })
    assert.equal(unfunded.twr.truncated, true, 'the unfunded purchase day is not valued')
    assert.equal(unfunded.twr.endDate, '2026-10-28')
    const funding = flow('2026-10-29', 439, 'reused_sale_proceeds', 'Trade Republic')
    const funded = run({ investments: [spx, goog], transactions: txs, flows: [...base, funding], prices, start: '2025-12-31', end: '2026-10-29' })
    assert.equal(funded.twr.status, 'ok')
    // Google's own result is the real −€1.70 (value €437.30 vs €439 paid), not +€437.30.
    close(funded.twr.bySleeve.goog.gainEur, 1.737405 * 251.7 - 439, 1e-6)
    close(funded.twr.twr, (9 * 131.75 - 3) / 900 * (1 + (1.737405 * 251.7 - 439) / 439) - 1, 1e-9)
    const c = summarizeContributions([...base, funding])
    assert.equal(c.ownBankEur, 900)
    assert.equal(c.reusedSaleProceedsEur, 439)
    assert.equal(c.grossFreshContributionsEur, 900, 'the €439 is re-used, not new money')
    close(c.netExternalCashFlowEur, 900 - 1182.75 + 439, 1e-9)
  })

  test('9. silver checkpoints: Holland Gold (statement anchor 31-12) and GoldRepublic first cycle', () => {
    const hg = inv({ id: 'hg', name: 'Zilver', platform: 'Holland Gold', type: 'commodity', ticker: 'XAG', commodity_kind: 'silver', quantity_unit: 'gram' })
    const gr = inv({ id: 'gr', name: 'Zilver', platform: 'GoldRepublic', type: 'commodity', ticker: 'XAG', commodity_kind: 'silver', quantity_unit: 'gram' })
    const row = (id: string, src: string) => ([date, type, q, p, a, f]: [string, 'buy' | 'sell', number, number, number, number]) =>
      tx({ investment_id: id, type, date, quantity: q, price_per_unit: p, amount: a, fee: f, source: src })
    const hgRows = ([
      ['2025-11-01', 'buy', 286.5359, 1.39, 400, 1.72], ['2025-11-04', 'buy', 255.606, 1.36, 350, 2.38],
      ['2025-12-01', 'buy', 46.3944, 1.61, 75, 0.31], ['2026-01-02', 'buy', 35.9254, 2.08, 75, 0.28],
      ['2026-01-13', 'sell', 313.093, 2.41, 750, 4.55], ['2026-01-30', 'sell', 311.3687, 2.81, 869.8, 5.15],
    ] as [string, 'buy' | 'sell', number, number, number, number][]).map(row('hg', 'source_migration_holland_gold'))
    const grRows = ([
      ['2025-02-03', 'buy', 48.9, 1.00838, 50, 0.690218], ['2025-03-03', 'buy', 49.416, 0.99785, 50, 0.6902444],
      ['2025-04-01', 'buy', 47.478, 1.0388, 50, 0.6798536], ['2025-05-01', 'buy', 52.16, 0.94479, 50, 0.7197536],
      ['2025-06-02', 'buy', 50.973, 0.96698, 50, 0.71012846], ['2025-07-01', 'buy', 48.342, 1.02002, 50, 0.69019316],
      ['2025-08-01', 'buy', 46.693, 1.05648, 50, 0.66977936], ['2025-09-01', 'buy', 43.071, 1.14601, 50, 0.64020329],
      ['2025-10-01', 'buy', 37.156, 1.33007, 50, 0.57991908], ['2025-12-17', 'sell', 424.189, 1.79198, 752.54, 7.6],
    ] as [string, 'buy' | 'sell', number, number, number, number][]).map(row('gr', 'source_migration_goldrepublic'))
    const xag = series('XAG', { '2025-01-01': 1, '2025-06-01': 1.1, '2025-12-01': 1.9, '2026-01-10': 2.4, '2026-01-28': 2.8 }, '2024-12-20', '2026-02-05', { unit: 'gram' })
    // Holland Gold, YTD 2026, from the statement value €1,157.08 (588.5363 g).
    const anchor: OfficialAnchor = {
      date: '2025-12-31',
      positions: [{ investmentId: 'hg', valueEur: 1157.08, quantity: 588.5363, source: 'Holland Gold jaaropgave 2025' }],
      cash: [{ platform: 'Holland Gold', amountEur: 0, source: 'Holland Gold jaaropgave 2025' }],
    }
    const hgFlows = [flow('2026-01-02', 75, 'bank_deposit', 'Holland Gold'), flow('2026-01-13', -750, 'withdrawal', 'Holland Gold'), flow('2026-01-30', -869.8, 'withdrawal', 'Holland Gold')]
    const y = run({ investments: [hg], transactions: hgRows, flows: hgFlows, prices: [xag], start: '2025-12-31', end: '2026-02-05', anchor })
    assert.equal(y.twr.status, 'ok')
    close(y.twr.startValueEur, 1157.08, 1e-9)
    close(y.twr.bySleeve.hg.gainEur, 750 + 869.8 - 1157.08 - 75, 1e-6) // €387.72
    const closedHg = y.overview.closed[0]
    assert.equal(closedHg.fullyClosed, true)
    close(closedHg.realizedEur, 719.8, 1e-6)
    close(closedHg.realizedReturn, 719.8 / 900, 1e-6) // +79.98%
    assert.equal(y.twr.quality, 'reconstructed', 'metal anchored on a statement')
    // GoldRepublic first cycle (2025): €450.00 → €752.54, +€302.54 (+67.23%).
    const grFlows = grRows.filter((t) => t.type === 'buy').map((t) => flow(t.date, 50, 'bank_deposit', 'GoldRepublic'))
    grFlows.push(flow('2025-12-17', -752.54, 'withdrawal', 'GoldRepublic'))
    const g = run({ investments: [gr], transactions: grRows, flows: grFlows, prices: [xag], start: '2024-12-31', end: '2025-12-31' })
    const closedGr = g.overview.closed[0]
    close(closedGr.soldCostEur, 450, 1e-6)
    close(closedGr.realizedEur, 302.54, 1e-6)
    close(closedGr.realizedReturn, 302.54 / 450, 1e-6)
    assert.equal(g.twr.quality, 'estimated', 'benchmark without a statement anchor is only an estimate')
  })

  test('a position sold out and bought again: first-buy date and personal return belong to the current holding', () => {
    const a = inv({ id: 'a' })
    const txs = [buy('a', '2025-03-01', 10, 50), sell('a', '2025-12-17', 10, 80), buy('a', '2026-02-05', 10, 100)]
    const { overview } = run({
      investments: [a], transactions: txs, start: '2025-12-31', end: '2026-03-01',
      flows: [flow('2025-03-01', 500), flow('2025-12-18', -800), flow('2026-02-05', 1000)],
      prices: [series('A', { '2025-03-01': 50, '2025-12-17': 80, '2026-02-05': 100, '2026-02-20': 90 }, '2025-02-20', '2026-03-01')],
    })
    const row = overview.open[0]
    assert.equal(row.firstBuyDate, '2026-02-05')
    assert.equal(row.openedInPeriod, true)
    close(row.personalReturn, -0.1) // 900 / 1000 − 1, not mixed with the earlier +60% cycle
  })

  test('every reason for "estimated" is listed separately; missing storage costs are never silently €0', () => {
    const g = inv({ id: 'g', name: 'Goud', platform: 'GoldRepublic', type: 'commodity', ticker: 'XAU', commodity_kind: 'gold', quantity_unit: 'gram' })
    const storage = (date: string) => tx({ investment_id: 'g', type: 'fee', date, amount: 1, notes: 'Bevestigde opslagkosten' })
    const txs = [buy('g', '2025-10-01', 10, 100), storage('2025-11-15'), storage('2025-12-15')]
    const xau = series('XAU', { '2025-09-20': 100 }, '2025-09-20', '2026-03-31', { unit: 'gram' })
    const anchor: OfficialAnchor = { date: '2025-12-31', positions: [{ investmentId: 'g', valueEur: 1000, quantity: 10, source: 'statement' }], cash: [] }
    const proposed: ReturnFlow = { ...flow('2026-03-01', 50, 'reused_sale_proceeds', 'GoldRepublic'), proposed: true, origin: 'proposed' }
    const base = [flow('2025-10-01', 1002, 'bank_deposit', 'GoldRepublic')]
    const r = run({ investments: [g], transactions: txs, flows: [...base, proposed], prices: [xau], start: '2025-12-31', end: '2026-03-31', anchor })
    assert.equal(r.twr.status, 'ok')
    assert.equal(r.twr.quality, 'estimated')
    const kinds = r.ledger.qualityIssues.map((i) => i.kind).sort()
    assert.deepEqual(kinds, ['proposed_flow', 'storage_costs_missing'])
    const storageIssue = r.ledger.qualityIssues.find((i) => i.kind === 'storage_costs_missing')!
    assert.equal(storageIssue.from, '2026-01-29') // 45 days after the last booked cost
    // With the costs booked through the period, the anchored metal is just 'reconstructed'.
    const booked = [...txs, storage('2026-01-15'), storage('2026-02-16'), storage('2026-03-16')]
    const ok = run({ investments: [g], transactions: booked, flows: [flow('2025-10-01', 1010, 'bank_deposit', 'GoldRepublic')], prices: [xau], start: '2025-12-31', end: '2026-03-31', anchor })
    assert.deepEqual(ok.ledger.qualityIssues, [])
    assert.equal(ok.twr.quality, 'reconstructed')
  })
})
