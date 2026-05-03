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

type Summary = {
  prices: {
    total: number
    successful: number
    skipped: number
    failed: number
    results: PriceResult[]
  }
  fx: { ok: boolean; error: string | null }
  snapshotOk: boolean
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
    try {
      const res = await fetch('/api/portfolio/refresh', { method: 'POST' })
      const json = await res.json().catch(() => ({}))
      if (!res.ok) {
        setStatus('error')
        setError(json.error ?? 'Could not refresh portfolio.')
        return
      }
      setStatus('success')
      setSummary({
        prices: json.prices,
        fx: json.fx,
        snapshotOk: !!json.snapshot,
        snapshotError: json.snapshot_error ?? null,
      })
      router.refresh()
    } catch (err) {
      setStatus('error')
      setError(err instanceof Error ? err.message : 'Network error.')
    }
  }

  const issueRows =
    summary?.prices.results.filter((r) => r.status !== 'success') ?? []
  const fxFailed = !!summary && !summary.fx.ok
  const snapshotFailed = !!summary && !summary.snapshotOk
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

          {fxFailed && (
            <div className="text-red-700">
              FX rates: failed — {summary.fx.error ?? 'unknown error'}
            </div>
          )}

          {snapshotFailed && (
            <div className="text-red-700">
              Snapshot: failed
              {summary.snapshotError ? ` — ${summary.snapshotError}` : ''}
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