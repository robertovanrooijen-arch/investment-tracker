'use client'

import { useCallback, useSyncExternalStore } from 'react'
import type { ReactNode } from 'react'
import { AccountPrivacyContext } from './privacy-context'

const STORAGE_KEY = 'investie:hide-account-details'
const CHANGE_EVENT = 'investie:privacy-change'

function subscribe(onStoreChange: () => void) {
  window.addEventListener('storage', onStoreChange)
  window.addEventListener(CHANGE_EVENT, onStoreChange)
  return () => {
    window.removeEventListener('storage', onStoreChange)
    window.removeEventListener(CHANGE_EVENT, onStoreChange)
  }
}

function getHiddenSnapshot() {
  try {
    return localStorage.getItem(STORAGE_KEY) === 'true'
  } catch {
    return false
  }
}

export function AccountPrivacyProvider({ children }: { children: ReactNode }) {
  // Starts "hidden" (the safe default) until we've actually read the stored
  // preference on the client. The alternative — defaulting to "visible" —
  // would mean every page load briefly renders real euro amounts before the
  // effect below can correct it back to "hidden" for users who chose that.
  // A brief placeholder-first paint for "visible" users is an acceptable
  // trade; a brief real-amount flash for "hidden" users is not.
  const hidden = useSyncExternalStore(subscribe, getHiddenSnapshot, () => true)
  const ready = useSyncExternalStore(subscribe, () => true, () => false)

  const toggle = useCallback(() => {
    const next = !getHiddenSnapshot()
    try {
      localStorage.setItem(STORAGE_KEY, String(next))
    } catch {
      // Ignore — preference just won't persist this session.
    }
    window.dispatchEvent(new Event(CHANGE_EVENT))
  }, [])

  return (
    <AccountPrivacyContext.Provider value={{ ready, hidden, toggle }}>
      {children}
    </AccountPrivacyContext.Provider>
  )
}
