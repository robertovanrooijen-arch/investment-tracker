import type { Transaction } from '@/types/database'

// ---------------------------------------------------------------------------
// What `amount` means differs per source. The exact broker/invoice figure is
// leading; quantity × (rounded) price_per_unit is only a fallback.
//
// Evidence (read-only analysis of the target account, 2026-10-29, 213 rows —
// every buy/sell row of each source fits the stated meaning):
//   source_migration_degiro          amount = quantity × price (gross), fee separate
//   source_migration_trade_republic  amount = gross cash value (cents-rounded
//                                    export amount; differs from q × p by
//                                    < €0.005), fee separate
//   source_migration_bitvavo         amount = total paid (gross + fee)
//   source_migration_goldrepublic    buy: total paid (gross + fee);
//                                    sell: net proceeds (gross − fee)
//   source_migration_holland_gold    as GoldRepublic (invoice totals)
//   trade_republic_order_pdf         amount = gross (the order confirmation
//                                    states "Bruto EUR 438,00 + kosten EUR
//                                    1,00 = totaal EUR 439,00"), fee separate
// A source NOT listed here is never guessed: the fallback q × p is used and
// the row is marked 'derived'.
// ---------------------------------------------------------------------------

export type AmountSemantics = 'gross' | 'net_cash'

export const AMOUNT_SEMANTICS_BY_SOURCE: Readonly<Record<string, AmountSemantics>> = {
  source_migration_degiro: 'gross',
  source_migration_trade_republic: 'gross',
  source_migration_bitvavo: 'net_cash',
  source_migration_goldrepublic: 'net_cash',
  source_migration_holland_gold: 'net_cash',
  trade_republic_order_pdf: 'gross',
}

// A broker amount and q × p may differ by rounding; beyond this (in the price
// currency) the difference is reported as an inconsistency to explain.
export const AMOUNT_CONSISTENCY_TOLERANCE = 0.01

export type TradeAmountMethod = 'source_gross_amount' | 'source_net_cash_amount' | 'quantity_x_price'

export type TradeAmounts = {
  // Gross transaction value (before fee) in price_currency.
  grossNative: number
  // Fee in price_currency when it can be expressed there without FX
  // (same currency); null otherwise (then converted by the FX policy).
  feeSameCurrency: number | null
  // Net cash movement in price_currency when fee is in the same currency:
  // buy = gross + fee (paid), sell = gross − fee (received).
  netCashNative: number | null
  method: TradeAmountMethod
  quality: 'exact' | 'derived'
  // quantity × price_per_unit, and the broker figure's deviation from it.
  quantityPriceGross: number
  deltaVsQuantityPrice: number
  // false when a source amount deviates from q × p (± fee) by more than the
  // tolerance — still used (it is the broker figure), but must be explained.
  consistent: boolean
}

/** Normalised amounts of a buy/sell row; null for other rows. */
export function tradeAmounts(tx: Transaction): TradeAmounts | null {
  if (tx.type !== 'buy' && tx.type !== 'sell') return null
  if (tx.quantity === null || tx.price_per_unit === null) return null

  const quantityPriceGross = tx.quantity * tx.price_per_unit
  const sameCurrencyFee =
    (tx.fee_currency ?? tx.price_currency ?? 'EUR') === (tx.price_currency ?? 'EUR') ? tx.fee ?? 0 : null
  const sign = tx.type === 'buy' ? 1 : -1
  const semantics = tx.source ? AMOUNT_SEMANTICS_BY_SOURCE[tx.source] : undefined
  const amount = tx.amount

  let grossNative = quantityPriceGross
  let method: TradeAmountMethod = 'quantity_x_price'
  if (semantics === 'gross' && amount !== null && Number.isFinite(amount)) {
    grossNative = amount
    method = 'source_gross_amount'
  } else if (semantics === 'net_cash' && amount !== null && Number.isFinite(amount) && sameCurrencyFee !== null) {
    // Invoice total: buy = gross + fee, sell = gross − fee.
    grossNative = amount - sign * sameCurrencyFee
    method = 'source_net_cash_amount'
  }

  const delta = grossNative - quantityPriceGross
  return {
    grossNative,
    feeSameCurrency: sameCurrencyFee,
    netCashNative: sameCurrencyFee === null ? null : grossNative + sign * sameCurrencyFee,
    method,
    quality: method === 'quantity_x_price' ? 'derived' : 'exact',
    quantityPriceGross,
    deltaVsQuantityPrice: delta,
    consistent: method === 'quantity_x_price' || Math.abs(delta) <= AMOUNT_CONSISTENCY_TOLERANCE,
  }
}

/**
 * Gross value (price_currency) for the part of a buy/sell row that was
 * actually filled (`fraction` < 1 only when a sale was clamped to the held
 * quantity). Falls back to q × p for rows without a recognised amount.
 */
export function tradeGrossNative(tx: Transaction, fraction = 1): number {
  const t = tradeAmounts(tx)
  const gross = t ? t.grossNative : (tx.quantity ?? 0) * (tx.price_per_unit ?? 0)
  return gross * fraction
}
