import { redirect } from 'next/navigation'
import { createClient } from '@/lib/supabase/server'
import { TransactionForm, type InvestmentOption } from '@/components/transactions/transaction-form'
import { heldQuantity } from '@/lib/domain/calculations'
import type { Transaction } from '@/types/database'

export const dynamic = 'force-dynamic'

export default async function NewTransactionPage() {
  const supabase = await createClient()

  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) redirect('/login')

  const { data: investmentsData } = await supabase
    .from('investments')
    .select('id, name, type, current_value')
    .eq('user_id', user.id)
    .order('name', { ascending: true })

  const investments = investmentsData ?? []

  const { data: txData } = await supabase
    .from('transactions')
    .select('*')
    .eq('user_id', user.id)
    .returns<Transaction[]>()

  const allTxs: Transaction[] = txData ?? []

  const options: InvestmentOption[] = investments.map((inv) => ({
    id: inv.id,
    name: inv.name,
    type: inv.type,
    current_value: inv.current_value,
    quantityHeld: heldQuantity(inv.id, allTxs),
  }))

  return (
    <div className="mx-auto max-w-3xl space-y-6">
      <div>
        <h1 className="text-2xl font-semibold text-slate-900">Record activity</h1>
        <p className="mt-1 text-sm text-slate-600">
          Log a buy, sell, dividend, deposit, withdrawal, interest, or fee.
        </p>
      </div>

      <TransactionForm investments={options} />
    </div>
  )
}