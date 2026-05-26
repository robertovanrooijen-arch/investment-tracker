import { createClient } from '@/lib/supabase/server'
import { PageHeader } from '@/components/ui/page-header'
import { ProjectionCalculator } from '@/components/tools/projection-calculator'
import { computePortfolioMetrics } from '@/lib/domain/calculations'
import { loadFxRates } from '@/lib/domain/fx'
import type { Investment, Transaction } from '@/types/database'

export const dynamic = 'force-dynamic'

export default async function ProjectionPage() {
  const supabase = await createClient()

  const [invRes, txRes, fxRes] = await Promise.all([
    supabase.from('investments').select('*').returns<Investment[]>(),
    supabase.from('transactions').select('*').returns<Transaction[]>(),
    loadFxRates(supabase),
  ])

  const metrics = computePortfolioMetrics(
    invRes.data ?? [],
    txRes.data ?? [],
    fxRes.rates,
  )

  return (
    <div className="space-y-6">
      <PageHeader
        title="Projection"
        subtitle="Estimate what your portfolio could be worth in the future."
      />
      <ProjectionCalculator currentPortfolioValue={metrics.totalValue} />
    </div>
  )
}
