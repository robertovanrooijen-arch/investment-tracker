import type { SupabaseClient } from '@supabase/supabase-js'
import type { Investment } from '@/types/database'
import { txFeeInEur, txNativeToEur } from '@/lib/domain/calculations'
import { tradeGrossNative } from '@/lib/domain/trade-amounts'
import { replayInvestment } from '@/lib/domain/investment-result'
import { CURRENT_PL_DEFINITION_VERSION } from '@/lib/domain/snapshot-method'
import type { CurrentValuation, CurrentValueQuality } from '@/lib/domain/current-valuation'
import type { PortfolioState } from '@/lib/returns/load-returns'

// ---------------------------------------------------------------------------
// Snapshots are written from the CENTRAL current valuation only — the same
// positions, prices, FX and quality as the headline every page shows — so a
// stored snapshot of today is exactly the value Dashboard and History show.
//
//   * incomplete valuation → nothing is written (no portfolio row, no
//     position rows): a partial snapshot would look complete later;
//   * total_value_eur = the shown value (cash per the cash policy; broker
//     cash kept apart goes to implied_cash_eur, audit only);
//   * P/L definition v3 (see snapshot-method): realised = trade result +
//     dividends/interest − separate costs − taxes; platform rewards are
//     contributions, not profit.
// Provenance/quality columns are written only when they exist
// (SNAPSHOT_QUALITY_COLUMNS=enabled, migrations M7 + M15).
// ---------------------------------------------------------------------------

export type SnapshotRow = Record<string, string | number | null>

export type CentralSnapshotRows =
  | { ok: true; portfolio: SnapshotRow; positions: SnapshotRow[]; quality: CurrentValueQuality | null }
  | { ok: false; reason: string; fxRelated: boolean }

// investment_snapshots.quality (M11 vocabulary) for each central quality.
const ROW_QUALITY: Record<CurrentValueQuality, string | null> = {
  confirmed: 'official',
  derived: 'exact',
  estimated: 'benchmark_only',
  owner_reported: null, // no value for it in the column's vocabulary
}

export function buildCentralSnapshotRows(
  state: Pick<PortfolioState, 'investments' | 'transactions' | 'fxRates' | 'valuation'>,
  args: { userId: string; source: string; today: string; now: string; writeQuality: boolean }
): CentralSnapshotRows {
  const v: CurrentValuation = state.valuation
  if (v.status !== 'ok' || v.totalEur === null || v.positionsEur === null) {
    return {
      ok: false,
      reason: `Snapshot not written: the central valuation is incomplete (missing FX or price) — ${v.gaps[0]?.reason ?? 'unknown gap'}`,
      fxRelated: v.gaps.some((g) => g.source === 'fx_rate' || g.source === 'transaction_fx' || g.source === 'ecb_fx'),
    }
  }
  const { investments, transactions, fxRates } = state
  const { userId, source, today, now, writeQuality } = args
  const byId = new Map(investments.map((i) => [i.id, i]))
  // Realised (definition v3) per investment over its whole history.
  const realisedOf = (inv: Investment) => {
    const r = replayInvestment(inv, transactions, fxRates, '0000-01-01', today)
    return r.realisedEur + r.dividendsInterestEur - r.costsEur - r.taxesEur
  }
  const realisedTotal = investments.reduce((s, inv) => s + realisedOf(inv), 0)
  const everInvested = transactions
    .filter((t) => t.type === 'buy' && t.quantity != null)
    .reduce((s, t) => s + txNativeToEur(tradeGrossNative(t), t, fxRates) + txFeeInEur(t, fxRates), 0)
  const unrealisedTotal = v.positions.reduce((s, p) => s + (p.unrealisedEur as number), 0)
  if (![realisedTotal, everInvested, unrealisedTotal].every(Number.isFinite)) {
    return { ok: false, reason: 'Snapshot not written: a realised or cost figure is unknown (missing FX).', fxRelated: true }
  }

  const portfolio: SnapshotRow = {
    user_id: userId,
    date: today,
    total_value_eur: v.totalEur,
    total_invested_eur: v.costOfOpenPositionsEur,
    total_realized_eur: realisedTotal,
    total_unrealized_eur: unrealisedTotal,
    total_ever_invested_eur: everInvested,
    snapshot_source: source,
    updated_at: now,
    ...(writeQuality
      ? {
          method: 'live',
          pl_definition_version: CURRENT_PL_DEFINITION_VERSION,
          stale_positions: 0, // a stale price makes the valuation incomplete
          fx_incomplete_positions: 0,
          positions_incomplete: 0,
          implied_cash_eur: v.brokerCash.presentation === 'separate' ? v.cashEur : null,
        }
      : {}),
  }
  const positions: SnapshotRow[] = v.positions.map((p) => {
    const inv = byId.get(p.investmentId)!
    return {
      user_id: userId,
      investment_id: p.investmentId,
      date: today,
      value_eur: p.valueEur,
      remaining_cost_basis_eur: p.remainingCostEur,
      realized_profit_eur: realisedOf(inv),
      unrealized_profit_eur: p.unrealisedEur,
      quantity: p.quantity,
      current_price_native: p.priceNative,
      currency: p.currency,
      snapshot_source: source,
      updated_at: now,
      ...(writeQuality
        ? {
            price_status: 'fresh',
            price_as_of: p.priceAsOf,
            fx_eur_per_unit: p.fxEurPerUnit,
            method: 'live',
            pl_definition_version: CURRENT_PL_DEFINITION_VERSION,
            unit: inv.quantity_unit ?? 'unit',
            quality: p.quality ? ROW_QUALITY[p.quality] : null,
            fetched_at: now,
          }
        : {}),
    }
  })
  return { ok: true, portfolio, positions, quality: v.quality }
}

export type CentralSnapshotResult = {
  snapshot: SnapshotRow | null
  snapshotError: string | null
  investmentSnapshots: { upserted: number; error: string | null }
  quality: 'complete' | 'fx_incomplete' | 'incomplete'
  valuationQuality: CurrentValueQuality | null
}

/** Writes today's portfolio + position snapshots from the central valuation, or nothing. */
export async function writeCentralSnapshots(
  supabase: SupabaseClient,
  state: Pick<PortfolioState, 'investments' | 'transactions' | 'fxRates' | 'valuation'>,
  args: { userId: string; source: string; today: string; now: string; writeQuality: boolean }
): Promise<CentralSnapshotResult> {
  const rows = buildCentralSnapshotRows(state, args)
  if (!rows.ok) {
    return {
      snapshot: null, snapshotError: rows.reason, investmentSnapshots: { upserted: 0, error: null },
      quality: rows.fxRelated ? 'fx_incomplete' : 'incomplete', valuationQuality: null,
    }
  }
  const { data, error } = await supabase
    .from('portfolio_snapshots')
    .upsert(rows.portfolio, { onConflict: 'user_id,date' })
    .select('date, total_value_eur, total_invested_eur, total_realized_eur, total_unrealized_eur, total_ever_invested_eur, snapshot_source, updated_at')
    .single()
  if (error) {
    return {
      snapshot: null, snapshotError: error.message, investmentSnapshots: { upserted: 0, error: null },
      quality: 'incomplete', valuationQuality: rows.quality,
    }
  }
  let upserted = 0
  let positionsError: string | null = null
  if (rows.positions.length) {
    const res = await supabase.from('investment_snapshots').upsert(rows.positions, { onConflict: 'user_id,investment_id,date' })
    if (res.error) positionsError = res.error.message
    else upserted = rows.positions.length
  }
  return {
    snapshot: (data as SnapshotRow) ?? rows.portfolio,
    snapshotError: null,
    investmentSnapshots: { upserted, error: positionsError },
    quality: 'complete',
    valuationQuality: rows.quality,
  }
}
