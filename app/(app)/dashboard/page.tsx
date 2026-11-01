import Link from 'next/link'
import { createClient } from '@/lib/supabase/server'
import { fetchAllInvestments, fetchAllTransactions } from '@/lib/supabase/fetch-user-data'
import { PageHeader } from '@/components/ui/page-header'
import { DataQualityNotice } from '@/components/ui/data-quality-notice'
import { unfundedPlatforms } from '@/lib/domain/reconciliation'
import { StatCard } from '@/components/ui/stat-card'
import { BrokerCashNote } from '@/components/ui/broker-cash-note'
import { PortfolioBreakdownCharts } from '@/components/history/portfolio-breakdown-charts'
import { RecentTransactions } from '@/components/dashboard/recent-transactions'
import { RefreshPortfolioButton } from '@/components/dashboard/refresh-portfolio-button'
import { PrivacyMoney, PrivacyValue, PrivacyGate } from '@/components/ui/privacy-value'
import { money } from '@/lib/format'
import { pct } from '@/lib/domain/calculations'
import { allocationSlices } from '@/lib/domain/current-valuation'
import { loadFxRates } from '@/lib/domain/fx'
import { normalizePlatformName } from '@/lib/domain/constants'
import { todayLocalIso, computeDailyChange, type DailyChange } from '@/lib/domain/snapshot'
import type { Transaction, InvestmentType, CapitalFlowEntry } from '@/types/database'
import { fetchAllRows } from '@/lib/supabase/fetch-all-rows'
import { loadReturns } from '@/lib/returns/load-returns'

type TxWithInvestment = Transaction & {
  investment: {
    name: string
    ticker: string | null
    type: InvestmentType
  } | null
}

function dailyChangeText(change: DailyChange): string {
  if (!change) return 'No previous day value'
  const sign = change.value > 0 ? '+' : ''
  const pctText =
    change.percent !== null
      ? ` (${change.percent > 0 ? '+' : ''}${change.percent.toFixed(2)}%)`
      : ''
  return `Today: ${sign}${money(change.value, 'EUR')}${pctText}`
}

function dailyChangePrivacyText(change: DailyChange): string {
  if (!change) return 'No previous day value'
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

  const [invRes, txRes, recentRes, fxRes, latestSnapRes, flowRes, returnsData] = await Promise.all([
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
    fetchAllRows<CapitalFlowEntry>((from, to) =>
      supabase.from('capital_flow_entries').select('*').order('id', { ascending: true }).range(from, to).returns<CapitalFlowEntry[]>()
    ),
    loadReturns(supabase, todayIso),
  ])

  const investments = invRes.data ?? []
  const transactions = txRes.data ?? []
  const recent = recentRes.data ?? []
  const fxRates = fxRes.rates
  const latestSnap = latestSnapRes.data as { updated_at: string } | null
  const lastRefreshedAt = latestSnap?.updated_at ?? null

  // ONE source for every headline figure: the central valuation and returns
  // engine (lib/returns/load-returns). No local recomputation, no fallback.
  const h = returnsData.headline
  const valuation = returnsData.valuation
  const mwr = returnsData.xirr
  const dailyChange: DailyChange =
    h.currentValueEur !== null && h.previousDayValueEur !== null
      ? computeDailyChange(h.currentValueEur, { total_value_eur: h.previousDayValueEur })
      : null

  const byCategory = allocationSlices(valuation, (p) => p.type)
  const byPlatform = allocationSlices(valuation, (p) => normalizePlatformName(p.platform))

  const totalResult = h.totalResultSinceStartEur
  const profitTone: 'positive' | 'negative' | 'neutral' =
    totalResult === null ? 'neutral' : totalResult > 0 ? 'positive' : totalResult < 0 ? 'negative' : 'neutral'

  const isEmpty = investments.length === 0
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
        unfundedPlatforms={unfundedPlatforms(investments, transactions, flowRes.data ?? [], fxRates)}
      />
      {!h.resultsAvailable && (
        <p className="rounded-xl border border-rose-200 bg-rose-50 px-4 py-3 text-sm text-rose-900">
          Returns and results are not shown: {h.resultsUnavailableReason}{' '}
          <Link href="/returns" className="underline">See every missing source</Link>.
        </p>
      )}

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
              value={<PrivacyMoney value={h.currentValueEur} fallbackText="—" />}
              hint={
                h.currentValueEur === null ? (
                  <span className="text-rose-700">{h.currentValueUnavailableReason}</span>
                ) : (
                  <>
                    <BrokerCashNote cash={h.brokerCash} />
                    <br />
                    <span className={dailyChangeClass(dailyChange)}>
                      <PrivacyValue
                        amount={dailyChangeText(dailyChange)}
                        privacyFallback={dailyChangePrivacyText(dailyChange)}
                      />
                    </span>
                  </>
                )
              }
            />
            <StatCard
              label="Cost of open positions"
              value={<PrivacyMoney value={h.costOfOpenPositionsEur} fallbackText="—" />}
              hint="Remaining purchase cost (incl. fees) of what you still hold. Not your contributions."
            />
            <StatCard
              label="Investment result"
              value={<PrivacyMoney value={totalResult} signed fallbackText="—" />}
              hint={
                totalResult === null ? (
                  <span className="text-slate-500">— {h.resultsUnavailableReason}</span>
                ) : (
                  <>
                    <PrivacyGate>
                      <>
                        {money(h.realisedSinceStartEur ?? 0, 'EUR')} realised ·{' '}
                        {money(h.unrealisedNowEur ?? 0, 'EUR')} unrealised
                      </>
                    </PrivacyGate>
                    <br />
                    <span className="text-slate-400">Since start, incl. dividends and interest, minus separate costs and taxes.</span>
                  </>
                )
              }
              tone={profitTone}
            />
            <StatCard
              label="Your personal return (XIRR)"
              value={h.xirrAnnualRate !== null ? `${h.xirrAnnualRate >= 0 ? '+' : ''}${pct(h.xirrAnnualRate)} / yr` : '—'}
              hint={
                <>
                  Your annualised return, based on the actual dates when money entered or left your portfolio.
                  <br />
                  {h.xirrAnnualRate !== null && (
                    <PrivacyGate fallback="Money-weighted, annualised.">
                      <>
                        The calculation uses {money(mwr.grossInEur, 'EUR')} entering and{' '}
                        {money(mwr.grossOutEur, 'EUR')} leaving on their real dates. Selling and reinvesting inside the portfolio is not a contribution.
                      </>
                    </PrivacyGate>
                  )}
                  {h.twrYtd !== null && (
                    <>
                      <br />
                      <Link href="/returns" className="underline">
                        Portfolio return YTD: {h.twrYtd >= 0 ? '+' : ''}{(h.twrYtd * 100).toFixed(2)}% (time-weighted)
                      </Link>
                    </>
                  )}
                  {mwr.unavailableReason && (
                    <>
                      <br />
                      <span className="text-amber-700">{mwr.unavailableReason}</span>
                    </>
                  )}
                </>
              }
              tone={h.xirrAnnualRate === null ? 'neutral' : h.xirrAnnualRate >= 0 ? 'positive' : 'negative'}
            />
          </div>
          <p className="text-xs text-slate-400 px-1">
            Broker cash is not an investment position. It stays in the return calculation (sales and re-investments move through it).
          </p>

          <PortfolioBreakdownCharts
            byCategory={byCategory}
            byPlatform={byPlatform}
            result={{
              realisedEur: h.realisedSinceStartEur,
              unrealisedEur: h.unrealisedNowEur,
              totalEur: h.totalResultSinceStartEur,
              unavailableReason: h.resultsUnavailableReason,
            }}
          />

          <RecentTransactions transactions={recent} />
        </>
      )}
    </div>
  )
}
