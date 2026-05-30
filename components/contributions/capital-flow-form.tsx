'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { createClient } from '@/lib/supabase/client'
import { Field } from '@/components/ui/field'
import { Button } from '@/components/ui/button'
import type { CapitalFlowDirection } from '@/types/database'

function todayISO() {
  return new Date().toISOString().slice(0, 10)
}

const inputClass =
  'w-full rounded-md border border-slate-300 bg-white px-3 py-2 text-sm text-slate-900 placeholder-slate-400 focus:border-slate-500 focus:outline-none focus:ring-1 focus:ring-slate-500'

export function CapitalFlowForm({
  knownPlatforms,
}: {
  knownPlatforms: string[]
}) {
  const router = useRouter()
  const supabase = createClient()

  const [direction, setDirection] = useState<CapitalFlowDirection>('to_portfolio')
  const [date,      setDate]      = useState(todayISO())
  const [platform,  setPlatform]  = useState('')
  const [amount,    setAmount]    = useState('')
  const [notes,     setNotes]     = useState('')
  const [saving,    setSaving]    = useState(false)
  const [error,     setError]     = useState<string | null>(null)

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault()
    setError(null)

    if (!date)           { setError('Please enter a date.'); return }
    if (!platform.trim()) { setError('Please enter a platform name.'); return }

    const amountNum = parseFloat(amount)
    if (!Number.isFinite(amountNum) || amountNum <= 0) {
      setError('Amount must be greater than 0.')
      return
    }

    setSaving(true)
    try {
      const { data: { user }, error: userError } = await supabase.auth.getUser()
      if (userError || !user) {
        setError('You are not signed in.')
        setSaving(false)
        return
      }

      const year = new Date(date + 'T00:00:00').getFullYear()

      const { error: dbError } = await supabase
        .from('capital_flow_entries')
        .insert({
          user_id:    user.id,
          flow_date:  date,
          year,
          platform:   platform.trim(),
          direction,
          amount_eur: amountNum,
          notes:      notes.trim() || null,
        })

      if (dbError) {
        setError(dbError.message)
        setSaving(false)
        return
      }

      router.push(`/contributions?year=${year}`)
      router.refresh()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Something went wrong.')
      setSaving(false)
    }
  }

  return (
    <form
      onSubmit={onSubmit}
      className="space-y-6 rounded-2xl border border-slate-200 bg-white p-6"
    >
      {/* Direction toggle */}
      <div>
        <p className="text-sm font-medium text-slate-700 mb-2">Direction</p>
        <div className="inline-flex rounded-lg border border-slate-200 bg-slate-50 p-0.5">
          {([
            { value: 'to_portfolio',   label: 'To portfolio'   },
            { value: 'from_portfolio', label: 'From portfolio' },
          ] as const).map(({ value, label }) => (
            <button
              key={value}
              type="button"
              onClick={() => setDirection(value)}
              className={`px-5 py-1.5 rounded-md text-sm font-medium transition-colors ${
                direction === value
                  ? 'bg-white text-slate-900 shadow-sm'
                  : 'text-slate-500 hover:text-slate-700'
              }`}
            >
              {label}
            </button>
          ))}
        </div>
        <p className="mt-1.5 text-xs text-slate-400">
          {direction === 'to_portfolio'
            ? 'Money sent from your bank or income to a portfolio platform.'
            : 'Money received back from a portfolio platform to your bank.'}
        </p>
      </div>

      <div className="grid gap-4 md:grid-cols-2">
        <Field label="Date" htmlFor="flow-date" required>
          <input
            id="flow-date"
            type="date"
            className={inputClass}
            value={date}
            onChange={(e) => setDate(e.target.value)}
          />
        </Field>

        <Field label="Platform" htmlFor="platform" required>
          <input
            id="platform"
            type="text"
            list="platform-suggestions"
            className={inputClass}
            value={platform}
            onChange={(e) => setPlatform(e.target.value)}
            placeholder="e.g. DEGIRO / Flatex"
            autoComplete="off"
          />
          {knownPlatforms.length > 0 && (
            <datalist id="platform-suggestions">
              {knownPlatforms.map((p) => (
                <option key={p} value={p} />
              ))}
            </datalist>
          )}
        </Field>

        <Field label="Amount (EUR)" htmlFor="amount" required>
          <input
            id="amount"
            type="number"
            inputMode="decimal"
            step="0.01"
            min="0.01"
            className={inputClass}
            value={amount}
            onChange={(e) => setAmount(e.target.value)}
            placeholder="0.00"
          />
        </Field>
      </div>

      <Field label="Notes" htmlFor="notes">
        <textarea
          id="notes"
          className={`${inputClass} resize-none`}
          rows={2}
          value={notes}
          onChange={(e) => setNotes(e.target.value)}
          placeholder="Optional"
        />
      </Field>

      {error && (
        <p className="rounded-lg bg-rose-50 border border-rose-200 px-4 py-2.5 text-sm text-rose-700">
          {error}
        </p>
      )}

      <div className="flex items-center gap-3">
        <Button type="submit" disabled={saving}>
          {saving ? 'Saving…' : 'Record capital flow'}
        </Button>
        <Button
          type="button"
          variant="secondary"
          onClick={() => router.push('/contributions')}
        >
          Cancel
        </Button>
      </div>
    </form>
  )
}
