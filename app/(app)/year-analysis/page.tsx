import Link from 'next/link'
import { createClient } from '@/lib/supabase/server'
import { PageHeader } from '@/components/ui/page-header'
import { StatCard } from '@/components/ui/stat-card'
import { money } from '@/lib/format'
import { loadFxRates } from '@/lib/domain/fx'
import { computePortfolioMetrics } from '@/lib/domain/calculations'
import {
  getAvailableYears,
  computeAssetYearRows,
  computeAssetClassSummaries,
  computeAssetClassYtd,
  computeYearPortfolioSummary,
  computePortfolioBridgeData,
  computeAssetPnlRanking,
  computeYearVerdict,
  computeReconciliationAudit,
  type SnapshotForAudit,
  type CapitalFlowEntryForYear,
  type InvestmentSnapshotForYtd,
  type AssetStatus,
  type AuditCheck,
  type AuditStatus,
} from '@/lib/domain/year-analysis'
import {
  PortfolioBridgeChart,
  AssetClassAllocationChart,
  AssetClassPnlChart,
  AssetClassYtdChart,
  AssetPnlRankingChart,
  MonthlyCashflowChart,
} from '@/components/year-analysis/charts'
import type { Investment, Transaction } from '@/types/database'

export const dynamic = 'force-dynamic'

const TYPE_LABELS: Record<string, string> = {
  stock: 'Stock',
  ETF: 'ETF',
  crypto: 'Crypto',
  cash: 'Cash',
  'real estate': 'Real Estate',
  commodity: 'Commodity',
  custom: 'Custom',
}

function plClass(n: number | null): string {
  if (n === null) return 'text-slate-400'
  if (n > 0) return 'text-emerald-600'
  if (n < 0) return 'text-rose-600'
  return 'text-slate-500'
}

function signedMoney(n: number): string {
  return (n >= 0 ? '+' : '') + money(n, 'EUR')
}

function plCell(n: number | null): string {
  if (n === null) return 'Not applicable'
  if (n === 0) return '—'
  return signedMoney(n)
}

function pctCell(n: number | null, digits = 1): string {
  if (n === null) return '—'
  return `${n >= 0 ? '+' : ''}${n.toFixed(digits)}%`
}

const STATUS_LABEL: Record<AssetStatus, string> = {
  open: 'Open',
  closed: 'Closed',
  cash: 'Cash',
}

const STATUS_CLASS: Record<AssetStatus, string> = {
  open: 'bg-emerald-50 text-emerald-700 border border-emerald-200',
  closed: 'bg-slate-100 text-slate-500 border border-slate-200',
  cash: 'bg-sky-50 text-sky-700 border border-sky-200',
}

const AUDIT_STATUS_LABEL: Record<AuditStatus, string> = {
  ok: 'OK',
  mismatch: 'Mismatch',
  approximate: 'Approximate / not directly reconcilable',
  unavailable: 'Unavailable',
}

const AUDIT_STATUS_CLASS: Record<AuditStatus, string> = {
  ok: 'bg-emerald-50 text-emerald-700 border border-emerald-200',
  mismatch: 'bg-rose-50 text-rose-700 border border-rose-200',
  approximate: 'bg-amber-50 text-amber-700 border border-amber-200',
  unavailable: 'bg-slate-100 text-slate-500 border border-slate-200',
}

function AuditCheckCard({ check }: { check: AuditCheck }) {
  return (
    <div className="rounded-xl border border-slate-200 p-4">
      <div className="flex flex-wrap items-center justify-between gap-2 mb-3">
        <h3 className="text-sm font-semibold text-slate-900">{check.title}</h3>
        <span
          className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium whitespace-nowrap ${AUDIT_STATUS_CLASS[check.status]}`}
        >
          {AUDIT_STATUS_LABEL[check.status]}
        </span>
      </div>
      <table className="w-full text-sm">
        <tbody className="divide-y divide-slate-100">
          {check.rows.map((row) => (
            <tr key={row.label}>
              <td className="py-1.5 pr-4 text-slate-600 align-top">
                {row.label}
                {row.note && <span className="block text-xs text-slate-400">{row.note}</span>}
              </td>
              <td className="py-1.5 text-right tabular-nums font-medium text-slate-900 whitespace-nowrap">
                {row.value !== null ? money(row.value, 'EUR') : '—'}
              </td>
            </tr>
          ))}
          <tr className="border-t-2 border-slate-200">
            <td className="py-1.5 pr-4 font-medium text-slate-700">Difference</td>
            <td
              className={`py-1.5 text-right tabular-nums font-semibold whitespace-nowrap ${
                check.differenceEur === null
                  ? 'text-slate-400'
                  : Math.abs(check.differenceEur) <= 1
                    ? 'text-emerald-600'
                    : 'text-rose-600'
              }`}
            >
              {check.differenceEur !== null ? signedMoney(check.differenceEur) : '—'}
            </td>
          </tr>
        </tbody>
      </table>
      <p className="mt-2 text-xs text-slate-500 leading-relaxed">{check.explanation}</p>
    </div>
  )
}

export default async function YearAnalysisPage({
  searchParams,
}: {
  searchParams: Promise<{ year?: string }>
}) {
  const supabase = await createClient()

  const [invRes, txRes, fxRes, snapRes, flowRes, invSnapRes] = await Promise.all([
    supabase.from('investments').select('*').returns<Investment[]>(),
    supabase.from('transactions').select('*').returns<Transaction[]>(),
    loadFxRates(supabase),
    supabase
      .from('portfolio_snapshots')
      .select('date, total_value_eur, total_realized_eur, total_unrealized_eur, updated_at, snapshot_source')
      .order('date', { ascending: true })
      .returns<SnapshotForAudit[]>(),
    supabase
      .from('capital_flow_entries')
      .select('year, flow_date, direction, amount_eur')
      .returns<CapitalFlowEntryForYear[]>(),
    // Source-backed per-investment valuations (e.g. official year-end
    // statements) — see computeInvestmentYtdRows / computeAssetClassYtd.
    // Fetched unfiltered (like portfolio_snapshots above) since the
    // selected year isn't known until after this batch resolves.
    supabase
      .from('investment_snapshots')
      .select('investment_id, date, value_eur')
      .returns<InvestmentSnapshotForYtd[]>(),
  ])

  const investments = invRes.data ?? []
  const transactions = txRes.data ?? []
  const fxRates = fxRes.rates
  const snapshots = snapRes.data ?? []
  const capitalFlowEntries = flowRes.data ?? []
  const investmentSnapshots: InvestmentSnapshotForYtd[] = (invSnapRes.data ?? []).map((s) => ({
    investment_id: s.investment_id,
    date: s.date,
    value_eur: Number(s.value_eur),
  }))

  const availableYears = getAvailableYears(transactions)
  const { year: yearParam } = await searchParams
  const year = availableYears.includes(Number(yearParam))
    ? Number(yearParam)
    : availableYears[0]

  const liveMetrics = computePortfolioMetrics(investments, transactions, fxRates)

  const assetRows = computeAssetYearRows(investments, transactions, year, fxRates)
  const classSummaries = computeAssetClassSummaries(assetRows)
  const classYtd = computeAssetClassYtd(investments, transactions, year, fxRates, investmentSnapshots)
  const summary = computeYearPortfolioSummary(
    year,
    assetRows,
    snapshots,
    capitalFlowEntries,
    transactions,
    liveMetrics.totalValue
  )
  const bridgeData = computePortfolioBridgeData(summary)
  const pnlRanking = computeAssetPnlRanking(assetRows)
  const verdict = computeYearVerdict(summary, classSummaries)
  const audit = computeReconciliationAudit(
    investments,
    transactions,
    year,
    fxRates,
    assetRows,
    summary,
    snapshots,
    liveMetrics
  )

  const showSnapshotWarning = summary.startSnapshotMissing || summary.endSnapshotMissing
  const isCurrentYear = year === new Date().getFullYear()

  return (
    <div className="space-y-6">
      <PageHeader
        title="Year Analysis"
        subtitle="How your portfolio and individual holdings performed in a given year."
      />

      {/* Year selector */}
      <div className="inline-flex flex-wrap rounded-lg border border-slate-200 bg-slate-50 p-0.5">
        {availableYears.map((y) => (
          <Link
            key={y}
            href={`/year-analysis?year=${y}`}
            className={`px-5 py-1.5 rounded-md text-sm font-medium transition-colors ${
              year === y
                ? 'bg-white text-slate-900 shadow-sm'
                : 'text-slate-500 hover:text-slate-700'
            }`}
          >
            {y}
          </Link>
        ))}
      </div>

      {showSnapshotWarning && (
        <div className="rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-800">
          {summary.startSnapshotMissing && summary.endSnapshotMissing ? (
            <>No portfolio snapshots found near the start or end of {year} — start and end values, and every percentage below, are incomplete.</>
          ) : summary.startSnapshotMissing ? (
            <>No portfolio snapshot found on or before the start of {year} — start value and every percentage below are unavailable.</>
          ) : (
            <>No portfolio snapshot found for the end of {year} yet — end value below falls back to today&apos;s live total.</>
          )}
        </div>
      )}

      {summary.valuationIsApproximate && year !== 2025 && (
        <div className="rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-800">
          Past-year unrealized P/L uses current prices unless historical snapshots/prices are available — {year}&apos;s
          quantities and cost basis are exact (from your transaction history), but they&apos;re valued at today&apos;s
          prices, not {year} year-end prices.
        </div>
      )}

      {year === 2025 && (
        <div className="rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-800">
          2025 is indicative: DEGIRO 2025 cashflow dates still use bulk rows, and open-position P/L may use current
          prices rather than exact 2025 year-end prices.
        </div>
      )}

      {/* Verdict */}
      <div className="rounded-2xl bg-slate-900 p-5 md:p-6">
        <p className="text-xs uppercase tracking-wide text-slate-400 font-medium mb-1.5">
          {year} in one sentence
        </p>
        <p className="text-sm md:text-base leading-relaxed text-white">{verdict}</p>
      </div>

      {/* Summary cards */}
      {summary.startValueDate === '2025-12-31' && (
        <p className="text-sm text-amber-700 bg-amber-50 border border-amber-200 rounded-xl px-4 py-3">
          Start value is corrected from official platform statements. Historical snapshot P/L fields for 2025-12-31
          are not fully reconstructed, so P/L bridge details remain approximate.
        </p>
      )}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
        <StatCard
          label="Start portfolio value"
          value={summary.startValueEur !== null ? money(summary.startValueEur, 'EUR') : '—'}
          hint={summary.startValueDate ? `As of ${summary.startValueDate}` : 'No snapshot available'}
        />
        <StatCard
          label={isCurrentYear ? 'Current portfolio value' : 'End portfolio value'}
          value={money(summary.endValueEur, 'EUR')}
          hint={summary.endValueIsLive ? `Live value, as of ${summary.endValueDate}` : `As of ${summary.endValueDate}`}
        />
        <StatCard
          label="Net contributions"
          value={signedMoney(summary.netContributionsEur)}
          hint={
            summary.netContributionsPercent !== null
              ? `${pctCell(summary.netContributionsPercent)} of start value · external cash to/from the portfolio`
              : 'External cash moved to/from the portfolio this year'
          }
        />
        <StatCard
          label="Growth after contributions"
          value={
            summary.growthExcludingContributionsEur !== null
              ? signedMoney(summary.growthExcludingContributionsEur)
              : '—'
          }
          hint="Selected-year value change after removing external cashflows."
          tone={
            summary.growthExcludingContributionsEur === null
              ? 'neutral'
              : summary.growthExcludingContributionsEur > 0
                ? 'positive'
                : summary.growthExcludingContributionsEur < 0
                  ? 'negative'
                  : 'neutral'
          }
        />
        <StatCard
          label="Modified Dietz return"
          value={pctCell(summary.modifiedDietzReturnPercent)}
          hint="Approximate selected-year return adjusted for cashflow timing."
          tone={
            summary.modifiedDietzReturnPercent === null
              ? 'neutral'
              : summary.modifiedDietzReturnPercent > 0
                ? 'positive'
                : summary.modifiedDietzReturnPercent < 0
                  ? 'negative'
                  : 'neutral'
          }
        />
        <StatCard
          label="Realized P/L from sales this year"
          value={signedMoney(summary.realizedPLInYearEur)}
          hint="Recognized this year, but gains may have built up in earlier years."
          tone={summary.realizedPLInYearEur > 0 ? 'positive' : summary.realizedPLInYearEur < 0 ? 'negative' : 'neutral'}
        />
        <StatCard
          label={isCurrentYear ? 'Current open-position P/L' : 'Unrealized P/L (approx.)'}
          value={signedMoney(summary.currentUnrealizedPLEur)}
          hint="Open positions at today's prices; not necessarily generated this year."
          tone={summary.currentUnrealizedPLEur > 0 ? 'positive' : summary.currentUnrealizedPLEur < 0 ? 'negative' : 'neutral'}
        />
        <StatCard
          label="Realized this year + current open P/L"
          value={signedMoney(summary.totalPLEur)}
          hint={
            summary.totalProfitLossPercent !== null
              ? `${pctCell(summary.totalProfitLossPercent)} of current cost basis. Not the same as selected-year return — use Growth after contributions / Modified Dietz for performance.`
              : 'Not the same as selected-year return — use Growth after contributions / Modified Dietz for performance.'
          }
          tone={summary.totalPLEur > 0 ? 'positive' : summary.totalPLEur < 0 ? 'negative' : 'neutral'}
        />
      </div>

      {/* Portfolio bridge */}
      <div className="bg-white rounded-2xl border border-slate-200 p-5 md:p-6">
        <div className="flex flex-col gap-1 sm:flex-row sm:items-baseline sm:justify-between mb-4">
          <h2 className="text-base font-semibold text-slate-900">Portfolio bridge — {year}</h2>
          {summary.modifiedDietzReturnPercent !== null && (
            <p className="text-sm font-medium text-slate-700">
              Approx. return: <span className={plClass(summary.modifiedDietzReturnPercent)}>{pctCell(summary.modifiedDietzReturnPercent)}</span>{' '}
              <span className="font-normal text-slate-400">Modified Dietz</span>
            </p>
          )}
        </div>
        <PortfolioBridgeChart steps={bridgeData} />
        <p className="mt-3 text-xs text-slate-400">
          Accounts for the timing of contributions. Still approximate because current prices/FX may be used instead
          of exact historical values.
        </p>
      </div>

      {/* Asset class overview */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <div className="bg-white rounded-2xl border border-slate-200 p-5 md:p-6">
          <h2 className="text-base font-semibold text-slate-900 mb-3">Allocation by asset class</h2>
          <AssetClassAllocationChart classSummaries={classSummaries} />
        </div>
        <div className="bg-white rounded-2xl border border-slate-200 p-5 md:p-6">
          <h2 className="text-base font-semibold text-slate-900 mb-3">P/L by asset class — {year}</h2>
          <AssetClassPnlChart classSummaries={classSummaries} />
        </div>
      </div>

      {/* YTD performance by asset class */}
      <div className="bg-white rounded-2xl border border-slate-200 p-5 md:p-6">
        <h2 className="text-base font-semibold text-slate-900 mb-1">YTD performance by asset class — {year}</h2>
        <p className="text-sm text-slate-500 mb-3">
          Selected-year growth after external cashflows, with Modified Dietz return by asset class.
        </p>
        <AssetClassYtdChart classYtd={classYtd} />
      </div>

      {/* Top winners / losers */}
      <div className="bg-white rounded-2xl border border-slate-200 p-5 md:p-6">
        <h2 className="text-base font-semibold text-slate-900 mb-1">Top winners / losers — {year}</h2>
        <p className="text-sm text-slate-500 mb-3">
          Ranked by Realized this year + current open P/L. Cash excluded.
        </p>
        <AssetPnlRankingChart rows={pnlRanking} />
      </div>

      {/* Monthly cashflow */}
      <div className="bg-white rounded-2xl border border-slate-200 p-5 md:p-6">
        <h2 className="text-base font-semibold text-slate-900 mb-1">Monthly cashflow — {year}</h2>
        <p className="text-sm text-slate-500 mb-3">When money was added to or withdrawn from the portfolio.</p>
        <MonthlyCashflowChart rows={summary.monthlyCashflow} />
      </div>

      {/* By asset class */}
      {classSummaries.length > 0 && (
        <div>
          <h2 className="text-base font-semibold text-slate-900 mb-3">By asset class — {year}</h2>
          <div className="bg-white rounded-2xl border border-slate-200 overflow-hidden">
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="bg-slate-50 border-b border-slate-200 text-xs font-semibold text-slate-600 uppercase tracking-wide">
                    <th className="text-left px-4 py-3.5 whitespace-nowrap">Class</th>
                    <th className="text-right px-4 py-3.5 whitespace-nowrap">Current value</th>
                    <th className="text-right px-4 py-3.5 whitespace-nowrap">Weight %</th>
                    <th className="text-right px-4 py-3.5 whitespace-nowrap">Bought</th>
                    <th className="text-right px-4 py-3.5 whitespace-nowrap">Sold</th>
                    <th className="text-right px-4 py-3.5 whitespace-nowrap">Realized P/L (year)</th>
                    <th className="text-right px-4 py-3.5 whitespace-nowrap">Unrealized P/L</th>
                    <th
                      className="text-right px-4 py-3.5 whitespace-nowrap"
                      title="Realized this year + current open P/L. Not the same as selected-year return."
                    >
                      Realized + open P/L
                    </th>
                    <th
                      className="text-right px-4 py-3.5 whitespace-nowrap"
                      title="Realized this year + current open P/L, as a % of current cost basis. Not the same as selected-year return."
                    >
                      Realized + open P/L %
                    </th>
                    <th className="text-right px-4 py-3.5 whitespace-nowrap">Fees</th>
                    <th className="text-right px-4 py-3.5 whitespace-nowrap">Div/interest</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-50">
                  {classSummaries.map((c) => (
                    <tr key={c.type} className="hover:bg-slate-50 transition-colors">
                      <td className="px-4 py-3.5 whitespace-nowrap font-medium text-slate-800">
                        {TYPE_LABELS[c.type] ?? c.type}
                        {c.isCashClass && (
                          <span className="ml-2 inline-flex items-center rounded-full bg-sky-50 px-2 py-0.5 text-xs font-medium text-sky-700 border border-sky-200">
                            Cash
                          </span>
                        )}
                      </td>
                      <td className="px-4 py-3.5 text-right tabular-nums whitespace-nowrap text-slate-900">
                        {money(c.currentValueEur, 'EUR')}
                      </td>
                      <td className="px-4 py-3.5 text-right tabular-nums whitespace-nowrap text-slate-500">
                        {c.pctOfPortfolio.toFixed(1)}%
                      </td>
                      <td className="px-4 py-3.5 text-right tabular-nums whitespace-nowrap">
                        {c.amountBoughtInYearEur > 0 ? money(c.amountBoughtInYearEur, 'EUR') : '—'}
                      </td>
                      <td className="px-4 py-3.5 text-right tabular-nums whitespace-nowrap">
                        {c.amountSoldInYearEur > 0 ? money(c.amountSoldInYearEur, 'EUR') : '—'}
                      </td>
                      <td className={`px-4 py-3.5 text-right tabular-nums whitespace-nowrap font-medium ${plClass(c.realizedPLInYearEur)}`}>
                        {plCell(c.realizedPLInYearEur)}
                      </td>
                      <td className={`px-4 py-3.5 text-right tabular-nums whitespace-nowrap font-medium ${plClass(c.currentUnrealizedPLEur)}`}>
                        {plCell(c.currentUnrealizedPLEur)}
                      </td>
                      <td className={`px-4 py-3.5 text-right tabular-nums whitespace-nowrap font-semibold ${plClass(c.totalPLEur)}`}>
                        {plCell(c.totalPLEur)}
                      </td>
                      <td className={`px-4 py-3.5 text-right tabular-nums whitespace-nowrap font-medium ${plClass(c.totalPLPercent)}`}>
                        {pctCell(c.totalPLPercent)}
                      </td>
                      <td className="px-4 py-3.5 text-right tabular-nums whitespace-nowrap text-slate-500">
                        {c.feesPaidInYearEur > 0 ? money(c.feesPaidInYearEur, 'EUR') : '—'}
                      </td>
                      <td className="px-4 py-3.5 text-right tabular-nums whitespace-nowrap text-slate-500">
                        {c.dividendsInterestInYearEur > 0 ? money(c.dividendsInterestInYearEur, 'EUR') : '—'}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        </div>
      )}

      {/* Per-asset table */}
      <div>
        <h2 className="text-base font-semibold text-slate-900 mb-3">Per-asset detail — {year}</h2>

        {assetRows.length === 0 ? (
          <div className="bg-white rounded-2xl border border-slate-200 p-8 text-center text-sm text-slate-500">
            No investment activity or open positions found for {year}.
          </div>
        ) : (
          <div className="bg-white rounded-2xl border border-slate-200 overflow-hidden">
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="bg-slate-50 border-b border-slate-200 text-xs font-semibold text-slate-600 uppercase tracking-wide">
                    <th className="text-left px-4 py-3.5 whitespace-nowrap sticky left-0 z-10 bg-slate-50">Asset</th>
                    <th className="text-left px-4 py-3.5 whitespace-nowrap">Platform</th>
                    <th className="text-left px-4 py-3.5 whitespace-nowrap">Type</th>
                    <th className="text-right px-4 py-3.5 whitespace-nowrap">Weight %</th>
                    <th className="text-right px-4 py-3.5 whitespace-nowrap">Bought</th>
                    <th className="text-right px-4 py-3.5 whitespace-nowrap">Sold</th>
                    <th className="text-right px-4 py-3.5 whitespace-nowrap">Realized P/L (year)</th>
                    <th className="text-right px-4 py-3.5 whitespace-nowrap">Unrealized P/L</th>
                    <th
                      className="text-right px-4 py-3.5 whitespace-nowrap"
                      title="Realized this year + current open P/L. Not the same as selected-year return."
                    >
                      Realized + open P/L
                    </th>
                    <th
                      className="text-right px-4 py-3.5 whitespace-nowrap"
                      title="Realized this year + current open P/L, as a % of current cost basis. Not the same as selected-year return."
                    >
                      Realized + open P/L %
                    </th>
                    <th className="text-right px-4 py-3.5 whitespace-nowrap">Current value</th>
                    <th className="text-left px-4 py-3.5 whitespace-nowrap">Status</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-50">
                  {assetRows.map((row) => (
                    <tr key={row.investmentId} className="hover:bg-slate-50 transition-colors">
                      <td className="px-4 py-3.5 whitespace-nowrap sticky left-0 z-10 bg-white">
                        <div className="font-medium text-slate-900">{row.name}</div>
                        <div className="text-xs text-slate-500">
                          {row.ticker ? `${row.ticker} · ` : ''}
                          {row.currentQuantity !== null
                            ? `${row.currentQuantity} held${row.status === 'closed' ? ' (closed)' : ''}`
                            : row.isCashLike
                              ? 'Cash balance'
                              : null}
                        </div>
                        {row.averageBuyPriceNative !== null && (
                          <div className="text-xs text-slate-400">
                            Avg buy: {money(row.averageBuyPriceNative, row.currency)}
                          </div>
                        )}
                      </td>
                      <td className="px-4 py-3.5 whitespace-nowrap text-slate-700">{row.platform}</td>
                      <td className="px-4 py-3.5 whitespace-nowrap">
                        <span className="inline-flex items-center rounded-full bg-slate-100 px-2 py-0.5 text-xs font-medium text-slate-700">
                          {TYPE_LABELS[row.type] ?? row.type}
                        </span>
                      </td>
                      <td className="px-4 py-3.5 text-right tabular-nums whitespace-nowrap text-slate-500">
                        {row.portfolioWeightPct !== null ? `${row.portfolioWeightPct.toFixed(1)}%` : '—'}
                      </td>
                      <td className="px-4 py-3.5 text-right tabular-nums whitespace-nowrap">
                        {row.amountBoughtInYearEur > 0 ? money(row.amountBoughtInYearEur, 'EUR') : '—'}
                      </td>
                      <td className="px-4 py-3.5 text-right tabular-nums whitespace-nowrap">
                        {row.amountSoldInYearEur > 0 ? money(row.amountSoldInYearEur, 'EUR') : '—'}
                      </td>
                      <td className={`px-4 py-3.5 text-right tabular-nums whitespace-nowrap font-medium ${plClass(row.realizedPLInYearEur)}`}>
                        {plCell(row.realizedPLInYearEur)}
                      </td>
                      <td className={`px-4 py-3.5 text-right tabular-nums whitespace-nowrap font-medium ${plClass(row.currentUnrealizedPLEur)}`}>
                        {plCell(row.currentUnrealizedPLEur)}
                      </td>
                      <td className={`px-4 py-3.5 text-right tabular-nums whitespace-nowrap font-semibold ${plClass(row.totalPLEur)}`}>
                        {plCell(row.totalPLEur)}
                      </td>
                      <td className={`px-4 py-3.5 text-right tabular-nums whitespace-nowrap font-medium ${plClass(row.totalPLPercent)}`}>
                        {pctCell(row.totalPLPercent)}
                      </td>
                      <td className="px-4 py-3.5 text-right tabular-nums whitespace-nowrap text-slate-900">
                        {money(row.currentValueEur, 'EUR')}
                      </td>
                      <td className="px-4 py-3.5 whitespace-nowrap">
                        <span className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium ${STATUS_CLASS[row.status]}`}>
                          {STATUS_LABEL[row.status]}
                        </span>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )}
      </div>

      {/* Calculation audit / debug (collapsed by default) */}
      <details className="rounded-2xl border border-slate-200 bg-white">
        <summary className="cursor-pointer select-none px-5 md:px-6 py-4 text-base font-semibold text-slate-900">
          Calculation audit / debug{' '}
          <span className="text-sm font-normal text-slate-500">
            — only needed when checking calculation consistency
          </span>
        </summary>
        <div className="px-5 md:px-6 pb-6 space-y-4">
          <p className="text-xs text-slate-500 leading-relaxed">
            Cross-checks Year Analysis&apos;s numbers against the same functions Dashboard/History use. Rows marked{' '}
            <span className="font-medium text-amber-600">Approximate / not directly reconcilable</span> have an
            explained, expected gap (usually cash exclusion or scope differences) — only{' '}
            <span className="font-medium text-rose-600">Mismatch</span> indicates an unexplained difference worth
            investigating further.
          </p>
          <AuditCheckCard check={audit.portfolioValueBridge} />
          <AuditCheckCard check={audit.profitLossBridge} />
          <AuditCheckCard check={audit.currentPlConsistency} />
          <AuditCheckCard check={audit.costBasisConsistency} />
          <AuditCheckCard check={audit.cashflowClassification} />
        </div>
      </details>

      <ul className="text-xs text-slate-400 leading-relaxed px-1 space-y-1 list-disc list-inside">
        <li>Cash is included in portfolio value, but excluded from investment P/L.</li>
        <li>Current open-position P/L uses current prices/FX, not historical prices.</li>
        <li>Growth after contributions is the selected-year euro result; Modified Dietz is the selected-year % return, adjusted for contribution timing.</li>
      </ul>
    </div>
  )
}
