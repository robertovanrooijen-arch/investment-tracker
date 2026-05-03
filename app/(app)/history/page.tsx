import { createClient } from '@/lib/supabase/server'
import { PageHeader } from '@/components/ui/page-header'
import { PortfolioHistoryChart } from '@/components/history/portfolio-history-chart'

export const dynamic = 'force-dynamic'

type SnapshotRow = {
  date: string
  total_value_eur: number
}

export default async function HistoryPage() {
  const supabase = await createClient()

  const { data } = await supabase
    .from('portfolio_snapshots')
    .select('date, total_value_eur')
    .order('date', { ascending: true })

  // Postgres `numeric` columns can come back as strings via supabase-js; coerce defensively.
  const snapshots: SnapshotRow[] = (data ?? []).map((row) => ({
    date: String(row.date),
    total_value_eur: Number(row.total_value_eur),
  }))

  return (
    <div className="space-y-6">
      <PageHeader
        title="Portfolio history"
        subtitle="How your portfolio value has changed over time, in EUR."
      />
      <PortfolioHistoryChart snapshots={snapshots} />
    </div>
  )
}