'use client'

import { useState } from 'react'
import { money } from '@/lib/format'
import { pct } from '@/lib/domain/calculations'
import type { PortfolioAllocation } from '@/lib/domain/allocation'
import { AllocationDonutChart } from './allocation-donut-chart'
import type { DonutItem } from './allocation-donut-chart'
import { AllocationHoldingsList } from './allocation-holdings-list'
import type { HoldingListItem } from './allocation-holdings-list'

export function AllocationOverview({ allocation }: { allocation: PortfolioAllocation }) {
  const [hoveredKey, setHoveredKey] = useState<string | null>(null)

  function jumpToCategory(key: string) {
    document
      .getElementById(`allocation-category-${key}`)
      ?.scrollIntoView({ behavior: 'smooth', block: 'start' })
  }

  const chartItems: DonutItem[] = allocation.categories.map((c) => ({
    key: c.slug,
    name: c.label,
    value: c.value,
    contextPct: c.portfolioPct,
    color: c.color,
  }))

  const listItems: HoldingListItem[] = allocation.categories.map((c) => ({
    key: c.slug,
    name: c.label,
    value: c.value,
    contextPct: c.portfolioPct,
    color: c.color,
  }))

  return (
    <div className="bg-white rounded-2xl border border-slate-200 p-5 md:p-6">
      <h2 className="text-base font-semibold text-slate-900 mb-1">Total allocation</h2>
      <p className="text-sm text-slate-500 mb-4">
        Click a slice or category to jump to its breakdown below.
      </p>

      <div className="grid grid-cols-1 md:grid-cols-[280px_1fr] gap-6 items-center">
        <AllocationDonutChart
          items={chartItems}
          contextLabel="portfolio"
          size={260}
          ariaLabel="Portfolio allocation by asset class"
          hoveredKey={hoveredKey}
          onHoverKey={setHoveredKey}
          onSelectKey={jumpToCategory}
        />

        <AllocationHoldingsList
          items={listItems}
          contextLabel="portfolio"
          showPortfolioColumn={false}
          hoveredKey={hoveredKey}
          onHoverKey={setHoveredKey}
          onSelectKey={jumpToCategory}
        />
      </div>

      <div className="mt-4 pt-4 border-t border-slate-100 flex items-center justify-between text-sm">
        <span className="text-slate-500">Total</span>
        <span className="font-semibold text-slate-900 tabular-nums">
          {money(allocation.totalValue)} · {pct(1)}
        </span>
      </div>
    </div>
  )
}
