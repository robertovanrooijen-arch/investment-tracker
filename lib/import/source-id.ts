import { createHash } from 'node:crypto'

export function sha256Hex(content: string | Uint8Array): string {
  return createHash('sha256').update(content).digest('hex')
}

/**
 * Stable external id for one source row.
 *
 * - Prefer the platform's own identifier (Bitvavo/Trade Republic transaction
 *   id, DEGIRO order id, Holland Gold order number): `<prefix>:<id>`.
 * - Otherwise hash the row's normalised identifying fields. Rows that are
 *   genuinely identical (same date, amount, description…) get an occurrence
 *   index in source order, so they stay distinct but deterministic across
 *   re-runs of the same file.
 *
 * Never derived from row position alone (re-exports can reorder rows) and
 * never from database UUIDs.
 */
export function externalIdFromNative(prefix: string, nativeId: string): string {
  const id = nativeId.trim()
  if (!id) throw new Error(`Empty native id for prefix "${prefix}".`)
  return `${prefix}:${id}`
}

export function externalIdsFromFields(prefix: string, rows: Array<Record<string, string | number | null>>): string[] {
  const seen = new Map<string, number>()
  return rows.map((row) => {
    const canonical = Object.keys(row)
      .sort()
      .map((k) => `${k}=${row[k] === null ? '' : String(row[k]).trim()}`)
      .join('|')
    const digest = sha256Hex(canonical).slice(0, 32)
    const occurrence = seen.get(digest) ?? 0
    seen.set(digest, occurrence + 1)
    return `${prefix}:h:${digest}:${occurrence}`
  })
}
