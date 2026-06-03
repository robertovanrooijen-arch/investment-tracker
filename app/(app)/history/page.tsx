import { createClient } from '@/lib/supabase/server'
import { PageHeader } from '@/components/ui/page-header'
import { StatCard } from '@/components/ui/stat-card'
import { PortfolioHistoryChart } from '@/components/history/portfolio-history-chart'
import { BreakdownChart } from '@/components/history/breakdown-chart'
import type { BreakdownSnapshot, BreakdownEntity } from '@/components/history/breakdown-chart'
import {
  computePortfolioMetrics,
  computeInvestmentMetrics,
  pct,
} from '@/lib/domain/calculations'
import { loadFxRates } from '@/lib/domain/fx'
import { money } from '@/lib/format'
import type { Investment, Transaction, InvestmentType } from '@/types/database'
import type { LivePoint } from '@/components/history/portfolio-history-chart'

export const dynamic = 'force-dynamic'

// Color palette shared across asset and platform entity lists
const PALETTE = [
  '#3b82f6', '#8b5cf6', '#f59e0b', '#10b981', '#ef4444',
  '#f97316', '#06b6d4', '#ec4899', '#84cc16', '#6366f1',
  '#14b8a6', '#a78bfa',
]

// Semantic labels and colors for investment types — mirrors the overview chart
const TYPE_LABELS: Record<string, string> = {
  stock:         'Stocks',
  ETF:           'ETFs',
  crypto:        'Crypto',
  cash:          'Cash',
  'real estate': 'Real Estate',
  commodity:     'Commodities',
  custom:        'Custom',
}

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
  total_invested_eur: number
  total_unrealized_eur: number
  total_realized_eur: number
  snapshot_source: string
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
  const todayIso = new Date().toISOString().slice(0, 10)

  const [portfolioRes, invSnapshotRes, invRes, txRes, fxRes] = await Promise.all([
    supabase
      .from('portfolio_snapshots')
      .select('date, total_value_eur, total_invested_eur, total_unrealized_eur, total_realized_eur, snapshot_source')
      .order('date', { ascending: true }),
    supabase
      .from('investment_snapshots')
      .select('date, investment_id, value_eur, remaining_cost_basis_eur, realized_profit_eur, unrealized_profit_eur, investment:investments(id, name, type, platform)')
      .order('date', { ascending: true })
      .returns<DetailedInvSnapshotRow[]>(),
    supabase.from('investments').select('*').returns<Investment[]>(),
    supabase.from('transactions').select('*').returns<Transaction[]>(),
    loadFxRates(supabase),
  ])

  // Postgres `numeric` columns can come back as strings via supabase-js; coerce.
  const rawPortfolioSnapshots: PortfolioSnapshotRow[] = (portfolioRes.data ?? []).map((row) => ({
    date: String(row.date),
    total_value_eur: Number(row.total_value_eur),
    total_invested_eur: Number(row.total_invested_eur),
    total_unrealized_eur: Number(row.total_unrealized_eur),
    total_realized_eur: Number(row.total_realized_eur ?? 0),
    snapshot_source: String(row.snapshot_source ?? ''),
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

  // ── Live metrics — same computation as Dashboard ───────────────────────────
  const investments = invRes.data ?? []
  const transactions = txRes.data ?? []
  const fxRates = fxRes.rates

  // Compute all investment metrics once; reuse for all sections below
  const invMetrics = investments.map((inv) => ({
    inv,
    m: computeInvestmentMetrics(inv, transactions, fxRates),
  }))

  const liveMetrics = computePortfolioMetrics(investments, transactions, fxRates)

  // Build per-type map for overview chart's live point
  const byTypeMap = new Map<string, number>()
  for (const { inv, m } of invMetrics) {
    if (!m.isClosed || m.currentValue > 0) {
      byTypeMap.set(inv.type, (byTypeMap.get(inv.type) ?? 0) + m.currentValue)
    }
  }

  const livePoint: LivePoint = {
    date: todayIso,
    totalValue: liveMetrics.totalValue,
    totalInvested: liveMetrics.totalInvested,
    totalUnrealized: liveMetrics.totalUnrealized,
    totalRealized: liveMetrics.totalRealized,
    byType: Array.from(byTypeMap.entries()).map(([type, value]) => ({
      type: type as InvestmentType,
      value,
    })),
  }

  // Inject today as a live snapshot; replace any stale existing entry
  const todaySnap: PortfolioSnapshotRow = {
    date: todayIso,
    total_value_eur: liveMetrics.totalValue,
    total_invested_eur: liveMetrics.totalInvested,
    total_unrealized_eur: liveMetrics.totalUnrealized,
    total_realized_eur: liveMetrics.totalRealized,
    snapshot_source: 'live',
  }

  const portfolioSnapshots: PortfolioSnapshotRow[] = [
    ...rawPortfolioSnapshots.filter((s) => s.date !== todayIso),
    todaySnap,
  ].sort((a, b) => (a.date < b.date ? -1 : 1))

  // Today's per-investment data comes from livePoint, not invSnapshots
  const invSnapshots = rawInvSnapshots.filter((s) => s.date !== todayIso)

  // ── Profit tone ────────────────────────────────────────────────────────────
  const profitTone: 'positive' | 'negative' | 'neutral' =
    liveMetrics.totalProfit > 0 ? 'positive' :
    liveMetrics.totalProfit < 0 ? 'negative' : 'neutral'

  const hasInvestments = investments.length > 0

  // ── Section 2: Per-asset breakdown ────────────────────────────────────────

  // Sort investments by current value desc so default-visible picks the largest
  const sortedInvMetrics = [...invMetrics]
    .filter(({ m }) => m.hasActivity || m.currentValue > 0)
    .sort((a, b) => b.m.currentValue - a.m.currentValue)

  const assetEntities: BreakdownEntity[] = sortedInvMetrics.map(({ inv }, i) => ({
    id: inv.id,
    label: inv.name,
    color: PALETTE[i % PALETTE.length],
  }))

  // Historical asset snapshots from DB (today replaced by live below)
  const assetHistSnaps: BreakdownSnapshot[] = rawDetailedInvSnapshots
    .filter((s) => s.date !== todayIso)
    .map((s) => ({
      date: s.date,
      entity_id: s.investment_id,
      value_eur: s.value_eur,
      cost_basis_eur: s.cost_basis_eur,
      pl_eur: s.pl_eur,
    }))

  // Live asset snapshots for today
  const assetLiveSnaps: BreakdownSnapshot[] = sortedInvMetrics.map(({ inv, m }) => ({
    date: todayIso,
    entity_id: inv.id,
    value_eur: m.currentValue,
    cost_basis_eur: m.remainingCostBasis,
    pl_eur: m.totalProfit,
  }))

  const assetSnapshots: BreakdownSnapshot[] = [...assetHistSnaps, ...assetLiveSnaps].sort(
    (a, b) => (a.date < b.date ? -1 : 1),
  )

  // ── Section 3: Per-platform breakdown ─────────────────────────────────────

  // Build platform order sorted by current value desc
  const platValueMap = new Map<string, number>()
  for (const { inv, m } of invMetrics) {
    platValueMap.set(inv.platform, (platValueMap.get(inv.platform) ?? 0) + m.currentValue)
  }
  const sortedPlatforms = [...platValueMap.entries()].sort((a, b) => b[1] - a[1])

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

  // Live platform snapshots for today
  const platLiveMap = new Map<string, { value_eur: number; cost_basis_eur: number; pl_eur: number }>()
  for (const { inv, m } of invMetrics) {
    const prev = platLiveMap.get(inv.platform) ?? { value_eur: 0, cost_basis_eur: 0, pl_eur: 0 }
    platLiveMap.set(inv.platform, {
      value_eur: prev.value_eur + m.currentValue,
      cost_basis_eur: prev.cost_basis_eur + m.remainingCostBasis,
      pl_eur: prev.pl_eur + m.totalProfit,
    })
  }

  const platLiveSnaps: BreakdownSnapshot[] = Array.from(platLiveMap.entries()).map(
    ([platform, metrics]) => ({ date: todayIso, entity_id: platform, ...metrics }),
  )

  const platformSnapshots: BreakdownSnapshot[] = [...platHistSnaps, ...platLiveSnaps].sort(
    (a, b) => (a.date < b.date ? -1 : 1),
  )

  // ── Section 4: By asset class ──────────────────────────────────────────────

  // Build type order sorted by current value desc
  const typeValueMap = new Map<string, number>()
  for (const { inv, m } of invMetrics) {
    typeValueMap.set(inv.type, (typeValueMap.get(inv.type) ?? 0) + m.currentValue)
  }
  const sortedTypes = [...typeValueMap.entries()].sort((a, b) => b[1] - a[1])

  const typeEntities: BreakdownEntity[] = sortedTypes.map(([type]) => ({
    id: type,
    label: TYPE_LABELS[type] ?? type,
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

  // Live type snapshots for today
  const typeLiveMap = new Map<string, { value_eur: number; cost_basis_eur: number; pl_eur: number }>()
  for (const { inv, m } of invMetrics) {
    const prev = typeLiveMap.get(inv.type) ?? { value_eur: 0, cost_basis_eur: 0, pl_eur: 0 }
    typeLiveMap.set(inv.type, {
      value_eur: prev.value_eur + m.currentValue,
      cost_basis_eur: prev.cost_basis_eur + m.remainingCostBasis,
      pl_eur: prev.pl_eur + m.totalProfit,
    })
  }

  const typeLiveSnaps: BreakdownSnapshot[] = Array.from(typeLiveMap.entries()).map(
    ([type, metrics]) => ({ date: todayIso, entity_id: type, ...metrics }),
  )

  const typeSnapshots: BreakdownSnapshot[] = [...typeHistSnaps, ...typeLiveSnaps].sort(
    (a, b) => (a.date < b.date ? -1 : 1),
  )

  return (
    <div className="space-y-8">
      <PageHeader
        title="Portfolio history"
        subtitle="How your portfolio value has changed over time, in EUR."
      />

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
              value={money(liveMetrics.totalValue, 'EUR')}
              hint="Current live value in EUR"
            />
            <StatCard
              label="Total invested"
              value={money(liveMetrics.totalInvested, 'EUR')}
              hint="Cost basis in EUR"
            />
            <StatCard
              label="Profit / loss"
              value={money(liveMetrics.totalProfit, 'EUR')}
              hint={
                liveMetrics.totalEverInvested > 0
                  ? `${pct(liveMetrics.totalProfitPct)} · ${money(liveMetrics.totalRealized, 'EUR')} realized · ${money(liveMetrics.totalUnrealized, 'EUR')} unrealized`
                  : undefined
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
