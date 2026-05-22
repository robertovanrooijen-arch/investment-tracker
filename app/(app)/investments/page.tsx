import Link from 'next/link'
import { createClient } from '@/lib/supabase/server'
import { PageHeader } from '@/components/ui/page-header'
import { computeInvestmentMetrics } from '@/lib/domain/calculations'
import { loadFxRates } from '@/lib/domain/fx'
import { hasUnits } from '@/lib/domain/constants'
import { RefreshPortfolioButton } from '@/components/dashboard/refresh-portfolio-button'
import { InvestmentsList } from '@/components/investments/investments-list'
import type { PrevSnap } from '@/components/investments/investment-row'
import type { PreparedRow } from '@/components/investments/investments-list'
import type { Investment, Transaction } from '@/types/database'

export default async function InvestmentsPage() {
  const supabase = await createClient()

  const todayIso = new Date().toISOString().slice(0, 10)
  // 7-day window covers weekends and public holidays where the cron may skip a day.
  const sevenDaysAgoIso = (() => {
    const d = new Date()
    d.setDate(d.getDate() - 7)
    return d.toISOString().slice(0, 10)
  })()

  const [invRes, txRes, fxRes, snapRes, latestSnapRes] = await Promise.all([
    supabase
      .from('investments')
      .select('*')
      .order('updated_at', { ascending: false })
      .returns<Investment[]>(),
    supabase.from('transactions').select('*').returns<Transaction[]>(),
    loadFxRates(supabase),
    supabase
      .from('investment_snapshots')
      .select('investment_id, date, value_eur, quantity')
      .lt('date', todayIso)
      .gte('date', sevenDaysAgoIso)
      .order('date', { ascending: false }),
    supabase
      .from('portfolio_snapshots')
      .select('updated_at')
      .order('date', { ascending: false })
      .limit(1)
      .maybeSingle(),
  ])

  const error = invRes.error
  const investments = invRes.data ?? []
  const transactions = txRes.data ?? []
  const fxRates = fxRes.rates
  const lastRefreshedAt =
    (latestSnapRes.data as { updated_at: string } | null)?.updated_at ?? null

  // Most recent snapshot (before today) per investment, within the 7-day window.
  // Rows arrive newest-first; first occurrence per investment_id is the winner.
  const prevSnapMap = new Map<string, PrevSnap>()
  for (const row of snapRes.data ?? []) {
    if (!prevSnapMap.has(row.investment_id)) {
      prevSnapMap.set(row.investment_id, {
        value_eur: Number(row.value_eur),
        quantity: row.quantity != null ? Number(row.quantity) : null,
      })
    }
  }

  const preparedRows: PreparedRow[] = investments.map((inv) => {
    const m = computeInvestmentMetrics(inv, transactions, fxRates)
    const prevSnap = prevSnapMap.get(inv.id) ?? null

    let dailyChangeEur: number | null = null
    let dailyChangePct: number | null = null

    if (!m.isClosed && prevSnap !== null) {
      if (hasUnits(inv.type)) {
        const prevQty = prevSnap.quantity
        const currQty = m.quantity
        if (prevQty != null && prevQty > 0 && currQty != null && currQty > 0) {
          const prevPriceEur = prevSnap.value_eur / prevQty
          const currPriceEur = m.currentValue / currQty
          dailyChangeEur = currQty * (currPriceEur - prevPriceEur)
          dailyChangePct = (currPriceEur / prevPriceEur - 1) * 100
        }
      } else {
        dailyChangeEur = m.currentValue - prevSnap.value_eur
        dailyChangePct =
          prevSnap.value_eur > 0
            ? (dailyChangeEur / prevSnap.value_eur) * 100
            : null
      }
    }

    return { inv, m, dailyChangeEur, dailyChangePct }
  })

  return (
    <div className="space-y-6">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <PageHeader
          title="Investments"
          subtitle="Every position you're tracking. Values shown in EUR."
        />

        <div className="flex flex-col items-start gap-2 sm:items-end shrink-0">
          <div className="flex flex-wrap items-center gap-2">
            <RefreshPortfolioButton lastRefreshedAt={lastRefreshedAt} />
            <Link
              href="/investments/new"
              className="inline-flex items-center justify-center rounded-lg bg-slate-900 px-4 py-2 text-sm font-medium text-white hover:bg-slate-800"
            >
              + Add investment
            </Link>
          </div>
        </div>
      </div>

      {error && (
        <div className="bg-white rounded-2xl border border-rose-200 p-6 text-sm text-rose-600">
          Could not load investments: {error.message}
        </div>
      )}

      {!error && preparedRows.length === 0 && (
        <div className="bg-white rounded-2xl border border-slate-200 p-10 text-center">
          <p className="text-slate-900 font-medium">No investments yet</p>
          <p className="text-sm text-slate-500 mt-1">
            Add your first position to start tracking your portfolio.
          </p>
          <Link
            href="/investments/new"
            className="mt-4 inline-flex items-center justify-center rounded-lg bg-slate-900 px-4 py-2 text-sm font-medium text-white hover:bg-slate-800"
          >
            + Add investment
          </Link>
        </div>
      )}

      {!error && preparedRows.length > 0 && (
        <InvestmentsList rows={preparedRows} />
      )}
    </div>
  )
}
