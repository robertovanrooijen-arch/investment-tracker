import type { Investment, InvestmentType, Transaction } from '@/types/database'
import { computeInvestmentMetrics } from '@/lib/domain/calculations'
import type { FxRates } from '@/lib/domain/fx'
import { categoryColorHex, categoryShade, commodityKindShade } from '@/lib/colors'

// ---------------------------------------------------------------------------
// Portfolio allocation — single data-transformation layer for the Asset
// Allocation page (and anything else that needs the same
// portfolio → category → holding hierarchy). All percentages are derived
// from computeInvestmentMetrics, the same per-investment source of truth
// used by the dashboard and the holdings list, so numbers never drift.
// ---------------------------------------------------------------------------

export type AllocationHolding = {
  /** Economic identifier ('ticker:X' / 'name:X' for normal holdings, or the commodity kind for metals) — stable even when multiple Investment rows are merged into one row here. */
  id: string
  name: string
  ticker: string | null
  value: number
  /** Share of this holding's own category (0–1). */
  categoryPct: number
  /** Share of the whole portfolio (0–1). */
  portfolioPct: number
  color: string
  /** Only set on the flattened, all-categories `PortfolioAllocation.holdings` list. */
  categoryLabel?: string
}

export type AllocationCategory = {
  type: InvestmentType
  /** URL-safe key, e.g. 'ETF' -> 'etf', 'real estate' -> 'real-estate'. */
  slug: string
  label: string
  value: number
  portfolioPct: number
  color: string
  holdings: AllocationHolding[]
}

export type PortfolioAllocation = {
  totalValue: number
  categories: AllocationCategory[]
  /** Every holding across every category, flattened and sorted largest-first. */
  holdings: AllocationHolding[]
}

const CATEGORY_LABELS: Record<InvestmentType, string> = {
  stock: 'Stocks',
  ETF: 'ETFs',
  crypto: 'Crypto',
  commodity: 'Commodities',
  cash: 'Cash',
  'real estate': 'Real Estate',
  custom: 'Custom',
}

export function categorySlug(type: InvestmentType | string): string {
  return type.toLowerCase().replace(/\s+/g, '-')
}

export function categoryLabel(type: InvestmentType): string {
  return CATEGORY_LABELS[type] ?? type
}

function safeShare(value: number, total: number): number {
  return total > 0 ? value / total : 0
}

function buildCommodityHoldings(
  rows: { inv: Investment; value: number }[],
  categoryValue: number,
  totalValue: number,
): AllocationHolding[] {
  const byKind = new Map<string, { value: number; label: string }>()

  for (const { inv, value } of rows) {
    const kind = inv.commodity_kind
    const key = kind ?? 'other'
    const label = kind === 'gold' ? 'Gold' : kind === 'silver' ? 'Silver' : inv.name
    const entry = byKind.get(key)
    if (entry) {
      entry.value += value
    } else {
      byKind.set(key, { value, label })
    }
  }

  return [...byKind.entries()]
    .sort((a, b) => b[1].value - a[1].value)
    .map(([key, entry], index) => ({
      id: key,
      name: entry.label,
      ticker: null,
      value: entry.value,
      categoryPct: safeShare(entry.value, categoryValue),
      portfolioPct: safeShare(entry.value, totalValue),
      color: commodityKindShade(key === 'gold' || key === 'silver' ? key : null, index),
    }))
}

/**
 * Groups by ticker (or by name when a ticker isn't set) so the same
 * instrument held across multiple Investment rows — e.g. the same ETF
 * bought on two different platforms, or a duplicate manual entry — shows up
 * as one economic-exposure row here. The Investments page still lists every
 * underlying record separately; this only affects the allocation hierarchy.
 */
function economicIdentifier(entity: { ticker: string | null; name: string }): string {
  const ticker = entity.ticker?.trim()
  return ticker ? `ticker:${ticker.toUpperCase()}` : `name:${entity.name.trim().toUpperCase()}`
}

function dedupeByEconomicIdentifier(
  rows: { inv: Investment; value: number }[],
): { name: string; ticker: string | null; value: number }[] {
  const groups = new Map<string, { name: string; ticker: string | null; value: number; maxValue: number }>()

  for (const { inv, value } of rows) {
    const key = economicIdentifier(inv)
    const group = groups.get(key)
    if (!group) {
      groups.set(key, { name: inv.name, ticker: inv.ticker, value, maxValue: value })
      continue
    }
    group.value += value
    // Label the merged row after whichever contributing record carries the
    // most value, so a stray small/placeholder entry never wins the name.
    if (value > group.maxValue) {
      group.maxValue = value
      group.name = inv.name
      group.ticker = inv.ticker
    }
  }

  return [...groups.values()]
}

function buildStandardHoldings(
  type: InvestmentType,
  rows: { inv: Investment; value: number }[],
  categoryValue: number,
  totalValue: number,
): AllocationHolding[] {
  return dedupeByEconomicIdentifier(rows)
    .sort((a, b) => b.value - a.value)
    .map(({ name, ticker, value }, index) => ({
      id: economicIdentifier({ ticker, name }),
      name,
      ticker,
      value,
      categoryPct: safeShare(value, categoryValue),
      portfolioPct: safeShare(value, totalValue),
      color: categoryShade(type, index),
    }))
}

export function buildPortfolioAllocation(
  investments: Investment[],
  transactions: Transaction[],
  fxRates?: FxRates,
): PortfolioAllocation {
  const rowsByType = new Map<InvestmentType, { inv: Investment; value: number }[]>()
  let totalValue = 0

  for (const inv of investments) {
    const { currentValue } = computeInvestmentMetrics(inv, transactions, fxRates)
    if (currentValue <= 0) continue

    const bucket = rowsByType.get(inv.type)
    if (bucket) bucket.push({ inv, value: currentValue })
    else rowsByType.set(inv.type, [{ inv, value: currentValue }])

    totalValue += currentValue
  }

  const categories: AllocationCategory[] = []
  for (const [type, rows] of rowsByType) {
    const categoryValue = rows.reduce((sum, r) => sum + r.value, 0)
    const holdings =
      type === 'commodity'
        ? buildCommodityHoldings(rows, categoryValue, totalValue)
        : buildStandardHoldings(type, rows, categoryValue, totalValue)

    categories.push({
      type,
      slug: categorySlug(type),
      label: categoryLabel(type),
      value: categoryValue,
      portfolioPct: safeShare(categoryValue, totalValue),
      color: categoryColorHex(type),
      holdings,
    })
  }

  categories.sort((a, b) => b.value - a.value)

  const holdings = categories
    .flatMap((c) => c.holdings.map((h) => ({ ...h, categoryLabel: c.label })))
    .sort((a, b) => b.value - a.value)

  return { totalValue, categories, holdings }
}

/**
 * Caps a slice list at `max` entries for chart display, folding the smallest
 * remainder into a single "Other" slice. Never drops data from tables/lists —
 * callers that need the full set should use the un-capped array directly.
 */
export function topSlicesWithOther<T extends { value: number }>(
  items: T[],
  max: number,
  makeOther: (value: number, count: number) => T,
): T[] {
  if (items.length <= max) return items
  const sorted = [...items].sort((a, b) => b.value - a.value)
  const head = sorted.slice(0, max - 1)
  const rest = sorted.slice(max - 1)
  const otherValue = rest.reduce((sum, r) => sum + r.value, 0)
  return [...head, makeOther(otherValue, rest.length)]
}
