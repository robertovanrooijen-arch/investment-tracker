import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { selectClosestClose, computeMarketYtdPercent } from '@/lib/domain/market-ytd'

describe('selectClosestClose', () => {
  test('picks the latest point on/before the target, not after', () => {
    const target = 1000
    const series = [
      { timestampSec: 900, close: 10, adjClose: null },
      { timestampSec: 950, close: 11, adjClose: null }, // should win: closest <= target
      { timestampSec: 1050, close: 999, adjClose: null }, // after target — must be ignored
    ]
    const result = selectClosestClose(series, target)
    assert.deepEqual(result, { closeNative: 11, timestampSec: 950 })
  })

  test('prefers adjClose over close when both are present', () => {
    const series = [{ timestampSec: 500, close: 100, adjClose: 95 }]
    const result = selectClosestClose(series, 1000)
    assert.equal(result?.closeNative, 95)
  })

  test('falls back to close when adjClose is null', () => {
    const series = [{ timestampSec: 500, close: 100, adjClose: null }]
    const result = selectClosestClose(series, 1000)
    assert.equal(result?.closeNative, 100)
  })

  test('skips null/zero/negative points and keeps looking', () => {
    const series = [
      { timestampSec: 400, close: 50, adjClose: null },
      { timestampSec: 500, close: null, adjClose: null },
      { timestampSec: 600, close: 0, adjClose: null },
      { timestampSec: 700, close: -5, adjClose: null },
    ]
    const result = selectClosestClose(series, 1000)
    assert.equal(result?.closeNative, 50)
    assert.equal(result?.timestampSec, 400)
  })

  test('returns null when every point is after the target', () => {
    const series = [{ timestampSec: 2000, close: 10, adjClose: null }]
    assert.equal(selectClosestClose(series, 1000), null)
  })

  test('returns null for an empty series', () => {
    assert.equal(selectClosestClose([], 1000), null)
  })
})

describe('computeMarketYtdPercent', () => {
  test('computes a plain price-ratio percentage', () => {
    // 110 vs a 100 start = +10%.
    const result = computeMarketYtdPercent(110, 100)
    assert.ok(result !== null && Math.abs(result - 10) < 1e-9)
  })

  test('handles a loss correctly', () => {
    const result = computeMarketYtdPercent(90, 100)
    assert.ok(result !== null && Math.abs(result - -10) < 1e-9)
  })

  test('returns null when the current price is missing', () => {
    assert.equal(computeMarketYtdPercent(null, 100), null)
  })

  test('returns null when the start close is missing', () => {
    assert.equal(computeMarketYtdPercent(110, null), null)
  })

  test('returns null rather than dividing by zero when the start close is zero', () => {
    assert.equal(computeMarketYtdPercent(110, 0), null)
  })

  test('returns null for a negative start close', () => {
    assert.equal(computeMarketYtdPercent(110, -5), null)
  })
})
