'use client'

import { useState } from 'react'
import type { PortfolioAllocation } from '@/lib/domain/allocation'
import { AllocationOverview } from './allocation-overview'
import { AllocationHoldingsView } from './allocation-holdings-view'
import { AllocationCategoryCard } from './allocation-category-card'

type View = 'categories' | 'holdings'

export function AllocationPageClient({
  allocation,
  initialCategorySlug,
}: {
  allocation: PortfolioAllocation
  initialCategorySlug: string | null
}) {
  const [view, setView] = useState<View>('categories')

  return (
    <div className="space-y-6">
      <div className="inline-flex rounded-lg border border-slate-200 bg-slate-50 p-1">
        <button
          type="button"
          onClick={() => setView('categories')}
          className={`rounded-md px-3 py-1.5 text-xs font-medium transition-colors ${
            view === 'categories'
              ? 'bg-white text-slate-900 shadow-sm'
              : 'text-slate-600 hover:text-slate-900'
          }`}
          aria-pressed={view === 'categories'}
        >
          Asset classes
        </button>
        <button
          type="button"
          onClick={() => setView('holdings')}
          className={`rounded-md px-3 py-1.5 text-xs font-medium transition-colors ${
            view === 'holdings'
              ? 'bg-white text-slate-900 shadow-sm'
              : 'text-slate-600 hover:text-slate-900'
          }`}
          aria-pressed={view === 'holdings'}
        >
          Holdings
        </button>
      </div>

      <AllocationOverview allocation={allocation} />

      {view === 'categories' ? (
        <div className="space-y-4">
          <h2 className="text-base font-semibold text-slate-900 px-1">Portfolio breakdown</h2>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4 items-start">
            {allocation.categories.map((category) => (
              <AllocationCategoryCard
                key={category.slug}
                category={category}
                highlighted={category.slug === initialCategorySlug}
              />
            ))}
          </div>
        </div>
      ) : (
        <AllocationHoldingsView allocation={allocation} />
      )}
    </div>
  )
}
