import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { fetchYahooPrice } from '@/lib/domain/yahoo-price'
import { hasUnits } from '@/lib/domain/constants'
import { computePortfolioMetrics } from '@/lib/domain/calculations'
import { loadFxRates } from '@/lib/domain/fx'
import { upsertTodaysSnapshot } from '@/lib/domain/snapshot'
import type { Investment, Transaction } from '@/types/database'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

type PriceResult = {
  id: string
  name: string
  ticker: string | null
  status: 'success' | 'skipped' | 'failed'
  price?: number
  currency?: string
  reason?: string
  error?: string
}

export async function POST() {
  const supabase = await createClient()

  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) {
    return NextResponse.json({ error: 'Not authenticated.' }, { status: 401 })
  }

  // -----------------------------------------------------------------
  // 1. Refresh prices for unit-based investments with tickers
  // -----------------------------------------------------------------
  const { data: invList, error: invFetchError } = await supabase
    .from('investments')
    .select('id, name, type, ticker')
    .eq('user_id', user.id)

  if (invFetchError) {
    return NextResponse.json({ error: invFetchError.message }, { status: 500 })
  }

  const fetchedAt = new Date().toISOString()
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
        .eq('user_id', user.id)
      if (updateError) throw new Error(`DB update failed: ${updateError.message}`)
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

  // -----------------------------------------------------------------
  // 2. Refresh FX rates from Frankfurter
  // -----------------------------------------------------------------
  let fxOk = false
  let fxError: string | null = null
  try {
    const fxRes = await fetch(
      'https://api.frankfurter.app/latest?from=EUR&to=USD,GBP',
      { cache: 'no-store' }
    )
    if (!fxRes.ok) {
      fxError = `FX provider returned ${fxRes.status}.`
    } else {
      const fxJson = (await fxRes.json()) as { rates?: Record<string, number> } | null
      const rates = fxJson?.rates
      if (rates && typeof rates === 'object') {
        const upserts: { currency: string; eur_per_unit: number; fetched_at: string }[] = [
          { currency: 'EUR', eur_per_unit: 1, fetched_at: fetchedAt },
        ]
        for (const [currency, perEur] of Object.entries(rates)) {
          if (typeof perEur !== 'number' || !Number.isFinite(perEur) || perEur <= 0) continue
          upserts.push({ currency, eur_per_unit: 1 / perEur, fetched_at: fetchedAt })
        }
        const { error: upsertError } = await supabase
          .from('fx_rates')
          .upsert(upserts, { onConflict: 'currency' })
        if (upsertError) fxError = upsertError.message
        else fxOk = true
      } else {
        fxError = 'No rates returned from FX provider.'
      }
    }
  } catch {
    fxError = 'Could not reach FX provider.'
  }

  // -----------------------------------------------------------------
  // 3. Re-fetch fresh data, compute metrics in EUR, write snapshot
  // -----------------------------------------------------------------
  const [freshInvRes, freshTxRes, freshFx] = await Promise.all([
    supabase
      .from('investments')
      .select('*')
      .eq('user_id', user.id)
      .returns<Investment[]>(),
    supabase
      .from('transactions')
      .select('*')
      .eq('user_id', user.id)
      .returns<Transaction[]>(),
    loadFxRates(supabase),
  ])

  const freshInvestments = freshInvRes.data ?? []
  const freshTransactions = freshTxRes.data ?? []
  const fxRates = freshFx.rates

  const metrics = computePortfolioMetrics(
    freshInvestments,
    freshTransactions,
    fxRates
  )

  const { snapshot, error: snapshotError } = await upsertTodaysSnapshot(
    supabase,
    user.id,
    metrics,
    'manual_refresh'
  )

  return NextResponse.json({
    ok: true,
    prices: priceSummary,
    fx: { ok: fxOk, error: fxError },
    snapshot: snapshot ?? null,
    snapshot_error: snapshotError,
    fetched_at: fetchedAt,
  })
}