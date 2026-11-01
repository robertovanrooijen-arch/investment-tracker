import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { buildRecentTransactions } from '@/lib/dashboard/recent-transactions'
import type { Investment, Transaction } from '@/types/database'

const investment = {
  id: 'i1', name: 'Alphabet', ticker: 'ABEC.DE', type: 'stock',
} as Pick<Investment, 'id' | 'name' | 'ticker' | 'type'>

function tx(id: string, date: string, createdAt: string, investmentId = 'i1'): Transaction {
  return {
    id, user_id: 'u', investment_id: investmentId, type: 'buy', quantity: 1,
    price_per_unit: 1, amount: 1, fee: 0, date, notes: null, created_at: createdAt,
    price_currency: 'EUR', fee_currency: 'EUR', fx_rate_to_eur: 1,
    recurring_rule_id: null, is_contribution: false, contribution_source: null,
  }
}

describe('dashboard recent transactions', () => {
  test('sorts deterministically and joins the already-loaded investment rows', () => {
    const rows = buildRecentTransactions([
      tx('old', '2026-10-01', '2026-10-01T10:00:00Z'),
      tx('newer-created', '2026-10-29', '2026-10-30T10:00:00Z'),
      tx('newest', '2026-10-29', '2026-10-31T10:00:00Z'),
    ], [investment], 2)

    assert.deepEqual(rows.map((row) => row.id), ['newest', 'newer-created'])
    assert.deepEqual(rows[0].investment, { name: 'Alphabet', ticker: 'ABEC.DE', type: 'stock' })
  })

  test('keeps an orphaned historical row visible without inventing a name', () => {
    const [row] = buildRecentTransactions([tx('orphan', '2026-10-29', '2026-10-29T00:00:00Z', 'missing')], [investment])
    assert.equal(row.investment, null)
  })
})
