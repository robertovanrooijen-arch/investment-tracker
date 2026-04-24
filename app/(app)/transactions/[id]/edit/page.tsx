import { notFound, redirect } from 'next/navigation'
import { createClient } from '@/lib/supabase/server'
import {
  TransactionForm,
  type InvestmentOption,
  type TransactionInitial,
} from '@/components/transactions/transaction-form'
import { DeleteTransactionButton } from '@/components/transactions/delete-transaction-button'
import { heldQuantity } from '@/lib/domain/calculations'
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

  if (!user) {
    redirect('/login')
  }

  const { data: tx, error: txError } = await supabase
    .from('transactions')
    .select('*')
    .eq('id', id)
    .eq('user_id', user.id)
    .maybeSingle<Transaction>()

  if (txError || !tx) {
    notFound()
  }

  const { data: investmentsData } = await supabase
    .from('investments')
    .select('id, name, type, current_value')
    .eq('user_id', user.id)
    .order('name', { ascending: true })

  const { data: txData } = await supabase
    .from('transactions')
    .select('*')
    .eq('user_id', user.id)
    .returns<Transaction[]>()

  const allTxs: Transaction[] = txData ?? []
  const investments = investmentsData ?? []

  const options: InvestmentOption[] = investments.map((inv) => ({
    id: inv.id,
    name: inv.name,
    type: inv.type,
    current_value: inv.current_value,
    quantityHeld: heldQuantity(inv.id, allTxs, tx.id),
  }))

  const initial: TransactionInitial = {
    id: tx.id,
    investment_id: tx.investment_id,
    type: tx.type as TransactionInitial['type'],
    date: tx.date,
    quantity: tx.quantity,
    price_per_unit: tx.price_per_unit,
    amount: tx.amount,
    fee: tx.fee,
    notes: tx.notes,
  }

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold text-slate-900">
          Edit activity
        </h1>
        <p className="mt-1 text-sm text-slate-600">
          Update the details of this entry.
        </p>
      </div>

      <TransactionForm investments={options} initial={initial} />

      <div className="pt-2 max-w-2xl">
        <DeleteTransactionButton transactionId={tx.id} />
      </div>
    </div>
  )
}