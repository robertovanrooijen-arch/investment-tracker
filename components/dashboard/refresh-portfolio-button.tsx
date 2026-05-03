'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { Button } from '@/components/ui/button'

type Status = 'idle' | 'loading' | 'success' | 'error'

type PriceResult = {
  id: string
  name: string
  ticker: string | null
  status: 'success' | 'skipped' | 'failed'
  reason?: string
  error?: string
}

type PriceSummary = {
  total: number
  successful: number
  skipped: number
  failed: number
  results: PriceResult[]
}

type FxSummary = {
  ok: boolean
  error: string | null
}

type Summary = {
  prices: PriceSummary | null
  fx: FxSummary | null
  snapshotPresent: boolean
  snapshotError: string | null
}

type Props = {
  lastRefreshedAt: string | null
}

export function RefreshPortfolioButton({ lastRefreshedAt }: Props) {
  const router = useRouter()
  const [status, setStatus] = useState<Status>('idle')
  const [summary, setSummary] = useState<Summary | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [showDetails, setShowDetails] = useState(false)

  async function refresh() {
    setStatus('loading')
    setSummary(null)
    setError(null)
    setShowDetails(false)

    let res: Response
    try {
      res = await fetch('/api/portfolio/refresh', { method: 'POST' })
    } catch (err) {
      setStatus('error')
      setError(err instanceof Error ? err.message : 'Network error.')
      return
    }

    let json: unknown = null
    try {
      json = await res.json()
    } catch {
      // body wasn't JSON; json stays null
    }

    if (!res.ok) {
      const msg =
        (isObject(json) && typeof json.error === 'string' && json.error) ||
        `Refresh failed (${res.status}).`
      setStatus('error')
      setError(msg)
      return
    }

    const parsed = parseSummary(json)
    if (!parsed) {
      setStatus('error')
      setError(
        'The server replied OK but the response was missing the expected price, FX, and snapshot fields.'
      )
      return
    }

    setStatus('success')
    setSummary(parsed)
    router.refresh()
  }

  const issueRows =
    summary?.prices?.results.filter((r) => r.status !== 'success') ?? []
  const fxFailed = !!summary?.fx && !summary.fx.ok
  const snapshotFailed = !!summary?.snapshotError
  const hasIssues = issueRows.length > 0 || fxFailed || snapshotFailed

  return (
    <div className="flex flex-col gap-2 text-xs">
      <div className="flex flex-wrap items-center gap-2">
        <Button onClick={refresh} disabled={status === 'loading'}>
          {status === 'loading' ? 'Refreshing portfolio…' : 'Refresh portfolio'}
        </Button>

        {status === 'idle' && lastRefreshedAt && (
          <span className="text-slate-500">
            Last refreshed {formatRelative(lastRefreshedAt)}
          </span>
        )}
        {status === 'idle' && !lastRefreshedAt && (
          <span className="text-slate-500">Never refreshed</span>
        )}

        {status === 'success' && summary && (
          <>
            <span
              className={`font-medium ${
                hasIssues ? 'text-amber-700' : 'text-emerald-700'
              }`}
            >
              {hasIssues ? '⚠ Refreshed with issues' : '✓ Portfolio refreshed'}
            </span>
            {hasIssues && (
              <button
                type="button"
                onClick={() => setShowDetails((v) => !v)}
                className="text-slate-600 underline hover:text-slate-900"
              >
                {showDetails ? 'Hide details' : 'Show details'}
              </button>
            )}
          </>
        )}

        {status === 'error' && (
          <span className="font-medium text-red-700">{error}</span>
        )}
      </div>

      {showDetails && summary && (
        <div className="space-y-2 rounded-md border border-slate-200 bg-slate-50 p-3">
          {summary.prices ? (
            <div className="text-slate-700">
              Prices:{' '}
              <span className="font-medium">{summary.prices.successful}</span>{' '}
              updated
              {summary.prices.skipped > 0 && (
                <>
                  ,{' '}
                  <span className="font-medium">{summary.prices.skipped}</span>{' '}
                  skipped
                </>
              )}
              {summary.prices.failed > 0 && (
                <>
                  ,{' '}
                  <span className="font-medium">{summary.prices.failed}</span>{' '}
                  failed
                </>
              )}
            </div>
          ) : (
            <div className="text-slate-500">Prices: no data returned.</div>
          )}

          {fxFailed && (
            <div className="text-red-700">
              FX rates: failed — {summary.fx?.error ?? 'unknown error'}
            </div>
          )}

          {snapshotFailed && (
            <div className="text-red-700">
              Snapshot: failed — {summary.snapshotError ?? 'unknown error'}
            </div>
          )}

          {issueRows.length > 0 && (
            <ul className="space-y-1">
              {issueRows.map((r) => (
                <li key={r.id} className="text-slate-700">
                  <span className="font-medium">{r.name}</span>
                  {r.ticker ? (
                    <span className="text-slate-500"> ({r.ticker})</span>
                  ) : null}
                  {' — '}
                  <span
                    className={
                      r.status === 'failed' ? 'text-red-700' : 'text-slate-500'
                    }
                  >
                    {r.status === 'failed' ? r.error : r.reason}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  )
}

function isObject(x: unknown): x is Record<string, unknown> {
  return !!x && typeof x === 'object'
}

function isPriceResult(x: unknown): x is PriceResult {
  if (!isObject(x)) return false
  if (typeof x.id !== 'string' || typeof x.name !== 'string') return false
  if (x.ticker !== null && typeof x.ticker !== 'string') return false
  if (
    x.status !== 'success' &&
    x.status !== 'skipped' &&
    x.status !== 'failed'
  ) {
    return false
  }
  return true
}

function parseSummary(json: unknown): Summary | null {
  if (!isObject(json)) return null

  let prices: PriceSummary | null = null
  const rawPrices = json.prices
  if (isObject(rawPrices)) {
    const rawResults = Array.isArray(rawPrices.results) ? rawPrices.results : []
    const results = rawResults.filter(isPriceResult)
    prices = {
      total:
        typeof rawPrices.total === 'number' ? rawPrices.total : results.length,
      successful:
        typeof rawPrices.successful === 'number' ? rawPrices.successful : 0,
      skipped: typeof rawPrices.skipped === 'number' ? rawPrices.skipped : 0,
      failed: typeof rawPrices.failed === 'number' ? rawPrices.failed : 0,
      results,
    }
  }

  let fx: FxSummary | null = null
  const rawFx = json.fx
  if (isObject(rawFx)) {
    fx = {
      ok: !!rawFx.ok,
      error: typeof rawFx.error === 'string' ? rawFx.error : null,
    }
  }

  const snapshotPresent = isObject(json.snapshot)
  const snapshotError =
    typeof json.snapshot_error === 'string' ? json.snapshot_error : null

  // If absolutely nothing useful came back, treat the response as invalid.
  if (!prices && !fx && !snapshotPresent && !snapshotError) {
    return null
  }

  return { prices, fx, snapshotPresent, snapshotError }
}

function formatRelative(iso: string): string {
  const then = new Date(iso).getTime()
  const now = Date.now()
  const diffSec = Math.round((now - then) / 1000)
  if (diffSec < 60) return 'just now'
  const diffMin = Math.round(diffSec / 60)
  if (diffMin < 60) return `${diffMin} min ago`
  const diffHr = Math.round(diffMin / 60)
  if (diffHr < 24) return `${diffHr} hr ago`
  const diffDay = Math.round(diffHr / 24)
  if (diffDay < 7) return `${diffDay} day${diffDay === 1 ? '' : 's'} ago`
  return new Date(iso).toLocaleDateString()
}