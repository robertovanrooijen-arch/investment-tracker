import Link from 'next/link'
import { createClient } from '@/lib/supabase/server'
import { fetchAllRows } from '@/lib/supabase/fetch-all-rows'
import { PageHeader } from '@/components/ui/page-header'
import { StatCard } from '@/components/ui/stat-card'
import { PrivacyMoney, PrivacyGate } from '@/components/ui/privacy-value'
import { AssetClassPerformanceTable } from '@/components/profit-loss/asset-class-performance-table'
import type { ClassPerformanceRow } from '@/components/profit-loss/asset-class-performance-table'
import { YtdBridgeBar } from '@/components/profit-loss/ytd-bridge-bar'
import { computePortfolioMetrics, computePerformanceByCategory, pct } from '@/lib/domain/calculations'
import type { PortfolioMetrics } from '@/lib/domain/calculations'
import { categoryLabel } from '@/lib/domain/allocation'
import { loadFxRates } from '@/lib/domain/fx'
import {
  computeAssetYearRows,
  computeAssetClassYtd,
  computeYearPortfolioSummary,
} from '@/lib/domain/year-analysis'
import type { CapitalFlowEntryForYear, InvestmentSnapshotForYtd } from '@/lib/domain/year-analysis'
import type { Investment, Transaction, InvestmentType } from '@/types/database'

export const dynamic = 'force-dynamic'

type RawInvSnapRow = {
  date: string
  investment_id: string
  value_eur: number | string
  investment: { id: string; type: InvestmentType } | null
}

function fmtPercent(n: number | null, digits = 2): string {
  if (n === null || !Number.isFinite(n)) return '—'
  return `${n >= 0 ? '+' : ''}${n.toFixed(digits)}%`
}

function tone(n: number | null): 'positive' | 'negative' | 'neutral' {
  if (n === null || n === 0) return 'neutral'
  return n > 0 ? 'positive' : 'negative'
}

// Privacy fallback for the Realized/Unrealized cards: each one's share of
// combined |realized| + |unrealized| — a share of total P/L, not a return —
// matching exactly what the Dashboard's Profit/Loss breakdown card shows,
// so the two pages never disagree on this number either.
function shareOfTotalPLText(n: number, metrics: PortfolioMetrics): string {
  const absTotal = Math.abs(metrics.totalRealized) + Math.abs(metrics.totalUnrealized)
  if (absTotal === 0) return '—'
  return `${((Math.abs(n) / absTotal) * 100).toFixed(1)}% of total P/L`
}

export default async function ProfitLossDetailsPage() {
  const supabase = await createClient()
  const year = new Date().getFullYear()

  const [invRes, txRes, fxRes, snapRes, flowRes, invSnapRes] = await Promise.all([
    supabase.from('investments').select('*').returns<Investment[]>(),
    supabase.from('transactions').select('*').returns<Transaction[]>(),
    loadFxRates(supabase),
    supabase
      .from('portfolio_snapshots')
      .select('date, total_value_eur')
      .order('date', { ascending: true }),
    supabase
      .from('capital_flow_entries')
      .select('year, flow_date, direction, amount_eur')
      .returns<CapitalFlowEntryForYear[]>(),
    fetchAllRows<RawInvSnapRow>((from, to) =>
      supabase
        .from('investment_snapshots')
        .select('date, investment_id, value_eur, investment:investments(id, type)')
        .order('date', { ascending: true })
        .order('investment_id', { ascending: true })
        .range(from, to)
        .returns<RawInvSnapRow[]>()
    ),
  ])

  const investments = invRes.data ?? []
  const transactions = txRes.data ?? []
  const fxRates = fxRes.rates
  const capitalFlowEntries = flowRes.data ?? []
  const snapshotsForYear = (snapRes.data ?? []).map((s) => ({
    date: String(s.date),
    total_value_eur: Number(s.total_value_eur),
  }))

  const investmentSnapshots: InvestmentSnapshotForYtd[] = (invSnapRes.data ?? [])
    .filter((r) => r.investment != null)
    .map((r) => ({ investment_id: r.investment_id, date: r.date, value_eur: Number(r.value_eur) }))

  if (investments.length === 0) {
    return (
      <div className="space-y-6">
        <div>
          <Link href="/dashboard" className="text-sm text-slate-500 hover:text-slate-700">
            ← Portfolio
          </Link>
        </div>
        <PageHeader title="Profit / Loss Details" subtitle="Performance by asset class and this year's breakdown." />
        <div className="bg-white rounded-2xl border border-slate-200 p-10 text-center">
          <p className="text-slate-900 font-medium">Nothing to show yet</p>
          <p className="text-sm text-slate-500 mt-1">Add an investment to start tracking performance.</p>
        </div>
      </div>
    )
  }

  // ── A. Total performance — same all-time metrics the Dashboard shows ─────
  const liveMetrics = computePortfolioMetrics(investments, transactions, fxRates)

  // ── B. YTD performance — reuses Year Analysis' current-year engine, the
  // same one the /ytd page is built on. "YTD" is just "this year, so far".
  const assetRows = computeAssetYearRows(investments, transactions, year, fxRates)
  const yearSummary = computeYearPortfolioSummary(
    year,
    assetRows,
    snapshotsForYear,
    capitalFlowEntries,
    transactions,
    liveMetrics.totalValue
  )

  // ── C. Performance per asset class — YTD (year-scoped, Modified Dietz)
  // combined with total/since-inception (all-time, same cash-exclusion rule
  // as the Dashboard's totals). Two legitimately different questions, never
  // computed twice for the same question.
  const classYtd = computeAssetClassYtd(investments, transactions, year, fxRates, investmentSnapshots)
  const classTotal = computePerformanceByCategory(investments, transactions, (i) => i.type, fxRates)

  const allTypes = new Set<InvestmentType>([
    ...classYtd.map((c) => c.type),
    ...classTotal.map((c) => c.key as InvestmentType),
  ])
  const classRows: ClassPerformanceRow[] = [...allTypes]
    .map((type) => {
      const ytd = classYtd.find((c) => c.type === type) ?? null
      const total = classTotal.find((c) => c.key === type) ?? null
      return {
        key: type,
        label: categoryLabel(type),
        ytdReturnPercent: ytd?.returnPercent ?? null,
        ytdUnavailableReason: ytd?.percentUnavailableReason ?? null,
        totalReturnPercent: total?.totalProfitPct !== null && total?.totalProfitPct !== undefined
          ? total.totalProfitPct * 100
          : null,
      }
    })
    .sort((a, b) => (b.totalReturnPercent ?? -Infinity) - (a.totalReturnPercent ?? -Infinity))

  // ── D. YTD breakdown — same summary numbers as section B, just the
  // start/contributions/growth/end split, shown as a bar instead of a table.
  const bridgeAmounts =
    yearSummary.startValueEur !== null && yearSummary.growthExcludingContributionsEur !== null
      ? {
          startValueEur: yearSummary.startValueEur,
          netContributionsEur: yearSummary.netContributionsEur,
          investmentProfitEur: yearSummary.growthExcludingContributionsEur,
          endValueEur: yearSummary.endValueEur,
        }
      : null

  return (
    <div className="space-y-6">
      <div>
        <Link href="/dashboard" className="text-sm text-slate-500 hover:text-slate-700">
          ← Portfolio
        </Link>
      </div>

      <PageHeader
        title="Profit / Loss Details"
        subtitle="Performance by asset class and how this year's change breaks down."
      />

      {/* A. Total performance */}
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
        <StatCard
          label="Total return"
          value={
            <PrivacyMoney
              value={liveMetrics.totalProfit}
              signed
              fallbackText={
                liveMetrics.totalProfitPct !== null
                  ? `${liveMetrics.totalProfitPct >= 0 ? '+' : ''}${pct(liveMetrics.totalProfitPct)}`
                  : '—'
              }
            />
          }
          hint={
            liveMetrics.totalProfitPct !== null ? (
              <PrivacyGate>
                <>{pct(liveMetrics.totalProfitPct)} all-time, cost-basis P/L</>
              </PrivacyGate>
            ) : undefined
          }
          tone={tone(liveMetrics.totalProfit)}
        />
        <StatCard
          label="Realized"
          value={
            <PrivacyMoney
              value={liveMetrics.totalRealized}
              signed
              fallbackText={shareOfTotalPLText(liveMetrics.totalRealized, liveMetrics)}
            />
          }
          tone={tone(liveMetrics.totalRealized)}
        />
        <StatCard
          label="Unrealized"
          value={
            <PrivacyMoney
              value={liveMetrics.totalUnrealized}
              signed
              fallbackText={shareOfTotalPLText(liveMetrics.totalUnrealized, liveMetrics)}
            />
          }
          tone={tone(liveMetrics.totalUnrealized)}
        />
      </div>

      {/* B. YTD performance */}
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
        <StatCard
          label={`YTD return (${year})`}
          value={
            <PrivacyMoney
              value={yearSummary.growthExcludingContributionsEur}
              signed
              fallbackText={fmtPercent(yearSummary.modifiedDietzReturnPercent)}
            />
          }
          hint={
            yearSummary.growthExcludingContributionsEur !== null ? (
              <PrivacyGate>
                <>{fmtPercent(yearSummary.modifiedDietzReturnPercent)} · Modified Dietz, since Jan 1</>
              </PrivacyGate>
            ) : (
              'No reliable start-of-year value yet'
            )
          }
          tone={tone(yearSummary.growthExcludingContributionsEur)}
        />
        <StatCard
          label="Net contributions YTD"
          value={<PrivacyMoney value={yearSummary.netContributionsEur} signed fallbackText="—" />}
          hint="Deposits minus withdrawals since Jan 1 — excluded from investment profit."
        />
      </div>

      {/* C. Performance per asset class */}
      <div className="bg-white rounded-2xl border border-slate-200 p-5 md:p-6">
        <h2 className="text-base font-semibold text-slate-900 mb-1">Performance by asset class</h2>
        <p className="text-sm text-slate-500 mb-4">
          YTD = selected-year return after contributions (Modified Dietz). Total = all-time, cost-basis return
          since each position was opened. Cash excluded.
        </p>
        <AssetClassPerformanceTable rows={classRows} />
      </div>

      {/* D. YTD profit breakdown */}
      <div className="bg-white rounded-2xl border border-slate-200 p-5 md:p-6">
        <h2 className="text-base font-semibold text-slate-900 mb-1">YTD breakdown</h2>
        <p className="text-sm text-slate-500 mb-4">
          Start-of-year value + net contributions + investment profit = current value. Contributions are never
          counted as investment profit.
        </p>
        {bridgeAmounts ? (
          <YtdBridgeBar amounts={bridgeAmounts} />
        ) : (
          <p className="text-sm text-slate-500">
            No start-of-year snapshot yet — the breakdown needs one to compare against.
          </p>
        )}
      </div>

      <p className="text-xs text-slate-400 px-1">
        All figures use the same portfolio and transaction data as the Dashboard and Asset Allocation pages —
        deposits/withdrawals are never counted as investment profit, and a transaction&apos;s fee is applied once.
      </p>
    </div>
  )
}
