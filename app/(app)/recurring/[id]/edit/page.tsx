import { notFound, redirect } from 'next/navigation'
import { createClient } from '@/lib/supabase/server'
import { PageHeader } from '@/components/ui/page-header'
import {
  RecurringForm,
  type InvestmentOption,
} from '@/components/recurring/recurring-form'
import { DeleteRecurringButton } from '@/components/recurring/delete-recurring-button'
import type { RecurringTransaction, InvestmentType } from '@/types/database'

export const dynamic = 'force-dynamic'

export default async function EditRecurringPage({
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

  const [{ data: rule, error: ruleError }, { data: invData }] =
    await Promise.all([
      supabase
        .from('recurring_transactions')
        .select('*')
        .eq('id', id)
        .eq('user_id', user.id)
        .single<RecurringTransaction>(),
      supabase
        .from('investments')
        .select('id, name, currency, type')
        .eq('user_id', user.id)
        .order('name', { ascending: true })
        .returns<
          Array<{ id: string; name: string; currency: string; type: InvestmentType }>
        >(),
    ])

  if (ruleError || !rule) notFound()

  const investments: InvestmentOption[] = (invData ?? []).map((inv) => ({
    id: inv.id,
    name: inv.name,
    currency: inv.currency,
    type: inv.type,
  }))

  return (
    <div className="space-y-6">
      <PageHeader title="Edit recurring rule" />
      <RecurringForm investments={investments} initial={rule} />
      <div className="pt-2 max-w-2xl">
        <DeleteRecurringButton ruleId={rule.id} />
      </div>
    </div>
  )
}
