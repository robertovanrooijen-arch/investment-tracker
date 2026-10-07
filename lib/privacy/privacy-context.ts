import { createContext, useContext } from 'react'

export type AccountPrivacyContextValue = {
  /** True once localStorage has been read on the client — see AccountPrivacyProvider for why this matters. */
  ready: boolean
  hidden: boolean
  toggle: () => void
}

// Exported (only) so tests can render PrivacyValue/PrivacyGate/PrivacyMoney
// under a controlled value via <AccountPrivacyContext.Provider value={...}>,
// without going through the real Provider's localStorage/mount-effect
// machinery — that machinery is a separate, UI-level concern from "does the
// component actually hide the value when told to". Kept in its own
// JSX-free .ts module (the Provider itself lives in privacy-provider.tsx)
// so plain Node tooling can import this half without a JSX transform.
export const AccountPrivacyContext = createContext<AccountPrivacyContextValue>({
  ready: false,
  hidden: true,
  toggle: () => {},
})

export function useAccountPrivacy(): AccountPrivacyContextValue {
  return useContext(AccountPrivacyContext)
}
