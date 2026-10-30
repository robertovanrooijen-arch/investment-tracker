import Link from 'next/link'
import { createClient } from '@/lib/supabase/server'
import { fetchAllInvestments, fetchAllTransactions } from '@/lib/supabase/fetch-user-data'
import { PageHeader } from '@/components/ui/page-header'
import { DataQualityNotice } from '@/components/ui/data-quality-notice'
import { unfundedPlatforms } from '@/lib/domain/reconciliation'
import { StatCard } from '@/components/ui/stat-card'
import { PortfolioBreakdownCharts } from '@/components/history/portfolio-breakdown-charts'
import { RecentTransactions } from '@/components/dashboard/recent-transactions'
import { RefreshPortfolioButton } from '@/components/dashboard/refresh-portfolio-button'
import { PrivacyMoney, PrivacyValue, PrivacyGate } from '@/components/ui/privacy-value'
import { money } from '@/lib/format'
import {
  computePortfolioMetrics,
  computeAllocation,
  pct,
} from '@/lib/domain/calculations'
import { loadFxRates } from '@/lib/domain/fx'
import { normalizePlatformName } from '@/lib/domain/constants'
import { todayLocalIso, computeDailyChange, type DailyChange } from '@/lib/domain/snapshot'
import type { Transaction, InvestmentType, CapitalFlowEntry } from '@/types/database'
import { fetchAllRows } from '@/lib/supabase/fetch-all-rows'
import { buildExternalCashFlowRows, externalFlowsForReturns } from '@/lib/domain/contributions'
import { allTimeMoneyWeightedReturn } from '@/lib/domain/returns'

type TxWithInvestment = Transaction & {
  investment: {
    name: string
    ticker: string | null
    type: InvestmentType
  } | null
}

function dailyChangeText(change: DailyChange): string {
  if (!change) return 'No previous snapshot yet'
  const sign = change.value > 0 ? '+' : ''
  const pctText =
    change.percent !== null
      ? ` (${change.percent > 0 ? '+' : ''}${change.percent.toFixed(2)}%)`
      : ''
  return `Today: ${sign}${money(change.value, 'EUR')}${pctText}`
}

function dailyChangePrivacyText(change: DailyChange): string {
  if (!change) return 'No previous snapshot yet'
  if (change.percent === null) return '—'
  return `Today: ${change.percent > 0 ? '+' : ''}${change.percent.toFixed(2)}%`
}

function dailyChangeClass(change: DailyChange): string {
  if (!change) return 'text-slate-400'
  if (change.value > 0) return 'text-emerald-600'
  if (change.value < 0) return 'text-rose-600'
  return 'text-slate-500'
}

export default async function DashboardPage() {
  const supabase = await createClient()

  const todayIso = todayLocalIso()

  const [invRes, txRes, recentRes, fxRes, latestSnapRes, prevSnapRes, flowRes] = await Promise.all([
    fetchAllInvestments(supabase),
    fetchAllTransactions(supabase),
    supabase
      .from('transactions')
      .select('*, investment:investments(name, ticker, type)')
      .order('date', { ascending: false })
      .order('created_at', { ascending: false })
      .limit(5)
      .returns<TxWithInvestment[]>(),
    loadFxRates(supabase),
    supabase
      .from('portfolio_snapshots')
      .select('updated_at')
      .order('date', { ascending: false })
      .limit(1)
      .maybeSingle(),
    supabase
      .from('portfolio_snapshots')
      .select('total_value_eur')
      .lt('date', todayIso)
      .order('date', { ascending: false })
      .limit(1)
      .maybeSingle(),
    fetchAllRows<CapitalFlowEntry>((from, to) =>
      supabase.from('capital_flow_entries').select('*').order('id', { ascending: true }).range(from, to).returns<CapitalFlowEntry[]>()
    ),
  ])

  const investments = invRes.data ?? []
  const transactions = txRes.data ?? []
  const recent = recentRes.data ?? []
  const fxRates = fxRes.rates
  const latestSnap = latestSnapRes.data as { updated_at: string } | null
  const lastRefreshedAt = latestSnap?.updated_at ?? null
  const previousSnap = prevSnapRes.data as { total_value_eur: number } | null

  const metrics = computePortfolioMetrics(investments, transactions, fxRates)
  // All-time money-weighted return (XIRR) on EXTERNAL flows only.
  const externalFlows = buildExternalCashFlowRows(flowRes.data ?? [], transactions)
  const mwr = allTimeMoneyWeightedReturn(externalFlowsForReturns(externalFlows), metrics.totalValue, todayIso)
  const dailyChange: DailyChange = computeDailyChange(metrics.totalValue, previousSnap)

  const byCategory = computeAllocation(
    investments,
    transactions,
    (i) => i.type,
    fxRates,
  )

  const byPlatform = computeAllocation(
    investments,
    transactions,
    (i) => normalizePlatformName(i.platform),
    fxRates,
  )

  const profitTone: 'positive' | 'negative' | 'neutral' =
    metrics.totalProfit > 0
      ? 'positive'
      : metrics.totalProfit < 0
        ? 'negative'
        : 'neutral'

  const isEmpty    = investments.length === 0
  const hasHistory = metrics.totalEverInvested > 0

  return (
    <div className="space-y-6">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <PageHeader
          title="Dashboard"
          subtitle="An overview of your entire portfolio in EUR."
        />

        <div className="flex flex-col items-start gap-2 sm:items-end">
          <RefreshPortfolioButton lastRefreshedAt={lastRefreshedAt} />
        </div>
      </div>

      <DataQualityNotice
        fxIncompleteCount={metrics.fxIncompleteCount}
        fxLiveFallbackCount={metrics.fxLiveFallbackCount}
        unfundedPlatforms={unfundedPlatforms(investments, transactions, flowRes.data ?? [], fxRates)}
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
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
            <StatCard
              label="Portfolio value"
              value={<PrivacyMoney value={metrics.totalValue} fallbackText="—" />}
              hint={
                <>
                  Converted to EUR
                  <br />
                  <span className={dailyChangeClass(dailyChange)}>
                    <PrivacyValue
                      amount={dailyChangeText(dailyChange)}
                      privacyFallback={dailyChangePrivacyText(dailyChange)}
                    />
                  </span>
                </>
              }
            />
            <StatCard
              label="Total invested"
              value={<PrivacyMoney value={metrics.totalInvested} fallbackText="—" />}
              hint="Cost basis converted to EUR"
            />
            <StatCard
              label="Profit / loss"
              value={
                hasHistory ? (
                  <PrivacyMoney
                    value={metrics.totalProfit}
                    signed
                    fallbackText="—"
                  />
                ) : (
                  '—'
                )
              }
              hint={
                hasHistory ? (
                  <>
                    <PrivacyGate>
                      <>
                        {money(metrics.totalRealized, 'EUR')} realized ·{' '}
                        {money(metrics.totalUnrealized, 'EUR')} unrealized
                      </>
                    </PrivacyGate>
                    <br />
                    <span className="text-slate-400">
                      All-time cost-basis P/L since each position was opened. Cash excluded.
                    </span>
                  </>
                ) : (
                  'Record a buy or deposit to start tracking gains'
                )
              }
              tone={hasHistory ? profitTone : 'neutral'}
            />
            <StatCard
              label="Money-weighted return (XIRR, secondary)"
              value={mwr.annualRate !== null ? `${mwr.annualRate >= 0 ? '+' : ''}${pct(mwr.annualRate)} / yr` : '—'}
              hint={
                <>
                  Depends on when and how much you added. For how your investments did, see{' '}
                  <Link href="/returns" className="underline">Returns (time-weighted)</Link>.
                  <br />
                  <PrivacyGate fallback="Money-weighted, annualised.">
                    <>
                      Money-weighted, annualised: your {money(mwr.grossInEur, 'EUR')} deposits and{' '}
                      {money(mwr.grossOutEur, 'EUR')} withdrawals (on their real dates) against today&apos;s value.
                    </>
                  </PrivacyGate>
                  {mwr.unavailableReason && (
                    <>
                      <br />
                      <span className="text-amber-700">{mwr.unavailableReason}</span>
                    </>
                  )}
                </>
              }
              tone={mwr.annualRate === null ? 'neutral' : mwr.annualRate >= 0 ? 'positive' : 'negative'}
            />
          </div>
          <p className="text-xs text-slate-400 px-1">
            Cash balances are included in portfolio value but excluded from investment P/L.
          </p>

          <PortfolioBreakdownCharts
            byCategory={byCategory}
            byPlatform={byPlatform}
            liveMetrics={metrics}
          />

          <RecentTransactions transactions={recent} />
        </>
      )}
    </div>
  )
}
