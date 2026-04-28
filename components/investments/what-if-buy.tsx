'use client'

import { useMemo, useState } from 'react'
import { money } from '@/lib/format'

type Props = {
  quantityHeld: number
  remainingCostBasis: number
  currentAverageBuyPrice: number | null
}

export function WhatIfBuy({
  quantityHeld,
  remainingCostBasis,
  currentAverageBuyPrice,
}: Props) {
  const [quantity, setQuantity] = useState('')
  const [price, setPrice] = useState('')
  const [fee, setFee] = useState('')

  const result = useMemo(() => {
    const q = parseFloat(quantity)
    const p = parseFloat(price)
    const f = parseFloat(fee)

    if (!Number.isFinite(q) || q <= 0) return null
    if (!Number.isFinite(p) || p < 0) return null

    const feeNum = Number.isFinite(f) && f >= 0 ? f : 0
    const buyCost = q * p + feeNum
    const newQuantity = quantityHeld + q
    const newCostBasis = remainingCostBasis + buyCost
    const newAverageBuyPrice = newQuantity > 0 ? newCostBasis / newQuantity : null

    const delta =
      currentAverageBuyPrice != null && newAverageBuyPrice != null
        ? newAverageBuyPrice - currentAverageBuyPrice
        : null

    return { newQuantity, newCostBasis, newAverageBuyPrice, buyCost, delta }
  }, [quantity, price, fee, quantityHeld, remainingCostBasis, currentAverageBuyPrice])

  const inputClass =
    'w-full rounded-md border border-slate-300 bg-white px-3 py-2 text-sm text-slate-900 placeholder-slate-400 focus:border-slate-500 focus:outline-none focus:ring-1 focus:ring-slate-500'

  return (
    <section className="rounded-lg border border-slate-200 bg-white p-6">
      <div>
        <h2 className="text-lg font-semibold text-slate-900">What-if: buy more</h2>
        <p className="mt-1 text-sm text-slate-600">
          Simulate adding to this position to see the impact on your average buy price.
          Nothing is saved.
        </p>
      </div>

      <div className="mt-4 grid gap-4 md:grid-cols-3">
        <div>
          <label htmlFor="wif-qty" className="mb-1 block text-sm font-medium text-slate-700">
            Quantity
          </label>
          <input
            id="wif-qty"
            type="number"
            step="any"
            min="0"
            className={inputClass}
            value={quantity}
            onChange={(e) => setQuantity(e.target.value)}
            placeholder="0"
          />
        </div>
        <div>
          <label htmlFor="wif-price" className="mb-1 block text-sm font-medium text-slate-700">
            Price per unit
          </label>
          <input
            id="wif-price"
            type="number"
            step="any"
            min="0"
            className={inputClass}
            value={price}
            onChange={(e) => setPrice(e.target.value)}
            placeholder="0.00"
          />
        </div>
        <div>
          <label htmlFor="wif-fee" className="mb-1 block text-sm font-medium text-slate-700">
            Fee <span className="text-slate-400">(optional)</span>
          </label>
          <input
            id="wif-fee"
            type="number"
            step="any"
            min="0"
            className={inputClass}
            value={fee}
            onChange={(e) => setFee(e.target.value)}
            placeholder="0.00"
          />
        </div>
      </div>

      <div className="mt-6 grid gap-3 md:grid-cols-3">
        <Stat
          label="Current avg buy price"
          value={currentAverageBuyPrice != null ? money(currentAverageBuyPrice) : '—'}
        />
        <Stat
          label="New avg buy price"
          value={result?.newAverageBuyPrice != null ? money(result.newAverageBuyPrice) : '—'}
          hint={
            result?.delta != null
              ? `${result.delta >= 0 ? '+' : ''}${money(result.delta)} per unit`
              : undefined
          }
          highlight={!!result}
        />
        <Stat
          label="New quantity"
          value={result ? formatNumber(result.newQuantity) : formatNumber(quantityHeld)}
          hint={result ? `was ${formatNumber(quantityHeld)}` : undefined}
        />
      </div>

      {result && (
        <p className="mt-4 text-xs text-slate-500">
          New cost basis:{' '}
          <span className="font-medium text-slate-700">{money(result.newCostBasis)}</span>{' '}
          · this buy adds{' '}
          <span className="font-medium text-slate-700">{money(result.buyCost)}</span>
        </p>
      )}
    </section>
  )
}

function Stat({
  label,
  value,
  hint,
  highlight,
}: {
  label: string
  value: string
  hint?: string
  highlight?: boolean
}) {
  return (
    <div
      className={`rounded-md border px-3 py-2 ${
        highlight ? 'border-slate-300 bg-slate-50' : 'border-slate-200 bg-white'
      }`}
    >
      <p className="text-xs uppercase tracking-wide text-slate-500">{label}</p>
      <p className="mt-1 text-lg font-semibold text-slate-900">{value}</p>
      {hint && <p className="mt-0.5 text-xs text-slate-500">{hint}</p>}
    </div>
  )
}

function formatNumber(n: number) {
  // Trim trailing zeros for fractional crypto holdings while keeping integers tidy.
  if (Number.isInteger(n)) return String(n)
  return n.toFixed(6).replace(/\.?0+$/, '')
}