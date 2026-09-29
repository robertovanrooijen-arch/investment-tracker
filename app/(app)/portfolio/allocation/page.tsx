import Link from 'next/link'
import { createClient } from '@/lib/supabase/server'
import { PageHeader } from '@/components/ui/page-header'
import { StatCard } from '@/components/ui/stat-card'
import { AllocationPageClient } from '@/components/allocation/allocation-page-client'
import { money } from '@/lib/format'
import { pct } from '@/lib/domain/calculations'
import { buildPortfolioAllocation, categorySlug } from '@/lib/domain/allocation'
import { loadFxRates } from '@/lib/domain/fx'
import type { Investment, Transaction } from '@/types/database'

export default async function AssetAllocationPage({
  searchParams,
}: {
  searchParams: Promise<{ category?: string }>
}) {
  const { category } = await searchParams
  const supabase = await createClient()

  const [invRes, txRes, fxRes] = await Promise.all([
    supabase.from('investments').select('*').returns<Investment[]>(),
    supabase.from('transactions').select('*').returns<Transaction[]>(),
    loadFxRates(supabase),
  ])

  const investments = invRes.data ?? []
  const transactions = txRes.data ?? []
  const fxRates = fxRes.rates

  const allocation = buildPortfolioAllocation(investments, transactions, fxRates)

  const largestHolding = allocation.holdings[0] ?? null
  const largestCategory = allocation.categories[0] ?? null
  const initialCategorySlug =
    category && allocation.categories.some((c) => c.slug === categorySlug(category))
      ? categorySlug(category)
      : null

  const isEmpty = allocation.holdings.length === 0

  return (
    <div className="space-y-6">
      <div>
        <Link href="/dashboard" className="text-sm text-slate-500 hover:text-slate-700">
          ← Portfolio
        </Link>
      </div>

      <PageHeader
        title="Asset Allocation"
        subtitle="Explore how your portfolio is distributed across asset classes and individual holdings."
      />

      {isEmpty ? (
        <div className="bg-white rounded-2xl border border-slate-200 p-10 text-center">
          <p className="text-slate-900 font-medium">Nothing to show yet</p>
          <p className="text-sm text-slate-500 mt-1">
            Add an investment to see how your portfolio breaks down.
          </p>
          <Link
            href="/investments/new"
            className="mt-4 inline-flex items-center justify-center rounded-lg bg-slate-900 px-4 py-2 text-sm font-medium text-white hover:bg-slate-800"
          >
            + Add investment
          </Link>
        </div>
      ) : (
        <>
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-4">
            <StatCard label="Total portfolio value" value={money(allocation.totalValue, 'EUR')} />
            <StatCard label="Holdings" value={String(allocation.holdings.length)} />
            <StatCard
              label="Largest position"
              value={largestHolding ? money(largestHolding.value, 'EUR') : '—'}
              hint={
                largestHolding
                  ? `${largestHolding.name} · ${pct(largestHolding.portfolioPct)} of portfolio`
                  : undefined
              }
            />
            <StatCard
              label="Largest asset class"
              value={largestCategory ? largestCategory.label : '—'}
              hint={largestCategory ? `${pct(largestCategory.portfolioPct)} of portfolio` : undefined}
            />
          </div>

          <AllocationPageClient allocation={allocation} initialCategorySlug={initialCategorySlug} />
        </>
      )}
    </div>
  )
}
