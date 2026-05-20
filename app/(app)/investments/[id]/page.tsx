import { notFound } from 'next/navigation'
import Link from 'next/link'
import { createClient } from '@/lib/supabase/server'
import { PageHeader } from '@/components/ui/page-header'
import { Badge } from '@/components/ui/badge'
import { StatCard } from '@/components/ui/stat-card'
import { RefreshPriceButton } from '@/components/investments/refresh-price-button'
import { InvestmentDetailChart } from '@/components/investments/investment-detail-chart'
import { money, fmtDate } from '@/lib/format'
import {
  computeInvestmentMetrics,
  pct,
  txAmountInPriceCurrency,
} from '@/lib/domain/calculations'
import { loadFxRates } from '@/lib/domain/fx'
import { txTypeBadgeClass } from '@/lib/domain/transaction-helpers'
import { hasUnits } from '@/lib/domain/constants'
import { buildInvestmentChartTimeline } from '@/lib/domain/chart-timeline'
import type { Investment, Transaction } from '@/types/database'

export default async function InvestmentDetailPage({
  params,
}: {
  params: Promise<{ id: string }>
}) {
  const { id } = await params
  const supabase = await createClient()

  const [invRes, txRes, snapRes, fxRes] = await Promise.all([
    supabase.from('investments').select('*').eq('id', id).single<Investment>(),
    supabase
      .from('transactions')
      .select('*')
      .eq('investment_id', id)
      .order('date', { ascending: false })
      .order('created_at', { ascending: false })
      .returns<Transaction[]>(),
    supabase
      .from('investment_snapshots')
      .select('date, value_eur, remaining_cost_basis_eur, unrealized_profit_eur')
      .eq('investment_id', id)
      .order('date', { ascending: true }),
    loadFxRates(supabase),
  ])

  if (invRes.error || !invRes.data) {
    notFound()
  }

  const investment = invRes.data
  const transactions = txRes.data ?? []
  const fxRates = fxRes.rates

  const m = computeInvestmentMetrics(investment, transactions, fxRates)
  const mNative = computeInvestmentMetrics(investment, transactions)

  const currency = investment.currency ?? 'EUR'
  const isForeign = currency !== 'EUR'

  const snapshots = (snapRes.data ?? []).map((row) => ({
    date: String(row.date),
    value_eur: Number(row.value_eur),
    remaining_cost_basis_eur: Number(row.remaining_cost_basis_eur),
    unrealized_profit_eur: Number(row.unrealized_profit_eur),
  }))

  const profitTone: 'positive' | 'negative' | 'neutral' =
    m.totalProfit > 0
      ? 'positive'
      : m.totalProfit < 0
        ? 'negative'
        : 'neutral'

        const isUnit = hasUnits(investment.type)
        const isCommodity = investment.type === 'commodity'
        const commodityUnitLabel = isCommodity
          ? (investment.quantity_unit === 'gram' ? 'g' : 'oz')
          : null
        const commodityUnitFull = isCommodity
          ? (investment.quantity_unit === 'gram' ? 'gram' : 'troy ounce')
          : null
        const hasRealized = m.realizedProfit !== 0
        const quantityHeld = m.quantity ?? 0
  const showWhatIfBuy = isUnit && quantityHeld > 0
  const statusLabel = m.isClosed ? 'Closed position' : 'Open position'

  return (
    <div className="space-y-6">
      <div>
        <Link
          href="/investments"
          className="text-sm text-slate-500 hover:text-slate-700"
        >
          ← Back to investments
        </Link>
      </div>

      <PageHeader
        title={investment.name}
        subtitle={
          investment.ticker
            ? `${investment.ticker} · ${investment.type} · ${investment.platform} · ${currency}`
            : `${investment.type} · ${investment.platform} · ${currency}`
        }
        action={
          <div className="flex flex-wrap items-center gap-2">
            {!m.isClosed && (
              <Link
                href={`/transactions/new?investment=${investment.id}`}
                className="inline-flex items-center justify-center rounded-lg border border-slate-300 bg-white px-4 py-2 text-sm font-medium text-slate-900 hover:bg-slate-50"
              >
                + Record activity
              </Link>
            )}
            {showWhatIfBuy && (
              <Link
                href={`/investments/${investment.id}/what-if`}
                className="inline-flex items-center justify-center rounded-lg border border-slate-300 bg-white px-4 py-2 text-sm font-medium text-slate-900 hover:bg-slate-50"
              >
                What-if buy more →
              </Link>
            )}
            <Link
              href={`/investments/${investment.id}/edit`}
              className="inline-flex items-center justify-center rounded-lg bg-slate-900 px-4 py-2 text-sm font-medium text-white hover:bg-slate-800"
            >
              Edit
            </Link>
          </div>
        }
      />

      {isUnit && m.hasActivity && (
        <div
          className={`inline-flex items-center rounded-full px-3 py-1 text-xs font-medium ${
            m.isClosed
              ? 'bg-slate-100 text-slate-700'
              : 'bg-emerald-50 text-emerald-700 border border-emerald-200'
          }`}
        >
          {statusLabel}
        </div>
      )}

      {isUnit && m.isClosed ? (
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          <StatCard label="Quantity held" value="0" hint="Fully sold" />
          <StatCard
            label="Realized profit / loss"
            value={money(m.realizedProfit, 'EUR')}
            hint={
              m.totalProfitPct !== null
                ? `${pct(m.totalProfitPct)} on ${money(
                    m.totalEverInvested,
                    'EUR'
                  )} invested`
                : undefined
            }
            tone={profitTone}
          />
        </div>
      ) : (
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
          <StatCard
            label="Current value"
            value={money(m.currentValue, 'EUR')}
            hint={
              isForeign
                ? `≈ ${money(mNative.currentValue, currency)} ${currency}`
                : undefined
            }
          />
          <StatCard
            label="Total invested"
            value={money(m.remainingCostBasis, 'EUR')}
            hint={
              isForeign
                ? `≈ ${money(mNative.remainingCostBasis, currency)} ${currency}`
                : isUnit
                  ? 'Cost basis of shares held'
                  : undefined
            }
          />
          <StatCard
            label="Profit / loss"
            value={m.hasActivity ? money(m.totalProfit, 'EUR') : '—'}
            hint={
              m.hasActivity && m.totalProfitPct !== null
                ? pct(m.totalProfitPct)
                : 'Record a buy or deposit to start tracking gains'
            }
            tone={m.hasActivity ? profitTone : 'neutral'}
          />
        </div>
      )}

      {isForeign && (
        <p className="text-xs text-slate-500">
          EUR values converted using the latest stored FX rate.
        </p>
      )}

{hasRealized && (
        <div className="bg-white rounded-2xl border border-slate-200 p-5 md:p-6">
          <h2 className="text-base font-semibold text-slate-900">
            Profit breakdown
          </h2>
          <div className="mt-4 grid grid-cols-1 sm:grid-cols-2 gap-4 text-sm">
            <div>
              <p className="text-xs uppercase tracking-wide text-slate-500 font-medium">
                {isUnit
                  ? 'Realized (from sells)'
                  : 'Realized (from interest / fees)'}
              </p>
              <p
                className={`mt-1 text-lg font-medium tabular-nums ${
                  m.realizedProfit > 0
                    ? 'text-emerald-600'
                    : m.realizedProfit < 0
                      ? 'text-rose-600'
                      : 'text-slate-900'
                }`}
              >
                {money(m.realizedProfit, 'EUR')}
              </p>
            </div>
            <div>
              <p className="text-xs uppercase tracking-wide text-slate-500 font-medium">
                {isUnit ? 'Unrealized (on remaining)' : 'Unrealized'}
              </p>
              <p
                className={`mt-1 text-lg font-medium tabular-nums ${
                  m.unrealizedProfit > 0
                    ? 'text-emerald-600'
                    : m.unrealizedProfit < 0
                      ? 'text-rose-600'
                      : 'text-slate-900'
                }`}
              >
                {m.isClosed ? '—' : money(m.unrealizedProfit, 'EUR')}
              </p>
            </div>
          </div>
        </div>
      )}

      {isUnit && !m.isClosed && (
        <div className="bg-white rounded-2xl border border-slate-200 p-5 md:p-6">
          <p className="text-xs font-medium uppercase tracking-wide text-slate-500 mb-4">
            Per-unit (in {currency})
          </p>
          <div className="grid grid-cols-1 sm:grid-cols-4 gap-4 text-sm">
            <div>
              <p className="text-xs uppercase tracking-wide text-slate-500 font-medium">
                Quantity held
              </p>
              <p className="mt-1 text-base text-slate-900 tabular-nums">
                {mNative.quantity ?? 0}
                {commodityUnitLabel ? ` ${commodityUnitLabel}` : ''}
              </p>
            </div>

            <div>
              <p className="text-xs uppercase tracking-wide text-slate-500 font-medium">
                {commodityUnitFull ? `Current price per ${commodityUnitFull}` : 'Current price'}
              </p>
              <p className="mt-1 text-base text-slate-900 tabular-nums">
                {investment.current_price !== null
                  ? money(investment.current_price, currency)
                  : '—'}
              </p>
            </div>

            <div>
              <p className="text-xs uppercase tracking-wide text-slate-500 font-medium">
                {commodityUnitFull ? `Avg buy price per ${commodityUnitFull}` : 'Avg buy price'}
              </p>
              <p className="mt-1 text-base text-slate-900 tabular-nums">
                {mNative.averageBuyPrice !== null
                  ? money(mNative.averageBuyPrice, currency)
                  : '—'}
              </p>
            </div>

            <div>
              <p className="text-xs uppercase tracking-wide text-slate-500 font-medium">
                Price updated
              </p>
              <p className="mt-1 text-base text-slate-900">
                {fmtDate(investment.price_last_updated_at)}
              </p>
            </div>
          </div>

          <div className="mt-4 border-t border-slate-100 pt-4">
            <RefreshPriceButton
              investmentId={investment.id}
              lastUpdatedAt={investment.price_last_updated_at}
              priceSource={investment.price_source}
            />
          </div>
        </div>
      )}

      <InvestmentDetailChart
        chartPoints={buildInvestmentChartTimeline(
          investment,
          transactions,
          snapshots,
          { currentValue: m.currentValue, remainingCostBasis: m.remainingCostBasis, unrealizedProfit: m.unrealizedProfit },
          new Date().toISOString().slice(0, 10),
          fxRates,
        )}
      />

      {investment.notes && (
        <div className="bg-white rounded-2xl border border-slate-200 p-5 md:p-6">
          <h2 className="text-base font-semibold text-slate-900">Notes</h2>
          <p className="mt-2 text-sm text-slate-700 whitespace-pre-wrap">
            {investment.notes}
          </p>
        </div>
      )}

      <div className="bg-white rounded-2xl border border-slate-200 overflow-hidden">
        <div className="flex items-center justify-between px-5 md:px-6 py-4 border-b border-slate-100">
          <h2 className="text-base font-semibold text-slate-900">
            Transaction history
          </h2>
          {!m.isClosed && (
            <Link
              href={`/transactions/new?investment=${investment.id}`}
              className="text-sm text-slate-600 hover:text-slate-900"
            >
              + Record activity
            </Link>
          )}
        </div>

        {transactions.length === 0 ? (
          <div className="p-6 text-sm text-slate-500">
            No activity yet for this investment.
          </div>
        ) : (
          <>
            <table className="hidden md:table w-full">
              <thead>
                <tr className="text-left text-xs uppercase tracking-wide text-slate-500 border-b border-slate-200">
                  <th className="px-6 py-3 font-medium">Date</th>
                  <th className="px-6 py-3 font-medium">Type</th>
                  <th className="px-6 py-3 font-medium text-right">Quantity</th>
                  <th className="px-6 py-3 font-medium text-right">Price</th>
                  <th className="px-6 py-3 font-medium text-right">Amount</th>
                  <th className="px-6 py-3 font-medium text-right">Fee</th>
                  <th className="px-6 py-3" />
                </tr>
              </thead>
              <tbody>
                {transactions.map((tx) => {
                  const priceCcy = tx.price_currency ?? currency
                  const feeCcy = tx.fee_currency ?? currency
                  const amountNative = txAmountInPriceCurrency(tx, fxRates)

                  return (
                    <tr
                      key={tx.id}
                      className="border-b last:border-b-0 border-slate-100 hover:bg-slate-50"
                    >
                      <td className="px-6 py-4 text-sm text-slate-700 whitespace-nowrap">
                        {fmtDate(tx.date)}
                      </td>
                      <td className="px-6 py-4">
                        <Badge className={txTypeBadgeClass(tx.type)}>
                          {tx.type}
                        </Badge>
                      </td>
                      <td className="px-6 py-4 text-right text-sm text-slate-700 tabular-nums">
                        {tx.quantity !== null ? tx.quantity : '—'}
                      </td>
                      <td className="px-6 py-4 text-right text-sm text-slate-700 tabular-nums">
                        {tx.price_per_unit !== null
                          ? money(tx.price_per_unit, priceCcy)
                          : '—'}
                      </td>
                      <td className="px-6 py-4 text-right text-sm text-slate-900 tabular-nums">
                        {money(amountNative, priceCcy)}
                      </td>
                      <td className="px-6 py-4 text-right text-sm text-slate-500 tabular-nums">
                        {tx.fee > 0 ? money(tx.fee, feeCcy) : '—'}
                      </td>
                      <td className="px-6 py-4 text-right">
                        <Link
                          href={`/transactions/${tx.id}/edit`}
                          className="text-sm font-medium text-slate-700 hover:text-slate-900"
                        >
                          Edit
                        </Link>
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>

            <ul className="md:hidden divide-y divide-slate-100">
              {transactions.map((tx) => {
                const priceCcy = tx.price_currency ?? currency
                const amountNative = txAmountInPriceCurrency(tx, fxRates)

                return (
                  <li key={tx.id}>
                    <Link
                      href={`/transactions/${tx.id}/edit`}
                      className="block px-5 py-4 hover:bg-slate-50"
                    >
                      <div className="flex items-center justify-between gap-3">
                        <div>
                          <Badge className={txTypeBadgeClass(tx.type)}>
                            {tx.type}
                          </Badge>
                          <div className="mt-1 text-xs text-slate-500">
                            {fmtDate(tx.date)}
                          </div>
                        </div>
                        <div className="text-right">
                          <div className="text-sm text-slate-900 tabular-nums">
                            {money(amountNative, priceCcy)}
                          </div>
                          {tx.quantity !== null &&
                            tx.price_per_unit !== null && (
                              <div className="text-xs text-slate-500 tabular-nums">
                                {tx.quantity} ×{' '}
                                {money(tx.price_per_unit, priceCcy)}
                              </div>
                            )}
                        </div>
                      </div>
                    </Link>
                  </li>
                )
              })}
            </ul>
          </>
        )}
      </div>
    </div>
  )
}