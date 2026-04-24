import { notFound } from 'next/navigation'
import { createClient } from '@/lib/supabase/server'
import { PageHeader } from '@/components/ui/page-header'
import { InvestmentForm } from '@/components/investments/investment-form'
import { DeleteInvestmentButton } from '@/components/investments/delete-investment-button'
import type { Investment } from '@/types/database'

export default async function EditInvestmentPage({
  params,
}: {
  params: Promise<{ id: string }>
}) {
  const { id } = await params
  const supabase = await createClient()

  const { data, error } = await supabase
    .from('investments')
    .select('*')
    .eq('id', id)
    .single<Investment>()

  if (error || !data) {
    notFound()
  }

  return (
    <div className="space-y-6">
      <PageHeader title="Edit investment" subtitle={data.name} />
      <InvestmentForm initial={data} />
      <div className="pt-2 max-w-2xl">
        <DeleteInvestmentButton
          investmentId={data.id}
          investmentName={data.name}
        />
      </div>
    </div>
  )
}