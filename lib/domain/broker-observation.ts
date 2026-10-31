// ---------------------------------------------------------------------------
// Broker value observations: a current value as the broker shows it (e.g. the
// GoldRepublic price per kilogram), read off by the owner or taken from a
// screenshot/export.
//
// An observation is a SEPARATE fact next to the market data: it never
// replaces historical closes, benchmark prices or transactions. For dealer
// metals it can anchor the dealer basis used by the valuation and TWR; the
// basis change itself is excluded from return. It is shown as a status:
//   * no evidence            → 'owner_reported'
//   * screenshot or export   → 'broker_evidence'
//   * official statement     → 'officially_confirmed'
// An observation older than OBSERVATION_STALE_AFTER_DAYS is shown as stale.
// ---------------------------------------------------------------------------

export type ObservationPriceUnit = 'gram' | 'kilogram' | 'troy_ounce' | 'unit'
export type ObservationEvidence = 'none' | 'screenshot' | 'export' | 'statement'
export type ObservationStatus = 'owner_reported' | 'broker_evidence' | 'officially_confirmed'

export type BrokerValueObservation = {
  investmentId: string
  quantity: number // in the investment's own unit (grams for metals tracked in grams)
  quantityUnit: 'gram' | 'troy_ounce' | 'unit'
  price: number
  priceUnit: ObservationPriceUnit
  currency: string
  totalValue: number // as shown by the broker
  observedAt: string // ISO date-time
  source: string
  evidence: ObservationEvidence
}

export const OBSERVATION_STALE_AFTER_DAYS = 3
export const OBSERVATION_VALUE_TOLERANCE = 0.005 // half a cent: the broker rounds to cents

const GRAMS_PER: Record<Exclude<ObservationPriceUnit, 'unit'>, number> = {
  gram: 1,
  kilogram: 1000,
  troy_ounce: 31.1034768,
}

/** Quantity × price, converting the price unit to the quantity unit. null when the units do not fit. */
export function observationComputedValue(o: Pick<BrokerValueObservation, 'quantity' | 'quantityUnit' | 'price' | 'priceUnit'>): number | null {
  if (o.priceUnit === 'unit' || o.quantityUnit === 'unit') {
    return o.priceUnit === o.quantityUnit ? o.quantity * o.price : null
  }
  const grams = o.quantity * GRAMS_PER[o.quantityUnit]
  return (grams / GRAMS_PER[o.priceUnit]) * o.price
}

export const roundCents = (n: number) => Math.round((n + Number.EPSILON) * 100) / 100

export function observationStatus(evidence: ObservationEvidence): ObservationStatus {
  if (evidence === 'statement') return 'officially_confirmed'
  if (evidence === 'screenshot' || evidence === 'export') return 'broker_evidence'
  return 'owner_reported'
}

export type ObservationView = {
  investmentId: string
  status: ObservationStatus
  computedValue: number | null
  roundedValue: number | null
  // The broker's total equals quantity × price after rounding to cents.
  consistent: boolean
  ageDays: number
  stale: boolean
  observation: BrokerValueObservation
}

export function viewObservation(o: BrokerValueObservation, now: string): ObservationView {
  const computed = observationComputedValue(o)
  const ageDays = (Date.parse(now) - Date.parse(o.observedAt)) / 86_400_000
  return {
    investmentId: o.investmentId,
    status: observationStatus(o.evidence),
    computedValue: computed,
    roundedValue: computed === null ? null : roundCents(computed),
    consistent: computed !== null && Math.abs(roundCents(computed) - o.totalValue) <= OBSERVATION_VALUE_TOLERANCE,
    ageDays,
    stale: ageDays > OBSERVATION_STALE_AFTER_DAYS,
    observation: o,
  }
}

/** Latest observation per investment (by observedAt), as display views. */
export function latestObservations(all: BrokerValueObservation[], now: string): Map<string, ObservationView> {
  const latest = new Map<string, BrokerValueObservation>()
  for (const o of all) {
    const cur = latest.get(o.investmentId)
    if (!cur || o.observedAt > cur.observedAt) latest.set(o.investmentId, o)
  }
  return new Map([...latest].map(([id, o]) => [id, viewObservation(o, now)]))
}
