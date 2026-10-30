import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { planImport, existingAfterApply, EMPTY_EXISTING, economicIndexFromExisting } from '@/lib/import/plan'
import { externalIdFromNative, externalIdsFromFields, sha256Hex } from '@/lib/import/source-id'
import type { ImportBatch, ImportTransaction } from '@/lib/import/types'

function tx(o: Partial<ImportTransaction>): ImportTransaction {
  return {
    platform: 'bitvavo',
    source: 'bitvavo_full_history_csv',
    externalId: 'bitvavo:1',
    sourceDatetime: '2025-05-30T07:12:42.471Z',
    instrumentKey: 'CRYPTO:BTC',
    type: 'buy',
    date: '2025-05-30',
    quantity: 0.001,
    pricePerUnit: 90000,
    amount: null,
    fee: 0.2,
    priceCurrency: 'EUR',
    feeCurrency: 'EUR',
    fxRateToEur: 1,
    orderGroupId: null,
    isContribution: false,
    ...o,
  }
}

function batch(o: Partial<ImportBatch> = {}): ImportBatch {
  return {
    files: [{ name: 'Full history.csv', sha256: sha256Hex('file'), rows: 2 }],
    positions: [
      { platform: 'bitvavo', instrumentKey: 'CRYPTO:BTC', name: 'Bitcoin', type: 'crypto', currency: 'EUR', quantityUnit: 'unit' },
    ],
    transactions: [
      tx({ externalId: 'bitvavo:1' }),
      tx({ externalId: 'bitvavo:2', date: '2025-06-13', sourceDatetime: '2025-06-13T17:13:07Z', quantity: 0.002 }),
    ],
    capitalFlows: [
      {
        platform: 'bitvavo', source: 'bitvavo_full_history_csv', externalId: 'bitvavo:d1',
        sourceDatetime: null, date: '2025-05-29', direction: 'to_portfolio', amountEur: 300, flowKind: 'bank_deposit',
      },
    ],
    expectedPositions: [{ platform: 'bitvavo', instrumentKey: 'CRYPTO:BTC', quantity: 0.003 }],
    expectedCounts: { bitvavo: { transactions: 2, capitalFlows: 1 } },
    ...o,
  }
}

describe('import planner (dry run)', () => {
  test('a valid batch plans every row and reconciles to the verified end position', () => {
    const plan = planImport(batch())
    assert.deepEqual(plan.errors, [])
    assert.equal(plan.ok, true)
    assert.equal(plan.toInsert.transactions.length, 2)
    assert.equal(plan.toInsert.capitalFlows.length, 1)
    const s = plan.perPlatform.bitvavo!
    assert.ok(Math.abs(s.buysEur - (90 + 0.2 + 180 + 0.2)) < 1e-9)
    assert.equal(s.flowsInEur, 300)
    assert.deepEqual(s.endPositions, [{ instrumentKey: 'CRYPTO:BTC', quantity: 0.003 }])
  })

  test('a second run over the same exports inserts zero rows (idempotent)', () => {
    const b = batch()
    const second = planImport(b, existingAfterApply(b))
    assert.equal(second.ok, true)
    assert.equal(second.toInsert.transactions.length, 0)
    assert.equal(second.toInsert.capitalFlows.length, 0)
    assert.equal(second.toInsert.positions.length, 0)
    assert.equal(second.perPlatform.bitvavo!.transactions.alreadyPresent, 2)
  })

  test('the same key with different content is a conflict, never an overwrite', () => {
    const b = batch()
    const existing = existingAfterApply(b)
    const changed = batch({ transactions: [tx({ externalId: 'bitvavo:1', fee: 0.3 }), b.transactions[1]] })
    const plan = planImport(changed, existing)
    assert.equal(plan.ok, false)
    assert.ok(plan.errors.some((e) => e.includes('conflict')))
  })

  test('refuses an account that already contains unrelated data', () => {
    const plan = planImport(batch(), { ...EMPTY_EXISTING, foreignRowCount: 3 })
    assert.equal(plan.ok, false)
  })

  test('refuses a mismatch with the verified end position or counts', () => {
    assert.equal(planImport(batch({ expectedPositions: [{ platform: 'bitvavo', instrumentKey: 'CRYPTO:BTC', quantity: 0.004 }] })).ok, false)
    assert.equal(planImport(batch({ expectedCounts: { bitvavo: { transactions: 53 } } })).ok, false)
  })

  test('refuses foreign-currency rows without historical FX, contribution-flagged rows and estimated sources', () => {
    const noFx = planImport(batch({ transactions: [tx({ priceCurrency: 'USD', fxRateToEur: null })], expectedPositions: [] }))
    assert.ok(noFx.errors.some((e) => e.includes('historical FX')))

    const flagged = planImport(batch({ transactions: [{ ...tx({}), isContribution: true } as unknown as ImportTransaction], expectedPositions: [] }))
    assert.ok(flagged.errors.some((e) => e.includes('is_contribution=false')))

    const estimated = planImport(batch({
      capitalFlows: [{ ...batch().capitalFlows[0], source: 'manual_abn_import_2025_2026_even_monthly_v1' }],
    }))
    assert.ok(estimated.errors.some((e) => e.includes('estimated')))
  })

  test('refuses selling more than was held at that moment', () => {
    const plan = planImport(batch({
      transactions: [tx({ type: 'sell', externalId: 'bitvavo:s', quantity: 1 })],
      expectedPositions: [],
    }))
    assert.ok(plan.errors.some((e) => e.includes('only 0 held')))
  })

  test('duplicate keys inside one batch are rejected', () => {
    const plan = planImport(batch({ transactions: [tx({}), tx({})] }))
    assert.ok(plan.errors.some((e) => e.includes('Duplicate')))
  })
})

describe('stable source ids', () => {
  test('native ids are prefixed; hashed ids are deterministic and keep identical rows distinct', () => {
    assert.equal(externalIdFromNative('tr', ' abc '), 'tr:abc')
    const rows = [
      { date: '2026-02-05', amount: 300, description: 'iDEAL Deposit' },
      { date: '2026-02-05', amount: 300, description: 'iDEAL Deposit' },
      { amount: 120, date: '2026-02-12', description: 'iDEAL Deposit' },
    ]
    const ids = externalIdsFromFields('degiro', rows)
    assert.equal(new Set(ids).size, 3)
    assert.deepEqual(externalIdsFromFields('degiro', rows), ids)
    // Field order does not matter.
    assert.equal(externalIdsFromFields('degiro', [rows[2]])[0], externalIdsFromFields('degiro', [{ description: 'iDEAL Deposit', date: '2026-02-12', amount: 120 }])[0])
  })
})

describe('an order recorded by hand is never imported twice or overwritten', () => {
  // The Alphabet (Google) order entered from the Trade Republic order PDF.
  const pdfRow = {
    id: 'pdf', user_id: 'u', investment_id: 'abec', type: 'buy' as const, quantity: 1.737405, price_per_unit: 252.1,
    amount: 438, fee: 1, date: '2026-10-29', notes: null, created_at: '2026-10-29T13:44:04Z', price_currency: 'EUR',
    fee_currency: 'EUR', fx_rate_to_eur: 1, recurring_rule_id: null, is_contribution: false, contribution_source: null,
    source: 'trade_republic_order_pdf', external_id: 'c366-64d7:002d-5b83', source_datetime: '2026-10-29T13:34:00Z',
  }
  const csvRow = tx({
    platform: 'trade_republic', source: 'source_migration_trade_republic', externalId: 'tr:other-id-scheme',
    instrumentKey: 'ISIN:US02079K1079', date: '2026-10-29', quantity: 1.737405, pricePerUnit: 252.1, fee: 1,
    sourceDatetime: '2026-10-29T13:34:00Z',
  })
  const batchWith = (t: ImportTransaction) =>
    batch({
      positions: [{ platform: 'trade_republic', instrumentKey: 'ISIN:US02079K1079', name: 'Alphabet Class C', type: 'stock', currency: 'EUR', quantityUnit: 'unit' }],
      transactions: [t],
      capitalFlows: [],
      expectedPositions: [],
      expectedCounts: {},
    })

  test('the same execution under another source/key is refused (link the keys), not inserted', () => {
    const existing = {
      ...EMPTY_EXISTING,
      economicIndex: economicIndexFromExisting([{ tx: pdfRow, platform: 'trade_republic', instrumentKey: 'ISIN:US02079K1079' }]),
    }
    const plan = planImport(batchWith(csvRow), existing)
    assert.equal(plan.ok, false)
    assert.equal(plan.toInsert.transactions.length, 0)
    assert.ok(plan.errors.some((e) => e.includes('trade_republic_order_pdf|c366-64d7:002d-5b83')))
  })

  test('a genuinely different execution on the same day is still imported', () => {
    const existing = {
      ...EMPTY_EXISTING,
      economicIndex: economicIndexFromExisting([{ tx: pdfRow, platform: 'trade_republic', instrumentKey: 'ISIN:US02079K1079' }]),
    }
    const plan = planImport(batchWith({ ...csvRow, quantity: 0.5, externalId: 'tr:another' }), existing)
    assert.equal(plan.ok, true)
    assert.equal(plan.toInsert.transactions.length, 1)
  })
})
