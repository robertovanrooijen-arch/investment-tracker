import { createClient } from '@/lib/supabase/server'
import { fetchAllInvestments, fetchAllTransactions } from '@/lib/supabase/fetch-user-data'
import { fetchAllRows } from '@/lib/supabase/fetch-all-rows'
import { PageHeader } from '@/components/ui/page-header'
import { CURRENT_PL_DEFINITION_VERSION } from '@/lib/domain/snapshot-method'
import { DataQualityNotice } from '@/components/ui/data-quality-notice'
import { unfundedPlatforms } from '@/lib/domain/reconciliation'
import { StatCard } from '@/components/ui/stat-card'
import { PortfolioHistoryChart } from '@/components/history/portfolio-history-chart'
import type { LivePoint, PortfolioSnapshot as ChartPortfolioSnapshot, InvSnapshot } from '@/components/history/portfolio-history-chart'
import { PortfolioBridgeChart, AssetClassYtdChart } from '@/components/year-analysis/charts'
import { MonthlyPerformanceTable, BestWorstCards, AssetBreakdownTable } from '@/components/ytd/ytd-components'
import { computePortfolioMetrics } from '@/lib/domain/calculations'
import { loadFxRates } from '@/lib/domain/fx'
import { fmtDate, money } from '@/lib/format'
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
import { PrivacyMoney, PrivacyGate } from '@/components/ui/privacy-value'
import type { InvestmentType } from '@/types/database'
import { loadReturns } from '@/lib/returns/load-returns'

type RawPortfolioSnapshot = {
  date: string
  total_value_eur: number
  total_invested_eur: number
  total_unrealized_eur: number
  total_realized_eur: number
  snapshot_source: string
  pl_definition_version: number | null
}

type RawInvSnapRow = {
  date: string
  investment_id: string
  value_eur: number | string
  remaining_cost_basis_eur: number | string
  investment: { id: string; type: InvestmentType } | null
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

  const [invRes, txRes, fxRes, snapRes, flowRes, invSnapRes, returnsData] = await Promise.all([
    fetchAllInvestments(supabase),
    fetchAllTransactions(supabase),
    loadFxRates(supabase),
    supabase
      .from('portfolio_snapshots')
      // '*' so pl_definition_version is included once migration M7 adds it.
      .select('*')
      .order('date', { ascending: true }),
    fetchAllRows<CapitalFlowEntryForYear>((from, to) =>
      supabase
        .from('capital_flow_entries')
        // '*' so linked_transaction_id is picked up automatically once the
        // pending migration adds it (prevents double-counting migrated rows).
        .select('*')
        .order('id', { ascending: true })
        .range(from, to)
        .returns<CapitalFlowEntryForYear[]>()
    ),
    fetchAllRows<RawInvSnapRow>((from, to) =>
      supabase
        .from('investment_snapshots')
        .select('date, investment_id, value_eur, remaining_cost_basis_eur, investment:investments(id, type)')
        .order('date', { ascending: true })
        .order('investment_id', { ascending: true })
        .range(from, to)
        .returns<RawInvSnapRow[]>()
    ),
    loadReturns(supabase, todayIso),
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
    pl_definition_version: row.pl_definition_version == null ? null : Number(row.pl_definition_version),
  }))

  const rawInvSnapshots = invSnapRes.data ?? []
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
  const canonicalYtd = returnsData.ytd

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
  // Where the start value comes from (coverage of historical valuations).
  const startSnapshotSource =
    rawSnapshots.find((r) => r.date === summary.startValueDate)?.snapshot_source ?? null
  const startValueSourceLabel =
    startSnapshotSource === 'cron' || startSnapshotSource === 'manual_refresh'
      ? 'live snapshot'
      : startSnapshotSource?.startsWith('reconstructed')
        ? 'reconstructed from historical prices (derived)'
        : startSnapshotSource
          ? `imported/statement snapshot (${startSnapshotSource})`
          : 'source unknown'

  const livePoint: LivePoint = {
    date: todayIso,
    totalValue: liveMetrics.totalValue,
    totalInvested: liveMetrics.totalInvested,
    totalUnrealized: liveMetrics.totalUnrealized,
    totalRealized: liveMetrics.totalRealized,
    byType: Array.from(byTypeMap.entries()).map(([type, value]) => ({ type: type as InvestmentType, value })),
  }

  const storedYtdByDate = new Map(rawSnapshots.filter((s) => s.date >= yearStartIso).map((s) => [s.date, s]))
  const reconstructedYtd = returnsData.reconstructedHistory
    .filter((point) => point.date >= yearStartIso && point.date !== todayIso)
    .map((point): ChartPortfolioSnapshot => {
      const stored = storedYtdByDate.get(point.date)
      return {
        date: point.date,
        total_value_eur: point.valueEur,
        total_invested_eur: stored?.total_invested_eur ?? null,
        total_unrealized_eur: stored?.total_unrealized_eur ?? null,
        total_realized_eur: stored?.total_realized_eur ?? null,
        snapshot_source: stored?.snapshot_source ?? 'reconstructed_yahoo_ecb',
        pl_definition_version: stored?.pl_definition_version ?? CURRENT_PL_DEFINITION_VERSION,
      }
    })
  const reconstructedYtdDates = new Set(reconstructedYtd.map((s) => s.date))
  const ytdChartSnapshots: ChartPortfolioSnapshot[] = [
    ...rawSnapshots
      .filter((s) => s.date >= yearStartIso && s.date !== todayIso && !reconstructedYtdDates.has(s.date)),
    ...reconstructedYtd,
    {
      date: todayIso,
      total_value_eur: liveMetrics.totalValue,
      total_invested_eur: liveMetrics.totalInvested,
      total_unrealized_eur: liveMetrics.totalUnrealized,
      total_realized_eur: liveMetrics.totalRealized,
      snapshot_source: 'live',
      pl_definition_version: CURRENT_PL_DEFINITION_VERSION,
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

      <DataQualityNotice
        fxIncompleteCount={Math.max(liveMetrics.fxIncompleteCount, summary.fxIncompleteCount)}
        fxLiveFallbackCount={liveMetrics.fxLiveFallbackCount}
        legacyContributionsSkippedFx={summary.legacyContributionsSkippedFx}
        unfundedPlatforms={unfundedPlatforms(investments, transactions, capitalFlowEntries, fxRates)}
      />

      {/* Top summary */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
        <StatCard
          label="Portfolio value"
          value={<PrivacyMoney value={liveMetrics.totalValue} fallbackText="—" />}
          hint="Current live value, EUR"
        />
        <StatCard
          label="Portfolio return YTD (TWR)"
          value={canonicalYtd.twr === null ? '—' : fmtPercent(canonicalYtd.twr * 100)}
          hint={
            canonicalYtd.status === 'ok' ? (
              <PrivacyGate fallback="Time-weighted return">
                <>
                  <PrivacyMoney value={returnsData.investmentResult?.period.totalEur ?? null} signed fallbackText="—" /> investment result · cash-flow timing removed
                </>
              </PrivacyGate>
            ) : (
              canonicalYtd.missing[0]?.reason ?? 'Return unavailable because historical data is incomplete'
            )
          }
          tone={canonicalYtd.twr === null ? 'neutral' : canonicalYtd.twr > 0 ? 'positive' : canonicalYtd.twr < 0 ? 'negative' : 'neutral'}
        />
        <StatCard
          label="Own money added YTD"
          value={<PrivacyMoney value={returnsData.contributionsYtd.grossOwnContributionsEur} fallbackText="—" />}
          hint={`${money(returnsData.contributionsYtd.grossPlatformContributionsEur, 'EUR')} platform-funded · re-used sale proceeds excluded`}
        />
        <StatCard
          label="Start-of-year value"
          value={<PrivacyMoney value={displayStartValueEur} fallbackText="—" />}
          hint={
            summary.startValueEur !== null
              ? `As of ${summary.startValueDate} · ${startValueSourceLabel}`
              : startedThisYear
                ? 'No prior activity — started investing this year'
                : 'No start-of-year snapshot available'
          }
        />
      </div>

      <p className="text-xs text-slate-400 px-1">
        Portfolio return uses the same daily time-weighted engine as Returns. New money is removed on its real date;
        sales and re-investments stay inside the portfolio and never become contributions. Market YTD per instrument
        is a different question: the price change of that instrument itself.
      </p>

      {/* Main chart */}
      <div className="bg-white rounded-2xl border border-slate-200 p-5 md:p-6">
        <div className="flex items-center justify-between mb-1">
          <h2 className="text-base font-semibold text-slate-900">Portfolio history</h2>
        </div>
        {hasHistoryGapAtStart && (
          <p className="mb-3 text-xs text-slate-400">
            The total-value line is reconstructed for the full year from transactions, Yahoo closes and ECB exchange
            rates. Detailed stored cost-basis and profit/loss snapshots start on {fmtDate(firstRealSnapshotIso)}.
          </p>
        )}
        {hasNoRealSnapshotsThisYear && (
          <p className="mb-3 text-xs text-slate-400">
            The total-value line is reconstructed from transactions, Yahoo closes and ECB exchange rates. No stored
            historical cost-basis or profit/loss snapshots are available yet.
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

