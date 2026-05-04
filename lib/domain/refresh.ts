import type { SupabaseClient } from '@supabase/supabase-js'
import { fetchYahooPrice } from '@/lib/domain/yahoo-price'
import { hasUnits } from '@/lib/domain/constants'
import {
  computeInvestmentMetrics,
  computePortfolioMetrics,
} from '@/lib/domain/calculations'
import { loadFxRates } from '@/lib/domain/fx'
import {
  upsertTodaysSnapshot,
  upsertTodaysInvestmentSnapshots,
  type SnapshotSource,
  type UpsertedSnapshot,
} from '@/lib/domain/snapshot'
import type { Investment, Transaction } from '@/types/database'

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
  fetchedAt: string
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
  const { data: invList, error: invFetchError } = await supabase
    .from('investments')
    .select('id, name, type, ticker')
    .eq('user_id', userId)

  if (invFetchError) {
    throw new Error(`Failed to load investments: ${invFetchError.message}`)
  }

  const priceResults: PriceResult[] = []
  const toFetch: { id: string; name: string; ticker: string }[] = []

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
      toFetch.push({ id: inv.id, name: inv.name, ticker: t })
    }
  }

  // 2. Fetch prices in parallel; one failure doesn't sink the others.
  const settledPrices = await Promise.allSettled(
    toFetch.map(async (inv) => {
      const { price, currency } = await fetchYahooPrice(inv.ticker)
      const { error: updateError } = await supabase
        .from('investments')
        .update({
          current_price: price,
          currency,
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
    supabase
      .from('investments')
      .select('*')
      .eq('user_id', userId)
      .returns<Investment[]>(),
    supabase
      .from('transactions')
      .select('*')
      .eq('user_id', userId)
      .returns<Transaction[]>(),
    loadFxRates(supabase),
  ])

  const freshInvestments = freshInvRes.data ?? []
  const freshTransactions = freshTxRes.data ?? []
  const fxRates = freshFx.rates

  // 4. Portfolio-level snapshot.
  const portfolioMetrics = computePortfolioMetrics(
    freshInvestments,
    freshTransactions,
    fxRates
  )
  const { snapshot, error: snapshotError } = await upsertTodaysSnapshot(
    supabase,
    userId,
    portfolioMetrics,
    source
  )

  // 5. Per-investment snapshots (in EUR).
  const investmentSnapshotInputs = freshInvestments.map((inv) => ({
    investmentId: inv.id,
    metrics: computeInvestmentMetrics(inv, freshTransactions, fxRates),
    currentPriceNative: inv.current_price ?? null,
    currency: inv.currency ?? 'EUR',
  }))

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