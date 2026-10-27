import { createClient } from '@/lib/supabase/server'
import { fetchAllRows } from '@/lib/supabase/fetch-all-rows'
import { PageHeader } from '@/components/ui/page-header'
import { StatCard } from '@/components/ui/stat-card'
import { PrivacyMoney } from '@/components/ui/privacy-value'
import { loadFxRates } from '@/lib/domain/fx'
import { computePortfolioMetrics } from '@/lib/domain/calculations'
import { isCashLikeInvestment } from '@/lib/domain/constants'
import {
  computeAssetYearRows,
  computeInvestmentYtdRows,
  computeYearPortfolioSummary,
} from '@/lib/domain/year-analysis'
import type { InvestmentSnapshotForYtd, CapitalFlowEntryForYear } from '@/lib/domain/year-analysis'
import { fetchMarketYtdCloses, computeMarketYtdPercent } from '@/lib/domain/market-ytd'
import { buildInvestmentChartTimeline } from '@/lib/domain/chart-timeline'
import { PerformanceTable } from '@/components/investment-performance/performance-table'
import type { PerformanceRow } from '@/components/investment-performance/performance-table'
import { MarketYtdBarChart } from '@/components/investment-performance/market-ytd-bar-chart'
import { InvestmentHistorySection } from '@/components/investment-performance/investment-history-section'
import type { Investment, Transaction } from '@/types/database'

export const dynamic = 'force-dynamic'

type SnapshotForSummary = { date: string; total_value_eur: number }
type RawInvestmentSnapshot = {
  investment_id: string
  date: string
  value_eur: number | string
  quantity: number | string | null
}

export default async function InvestmentPerformancePage() {
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
      .select('date, total_value_eur')
      .order('date', { ascending: true })
      .returns<SnapshotForSummary[]>(),
    supabase
      .from('capital_flow_entries')
      .select('year, flow_date, direction, amount_eur')
      .returns<CapitalFlowEntryForYear[]>(),
    // All per-investment snapshots for this user — reused for two different
    // purposes below: (1) source-backed year-start valuations (date <=
    // yearStartIso), same mechanism computeInvestmentYtdRows already
    // supports; (2) the full per-investment history chart timeline.
    fetchAllRows<RawInvestmentSnapshot>((from, to) =>
      supabase
        .from('investment_snapshots')
        .select('investment_id, date, value_eur, quantity')
        .order('date', { ascending: true })
        .order('investment_id', { ascending: true })
        .range(from, to)
        .returns<RawInvestmentSnapshot[]>()
    ),
  ])

  const investments = invRes.data ?? []
  const transactions = txRes.data ?? []
  const fxRates = fxRes.rates
  const portfolioSnapshots = snapRes.data ?? []
  const capitalFlowEntries = flowRes.data ?? []
  const allInvSnapshots = invSnapRes.data ?? []

  const ytdStartSnapshots: InvestmentSnapshotForYtd[] = allInvSnapshots
    .filter((s) => s.date <= yearStartIso)
    .map((s) => ({ investment_id: s.investment_id, date: s.date, value_eur: Number(s.value_eur) }))

  const snapshotsByInvestmentId = new Map<string, { date: string; value_eur: number; quantity: number | null }[]>()
  for (const s of allInvSnapshots) {
    const list = snapshotsByInvestmentId.get(s.investment_id) ?? []
    list.push({ date: s.date, value_eur: Number(s.value_eur), quantity: s.quantity != null ? Number(s.quantity) : null })
    snapshotsByInvestmentId.set(s.investment_id, list)
  }

  const liveMetrics = computePortfolioMetrics(investments, transactions, fxRates)
  const assetRows = computeAssetYearRows(investments, transactions, year, fxRates)
  const assetRowById = new Map(assetRows.map((r) => [r.investmentId, r]))
  const ytdRows = computeInvestmentYtdRows(investments, transactions, year, fxRates, ytdStartSnapshots)
  const ytdRowById = new Map(ytdRows.map((r) => [r.investmentId, r]))
  const summary = computeYearPortfolioSummary(
    year,
    assetRows,
    portfolioSnapshots,
    capitalFlowEntries,
    transactions,
    liveMetrics.totalValue
  )

  // Market YTD: real historical closes fetched live from Yahoo (same source
  // lib/domain/yahoo-price.ts uses for "now"), never derived from the EUR
  // snapshot values above — see lib/domain/market-ytd.ts for why those two
  // data sources can't substitute for each other. Cash-like and ticker-less
  // investments are skipped; a ticker that fails to fetch reports null, not
  // a guess.
  const tickers = investments
    .filter((inv) => !isCashLikeInvestment(inv) && inv.ticker)
    .map((inv) => inv.ticker as string)
  const marketYtdCloses = await fetchMarketYtdCloses(tickers, yearStartIso)

  const rows: PerformanceRow[] = investments
    .filter((inv) => !isCashLikeInvestment(inv))
    .map((inv) => {
      const assetRow = assetRowById.get(inv.id) ?? null
      const ytd = ytdRowById.get(inv.id) ?? null
      const historicalClose = inv.ticker ? marketYtdCloses.get(inv.ticker) ?? null : null
      const marketYtdPercent = computeMarketYtdPercent(inv.current_price, historicalClose?.closeNative ?? null)

      return {
        inv,
        marketYtdPercent,
        marketYtdAsOfDate: historicalClose?.asOfDateIso ?? null,
        startValueEur: ytd?.startValueEur ?? null,
        amountBoughtInYearEur: assetRow?.amountBoughtInYearEur ?? 0,
        amountSoldInYearEur: assetRow?.amountSoldInYearEur ?? 0,
        currentValueEur: assetRow?.currentValueEur ?? 0,
        ytdGrowthEur: ytd?.ytdGrowthEur ?? null,
        ytdReturnPercent: ytd?.ytdReturnPercent ?? null,
        unavailableReason: ytd?.unavailableReason ?? null,
        percentUnavailableReason: ytd?.percentUnavailableReason ?? null,
        portfolioWeightPct: assetRow?.portfolioWeightPct ?? null,
        // computeAssetYearRows drops a holding entirely once it has neither
        // activity in `year` nor any value left — e.g. a position fully
        // exited in a PRIOR year that's simply been dormant ever since.
        // That's correct for the year-scoped engine, but on this page it
        // means `assetRow` is null here — used to split these out of the
        // main comparison table instead of showing a confusing all-zero row.
        hasActivityThisYear: assetRow !== null,
      }
    })

  const chartPointsByInvestmentId: Record<string, ReturnType<typeof buildInvestmentChartTimeline>> = {}
  for (const inv of investments) {
    if (isCashLikeInvestment(inv)) continue
    const m = assetRowById.get(inv.id)
    // buildInvestmentChartTimeline filters to this investment's own
    // transactions internally, so passing the full portfolio list here is
    // safe — see lib/domain/chart-timeline.ts.
    chartPointsByInvestmentId[inv.id] = buildInvestmentChartTimeline(
      inv,
      transactions,
      snapshotsByInvestmentId.get(inv.id) ?? [],
      {
        currentValue: m?.currentValueEur ?? 0,
        remainingCostBasis: m?.remainingCostBasisEur ?? 0,
        unrealizedProfit: m?.currentUnrealizedPLEur ?? 0,
      },
      todayIso,
      fxRates
    )
  }

  const chartableInvestments = investments.filter(
    (inv) => !isCashLikeInvestment(inv) && (chartPointsByInvestmentId[inv.id]?.length ?? 0) > 1
  )

  return (
    <div className="space-y-6">
      <PageHeader
        title="Investment Performance"
        subtitle={`Compare market return vs. your own position return, year-to-date (${year}). Values in EUR.`}
      />

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <StatCard
          label="Total portfolio value"
          value={<PrivacyMoney value={liveMetrics.totalValue} fallbackText="—" />}
        />
        <StatCard
          label="Total buys YTD"
          value={<PrivacyMoney value={summary.totalBuysEur} fallbackText="—" />}
        />
        <StatCard
          label="Net cashflows YTD"
          value={<PrivacyMoney value={summary.netContributionsEur} signed fallbackText="—" />}
          hint="External money in minus out — not investment performance."
        />
        <StatCard
          label="Investment result YTD"
          value={
            <PrivacyMoney
              value={summary.growthExcludingContributionsEur}
              signed
              fallbackText={summary.modifiedDietzReturnPercent !== null ? `${summary.modifiedDietzReturnPercent >= 0 ? '+' : ''}${summary.modifiedDietzReturnPercent.toFixed(1)}%` : '—'}
            />
          }
          tone={
            summary.growthExcludingContributionsEur === null
              ? 'neutral'
              : summary.growthExcludingContributionsEur > 0
                ? 'positive'
                : summary.growthExcludingContributionsEur < 0
                  ? 'negative'
                  : 'neutral'
          }
          hint="Value change with contributions backed out. Accuracy depends on every deposit being correctly tagged as external — see Methodology below."
        />
      </div>

      {rows.length === 0 ? (
        <div className="bg-white rounded-2xl border border-slate-200 p-10 text-center">
          <p className="text-slate-900 font-medium">No investments to compare yet</p>
          <p className="text-sm text-slate-500 mt-1">
            Add a stock, ETF, crypto, or commodity position to see it here.
          </p>
        </div>
      ) : (
        <>
          <MarketYtdBarChart rows={rows} />
          <PerformanceTable rows={rows} year={year} />
          {chartableInvestments.length > 0 && (
            <InvestmentHistorySection
              investments={chartableInvestments}
              chartPointsByInvestmentId={chartPointsByInvestmentId}
            />
          )}
          <MethodologyNote year={year} />
        </>
      )}
    </div>
  )
}

function MethodologyNote({ year }: { year: number }) {
  return (
    <details className="group rounded-2xl border border-slate-200 bg-white p-5 md:p-6">
      <summary className="cursor-pointer text-sm font-medium text-slate-700 [&::-webkit-details-marker]:hidden">
        Methodology &amp; known limitations
      </summary>
      <div className="mt-3 space-y-2 text-sm text-slate-600">
        <p>
          <span className="font-medium text-slate-900">Market YTD</span> is the security&apos;s
          own price return since its last close on/before Jan 1, {year}, fetched live and shown
          in the ticker&apos;s own trading currency. It uses the split-adjusted close, but is not
          a total return — dividends are not added back unless the data source happens to
          include them.
        </p>
        <p>
          <span className="font-medium text-slate-900">Personal YTD</span> is a Modified Dietz
          (time-weighted) return on your own position, reusing the same calculation as the
          Investments and Year Analysis pages — never a naive profit ÷ money-in ratio. A
          position bought only recently can show a percentage that looks extreme (even beyond
          ±100%) if its price has already moved a lot relative to how little time it&apos;s been
          held — that is mathematically correct, not a display bug.
        </p>
        <p>
          <span className="font-medium text-slate-900">Personal YTD % can read &quot;—&quot;</span>{' '}
          while the € result still shows a real number. This happens when there isn&apos;t a
          reliable capital base to express a percentage against — e.g. a position opened only a
          few days ago, where the time-weighted denominator is too small for the result to be
          numerically stable.
        </p>
        <p>
          <span className="font-medium text-slate-900">Net cashflows / Investment result YTD</span>{' '}
          only count a transaction as external money when it is explicitly tagged as a
          contribution. If a real deposit-funded purchase is missing that tag, this total will
          understate contributions and correspondingly overstate the investment result — this is
          a data-tagging question, not a calculation error, and is shared with the Dashboard and
          Year Analysis pages.
        </p>
        <p>
          The same ticker can appear more than once when you hold it on different platforms
          (e.g. a savings plan on one broker and a separate lump-sum position on another) — these
          are tracked as genuinely separate positions, never merged.
        </p>
      </div>
    </details>
  )
}
