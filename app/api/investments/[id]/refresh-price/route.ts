import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { fetchYahooPrice } from '@/lib/domain/yahoo-price'
import { hasUnits, GRAMS_PER_TROY_OUNCE } from '@/lib/domain/constants'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function POST(
  _req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params
  const supabase = await createClient()

  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) {
    return NextResponse.json({ error: 'Not authenticated.' }, { status: 401 })
  }

  const { data: investment, error: fetchError } = await supabase
    .from('investments')
    .select('id, type, ticker, currency, quantity_unit')
    .eq('id', id)
    .eq('user_id', user.id)
    .maybeSingle()

  if (fetchError || !investment) {
    return NextResponse.json({ error: 'Investment not found.' }, { status: 404 })
  }

  if (!hasUnits(investment.type)) {
    return NextResponse.json(
      { error: 'Price refresh is only supported for stock, ETF, and crypto investments.' },
      { status: 400 }
    )
  }

  const ticker = investment.ticker?.trim()
  if (!ticker) {
    return NextResponse.json(
      { error: 'This investment has no ticker. Add one in Edit details first.' },
      { status: 400 }
    )
  }

  let price: number
  let currency: string
  try {
    const result = await fetchYahooPrice(ticker)
    price =
      investment.type === 'commodity' && investment.quantity_unit === 'gram'
        ? result.price / GRAMS_PER_TROY_OUNCE
        : result.price
    currency = result.currency
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'Could not fetch price.' },
      { status: 502 }
    )
  }

  const updatedAt = new Date().toISOString()

  const { error: updateError } = await supabase
    .from('investments')
    .update({
      current_price: price,
      currency,
      price_last_updated_at: updatedAt,
      price_source: 'yahoo',
      updated_at: updatedAt,
    })
    .eq('id', id)
    .eq('user_id', user.id)

  if (updateError) {
    return NextResponse.json({ error: updateError.message }, { status: 500 })
  }

  return NextResponse.json({
    ok: true,
    price,
    currency,
    price_last_updated_at: updatedAt,
  })
}