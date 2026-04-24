'use client'

import { useState, useMemo, useEffect, type FormEvent } from 'react'
import { useRouter } from 'next/navigation'
import Link from 'next/link'
import { createClient } from '@/lib/supabase/client'
import {
  TX_TYPES,
  usesUnits,
  usesAmount,
  txTypesForInvestmentType,
} from '@/lib/domain/transaction-helpers'
import type {
  Transaction,
  TransactionType,
  Investment,
} from '@/types/database'
import { Field } from '@/components/ui/field'
import { Button } from '@/components/ui/button'

const inputClass =
  'w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm text-slate-900 placeholder:text-slate-400 focus:border-slate-900 focus:outline-none focus:ring-1 focus:ring-slate-900'

type InvestmentOption = Pick<Investment, 'id' | 'name' | 'ticker' | 'type'>

type TransactionFormProps = {
  investments: InvestmentOption[]
  initial?: Transaction
  defaultInvestmentId?: string
}

export function TransactionForm({
  investments,
  initial,
  defaultInvestmentId,
}: TransactionFormProps) {
  const router = useRouter()
  const supabase = createClient()
  const isEdit = Boolean(initial)

  const [investmentId, setInvestmentId] = useState(
    initial?.investment_id ?? defaultInvestmentId ?? investments[0]?.id ?? ''
  )
  const [type, setType] = useState<TransactionType>(initial?.type ?? 'buy')
  const [date, setDate] = useState(
    initial?.date ?? new Date().toISOString().slice(0, 10)
  )
  const [quantity, setQuantity] = useState(
    initial?.quantity !== null && initial?.quantity !== undefined
      ? String(initial.quantity)
      : ''
  )
  const [pricePerUnit, setPricePerUnit] = useState(
    initial?.price_per_unit !== null && initial?.price_per_unit !== undefined
      ? String(initial.price_per_unit)
      : ''
  )
  const [amount, setAmount] = useState(
    initial?.amount !== null && initial?.amount !== undefined
      ? String(initial.amount)
      : ''
  )
  const [fee, setFee] = useState(
    initial?.fee !== null && initial?.fee !== undefined
      ? String(initial.fee)
      : '0'
  )
  const [notes, setNotes] = useState(initial?.notes ?? '')

  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  // Which transaction types are valid for the currently-selected investment.
  const selectedInvestment = investments.find((i) => i.id === investmentId)
  const allowedTypes: TransactionType[] = selectedInvestment
    ? txTypesForInvestmentType(selectedInvestment.type)
    : TX_TYPES

  // If the currently-selected type isn't valid for this investment, switch it.
  useEffect(() => {
    if (selectedInvestment && !allowedTypes.includes(type)) {
      setType(allowedTypes[0])
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [investmentId])

  const showUnits = usesUnits(type)
  const showAmount = usesAmount(type)

  // Live preview of qty × price for buy/sell.
  const computedAmount = useMemo(() => {
    if (!showUnits) return null
    if (quantity === '' || pricePerUnit === '') return null
    const q = Number(quantity)
    const p = Number(pricePerUnit)
    if (!Number.isFinite(q) || !Number.isFinite(p)) return null
    return q * p
  }, [showUnits, quantity, pricePerUnit])

  async function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault()
    setError(null)

    if (!investmentId) {
      setError('Please pick an investment.')
      return
    }
    if (!date) {
      setError('Please pick a date.')
      return
    }

    setSaving(true)

    const {
      data: { user },
      error: userErr,
    } = await supabase.auth.getUser()
    if (userErr || !user) {
      setError('You are not signed in.')
      setSaving(false)
      return
    }

    // Build the fields depending on type.
    let finalQuantity: number | null = null
    let finalPrice: number | null = null
    let finalAmount: number | null = null

    if (showUnits) {
      if (quantity === '' || pricePerUnit === '') {
        setError('Please enter both quantity and price per unit.')
        setSaving(false)
        return
      }
      finalQuantity = Number(quantity)
      finalPrice = Number(pricePerUnit)
      finalAmount = finalQuantity * finalPrice
    } else {
      if (amount === '') {
        setError('Please enter an amount.')
        setSaving(false)
        return
      }
      finalAmount = Number(amount)
    }

    const feeNum = fee !== '' ? Number(fee) : 0

    const payload = {
      investment_id: investmentId,
      type,
      date,
      quantity: finalQuantity,
      price_per_unit: finalPrice,
      amount: finalAmount,
      fee: feeNum,
      notes: notes.trim() ? notes.trim() : null,
    }

    if (isEdit && initial) {
      const { error: upErr } = await supabase
        .from('transactions')
        .update(payload)
        .eq('id', initial.id)
      if (upErr) {
        setError(upErr.message)
        setSaving(false)
        return
      }
    } else {
      const { error: insErr } = await supabase
        .from('transactions')
        .insert({ ...payload, user_id: user.id })
      if (insErr) {
        setError(insErr.message)
        setSaving(false)
        return
      }
    }

    // Value updates also roll into the investment's current_value so the
    // dashboard and list reflect the new number immediately.
    if (type === 'value update' && finalAmount !== null) {
      await supabase
        .from('investments')
        .update({ current_value: finalAmount })
        .eq('id', investmentId)
    }

    router.push('/transactions')
    router.refresh()
  }

  // If the user has no investments yet, show a friendly nudge.
  if (investments.length === 0) {
    return (
      <div className="bg-white rounded-2xl border border-slate-200 p-8 max-w-2xl">
        <p className="text-slate-900 font-medium">No investments yet</p>
        <p className="text-sm text-slate-500 mt-1">
          You need at least one investment before you can add a transaction.
        </p>
        <Link
          href="/investments/new"
          className="mt-4 inline-flex items-center justify-center rounded-lg bg-slate-900 px-4 py-2 text-sm font-medium text-white hover:bg-slate-800"
        >
          + Add your first investment
        </Link>
      </div>
    )
  }

  return (
    <form
      onSubmit={onSubmit}
      className="bg-white rounded-2xl border border-slate-200 p-6 md:p-8 max-w-2xl"
    >
      <div className="grid grid-cols-1 md:grid-cols-2 gap-5">
        <Field label="Investment" htmlFor="investment" required>
          <select
            id="investment"
            className={inputClass}
            value={investmentId}
            onChange={(e) => setInvestmentId(e.target.value)}
          >
            {investments.map((inv) => (
              <option key={inv.id} value={inv.id}>
                {inv.name}
                {inv.ticker ? ` (${inv.ticker})` : ''}
              </option>
            ))}
          </select>
        </Field>

        <Field label="Type" htmlFor="type" required>
          <select
            id="type"
            className={inputClass}
            value={type}
            onChange={(e) => setType(e.target.value as TransactionType)}
          >
            {allowedTypes.map((t) => (
              <option key={t} value={t}>
                {t}
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
            required
          />
        </Field>

        <Field label="Fee" htmlFor="fee" hint="Optional — defaults to 0">
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

        {showUnits && (
          <>
            <Field label="Quantity" htmlFor="quantity" required>
              <input
                id="quantity"
                type="number"
                step="any"
                min="0"
                className={inputClass}
                value={quantity}
                onChange={(e) => setQuantity(e.target.value)}
                placeholder="0"
              />
            </Field>

            <Field label="Price per unit" htmlFor="price" required>
              <input
                id="price"
                type="number"
                step="any"
                min="0"
                className={inputClass}
                value={pricePerUnit}
                onChange={(e) => setPricePerUnit(e.target.value)}
                placeholder="0.00"
              />
            </Field>
          </>
        )}

        {showAmount && (
          <Field
            label={
              type === 'deposit'
                ? 'Deposit amount'
                : type === 'withdraw'
                ? 'Withdraw amount'
                : 'New total value'
            }
            htmlFor="amount"
            required
            hint={
              type === 'value update'
                ? 'Sets this holding to a new total value (e.g. updated house appraisal)'
                : undefined
            }
          >
            <input
              id="amount"
              type="number"
              step="any"
              min="0"
              className={inputClass}
              value={amount}
              onChange={(e) => setAmount(e.target.value)}
              placeholder="0.00"
            />
          </Field>
        )}

        <div className="md:col-span-2">
          <Field label="Notes" htmlFor="notes" hint="Optional">
            <textarea
              id="notes"
              rows={3}
              className={inputClass}
              value={notes ?? ''}
              onChange={(e) => setNotes(e.target.value)}
              placeholder="Anything you want to remember about this transaction"
            />
          </Field>
        </div>
      </div>

      {showUnits && computedAmount !== null && (
        <p className="mt-4 text-sm text-slate-600">
          Total:{' '}
          <span className="font-medium text-slate-900">
            {new Intl.NumberFormat('en-IE', {
              style: 'currency',
              currency: 'EUR',
            }).format(computedAmount)}
          </span>
        </p>
      )}

      {error && <p className="mt-4 text-sm text-rose-600">{error}</p>}

      <div className="mt-6 flex items-center gap-3">
        <Button type="submit" disabled={saving}>
          {saving ? 'Saving…' : isEdit ? 'Save changes' : 'Add transaction'}
        </Button>
        <Link
          href="/transactions"
          className="text-sm text-slate-600 hover:text-slate-900"
        >
          Cancel
        </Link>
      </div>
    </form>
  )
}
