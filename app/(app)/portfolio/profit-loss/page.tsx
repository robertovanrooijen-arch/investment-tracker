import Link from 'next/link'
import { createClient } from '@/lib/supabase/server'
import { fetchAllInvestments, fetchAllTransactions } from '@/lib/supabase/fetch-user-data'
import { fetchAllRows } from '@/lib/supabase/fetch-all-rows'
import { PageHeader } from '@/components/ui/page-header'
import { DataQualityNotice } from '@/components/ui/data-quality-notice'
import { unfundedPlatforms } from '@/lib/domain/reconciliation'
import { StatCard } from '@/components/ui/stat-card'
import { PrivacyMoney, PrivacyGate } from '@/components/ui/privacy-value'
import { AssetClassPerformanceTable } from '@/components/profit-loss/asset-class-performance-table'
import type { ClassPerformanceRow } from '@/components/profit-loss/asset-class-performance-table'
import { YtdBridgeBar } from '@/components/profit-loss/ytd-bridge-bar'
import { computeInvestmentMetrics, computePortfolioMetrics, computePerformanceByCategory } from '@/lib/domain/calculations'
import { hasUnits, isCashLikeInvestment } from '@/lib/domain/constants'
import { PositionReturnsTable, type PositionReturnRow } from '@/components/profit-loss/position-returns-table'
import { categoryLabel } from '@/lib/domain/allocation'
import { loadFxRates } from '@/lib/domain/fx'
import { money } from '@/lib/format'
import { loadReturns } from '@/lib/returns/load-returns'
import {
  computeAssetYearRows,
  computeAssetClassYtd,
  computeYearPortfolioSummary,
} from '@/lib/domain/year-analysis'
import type { CapitalFlowEntryForYear, InvestmentSnapshotForYtd } from '@/lib/domain/year-analysis'
import type { InvestmentType } from '@/types/database'

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

export default async function ProfitLossDetailsPage() {
  const supabase = await createClient()
  const year = new Date().getFullYear()
  const todayIso = new Date().toISOString().slice(0, 10)

  const [invRes, txRes, fxRes, snapRes, flowRes, invSnapRes, returnsData] = await Promise.all([
    fetchAllInvestments(supabase),
    fetchAllTransactions(supabase),
    loadFxRates(supabase),
    supabase
      .from('portfolio_snapshots')
      .select('date, total_value_eur')
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
        .select('date, investment_id, value_eur, investment:investments(id, type)')
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

  // ── A. Total performance — the same canonical result and XIRR used by
  // Dashboard, Returns and YTD. The legacy metrics remain only as a fallback
  // when a historical source is incomplete.
  const liveMetrics = computePortfolioMetrics(investments, transactions, fxRates)
  const mwr = returnsData.xirr
  const canonicalResult = returnsData.investmentResult
  const totalResult = canonicalResult?.sinceStart.totalEur ?? liveMetrics.totalProfit
  const realisedResult = canonicalResult?.sinceStart.realisedEur ?? liveMetrics.totalRealized
  const unrealisedResult = canonicalResult?.sinceStart.unrealisedEndEur ?? liveMetrics.totalUnrealized

  // Realized (sold) and unrealized (held) result per position.
  const positionRows: PositionReturnRow[] = investments
    .filter((inv) => !isCashLikeInvestment(inv) && hasUnits(inv.type))
    .map((inv) => {
      const m = computeInvestmentMetrics(inv, transactions, fxRates)
      return {
        id: inv.id,
        name: inv.name,
        platform: inv.platform,
        isClosed: m.isClosed,
        soldCostEur: m.soldCostBasis,
        saleProceedsEur: m.saleProceeds,
        tradeRealizedEur: m.tradeRealizedProfit,
        realizedReturnPct: m.realizedReturnPct,
        incomeAndFeesEur: m.incomeNet - m.separateFees,
        remainingCostEur: m.remainingCostBasis,
        currentValueEur: m.currentValue,
        unrealizedEur: m.unrealizedProfit,
        unrealizedReturnPct: m.unrealizedReturnPct,
      }
    })
    .sort((a, b) => b.tradeRealizedEur + b.unrealizedEur - (a.tradeRealizedEur + a.unrealizedEur))

  // Unrealized return on remaining cost per asset class (open, non-cash
  // positions). Plain sums: an unknown figure makes the class unknown.
  const unrealizedByClass = new Map<string, { unrealized: number; cost: number }>()
  for (const inv of investments) {
    if (isCashLikeInvestment(inv)) continue
    const m = computeInvestmentMetrics(inv, transactions, fxRates)
    if (m.isClosed || !(m.remainingCostBasis > 0 || Number.isNaN(m.remainingCostBasis))) continue
    const b = unrealizedByClass.get(inv.type) ?? { unrealized: 0, cost: 0 }
    b.unrealized += m.unrealizedProfit
    b.cost += m.remainingCostBasis
    unrealizedByClass.set(inv.type, b)
  }

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
      return {
        key: type,
        label: categoryLabel(type),
        ytdReturnPercent: ytd?.returnPercent ?? null,
        ytdUnavailableReason: ytd?.percentUnavailableReason ?? null,
        unrealizedReturnPercent: (() => {
          const b = unrealizedByClass.get(type)
          return b && Number.isFinite(b.unrealized) && b.cost > 0 ? (b.unrealized / b.cost) * 100 : null
        })(),
      }
    })
    .sort((a, b) => (b.unrealizedReturnPercent ?? -Infinity) - (a.unrealizedReturnPercent ?? -Infinity))

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

      <DataQualityNotice
        fxIncompleteCount={Math.max(liveMetrics.fxIncompleteCount, yearSummary.fxIncompleteCount)}
        fxLiveFallbackCount={liveMetrics.fxLiveFallbackCount}
        legacyContributionsSkippedFx={yearSummary.legacyContributionsSkippedFx}
        unfundedPlatforms={unfundedPlatforms(investments, transactions, capitalFlowEntries, fxRates)}
      />

      {/* A. Total performance */}
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
        <StatCard
          label="Total investment result"
          value={
            <PrivacyMoney
              value={totalResult}
              signed
              fallbackText={mwr.annualRate !== null ? `${fmtPercent(mwr.annualRate * 100)} / yr XIRR` : '—'}
            />
          }
          hint={
            <>
              Realised and unrealised result, dividends and interest, minus separate costs and taxes.{' '}
              {mwr.annualRate !== null
                ? `Your personal money-weighted return (XIRR): ${fmtPercent(mwr.annualRate * 100)} per year.`
                : `No XIRR: ${mwr.unavailableReason ?? 'not enough data'}`}
            </>
          }
          tone={tone(totalResult)}
        />
        <StatCard
          label="Realized"
          value={
            <PrivacyMoney
              value={realisedResult}
              signed
              fallbackText="Closed and partly sold positions"
            />
          }
          tone={tone(realisedResult)}
        />
        <StatCard
          label="Unrealized"
          value={
            <PrivacyMoney
              value={unrealisedResult}
              signed
              fallbackText="Open positions"
            />
          }
          tone={tone(unrealisedResult)}
        />
      </div>

      {/* B. YTD performance */}
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
        <StatCard
          label={`Investment result YTD (${year})`}
          value={
            <PrivacyMoney
              value={canonicalResult?.period.totalEur ?? yearSummary.growthExcludingContributionsEur}
              signed
              fallbackText={returnsData.ytd.twr === null ? '—' : fmtPercent(returnsData.ytd.twr * 100)}
            />
          }
          hint={
            returnsData.ytd.twr !== null ? (
              <PrivacyGate>
                <>{fmtPercent(returnsData.ytd.twr * 100)} · time-weighted return, since Jan 1</>
              </PrivacyGate>
            ) : (
              returnsData.ytd.missing[0]?.reason ?? 'No reliable historical valuation yet'
            )
          }
          tone={tone(canonicalResult?.period.totalEur ?? yearSummary.growthExcludingContributionsEur)}
        />
        <StatCard
          label="Own money added YTD"
          value={<PrivacyMoney value={returnsData.contributionsYtd.grossOwnContributionsEur} fallbackText="—" />}
          hint={`${money(returnsData.contributionsYtd.grossPlatformContributionsEur, 'EUR')} platform-funded · re-used sale proceeds excluded`}
        />
      </div>

      {/* C. Performance per asset class */}
      <div className="bg-white rounded-2xl border border-slate-200 p-5 md:p-6">
        <h2 className="text-base font-semibold text-slate-900 mb-1">Performance by asset class</h2>
        <p className="text-sm text-slate-500 mb-4">
          Portfolio YTD uses the same time-weighted engine as Returns. The rows below show each asset class on its
          own historical basis. Cash is excluded from the asset-class comparison.
        </p>
        <AssetClassPerformanceTable rows={classRows} />
      </div>

      <div>
        <PositionReturnsTable rows={positionRows} />
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
