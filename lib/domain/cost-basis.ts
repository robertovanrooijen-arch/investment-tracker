// Central cost-basis configuration and sale allocation.
//
// METHOD: moving average (average cost). On every buy the position's cost
// basis grows by the full purchase cost (gross + fee); on a sale the sold
// share of the cost basis is `average cost × quantity sold`. This is the only
// method implemented; it is configured here, in one place, so every replay
// (Dashboard, Year Analysis, YTD, charts, snapshots) uses the same rules.
//
// Whatever the method, a FULLY closed position realises exactly
//   total net sale proceeds − total purchase cost,
// because the sale that closes the position takes all remaining cost basis
// (see allocateSale) — so lot matching can never leave cents behind.

export type CostBasisMethod = 'moving_average'

export const COST_BASIS_METHOD: CostBasisMethod = 'moving_average'

/**
 * Quantities at or below this (in the position's own unit: shares, grams,
 * troy ounces, BTC) are economically zero. Floating-point arithmetic on
 * fractional fills leaves residues such as 5.68e-14 g after a full sale;
 * those must count as closed, not as a tiny open position. 1e-9 is far below
 * every real broker precision used here (TR shares 1e-6, BTC 1e-8, grams 1e-4).
 */
export const QUANTITY_EPSILON = 1e-9

export function isEffectivelyZero(quantity: number): boolean {
  return Math.abs(quantity) <= QUANTITY_EPSILON
}

export type SaleAllocation = {
  // Quantity actually taken from the position (never more than held).
  quantity: number
  // Share of the sale row's own quantity that was filled (1 unless oversold).
  fractionOfRow: number
  soldCostNative: number
  soldCostEur: number
  // True when this sale leaves nothing (within QUANTITY_EPSILON): all
  // remaining cost basis is assigned to it and the position is reset to 0.
  closesPosition: boolean
}

/**
 * Allocates cost basis to a sale under COST_BASIS_METHOD. Returns null when
 * nothing is held (a sale against an empty position realises nothing here;
 * the reconciliation audit reports it as an oversell).
 */
export function allocateSale(
  held: number,
  costNative: number,
  costEur: number,
  requestedQuantity: number
): SaleAllocation | null {
  if (!(held > QUANTITY_EPSILON) || !(requestedQuantity > 0)) return null
  const quantity = Math.min(requestedQuantity, held)
  const closesPosition = isEffectivelyZero(held - quantity)
  if (closesPosition) {
    return {
      quantity: held,
      fractionOfRow: Math.min(1, held / requestedQuantity),
      soldCostNative: costNative,
      soldCostEur: costEur,
      closesPosition: true,
    }
  }
  const share = quantity / held
  return {
    quantity,
    fractionOfRow: quantity / requestedQuantity,
    soldCostNative: costNative * share,
    soldCostEur: costEur * share,
    closesPosition: false,
  }
}
