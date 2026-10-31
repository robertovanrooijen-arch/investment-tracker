import type { Investment, Transaction } from '@/types/database'
import { quantityOn, valuePosition, type FxSeries, type PriceSeries } from '@/lib/valuation/historical-valuation'

// ---------------------------------------------------------------------------
// Dealer metals (gold/silver at Holland Gold, GoldRepublic, ...) are valued
// on the DEALER's basis, not on COMEX: an official dealer statement or an
// owner-reported dealer value is the anchor, and between anchors the value
// follows the relative move of the COMEX benchmark:
//
//     value(d) = benchmark value(d) × k,   k = dealer value ÷ benchmark value
//                                              on the anchor date
//
// Which factor applies when (documented, never open-ended in the past):
//   * the factor of an anchor applies from that anchor until the next one;
//   * before the first anchor the first anchor's factor applies (so the
//     dealer-vs-COMEX difference never shows up as a fake return on the
//     anchor date itself);
//   * at every later anchor the series is re-based on the new dealer value;
//     that step is a valuation_basis_adjustment, never a result.
// A metal without any dealer anchor is on the plain benchmark ('estimated').
// The dealer-vs-COMEX difference is therefore never market performance.
// ---------------------------------------------------------------------------

export type DealerAnchor = {
  investmentId: string
  date: string // valuation date (close)
  valueEur: number
  quantity: number | null
  source: string
  kind: 'official_statement' | 'owner_observation'
}

export type DealerFactor = DealerAnchor & { factor: number; benchmarkEur: number }

/** The usable anchors of one metal, oldest first, with their factor. Unusable ones are explained. */
export function dealerFactors(
  inv: Investment,
  transactions: Transaction[],
  anchors: DealerAnchor[],
  prices: Map<string, PriceSeries>,
  fx: FxSeries
): { factors: DealerFactor[]; notes: string[] } {
  const notes: string[] = []
  const factors: DealerFactor[] = []
  for (const a of anchors.filter((x) => x.investmentId === inv.id).sort((x, y) => (x.date < y.date ? -1 : 1))) {
    const q = quantityOn(inv, transactions, a.date)
    if (a.quantity != null && Math.abs(a.quantity - q) > 1e-6) {
      notes.push(`${inv.platform} ${inv.name}: dealer value of ${a.date} is for ${a.quantity}, the books hold ${q}; not used.`)
      continue
    }
    const v = valuePosition(inv, transactions, a.date, prices, fx)
    const benchmark = v.valueEur ?? v.benchmarkValueEur
    if (!benchmark || !(benchmark > 0)) {
      notes.push(`${inv.platform} ${inv.name}: no benchmark value on ${a.date} to anchor the dealer value.`)
      continue
    }
    factors.push({ ...a, factor: a.valueEur / benchmark, benchmarkEur: benchmark })
  }
  return { factors, notes }
}

/** The factor that applies on `date` (see header); undefined without anchors. */
export function dealerFactorOn(factors: DealerFactor[], date: string): DealerFactor | undefined {
  if (!factors.length) return undefined
  let current: DealerFactor = factors[0]
  for (const f of factors) if (f.date <= date) current = f
  return current
}
