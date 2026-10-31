import Link from 'next/link'
import { createClient } from '@/lib/supabase/server'
import { PageHeader } from '@/components/ui/page-header'
import { StatCard } from '@/components/ui/stat-card'
import { BrokerCashNote } from '@/components/ui/broker-cash-note'
import { AllocationPageClient } from '@/components/allocation/allocation-page-client'
import { PrivacyMoney, PrivacyGate } from '@/components/ui/privacy-value'
import { pct } from '@/lib/domain/calculations'
import { buildAllocationFromValuation, categorySlug } from '@/lib/domain/allocation'
import { loadPortfolioState } from '@/lib/returns/load-returns'
import { todayLocalIso } from '@/lib/domain/snapshot'

export default async function AssetAllocationPage({
  searchParams,
}: {
  searchParams: Promise<{ category?: string }>
}) {
  const { category } = await searchParams
  const supabase = await createClient()

  // The central current valuation: exactly the values of Dashboard and Returns.
  const { investments, valuation } = await loadPortfolioState(supabase, todayLocalIso())
  const allocation = buildAllocationFromValuation(investments, valuation)

  const largestHolding = allocation.holdings[0] ?? null
  const largestCategory = allocation.categories[0] ?? null
  const initialCategorySlug =
    category && allocation.categories.some((c) => c.slug === categorySlug(category))
      ? categorySlug(category)
      : null

  // An allocation withheld because of missing FX is not "empty" — the notice explains it.
  const isEmpty = allocation.holdings.length === 0 && valuation.status === 'ok'

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

      {valuation.status !== 'ok' && (
        <p className="rounded-xl border border-rose-200 bg-rose-50 px-4 py-3 text-sm text-rose-900">
          — The allocation is not shown: {valuation.gaps[0]?.reason ?? 'the current value is incomplete'}
        </p>
      )}

      {valuation.status !== 'ok' ? null : isEmpty ? (
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
            <StatCard
              label="Total portfolio value"
              value={<PrivacyMoney value={valuation.totalEur} fallbackText="—" />}
              hint={<>Same as Dashboard · <BrokerCashNote cash={valuation.brokerCash} /></>}
            />
            <StatCard label="Holdings" value={String(allocation.holdings.length)} />
            <StatCard
              label="Largest position"
              value={
                largestHolding ? (
                  <PrivacyMoney value={largestHolding.value} fallbackText={largestHolding.name} />
                ) : (
                  '—'
                )
              }
              hint={
                largestHolding ? (
                  <PrivacyGate fallback={<>{pct(largestHolding.portfolioPct)} of portfolio</>}>
                    <>
                      {largestHolding.name} · {pct(largestHolding.portfolioPct)} of portfolio
                    </>
                  </PrivacyGate>
                ) : undefined
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
