import type { Investment, Transaction } from '@/types/database'
import type { FxRates } from '@/lib/domain/fx'
import { hasUnits } from '@/lib/domain/constants'
import { computeInvestmentMetrics, txFeeInEur, txNativeToEur } from '@/lib/domain/calculations'
import { allocateSale, isEffectivelyZero, QUANTITY_EPSILON } from '@/lib/domain/cost-basis'
import { tradeAmounts, tradeGrossNative } from '@/lib/domain/trade-amounts'
import { investmentPriceUnit } from '@/lib/domain/price-normalization'

// ---------------------------------------------------------------------------
// Source reconciliation audit (pure, read-only).
//
// Status order (worst wins):
//   blocked   — the figures are wrong or cannot be trusted (oversell, missing
//               FX/price, duplicate keys, mismatch with an official source);
//   warning   — something must be explained (missing source key, amount
//               deviation, possible double booking, unexplained cash);
//   derived   — internally consistent, but not confirmed by an official
//               source (no statement given) — never shown as green;
//   confirmed — matches an official source that was actually provided.
// ---------------------------------------------------------------------------

export type AuditStatus = 'confirmed' | 'derived' | 'warning' | 'blocked'

const RANK: Record<AuditStatus, number> = { confirmed: 0, derived: 1, warning: 2, blocked: 3 }
export const worstStatus = (...s: AuditStatus[]): AuditStatus =>
  s.reduce((w, x) => (RANK[x] > RANK[w] ? x : w), 'confirmed' as AuditStatus)

export type AuditFinding = { status: AuditStatus; check: string; detail: string }

export type OfficialPosition = { investmentId: string; quantity: number; asOf: string; source: string; tolerance?: number }
export type OfficialCash = { platform: string; amountEur: number; asOf: string; source: string }
export type SourceFileCount = { source: string; file: string; expectedRows: number }

export type PositionAudit = {
  investmentId: string
  name: string
  platform: string
  boughtQuantity: number
  soldQuantity: number
  endQuantity: number
  officialQuantity: number | null
  status: AuditStatus
  findings: AuditFinding[]
}

export type PlatformAudit = {
  platform: string
  status: AuditStatus
  positions: PositionAudit[]
  // Cash implied by the books: external in − out − buys + sells + income − fees.
  impliedCashEur: number
  officialCashEur: number | null
  findings: AuditFinding[]
}

export type ReconciliationReport = {
  status: AuditStatus
  platforms: PlatformAudit[]
  findings: AuditFinding[] // account-level (keys, source files)
}

type FlowLike = { platform?: string; direction: 'to_portfolio' | 'from_portfolio'; amount_eur: number | string }

const PRICE_STALE_DAYS = 7

/**
 * Cash a platform should hold according to the books, optionally as of a
 * date (inclusive): external flows in − out − buys (incl. fee) + net sales +
 * net income − separate fees ± deposit/withdraw rows. 'derived', never
 * official: compare with a broker statement before trusting it.
 */
export function impliedPlatformCash(
  platform: string,
  investments: Investment[],
  transactions: Transaction[],
  capitalFlows: (FlowLike & { flow_date?: string })[],
  fxRates: FxRates,
  upToDate?: string
): number {
  const invIds = new Set(investments.filter((i) => i.platform === platform).map((i) => i.id))
  let cash = 0
  for (const f of capitalFlows.filter((x) => (x.platform ?? 'Unknown') === platform)) {
    if (upToDate && f.flow_date && f.flow_date > upToDate) continue
    cash += (f.direction === 'to_portfolio' ? 1 : -1) * Number(f.amount_eur)
  }
  for (const t of transactions.filter((x) => invIds.has(x.investment_id) && (!upToDate || x.date <= upToDate))) {
    const fee = txFeeInEur(t, fxRates)
    if (t.type === 'buy') cash -= txNativeToEur(tradeGrossNative(t), t, fxRates) + fee
    else if (t.type === 'sell') cash += txNativeToEur(tradeGrossNative(t), t, fxRates) - fee
    else if (t.type === 'dividend' || t.type === 'interest') cash += txNativeToEur(t.amount ?? 0, t, fxRates) - fee
    else if (t.type === 'fee') cash -= txNativeToEur(t.amount ?? 0, t, fxRates)
    else if (t.type === 'deposit') cash += txNativeToEur(t.amount ?? 0, t, fxRates)
    else if (t.type === 'withdraw') cash -= txNativeToEur(t.amount ?? 0, t, fxRates)
  }
  return cash
}

/**
 * Platforms whose purchases are not funded in the books (implied cash below
 * −€1): money entered positions without any recorded contribution, sale or
 * income. Returns then count that position's value as gain. Audit
 * information only — no cash position is created from it.
 */
export function unfundedPlatforms(
  investments: Investment[],
  transactions: Transaction[],
  capitalFlows: (FlowLike & { flow_date?: string })[],
  fxRates: FxRates
): { platform: string; shortfallEur: number }[] {
  const platforms = new Set([...investments.map((i) => i.platform), ...capitalFlows.map((f) => f.platform ?? 'Unknown')])
  const out: { platform: string; shortfallEur: number }[] = []
  for (const platform of platforms) {
    const cash = impliedPlatformCash(platform, investments, transactions, capitalFlows, fxRates)
    if (Number.isFinite(cash) && cash < -1) out.push({ platform, shortfallEur: -cash })
  }
  return out.sort((a, b) => a.platform.localeCompare(b.platform))
}

export function reconcileAccount(input: {
  investments: Investment[]
  transactions: Transaction[]
  capitalFlows: FlowLike[]
  fxRates: FxRates
  asOf: string // YYYY-MM-DD
  officialPositions?: OfficialPosition[]
  officialCash?: OfficialCash[]
  sourceFiles?: SourceFileCount[]
}): ReconciliationReport {
  const { investments, transactions, capitalFlows, fxRates, asOf } = input
  const accountFindings: AuditFinding[] = []

  // ── Account level: source keys and source-file row counts ──
  const keyCount = new Map<string, number>()
  let missingKeys = 0
  for (const t of transactions) {
    if (!t.source || !t.external_id) {
      missingKeys++
      continue
    }
    const k = `${t.source}|${t.external_id}`
    keyCount.set(k, (keyCount.get(k) ?? 0) + 1)
  }
  const dupKeys = [...keyCount.values()].filter((c) => c > 1).length
  accountFindings.push(
    dupKeys > 0
      ? { status: 'blocked', check: 'duplicate source keys', detail: `${dupKeys} (source, external_id) key(s) occur more than once.` }
      : { status: 'confirmed', check: 'duplicate source keys', detail: 'Every (source, external_id) key is unique.' }
  )
  if (missingKeys > 0) {
    accountFindings.push({ status: 'warning', check: 'missing source keys', detail: `${missingKeys} transaction(s) have no source/external_id.` })
  }
  for (const f of input.sourceFiles ?? []) {
    const actual = transactions.filter((t) => t.source === f.source).length
    accountFindings.push(
      actual === f.expectedRows
        ? { status: 'confirmed', check: `row count ${f.file}`, detail: `${actual} rows, as in the source file.` }
        : { status: 'blocked', check: `row count ${f.file}`, detail: `Source file has ${f.expectedRows} rows, ${actual} imported.` }
    )
  }
  if (!input.sourceFiles || input.sourceFiles.length === 0) {
    accountFindings.push({ status: 'derived', check: 'source file row counts', detail: 'No source-file row counts provided.' })
  }

  // ── Per position ──
  const byPlatform = new Map<string, PositionAudit[]>()
  const officialByInv = new Map((input.officialPositions ?? []).map((o) => [o.investmentId, o]))

  for (const inv of investments) {
    const txs = transactions
      .filter((t) => t.investment_id === inv.id)
      .sort((a, b) => (a.date !== b.date ? (a.date < b.date ? -1 : 1) : a.created_at < b.created_at ? -1 : 1))
    const findings: AuditFinding[] = []
    let held = 0
    let bought = 0
    let sold = 0
    let cost = 0

    if (hasUnits(inv.type)) {
      if (investmentPriceUnit(inv) === null) {
        findings.push({ status: 'blocked', check: 'unit', detail: 'Commodity without a quantity unit.' })
      }
      for (const t of txs) {
        if (t.type === 'buy' && t.quantity !== null) {
          held += t.quantity
          bought += t.quantity
          cost += tradeGrossNative(t)
        } else if (t.type === 'sell' && t.quantity !== null) {
          if (t.quantity > held + QUANTITY_EPSILON) {
            findings.push({ status: 'blocked', check: 'oversell', detail: `${t.date}: sells ${t.quantity}, only ${held} held.` })
          }
          const sale = allocateSale(held, cost, cost, t.quantity)
          sold += t.quantity
          if (sale) {
            held = sale.closesPosition ? 0 : held - sale.quantity
            cost -= sale.soldCostNative
          } else {
            held -= t.quantity
          }
          if (held < -QUANTITY_EPSILON) {
            findings.push({ status: 'blocked', check: 'negative quantity', detail: `${t.date}: quantity ${held}.` })
          }
        }
        const amounts = tradeAmounts(t)
        if (amounts && !amounts.consistent) {
          findings.push({
            status: 'warning',
            check: 'broker amount',
            detail: `${t.date}: broker gross ${amounts.grossNative.toFixed(2)} vs quantity × price ${amounts.quantityPriceGross.toFixed(2)}.`,
          })
        }
        if (amounts && amounts.quality === 'derived') {
          findings.push({ status: 'derived', check: 'broker amount', detail: `${t.date}: no verified amount semantics for source "${t.source ?? '—'}"; quantity × price used.` })
        }
      }
      const residue = bought - sold
      if (residue !== 0 && isEffectivelyZero(residue)) {
        findings.push({ status: 'confirmed', check: 'floating-point residue', detail: `Residue ${residue.toExponential(2)} treated as exactly 0.` })
      }
    }

    // Possible double bookings of fees / dividends / interest.
    const seen = new Map<string, number>()
    for (const t of txs.filter((x) => x.type === 'fee' || x.type === 'dividend' || x.type === 'interest')) {
      const k = `${t.type}|${t.date}|${t.amount}|${t.fee}`
      seen.set(k, (seen.get(k) ?? 0) + 1)
    }
    for (const [k, c] of seen) {
      if (c > 1) findings.push({ status: 'warning', check: 'possible double booking', detail: `${c}× ${k.split('|').slice(0, 3).join(' ')}.` })
    }

    // FX, price, currency.
    const m = computeInvestmentMetrics(inv, transactions, fxRates)
    if (m.fxStatus === 'incomplete') findings.push({ status: 'blocked', check: 'FX', detail: 'A historical or current FX rate is missing.' })
    if (m.fxStatus === 'live_rate_fallback') findings.push({ status: 'warning', check: 'FX', detail: 'A legacy row uses today\'s FX rate.' })
    const open = hasUnits(inv.type) && !m.isClosed && (m.quantity ?? 0) > 0
    if (open) {
      if (inv.current_price === null || !(inv.current_price > 0)) {
        findings.push({ status: 'blocked', check: 'price', detail: 'Open position without a current price.' })
      } else if (inv.price_last_updated_at) {
        const age = (Date.parse(`${asOf}T00:00:00Z`) - Date.parse(inv.price_last_updated_at)) / 86_400_000
        if (age > PRICE_STALE_DAYS) findings.push({ status: 'warning', check: 'price', detail: `Price is ${Math.floor(age)} days old.` })
      }
      if (!/^[A-Z]{3}$/.test(inv.currency ?? '')) findings.push({ status: 'blocked', check: 'currency', detail: `Invalid currency "${inv.currency}".` })
    }

    // Official end position.
    const official = officialByInv.get(inv.id) ?? null
    const endQuantity = hasUnits(inv.type) ? (isEffectivelyZero(held) ? 0 : held) : 0
    if (hasUnits(inv.type)) {
      if (official) {
        const tol = official.tolerance ?? 1e-6
        findings.push(
          Math.abs(official.quantity - endQuantity) <= tol
            ? { status: 'confirmed', check: 'official end position', detail: `${endQuantity} = ${official.source} (${official.asOf}).` }
            : { status: 'blocked', check: 'official end position', detail: `Books ${endQuantity}, ${official.source} ${official.quantity} (${official.asOf}).` }
        )
      } else {
        findings.push({ status: 'derived', check: 'official end position', detail: 'No official end position provided.' })
      }
    }

    const audit: PositionAudit = {
      investmentId: inv.id,
      name: inv.name,
      platform: inv.platform,
      boughtQuantity: bought,
      soldQuantity: sold,
      endQuantity,
      officialQuantity: official?.quantity ?? null,
      status: worstStatus(...findings.map((f) => f.status)),
      findings,
    }
    const list = byPlatform.get(inv.platform) ?? []
    list.push(audit)
    byPlatform.set(inv.platform, list)
  }

  // ── Per platform: implied cash ──
  const platforms: PlatformAudit[] = []
  const platformNames = new Set([...byPlatform.keys(), ...capitalFlows.map((f) => f.platform ?? 'Unknown')])
  for (const platform of platformNames) {
    const cash = impliedPlatformCash(platform, investments, transactions, capitalFlows, fxRates)
    const findings: AuditFinding[] = []
    const official = (input.officialCash ?? []).find((c) => c.platform === platform) ?? null
    if (!Number.isFinite(cash)) {
      findings.push({ status: 'blocked', check: 'implied cash', detail: 'Implied cash cannot be computed (missing FX).' })
    } else if (official) {
      const diff = cash - official.amountEur
      findings.push(
        Math.abs(diff) <= 0.01
          ? { status: 'confirmed', check: 'broker cash', detail: `Implied €${cash.toFixed(2)} = ${official.source} (${official.asOf}).` }
          : { status: 'warning', check: 'broker cash', detail: `Implied €${cash.toFixed(2)} vs ${official.source} €${official.amountEur.toFixed(2)}: €${diff.toFixed(2)} unexplained.` }
      )
    } else if (cash < -0.01) {
      findings.push({ status: 'warning', check: 'implied cash', detail: `Implied cash is negative (€${cash.toFixed(2)}): an inflow or sale is missing.` })
    } else {
      findings.push({ status: 'derived', check: 'broker cash', detail: `Implied €${cash.toFixed(2)}; no official cash balance provided.` })
    }
    const positions = byPlatform.get(platform) ?? []
    platforms.push({
      platform,
      positions,
      impliedCashEur: cash,
      officialCashEur: official?.amountEur ?? null,
      findings,
      status: worstStatus(...findings.map((f) => f.status), ...positions.map((p) => p.status)),
    })
  }
  platforms.sort((a, b) => a.platform.localeCompare(b.platform))

  return {
    status: worstStatus(...accountFindings.map((f) => f.status), ...platforms.map((p) => p.status)),
    platforms,
    findings: accountFindings,
  }
}
