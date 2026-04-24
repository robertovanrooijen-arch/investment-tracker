import { notFound } from 'next/navigation'
import { createClient } from '@/lib/supabase/server'
import { PageHeader } from '@/components/ui/page-header'
import { TransactionForm } from '@/components/transactions/transaction-form'
import { DeleteTransactionButton } from '@/components/transactions/delete-transaction-button'
import type { Transaction, Investment } from '@/types/database'

type InvestmentOption = Pick<Investment, 'id' | 'name' | 'ticker' | 'type'>

export default async function EditTransactionPage({
  params,
}: {
  params: Promise<{ id: string }>
}) {
  const { id } = await params
  const supabase = await createClient()

  const [txRes, invRes] = await Promise.all([
    supabase
      .from('transactions')
      .select('*')
      .eq('id', id)
      .single<Transaction>(),
    supabase
      .from('investments')
      .select('id, name, ticker, type')
      .order('name', { ascending: true })
      .returns<InvestmentOption[]>(),
  ])

  if (txRes.error || !txRes.data) {
    notFound()
  }

  return (
    <div className="space-y-6">
      <PageHeader title="Edit transaction" />
      <TransactionForm investments={invRes.data ?? []} initial={txRes.data} />
      <div className="pt-2 max-w-2xl">
        <DeleteTransactionButton transactionId={txRes.data.id} />
      </div>
    </div>
  )
}
