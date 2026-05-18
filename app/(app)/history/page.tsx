import { createClient } from '@/lib/supabase/server'
import { PageHeader } from '@/components/ui/page-header'
import { PortfolioHistoryChart } from '@/components/history/portfolio-history-chart'
import type { InvestmentType } from '@/types/database'

export const dynamic = 'force-dynamic'

type PortfolioSnapshotRow = {
  date: string
  total_value_eur: number
}

type InvSnapshotRow = {
  date: string
  value_eur: number
  remaining_cost_basis_eur: number
  investment: { type: InvestmentType } | null
}

export default async function HistoryPage() {
  const supabase = await createClient()

  const [portfolioRes, invSnapshotRes] = await Promise.all([
    supabase
      .from('portfolio_snapshots')
      .select('date, total_value_eur')
      .order('date', { ascending: true }),
    supabase
      .from('investment_snapshots')
      .select('date, value_eur, remaining_cost_basis_eur, investment:investments(type)')
      .order('date', { ascending: true })
      .returns<InvSnapshotRow[]>(),
  ])

  // Postgres `numeric` columns can come back as strings via supabase-js; coerce.
  const portfolioSnapshots: PortfolioSnapshotRow[] = (portfolioRes.data ?? []).map(
    (row) => ({
      date: String(row.date),
      total_value_eur: Number(row.total_value_eur),
    }),
  )

  const invSnapshots = (invSnapshotRes.data ?? [])
    .filter((row) => row.investment?.type != null)
    .map((row) => ({
      date: String(row.date),
      value_eur: Number(row.value_eur),
      remaining_cost_basis_eur: Number(row.remaining_cost_basis_eur),
      type: row.investment!.type,
    }))

  return (
    <div className="space-y-6">
      <PageHeader
        title="Portfolio history"
        subtitle="How your portfolio value has changed over time, in EUR."
      />
      <PortfolioHistoryChart
        portfolioSnapshots={portfolioSnapshots}
        invSnapshots={invSnapshots}
      />
    </div>
  )
}
