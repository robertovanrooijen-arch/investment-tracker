import { createClient } from '@/lib/supabase/server'
import { PageHeader } from '@/components/ui/page-header'
import { StatCard } from '@/components/ui/stat-card'
import { PortfolioHistoryChart } from '@/components/history/portfolio-history-chart'
import {
  computePortfolioMetrics,
  computeInvestmentMetrics,
  pct,
} from '@/lib/domain/calculations'
import { loadFxRates } from '@/lib/domain/fx'
import { money } from '@/lib/format'
import type { Investment, Transaction, InvestmentType } from '@/types/database'
import type { LivePoint } from '@/components/history/portfolio-history-chart'

export const dynamic = 'force-dynamic'

type PortfolioSnapshotRow = {
  date: string
  total_value_eur: number
  total_invested_eur: number
  total_unrealized_eur: number
  total_realized_eur: number
  snapshot_source: string
}

type InvSnapshotRow = {
  date: string
  value_eur: number
  remaining_cost_basis_eur: number
  investment: { type: InvestmentType } | null
}

export default async function HistoryPage() {
  const supabase = await createClient()

  const todayIso = new Date().toISOString().slice(0, 10)

  const [portfolioRes, invSnapshotRes, invRes, txRes, fxRes] = await Promise.all([
    supabase
      .from('portfolio_snapshots')
      .select('date, total_value_eur, total_invested_eur, total_unrealized_eur, total_realized_eur, snapshot_source')
      .order('date', { ascending: true }),
    supabase
      .from('investment_snapshots')
      .select('date, value_eur, remaining_cost_basis_eur, investment:investments(type)')
      .order('date', { ascending: true })
      .returns<InvSnapshotRow[]>(),
    supabase.from('investments').select('*').returns<Investment[]>(),
    supabase.from('transactions').select('*').returns<Transaction[]>(),
    loadFxRates(supabase),
  ])

  // Postgres `numeric` columns can come back as strings via supabase-js; coerce.
  const rawPortfolioSnapshots: PortfolioSnapshotRow[] = (portfolioRes.data ?? []).map(
    (row) => ({
      date: String(row.date),
      total_value_eur: Number(row.total_value_eur),
      total_invested_eur: Number(row.total_invested_eur),
      total_unrealized_eur: Number(row.total_unrealized_eur),
      total_realized_eur: Number(row.total_realized_eur ?? 0),
      snapshot_source: String(row.snapshot_source ?? ''),
    }),
  )

  const rawInvSnapshots = (invSnapshotRes.data ?? [])
    .filter((row) => row.investment?.type != null)
    .map((row) => ({
      date: String(row.date),
      value_eur: Number(row.value_eur),
      remaining_cost_basis_eur: Number(row.remaining_cost_basis_eur),
      type: row.investment!.type,
    }))

  // ── Live metrics — same computation as Dashboard ───────────────────────────
  const investments = invRes.data ?? []
  const transactions = txRes.data ?? []
  const fxRates = fxRes.rates

  const liveMetrics = computePortfolioMetrics(investments, transactions, fxRates)

  // Build per-type value map for the live point type breakdown lines
  const byTypeMap = new Map<string, number>()
  for (const inv of investments) {
    const m = computeInvestmentMetrics(inv, transactions, fxRates)
    if (!m.isClosed || m.currentValue > 0) {
      byTypeMap.set(inv.type, (byTypeMap.get(inv.type) ?? 0) + m.currentValue)
    }
  }

  // Today's live data point — overrides any stale snapshot for today's date
  const livePoint: LivePoint = {
    date: todayIso,
    totalValue: liveMetrics.totalValue,
    totalInvested: liveMetrics.totalInvested,
    totalUnrealized: liveMetrics.totalUnrealized,
    totalRealized: liveMetrics.totalRealized,
    byType: Array.from(byTypeMap.entries()).map(([type, value]) => ({
      type: type as InvestmentType,
      value,
    })),
  }

  // Inject today as a live snapshot; replace any stale existing entry
  const todaySnap: PortfolioSnapshotRow = {
    date: todayIso,
    total_value_eur: liveMetrics.totalValue,
    total_invested_eur: liveMetrics.totalInvested,
    total_unrealized_eur: liveMetrics.totalUnrealized,
    total_realized_eur: liveMetrics.totalRealized,
    snapshot_source: 'live',
  }

  const portfolioSnapshots: PortfolioSnapshotRow[] = [
    ...rawPortfolioSnapshots.filter((s) => s.date !== todayIso),
    todaySnap,
  ].sort((a, b) => (a.date < b.date ? -1 : 1))

  // Today's per-investment data comes from livePoint, not invSnapshots
  const invSnapshots = rawInvSnapshots.filter((s) => s.date !== todayIso)

  // ── Profit tone ────────────────────────────────────────────────────────────
  const profitTone: 'positive' | 'negative' | 'neutral' =
    liveMetrics.totalProfit > 0 ? 'positive' :
    liveMetrics.totalProfit < 0 ? 'negative' : 'neutral'

  const hasInvestments = investments.length > 0

  return (
    <div className="space-y-6">
      <PageHeader
        title="Portfolio history"
        subtitle="How your portfolio value has changed over time, in EUR."
      />

      <PortfolioHistoryChart
        portfolioSnapshots={portfolioSnapshots}
        invSnapshots={invSnapshots}
        livePoint={livePoint}
      />

      {hasInvestments && (
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
          <StatCard
            label="Portfolio value"
            value={money(liveMetrics.totalValue, 'EUR')}
            hint="Current live value in EUR"
          />
          <StatCard
            label="Total invested"
            value={money(liveMetrics.totalInvested, 'EUR')}
            hint="Cost basis in EUR"
          />
          <StatCard
            label="Profit / loss"
            value={money(liveMetrics.totalProfit, 'EUR')}
            hint={
              liveMetrics.totalEverInvested > 0
                ? `${pct(liveMetrics.totalProfitPct)} · ${money(liveMetrics.totalRealized, 'EUR')} realized · ${money(liveMetrics.totalUnrealized, 'EUR')} unrealized`
                : undefined
            }
            tone={profitTone}
          />
        </div>
      )}
    </div>
  )
}
