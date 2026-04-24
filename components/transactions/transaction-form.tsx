'use client'

import { FormEvent, useEffect, useMemo, useState } from 'react'
import { useRouter } from 'next/navigation'
import { createClient } from '@/lib/supabase/client'
import { Field } from '@/components/ui/field'
import { Button } from '@/components/ui/button'
import { money } from '@/lib/format'

const UNIT_TYPES = new Set(['stock', 'etf', 'crypto'])

type TxType = 'buy' | 'sell' | 'dividend' | 'deposit' | 'withdraw' | 'interest' | 'fee'

export type InvestmentOption = {
  id: string
  name: string
  type: string
  quantityHeld: number
  current_value: number | null
}

export type TransactionInitial = {
  id: string
  investment_id: string
  type: TxType
  date: string
  quantity: number | null
  price_per_unit: number | null
  amount: number | null
  fee: number | null
  notes: string | null
}

type Props = {
  investments: InvestmentOption[]
  initial?: TransactionInitial
}

const UNIT_TX_TYPES: TxType[] = ['buy', 'sell', 'dividend']
const AMOUNT_TX_TYPES: TxType[] = ['deposit', 'withdraw', 'interest', 'fee']

const TX_LABELS: Record<TxType, string> = {
  buy: 'Buy',
  sell: 'Sell',
  dividend: 'Dividend',
  deposit: 'Deposit',
  withdraw: 'Withdraw',
  interest: 'Interest',
  fee: 'Fee',
}

function todayISO() {
  return new Date().toISOString().slice(0, 10)
}

export function TransactionForm({ investments, initial }: Props) {
  const router = useRouter()
  const supabase = createClient()

  const [investmentId, setInvestmentId] = useState<string>(
    initial?.investment_id ?? investments[0]?.id ?? ''
  )
  const [type, setType] = useState<TxType>(initial?.type ?? 'buy')
  const [date, setDate] = useState<string>(initial?.date ?? todayISO())
  const [quantity, setQuantity] = useState<string>(
    initial?.quantity != null ? String(initial.quantity) : ''
  )
  const [pricePerUnit, setPricePerUnit] = useState<string>(
    initial?.price_per_unit != null ? String(initial.price_per_unit) : ''
  )
  const [amount, setAmount] = useState<string>(
    initial?.amount != null ? String(initial.amount) : ''
  )
  const [fee, setFee] = useState<string>(
    initial?.fee != null ? String(initial.fee) : ''
  )
  const [notes, setNotes] = useState<string>(initial?.notes ?? '')

  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const selectedInvestment = useMemo(
    () => investments.find((i) => i.id === investmentId) ?? null,
    [investments, investmentId]
  )

  const isUnit = !!selectedInvestment && UNIT_TYPES.has(selectedInvestment.type)
  const allowedTypes: TxType[] = isUnit ? UNIT_TX_TYPES : AMOUNT_TX_TYPES

  // If the investment changes and the current tx type is no longer valid, switch it.
  useEffect(() => {
    if (!selectedInvestment) return
    if (!allowedTypes.includes(type)) {
      setType(allowedTypes[0])
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [investmentId])

  const isSell = type === 'sell'
  const availableToSell = selectedInvestment?.quantityHeld ?? 0

  const showUnits = isUnit && (type === 'buy' || type === 'sell')
  const showAmount = !showUnits

  const computedAmount = useMemo(() => {
    if (!showUnits) return null
    const q = parseFloat(quantity)
    const p = parseFloat(pricePerUnit)
    if (Number.isFinite(q) && Number.isFinite(p)) {
      const f = parseFloat(fee)
      const feeNum = Number.isFinite(f) ? f : 0
      const gross = q * p
      return type === 'buy' ? gross + feeNum : gross - feeNum
    }
    return null
  }, [showUnits, quantity, pricePerUnit, fee, type])

  async function onSubmit(e: FormEvent) {
    e.preventDefault()
    setError(null)

    if (!investmentId) {
      setError('Please select an investment.')
      return
    }
    if (!date) {
      setError('Please choose a date.')
      return
    }

    const feeNum = parseFloat(fee)
    const feeVal = Number.isFinite(feeNum) ? feeNum : 0

    let finalQuantity: number | null = null
    let finalPrice: number | null = null
    let finalAmount: number | null = null

    if (showUnits) {
      finalQuantity = parseFloat(quantity)
      finalPrice = parseFloat(pricePerUnit)

      if (!Number.isFinite(finalQuantity) || finalQuantity <= 0) {
        setError('Quantity must be greater than 0.')
        return
      }
      if (!Number.isFinite(finalPrice) || finalPrice < 0) {
        setError('Price per unit must be 0 or higher.')
        return
      }

      if (isSell && finalQuantity > availableToSell + 1e-9) {
        setError(
          `You only hold ${availableToSell} ${
            availableToSell === 1 ? 'unit' : 'units'
          } — you can't sell ${finalQuantity}.`
        )
        return
      }

      const gross = finalQuantity * finalPrice
      finalAmount = type === 'buy' ? gross + feeVal : gross - feeVal
    } else {
      finalAmount = parseFloat(amount)
      if (!Number.isFinite(finalAmount) || finalAmount < 0) {
        setError('Amount must be 0 or higher.')
        return
      }
    }

    setSaving(true)
    try {
      const payload = {
        investment_id: investmentId,
        type,
        date,
        quantity: finalQuantity,
        price_per_unit: finalPrice,
        amount: finalAmount,
        fee: feeVal || null,
        notes: notes.trim() || null,
      }

      const { error: dbError } = initial
        ? await supabase.from('transactions').update(payload).eq('id', initial.id)
        : await supabase.from('transactions').insert(payload)

      if (dbError) {
        setError(dbError.message)
        setSaving(false)
        return
      }

      // Keep the investment's current_value in sync when a buy/sell price is recorded.
      if (showUnits && finalPrice != null && finalPrice > 0) {
        await supabase
          .from('investments')
          .update({ current_value: finalPrice })
          .eq('id', investmentId)
      }

      router.push('/transactions')
      router.refresh()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Something went wrong.')
      setSaving(false)
    }
  }

  if (investments.length === 0) {
    return (
      <div className="rounded-lg border border-slate-200 bg-white p-6 text-sm text-slate-600">
        You need at least one investment before you can record activity.{' '}
        <a href="/investments/new" className="font-medium text-slate-900 underline">
          Create one first
        </a>
        .
      </div>
    )
  }

  const inputClass =
    'w-full rounded-md border border-slate-300 bg-white px-3 py-2 text-sm text-slate-900 placeholder-slate-400 focus:border-slate-500 focus:outline-none focus:ring-1 focus:ring-slate-500'

  return (
    <form
      onSubmit={onSubmit}
      className="space-y-6 rounded-lg border border-slate-200 bg-white p-6"
    >
      <div className="grid gap-4 md:grid-cols-2">
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
              </option>
            ))}
          </select>
        </Field>

        <Field label="Type" htmlFor="type" required>
          <select
            id="type"
            className={inputClass}
            value={type}
            onChange={(e) => setType(e.target.value as TxType)}
          >
            {allowedTypes.map((t) => (
              <option key={t} value={t}>
                {TX_LABELS[t]}
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

        <Field label="Fee" htmlFor="fee">
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
                max={isSell ? availableToSell : undefined}
                className={inputClass}
                value={quantity}
                onChange={(e) => setQuantity(e.target.value)}
                placeholder="0"
              />
              {isSell && (
                <p className="mt-1 text-xs text-slate-500">
                  Available to sell: {availableToSell}
                </p>
              )}
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
          <Field label="Amount" htmlFor="amount" required>
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
          <Field label="Notes" htmlFor="notes">
            <textarea
              id="notes"
              className={`${inputClass} min-h-[80px]`}
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              placeholder="Optional notes"
            />
          </Field>
        </div>
      </div>

      {showUnits && computedAmount !== null && (
        <p className="text-sm text-slate-600">
          Total {type === 'buy' ? 'cost' : 'proceeds'}:{' '}
          <span className="font-medium text-slate-900">{money(computedAmount)}</span>
        </p>
      )}

      {error && (
        <p className="rounded-md bg-red-50 px-3 py-2 text-sm text-red-700">{error}</p>
      )}

      <div className="flex items-center gap-3">
        <Button type="submit" disabled={saving}>
          {saving ? 'Saving…' : initial ? 'Save changes' : 'Record activity'}
        </Button>
        <Button type="button" variant="secondary" onClick={() => router.back()}>
          Cancel
        </Button>
      </div>
    </form>
  )
}
