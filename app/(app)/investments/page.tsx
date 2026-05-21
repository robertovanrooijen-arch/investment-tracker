import Link from 'next/link'
import { createClient } from '@/lib/supabase/server'
import { PageHeader } from '@/components/ui/page-header'
import { money } from '@/lib/format'
import { computeInvestmentMetrics, pct } from '@/lib/domain/calculations'
import { loadFxRates } from '@/lib/domain/fx'
import { hasUnits } from '@/lib/domain/constants'
import { InvestmentRow } from '@/components/investments/investment-row'
import { RefreshPortfolioButton } from '@/components/dashboard/refresh-portfolio-button'
import type { PrevSnap } from '@/components/investments/investment-row'
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

  const rows = investments.map((inv) => ({
    inv,
    m: computeInvestmentMetrics(inv, transactions, fxRates),
    prevSnap: prevSnapMap.get(inv.id) ?? null,
  }))

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

      {!error && rows.length === 0 && (
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

      {!error && rows.length > 0 && (
        <div className="bg-white rounded-2xl border border-slate-200 overflow-hidden">
          <table className="hidden md:table w-full">
            <thead>
              <tr className="text-left text-xs uppercase tracking-wide text-slate-500 border-b border-slate-200">
                <th className="px-6 py-3 font-medium">Name</th>
                <th className="px-6 py-3 font-medium">Type</th>
                <th className="px-6 py-3 font-medium">Platform</th>
                <th className="px-6 py-3 font-medium text-right">Value EUR</th>
                <th className="px-6 py-3 font-medium text-right">P / L EUR</th>
                <th className="px-6 py-3 font-medium text-right">Daily</th>
                <th className="px-6 py-3 font-medium">Updated</th>
              </tr>
            </thead>
            <tbody>
              {rows.map(({ inv, m, prevSnap }) => (
                <InvestmentRow key={inv.id} inv={inv} m={m} prevSnap={prevSnap} />
              ))}
            </tbody>
          </table>

          <ul className="md:hidden divide-y divide-slate-100">
            {rows.map(({ inv, m, prevSnap }) => {
              const showPL = m.totalEverInvested > 0
              const plTone =
                m.totalProfit > 0
                  ? 'text-emerald-600'
                  : m.totalProfit < 0
                    ? 'text-rose-600'
                    : 'text-slate-500'

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

              const dailyTone =
                dailyChangeEur === null
                  ? 'text-slate-400'
                  : dailyChangeEur > 0
                    ? 'text-emerald-600'
                    : dailyChangeEur < 0
                      ? 'text-rose-600'
                      : 'text-slate-500'

              return (
                <li key={inv.id}>
                  <Link
                    href={`/investments/${inv.id}`}
                    className="flex items-center justify-between px-5 py-4 hover:bg-slate-50"
                  >
                    <div className="min-w-0">
                      <div className="font-medium text-slate-900 truncate flex items-center gap-2">
                        {inv.name}
                        {m.isClosed && (
                          <span className="inline-flex items-center rounded-full bg-slate-100 px-2 py-0.5 text-xs font-medium text-slate-500">
                            Closed
                          </span>
                        )}
                      </div>

                      <div className="mt-1 flex items-center gap-2 text-xs text-slate-500">
                        <span>{inv.type}</span>
                        <span>·</span>
                        <span>{inv.platform}</span>
                        <span>·</span>
                        <span>{inv.currency ?? 'EUR'}</span>
                      </div>
                    </div>

                    <div className="text-right shrink-0">
                      <div className="text-sm text-slate-900 tabular-nums">
                        {money(m.currentValue, 'EUR')}
                      </div>
                      <div className={`text-xs tabular-nums ${plTone}`}>
                        {showPL
                          ? m.totalProfitPct !== null
                            ? pct(m.totalProfitPct)
                            : '—'
                          : '—'}
                      </div>
                      {dailyChangeEur !== null && (
                        <div className={`text-xs tabular-nums ${dailyTone}`}>
                          {dailyChangeEur >= 0 ? '+' : ''}
                          {money(dailyChangeEur, 'EUR')}
                          {dailyChangePct !== null && (
                            <> ({dailyChangePct >= 0 ? '+' : ''}{dailyChangePct.toFixed(2)}%)</>
                          )}
                        </div>
                      )}
                    </div>
                  </Link>
                </li>
              )
            })}
          </ul>
        </div>
      )}
    </div>
  )
}
