import { normalizeQuoteCurrency } from '@/lib/domain/price-update'
import type { FxSeries, PriceSeries } from '@/lib/valuation/historical-valuation'

// Read-only market history: raw daily closes with split events (Yahoo chart,
// the same public endpoint the live price refresh uses) and ECB reference
// rates (Frankfurter). Used for RECONSTRUCTED historical values only — never
// stored, never presented as official.

const UA = { 'User-Agent': 'Mozilla/5.0 (compatible; InvestmentTracker/1.0)' }

export async function fetchDailySeries(ticker: string, fromIso: string, fetchedAt: string): Promise<PriceSeries> {
  const p1 = Math.floor(Date.parse(`${fromIso}T00:00:00Z`) / 1000)
  const p2 = Math.floor(Date.now() / 1000)
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(ticker)}?interval=1d&period1=${p1}&period2=${p2}&events=split`
  const r = await fetch(url, { headers: UA, cache: 'no-store' })
  if (!r.ok) throw new Error(`HTTP ${r.status}`)
  const res = (await r.json())?.chart?.result?.[0]
  const ts: number[] = res?.timestamp ?? []
  const closes: (number | null)[] = res?.indicators?.quote?.[0]?.close ?? []
  const rawCurrency = res?.meta?.currency ?? null
  const scale = normalizeQuoteCurrency(1, rawCurrency)
  if (!scale) throw new Error(`unusable currency "${rawCurrency}"`)
  const series = ts
    .map((t, i) => ({ date: new Date(t * 1000).toISOString().slice(0, 10), close: closes[i] }))
    .filter((x): x is { date: string; close: number } => typeof x.close === 'number' && x.close > 0)
    .map((x) => ({ date: x.date, close: x.close * scale.price }))
  const splits = Object.values((res?.events?.splits ?? {}) as Record<string, { date: number; numerator: number; denominator: number }>).map(
    (s) => ({ date: new Date(s.date * 1000).toISOString().slice(0, 10), ratio: s.numerator / s.denominator })
  )
  return { symbol: ticker, currency: scale.currency, closes: series, splits, source: 'yahoo_chart_1d_close', fetchedAt }
}

export async function fetchPriceHistory(
  tickers: string[],
  fromIso: string
): Promise<{ prices: Map<string, PriceSeries>; errors: Record<string, string> }> {
  const fetchedAt = new Date().toISOString()
  const prices = new Map<string, PriceSeries>()
  const errors: Record<string, string> = {}
  await Promise.all(
    [...new Set(tickers)].map(async (t) => {
      try {
        prices.set(t, await fetchDailySeries(t, fromIso, fetchedAt))
      } catch (e) {
        errors[t] = e instanceof Error ? e.message : String(e)
      }
    })
  )
  return { prices, errors }
}

export async function fetchEcbFxHistory(currencies: string[], fromIso: string, toIso: string): Promise<FxSeries> {
  const wanted = [...new Set(currencies.filter((c) => c !== 'EUR'))]
  const fx: FxSeries = {}
  if (!wanted.length) return fx
  const r = await fetch(`https://api.frankfurter.app/${fromIso}..${toIso}?from=EUR&to=${wanted.join(',')}`, { cache: 'no-store' })
  if (!r.ok) throw new Error(`FX HTTP ${r.status}`)
  const j = (await r.json()) as { rates?: Record<string, Record<string, number>> }
  for (const c of wanted) {
    fx[c] = Object.entries(j.rates ?? {})
      .map(([date, rates]) => ({ date, eurPerUnit: 1 / rates[c] }))
      .filter((x) => Number.isFinite(x.eurPerUnit))
      .sort((a, b) => (a.date < b.date ? -1 : 1))
  }
  return fx
}
