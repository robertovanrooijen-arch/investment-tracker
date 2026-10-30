export type YahooPriceResult = {
    price: number
    // Raw currency code as reported by Yahoo (may be a minor unit such as
    // 'GBp'); normalise with priceForStorage() before storing anything.
    currency: string | null
    // When the quoted price was set on the market (ISO), if Yahoo reports it.
    marketTimeIso: string | null
  }

  type ChartMeta = {
    regularMarketPrice?: unknown
    currency?: unknown
    regularMarketTime?: unknown
  }

  /**
   * Fetch the latest price for a ticker from Yahoo Finance's chart endpoint.
   * Throws a readable Error on any failure (network, bad ticker, no price, etc.).
   */
  export async function fetchYahooPrice(ticker: string): Promise<YahooPriceResult> {
    const safeTicker = encodeURIComponent(ticker.trim())
    const url = `https://query1.finance.yahoo.com/v8/finance/chart/${safeTicker}?interval=1d&range=1d`

    let res: Response
    try {
      res = await fetch(url, {
        cache: 'no-store',
        headers: {
          // Yahoo's chart endpoint sometimes rejects empty/default UAs.
          'User-Agent': 'Mozilla/5.0 (compatible; InvestmentTracker/1.0)',
        },
      })
    } catch {
      throw new Error(`Network error fetching "${ticker}".`)
    }

    if (!res.ok) {
      throw new Error(`Yahoo returned ${res.status} for "${ticker}".`)
    }

    let json: unknown
    try {
      json = await res.json()
    } catch {
      throw new Error(`Invalid response for "${ticker}".`)
    }

    // Walk the response shape defensively.
    const meta = (json as { chart?: { result?: Array<{ meta?: ChartMeta }> } })?.chart?.result?.[0]?.meta
    const price = meta?.regularMarketPrice
    const currency = meta?.currency
    const marketTime = meta?.regularMarketTime

    if (typeof price !== 'number' || !Number.isFinite(price) || price <= 0) {
      throw new Error(`No usable price returned for "${ticker}".`)
    }

    return {
      price,
      // No silent 'USD' default any more: a missing currency is rejected by
      // priceForStorage() instead of being assumed.
      currency: typeof currency === 'string' && currency.length > 0 ? currency : null,
      marketTimeIso:
        typeof marketTime === 'number' && Number.isFinite(marketTime)
          ? new Date(marketTime * 1000).toISOString()
          : null,
    }
  }
