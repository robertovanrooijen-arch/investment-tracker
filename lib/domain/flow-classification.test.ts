import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import type { Investment, Transaction } from '@/types/database'
import type { ContribRow } from '@/lib/domain/contributions'
import { classifyReturnFlows, isRewardTransaction, summarizeContributions } from '@/lib/domain/flow-classification'

const row = (id: string, flow_date: string, direction: 'to_portfolio' | 'from_portfolio', amount_eur: number, notes: string, platform = 'Trade Republic'): ContribRow =>
  ({ id, flow_date, direction, amount_eur, notes, platform, monthKey: flow_date.slice(0, 7), year: 2026, source: 'ledger', created_at: '' }) as ContribRow

describe('return flows vs new personal contribution', () => {
  test('Round Up, Saveback, bank money, withdrawals and an explicit re-use label are kept apart', () => {
    const rows = [
      row('a', '2026-03-02', 'to_portfolio', 39.36, 'Vast ETF-spaarplan [external_id=x]'),
      row('b', '2026-03-02', 'to_portfolio', 4.83, 'Round Up [external_id=y]'),
      row('c', '2026-04-02', 'to_portfolio', 14.04, 'Saveback [external_id=z]'),
      row('d', '2026-10-08', 'from_portfolio', 1185.23, 'Bevestigde opname/terugstorting', 'DEGIRO'),
      row('e', '2026-10-14', 'to_portfolio', 406.54, 'Gewone kooporder'),
    ]
    const flows = classifyReturnFlows({ externalRows: rows, transactions: [], investments: [], labels: { e: 'reused_sale_proceeds' } })
    assert.deepEqual(flows.map((f) => f.kind), ['bank_deposit', 'round_up', 'saveback', 'withdrawal', 'reused_sale_proceeds'])
    const s = summarizeContributions(flows)
    assert.equal(s.ownBankEur, 39.36)
    assert.equal(s.roundUpEur, 4.83)
    assert.equal(s.savebackEur, 14.04)
    assert.equal(s.reusedSaleProceedsEur, 406.54)
    assert.ok(Math.abs(s.grossOwnContributionsEur - (39.36 + 4.83)) < 1e-9)
    assert.equal(s.grossPlatformContributionsEur, 14.04)
    assert.ok(Math.abs(s.grossFreshContributionsEur - (39.36 + 4.83 + 14.04)) < 1e-9)
    // The net external cash flow is a different concept (and a different name).
    assert.ok(Math.abs(s.netExternalCashFlowEur - (39.36 + 4.83 + 14.04 + 406.54 - 1185.23)) < 1e-9)
    assert.ok(!('netNewPersonalEur' in s))
  })

  test('a referral bonus is an external reward (not investment income); a proposed flow is marked as such', () => {
    const inv = { id: 'i', platform: 'Trade Republic' } as Investment
    const bonus = { id: 'x', investment_id: 'i', type: 'interest', date: '2026-02-28', amount: 10, fee: 0, notes: 'BONUS: Referral bonus of 10 EUR', price_currency: 'EUR', fx_rate_to_eur: 1 } as Transaction
    const interest = { ...bonus, id: 'y', notes: 'INTEREST_PAYMENT: Interest payment' } as Transaction
    assert.equal(isRewardTransaction(bonus), true)
    assert.equal(isRewardTransaction(interest), false)
    const flows = classifyReturnFlows({
      externalRows: [], transactions: [bonus, interest], investments: [inv], fxRates: { EUR: 1 },
      proposed: [{ id: 'p', date: '2026-10-29', platform: 'Trade Republic', amountEur: 439, kind: 'reused_sale_proceeds', label: 'Google' }],
    })
    assert.deepEqual(flows.map((f) => [f.kind, f.proposed]), [['external_reward', false], ['reused_sale_proceeds', true]])
    const s = summarizeContributions(flows)
    assert.equal(s.otherRewardsEur, 10)
    assert.equal(s.grossPlatformContributionsEur, 10, 'rewards are platform money, not own money')
    assert.equal(s.grossOwnContributionsEur, 0)
    assert.equal(s.grossFreshContributionsEur, 10, 'the proposed re-used €439 is not fresh money')
    assert.equal(s.proposedCount, 1)
  })
})
