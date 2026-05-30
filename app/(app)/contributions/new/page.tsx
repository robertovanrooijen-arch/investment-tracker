import { redirect } from 'next/navigation'
import { createClient } from '@/lib/supabase/server'
import { PageHeader } from '@/components/ui/page-header'
import { CapitalFlowForm } from '@/components/contributions/capital-flow-form'

export const dynamic = 'force-dynamic'

export default async function NewCapitalFlowPage() {
  const supabase = await createClient()

  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) redirect('/login')

  // Fetch existing platform names for autocomplete suggestions
  const { data: rows } = await supabase
    .from('capital_flow_entries')
    .select('platform')
    .order('platform', { ascending: true })

  const knownPlatforms = Array.from(
    new Set((rows ?? []).map((r) => r.platform as string))
  )

  return (
    <div className="mx-auto max-w-2xl space-y-6">
      <PageHeader
        title="Record capital flow"
        subtitle="Log money sent to or received from a portfolio platform."
      />
      <CapitalFlowForm knownPlatforms={knownPlatforms} />
    </div>
  )
}
