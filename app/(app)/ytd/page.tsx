import { createClient } from '@/lib/supabase/server'
import { PageHeader } from '@/components/ui/page-header'
import { StatCard } from '@/components/ui/stat-card'
import { PortfolioHistoryChart } from '@/components/history/portfolio-history-chart'
import type { LivePoint, PortfolioSnapshot as ChartPortfolioSnapshot, InvSnapshot } from '@/components/history/portfolio-history-chart'
import { PortfolioBridgeChart, AssetClassYtdChart } from '@/components/year-analysis/charts'
import { MonthlyPerformanceTable, BestWorstCards, AssetBreakdownTable } from '@/components/ytd/ytd-components'
import { computePortfolioMetrics } from '@/lib/domain/calculations'
import { loadFxRates } from '@/lib/domain/fx'
import { money, fmtDate } from '@/lib/format'
import {
  computeAssetYearRows,
  computeAssetClassSummaries,
  computeAssetClassYtd,
  computeInvestmentYtdRows,
  computeYearPortfolioSummary,
  computePortfolioBridgeData,
  computeMonthlyYtdPerformance,
  getAvailableYears,
} from '@/lib/domain/year-analysis'
import type { CapitalFlowEntryForYear, InvestmentSnapshotForYtd } from '@/lib/domain/year-analysis'
import type { Investment, Transaction, InvestmentType } from '@/types/database'

type RawPortfolioSnapshot = {
  date: string
  total_value_eur: number
  total_invested_eur: number
  total_unrealized_eur: number
  total_realized_eur: number
  snapshot_source: string
}

export const dynamic = 'force-dynamic'

function fmtPercent(n: number | null, digits = 2): string {
  if (n === null || !Number.isFinite(n)) return '—'
  return `${n >= 0 ? '+' : ''}${n.toFixed(digits)}%`
}

export default async function YtdPage() {
  const supabase = await createClient()
  const year = new Date().getFullYear()
  const yearStartIso = `${year}-01-01`
  const todayIso = new Date().toISOString().slice(0, 10)

  const [invRes, txRes, fxRes, snapRes, flowRes, invSnapRes] = await Promise.all([
    supabase.from('investments').select('*').returns<Investment[]>(),
    supabase.from('transactions').select('*').returns<Transaction[]>(),
    loadFxRates(supabase),
    supabase
      .from('portfolio_snapshots')
      .select('date, total_value_eur, total_invested_eur, total_unrealized_eur, total_realized_eur, snapshot_source')
      .order('date', { ascending: true }),
    supabase
      .from('capital_flow_entries')
      .select('year, flow_date, direction, amount_eur')
      .returns<CapitalFlowEntryForYear[]>(),
    supabase
      .from('investment_snapshots')
      .select('date, investment_id, value_eur, remaining_cost_basis_eur, realized_profit_eur, unrealized_profit_eur, investment:investments(id, type)')
      .order('date', { ascending: true }),
  ])

  const investments = invRes.data ?? []
  const transactions = txRes.data ?? []
  const fxRates = fxRes.rates
  const capitalFlowEntries = flowRes.data ?? []

  if (investments.length === 0) {
    return (
      <div className="space-y-6">
        <PageHeader
          title="Year to date"
          subtitle={`Portfolio performance from January 1, ${year} to today.`}
        />
        <div className="bg-white rounded-2xl border border-slate-200 p-10 text-center">
          <p className="text-slate-900 font-medium">No investments yet</p>
          <p className="mt-1 text-sm text-slate-500">
            Add your first position to start tracking year-to-date performance.
          </p>
        </div>
      </div>
    )
  }

  // Postgres numeric columns come back as strings via supabase-js; coerce.
  const rawSnapshots: RawPortfolioSnapshot[] = (snapRes.data ?? []).map((row) => ({
    date: String(row.date),
    total_value_eur: Number(row.total_value_eur),
    total_invested_eur: Number(row.total_invested_eur),
    total_unrealized_eur: Number(row.total_unrealized_eur),
    total_realized_eur: Number(row.total_realized_eur ?? 0),
    snapshot_source: String(row.snapshot_source ?? ''),
  }))

  type RawInvSnapRow = {
    date: string
    investment_id: string
    value_eur: number | string
    remaining_cost_basis_eur: number | string
    investment: { id: string; type: InvestmentType } | null
  }
  const rawInvSnapshots = (invSnapRes.data ?? []) as unknown as RawInvSnapRow[]
  const investmentSnapshots: InvestmentSnapshotForYtd[] = rawInvSnapshots
    .filter((r) => r.investment != null)
    .map((r) => ({ investment_id: r.investment_id, date: r.date, value_eur: Number(r.value_eur) }))

  // ── Live metrics — same computation as Dashboard ─────────────────────────
  const liveMetrics = computePortfolioMetrics(investments, transactions, fxRates)

  // ── Core YTD numbers — all reused from Year Analysis' current-year engine.
  // "YTD" is exactly "Year Analysis for the current, still-open year".
  const assetRows = computeAssetYearRows(investments, transactions, year, fxRates)
  const classSummaries = computeAssetClassSummaries(assetRows)
  const classYtd = computeAssetClassYtd(investments, transactions, year, fxRates, investmentSnapshots)
  const snapshotsForYear = rawSnapshots.map((s) => ({ date: s.date, total_value_eur: s.total_value_eur }))
  const summary = computeYearPortfolioSummary(
    year,
    assetRows,
    snapshotsForYear,
    capitalFlowEntries,
    transactions,
    liveMetrics.totalValue
  )

  // Edge case: user started investing during the current year, so there is
  // genuinely no snapshot at/before Jan 1 — startValueEur comes back null.
  // If nothing at all happened before this year, the financially correct
  // start-of-year value is unambiguously €0 (not "unknown"), for the KPI
  // card only. The shared bridge/monthly/Modified-Dietz calculations are
  // NOT patched here — they still honestly show "unavailable" until a real
  // year-start snapshot exists, matching how Year Analysis treats this.
  const startedThisYear = getAvailableYears(transactions).every((y) => y >= year)
  const displayStartValueEur = summary.startValueEur ?? (startedThisYear ? 0 : null)

  const bridgeData = computePortfolioBridgeData(summary)
  const monthlyRows = computeMonthlyYtdPerformance(
    year,
    summary.startValueEur,
    summary.startValueDate,
    snapshotsForYear,
    capitalFlowEntries,
    transactions,
    liveMetrics.totalValue
  )
  const ytdRows = computeInvestmentYtdRows(investments, transactions, year, fxRates, investmentSnapshots)

  // ── Main chart data — same shape/plumbing as the History page, but
  // scoped to this calendar year only (Jan 1 → today), so the reused
  // PortfolioHistoryChart's "All" preset means "all of YTD".
  const byTypeMap = new Map<string, number>()
  for (const inv of investments) {
    const row = assetRows.find((r) => r.investmentId === inv.id)
    if (row && (row.status !== 'closed' || row.currentValueEur > 0)) {
      byTypeMap.set(inv.type, (byTypeMap.get(inv.type) ?? 0) + row.currentValueEur)
    }
  }
  const livePoint: LivePoint = {
    date: todayIso,
    totalValue: liveMetrics.totalValue,
    totalInvested: liveMetrics.totalInvested,
    totalUnrealized: liveMetrics.totalUnrealized,
    totalRealized: liveMetrics.totalRealized,
    byType: Array.from(byTypeMap.entries()).map(([type, value]) => ({ type: type as InvestmentType, value })),
  }

  const ytdChartSnapshots: ChartPortfolioSnapshot[] = [
    ...rawSnapshots
      .filter((s) => s.date >= yearStartIso && s.date !== todayIso)
      .map((s) => ({
        date: s.date,
        total_value_eur: s.total_value_eur,
        total_invested_eur: s.total_invested_eur,
        total_unrealized_eur: s.total_unrealized_eur,
        total_realized_eur: s.total_realized_eur,
        snapshot_source: s.snapshot_source,
      })),
    {
      date: todayIso,
      total_value_eur: liveMetrics.totalValue,
      total_invested_eur: liveMetrics.totalInvested,
      total_unrealized_eur: liveMetrics.totalUnrealized,
      total_realized_eur: liveMetrics.totalRealized,
      snapshot_source: 'live',
    },
  ].sort((a, b) => (a.date < b.date ? -1 : 1))

  const ytdInvSnapshots: InvSnapshot[] = rawInvSnapshots
    .filter((r) => r.investment != null && r.date >= yearStartIso && r.date !== todayIso)
    .map((r) => ({
      date: r.date,
      value_eur: Number(r.value_eur),
      remaining_cost_basis_eur: Number(r.remaining_cost_basis_eur),
      type: r.investment!.type,
    }))

  const tone = (n: number | null) =>
    n === null || n === 0 ? 'neutral' : n > 0 ? 'positive' : 'negative'

  // Earliest REAL portfolio_snapshots row this year — underlying data
  // coverage, deliberately BEFORE any downsampling. This describes what
  // history actually exists, which is a different question from what the
  // chart currently has rendered/sampled at whichever preset the viewer has
  // selected (PortfolioHistoryChart's own "From … on" header already
  // answers that, from its own sampled data — see
  // lib/domain/chart-series.ts's downsampleForPreset, untouched here). The
  // two intentionally aren't forced to match: e.g. at the "all" preset this
  // app's real May data (27 daily rows) gets summarized to a single 31 May
  // point for display, but the real data coverage this message describes
  // still starts 5 May.
  const realSnapshotsThisYear = rawSnapshots
    .filter((s) => s.date >= yearStartIso)
    .sort((a, b) => (a.date < b.date ? -1 : 1))
  const firstRealSnapshotIso = realSnapshotsThisYear[0]?.date ?? null
  const hasHistoryGapAtStart = firstRealSnapshotIso !== null && firstRealSnapshotIso > yearStartIso
  const hasNoRealSnapshotsThisYear = firstRealSnapshotIso === null

  return (
    <div className="space-y-6">
      <PageHeader
        title="Year to date"
        subtitle={`Portfolio performance from January 1, ${year} to today.`}
      />

      {/* Top summary */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
        <StatCard
          label="Portfolio value"
          value={money(liveMetrics.totalValue, 'EUR')}
          hint="Current live value, EUR"
        />
        <StatCard
          label="YTD return"
          value={fmtSignedMoney(summary.growthExcludingContributionsEur)}
          hint={
            summary.modifiedDietzReturnPercent !== null
              ? `${fmtPercent(summary.modifiedDietzReturnPercent)} · Modified Dietz`
              : 'No reliable start-of-year value yet'
          }
          tone={tone(summary.growthExcludingContributionsEur)}
        />
        <StatCard
          label="Net contributions YTD"
          value={fmtSignedMoney(summary.netContributionsEur)}
          hint="Deposits minus withdrawals since Jan 1"
        />
        <StatCard
          label="Start-of-year value"
          value={displayStartValueEur !== null ? money(displayStartValueEur, 'EUR') : '—'}
          hint={
            summary.startValueEur !== null
              ? `As of ${summary.startValueDate}`
              : startedThisYear
                ? 'No prior activity — started investing this year'
                : 'No start-of-year snapshot available'
          }
        />
      </div>

      <p className="text-xs text-slate-400 px-1">
        YTD return = current value − start-of-year value − net contributions, so deposits and withdrawals are not
        counted as investment performance. The percentage return uses Modified Dietz, which adjusts for the timing
        of cash flows — the same methodology Year Analysis uses.
      </p>

      {/* Main chart */}
      <div className="bg-white rounded-2xl border border-slate-200 p-5 md:p-6">
        <div className="flex items-center justify-between mb-1">
          <h2 className="text-base font-semibold text-slate-900">Portfolio history</h2>
        </div>
        {hasHistoryGapAtStart && (
          <p className="mb-3 text-xs text-slate-400">
            Portfolio history is available from {fmtDate(firstRealSnapshotIso)}. The chart may aggregate earlier
            observations depending on the selected time range. YTD calculations above still include the full year.
          </p>
        )}
        {hasNoRealSnapshotsThisYear && (
          <p className="mb-3 text-xs text-slate-400">
            No historical snapshots recorded yet this year — showing today&apos;s live value only. YTD calculations
            above still include the full year.
          </p>
        )}
        <PortfolioHistoryChart
          portfolioSnapshots={ytdChartSnapshots}
          invSnapshots={ytdInvSnapshots}
          livePoint={livePoint}
          initialPreset="all"
          rangeFloorIso={yearStartIso}
          openingPoint={
            displayStartValueEur !== null ? { date: yearStartIso, totalValueEur: displayStartValueEur } : undefined
          }
        />
      </div>

      {/* YTD breakdown (waterfall) */}
      <div className="bg-white rounded-2xl border border-slate-200 p-5 md:p-6">
        <h2 className="text-base font-semibold text-slate-900 mb-1">YTD breakdown</h2>
        <p className="text-sm text-slate-500 mb-3">
          Start-of-year value + contributions − withdrawals + investment gains/losses = current value.
        </p>
        <PortfolioBridgeChart steps={bridgeData} />
      </div>

      {/* Monthly performance */}
      <div className="bg-white rounded-2xl border border-slate-200 p-5 md:p-6">
        <h2 className="text-base font-semibold text-slate-900 mb-1">Monthly performance</h2>
        <p className="text-sm text-slate-500 mb-3">Each month of {year} up to the current month.</p>
        <MonthlyPerformanceTable rows={monthlyRows} />
      </div>

      {/* Asset breakdown */}
      <div className="bg-white rounded-2xl border border-slate-200 p-5 md:p-6">
        <h2 className="text-base font-semibold text-slate-900 mb-1">YTD by asset class</h2>
        <p className="text-sm text-slate-500 mb-3">
          Selected-year growth after external cashflows, with Modified Dietz return by asset class.
        </p>
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
          <AssetClassYtdChart classYtd={classYtd} />
          <AssetBreakdownTable summaries={classSummaries} classYtd={classYtd} />
        </div>
      </div>

      {/* Best / worst performer YTD */}
      <div className="space-y-3">
        <h2 className="text-base font-semibold text-slate-900 px-1">Best / worst performer YTD</h2>
        <BestWorstCards rows={ytdRows} investments={investments} />
      </div>
    </div>
  )
}

function fmtSignedMoney(n: number | null): string {
  if (n === null || !Number.isFinite(n)) return '—'
  return `${n >= 0 ? '+' : ''}${money(n, 'EUR')}`
}
