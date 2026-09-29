'use client'

import { useEffect, useState } from 'react'
import { money } from '@/lib/format'
import { pct } from '@/lib/domain/calculations'
import { topSlicesWithOther } from '@/lib/domain/allocation'
import type { AllocationCategory } from '@/lib/domain/allocation'
import { AllocationDonutChart } from './allocation-donut-chart'
import type { DonutItem } from './allocation-donut-chart'
import { AllocationHoldingsList } from './allocation-holdings-list'
import type { HoldingListItem } from './allocation-holdings-list'

const CHART_MAX_SLICES = 8
const OTHER_COLOR = '#cbd5e1' // slate-300

type Props = {
  category: AllocationCategory
  /** True right after arriving via ?category=<slug> — briefly accents the card and scrolls it into view. */
  highlighted?: boolean
}

export function AllocationCategoryCard({ category, highlighted = false }: Props) {
  const [hoveredKey, setHoveredKey] = useState<string | null>(null)
  const [selectedKey, setSelectedKey] = useState<string | null>(null)
  const [flash, setFlash] = useState(highlighted)

  useEffect(() => {
    if (!highlighted) return
    const el = document.getElementById(`allocation-category-${category.slug}`)
    el?.scrollIntoView({ behavior: 'smooth', block: 'start' })
    const timer = setTimeout(() => setFlash(false), 2200)
    return () => clearTimeout(timer)
    // Only run once on mount for the initially-highlighted card.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const chartItems: DonutItem[] = topSlicesWithOther<DonutItem>(
    category.holdings.map((h) => ({
      key: h.id,
      name: h.name,
      value: h.value,
      contextPct: h.categoryPct,
      portfolioPct: h.portfolioPct,
      color: h.color,
    })),
    CHART_MAX_SLICES,
    (value, count) => ({
      key: 'other',
      name: `Other (${count})`,
      value,
      contextPct: category.value > 0 ? value / category.value : 0,
      portfolioPct: undefined,
      color: OTHER_COLOR,
      selectable: false,
    }),
  )

  const listItems: HoldingListItem[] = category.holdings.map((h) => ({
    key: h.id,
    name: h.name,
    ticker: h.ticker,
    value: h.value,
    contextPct: h.categoryPct,
    portfolioPct: h.portfolioPct,
    color: h.color,
  }))

  return (
    <div
      id={`allocation-category-${category.slug}`}
      className={`bg-white rounded-2xl border p-5 md:p-6 transition-colors duration-700 scroll-mt-6 ${
        flash ? 'border-slate-900 ring-2 ring-slate-900/10' : 'border-slate-200'
      }`}
    >
      <div className="flex items-start justify-between gap-4 mb-4">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <span
              className="inline-block h-2.5 w-2.5 shrink-0 rounded-full"
              style={{ backgroundColor: category.color }}
            />
            <h3 className="text-base font-semibold text-slate-900">{category.label}</h3>
          </div>
          <p className="mt-1 text-sm text-slate-500">
            {category.holdings.length} {category.holdings.length === 1 ? 'holding' : 'holdings'}
          </p>
        </div>
        <div className="text-right shrink-0">
          <div className="text-lg font-semibold text-slate-900 tabular-nums">
            {money(category.value)}
          </div>
          <div className="text-sm text-slate-500 tabular-nums">
            {pct(category.portfolioPct)} of portfolio
          </div>
        </div>
      </div>

      <div className="flex justify-center mb-6">
        <AllocationDonutChart
          items={chartItems}
          contextLabel={category.label}
          size={170}
          ariaLabel={`${category.label} breakdown by holding`}
          hoveredKey={hoveredKey}
          selectedKey={selectedKey}
          onHoverKey={setHoveredKey}
          onSelectKey={(key) => setSelectedKey((prev) => (prev === key ? null : key))}
          centerLabel={{ primary: pct(category.portfolioPct), secondary: 'of portfolio' }}
        />
      </div>

      <div className="border-t border-slate-100 pt-1">
        <AllocationHoldingsList
          items={listItems}
          contextLabel={category.label}
          layout="stacked"
          hoveredKey={hoveredKey}
          selectedKey={selectedKey}
          onHoverKey={setHoveredKey}
          onSelectKey={(key) => setSelectedKey((prev) => (prev === key ? null : key))}
          emptyMessage="No holdings in this category yet."
        />
      </div>
    </div>
  )
}
