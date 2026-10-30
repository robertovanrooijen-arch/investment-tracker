import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import {
  buildExternalCashFlowRows,
  externalFlowsForReturns,
  suggestTransferPairs,
  type CapitalFlowLike,
} from '@/lib/domain/contributions'
import { allTimeMoneyWeightedReturn } from '@/lib/domain/returns'

const flow = (o: Partial<CapitalFlowLike> & { id: string }): CapitalFlowLike & { id: string } => ({
  flow_date: '2026-03-01',
  year: 2026,
  platform: 'DEGIRO',
  direction: 'to_portfolio',
  amount_eur: 1000,
  ...o,
})

describe('internal transfers between brokers', () => {
  const base = [
    flow({ id: 'dep', flow_date: '2025-01-02', year: 2025, amount_eur: 1000 }),
    // Sale at DEGIRO, money to the bank, then into GoldRepublic: the SAME money.
    flow({ id: 'out', flow_date: '2026-03-01', direction: 'from_portfolio', amount_eur: 500, transfer_group_id: 'g1' }),
    flow({ id: 'in', flow_date: '2026-03-03', platform: 'GoldRepublic', amount_eur: 499.5, transfer_group_id: 'g1' }),
  ]

  test('an explicitly grouped out/in pair is not an external withdrawal + new contribution', () => {
    const r = buildExternalCashFlowRows(base, [])
    assert.deepEqual(r.rows.map((x) => x.id), ['dep'])
    assert.deepEqual(r.internalTransfers, [{ groupId: 'g1', outEur: 500, inEur: 499.5, costEur: 0.5 }])
    assert.equal(r.transferIssues.length, 0)
    // XIRR / net contributions see only the real €1,000 deposit.
    const mwr = allTimeMoneyWeightedReturn(externalFlowsForReturns(r), 1100, '2026-01-02')
    assert.equal(mwr.netContributionsEur, 1000)
  })

  test('the same flows WITHOUT a group stay external (no automatic linking on amount and date)', () => {
    const ungrouped = base.map((f) => ({ ...f, transfer_group_id: null }))
    const r = buildExternalCashFlowRows(ungrouped, [])
    assert.equal(r.rows.length, 3)
    // …but they are offered for review, never applied.
    const s = suggestTransferPairs(ungrouped)
    assert.deepEqual(s, [{ outId: 'out', inId: 'in', amountEur: 500, days: 2 }])
    assert.equal(buildExternalCashFlowRows(ungrouped, []).internalTransfers.length, 0)
  })

  test('an incomplete or inconsistent group is flagged and counted as external (fail-safe)', () => {
    const half = buildExternalCashFlowRows([base[0], base[1]], [])
    assert.equal(half.rows.length, 2)
    assert.equal(half.transferIssues[0].status, 'warning')

    const tooMuchIn = buildExternalCashFlowRows([base[0], base[1], { ...base[2], amount_eur: 650 }], [])
    assert.equal(tooMuchIn.rows.length, 3)
    assert.match(tooMuchIn.transferIssues[0].reason, /differ/)

    const samePlatform = buildExternalCashFlowRows([base[1], { ...base[2], platform: 'DEGIRO' }], [])
    assert.equal(samePlatform.rows.length, 2)
  })
})
