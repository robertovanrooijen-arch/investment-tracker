'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { createClient } from '@/lib/supabase/client'
import { Button } from '@/components/ui/button'

type Props = {
  investmentId: string
  investmentName: string
}

export function DeleteInvestmentButton({ investmentId, investmentName }: Props) {
  const router = useRouter()
  const supabase = createClient()
  const [deleting, setDeleting] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function onDelete() {
    const confirmed = window.confirm(
      `Delete "${investmentName}"? This will also delete any transactions for it.`
    )
    if (!confirmed) return

    setDeleting(true)
    setError(null)

    const { error: delErr } = await supabase
      .from('investments')
      .delete()
      .eq('id', investmentId)

    if (delErr) {
      setError(delErr.message)
      setDeleting(false)
      return
    }

    router.push('/investments')
    router.refresh()
  }

  return (
    <div>
      <Button variant="danger" onClick={onDelete} disabled={deleting}>
        {deleting ? 'Deleting…' : 'Delete investment'}
      </Button>
      {error && <p className="mt-2 text-sm text-rose-600">{error}</p>}
    </div>
  )
}