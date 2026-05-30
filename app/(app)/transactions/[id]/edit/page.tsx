import { notFound, redirect } from 'next/navigation'
import { createClient } from '@/lib/supabase/server'
import {
  TransactionForm,
  type InvestmentOption,
  type TransactionInitial,
} from '@/components/transactions/transaction-form'
import { heldQuantity } from '@/lib/domain/calculations'
import { loadFxRates } from '@/lib/domain/fx'
import type { Transaction } from '@/types/database'

export const dynamic = 'force-dynamic'

export default async function EditTransactionPage({
  params,
}: {
  params: Promise<{ id: string }>
}) {
  const { id } = await params
  const supabase = await createClient()

  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) redirect('/login')

  const { data: tx } = await supabase
    .from('transactions')
    .select('*')
    .eq('id', id)
    .eq('user_id', user.id)
    .maybeSingle<Transaction>()

  if (!tx) notFound()

  const [{ data: investmentsData }, { data: txData }, fxRes] =
    await Promise.all([
      supabase
        .from('investments')
        .select('id, name, type, current_value, currency, quantity_unit')
        .eq('user_id', user.id)
        .order('name', { ascending: true }),
      supabase
        .from('transactions')
        .select('*')
        .eq('user_id', user.id)
        .returns<Transaction[]>(),
      loadFxRates(supabase),
    ])

  const investments = investmentsData ?? []
  const allTxs = txData ?? []
  const fxRates = fxRes.rates

  const options: InvestmentOption[] = investments.map((inv) => ({
    id: inv.id,
    name: inv.name,
    type: inv.type,
    current_value: inv.current_value,
    quantityHeld: heldQuantity(inv.id, allTxs, tx.id),
    currency: inv.currency ?? 'EUR',
    quantity_unit: inv.quantity_unit ?? null,
  }))

  const initial: TransactionInitial = {
    id:                  tx.id,
    investment_id:       tx.investment_id,
    type:                tx.type,
    date:                tx.date,
    quantity:            tx.quantity,
    price_per_unit:      tx.price_per_unit,
    amount:              tx.amount,
    fee:                 tx.fee,
    notes:               tx.notes,
    price_currency:      tx.price_currency,
    fee_currency:        tx.fee_currency,
    fx_rate_to_eur:      tx.fx_rate_to_eur,
    is_contribution:     tx.is_contribution,
    contribution_source: tx.contribution_source,
  }

  return (
    <div className="mx-auto max-w-3xl space-y-6">
      <div>
        <h1 className="text-2xl font-semibold text-slate-900">Edit activity</h1>
        <p className="mt-1 text-sm text-slate-600">
          Update the details of this entry.
        </p>
      </div>

      <TransactionForm
        investments={options}
        initial={initial}
        fxRates={fxRates}
      />
    </div>
  )
}