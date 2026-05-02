import type { SupabaseClient } from '@supabase/supabase-js'

export type FxRates = Record<string, number>

export const SUPPORTED_CURRENCIES = ['EUR', 'USD', 'GBP'] as const
export type SupportedCurrency = (typeof SUPPORTED_CURRENCIES)[number]

export async function loadFxRates(
  supabase: SupabaseClient
): Promise<{ rates: FxRates; lastUpdatedAt: string | null }> {
  const { data } = await supabase
    .from('fx_rates')
    .select('currency, eur_per_unit, fetched_at')

  const rates: FxRates = { EUR: 1 }
  let lastUpdatedAt: string | null = null

  for (const row of data ?? []) {
    rates[row.currency] = Number(row.eur_per_unit)
    if (row.currency !== 'EUR') {
      if (!lastUpdatedAt || row.fetched_at > lastUpdatedAt) {
        lastUpdatedAt = row.fetched_at
      }
    }
  }

  return { rates, lastUpdatedAt }
}

export function toEur(amount: number, currency: string, rates: FxRates): number {
  if (currency === 'EUR') return amount
  const r = rates[currency]
  if (!r || !Number.isFinite(r)) return amount // fallback: leave native
  return amount * r
}