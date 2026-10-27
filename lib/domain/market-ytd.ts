// "Market YTD" — the pure price return of a ticker since the last trading
// day on/before a given date (normally this year's Jan 1), independent of
// when/whether the user actually held it. Deliberately separate from every
// other YTD figure in this app (InvestmentYtdRow.ytdReturnPercent etc.),
// which measures the USER's money-weighted return on their own position —
// the two are different questions and must never be interchanged.
//
// This app has no stored historical price series (investment_snapshots only
// stores EUR value + quantity, never a per-date native price), so the
// year-start price is fetched live from Yahoo's chart endpoint, the same
// data source lib/domain/yahoo-price.ts already uses for "now". Never
// fabricated, never inferred from unrelated EUR values — a ticker that
// can't be fetched reports null, not a guess.

export type HistoricalClose = {
  // Split-adjusted close in the ticker's native currency.
  closeNative: number
  // The actual trading day this close belongs to — may be a few days
  // before the requested date (weekends/holidays), shown to the user so
  // the comparison point is never silently wrong.
  asOfDateIso: string
}

type YahooChartSeriesPoint = {
  timestampSec: number
  close: number | null
  adjClose: number | null
}

/**
 * Picks the trading day on/before `targetUnixSec` with the close nearest
 * to it, preferring the split-adjusted close when available. Returns null
 * when nothing in `series` is on/before the target — never picks a date
 * AFTER the target, which would silently answer a different question
 * ("return since some other day") than the one asked.
 */
export function selectClosestClose(
  series: YahooChartSeriesPoint[],
  targetUnixSec: number
): { closeNative: number; timestampSec: number } | null {
  let best: { closeNative: number; timestampSec: number } | null = null

  for (const point of series) {
    if (point.timestampSec > targetUnixSec) continue
    const price = point.adjClose ?? point.close
    if (price === null || !Number.isFinite(price) || price <= 0) continue
    if (best === null || point.timestampSec > best.timestampSec) {
      best = { closeNative: price, timestampSec: point.timestampSec }
    }
  }

  return best
}

/**
 * Market YTD % = today's price vs. the year-start close, both in the
 * ticker's own native currency (no FX involved — see the page-level note on
 * why this is deliberately not converted to EUR). Returns null whenever
 * either side is missing or the start close is non-positive, rather than a
 * divide-by-zero or a misleading 0%.
 */
export function computeMarketYtdPercent(
  currentPriceNative: number | null,
  startCloseNative: number | null
): number | null {
  if (currentPriceNative === null || startCloseNative === null) return null
  if (!Number.isFinite(startCloseNative) || startCloseNative <= 0) return null
  if (!Number.isFinite(currentPriceNative)) return null
  return (currentPriceNative / startCloseNative - 1) * 100
}

function unixSecForDate(dateIso: string): number {
  return Math.floor(new Date(`${dateIso}T12:00:00Z`).getTime() / 1000)
}

/**
 * Fetches the real historical close nearest to (and not after) `targetDateIso`
 * for one ticker, from the same Yahoo chart endpoint fetchYahooPrice uses.
 * Looks back up to 10 days to clear weekends/holidays around the target.
 * Returns null on any failure (network, no data, bad ticker) — callers must
 * treat null as "unavailable", never as zero.
 */
export async function fetchYahooHistoricalClose(
  ticker: string,
  targetDateIso: string
): Promise<HistoricalClose | null> {
  const targetUnixSec = unixSecForDate(targetDateIso)
  const period1 = targetUnixSec - 10 * 24 * 60 * 60
  const period2 = targetUnixSec + 24 * 60 * 60

  const safeTicker = encodeURIComponent(ticker.trim())
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${safeTicker}?interval=1d&period1=${period1}&period2=${period2}`

  let res: Response
  try {
    res = await fetch(url, {
      cache: 'no-store',
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; InvestmentTracker/1.0)' },
    })
  } catch {
    return null
  }
  if (!res.ok) return null

  let json: unknown
  try {
    json = await res.json()
  } catch {
    return null
  }

  type ChartApiResponse = {
    chart?: {
      result?: Array<{
        timestamp?: unknown
        indicators?: {
          quote?: Array<{ close?: unknown }>
          adjclose?: Array<{ adjclose?: unknown }>
        }
      }>
    }
  }

  const result = (json as ChartApiResponse)?.chart?.result?.[0]
  const timestamps: unknown = result?.timestamp
  const closes: unknown = result?.indicators?.quote?.[0]?.close
  const adjCloses: unknown = result?.indicators?.adjclose?.[0]?.adjclose
  if (!Array.isArray(timestamps)) return null

  const series: YahooChartSeriesPoint[] = timestamps.map((ts: unknown, i: number) => ({
    timestampSec: Number(ts),
    close: Array.isArray(closes) && typeof closes[i] === 'number' ? closes[i] : null,
    adjClose: Array.isArray(adjCloses) && typeof adjCloses[i] === 'number' ? adjCloses[i] : null,
  }))

  const picked = selectClosestClose(series, targetUnixSec)
  if (!picked) return null

  return {
    closeNative: picked.closeNative,
    asOfDateIso: new Date(picked.timestampSec * 1000).toISOString().slice(0, 10),
  }
}

/**
 * Fetches year-start closes for a set of tickers in parallel, deduped (two
 * investments sharing a ticker only trigger one request) and with each
 * ticker's failure fully isolated from the rest via allSettled — one bad
 * symbol never blanks out the whole page's Market YTD column.
 */
export async function fetchMarketYtdCloses(
  tickers: string[],
  targetDateIso: string
): Promise<Map<string, HistoricalClose | null>> {
  const unique = Array.from(new Set(tickers.filter((t) => t.trim().length > 0)))
  const results = await Promise.allSettled(
    unique.map((ticker) => fetchYahooHistoricalClose(ticker, targetDateIso))
  )

  const map = new Map<string, HistoricalClose | null>()
  unique.forEach((ticker, i) => {
    const r = results[i]
    map.set(ticker, r.status === 'fulfilled' ? r.value : null)
  })
  return map
}
