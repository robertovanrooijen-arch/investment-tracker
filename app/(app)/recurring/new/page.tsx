import { redirect } from 'next/navigation'
import { createClient } from '@/lib/supabase/server'
import { PageHeader } from '@/components/ui/page-header'
import {
  RecurringForm,
  type InvestmentOption,
} from '@/components/recurring/recurring-form'
import type { InvestmentType } from '@/types/database'

export const dynamic = 'force-dynamic'

export default async function NewRecurringPage() {
  const supabase = await createClient()

  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) redirect('/login')

  const { data: invData } = await supabase
    .from('investments')
    .select('id, name, currency, type')
    .eq('user_id', user.id)
    .order('name', { ascending: true })
    .returns<Array<{ id: string; name: string; currency: string; type: InvestmentType }>>()

  const investments: InvestmentOption[] = (invData ?? []).map((inv) => ({
    id: inv.id,
    name: inv.name,
    currency: inv.currency,
    type: inv.type,
  }))

  return (
    <div className="space-y-6">
      <PageHeader
        title="New recurring rule"
        subtitle="Schedule automatic buys or fees for an investment."
      />
      <RecurringForm investments={investments} />
    </div>
  )
}
