'use client'

import { useState, type FormEvent } from 'react'
import { useRouter } from 'next/navigation'
import Link from 'next/link'
import { createClient } from '@/lib/supabase/client'
import {
  CATEGORIES,
  PLATFORMS,
  hasUnits,
  COMMODITY_KINDS,
  QUANTITY_UNITS,
  DEFAULT_COMMODITY_TICKERS,
} from '@/lib/domain/constants'
import type {
  Investment,
  InvestmentInput,
  InvestmentType,
  CommodityKind,
  QuantityUnit,
} from '@/types/database'
import { Field } from '@/components/ui/field'
import { Button } from '@/components/ui/button'

type InvestmentFormProps = {
  initial?: Investment
}

const inputClass =
  'w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm text-slate-900 placeholder:text-slate-400 focus:border-slate-900 focus:outline-none focus:ring-1 focus:ring-slate-900'

// All default commodity tickers — used to detect whether the ticker was
// auto-set, so we can replace it when the user changes metal or currency.
const DEFAULT_COMMODITY_TICKER_SET = new Set(Object.values(DEFAULT_COMMODITY_TICKERS))

function getDefaultCommodityTicker(kind: CommodityKind): string {
  return DEFAULT_COMMODITY_TICKERS[kind]
}

export function InvestmentForm({ initial }: InvestmentFormProps) {
  const router = useRouter()
  const supabase = createClient()
  const isEdit = Boolean(initial)

  const [name, setName] = useState(initial?.name ?? '')
  const [ticker, setTicker] = useState(initial?.ticker ?? '')
  const [type, setType] = useState<InvestmentType>(initial?.type ?? 'stock')
  const [platform, setPlatform] = useState(initial?.platform ?? PLATFORMS[0])
  const [currency, setCurrency] = useState(initial?.currency ?? 'EUR')

  const [commodityKind, setCommodityKind] = useState<CommodityKind>(
    initial?.commodity_kind ?? 'gold'
  )
  const [quantityUnit, setQuantityUnit] = useState<QuantityUnit>(
    initial?.quantity_unit ?? 'troy_ounce'
  )

  const [currentPrice, setCurrentPrice] = useState(
    initial?.current_price !== null && initial?.current_price !== undefined
      ? String(initial.current_price)
      : ''
  )

  const [currentValue, setCurrentValue] = useState(
    initial?.current_value !== null && initial?.current_value !== undefined
      ? String(initial.current_value)
      : ''
  )

  const [notes, setNotes] = useState(initial?.notes ?? '')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const isCommodity = type === 'commodity'
  const showPrice = hasUnits(type)
  const showValue = !hasUnits(type)
  const requiresTicker = hasUnits(type)

  const priceLabelSuffix = isCommodity
    ? ` per ${quantityUnit === 'gram' ? 'gram' : 'troy ounce'} (${currency})`
    : ' per unit'

  function handleTypeChange(newType: InvestmentType) {
    setType(newType)
    if (newType === 'commodity') {
      if (!ticker || DEFAULT_COMMODITY_TICKER_SET.has(ticker)) {
        setTicker(getDefaultCommodityTicker(commodityKind))
      }
      // GC=F / SI=F are USD instruments — default to USD when switching in.
      if (!isCommodity) {
        setCurrency('USD')
      }
    }
  }

  function handleCommodityKindChange(newKind: CommodityKind) {
    setCommodityKind(newKind)
    if (isCommodity && DEFAULT_COMMODITY_TICKER_SET.has(ticker)) {
      setTicker(getDefaultCommodityTicker(newKind))
    }
  }

  function handleCurrencyChange(newCurr: string) {
    setCurrency(newCurr)
  }

  async function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault()
    setError(null)

    if (!name.trim()) {
      setError('Name is required.')
      return
    }

    if (requiresTicker && !ticker.trim()) {
      setError('Ticker is required for stocks, ETFs, crypto, and commodities.')
      return
    }
    if (!platform.trim()) {
      setError('Platform is required.')
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

    const payload: InvestmentInput = {
      name: name.trim(),
      ticker: ticker.trim() ? ticker.trim().toUpperCase() : null,
      type,
      platform: platform.trim(),
      current_price:
        showPrice && currentPrice !== '' ? Number(currentPrice) : null,
      current_value:
        showValue && currentValue !== '' ? Number(currentValue) : null,
      currency: currency.trim() || 'EUR',
      notes: notes.trim() ? notes.trim() : null,
      commodity_kind: isCommodity ? commodityKind : null,
      quantity_unit: isCommodity ? quantityUnit : null,
    }

    if (isEdit && initial) {
      const { error: updateErr } = await supabase
        .from('investments')
        .update(payload)
        .eq('id', initial.id)

      if (updateErr) {
        setError(updateErr.message)
        setSaving(false)
        return
      }
    } else {
      const { error: insertErr } = await supabase
        .from('investments')
        .insert({ ...payload, user_id: user.id })

      if (insertErr) {
        setError(insertErr.message)
        setSaving(false)
        return
      }
    }

    if (isEdit && initial) {
      router.push(`/investments/${initial.id}`)
    } else {
      router.push('/investments')
    }

    router.refresh()
  }

  return (
    <form
      onSubmit={onSubmit}
      className="bg-white rounded-2xl border border-slate-200 p-6 md:p-8 max-w-2xl"
    >
      <div className="grid grid-cols-1 md:grid-cols-2 gap-5">
        <Field label="Name" htmlFor="name" required>
          <input
            id="name"
            className={inputClass}
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="e.g. Apple, Bitcoin, My house"
            required
          />
        </Field>

        <Field label="Type" htmlFor="type" required>
          <select
            id="type"
            className={inputClass}
            value={type}
            onChange={(e) => handleTypeChange(e.target.value as InvestmentType)}
          >
            {CATEGORIES.map((c) => (
              <option key={c} value={c}>
                {c}
              </option>
            ))}
          </select>
        </Field>

        {isCommodity && (
          <>
            <Field label="Metal" htmlFor="commodity_kind" required>
              <select
                id="commodity_kind"
                className={inputClass}
                value={commodityKind}
                onChange={(e) =>
                  handleCommodityKindChange(e.target.value as CommodityKind)
                }
              >
                {COMMODITY_KINDS.map((k) => (
                  <option key={k} value={k}>
                    {k}
                  </option>
                ))}
              </select>
            </Field>

            <Field label="Quantity unit" htmlFor="quantity_unit" required>
              <select
                id="quantity_unit"
                className={inputClass}
                value={quantityUnit}
                onChange={(e) =>
                  setQuantityUnit(e.target.value as QuantityUnit)
                }
              >
                <option value="gram">gram</option>
                <option value="troy_ounce">troy ounce</option>
              </select>
            </Field>
          </>
        )}

        <Field
          label={requiresTicker ? 'Ticker' : 'Ticker (optional)'}
          htmlFor="ticker"
          required={requiresTicker}
        >
          <input
            id="ticker"
            className={inputClass}
            value={ticker}
            onChange={(e) => setTicker(e.target.value.toUpperCase())}
            placeholder="e.g. TSLA, VWCE.DE, BTC-EUR"
          />
          {isCommodity ? (
            <p className="mt-1 text-xs text-slate-500">
              Default: <code>{getDefaultCommodityTicker(commodityKind)}</code>{' '}
              (COMEX futures, USD/troy oz). You can enter any Yahoo Finance
              ticker manually.
            </p>
          ) : (
            requiresTicker && (
              <p className="mt-1 text-xs text-slate-500">
                Must match Yahoo Finance format. US stocks:{' '}
                <code>TSLA</code>. Amsterdam: <code>INGA.AS</code>. Xetra:{' '}
                <code>VWCE.DE</code>. Crypto in EUR: <code>BTC-EUR</code>.
              </p>
            )
          )}
        </Field>

        <Field label="Currency" htmlFor="currency">
          <select
            id="currency"
            className={inputClass}
            value={currency}
            onChange={(e) => handleCurrencyChange(e.target.value)}
          >
            <option value="EUR">EUR</option>
            <option value="USD">USD</option>
            <option value="GBP">GBP</option>
          </select>
        </Field>

        <Field label="Platform" htmlFor="platform" required>
          <input
            id="platform"
            list="platform-suggestions"
            className={inputClass}
            value={platform}
            onChange={(e) => setPlatform(e.target.value)}
            placeholder="e.g. DEGIRO, Trading 212, your own"
            required
          />
          <datalist id="platform-suggestions">
            {PLATFORMS.map((p) => (
              <option key={p} value={p} />
            ))}
          </datalist>
          <p className="mt-1 text-xs text-slate-500">
            Pick from suggestions or type your own.
          </p>
        </Field>

        {showPrice && (
          <Field
            label={`Current price${priceLabelSuffix}`}
            htmlFor="current_price"
            hint="Latest price. Used with your quantity to compute value."
          >
            <input
              id="current_price"
              type="number"
              step="any"
              min="0"
              className={inputClass}
              value={currentPrice}
              onChange={(e) => setCurrentPrice(e.target.value)}
              placeholder="0.00"
            />
          </Field>
        )}

        {showValue && (
          <Field
            label="Current value"
            htmlFor="current_value"
            hint="Optional — total value of this holding"
          >
            <input
              id="current_value"
              type="number"
              step="any"
              min="0"
              className={inputClass}
              value={currentValue}
              onChange={(e) => setCurrentValue(e.target.value)}
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
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              placeholder="Anything you want to remember about this investment"
            />
          </Field>
        </div>
      </div>

      {error && <p className="mt-4 text-sm text-rose-600">{error}</p>}

      <div className="mt-6 flex items-center gap-3">
        <Button type="submit" disabled={saving}>
          {saving ? 'Saving…' : isEdit ? 'Save changes' : 'Add investment'}
        </Button>
        <Link
          href="/investments"
          className="text-sm text-slate-600 hover:text-slate-900"
        >
          Cancel
        </Link>
      </div>
    </form>
  )
}
