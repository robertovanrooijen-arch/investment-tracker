'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { createClient } from '@/lib/supabase/client'
import { Button } from '@/components/ui/button'

type Props = {
  ruleId: string
}

export function DeleteRecurringButton({ ruleId }: Props) {
  const router = useRouter()
  const supabase = createClient()
  const [deleting, setDeleting] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function onDelete() {
    const confirmed = window.confirm(
      'Delete this recurring rule? Past generated transactions are kept.',
    )
    if (!confirmed) return

    setDeleting(true)
    setError(null)

    const { error: delErr } = await supabase
      .from('recurring_transactions')
      .delete()
      .eq('id', ruleId)

    if (delErr) {
      setError(delErr.message)
      setDeleting(false)
      return
    }

    router.push('/recurring')
    router.refresh()
  }

  return (
    <div>
      <Button variant="danger" onClick={onDelete} disabled={deleting}>
        {deleting ? 'Deleting…' : 'Delete rule'}
      </Button>
      {error && <p className="mt-2 text-sm text-rose-600">{error}</p>}
    </div>
  )
}
