'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { Button } from '@/components/ui/button'

type Status = 'idle' | 'loading' | 'success' | 'error'

type RefreshResult = {
  id: string
  name: string
  ticker: string | null
  status: 'success' | 'skipped' | 'failed'
  reason?: string
  error?: string
}

type Summary = {
  total: number
  successful: number
  skipped: number
  failed: number
  results: RefreshResult[]
}

export function RefreshAllPricesButton() {
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
      const res = await fetch('/api/investments/refresh-prices', { method: 'POST' })
      const json = await res.json().catch(() => ({}))
      if (!res.ok) {
        setStatus('error')
        setError(json.error ?? 'Could not refresh prices.')
        return
      }
      setStatus('success')
      setSummary({
        total: json.total ?? 0,
        successful: json.successful ?? 0,
        skipped: json.skipped ?? 0,
        failed: json.failed ?? 0,
        results: json.results ?? [],
      })
      router.refresh()
    } catch (err) {
      setStatus('error')
      setError(err instanceof Error ? err.message : 'Network error.')
    }
  }

  const hasIssues = summary && (summary.skipped > 0 || summary.failed > 0)
  const issueRows = summary?.results.filter((r) => r.status !== 'success') ?? []

  return (
    <div className="flex flex-col gap-2 text-xs">
      <div className="flex flex-wrap items-center gap-2">
        <Button
          onClick={refresh}
          disabled={status === 'loading'}
          variant="secondary"
        >
          {status === 'loading' ? 'Refreshing all…' : 'Refresh all prices'}
        </Button>

        {status === 'success' && summary && (
          <>
            <span className="font-medium text-emerald-700">
              ✓ Updated {summary.successful} of {summary.total}
              {summary.skipped > 0 ? ` · ${summary.skipped} skipped` : ''}
              {summary.failed > 0 ? ` · ${summary.failed} failed` : ''}
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

      {showDetails && issueRows.length > 0 && (
        <ul className="space-y-1 rounded-md border border-slate-200 bg-slate-50 p-3">
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
  )
}