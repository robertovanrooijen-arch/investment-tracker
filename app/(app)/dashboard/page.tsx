import Link from 'next/link'
import { createClient } from '@/lib/supabase/server'
import { PageHeader } from '@/components/ui/page-header'
import { StatCard } from '@/components/ui/stat-card'
import { AllocationBreakdown } from '@/components/dashboard/allocation-breakdown'
import { RecentTransactions } from '@/components/dashboard/recent-transactions'
import { money } from '@/lib/format'
import {
  computePortfolioMetrics,
  computeAllocation,
  pct,
} from '@/lib/domain/calculations'
import { categoryColor, platformColor } from '@/lib/colors'
import type { Investment, Transaction, InvestmentType } from '@/types/database'

type TxWithInvestment = Transaction & {
  investment: {
    name: string
    ticker: string | null
    type: InvestmentType
  } | null
}

export default async function DashboardPage() {
  const supabase = await createClient()

  const [invRes, txRes, recentRes] = await Promise.all([
    supabase.from('investments').select('*').returns<Investment[]>(),
    supabase.from('transactions').select('*').returns<Transaction[]>(),
    supabase
      .from('transactions')
      .select('*, investment:investments(name, ticker, type)')
      .order('date', { ascending: false })
      .order('created_at', { ascending: false })
      .limit(5)
      .returns<TxWithInvestment[]>(),
  ])

  const investments = invRes.data ?? []
  const transactions = txRes.data ?? []
  const recent = recentRes.data ?? []

  const metrics = computePortfolioMetrics(investments, transactions)
  const byCategory = computeAllocation(
    investments,
    transactions,
    (i) => i.type
  )
  const byPlatform = computeAllocation(
    investments,
    transactions,
    (i) => i.platform
  )

  const profitTone: 'positive' | 'negative' | 'neutral' =
    metrics.totalProfit > 0
      ? 'positive'
      : metrics.totalProfit < 0
      ? 'negative'
      : 'neutral'

  const isEmpty = investments.length === 0
  const hasHistory = metrics.totalEverInvested > 0

  return (
    <div className="space-y-6">
      <PageHeader
        title="Dashboard"
        subtitle="An overview of your entire portfolio."
      />

      {isEmpty ? (
        <div className="bg-white rounded-2xl border border-slate-200 p-10 text-center">
          <p className="text-slate-900 font-medium">Welcome!</p>
          <p className="text-sm text-slate-500 mt-1">
            Add your first investment to start tracking your portfolio.
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
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
            <StatCard
              label="Portfolio value"
              value={money(metrics.totalValue)}
            />
            <StatCard
              label="Total invested"
              value={money(metrics.totalInvested)}
              hint="Money currently tied up in open positions"
            />
            <StatCard
              label="Profit / loss"
              value={hasHistory ? money(metrics.totalProfit) : '—'}
              hint={
                hasHistory
                  ? `${
                      metrics.totalProfitPct !== null
                        ? pct(metrics.totalProfitPct)
                        : '—'
                    } · ${money(metrics.totalRealized)} realized · ${money(
                      metrics.totalUnrealized
                    )} unrealized`
                  : 'Record a buy or deposit to start tracking gains'
              }
              tone={hasHistory ? profitTone : 'neutral'}
            />
          </div>

          <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
            <AllocationBreakdown
              title="By category"
              slices={byCategory}
              colorFor={categoryColor}
              emptyMessage="No value in your portfolio yet."
            />
            <AllocationBreakdown
              title="By platform"
              slices={byPlatform}
              colorFor={platformColor}
              emptyMessage="No value in your portfolio yet."
            />
          </div>

          <RecentTransactions transactions={recent} />
        </>
      )}
    </div>
  )
}