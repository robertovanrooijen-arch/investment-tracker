export type YahooPriceResult = {
    price: number
    currency: string
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
    const meta = (json as any)?.chart?.result?.[0]?.meta
    const price = meta?.regularMarketPrice
    const currency = meta?.currency
  
    if (typeof price !== 'number' || !Number.isFinite(price) || price <= 0) {
      throw new Error(`No usable price returned for "${ticker}".`)
    }
  
    return {
      price,
      currency:
        typeof currency === 'string' && currency.length > 0 ? currency : 'USD',
    }
  }
  