'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { Button } from '@/components/ui/button'

type Status = 'idle' | 'loading' | 'success' | 'error'

type Props = {
  lastUpdatedAt: string | null
}

export function RefreshFxButton({ lastUpdatedAt }: Props) {
  const router = useRouter()
  const [status, setStatus] = useState<Status>('idle')
  const [message, setMessage] = useState<string | null>(null)

  async function refresh() {
    setStatus('loading')
    setMessage(null)
    try {
      const res = await fetch('/api/fx/refresh', { method: 'POST' })
      const json = await res.json().catch(() => ({}))
      if (!res.ok) {
        setStatus('error')
        setMessage(json.error ?? 'Could not refresh FX rates.')
        return
      }
      setStatus('success')
      setMessage('FX rates updated.')
      router.refresh()
    } catch (err) {
      setStatus('error')
      setMessage(err instanceof Error ? err.message : 'Network error.')
    }
  }

  return (
    <div className="flex flex-wrap items-center gap-2 text-xs">
      <Button onClick={refresh} disabled={status === 'loading'} variant="secondary">
        {status === 'loading' ? 'Refreshing…' : 'Refresh FX'}
      </Button>
      {status === 'idle' && lastUpdatedAt && (
        <span className="text-slate-500">
          FX updated {formatRelative(lastUpdatedAt)}
        </span>
      )}
      {status === 'idle' && !lastUpdatedAt && (
        <span className="text-slate-500">FX never refreshed</span>
      )}
      {status === 'success' && (
        <span className="font-medium text-emerald-700">✓ {message}</span>
      )}
      {status === 'error' && (
        <span className="font-medium text-red-700">{message}</span>
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