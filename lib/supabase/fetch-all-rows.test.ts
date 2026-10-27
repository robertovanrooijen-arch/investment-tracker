import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { fetchAllRows } from '@/lib/supabase/fetch-all-rows'

describe('fetchAllRows', () => {
  test('fetches all 2,500 rows in deterministic range pages', async () => {
    const source = Array.from({ length: 2500 }, (_, id) => ({ id }))
    const requestedRanges: Array<[number, number]> = []

    const result = await fetchAllRows(async (from, to) => {
      requestedRanges.push([from, to])
      return { data: source.slice(from, to + 1), error: null }
    })

    assert.equal(result.error, null)
    assert.equal(result.data?.length, 2500)
    assert.deepEqual(result.data, source)
    assert.deepEqual(requestedRanges, [
      [0, 999],
      [1000, 1999],
      [2000, 2999],
    ])
  })

  test('requests one final empty page when the row count equals a full page', async () => {
    const source = Array.from({ length: 2000 }, (_, id) => ({ id }))
    let calls = 0

    const result = await fetchAllRows(async (from, to) => {
      calls += 1
      return { data: source.slice(from, to + 1), error: null }
    })

    assert.equal(result.data?.length, 2000)
    assert.equal(calls, 3)
  })

  test('returns no partial data when a later page fails', async () => {
    const failure = new Error('page failed')

    const result = await fetchAllRows(async (from, to) => {
      if (from === 0) {
        return {
          data: Array.from({ length: to - from + 1 }, (_, id) => ({ id })),
          error: null,
        }
      }
      return { data: null, error: failure }
    })

    assert.equal(result.data, null)
    assert.equal(result.error, failure)
  })

  test('rejects an invalid page size', async () => {
    await assert.rejects(
      () => fetchAllRows(async () => ({ data: [], error: null }), 0),
      /pageSize must be a positive integer/
    )
  })
})
