'use client'

import { useState, type FormEvent } from 'react'
import { useRouter } from 'next/navigation'
import Link from 'next/link'
import { createClient } from '@/lib/supabase/client'
import type {
  RecurringTransaction,
  RecurringTransactionType,
  RecurringFrequency,
  InvestmentType,
} from '@/types/database'
import { Field } from '@/components/ui/field'
import { Button } from '@/components/ui/button'

export type InvestmentOption = {
  id: string
  name: string
  currency: string
  type: InvestmentType
}

type RecurringFormProps = {
  investments: InvestmentOption[]
  initial?: RecurringTransaction
}

const CURRENCIES = ['EUR', 'USD', 'GBP']
const DAY_NAMES = [
  'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday',
]
const DAY_OF_MONTH_OPTIONS = Array.from({ length: 28 }, (_, i) => i + 1)

const inputClass =
  'w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm text-slate-900 placeholder:text-slate-400 focus:border-slate-900 focus:outline-none focus:ring-1 focus:ring-slate-900'

export function RecurringForm({ investments, initial }: RecurringFormProps) {
  const router = useRouter()
  const supabase = createClient()
  const isEdit = Boolean(initial)

  const defaultInv = investments[0] ?? null
  const initialInv = initial
    ? (investments.find((i) => i.id === initial.investment_id) ?? null)
    : defaultInv

  const [investmentId, setInvestmentId] = useState(
    initial?.investment_id ?? defaultInv?.id ?? '',
  )
  const [type, setType] = useState<RecurringTransactionType>(
    initial?.type ?? 'buy',
  )
  const [frequency, setFrequency] = useState<RecurringFrequency>(
    initial?.frequency ?? 'monthly',
  )
  const [dayOfMonth, setDayOfMonth] = useState(
    String(initial?.day_of_month ?? 1),
  )
  const [dayOfWeek, setDayOfWeek] = useState(
    String(initial?.day_of_week ?? 0),
  )
  const [startDate, setStartDate] = useState(
    initial?.start_date ?? new Date().toISOString().slice(0, 10),
  )
  const [endDate, setEndDate] = useState(initial?.end_date ?? '')
  const [fixedAmount, setFixedAmount] = useState(
    initial?.fixed_amount !== null && initial?.fixed_amount !== undefined
      ? String(initial.fixed_amount)
      : '',
  )
  const [fixedAmountCurrency, setFixedAmountCurrency] = useState(
    initial?.fixed_amount_currency ?? initialInv?.currency ?? 'EUR',
  )
  const [fee, setFee] = useState(initial ? String(initial.fee) : '0')
  const [feeCurrency, setFeeCurrency] = useState(
    initial?.fee_currency ?? 'EUR',
  )
  const [notes, setNotes] = useState(initial?.notes ?? '')
  const [active, setActive] = useState(initial?.active ?? true)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const selectedInv = investments.find((i) => i.id === investmentId) ?? null
  const isWeekly = frequency === 'weekly'
  const isBuy = type === 'buy'
  const currencyMismatch =
    isBuy && selectedInv !== null && fixedAmountCurrency !== selectedInv.currency

  function handleInvestmentChange(id: string) {
    setInvestmentId(id)
    const inv = investments.find((i) => i.id === id)
    if (inv) setFixedAmountCurrency(inv.currency)
  }

  async function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault()
    setError(null)

    if (!investmentId) {
      setError('Please select an investment.')
      return
    }
    if (!startDate) {
      setError('Start date is required.')
      return
    }
    const amtNum = Number(fixedAmount)
    if (!fixedAmount || !Number.isFinite(amtNum) || amtNum <= 0) {
      setError('Amount must be a positive number.')
      return
    }

    setSaving(true)

    const payload = {
      investment_id: investmentId,
      type,
      frequency,
      day_of_month: !isWeekly ? Number(dayOfMonth) : null,
      day_of_week: isWeekly ? Number(dayOfWeek) : null,
      start_date: startDate,
      end_date: endDate || null,
      fixed_quantity: null,
      fixed_amount: amtNum,
      fixed_amount_currency: fixedAmountCurrency,
      fee: isBuy ? Number(fee) || 0 : 0,
      fee_currency: isBuy ? feeCurrency : fixedAmountCurrency,
      notes: notes.trim() || null,
      active,
    }

    if (isEdit && initial) {
      const { error: updateErr } = await supabase
        .from('recurring_transactions')
        .update({ ...payload, updated_at: new Date().toISOString() })
        .eq('id', initial.id)

      if (updateErr) {
        setError(updateErr.message)
        setSaving(false)
        return
      }
    } else {
      const {
        data: { user },
        error: userErr,
      } = await supabase.auth.getUser()
      if (userErr || !user) {
        setError('You are not signed in.')
        setSaving(false)
        return
      }

      const { error: insertErr } = await supabase
        .from('recurring_transactions')
        .insert({ ...payload, user_id: user.id, last_generated_date: null })

      if (insertErr) {
        setError(insertErr.message)
        setSaving(false)
        return
      }
    }

    router.push('/recurring')
    router.refresh()
  }

  return (
    <form
      onSubmit={onSubmit}
      className="bg-white rounded-2xl border border-slate-200 p-6 md:p-8 max-w-2xl"
    >
      <div className="grid grid-cols-1 md:grid-cols-2 gap-5">
        {/* Investment */}
        <div className="md:col-span-2">
          <Field label="Investment" htmlFor="investment_id" required>
            <select
              id="investment_id"
              className={inputClass}
              value={investmentId}
              onChange={(e) => handleInvestmentChange(e.target.value)}
            >
              {investments.length === 0 && (
                <option value="">No investments found</option>
              )}
              {investments.map((inv) => (
                <option key={inv.id} value={inv.id}>
                  {inv.name} ({inv.currency})
                </option>
              ))}
            </select>
          </Field>
        </div>

        {/* Type */}
        <Field label="Type" htmlFor="type" required>
          <select
            id="type"
            className={inputClass}
            value={type}
            onChange={(e) => setType(e.target.value as RecurringTransactionType)}
          >
            <option value="buy">Buy</option>
            <option value="fee">Fee</option>
          </select>
        </Field>

        {/* Frequency */}
        <Field label="Frequency" htmlFor="frequency" required>
          <select
            id="frequency"
            className={inputClass}
            value={frequency}
            onChange={(e) => setFrequency(e.target.value as RecurringFrequency)}
          >
            <option value="weekly">Weekly</option>
            <option value="monthly">Monthly</option>
            <option value="quarterly">Quarterly</option>
          </select>
        </Field>

        {/* Day of week (weekly only) */}
        {isWeekly && (
          <Field label="Day of week" htmlFor="day_of_week" required>
            <select
              id="day_of_week"
              className={inputClass}
              value={dayOfWeek}
              onChange={(e) => setDayOfWeek(e.target.value)}
            >
              {DAY_NAMES.map((name, i) => (
                <option key={i} value={i}>
                  {name}
                </option>
              ))}
            </select>
          </Field>
        )}

        {/* Day of month (monthly / quarterly) */}
        {!isWeekly && (
          <Field label="Day of month" htmlFor="day_of_month" required hint="1–28">
            <select
              id="day_of_month"
              className={inputClass}
              value={dayOfMonth}
              onChange={(e) => setDayOfMonth(e.target.value)}
            >
              {DAY_OF_MONTH_OPTIONS.map((d) => (
                <option key={d} value={d}>
                  {d}
                </option>
              ))}
            </select>
          </Field>
        )}

        {/* Amount */}
        <Field
          label={isBuy ? 'Fixed buy amount' : 'Fee amount'}
          htmlFor="fixed_amount"
          required
          hint={isBuy ? 'Amount to invest per occurrence' : 'Fee charged per occurrence'}
        >
          <input
            id="fixed_amount"
            type="number"
            step="any"
            min="0.01"
            className={inputClass}
            value={fixedAmount}
            onChange={(e) => setFixedAmount(e.target.value)}
            placeholder="0.00"
          />
        </Field>

        {/* Amount currency */}
        <Field
          label={isBuy ? 'Amount currency' : 'Fee currency'}
          htmlFor="fixed_amount_currency"
          required
        >
          <select
            id="fixed_amount_currency"
            className={inputClass}
            value={fixedAmountCurrency}
            onChange={(e) => setFixedAmountCurrency(e.target.value)}
          >
            {CURRENCIES.map((c) => (
              <option key={c} value={c}>
                {c}
              </option>
            ))}
          </select>
        </Field>

        {/* Broker fee (buy only) */}
        {isBuy && (
          <>
            <Field label="Broker fee" htmlFor="fee" hint="Optional — 0 for no fee">
              <input
                id="fee"
                type="number"
                step="any"
                min="0"
                className={inputClass}
                value={fee}
                onChange={(e) => setFee(e.target.value)}
                placeholder="0.00"
              />
            </Field>

            <Field label="Fee currency" htmlFor="fee_currency" required>
              <select
                id="fee_currency"
                className={inputClass}
                value={feeCurrency}
                onChange={(e) => setFeeCurrency(e.target.value)}
              >
                {CURRENCIES.map((c) => (
                  <option key={c} value={c}>
                    {c}
                  </option>
                ))}
              </select>
            </Field>
          </>
        )}

        {/* Start date */}
        <Field label="Start date" htmlFor="start_date" required>
          <input
            id="start_date"
            type="date"
            className={inputClass}
            value={startDate}
            onChange={(e) => setStartDate(e.target.value)}
          />
        </Field>

        {/* End date */}
        <Field label="End date" htmlFor="end_date" hint="Leave blank for indefinite">
          <input
            id="end_date"
            type="date"
            className={inputClass}
            value={endDate}
            onChange={(e) => setEndDate(e.target.value)}
          />
        </Field>

        {/* Notes */}
        <div className="md:col-span-2">
          <Field label="Notes" htmlFor="notes" hint="Optional">
            <textarea
              id="notes"
              rows={2}
              className={inputClass}
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              placeholder="e.g. Monthly DCA into VWCE"
            />
          </Field>
        </div>

        {/* Active toggle */}
        <div className="md:col-span-2">
          <label className="flex items-center gap-3 cursor-pointer select-none">
            <input
              type="checkbox"
              checked={active}
              onChange={(e) => setActive(e.target.checked)}
              className="h-4 w-4 rounded border-slate-300 text-slate-900 focus:ring-slate-900"
            />
            <span className="text-sm text-slate-700">
              Active — generate transactions automatically on schedule
            </span>
          </label>
        </div>
      </div>

      {currencyMismatch && (
        <div className="mt-4 rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-800">
          Amount currency ({fixedAmountCurrency}) does not match this
          investment&apos;s currency ({selectedInv!.currency}). Buy rules will
          be skipped at generation time until they match.
        </div>
      )}

      {error && <p className="mt-4 text-sm text-rose-600">{error}</p>}

      <div className="mt-6 flex items-center gap-3">
        <Button type="submit" disabled={saving}>
          {saving ? 'Saving…' : isEdit ? 'Save changes' : 'Add rule'}
        </Button>
        <Link
          href="/recurring"
          className="text-sm text-slate-600 hover:text-slate-900"
        >
          Cancel
        </Link>
      </div>
    </form>
  )
}
