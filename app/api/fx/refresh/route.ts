import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function POST() {
  const supabase = await createClient()

  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) {
    return NextResponse.json({ error: 'Not authenticated.' }, { status: 401 })
  }

  let json: { rates?: Record<string, number>; date?: string } | null = null
  try {
    const res = await fetch(
      'https://api.frankfurter.app/latest?from=EUR&to=USD,GBP',
      { cache: 'no-store' }
    )
    if (!res.ok) {
      return NextResponse.json(
        { error: `FX provider returned ${res.status}.` },
        { status: 502 }
      )
    }
    json = await res.json()
  } catch {
    return NextResponse.json(
      { error: 'Could not reach FX provider.' },
      { status: 502 }
    )
  }

  const rates = json?.rates
  if (!rates || typeof rates !== 'object') {
    return NextResponse.json({ error: 'No rates returned.' }, { status: 502 })
  }

  const fetchedAt = new Date().toISOString()
  const upserts = [
    { currency: 'EUR', eur_per_unit: 1, fetched_at: fetchedAt },
  ]

  // Frankfurter returns: 1 EUR = perEur <currency>. So 1 <currency> = 1/perEur EUR.
  for (const [currency, perEur] of Object.entries(rates)) {
    if (typeof perEur !== 'number' || !Number.isFinite(perEur) || perEur <= 0) continue
    upserts.push({ currency, eur_per_unit: 1 / perEur, fetched_at: fetchedAt })
  }

  const { error } = await supabase
    .from('fx_rates')
    .upsert(upserts, { onConflict: 'currency' })

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 })
  }

  return NextResponse.json({
    ok: true,
    rates: Object.fromEntries(upserts.map((r) => [r.currency, r.eur_per_unit])),
    fetched_at: fetchedAt,
  })
}