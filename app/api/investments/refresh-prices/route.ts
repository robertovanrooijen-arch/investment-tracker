import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { fetchAllInvestments } from '@/lib/supabase/fetch-user-data'
import { fetchYahooPrice } from '@/lib/domain/yahoo-price'
import { hasUnits } from '@/lib/domain/constants'
import { priceForStorage } from '@/lib/domain/price-update'
import type { Investment, InvestmentType, QuantityUnit } from '@/types/database'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

type RefreshResult = {
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

  const { data: investments, error: fetchError } = await fetchAllInvestments<
    Pick<Investment, 'id' | 'name' | 'type' | 'ticker' | 'currency' | 'quantity_unit'>
  >(supabase, 'id, name, type, ticker, currency, quantity_unit', { userId: user.id })

  if (fetchError) {
    return NextResponse.json({ error: fetchError.message }, { status: 500 })
  }

  // Only consider unit-based investments. Non-unit (cash, real estate, custom)
  // are simply ignored — they wouldn't be in scope for a price refresh.
  const unitInvestments = (investments ?? []).filter((inv) => hasUnits(inv.type))

  // Split into "has ticker" vs "no ticker" → skipped.
  const results: RefreshResult[] = []
  const toFetch: {
    id: string
    name: string
    ticker: string
    type: InvestmentType
    currency: string | null
    quantity_unit: QuantityUnit | null
  }[] = []

  for (const inv of unitInvestments) {
    const t = inv.ticker?.trim()
    if (!t) {
      results.push({
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

  const fetchedAt = new Date().toISOString()

  // Fire all Yahoo lookups in parallel; one failure doesn't sink the rest.
  const settled = await Promise.allSettled(
    toFetch.map(async (inv) => {
      const quote = await fetchYahooPrice(inv.ticker)
      const checked = priceForStorage(quote.price, quote.currency, inv)
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
        .eq('user_id', user.id)

      if (updateError) throw new Error(`DB update failed: ${updateError.message}`)

      return { price, currency }
    })
  )

  for (let i = 0; i < settled.length; i++) {
    const inv = toFetch[i]
    const r = settled[i]
    if (r.status === 'fulfilled') {
      results.push({
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
      results.push({
        id: inv.id,
        name: inv.name,
        ticker: inv.ticker,
        status: 'failed',
        error: errMsg,
      })
    }
  }

  const successful = results.filter((r) => r.status === 'success').length
  const skipped = results.filter((r) => r.status === 'skipped').length
  const failed = results.filter((r) => r.status === 'failed').length

  return NextResponse.json({
    ok: true,
    total: results.length,
    successful,
    skipped,
    failed,
    results,
    fetched_at: fetchedAt,
  })
}
