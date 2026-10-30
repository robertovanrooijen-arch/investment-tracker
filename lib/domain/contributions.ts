import type { CapitalFlowDirection, Transaction } from '@/types/database'
import type { FxRates } from '@/lib/domain/fx'
import { txFeeInEur, txNativeToEur } from '@/lib/domain/calculations'
import { tradeGrossNative } from '@/lib/domain/trade-amounts'

export type ContribRow = {
  id: string
  flow_date: string          // 'YYYY-MM-DD'
  monthKey: string           // 'YYYY-MM' — derived from flow_date, timezone-safe
  year: number
  platform: string
  direction: CapitalFlowDirection
  amount_eur: number
  // 'ledger' = capital_flow_entries row (the single source of truth for
  //            external money in/out)
  // 'transaction' = LEGACY compatibility only: a manually-entered transaction
  //            still flagged is_contribution=true that has not yet been
  //            migrated to a capital_flow_entries row. See
  //            buildExternalCashFlowRows.
  source: 'ledger' | 'transaction'
  notes: string | null
  created_at: string
}

type TxWithPlatform = Transaction & { investment?: { platform: string } | null }

/**
 * The capital_flow_entries fields this module needs. `linked_transaction_id`
 * only exists after the proposed migration; until then it is simply absent
 * (undefined), which makes every legacy transaction still count — the same
 * behaviour as before this change.
 */
export type CapitalFlowLike = {
  id?: string
  flow_date: string
  year: number
  platform?: string
  direction: CapitalFlowDirection
  amount_eur: number | string
  notes?: string | null
  created_at?: string | null
  linked_transaction_id?: string | null
  // Present only after the pending migration. Two flows with the same
  // transfer_group_id (one out of a platform, one into another) are the SAME
  // money moving inside the portfolio — never an external contribution.
  transfer_group_id?: string | null
}

/**
 * LEGACY: converts a transaction flagged is_contribution=true into an external
 * cash-flow row. Kept only so the remaining legacy rows keep counting until
 * they are migrated to capital_flow_entries.
 *
 * Fees are converted with their own fee_currency (a EUR fee is never
 * multiplied by a USD price rate); the gross amount uses the row's own
 * historical fx_rate_to_eur.
 */
export function txToContribRow(tx: TxWithPlatform, fxRates?: FxRates): ContribRow | null {
  let direction: ContribRow['direction']
  let amount_eur: number

  if (tx.type === 'buy') {
    direction = 'to_portfolio'
    amount_eur =
      txNativeToEur(tradeGrossNative(tx), tx, fxRates) +
      txFeeInEur(tx, fxRates)
  } else if (tx.type === 'deposit') {
    direction = 'to_portfolio'
    amount_eur = txNativeToEur(tx.amount ?? 0, tx, fxRates) + txFeeInEur(tx, fxRates)
  } else if (tx.type === 'withdraw') {
    direction = 'from_portfolio'
    amount_eur = txNativeToEur(tx.amount ?? 0, tx, fxRates)
  } else {
    // sell, dividend, interest, fee, value update — never affect contributions
    return null
  }

  return {
    id: tx.id,
    flow_date: tx.date,
    monthKey: tx.date.slice(0, 7),
    year: Number(tx.date.slice(0, 4)),
    platform: tx.investment?.platform ?? 'Unknown',
    direction,
    amount_eur,
    source: 'transaction',
    notes: tx.notes,
    created_at: tx.created_at,
  }
}

export type ExternalCashFlowResult = {
  rows: ContribRow[]
  // Legacy is_contribution transactions still counted (not yet migrated).
  legacyTransactionCount: number
  // Legacy rows skipped because a capital_flow_entries row now represents them.
  supersededLegacyCount: number
  // Imported rows (external_id set) flagged is_contribution=true — never
  // counted: imports must book external money as capital_flow_entries.
  ignoredImportedCount: number
  // Explicit transfer groups that are NOT valid internal transfers; their
  // flows keep counting as external (fail-safe) and must be reviewed.
  transferIssues: TransferIssue[]
  // Valid internal transfers excluded from external flows.
  internalTransfers: { groupId: string; outEur: number; inEur: number; costEur: number }[]
  // Legacy rows whose EUR amount is unknown (missing FX). They are NOT in
  // `rows`; callers must treat the affected totals as unknown (fail-closed),
  // never as a smaller total. Kept here with amount_eur = NaN for that purpose.
  fxMissingCount: number
  fxMissingRows: ContribRow[]
}

/**
 * The ONE definition of "external money in/out" used by the Contributions
 * page and every Year Analysis / YTD / Profit-Loss / Performance figure.
 *
 * - Every capital_flow_entries row counts.
 * - A transaction counts only if it is a legacy, manually-entered row
 *   (no external_id) flagged is_contribution=true AND no capital flow links
 *   to it via linked_transaction_id. That link is how a legacy row is
 *   migrated without ever being counted twice.
 * - Sells, dividends, fees and internal reallocations never count.
 */
export function buildExternalCashFlowRows(
  capitalFlows: CapitalFlowLike[],
  transactions: TxWithPlatform[],
  fxRates?: FxRates
): ExternalCashFlowResult {
  const { internalIds, issues: transferIssues, transfers: internalTransfers } = resolveTransferGroups(capitalFlows)

  const rows: ContribRow[] = capitalFlows
    .map((e, i) => ({ e, i }))
    .filter(({ e, i }) => !internalIds.has(e.id ?? `cfe-${i}`))
    .map(({ e, i }) => ({
    id: e.id ?? `cfe-${i}`,
    flow_date: e.flow_date,
    monthKey: getMonthKey(e.flow_date),
    year: e.year,
    platform: e.platform ?? 'Unknown',
    direction: e.direction,
    amount_eur: Number(e.amount_eur),
    source: 'ledger',
    notes: e.notes ?? null,
    created_at: e.created_at ?? '',
  }) as ContribRow)

  const linked = new Set(
    capitalFlows.map((e) => e.linked_transaction_id).filter((id): id is string => !!id)
  )

  let legacyTransactionCount = 0
  let supersededLegacyCount = 0
  let ignoredImportedCount = 0
  let fxMissingCount = 0
  const fxMissingRows: ContribRow[] = []

  for (const tx of transactions) {
    if (!tx.is_contribution) continue
    if (tx.external_id != null) {
      ignoredImportedCount++
      continue
    }
    if (linked.has(tx.id)) {
      supersededLegacyCount++
      continue
    }
    const row = txToContribRow(tx, fxRates)
    if (!row) continue
    if (!Number.isFinite(row.amount_eur)) {
      fxMissingCount++
      fxMissingRows.push({ ...row, amount_eur: NaN })
      continue
    }
    rows.push(row)
    legacyTransactionCount++
  }

  return {
    rows,
    legacyTransactionCount,
    supersededLegacyCount,
    ignoredImportedCount,
    fxMissingCount,
    fxMissingRows,
    transferIssues,
    internalTransfers,
  }
}

// ---------------------------------------------------------------------------
// Internal transfers between platforms
//
// A sale at broker A, a bank transfer and a purchase at broker B can be the
// SAME money. That is only recognised when both capital flows explicitly
// carry the same transfer_group_id (set after review) — never inferred from
// amount and date alone. Where the bank account lies:
//   * bank OUTSIDE the portfolio (default): money parked on the bank between
//     the two legs is outside; the pair is still one internal move as long as
//     both legs are grouped. Ungrouped legs stay an external withdrawal and an
//     external contribution.
//   * bank INSIDE the portfolio (reserved investment cash): model the bank
//     as its own platform; broker ↔ bank legs are then grouped transfers and
//     only salary/savings moving in or out of that bank account is external.
// ---------------------------------------------------------------------------

export const TRANSFER_AMOUNT_TOLERANCE_EUR = 5

export type TransferIssue = {
  groupId: string
  reason: string
  status: 'warning'
}

function resolveTransferGroups(capitalFlows: CapitalFlowLike[]): {
  internalIds: Set<string>
  issues: TransferIssue[]
  transfers: ExternalCashFlowResult['internalTransfers']
} {
  const groups = new Map<string, { id: string; flow: CapitalFlowLike }[]>()
  capitalFlows.forEach((flow, i) => {
    if (!flow.transfer_group_id) return
    const list = groups.get(flow.transfer_group_id) ?? []
    list.push({ id: flow.id ?? `cfe-${i}`, flow })
    groups.set(flow.transfer_group_id, list)
  })

  const internalIds = new Set<string>()
  const issues: TransferIssue[] = []
  const transfers: ExternalCashFlowResult['internalTransfers'] = []
  for (const [groupId, legs] of groups) {
    const out = legs.filter((l) => l.flow.direction === 'from_portfolio')
    const into = legs.filter((l) => l.flow.direction === 'to_portfolio')
    const issue = (reason: string) => issues.push({ groupId, reason, status: 'warning' })
    if (legs.length !== 2 || out.length !== 1 || into.length !== 1) {
      issue('A transfer group needs exactly one outgoing and one incoming flow; counted as external until fixed.')
      continue
    }
    const outEur = Number(out[0].flow.amount_eur)
    const inEur = Number(into[0].flow.amount_eur)
    if (!Number.isFinite(outEur) || !Number.isFinite(inEur)) {
      issue('A transfer leg has no known EUR amount.')
      continue
    }
    if ((out[0].flow.platform ?? '') === (into[0].flow.platform ?? '')) {
      issue('Both legs are on the same platform; that is not a transfer between platforms.')
      continue
    }
    if (into[0].flow.flow_date < out[0].flow.flow_date) {
      issue('The incoming leg is dated before the outgoing leg.')
      continue
    }
    const cost = outEur - inEur
    if (cost < -0.005 || cost > TRANSFER_AMOUNT_TOLERANCE_EUR) {
      issue(`Legs differ by €${cost.toFixed(2)} (more arrived than left, or more than €${TRANSFER_AMOUNT_TOLERANCE_EUR} lost).`)
      continue
    }
    internalIds.add(out[0].id)
    internalIds.add(into[0].id)
    transfers.push({ groupId, outEur, inEur, costEur: cost })
  }
  return { internalIds, issues, transfers }
}

export type TransferSuggestion = { outId: string; inId: string; amountEur: number; days: number }

/**
 * REVIEW AID ONLY: outgoing flows followed within `maxDays` by an incoming
 * flow on another platform for (almost) the same amount. Suggestions are
 * never applied automatically; a person must set transfer_group_id.
 */
export function suggestTransferPairs(
  capitalFlows: (CapitalFlowLike & { id: string })[],
  maxDays = 7
): TransferSuggestion[] {
  const outs = capitalFlows.filter((f) => f.direction === 'from_portfolio' && !f.transfer_group_id)
  const ins = capitalFlows.filter((f) => f.direction === 'to_portfolio' && !f.transfer_group_id)
  const used = new Set<string>()
  const out: TransferSuggestion[] = []
  for (const o of [...outs].sort((a, b) => (a.flow_date < b.flow_date ? -1 : 1))) {
    const oAmt = Number(o.amount_eur)
    const match = ins
      .filter((i) => !used.has(i.id) && i.platform !== o.platform && i.flow_date >= o.flow_date)
      .map((i) => ({ i, days: (Date.parse(i.flow_date) - Date.parse(o.flow_date)) / 86_400_000, diff: oAmt - Number(i.amount_eur) }))
      .filter((c) => c.days <= maxDays && c.diff >= -0.005 && c.diff <= TRANSFER_AMOUNT_TOLERANCE_EUR)
      .sort((a, b) => a.days - b.days || a.diff - b.diff)[0]
    if (match) {
      used.add(match.i.id)
      out.push({ outId: o.id, inId: match.i.id, amountEur: oAmt, days: match.days })
    }
  }
  return out
}

/**
 * External flows (+ into the portfolio, − out of it) for return
 * calculations. Rows with an unknown EUR amount are KEPT (as NaN) so every
 * return that depends on them is unavailable instead of silently wrong.
 */
export function externalFlowsForReturns(result: ExternalCashFlowResult): { date: string; amountEur: number }[] {
  return [...result.rows, ...result.fxMissingRows].map((r) => ({
    date: r.flow_date,
    amountEur: r.direction === 'to_portfolio' ? r.amount_eur : -r.amount_eur,
  }))
}

export function getMonthKey(date: string): string {
  return date.slice(0, 7)
}
