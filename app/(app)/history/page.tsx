import { createClient } from '@/lib/supabase/server'
import { fetchAllInvestments, fetchAllTransactions } from '@/lib/supabase/fetch-user-data'
import { fetchAllRows } from '@/lib/supabase/fetch-all-rows'
import { PageHeader } from '@/components/ui/page-header'
import { CURRENT_PL_DEFINITION_VERSION } from '@/lib/domain/snapshot-method'
import { StatCard } from '@/components/ui/stat-card'
import { BrokerCashNote } from '@/components/ui/broker-cash-note'
import { PortfolioHistoryChart } from '@/components/history/portfolio-history-chart'
import { BreakdownChart } from '@/components/history/breakdown-chart'
import type { BreakdownSnapshot, BreakdownEntity } from '@/components/history/breakdown-chart'
import Link from 'next/link'
import { fmtDate, money } from '@/lib/format'
import { todayLocalIso } from '@/lib/domain/snapshot'
import { categoryLabel } from '@/lib/domain/allocation'
import { PrivacyMoney, PrivacyGate } from '@/components/ui/privacy-value'
import type { InvestmentType } from '@/types/database'
import type { LivePoint } from '@/components/history/portfolio-history-chart'
import { loadReturns } from '@/lib/returns/load-returns'

export const dynamic = 'force-dynamic'

// Color palette shared across asset and platform entity lists
const PALETTE = [
  '#3b82f6', '#8b5cf6', '#f59e0b', '#10b981', '#ef4444',
  '#f97316', '#06b6d4', '#ec4899', '#84cc16', '#6366f1',
  '#14b8a6', '#a78bfa',
]

const TYPE_COLORS: Record<string, string> = {
  stock:         '#3b82f6',
  ETF:           '#8b5cf6',
  crypto:        '#f59e0b',
  cash:          '#10b981',
  'real estate': '#ef4444',
  commodity:     '#d97706',
  custom:        '#6b7280',
}

type PortfolioSnapshotRow = {
  date: string
  total_value_eur: number
  total_invested_eur: number | null
  total_unrealized_eur: number | null
  total_realized_eur: number | null
  snapshot_source: string
  pl_definition_version: number | null
}

type DetailedInvSnapshotRow = {
  date: string
  investment_id: string
  value_eur: number
  remaining_cost_basis_eur: number
  realized_profit_eur: number
  unrealized_profit_eur: number
  investment: { id: string; name: string; type: InvestmentType; platform: string } | null
}

export default async function HistoryPage() {
  const supabase = await createClient()
  const todayIso = todayLocalIso()

  const [portfolioRes, invSnapshotRes, invRes, txRes, returnsData] = await Promise.all([
    supabase
      .from('portfolio_snapshots')
      // '*' so pl_definition_version is included once migration M7 adds it.
      .select('*')
      .order('date', { ascending: true }),
    fetchAllRows<DetailedInvSnapshotRow>((from, to) =>
      supabase
        .from('investment_snapshots')
        .select('date, investment_id, value_eur, remaining_cost_basis_eur, realized_profit_eur, unrealized_profit_eur, investment:investments(id, name, type, platform)')
        .order('date', { ascending: true })
        .order('investment_id', { ascending: true })
        .range(from, to)
        .returns<DetailedInvSnapshotRow[]>()
    ),
    fetchAllInvestments(supabase),
    fetchAllTransactions(supabase),
    loadReturns(supabase, todayIso),
  ])

  // Postgres `numeric` columns can come back as strings via supabase-js; coerce.
  const rawPortfolioSnapshots: PortfolioSnapshotRow[] = (portfolioRes.data ?? []).map((row) => ({
    date: String(row.date),
    total_value_eur: Number(row.total_value_eur),
    total_invested_eur: row.total_invested_eur == null ? null : Number(row.total_invested_eur),
    total_unrealized_eur: row.total_unrealized_eur == null ? null : Number(row.total_unrealized_eur),
    total_realized_eur: row.total_realized_eur == null ? null : Number(row.total_realized_eur),
    snapshot_source: String(row.snapshot_source ?? ''),
    pl_definition_version: row.pl_definition_version == null ? null : Number(row.pl_definition_version),
  }))

  // Normalise detailed investment snapshot rows
  const rawDetailedInvSnapshots = (invSnapshotRes.data ?? [])
    .filter((row) => row.investment != null)
    .map((row) => ({
      date: String(row.date),
      investment_id: String(row.investment_id),
      value_eur: Number(row.value_eur),
      cost_basis_eur: Number(row.remaining_cost_basis_eur),
      pl_eur: Number(row.realized_profit_eur ?? 0) + Number(row.unrealized_profit_eur ?? 0),
      name: row.investment!.name,
      type: row.investment!.type,
      platform: row.investment!.platform,
    }))

  // Backward-compatible per-type rows for PortfolioHistoryChart
  const rawInvSnapshots = rawDetailedInvSnapshots.map((row) => ({
    date: row.date,
    value_eur: row.value_eur,
    remaining_cost_basis_eur: row.cost_basis_eur,
    type: row.type,
  }))

  // ── Today: the CENTRAL current valuation and result (same as Dashboard) ────
  const investments = invRes.data ?? []
  const transactions = txRes.data ?? []
  const h = returnsData.headline
  const valuation = returnsData.valuation
  const resultRows = new Map(
    (returnsData.investmentResult?.sinceStart.byInvestment ?? []).map((r) => [r.investmentId, r])
  )
  const valueById = new Map(valuation.positions.map((p) => [p.investmentId, p]))
  // Per-investment figures for today, only when value AND result are complete.
  const todayAvailable = h.currentValueEur !== null && h.resultsAvailable
  const todayRows = investments
    .filter((inv) => transactions.some((t) => t.investment_id === inv.id))
    .map((inv) => {
      const v = valueById.get(inv.id)
      const r = resultRows.get(inv.id)
      return {
        inv,
        valueEur: v?.valueEur ?? 0,
        costEur: v?.remainingCostEur ?? 0,
        plEur: r?.totalEur ?? 0,
      }
    })

  const byTypeMap = new Map<string, number>()
  for (const p of valuation.positions) byTypeMap.set(p.type, (byTypeMap.get(p.type) ?? 0) + (p.valueEur ?? 0))

  const livePoint: LivePoint | undefined = h.currentValueEur === null ? undefined : {
    date: todayIso,
    totalValue: h.currentValueEur,
    totalInvested: valuation.costOfOpenPositionsEur,
    totalUnrealized: h.unrealisedNowEur ?? 0,
    totalRealized: h.realisedSinceStartEur ?? 0,
    byType: Array.from(byTypeMap.entries()).map(([type, value]) => ({
      type: type as InvestmentType,
      value,
    })),
  }

  // Today's point = exactly the central current value. Profit/loss lines stay
  // empty for today: the stored snapshots use an older P/L definition and
  // the two must not be joined into one line.
  const todaySnap: PortfolioSnapshotRow | null = h.currentValueEur === null ? null : {
    date: todayIso,
    total_value_eur: h.currentValueEur,
    total_invested_eur: valuation.costOfOpenPositionsEur,
    total_unrealized_eur: null,
    total_realized_eur: null,
    snapshot_source: 'central_valuation',
    pl_definition_version: CURRENT_PL_DEFINITION_VERSION,
  }

  // Yahoo/ECB + transactions reconstruct the total-value line every day, but
  // only when the reconstruction is complete (otherwise it is empty and the
  // gaps are listed). Stored snapshots still provide cost basis and P/L where
  // those fields are genuinely known; null elsewhere.
  const storedByDate = new Map(rawPortfolioSnapshots.map((s) => [s.date, s]))
  const reconstructed = returnsData.reconstructedHistory.map((point): PortfolioSnapshotRow => {
    const stored = storedByDate.get(point.date)
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
  const reconstructedDates = new Set(reconstructed.map((s) => s.date))
  const portfolioSnapshots: PortfolioSnapshotRow[] = [
    ...rawPortfolioSnapshots.filter((s) => !reconstructedDates.has(s.date) && s.date !== todayIso),
    ...reconstructed.filter((s) => s.date !== todayIso),
    ...(todaySnap ? [todaySnap] : []),
  ].sort((a, b) => (a.date < b.date ? -1 : 1))
  const historyComplete = returnsData.reconstructedHistory.length > 0

  // Today's per-investment data comes from livePoint, not invSnapshots
  const invSnapshots = rawInvSnapshots.filter((s) => s.date !== todayIso)

  // ── Profit tone ────────────────────────────────────────────────────────────
  const totalResult = h.totalResultSinceStartEur
  const profitTone: 'positive' | 'negative' | 'neutral' =
    totalResult === null ? 'neutral' : totalResult > 0 ? 'positive' : totalResult < 0 ? 'negative' : 'neutral'

  const hasInvestments = investments.length > 0

  // ── Section 2: Per-asset breakdown ────────────────────────────────────────

  // Sort investments by current value desc so default-visible picks the largest
  const sortedRows = [...todayRows].sort((a, b) => b.valueEur - a.valueEur)

  const assetEntities: BreakdownEntity[] = sortedRows.map(({ inv }, i) => ({
    id: inv.id,
    label: inv.name,
    color: PALETTE[i % PALETTE.length],
  }))

  // Historical asset snapshots from DB (today replaced by the central values below)
  const assetHistSnaps: BreakdownSnapshot[] = rawDetailedInvSnapshots
    .filter((s) => s.date !== todayIso)
    .map((s) => ({
      date: s.date,
      entity_id: s.investment_id,
      value_eur: s.value_eur,
      cost_basis_eur: s.cost_basis_eur,
      pl_eur: s.pl_eur,
    }))

  const assetLiveSnaps: BreakdownSnapshot[] = todayAvailable
    ? sortedRows.map(({ inv, valueEur, costEur, plEur }) => ({
        date: todayIso, entity_id: inv.id, value_eur: valueEur, cost_basis_eur: costEur, pl_eur: plEur,
      }))
    : []

  const assetSnapshots: BreakdownSnapshot[] = [...assetHistSnaps, ...assetLiveSnaps].sort(
    (a, b) => (a.date < b.date ? -1 : 1),
  )

  // ── Section 3: Per-platform breakdown ─────────────────────────────────────

  const sumBy = (key: (inv: (typeof todayRows)[number]['inv']) => string) => {
    const m = new Map<string, { value_eur: number; cost_basis_eur: number; pl_eur: number }>()
    for (const r of todayRows) {
      const prev = m.get(key(r.inv)) ?? { value_eur: 0, cost_basis_eur: 0, pl_eur: 0 }
      m.set(key(r.inv), { value_eur: prev.value_eur + r.valueEur, cost_basis_eur: prev.cost_basis_eur + r.costEur, pl_eur: prev.pl_eur + r.plEur })
    }
    return m
  }
  const platLiveMap = sumBy((inv) => inv.platform)
  const sortedPlatforms = [...platLiveMap.entries()].sort((a, b) => b[1].value_eur - a[1].value_eur)

  const platformEntities: BreakdownEntity[] = sortedPlatforms.map(([platform], i) => ({
    id: platform,
    label: platform,
    color: PALETTE[i % PALETTE.length],
  }))

  // Aggregate historical inv snapshots by platform per date
  const platHistMap = new Map<
    string,
    Map<string, { value_eur: number; cost_basis_eur: number; pl_eur: number }>
  >()
  for (const s of rawDetailedInvSnapshots) {
    if (s.date === todayIso) continue
    let platMap = platHistMap.get(s.date)
    if (!platMap) { platMap = new Map(); platHistMap.set(s.date, platMap) }
    const prev = platMap.get(s.platform) ?? { value_eur: 0, cost_basis_eur: 0, pl_eur: 0 }
    platMap.set(s.platform, {
      value_eur: prev.value_eur + s.value_eur,
      cost_basis_eur: prev.cost_basis_eur + s.cost_basis_eur,
      pl_eur: prev.pl_eur + s.pl_eur,
    })
  }

  const platHistSnaps: BreakdownSnapshot[] = Array.from(platHistMap.entries()).flatMap(
    ([date, platMap]) =>
      Array.from(platMap.entries()).map(([platform, metrics]) => ({
        date,
        entity_id: platform,
        ...metrics,
      })),
  )

  const platLiveSnaps: BreakdownSnapshot[] = todayAvailable
    ? Array.from(platLiveMap.entries()).map(([platform, metrics]) => ({ date: todayIso, entity_id: platform, ...metrics }))
    : []

  const platformSnapshots: BreakdownSnapshot[] = [...platHistSnaps, ...platLiveSnaps].sort(
    (a, b) => (a.date < b.date ? -1 : 1),
  )

  // ── Section 4: By asset class ──────────────────────────────────────────────

  // Build type order sorted by current value desc
  const typeLiveMap = sumBy((inv) => inv.type)
  const sortedTypes = [...typeLiveMap.entries()].sort((a, b) => b[1].value_eur - a[1].value_eur)

  const typeEntities: BreakdownEntity[] = sortedTypes.map(([type]) => ({
    id: type,
    label: categoryLabel(type as InvestmentType),
    color: TYPE_COLORS[type] ?? '#9ca3af',
  }))

  // Aggregate historical inv snapshots by type per date
  const typeHistMap = new Map<
    string,
    Map<string, { value_eur: number; cost_basis_eur: number; pl_eur: number }>
  >()
  for (const s of rawDetailedInvSnapshots) {
    if (s.date === todayIso) continue
    let tMap = typeHistMap.get(s.date)
    if (!tMap) { tMap = new Map(); typeHistMap.set(s.date, tMap) }
    const prev = tMap.get(s.type) ?? { value_eur: 0, cost_basis_eur: 0, pl_eur: 0 }
    tMap.set(s.type, {
      value_eur: prev.value_eur + s.value_eur,
      cost_basis_eur: prev.cost_basis_eur + s.cost_basis_eur,
      pl_eur: prev.pl_eur + s.pl_eur,
    })
  }

  const typeHistSnaps: BreakdownSnapshot[] = Array.from(typeHistMap.entries()).flatMap(
    ([date, tMap]) =>
      Array.from(tMap.entries()).map(([type, metrics]) => ({
        date,
        entity_id: type,
        ...metrics,
      })),
  )

  const typeLiveSnaps: BreakdownSnapshot[] = todayAvailable
    ? Array.from(typeLiveMap.entries()).map(([type, metrics]) => ({ date: todayIso, entity_id: type, ...metrics }))
    : []

  const typeSnapshots: BreakdownSnapshot[] = [...typeHistSnaps, ...typeLiveSnaps].sort(
    (a, b) => (a.date < b.date ? -1 : 1),
  )

  return (
    <div className="space-y-8">
      <PageHeader
        title="Portfolio history"
        subtitle="How your portfolio value has changed over time, in EUR."
      />

      <div className="rounded-xl border border-slate-200 bg-slate-50 px-4 py-3 text-xs leading-relaxed text-slate-600 space-y-1">
        <p>
          <span className="font-medium text-slate-700">Source:</span> the total-value line is rebuilt when this page opens from
          your transactions, Yahoo daily closes and ECB exchange rates, and ends on today&apos;s central portfolio value (the same
          value as the Dashboard). Stored snapshots remain the only source for historical cost basis and profit/loss.
        </p>
        <p>
          <span className="font-medium text-slate-700">Last market close:</span>{' '}
          {returnsData.lastMarketCloseDate ? fmtDate(returnsData.lastMarketCloseDate) : '—'} ·{' '}
          <span className="font-medium text-slate-700">oldest current price:</span>{' '}
          {valuation.oldestPriceAsOf ? fmtDate(valuation.oldestPriceAsOf.slice(0, 10)) : '—'} ·{' '}
          <span className="font-medium text-slate-700">quality:</span>{' '}
          {historyComplete ? (valuation.quality === 'estimated' ? 'estimated (metals on a market benchmark)' : valuation.quality ?? '—') : 'incomplete'}
        </p>
        {!historyComplete && (
          <p className="text-rose-700">
            The reconstructed history is incomplete and is not shown ({h.resultsUnavailableReason ?? 'missing market data'}). Only stored
            snapshots are plotted. <Link href="/returns" className="underline">See every missing source</Link>.
          </p>
        )}
        {h.currentValueEur === null && (
          <p className="text-rose-700">No point for today: {h.currentValueUnavailableReason}</p>
        )}
      </div>

      {/* Section 1: Portfolio overview */}
      <div className="space-y-4">
        <PortfolioHistoryChart
          portfolioSnapshots={portfolioSnapshots}
          invSnapshots={invSnapshots}
          livePoint={livePoint}
        />

        {hasInvestments && (
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
            <StatCard
              label="Portfolio value"
              value={<PrivacyMoney value={h.currentValueEur} fallbackText="—" />}
              hint={h.currentValueEur === null ? h.currentValueUnavailableReason ?? undefined : <>Same as Dashboard · <BrokerCashNote cash={h.brokerCash} /></>}
            />
            <StatCard
              label="Cost of open positions"
              value={<PrivacyMoney value={h.costOfOpenPositionsEur} fallbackText="—" />}
              hint="Remaining purchase cost of what you still hold"
            />
            <StatCard
              label="Investment result"
              value={<PrivacyMoney value={totalResult} signed fallbackText="—" />}
              hint={
                totalResult === null ? (h.resultsUnavailableReason ?? undefined) : (
                  <PrivacyGate>
                    <>
                      {money(h.realisedSinceStartEur ?? 0, 'EUR')} realised ·{' '}
                      {money(h.unrealisedNowEur ?? 0, 'EUR')} unrealised · since start
                    </>
                  </PrivacyGate>
                )
              }
              tone={profitTone}
            />
          </div>
        )}
      </div>

      {/* Section 2: By asset */}
      {assetEntities.length > 0 && (
        <BreakdownChart
          heading="By asset"
          subtitle="Value of individual holdings over time."
          entities={assetEntities}
          snapshots={assetSnapshots}
          defaultVisibleCount={5}
        />
      )}

      {/* Section 3: By platform */}
      {platformEntities.length > 0 && (
        <BreakdownChart
          heading="By platform"
          subtitle="Portfolio breakdown by broker or platform over time."
          entities={platformEntities}
          snapshots={platformSnapshots}
          defaultVisibleCount={platformEntities.length}
        />
      )}

      {/* Section 4: By asset class */}
      {typeEntities.length > 0 && (
        <BreakdownChart
          heading="By asset class"
          subtitle="Portfolio breakdown by investment category over time."
          entities={typeEntities}
          snapshots={typeSnapshots}
          defaultVisibleCount={typeEntities.length}
        />
      )}
    </div>
  )
}
