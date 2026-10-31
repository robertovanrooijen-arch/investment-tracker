import type { SupabaseClient } from '@supabase/supabase-js'
import { fetchYahooPrice } from '@/lib/domain/yahoo-price'
import { hasUnits } from '@/lib/domain/constants'
import { priceForStorage, priceStatusFor, type PriceStatus } from '@/lib/domain/price-update'
import { fetchAllInvestments } from '@/lib/supabase/fetch-user-data'
import { todayLocalIso, type SnapshotSource } from '@/lib/domain/snapshot'
import { loadPortfolioState } from '@/lib/returns/load-returns'
import { writeCentralSnapshots, type SnapshotRow } from '@/lib/domain/central-snapshot'
import type { CurrentValueQuality, DataGap } from '@/lib/domain/current-valuation'
import type { Investment } from '@/types/database'

export type PriceResult = {
  id: string
  name: string
  ticker: string | null
  status: 'success' | 'skipped' | 'failed'
  price?: number
  currency?: string
  reason?: string
  error?: string
}

export type RefreshSummary = {
  prices: {
    total: number
    successful: number
    skipped: number
    failed: number
    results: PriceResult[]
  }
  snapshot: SnapshotRow | null
  snapshotError: string | null
  investmentSnapshots: { upserted: number; error: string | null }
  // Price quality of every position at snapshot time. Persisted only once the
  // pending snapshot-quality columns exist (SNAPSHOT_QUALITY_COLUMNS=enabled);
  // always returned here so a cron/manual run never hides stale prices.
  priceStatusCounts: Record<PriceStatus, number>
  // Open positions without a validated current value.
  skippedIncompleteSnapshots: number
  // 'complete'      → snapshots written (from the central valuation).
  // 'fx_incomplete' → NO snapshot at all: an FX rate is missing.
  // 'incomplete'    → NO snapshot at all: a price or other value is missing.
  // A partial historical snapshot is never stored.
  quality: 'complete' | 'fx_incomplete' | 'incomplete'
  // Quality of the stored value (e.g. 'estimated' with a metal benchmark) and
  // every reason why nothing was written.
  valuationQuality: CurrentValueQuality | null
  valuationGaps: DataGap[]
  fetchedAt: string
}

export function snapshotQualityColumnsEnabled(): boolean {
  return process.env.SNAPSHOT_QUALITY_COLUMNS === 'enabled'
}

/**
 * Refresh prices, recompute metrics, and write today's portfolio + per-investment
 * snapshots for one user. Does NOT refresh FX rates — caller's responsibility.
 *
 * Throws only on catastrophic failures (e.g. cannot read user's investments).
 * Per-ticker price failures are reported in the summary but do not throw.
 */
export async function refreshPortfolioForUser(
  supabase: SupabaseClient,
  userId: string,
  source: SnapshotSource = 'manual_refresh'
): Promise<RefreshSummary> {
  const fetchedAt = new Date().toISOString()

  // 1. Fetch user investments (used to decide which need price refresh).
  const { data: invList, error: invFetchError } = await fetchAllInvestments<
    Pick<Investment, 'id' | 'name' | 'type' | 'ticker' | 'currency' | 'quantity_unit'>
  >(supabase, 'id, name, type, ticker, currency, quantity_unit', { userId })

  if (invFetchError) {
    throw new Error(`Failed to load investments: ${invFetchError.message}`)
  }

  const priceResults: PriceResult[] = []
  const toFetch: {
    id: string
    name: string
    ticker: string
    type: Investment['type']
    currency: string | null
    quantity_unit: Investment['quantity_unit']
  }[] = []

  for (const inv of invList ?? []) {
    if (!hasUnits(inv.type)) continue
    const t = inv.ticker?.trim()
    if (!t) {
      priceResults.push({
        id: inv.id,
        name: inv.name,
        ticker: null,
        status: 'skipped',
        reason: 'No ticker set',
      })
    } else {
      toFetch.push({ id: inv.id, name: inv.name, ticker: t, type: inv.type, currency: inv.currency, quantity_unit: inv.quantity_unit })
    }
  }

  // 2. Fetch prices in parallel; one failure doesn't sink the others.
  const settledPrices = await Promise.allSettled(
    toFetch.map(async (inv) => {
      const quote = await fetchYahooPrice(inv.ticker)
      const checked = priceForStorage(quote.price, quote.currency, inv)
      // A rejected quote (wrong/unknown currency) keeps the old price; the
      // position is then reported as stale instead of silently "refreshed".
      if (!checked.ok) throw new Error(checked.reason)
      const { price, currency } = checked
      const { error: updateError } = await supabase
        .from('investments')
        .update({
          // investments.currency is deliberately NOT updated from Yahoo.
          current_price: price,
          price_last_updated_at: fetchedAt,
          price_source: 'yahoo',
          updated_at: fetchedAt,
        })
        .eq('id', inv.id)
        .eq('user_id', userId)
      if (updateError)
        throw new Error(`DB update failed: ${updateError.message}`)
      return { price, currency }
    })
  )

  for (let i = 0; i < settledPrices.length; i++) {
    const inv = toFetch[i]
    const r = settledPrices[i]
    if (r.status === 'fulfilled') {
      priceResults.push({
        id: inv.id,
        name: inv.name,
        ticker: inv.ticker,
        status: 'success',
        price: r.value.price,
        currency: r.value.currency,
      })
    } else {
      const errMsg =
        r.reason instanceof Error
          ? r.reason.message
          : typeof r.reason === 'string'
            ? r.reason
            : 'Unknown error'
      priceResults.push({
        id: inv.id,
        name: inv.name,
        ticker: inv.ticker,
        status: 'failed',
        error: errMsg,
      })
    }
  }

  const priceSummary = {
    total: priceResults.length,
    successful: priceResults.filter((r) => r.status === 'success').length,
    skipped: priceResults.filter((r) => r.status === 'skipped').length,
    failed: priceResults.filter((r) => r.status === 'failed').length,
    results: priceResults,
  }

  // 3. The CENTRAL valuation on the refreshed prices — the same object every
  //    page shows. Snapshots are written from it, or not at all.
  const today = todayLocalIso()
  const state = await loadPortfolioState(supabase, today, fetchedAt, { userId })
  const refreshedIds = new Set(priceResults.filter((r) => r.status === 'success').map((r) => r.id))
  const openIds = new Set(state.valuation.positions.map((p) => p.investmentId))
  const priceStatusCounts: Record<PriceStatus, number> = { fresh: 0, stale: 0, missing: 0, not_applicable: 0 }
  for (const inv of state.investments) {
    priceStatusCounts[priceStatusFor({
      isUnitBased: hasUnits(inv.type),
      isOpen: openIds.has(inv.id),
      currentPrice: inv.current_price,
      refreshedThisRun: refreshedIds.has(inv.id),
    })]++
  }
  const written = await writeCentralSnapshots(supabase, state, {
    userId, source, today, now: fetchedAt, writeQuality: snapshotQualityColumnsEnabled(),
  })
  return {
    prices: priceSummary,
    snapshot: written.snapshot,
    snapshotError: written.snapshotError,
    investmentSnapshots: written.investmentSnapshots,
    priceStatusCounts,
    skippedIncompleteSnapshots: state.valuation.positions.filter((p) => p.valueEur === null).length,
    quality: written.quality,
    valuationQuality: written.valuationQuality,
    valuationGaps: state.valuation.gaps,
    fetchedAt,
  }
}

/**
 * Refresh global FX rates from Frankfurter, upsert into fx_rates table.
 * Independent of any user. Safe to call once per cron run, or once per
 * user-facing refresh click.
 */
export async function refreshFxRatesGlobal(
  supabase: SupabaseClient
): Promise<{ ok: boolean; error: string | null }> {
  const fetchedAt = new Date().toISOString()

  let json: { rates?: Record<string, number> } | null = null
  try {
    const res = await fetch(
      'https://api.frankfurter.app/latest?from=EUR&to=USD,GBP',
      { cache: 'no-store' }
    )
    if (!res.ok) {
      return { ok: false, error: `FX provider returned ${res.status}.` }
    }
    json = (await res.json()) as { rates?: Record<string, number> }
  } catch {
    return { ok: false, error: 'Could not reach FX provider.' }
  }

  const rates = json?.rates
  if (!rates || typeof rates !== 'object') {
    return { ok: false, error: 'No rates returned from FX provider.' }
  }

  const upserts = [{ currency: 'EUR', eur_per_unit: 1, fetched_at: fetchedAt }]
  for (const [currency, perEur] of Object.entries(rates)) {
    if (typeof perEur !== 'number' || !Number.isFinite(perEur) || perEur <= 0) {
      continue
    }
    upserts.push({ currency, eur_per_unit: 1 / perEur, fetched_at: fetchedAt })
  }

  const { error } = await supabase
    .from('fx_rates')
    .upsert(upserts, { onConflict: 'currency' })

  if (error) return { ok: false, error: error.message }
  return { ok: true, error: null }
}