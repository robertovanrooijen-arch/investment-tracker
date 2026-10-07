import { AccountPrivacyToggle } from './account-privacy-toggle'

/**
 * Mobile's equivalent of the Sidebar header — BottomNav only carries page
 * links, so this is the one persistent, global strip on small screens where
 * an app-wide (non-navigational) control like the privacy toggle belongs,
 * instead of a floating fixed button layered on top of page content.
 */
export function MobileTopBar() {
  return (
    <header className="md:hidden fixed top-0 inset-x-0 z-20 flex items-center justify-between bg-white border-b border-slate-200 px-4 py-2.5">
      <div className="flex items-center gap-2">
        <div className="w-7 h-7 rounded-lg bg-slate-900 text-white flex items-center justify-center text-sm font-bold">
          I
        </div>
        <span className="font-semibold text-slate-900 text-sm">Investie</span>
      </div>
      <AccountPrivacyToggle />
    </header>
  )
}
