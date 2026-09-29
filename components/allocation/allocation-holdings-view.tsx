'use client'

import { useState } from 'react'
import { topSlicesWithOther } from '@/lib/domain/allocation'
import type { PortfolioAllocation } from '@/lib/domain/allocation'
import { AllocationDonutChart } from './allocation-donut-chart'
import type { DonutItem } from './allocation-donut-chart'
import { AllocationHoldingsList } from './allocation-holdings-list'
import type { HoldingListItem } from './allocation-holdings-list'

const CHART_MAX_SLICES = 10
const OTHER_COLOR = '#cbd5e1' // slate-300

/**
 * "Holdings" view toggle — every individual position across every asset
 * class, in one flat donut + largest-to-smallest list. Answers "what are my
 * biggest positions?" as opposed to "how much do I have per asset class?".
 */
export function AllocationHoldingsView({ allocation }: { allocation: PortfolioAllocation }) {
  const [hoveredKey, setHoveredKey] = useState<string | null>(null)
  const [selectedKey, setSelectedKey] = useState<string | null>(null)

  const chartItems: DonutItem[] = topSlicesWithOther<DonutItem>(
    allocation.holdings.map((h) => ({
      key: h.id,
      name: h.name,
      value: h.value,
      contextPct: h.portfolioPct,
      color: h.color,
    })),
    CHART_MAX_SLICES,
    (value, count) => ({
      key: 'other',
      name: `Other (${count})`,
      value,
      contextPct: allocation.totalValue > 0 ? value / allocation.totalValue : 0,
      color: OTHER_COLOR,
      selectable: false,
    }),
  )

  const listItems: HoldingListItem[] = allocation.holdings.map((h) => ({
    key: h.id,
    name: h.name,
    ticker: h.ticker,
    category: h.categoryLabel,
    value: h.value,
    contextPct: h.portfolioPct,
    color: h.color,
  }))

  return (
    <div className="bg-white rounded-2xl border border-slate-200 p-5 md:p-6">
      <h2 className="text-base font-semibold text-slate-900 mb-1">All holdings</h2>
      <p className="text-sm text-slate-500 mb-4">
        Every position, largest to smallest, regardless of asset class.
      </p>

      <div className="grid grid-cols-1 md:grid-cols-[260px_1fr] gap-6 items-start">
        <AllocationDonutChart
          items={chartItems}
          contextLabel="portfolio"
          size={240}
          ariaLabel="All holdings by value"
          hoveredKey={hoveredKey}
          selectedKey={selectedKey}
          onHoverKey={setHoveredKey}
          onSelectKey={(key) => setSelectedKey((prev) => (prev === key ? null : key))}
        />

        <AllocationHoldingsList
          items={listItems}
          contextLabel="portfolio"
          layout="table"
          showPortfolioColumn={false}
          showCategoryColumn
          hoveredKey={hoveredKey}
          selectedKey={selectedKey}
          onHoverKey={setHoveredKey}
          onSelectKey={(key) => setSelectedKey((prev) => (prev === key ? null : key))}
          emptyMessage="No holdings yet."
        />
      </div>
    </div>
  )
}
