'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { createClient } from '@/lib/supabase/client'
import { Field } from '@/components/ui/field'
import { Button } from '@/components/ui/button'

type ContributionType = 'deposit' | 'withdraw'

export type CashAccount = {
  id: string
  name: string
  currency: string
}

type FxRates = Record<string, number>

function todayISO() {
  return new Date().toISOString().slice(0, 10)
}

const inputClass =
  'w-full rounded-md border border-slate-300 bg-white px-3 py-2 text-sm text-slate-900 placeholder-slate-400 focus:border-slate-500 focus:outline-none focus:ring-1 focus:ring-slate-500'

export function ContributionForm({
  accounts,
  fxRates,
}: {
  accounts: CashAccount[]
  fxRates: FxRates
}) {
  const router = useRouter()
  const supabase = createClient()

  const [type,      setType]      = useState<ContributionType>('deposit')
  const [accountId, setAccountId] = useState(accounts[0]?.id ?? '')
  const [date,      setDate]      = useState(todayISO())
  const [amount,    setAmount]    = useState('')
  const [notes,     setNotes]     = useState('')
  const [saving,    setSaving]    = useState(false)
  const [error,     setError]     = useState<string | null>(null)

  // Derive currency from the currently selected account — not a separate state
  const selectedAccount = accounts.find((a) => a.id === accountId) ?? accounts[0]
  const accountCurrency = selectedAccount?.currency ?? 'EUR'

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault()
    setError(null)

    if (!accountId) { setError('Please select an account.'); return }
    if (!date)       { setError('Please enter a date.'); return }

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

      const { error: dbError } = await supabase.from('transactions').insert({
        user_id:             user.id,
        investment_id:       accountId,
        type,
        date,
        amount:              amountNum,
        fee:                 0,
        quantity:            null,
        price_per_unit:      null,
        notes:               notes.trim() || null,
        price_currency:      accountCurrency,
        fee_currency:        accountCurrency,
        fx_rate_to_eur:      fxRates[accountCurrency] ?? 1,
        // Deposits via this form are always external new money.
        // Withdrawals reduce contributed capital but are not contributions.
        is_contribution:     type === 'deposit',
        contribution_source: type === 'deposit' ? 'external' : null,
      })

      if (dbError) {
        setError(dbError.message)
        setSaving(false)
        return
      }

      // Mirror cash-flow auto-update used by the main transaction form:
      // deposit → current_value += amount, withdraw → current_value -= amount
      const sign = type === 'deposit' ? 1 : -1
      const { data: invRow } = await supabase
        .from('investments')
        .select('current_value')
        .eq('id', accountId)
        .single()

      if (invRow) {
        await supabase
          .from('investments')
          .update({ current_value: (invRow.current_value ?? 0) + sign * amountNum })
          .eq('id', accountId)
      }

      router.push('/contributions')
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
      {/* Type toggle */}
      <div>
        <p className="text-sm font-medium text-slate-700 mb-2">Type</p>
        <div className="inline-flex rounded-lg border border-slate-200 bg-slate-50 p-0.5">
          {(['deposit', 'withdraw'] as const).map((t) => (
            <button
              key={t}
              type="button"
              onClick={() => setType(t)}
              className={`px-5 py-1.5 rounded-md text-sm font-medium transition-colors ${
                type === t
                  ? 'bg-white text-slate-900 shadow-sm'
                  : 'text-slate-500 hover:text-slate-700'
              }`}
            >
              {t === 'deposit' ? 'Deposit' : 'Withdraw'}
            </button>
          ))}
        </div>
      </div>

      <div className="grid gap-4 md:grid-cols-2">
        <Field label="Account" htmlFor="account" required>
          <select
            id="account"
            className={inputClass}
            value={accountId}
            onChange={(e) => setAccountId(e.target.value)}
          >
            {accounts.map((acc) => (
              <option key={acc.id} value={acc.id}>
                {acc.name} ({acc.currency})
              </option>
            ))}
          </select>
        </Field>

        <Field label="Date" htmlFor="date" required>
          <input
            id="date"
            type="date"
            className={inputClass}
            value={date}
            onChange={(e) => setDate(e.target.value)}
          />
        </Field>

        <Field
          label="Amount"
          htmlFor="amount"
          hint={`Currency: ${accountCurrency} (from selected account)`}
          required
        >
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
          {saving ? 'Saving…' : type === 'deposit' ? 'Record deposit' : 'Record withdrawal'}
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
