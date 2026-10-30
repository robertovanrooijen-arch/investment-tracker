import type {
  ImportBatch,
  ImportCapitalFlow,
  ImportPosition,
  ImportTransaction,
  PlatformCode,
} from '@/lib/import/types'
import type { Transaction } from '@/types/database'
import { tradeGrossNative } from '@/lib/domain/trade-amounts'

// ---------------------------------------------------------------------------
// Pure dry-run planner. Given a canonical batch (parsed from original exports)
// and what already exists in the target account, it decides exactly what an
// apply would insert — or refuses. It never writes anything.
//
// Idempotency: every row is keyed by (source, external_id). A row whose key
// already exists with the same content is skipped; with DIFFERENT content it
// is a conflict and the whole plan is rejected (never overwritten).
// ---------------------------------------------------------------------------

export type ExistingState = {
  // key `${source}|${externalId}` → content fingerprint (see fingerprint*)
  transactions: Map<string, string>
  capitalFlows: Map<string, string>
  // key `${platform}|${instrumentKey}`
  positions: Set<string>
  // Rows in the target account that do NOT come from this importer's sources
  // and are NOT transactions (recurring rules, stray snapshots…). Must be 0.
  foreignRowCount: number
  // Economic fingerprint (see economicFingerprint) of EVERY existing
  // transaction, whatever its source → "source|external_id" (or a label for
  // a manual row). A source row that matches one of these under a different
  // key is the same order recorded elsewhere (e.g. a Trade Republic order PDF
  // entered by hand before the CSV import): it is never inserted again and
  // never overwrites the existing row.
  economicIndex?: Map<string, string>
}

export const EMPTY_EXISTING: ExistingState = {
  transactions: new Map(),
  capitalFlows: new Map(),
  positions: new Set(),
  foreignRowCount: 0,
}

export type PlatformSummary = {
  transactions: { insert: number; alreadyPresent: number }
  capitalFlows: { insert: number; alreadyPresent: number }
  buysEur: number
  sellsEur: number
  incomeEur: number
  feesEur: number
  flowsInEur: number
  flowsOutEur: number
  endPositions: { instrumentKey: string; quantity: number }[]
}

export type ImportPlan = {
  ok: boolean
  errors: string[]
  perPlatform: Partial<Record<PlatformCode, PlatformSummary>>
  toInsert: {
    positions: ImportPosition[]
    transactions: ImportTransaction[]
    capitalFlows: ImportCapitalFlow[]
  }
}

export const rowKey = (source: string, externalId: string) => `${source}|${externalId}`
const positionKey = (platform: string, instrumentKey: string) => `${platform}|${instrumentKey}`

export function fingerprintTransaction(t: ImportTransaction): string {
  return JSON.stringify([
    t.platform, t.instrumentKey, t.type, t.date, t.quantity, t.pricePerUnit, t.amount,
    t.fee, t.priceCurrency, t.feeCurrency, t.fxRateToEur,
  ])
}

/**
 * Economic identity of a trade, independent of the source and its id scheme:
 * platform, instrument, type, trade date, quantity (1e-6) and gross amount
 * (cents). Two rows with the same fingerprint are the same execution.
 */
export function economicFingerprint(t: {
  platform: string
  instrumentKey: string
  type: string
  date: string
  quantity: number | null
  grossAmount: number | null
}): string {
  const q = t.quantity === null ? '' : (Math.round(t.quantity * 1e6) / 1e6).toFixed(6)
  const a = t.grossAmount === null ? '' : (Math.round(t.grossAmount * 100) / 100).toFixed(2)
  return [t.platform, t.instrumentKey, t.type, t.date, q, a].join('|')
}

/** Gross amount of a canonical row (q × p for trades, amount otherwise). */
export function canonicalGross(t: ImportTransaction): number | null {
  if (t.type === 'buy' || t.type === 'sell') return t.quantity !== null && t.pricePerUnit !== null ? t.quantity * t.pricePerUnit : t.amount
  return t.amount
}

export function fingerprintCapitalFlow(f: ImportCapitalFlow): string {
  return JSON.stringify([f.platform, f.date, f.direction, f.amountEur, f.flowKind])
}

function toEur(amount: number, currency: string, t: ImportTransaction): number | null {
  if (currency === 'EUR') return amount
  if (currency === t.priceCurrency && t.fxRateToEur !== null && t.fxRateToEur > 0) return amount * t.fxRateToEur
  return null
}

function emptySummary(): PlatformSummary {
  return {
    transactions: { insert: 0, alreadyPresent: 0 },
    capitalFlows: { insert: 0, alreadyPresent: 0 },
    buysEur: 0, sellsEur: 0, incomeEur: 0, feesEur: 0, flowsInEur: 0, flowsOutEur: 0,
    endPositions: [],
  }
}

export function planImport(batch: ImportBatch, existing: ExistingState = EMPTY_EXISTING): ImportPlan {
  const errors: string[] = []
  const perPlatform: Partial<Record<PlatformCode, PlatformSummary>> = {}
  const summary = (p: PlatformCode) => (perPlatform[p] ??= emptySummary())

  if (existing.foreignRowCount > 0) {
    errors.push(
      `Target account already contains ${existing.foreignRowCount} row(s) that are not from this import. Refusing to mix data.`
    )
  }
  if (batch.files.length === 0) errors.push('No source files: an import must come from original exports.')

  // Positions
  const positions = new Map<string, ImportPosition>()
  for (const p of batch.positions) {
    const k = positionKey(p.platform, p.instrumentKey)
    if (positions.has(k)) errors.push(`Duplicate position ${k}.`)
    positions.set(k, p)
  }

  // Transactions: validation, idempotency, EUR totals, replayed end quantities
  const seenTx = new Set<string>()
  const toInsertTx: ImportTransaction[] = []
  const quantities = new Map<string, number>()
  const sorted = [...batch.transactions].sort((a, b) =>
    (a.sourceDatetime ?? a.date) < (b.sourceDatetime ?? b.date) ? -1 : (a.sourceDatetime ?? a.date) > (b.sourceDatetime ?? b.date) ? 1 : 0
  )
  for (const t of sorted) {
    const key = rowKey(t.source, t.externalId)
    const where = `transaction ${key}`
    if (seenTx.has(key)) { errors.push(`Duplicate ${where} within the batch.`); continue }
    seenTx.add(key)

    const pk = positionKey(t.platform, t.instrumentKey)
    if (!positions.has(pk)) errors.push(`${where}: unknown position ${pk}.`)
    if ((t as { isContribution: boolean }).isContribution !== false) {
      errors.push(`${where}: imported transactions must have is_contribution=false.`)
    }
    if (t.priceCurrency !== 'EUR' && !(t.fxRateToEur !== null && t.fxRateToEur > 0)) {
      errors.push(`${where}: ${t.priceCurrency} amount without a historical FX rate.`)
    }

    const s = summary(t.platform)
    const prior = existing.transactions.get(key)
    const economic = existing.economicIndex?.get(
      economicFingerprint({ platform: t.platform, instrumentKey: t.instrumentKey, type: t.type, date: t.date, quantity: t.quantity, grossAmount: canonicalGross(t) })
    )
    if (prior !== undefined) {
      if (prior !== fingerprintTransaction(t)) errors.push(`${where}: already imported with different content (conflict).`)
      else s.transactions.alreadyPresent++
    } else if (economic !== undefined && economic !== key) {
      // Same execution already recorded under another source/key: never a
      // second row, never an overwrite — the keys must be linked explicitly.
      errors.push(`${where}: the same order is already recorded as ${economic}; link the keys instead of inserting.`)
    } else {
      s.transactions.insert++
      toInsertTx.push(t)
    }

    const feeEur = t.fee === 0 ? 0 : toEur(t.fee, t.feeCurrency, t)
    if (feeEur === null) errors.push(`${where}: fee in ${t.feeCurrency} cannot be converted; normalise it to EUR or the price currency.`)
    const fee = feeEur ?? 0
    s.feesEur += fee

    if (t.type === 'buy' || t.type === 'sell') {
      if (t.quantity === null || t.pricePerUnit === null || !(t.quantity > 0)) {
        errors.push(`${where}: ${t.type} needs a positive quantity and a price.`)
        continue
      }
      const gross = toEur(t.quantity * t.pricePerUnit, t.priceCurrency, t) ?? 0
      const held = quantities.get(pk) ?? 0
      if (t.type === 'buy') {
        s.buysEur += gross + fee
        quantities.set(pk, held + t.quantity)
      } else {
        if (t.quantity > held + 1e-9) errors.push(`${where}: sells ${t.quantity} but only ${held} held at that time.`)
        s.sellsEur += gross - fee
        quantities.set(pk, held - t.quantity)
      }
    } else if (t.type === 'dividend' || t.type === 'interest') {
      s.incomeEur += toEur(t.amount ?? 0, t.priceCurrency, t) ?? 0
    } else if (t.type === 'fee') {
      s.feesEur += toEur(t.amount ?? 0, t.priceCurrency, t) ?? 0
    }
  }

  // Capital flows
  const seenFlow = new Set<string>()
  const toInsertFlows: ImportCapitalFlow[] = []
  for (const f of batch.capitalFlows) {
    const key = rowKey(f.source, f.externalId)
    const where = `capital flow ${key}`
    if (seenFlow.has(key)) { errors.push(`Duplicate ${where} within the batch.`); continue }
    seenFlow.add(key)
    if (!(f.amountEur > 0)) errors.push(`${where}: amount must be positive (direction carries the sign).`)
    if (/even_monthly/i.test(f.source)) errors.push(`${where}: estimated sources are not allowed.`)
    const s = summary(f.platform)
    const prior = existing.capitalFlows.get(key)
    if (prior !== undefined) {
      if (prior !== fingerprintCapitalFlow(f)) errors.push(`${where}: already imported with different content (conflict).`)
      else s.capitalFlows.alreadyPresent++
    } else {
      s.capitalFlows.insert++
      toInsertFlows.push(f)
    }
    if (f.direction === 'to_portfolio') s.flowsInEur += f.amountEur
    else s.flowsOutEur += f.amountEur
  }

  // End positions vs. the verified statements
  for (const [pk, qty] of quantities) {
    const [platform, instrumentKey] = pk.split('|') as [PlatformCode, string]
    summary(platform).endPositions.push({ instrumentKey, quantity: qty })
  }
  const expectedKeys = new Set<string>()
  for (const e of batch.expectedPositions) {
    const pk = positionKey(e.platform, e.instrumentKey)
    expectedKeys.add(pk)
    const actual = quantities.get(pk) ?? 0
    if (Math.abs(actual - e.quantity) > (e.tolerance ?? 1e-9)) {
      errors.push(`End position ${pk}: expected ${e.quantity}, import gives ${actual}.`)
    }
  }
  const platformsWithExpectations = new Set(batch.expectedPositions.map((e) => e.platform))
  for (const [pk, qty] of quantities) {
    const platform = pk.split('|')[0] as PlatformCode
    if (platformsWithExpectations.has(platform) && !expectedKeys.has(pk) && Math.abs(qty) > 1e-9) {
      errors.push(`End position ${pk}: ${qty} held but not in the verified statement.`)
    }
  }

  // Verified counts per platform
  for (const [platform, counts] of Object.entries(batch.expectedCounts ?? {}) as [PlatformCode, { transactions?: number; capitalFlows?: number }][]) {
    const s = summary(platform)
    const txTotal = s.transactions.insert + s.transactions.alreadyPresent
    const flowTotal = s.capitalFlows.insert + s.capitalFlows.alreadyPresent
    if (counts.transactions !== undefined && counts.transactions !== txTotal) {
      errors.push(`${platform}: expected ${counts.transactions} transactions, source gives ${txTotal}.`)
    }
    if (counts.capitalFlows !== undefined && counts.capitalFlows !== flowTotal) {
      errors.push(`${platform}: expected ${counts.capitalFlows} capital flows, source gives ${flowTotal}.`)
    }
  }

  const toInsertPositions = [...positions.entries()]
    .filter(([k]) => !existing.positions.has(k))
    .map(([, p]) => p)

  return {
    ok: errors.length === 0,
    errors,
    perPlatform,
    toInsert: { positions: toInsertPositions, transactions: toInsertTx, capitalFlows: toInsertFlows },
  }
}

/**
 * Economic index of the rows ALREADY in the target account (any source,
 * including hand-entered rows such as an order PDF). `instrumentKey` must come
 * from the position ↔ instrument mapping (ISIN), never from the name.
 */
export function economicIndexFromExisting(
  rows: { tx: Transaction; platform: string; instrumentKey: string }[]
): Map<string, string> {
  return new Map(
    rows.map(({ tx, platform, instrumentKey }) => [
      economicFingerprint({
        platform,
        instrumentKey,
        type: tx.type,
        date: tx.date,
        quantity: tx.quantity,
        grossAmount: tx.type === 'buy' || tx.type === 'sell' ? tradeGrossNative(tx) : tx.amount,
      }),
      tx.source && tx.external_id ? rowKey(tx.source, tx.external_id) : `manual row ${tx.id}`,
    ])
  )
}

/** Builds the ExistingState a second run would see after a successful apply. */
export function existingAfterApply(batch: ImportBatch): ExistingState {
  return {
    transactions: new Map(batch.transactions.map((t) => [rowKey(t.source, t.externalId), fingerprintTransaction(t)])),
    capitalFlows: new Map(batch.capitalFlows.map((f) => [rowKey(f.source, f.externalId), fingerprintCapitalFlow(f)])),
    positions: new Set(batch.positions.map((p) => positionKey(p.platform, p.instrumentKey))),
    foreignRowCount: 0,
    economicIndex: new Map(
      batch.transactions.map((t) => [
        economicFingerprint({ platform: t.platform, instrumentKey: t.instrumentKey, type: t.type, date: t.date, quantity: t.quantity, grossAmount: canonicalGross(t) }),
        rowKey(t.source, t.externalId),
      ])
    ),
  }
}
