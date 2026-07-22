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
  computeYearPortfolioSummary,
  computePortfolioBridgeData,
  computeAssetPnlRanking,
  computeYearVerdict,
  type PortfolioSnapshotForYear,
  type CapitalFlowEntryForYear,
  type AssetStatus,
} from '@/lib/domain/year-analysis'
import {
  PortfolioBridgeChart,
  AssetClassAllocationChart,
  AssetClassPnlChart,
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

export default async function YearAnalysisPage({
  searchParams,
}: {
  searchParams: Promise<{ year?: string }>
}) {
  const supabase = await createClient()

  const [invRes, txRes, fxRes, snapRes, flowRes] = await Promise.all([
    supabase.from('investments').select('*').returns<Investment[]>(),
    supabase.from('transactions').select('*').returns<Transaction[]>(),
    loadFxRates(supabase),
    supabase
      .from('portfolio_snapshots')
      .select('date, total_value_eur')
      .order('date', { ascending: true })
      .returns<PortfolioSnapshotForYear[]>(),
    supabase
      .from('capital_flow_entries')
      .select('year, flow_date, direction, amount_eur')
      .returns<CapitalFlowEntryForYear[]>(),
  ])

  const investments = invRes.data ?? []
  const transactions = txRes.data ?? []
  const fxRates = fxRes.rates
  const snapshots = snapRes.data ?? []
  const capitalFlowEntries = flowRes.data ?? []

  const availableYears = getAvailableYears(transactions)
  const { year: yearParam } = await searchParams
  const year = availableYears.includes(Number(yearParam))
    ? Number(yearParam)
    : availableYears[0]

  const liveTotalValueEur = computePortfolioMetrics(investments, transactions, fxRates).totalValue

  const assetRows = computeAssetYearRows(investments, transactions, year, fxRates)
  const classSummaries = computeAssetClassSummaries(assetRows)
  const summary = computeYearPortfolioSummary(
    year,
    assetRows,
    snapshots,
    capitalFlowEntries,
    transactions,
    liveTotalValueEur
  )
  const bridgeData = computePortfolioBridgeData(summary)
  const pnlRanking = computeAssetPnlRanking(assetRows)
  const verdict = computeYearVerdict(summary, classSummaries)

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

      {summary.valuationIsApproximate && (
        <div className="rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-800">
          Past-year unrealized P/L uses current prices unless historical snapshots/prices are available — {year}&apos;s
          quantities and cost basis are exact (from your transaction history), but they&apos;re valued at today&apos;s
          prices, not {year} year-end prices.
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
          hint="End minus start minus net contributions — a euro bridge figure, not a % return"
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
          hint="Approximate — weights contributions by how long they were invested"
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
          label="Realized P/L this year"
          value={signedMoney(summary.realizedPLInYearEur)}
          hint="Profit/loss locked in by sells (and interest/fees) this year"
          tone={summary.realizedPLInYearEur > 0 ? 'positive' : summary.realizedPLInYearEur < 0 ? 'negative' : 'neutral'}
        />
        <StatCard
          label={isCurrentYear ? 'Current unrealized P/L' : 'Unrealized P/L (approx.)'}
          value={signedMoney(summary.currentUnrealizedPLEur)}
          hint="Excludes cash — not necessarily generated inside this year, see note above"
          tone={summary.currentUnrealizedPLEur > 0 ? 'positive' : summary.currentUnrealizedPLEur < 0 ? 'negative' : 'neutral'}
        />
        <StatCard
          label="Total profit/loss"
          value={signedMoney(summary.totalPLEur)}
          hint={
            summary.totalProfitLossPercent !== null
              ? `${pctCell(summary.totalProfitLossPercent)} of current cost basis · realized this year + unrealized (excludes cash)`
              : 'Realized this year + unrealized (excludes cash)'
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

      {/* Top winners / losers */}
      <div className="bg-white rounded-2xl border border-slate-200 p-5 md:p-6">
        <h2 className="text-base font-semibold text-slate-900 mb-1">Top winners / losers — {year}</h2>
        <p className="text-sm text-slate-500 mb-3">Ranked by Total P/L. Cash excluded.</p>
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
                  <tr className="bg-slate-50 border-b border-slate-100 text-xs font-medium text-slate-500 uppercase tracking-wide">
                    <th className="text-left px-4 py-3 whitespace-nowrap">Class</th>
                    <th className="text-right px-4 py-3 whitespace-nowrap">Current value</th>
                    <th className="text-right px-4 py-3 whitespace-nowrap">Weight %</th>
                    <th className="text-right px-4 py-3 whitespace-nowrap">Bought</th>
                    <th className="text-right px-4 py-3 whitespace-nowrap">Sold</th>
                    <th className="text-right px-4 py-3 whitespace-nowrap">Realized P/L (year)</th>
                    <th className="text-right px-4 py-3 whitespace-nowrap">Unrealized P/L</th>
                    <th className="text-right px-4 py-3 whitespace-nowrap">Total P/L</th>
                    <th className="text-right px-4 py-3 whitespace-nowrap">Total P/L %</th>
                    <th className="text-right px-4 py-3 whitespace-nowrap">Fees</th>
                    <th className="text-right px-4 py-3 whitespace-nowrap">Div/interest</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-50">
                  {classSummaries.map((c) => (
                    <tr key={c.type} className="hover:bg-slate-50 transition-colors">
                      <td className="px-4 py-3 whitespace-nowrap font-medium text-slate-800">
                        {TYPE_LABELS[c.type] ?? c.type}
                        {c.isCashClass && (
                          <span className="ml-2 inline-flex items-center rounded-full bg-sky-50 px-2 py-0.5 text-xs font-medium text-sky-700 border border-sky-200">
                            Cash
                          </span>
                        )}
                      </td>
                      <td className="px-4 py-3 text-right tabular-nums whitespace-nowrap text-slate-900">
                        {money(c.currentValueEur, 'EUR')}
                      </td>
                      <td className="px-4 py-3 text-right tabular-nums whitespace-nowrap text-slate-500">
                        {c.pctOfPortfolio.toFixed(1)}%
                      </td>
                      <td className="px-4 py-3 text-right tabular-nums whitespace-nowrap">
                        {c.amountBoughtInYearEur > 0 ? money(c.amountBoughtInYearEur, 'EUR') : '—'}
                      </td>
                      <td className="px-4 py-3 text-right tabular-nums whitespace-nowrap">
                        {c.amountSoldInYearEur > 0 ? money(c.amountSoldInYearEur, 'EUR') : '—'}
                      </td>
                      <td className={`px-4 py-3 text-right tabular-nums whitespace-nowrap font-medium ${plClass(c.realizedPLInYearEur)}`}>
                        {plCell(c.realizedPLInYearEur)}
                      </td>
                      <td className={`px-4 py-3 text-right tabular-nums whitespace-nowrap font-medium ${plClass(c.currentUnrealizedPLEur)}`}>
                        {plCell(c.currentUnrealizedPLEur)}
                      </td>
                      <td className={`px-4 py-3 text-right tabular-nums whitespace-nowrap font-semibold ${plClass(c.totalPLEur)}`}>
                        {plCell(c.totalPLEur)}
                      </td>
                      <td className={`px-4 py-3 text-right tabular-nums whitespace-nowrap font-medium ${plClass(c.totalPLPercent)}`}>
                        {pctCell(c.totalPLPercent)}
                      </td>
                      <td className="px-4 py-3 text-right tabular-nums whitespace-nowrap text-slate-500">
                        {c.feesPaidInYearEur > 0 ? money(c.feesPaidInYearEur, 'EUR') : '—'}
                      </td>
                      <td className="px-4 py-3 text-right tabular-nums whitespace-nowrap text-slate-500">
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
                  <tr className="bg-slate-50 border-b border-slate-100 text-xs font-medium text-slate-500 uppercase tracking-wide">
                    <th className="text-left px-4 py-3 whitespace-nowrap sticky left-0 z-10 bg-slate-50">Asset</th>
                    <th className="text-left px-4 py-3 whitespace-nowrap">Platform</th>
                    <th className="text-left px-4 py-3 whitespace-nowrap">Type</th>
                    <th className="text-right px-4 py-3 whitespace-nowrap">Weight %</th>
                    <th className="text-right px-4 py-3 whitespace-nowrap">Bought</th>
                    <th className="text-right px-4 py-3 whitespace-nowrap">Sold</th>
                    <th className="text-right px-4 py-3 whitespace-nowrap">Realized P/L (year)</th>
                    <th className="text-right px-4 py-3 whitespace-nowrap">Unrealized P/L</th>
                    <th className="text-right px-4 py-3 whitespace-nowrap">Total P/L</th>
                    <th className="text-right px-4 py-3 whitespace-nowrap">Total P/L %</th>
                    <th className="text-right px-4 py-3 whitespace-nowrap">Current value</th>
                    <th className="text-left px-4 py-3 whitespace-nowrap">Status</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-50">
                  {assetRows.map((row) => (
                    <tr key={row.investmentId} className="hover:bg-slate-50 transition-colors">
                      <td className="px-4 py-3 whitespace-nowrap sticky left-0 z-10 bg-white">
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
                      <td className="px-4 py-3 whitespace-nowrap text-slate-700">{row.platform}</td>
                      <td className="px-4 py-3 whitespace-nowrap">
                        <span className="inline-flex items-center rounded-full bg-slate-100 px-2 py-0.5 text-xs font-medium text-slate-700">
                          {TYPE_LABELS[row.type] ?? row.type}
                        </span>
                      </td>
                      <td className="px-4 py-3 text-right tabular-nums whitespace-nowrap text-slate-500">
                        {row.portfolioWeightPct !== null ? `${row.portfolioWeightPct.toFixed(1)}%` : '—'}
                      </td>
                      <td className="px-4 py-3 text-right tabular-nums whitespace-nowrap">
                        {row.amountBoughtInYearEur > 0 ? money(row.amountBoughtInYearEur, 'EUR') : '—'}
                      </td>
                      <td className="px-4 py-3 text-right tabular-nums whitespace-nowrap">
                        {row.amountSoldInYearEur > 0 ? money(row.amountSoldInYearEur, 'EUR') : '—'}
                      </td>
                      <td className={`px-4 py-3 text-right tabular-nums whitespace-nowrap font-medium ${plClass(row.realizedPLInYearEur)}`}>
                        {plCell(row.realizedPLInYearEur)}
                      </td>
                      <td className={`px-4 py-3 text-right tabular-nums whitespace-nowrap font-medium ${plClass(row.currentUnrealizedPLEur)}`}>
                        {plCell(row.currentUnrealizedPLEur)}
                      </td>
                      <td className={`px-4 py-3 text-right tabular-nums whitespace-nowrap font-semibold ${plClass(row.totalPLEur)}`}>
                        {plCell(row.totalPLEur)}
                      </td>
                      <td className={`px-4 py-3 text-right tabular-nums whitespace-nowrap font-medium ${plClass(row.totalPLPercent)}`}>
                        {pctCell(row.totalPLPercent)}
                      </td>
                      <td className="px-4 py-3 text-right tabular-nums whitespace-nowrap text-slate-900">
                        {money(row.currentValueEur, 'EUR')}
                      </td>
                      <td className="px-4 py-3 whitespace-nowrap">
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

      <p className="text-xs text-slate-400 leading-relaxed px-1">
        <span className="font-medium text-slate-500">Notes: </span>
        Current value and unrealized P/L use current FX rates, not historical FX. Cash balances are excluded from
        investment P/L — cash-like holdings (uninvested broker cash / free-space balances) show current value and
        cash movements only, never unrealized or total P/L, since a cash balance isn&apos;t investment profit.
        &quot;Growth after contributions&quot; removes net contributions from the portfolio value change; its Modified
        Dietz % weights each contribution/withdrawal by how long it was actually invested during the year, but it is
        still an approximation, not an exact investment return. Net contributions counts only money moved between
        your bank/income and portfolio platforms — reinvestments and reallocations between assets or platforms are
        excluded. Percentages that depend on cost basis or start-of-year value show{' '}
        <span className="whitespace-nowrap">—</span> when that denominator is missing, zero, or unreliable, rather
        than a misleading number.
      </p>
    </div>
  )
}
