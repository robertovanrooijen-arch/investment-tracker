'use client'

import { useEffect, useState, useCallback } from 'react'
import type { ReactNode } from 'react'
import { AccountPrivacyContext } from './privacy-context'

const STORAGE_KEY = 'investie:hide-account-details'

export function AccountPrivacyProvider({ children }: { children: ReactNode }) {
  // Starts "hidden" (the safe default) until we've actually read the stored
  // preference on the client. The alternative — defaulting to "visible" —
  // would mean every page load briefly renders real euro amounts before the
  // effect below can correct it back to "hidden" for users who chose that.
  // A brief placeholder-first paint for "visible" users is an acceptable
  // trade; a brief real-amount flash for "hidden" users is not.
  const [hidden, setHidden] = useState(true)
  const [ready, setReady] = useState(false)

  useEffect(() => {
    try {
      const stored = localStorage.getItem(STORAGE_KEY)
      setHidden(stored === null ? false : stored === 'true')
    } catch {
      // Storage unavailable (private browsing, blocked, etc.) — fall back to visible.
      setHidden(false)
    }
    setReady(true)
  }, [])

  const toggle = useCallback(() => {
    setHidden((prev) => {
      const next = !prev
      try {
        localStorage.setItem(STORAGE_KEY, String(next))
      } catch {
        // Ignore — preference just won't persist this session.
      }
      return next
    })
  }, [])

  return (
    <AccountPrivacyContext.Provider value={{ ready, hidden, toggle }}>
      {children}
    </AccountPrivacyContext.Provider>
  )
}
