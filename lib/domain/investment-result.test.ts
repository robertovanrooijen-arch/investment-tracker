import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import type { Investment, Transaction } from '@/types/database'
import { computeTwr } from '@/lib/domain/twr'
import { buildTwrLedger, addDays } from '@/lib/domain/twr-ledger'
import { summarizeContributions, type FlowKind, type ReturnFlow } from '@/lib/domain/flow-classification'
import { buildPositionOverview } from '@/lib/domain/position-overview'
import { computeInvestmentResult } from '@/lib/domain/investment-result'
import type { PriceSeries } from '@/lib/valuation/historical-valuation'

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
    id: `r${seq}`, user_id: 'u', quantity: null, price_per_unit: null, amount: null, fee: 0, notes: null,
    created_at: `2026-01-01T00:00:${String(seq % 60).padStart(2, '0')}Z`, price_currency: 'EUR', fee_currency: 'EUR',
    fx_rate_to_eur: 1, recurring_rule_id: null, is_contribution: false, contribution_source: null,
    source: 'source_migration_degiro', external_id: `y${seq}`, ...o,
  } as Transaction
}
const buy = (id: string, date: string, q: number, p: number, fee = 0) => tx({ investment_id: id, type: 'buy', date, quantity: q, price_per_unit: p, amount: q * p, fee })
const sell = (id: string, date: string, q: number, p: number, fee = 0) => tx({ investment_id: id, type: 'sell', date, quantity: q, price_per_unit: p, amount: q * p, fee })
let fseq = 0
const flow = (date: string, amountEur: number, kind: FlowKind = amountEur < 0 ? 'withdrawal' : 'bank_deposit'): ReturnFlow => ({
  id: `g${++fseq}`, date, platform: 'Broker', amountEur, kind, label: kind, origin: 'capital_flow', proposed: false,
})
function series(symbol: string, points: Record<string, number>, from: string, to: string): PriceSeries {
  const closes: { date: string; close: number }[] = []
  let last: number | undefined
  for (let d = from; d <= to; d = addDays(d, 1)) {
    if (points[d] !== undefined) last = points[d]
    if (last !== undefined) closes.push({ date: d, close: last })
  }
  return { symbol, currency: 'EUR', closes, source: 'test', fetchedAt: '' }
}

// Two periods on the same records: "since start" and "2026".
function scenario(investments: Investment[], transactions: Transaction[], flows: ReturnFlow[], prices: PriceSeries[], end = '2026-03-31') {
  const map = new Map(prices.map((p) => [p.symbol, p]))
  const ledger = (start: string) =>
    buildTwrLedger({ investments, transactions, flows, prices: map, fx: {}, fxRates: { EUR: 1 }, startDate: start, endDate: end })
  const allLedger = ledger('2025-06-30')
  const ytdLedger = ledger('2025-12-31')
  const sinceStartTwr = computeTwr(allLedger.input)
  const periodTwr = computeTwr(ytdLedger.input)
  const result = computeInvestmentResult({ investments, transactions, flows, fxRates: { EUR: 1 }, periodTwr, sinceStartTwr })
  return { result, periodTwr, sinceStartTwr, ytdLedger, map }
}

const near = (a: number, b: number, eps = 1e-9) => assert.ok(Math.abs(a - b) <= eps, `expected ${b}, got ${a}`)

describe('investment result (why the euros are what they are)', () => {
  const win = inv({ id: 'win' })
  const loss = inv({ id: 'loss' })
  const txs = [
    buy('win', '2025-07-01', 10, 100, 1), buy('loss', '2025-07-01', 5, 200, 1),
    sell('win', '2026-02-01', 4, 130, 1), // partial sale in 2026
    tx({ investment_id: 'win', type: 'dividend', date: '2026-02-10', amount: 6, fee: 0.9 }),
    tx({ investment_id: 'loss', type: 'fee', date: '2026-02-15', amount: 0.5, notes: 'Dividendbelasting' }),
    tx({ investment_id: 'loss', type: 'fee', date: '2026-02-16', amount: 2, notes: 'Bewaarkosten' }),
    tx({ investment_id: 'win', type: 'interest', date: '2026-03-01', amount: 1.25 }),
  ]
  const flows = [flow('2025-07-01', 2002), flow('2026-02-20', -300)]
  const prices = [
    series('WIN', { '2025-07-01': 100, '2025-12-31': 120, '2026-02-01': 130, '2026-03-31': 125 }, '2025-06-20', '2026-03-31'),
    series('LOSS', { '2025-07-01': 200, '2025-12-31': 180, '2026-03-31': 170 }, '2025-06-20', '2026-03-31'),
  ]
  const s = scenario([win, loss], txs, flows, prices)

  test('1. gross unrealised gains + gross losses = net unrealised, exactly', () => {
    const { result } = s
    near(result.grossUnrealisedGainsEur + result.grossUnrealisedLossesEur, result.netUnrealisedEur)
    // win: 6 × 125 − 6/10 × 1001 = 149.40 ; loss: 5 × 170 − 1001 = −151
    near(result.grossUnrealisedGainsEur, 750 - 600.6)
    near(result.grossUnrealisedLossesEur, 850 - 1001)
  })

  test('2. a partial sale is realised for the sold units and unrealised for the rest — never both', () => {
    const { result, periodTwr, ytdLedger, map } = s
    // Sold 4 of 10 (cost 4/10 × 1001 = 400.40) for 4 × 130 − 1 = 519.
    near(result.period.realisedEur, 519 - 400.4)
    near(result.sinceStart.realisedEur, 519 - 400.4)
    const overview = buildPositionOverview({
      investments: [win, loss], transactions: txs, ledger: ytdLedger, twr: periodTwr, prices: map, fxRates: { EUR: 1 },
      periodStart: '2025-12-31', periodEnd: '2026-03-31',
    })
    const openWin = overview.open.find((r) => r.investmentId === 'win')!
    near(openWin.realizedInPeriodEur, 519 - 400.4)
    near(openWin.unrealizedEur, 750 - 600.6)
    const closedWin = overview.closed.find((r) => r.investmentId === 'win')!
    assert.equal(closedWin.fullyClosed, false)
    assert.equal(closedWin.contribution, null, 'its contribution is counted once, in the open table')
  })

  test('3. realised + unrealised + income − costs − taxes = total = value change − net external cash flow', () => {
    for (const col of [s.result.period, s.result.sinceStart]) {
      near(col.totalEur, col.realisedEur + col.unrealisedChangeEur + col.dividendsInterestEur - col.costsEur - col.taxesEur)
      near(col.totalEur, col.checkEur, 1e-6)
      assert.equal(col.reconciled, true)
    }
    const p = s.result.period
    near(p.dividendsInterestEur, 6 + 1.25)
    near(p.taxesEur, 0.9 + 0.5)
    near(p.costsEur, 2)
    near(p.transactionFeesIncludedEur, 1, 1e-9) // the sell fee: already inside realised, not subtracted again
    // The period total is the TWR's euro result.
    near(p.totalEur, s.periodTwr.gainEur!, 1e-6)
  })

  test('4. re-invested sale proceeds are never new contributions', () => {
    const a = inv({ id: 'a' })
    const b = inv({ id: 'b' })
    const t = [buy('a', '2025-07-01', 5, 100), sell('a', '2026-01-05', 5, 110), buy('b', '2026-01-05', 5.5, 100)]
    const f = [flow('2025-07-01', 500)]
    const r = scenario([a, b], t, f, [
      series('A', { '2025-07-01': 100, '2026-01-05': 110 }, '2025-06-20', '2026-03-31'),
      series('B', { '2025-07-01': 100, '2026-03-31': 600 / 5.5 }, '2025-06-20', '2026-03-31'),
    ])
    assert.equal(summarizeContributions(f).grossFreshContributionsEur, 500)
    near(r.result.sinceStart.realisedEur, 50)
    near(r.result.netUnrealisedEur, 50)
    near(r.result.sinceStart.totalEur, 100)
  })

  test('5. presenting the overview and result never changes the TWR or the sum of contributions', () => {
    const fresh = scenario([win, loss], txs, flows, prices)
    const snapshot = JSON.stringify(fresh.periodTwr)
    buildPositionOverview({
      investments: [win, loss], transactions: txs, ledger: fresh.ytdLedger, twr: fresh.periodTwr, prices: fresh.map,
      fxRates: { EUR: 1 }, periodStart: '2025-12-31', periodEnd: '2026-03-31',
    })
    computeInvestmentResult({ investments: [win, loss], transactions: txs, flows, fxRates: { EUR: 1 }, periodTwr: fresh.periodTwr, sinceStartTwr: fresh.sinceStartTwr })
    assert.equal(JSON.stringify(fresh.periodTwr), snapshot)
    assert.equal(fresh.periodTwr.reconciled, true)
    near(fresh.periodTwr.sumOfContributions!, fresh.periodTwr.twr!, 1e-12)
  })
})
