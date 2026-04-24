import { createClient } from '@/lib/supabase/server'
import { PageHeader } from '@/components/ui/page-header'
import { TransactionForm } from '@/components/transactions/transaction-form'
import type { Investment } from '@/types/database'

type InvestmentOption = Pick<Investment, 'id' | 'name' | 'ticker' | 'type'>

export default async function NewTransactionPage() {
  const supabase = await createClient()

  const { data: investments } = await supabase
    .from('investments')
    .select('id, name, ticker, type')
    .order('name', { ascending: true })
    .returns<InvestmentOption[]>()

  return (
    <div className="space-y-6">
      <PageHeader
        title="Add transaction"
        subtitle="Record a buy, sell, deposit, withdrawal, or value update."
      />
      <TransactionForm investments={investments ?? []} />
    </div>
  )
}