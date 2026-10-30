import { createClient } from '@/lib/supabase/server'
import { PageHeader } from '@/components/ui/page-header'
import { ReturnsView } from '@/components/returns/returns-view'
import { loadReturns } from '@/lib/returns/load-returns'
import { todayLocalIso } from '@/lib/domain/snapshot'

export const dynamic = 'force-dynamic'

export default async function ReturnsPage() {
  const supabase = await createClient()
  const data = await loadReturns(supabase, todayLocalIso())

  return (
    <div className="space-y-6">
      <PageHeader
        title="Returns"
        subtitle="How well your investments did, regardless of when you added or withdrew money."
      />
      <ReturnsView data={data} />
    </div>
  )
}
