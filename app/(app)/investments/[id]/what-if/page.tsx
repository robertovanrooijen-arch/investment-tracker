import { notFound } from 'next/navigation'
import Link from 'next/link'
import { createClient } from '@/lib/supabase/server'
import { PageHeader } from '@/components/ui/page-header'
import { WhatIfBuy } from '@/components/investments/what-if-buy'
import { computeInvestmentMetrics } from '@/lib/domain/calculations'
import { hasUnits } from '@/lib/domain/constants'
import type { Investment, Transaction } from '@/types/database'

export default async function WhatIfBuyPage({
  params,
}: {
  params: Promise<{ id: string }>
}) {
  const { id } = await params
  const supabase = await createClient()

  const [invRes, txRes] = await Promise.all([
    supabase.from('investments').select('*').eq('id', id).single<Investment>(),
    supabase
      .from('transactions')
      .select('*')
      .eq('investment_id', id)
      .returns<Transaction[]>(),
  ])

  if (invRes.error || !invRes.data) {
    notFound()
  }

  const investment = invRes.data
  const transactions = txRes.data ?? []

  // The simulator works in native currency (per-unit reasoning).
  const m = computeInvestmentMetrics(investment, transactions)

  const currency = investment.currency ?? 'EUR'
  const isUnit = hasUnits(investment.type)
  const quantityHeld = m.quantity ?? 0

  // Simulator only makes sense for unit assets with an open position.
  if (!isUnit || quantityHeld <= 0) {
    notFound()
  }

  return (
    <div className="space-y-6">
      <div>
        <Link
          href={`/investments/${investment.id}`}
          className="text-sm text-slate-500 hover:text-slate-700"
        >
          ← Back to {investment.name}
        </Link>
      </div>

      <PageHeader
        title={`What-if: buy more ${investment.name}`}
        subtitle={
          investment.ticker
            ? `${investment.ticker} · prices in ${currency}`
            : `Prices in ${currency}`
        }
      />

      <div className="rounded-2xl border border-slate-200 bg-white p-5 md:p-6">
        <p className="text-sm text-slate-600">
          Simulate buying more of this position to see how a new purchase would
          change your average buy price (GAK). Nothing is saved — it&apos;s a
          calculator. All values are in {currency}.
        </p>
      </div>

      <WhatIfBuy
        quantityHeld={quantityHeld}
        remainingCostBasis={m.remainingCostBasis}
        currentAverageBuyPrice={m.averageBuyPrice}
        currency={currency}
      />
    </div>
  )
}