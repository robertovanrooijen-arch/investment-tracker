'use client'

import { FormEvent, useEffect, useMemo, useState } from 'react'
import { useRouter } from 'next/navigation'
import { createClient } from '@/lib/supabase/client'
import { Field } from '@/components/ui/field'
import { Button } from '@/components/ui/button'
import { money } from '@/lib/format'
import { SUPPORTED_CURRENCIES } from '@/lib/domain/fx'

const UNIT_TYPES = new Set(['stock', 'ETF', 'crypto', 'commodity'])

type TxType =
  | 'buy'
  | 'sell'
  | 'dividend'
  | 'deposit'
  | 'withdraw'
  | 'interest'
  | 'fee'
  | 'value update'

export type InvestmentOption = {
  id: string
  name: string
  type: string
  quantityHeld: number
  current_value: number | null
  currency: string
  quantity_unit?: string | null
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
  price_currency: string | null
  fee_currency: string | null
  fx_rate_to_eur: number | null
  is_contribution: boolean
  contribution_source: string | null
}

type FxRates = Record<string, number>

type Props = {
  investments: InvestmentOption[]
  initial?: TransactionInitial
  fxRates: FxRates
}

const COMMODITY_TX_TYPES: TxType[] = ['buy', 'sell']
const UNIT_TX_TYPES: TxType[] = ['buy', 'sell', 'dividend']
const AMOUNT_TX_TYPES: TxType[] = [
  'deposit',
  'withdraw',
  'interest',
  'fee',
  'value update',
]

const TX_LABELS: Record<TxType, string> = {
  buy: 'Buy',
  sell: 'Sell',
  dividend: 'Dividend',
  deposit: 'Deposit',
  withdraw: 'Withdraw',
  interest: 'Interest',
  fee: 'Fee',
  'value update': 'Value update',
}

const AMOUNT_FIELD_LABELS: Record<TxType, string> = {
  buy: 'Amount',
  sell: 'Amount',
  dividend: 'Dividend amount',
  deposit: 'Deposit amount',
  withdraw: 'Withdrawal amount',
  interest: 'Interest amount',
  fee: 'Fee amount',
  'value update': 'New value',
}

// Sign that determines how a transaction affects the cash balance.
//   +1 → cash arrives (current_value goes up)
//   -1 → cash leaves (current_value goes down)
//    0 → no automatic effect on current_value
function cashSign(t: TxType): 1 | -1 | 0 {
  if (t === 'deposit' || t === 'interest') return 1
  if (t === 'withdraw' || t === 'fee') return -1
  return 0
}

function todayISO() {
  return new Date().toISOString().slice(0, 10)
}

export function TransactionForm({ investments, initial, fxRates }: Props) {
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
  const [feeCurrency, setFeeCurrency] = useState<string>(
    initial?.fee_currency ?? 'EUR'
  )
  const [fxRateOverride, setFxRateOverride] = useState<string>(
    initial?.fx_rate_to_eur != null ? String(initial.fx_rate_to_eur) : ''
  )

  const [interestMode, setInterestMode] = useState<'fixed' | 'pct'>('fixed')
  const [interestPct, setInterestPct] = useState<string>('')

  const [isContribution, setIsContribution] = useState<boolean>(
    initial?.is_contribution ?? false
  )

  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const selectedInvestment = useMemo(
    () => investments.find((i) => i.id === investmentId) ?? null,
    [investments, investmentId]
  )

  const priceCurrency = selectedInvestment?.currency ?? 'EUR'
  const priceToEur = fxRates[priceCurrency] ?? 1
  const feeToEur = fxRates[feeCurrency] ?? 1

  const effectivePriceToEur = useMemo(() => {
    const trimmed = fxRateOverride.trim()
    if (trimmed === '') return priceToEur
    const parsed = parseFloat(trimmed)
    return Number.isFinite(parsed) && parsed > 0 ? parsed : priceToEur
  }, [fxRateOverride, priceToEur])

  const isUnit =
    !!selectedInvestment && UNIT_TYPES.has(selectedInvestment.type)
  const isCommodity = selectedInvestment?.type === 'commodity'
  const quantityUnit = selectedInvestment?.quantity_unit ?? null
  const unitLabel = quantityUnit === 'gram' ? 'g' : quantityUnit === 'troy_ounce' ? 'oz' : ''
  const allowedTypes: TxType[] = isCommodity
    ? COMMODITY_TX_TYPES
    : isUnit
      ? UNIT_TX_TYPES
      : AMOUNT_TX_TYPES

  useEffect(() => {
    if (!selectedInvestment) return
    if (!allowedTypes.includes(type)) {
      setType(allowedTypes[0])
      setInterestMode('fixed')
      setInterestPct('')
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [investmentId])

  const isSell = type === 'sell'
  const isFeeTransaction = type === 'fee'
  const isInterest = type === 'interest'
  const availableToSell = selectedInvestment?.quantityHeld ?? 0
  const currentValue = selectedInvestment?.current_value ?? null

  const showUnits = isUnit && (type === 'buy' || type === 'sell')
  const showAmount = !showUnits
  const showFxOverride = priceCurrency !== 'EUR'
  const showBrokerFeeField = !isFeeTransaction // hidden when the tx itself is a fee

  const totalsPreview = useMemo(() => {
    if (!showUnits) return null

    const q = parseFloat(quantity)
    const p = parseFloat(pricePerUnit)
    if (!Number.isFinite(q) || !Number.isFinite(p)) return null

    const f = parseFloat(fee)
    const feeNum = Number.isFinite(f) && f >= 0 ? f : 0

    const assetCost = q * p
    const assetEur = assetCost * effectivePriceToEur
    const feeEur = feeNum * feeToEur
    const totalEur = type === 'buy' ? assetEur + feeEur : assetEur - feeEur

    return { assetCost, feeAmount: feeNum, totalEur }
  }, [showUnits, quantity, pricePerUnit, fee, type, effectivePriceToEur, feeToEur])

  const amountEurPreview = useMemo(() => {
    if (!showAmount || priceCurrency === 'EUR') return null
    const a = parseFloat(amount)
    if (!Number.isFinite(a) || a <= 0) return null
    return a * effectivePriceToEur
  }, [showAmount, amount, priceCurrency, effectivePriceToEur])

  // Percentage-based interest: amount = currentValue × pct / 100
  const interestPctAmount = useMemo(() => {
    if (!isInterest || interestMode !== 'pct') return null
    const pctNum = parseFloat(interestPct)
    if (!Number.isFinite(pctNum) || pctNum <= 0) return null
    if (currentValue == null || currentValue <= 0) return null
    return (currentValue * pctNum) / 100
  }, [isInterest, interestMode, interestPct, currentValue])

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

    // Broker fee: 0 is valid. For 'fee' tx type, force broker fee to 0
    // (the tx amount IS the fee — no separate broker fee).
    const feeNum = parseFloat(fee)
    const feeVal = isFeeTransaction
      ? 0
      : Number.isFinite(feeNum) && feeNum >= 0
        ? feeNum
        : 0

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
        const heldLabel =
          isCommodity && unitLabel
            ? `${availableToSell} ${unitLabel}`
            : `${availableToSell} ${availableToSell === 1 ? 'unit' : 'units'}`
        setError(`You only hold ${heldLabel} — you can't sell ${finalQuantity}.`)
        return
      }

      const gross = finalQuantity * finalPrice
      finalAmount = type === 'buy' ? gross + feeVal : gross - feeVal
    } else {
      if (isInterest && interestMode === 'pct') {
        if (interestPctAmount === null || interestPctAmount <= 0) {
          setError(
            currentValue == null || currentValue <= 0
              ? 'This investment has no current value set — update it before using percentage mode.'
              : 'Enter a valid interest percentage greater than 0.',
          )
          return
        }
        finalAmount = interestPctAmount
      } else {
        finalAmount = parseFloat(amount)
        if (!Number.isFinite(finalAmount) || finalAmount < 0) {
          setError('Amount must be 0 or higher.')
          return
        }
      }
    }

    let fxRateToSave: number | null = null
    const overrideStr = fxRateOverride.trim()
    if (overrideStr !== '') {
      const parsed = parseFloat(overrideStr)
      if (!Number.isFinite(parsed) || parsed <= 0) {
        setError('FX rate must be a positive number.')
        return
      }
      fxRateToSave = parsed
    } else {
      const live = fxRates[priceCurrency]
      fxRateToSave =
        typeof live === 'number' && Number.isFinite(live) ? live : null
    }

    setSaving(true)

    try {
      const {
        data: { user },
        error: userError,
      } = await supabase.auth.getUser()

      if (userError || !user) {
        setError('You are not signed in.')
        setSaving(false)
        return
      }

      const showContributionCheckbox = type === 'buy' || type === 'deposit' || type === 'withdraw'

      const payload = {
        investment_id:       investmentId,
        type,
        date,
        quantity:            finalQuantity,
        price_per_unit:      finalPrice,
        amount:              finalAmount,
        fee:                 feeVal,
        notes:               notes.trim() || null,
        price_currency:      priceCurrency,
        fee_currency:        feeCurrency,
        fx_rate_to_eur:      fxRateToSave,
        is_contribution:     showContributionCheckbox ? isContribution : false,
        contribution_source: showContributionCheckbox && isContribution ? 'external' : null,
      }

      const { error: dbError } = initial
        ? await supabase
            .from('transactions')
            .update(payload)
            .eq('id', initial.id)
        : await supabase.from('transactions').insert({
            ...payload,
            user_id: user.id,
          })

      if (dbError) {
        setError(dbError.message)
        setSaving(false)
        return
      }

      // 1. Sync current_price for unit-asset buys/sells.
      if (showUnits && finalPrice != null && finalPrice > 0) {
        await supabase
          .from('investments')
          .update({ current_price: finalPrice })
          .eq('id', investmentId)
      }

      // 2. 'value update' tx sets current_value to a specific value.
      if (type === 'value update' && finalAmount !== null) {
        await supabase
          .from('investments')
          .update({ current_value: finalAmount })
          .eq('id', investmentId)
      }

      // 3. Cash-flow auto-update of current_value.
      //    deposit / interest → +amount
      //    withdraw / fee     → -amount
      //
      //    On insert: apply the full delta.
      //    On edit (same investment): reverse the old impact, apply the new.
      //    On edit that changed investment: skipped — too easy to misalign
      //    two investments. User can correct with a 'value update' tx.
      let valueDelta = 0
      if (!initial && cashSign(type) !== 0 && finalAmount != null) {
        valueDelta = cashSign(type) * finalAmount
      } else if (
        initial &&
        initial.investment_id === investmentId &&
        finalAmount != null
      ) {
        const oldImpact = cashSign(initial.type) * (initial.amount ?? 0)
        const newImpact = cashSign(type) * finalAmount
        valueDelta = newImpact - oldImpact
      }

      if (valueDelta !== 0) {
        const { data: invRow } = await supabase
          .from('investments')
          .select('current_value')
          .eq('id', investmentId)
          .single()

        if (invRow) {
          await supabase
            .from('investments')
            .update({
              current_value: (invRow.current_value ?? 0) + valueDelta,
            })
            .eq('id', investmentId)
        }
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
        <a
          href="/investments/new"
          className="font-medium text-slate-900 underline"
        >
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
                {inv.name} ({inv.currency})
              </option>
            ))}
          </select>
        </Field>

        <Field label="Type" htmlFor="type" required>
          <select
            id="type"
            className={inputClass}
            value={type}
            onChange={(e) => {
              const next = e.target.value as TxType
              setType(next)
              if (next !== 'interest') {
                setInterestMode('fixed')
                setInterestPct('')
              }
              if (next !== 'buy' && next !== 'deposit') {
                setIsContribution(false)
              }
            }}
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

        {showBrokerFeeField && (
          <Field label="Fee" htmlFor="fee">
            <div className="flex gap-2">
              <input
                id="fee"
                type="number"
                step="any"
                min="0"
                className={`${inputClass} flex-1 min-w-0`}
                value={fee}
                onChange={(e) => setFee(e.target.value)}
                placeholder="0.00"
              />
              <select
                aria-label="Fee currency"
                className="w-[110px] shrink-0 rounded-md border border-slate-300 bg-white px-3 py-2 text-sm text-slate-900 focus:border-slate-500 focus:outline-none focus:ring-1 focus:ring-slate-500"
                value={feeCurrency}
                onChange={(e) => setFeeCurrency(e.target.value)}
              >
                {SUPPORTED_CURRENCIES.map((c) => (
                  <option key={c} value={c}>
                    {c}
                  </option>
                ))}
              </select>
            </div>
            <p className="mt-1 text-xs text-slate-500">
              Broker fee currency. 0 is allowed for commission-free trades.
            </p>
          </Field>
        )}

        {showUnits && (
          <>
            <Field
              label={isCommodity && unitLabel ? `Quantity (${unitLabel})` : 'Quantity'}
              htmlFor="quantity"
              required
            >
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
                  Available to sell:{' '}
                  {isCommodity && unitLabel
                    ? `${availableToSell} ${unitLabel}`
                    : availableToSell}
                </p>
              )}
            </Field>

            <Field
              label={
                isCommodity
                  ? `Price per ${quantityUnit === 'gram' ? 'gram' : 'troy ounce'} (${priceCurrency})`
                  : `Price per unit (${priceCurrency})`
              }
              htmlFor="price"
              required
            >
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
              <p className="mt-1 text-xs text-slate-500">
                Asset trading currency: {priceCurrency}.
              </p>
            </Field>
          </>
        )}

        {showAmount && (
          <div className="md:col-span-2 space-y-3">
            {isInterest && (
              <div className="flex gap-2">
                <button
                  type="button"
                  onClick={() => setInterestMode('fixed')}
                  className={`px-3 py-1.5 rounded-lg text-sm font-medium border transition-colors ${
                    interestMode === 'fixed'
                      ? 'bg-slate-900 text-white border-slate-900'
                      : 'bg-white text-slate-700 border-slate-300 hover:bg-slate-50'
                  }`}
                >
                  Fixed amount
                </button>
                <button
                  type="button"
                  onClick={() => setInterestMode('pct')}
                  className={`px-3 py-1.5 rounded-lg text-sm font-medium border transition-colors ${
                    interestMode === 'pct'
                      ? 'bg-slate-900 text-white border-slate-900'
                      : 'bg-white text-slate-700 border-slate-300 hover:bg-slate-50'
                  }`}
                >
                  Percentage
                </button>
              </div>
            )}

            {(!isInterest || interestMode === 'fixed') && (
              <Field
                label={`${AMOUNT_FIELD_LABELS[type]} (${priceCurrency})`}
                htmlFor="amount"
                required
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
                {amountEurPreview !== null && (
                  <p className="mt-1 text-xs text-slate-500">
                    ≈ {money(amountEurPreview, 'EUR')}
                  </p>
                )}
              </Field>
            )}

            {isInterest && interestMode === 'pct' && (
              <Field
                label="Interest rate (%)"
                htmlFor="interest-pct"
                required
              >
                <input
                  id="interest-pct"
                  type="number"
                  step="any"
                  min="0"
                  className={inputClass}
                  value={interestPct}
                  onChange={(e) => setInterestPct(e.target.value)}
                  placeholder="e.g. 2.5"
                />
                {interestPctAmount !== null && currentValue !== null && (
                  <p className="mt-1 text-xs text-slate-500">
                    = {money(interestPctAmount, priceCurrency)}{' '}
                    ({interestPct}% of {money(currentValue, priceCurrency)})
                  </p>
                )}
                {(currentValue == null || currentValue <= 0) && (
                  <p className="mt-1 text-xs text-amber-600">
                    This investment has no current value set — update it before using percentage mode.
                  </p>
                )}
              </Field>
            )}
          </div>
        )}

        {showFxOverride && (
          <div className="md:col-span-2">
            <Field
              label={`FX rate (${priceCurrency} → EUR)`}
              htmlFor="fxrate"
            >
              <input
                id="fxrate"
                type="number"
                step="any"
                min="0"
                className={inputClass}
                value={fxRateOverride}
                onChange={(e) => setFxRateOverride(e.target.value)}
                placeholder={priceToEur ? priceToEur.toFixed(4) : '0.0000'}
              />
              <p className="mt-1 text-xs text-slate-500">
                Leave empty to use the current rate ({priceToEur.toFixed(4)}).
                Override with the rate from your broker&apos;s confirmation
                for exact accuracy.
              </p>
            </Field>
          </div>
        )}

        {(type === 'buy' || type === 'deposit' || type === 'withdraw') && (
          <div className="md:col-span-2">
            <label className="flex items-start gap-3 cursor-pointer group">
              <input
                type="checkbox"
                checked={isContribution}
                onChange={(e) => setIsContribution(e.target.checked)}
                className="mt-0.5 h-4 w-4 rounded border-slate-300 accent-slate-900 cursor-pointer"
              />
              <span className="text-sm text-slate-700 leading-snug">
                {type === 'withdraw' ? (
                  <>
                    <span className="font-medium">Counts as money taken out of my portfolio</span>
                    <span className="block text-xs text-slate-400 mt-0.5">
                      Check this if the cash left your portfolio for good (withdrawn to bank/spending).
                      Leave unchecked for internal transfers — e.g. withdrawing to buy on another platform.
                    </span>
                  </>
                ) : (
                  <>
                    <span className="font-medium">New money from outside my portfolio</span>
                    <span className="block text-xs text-slate-400 mt-0.5">
                      Check this if the funds came from your bank or income — not from selling
                      or reinvesting existing portfolio assets.
                    </span>
                  </>
                )}
              </span>
            </label>
          </div>
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

      {showUnits && totalsPreview && (
        <div className="space-y-1 rounded-md bg-slate-50 px-4 py-3 text-sm">
          <div className="flex justify-between text-slate-600">
            <span>Asset {type === 'buy' ? 'cost' : 'value'}</span>
            <span className="font-medium text-slate-900 tabular-nums">
              {money(totalsPreview.assetCost, priceCurrency)}
            </span>
          </div>
          {totalsPreview.feeAmount > 0 && (
            <div className="flex justify-between text-slate-600">
              <span>Fee</span>
              <span className="font-medium text-slate-900 tabular-nums">
                {money(totalsPreview.feeAmount, feeCurrency)}
              </span>
            </div>
          )}
          <div className="flex justify-between border-t border-slate-200 pt-2 text-slate-600">
            <span>≈ Total {type === 'buy' ? 'cash out' : 'cash in'} (EUR)</span>
            <span className="font-semibold text-slate-900 tabular-nums">
              {money(totalsPreview.totalEur, 'EUR')}
            </span>
          </div>
        </div>
      )}

      {error && (
        <p className="rounded-md bg-red-50 px-3 py-2 text-sm text-red-700">
          {error}
        </p>
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