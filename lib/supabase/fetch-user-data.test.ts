import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import type { SupabaseClient } from '@supabase/supabase-js'
import { fetchAllInvestments, fetchAllTransactions } from '@/lib/supabase/fetch-user-data'

// A fake PostgREST that, like the real one, returns at most 1000 rows per
// request and records the filters/orderings each page asked for.
function fakeTable(rows: { id: string }[]) {
  const calls: { filters: string[]; orders: string[]; range: [number, number] }[] = []
  const client = {
    from: () => {
      const filters: string[] = []
      const orders: string[] = []
      let range: [number, number] = [0, 999]
      const q = {
        select: () => q,
        eq: (c: string, v: unknown) => { filters.push(`${c}=${v}`); return q },
        in: (c: string) => { filters.push(`${c} in`); return q },
        order: (c: string, o: { ascending: boolean }) => { orders.push(`${c} ${o.ascending ? 'asc' : 'desc'}`); return q },
        range: (from: number, to: number) => { range = [from, to]; return q },
        returns: () => q,
        then: (resolve: (v: unknown) => void) => {
          calls.push({ filters, orders, range })
          resolve({ data: rows.slice(range[0], Math.min(range[1] + 1, range[0] + 1000)), error: null })
        },
      }
      return q
    },
  } as unknown as SupabaseClient
  return { client, calls }
}

const many = Array.from({ length: 2345 }, (_, i) => ({ id: String(i).padStart(5, '0') }))

describe('paginated reads of investments and transactions', () => {
  test('all 2,345 transactions are read (not the first 1000), ordered by a unique key', async () => {
    const { client, calls } = fakeTable(many)
    const res = await fetchAllTransactions(client, '*', { userId: 'u' })
    assert.equal(res.data?.length, 2345)
    assert.equal(calls.length, 3)
    for (const c of calls) {
      assert.deepEqual(c.filters, ['user_id=u'])
      assert.deepEqual(c.orders, ['id asc'])
    }
  })

  test('newest-first lists keep id as the final tie-breaker', async () => {
    const { client, calls } = fakeTable(many.slice(0, 5))
    await fetchAllTransactions(client, '*', { investmentId: 'i', order: 'date_desc' })
    assert.deepEqual(calls[0].orders, ['date desc', 'created_at desc', 'id desc'])
    assert.deepEqual(calls[0].filters, ['investment_id=i'])
  })

  test('investments by name still end with id, and every user is reached by the cron list', async () => {
    const { client, calls } = fakeTable(many)
    const res = await fetchAllInvestments(client, 'user_id')
    assert.equal(res.data?.length, 2345)
    const named = fakeTable(many.slice(0, 3))
    await fetchAllInvestments(named.client, '*', { userId: 'u', order: 'name' })
    assert.deepEqual(named.calls[0].orders, ['name asc', 'id asc'])
    assert.deepEqual(calls[0].orders, ['id asc'])
  })
})
