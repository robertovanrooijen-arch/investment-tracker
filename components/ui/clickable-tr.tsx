'use client'

import { useRouter } from 'next/navigation'
import type { ReactNode } from 'react'

type Props = {
  href: string
  className?: string
  children: ReactNode
}

export function ClickableTr({ href, className = '', children }: Props) {
  const router = useRouter()

  function navigate(e: React.MouseEvent) {
    const sel = typeof window !== 'undefined' ? window.getSelection() : null
    if (sel?.toString().length) return
    if (e.metaKey || e.ctrlKey) { window.open(href, '_blank'); return }
    router.push(href)
  }

  return (
    <tr
      tabIndex={0}
      onClick={navigate}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault()
          router.push(href)
        }
      }}
      className={`cursor-pointer focus:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-slate-300 ${className}`}
    >
      {children}
    </tr>
  )
}
