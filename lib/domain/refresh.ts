import type { SupabaseClient } from '@supabase/supabase-js'
import { fetchYahooPrice } from '@/lib/domain/yahoo-price'
import { hasUnits } from '@/lib/domain/constants'
import { priceForStorage, priceStatusFor, type PriceStatus } from '@/lib/domain/price-update'
import {
  computeInvestmentMetrics,
  computePortfolioMetrics,
} from '@/lib/domain/calculations'
import { loadFxRates } from '@/lib/domain/fx'
import { fetchAllInvestments, fetchAllTransactions } from '@/lib/supabase/fetch-user-data'
import {
  upsertTodaysSnapshot,
  upsertTodaysInvestmentSnapshots,
  type InvestmentSnapshotInput,
  type SnapshotSource,
  type UpsertedSnapshot,
} from '@/lib/domain/snapshot'
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
  snapshot: UpsertedSnapshot | null
  snapshotError: string | null
  investmentSnapshots: { upserted: number; error: string | null }
  // Price quality of every position at snapshot time. Persisted only once the
  // pending snapshot-quality columns exist (SNAPSHOT_QUALITY_COLUMNS=enabled);
  // always returned here so a cron/manual run never hides stale prices.
  priceStatusCounts: Record<PriceStatus, number>
  // Positions whose EUR figures are unknown (missing FX).
  skippedIncompleteSnapshots: number
  // 'complete'     → snapshots written.
  // 'fx_incomplete'→ NO snapshot written at all (portfolio or per-position):
  //                  a partial historical snapshot is never stored.
  quality: 'complete' | 'fx_incomplete'
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

  // 3. Re-fetch fresh data, load fresh FX, compute metrics in EUR.
  const [freshInvRes, freshTxRes, freshFx] = await Promise.all([
    fetchAllInvestments(supabase, '*', { userId }),
    fetchAllTransactions(supabase, '*', { userId }),
    loadFxRates(supabase),
  ])

  // A failed read must never become an empty portfolio (and a €0 snapshot).
  if (freshInvRes.error) {
    throw new Error(`Failed to load investments: ${freshInvRes.error.message}`)
  }
  if (freshTxRes.error) {
    throw new Error(`Failed to load transactions: ${freshTxRes.error.message}`)
  }

  const freshInvestments = freshInvRes.data ?? []
  const freshTransactions = freshTxRes.data ?? []
  const fxRates = freshFx.rates

  // 4. Per-position metrics and price quality (computed once, used by both
  //    the portfolio snapshot and the per-investment snapshots).
  const refreshedIds = new Set(
    priceResults.filter((r) => r.status === 'success').map((r) => r.id)
  )
  const priceStatusCounts: Record<PriceStatus, number> = {
    fresh: 0,
    stale: 0,
    missing: 0,
    not_applicable: 0,
  }
  const writeQuality = snapshotQualityColumnsEnabled()
  let skippedIncompleteSnapshots = 0
  const investmentSnapshotInputs: InvestmentSnapshotInput[] = []
  for (const inv of freshInvestments) {
    const metrics = computeInvestmentMetrics(inv, freshTransactions, fxRates)
    const status = priceStatusFor({
      isUnitBased: hasUnits(inv.type),
      isOpen: (metrics.quantity ?? 0) > 0,
      currentPrice: inv.current_price,
      refreshedThisRun: refreshedIds.has(inv.id),
    })
    priceStatusCounts[status]++
    const numbers = [
      metrics.currentValue,
      metrics.remainingCostBasis,
      metrics.realizedProfit,
      metrics.unrealizedProfit,
    ]
    if (!numbers.every(Number.isFinite)) {
      // Unknown EUR figures (missing FX) are not written as a fake number.
      skippedIncompleteSnapshots++
      continue
    }
    investmentSnapshotInputs.push({
      investmentId: inv.id,
      metrics,
      currentPriceNative: inv.current_price ?? null,
      currency: inv.currency ?? 'EUR',
      quality: writeQuality
        ? {
            price_status: status,
            price_as_of: hasUnits(inv.type) ? inv.price_last_updated_at : null,
            fx_eur_per_unit:
              inv.currency === 'EUR' ? 1 : fxRates[inv.currency ?? 'EUR'] ?? null,
          }
        : undefined,
    })
  }

  // 5. Portfolio-level snapshot — FAIL-CLOSED. If any required figure is
  //    unknown, nothing is written for today (neither the portfolio row nor
  //    the per-position rows): a partial snapshot would look complete later.
  const portfolioMetrics = computePortfolioMetrics(
    freshInvestments,
    freshTransactions,
    fxRates
  )
  if (!portfolioMetrics.complete || skippedIncompleteSnapshots > 0) {
    return {
      prices: priceSummary,
      snapshot: null,
      snapshotError:
        `Snapshot not written: ${Math.max(portfolioMetrics.fxIncompleteCount, skippedIncompleteSnapshots)} ` +
        'position(s) have a missing FX rate, so portfolio totals are incomplete.',
      investmentSnapshots: { upserted: 0, error: null },
      priceStatusCounts,
      skippedIncompleteSnapshots,
      quality: 'fx_incomplete',
      fetchedAt,
    }
  }
  const { snapshot, error: snapshotError } = await upsertTodaysSnapshot(
    supabase,
    userId,
    portfolioMetrics,
    source,
    snapshotQualityColumnsEnabled()
      ? {
          stale_positions: priceStatusCounts.stale + priceStatusCounts.missing,
          fx_incomplete_positions: portfolioMetrics.fxIncompleteCount,
        }
      : undefined
  )

  // 6. Per-investment snapshots (in EUR).
  const { upserted, error: invSnapshotError } =
    await upsertTodaysInvestmentSnapshots(
      supabase,
      userId,
      investmentSnapshotInputs,
      source
    )

  return {
    prices: priceSummary,
    snapshot: snapshot ?? null,
    snapshotError,
    investmentSnapshots: { upserted, error: invSnapshotError },
    priceStatusCounts,
    skippedIncompleteSnapshots,
    quality: 'complete',
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