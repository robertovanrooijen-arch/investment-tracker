'use client'

import { Icon } from '@/components/ui/icon'
import { useAccountPrivacy } from '@/lib/privacy/privacy-context'

/**
 * Rendered inside the real nav chrome — the desktop Sidebar's header row and
 * the mobile MobileTopBar — rather than as its own floating fixed element, so
 * it's part of the same persistent nav surface every page already gets, not
 * a layer that can drift out of position or collide with page content.
 * Toggles the single AccountPrivacyContext every money-rendering component
 * reads from.
 */
export function AccountPrivacyToggle({ className = '' }: { className?: string }) {
  const { hidden, ready, toggle } = useAccountPrivacy()

  const label = hidden ? 'Show account details' : 'Hide account details'

  return (
    <button
      type="button"
      onClick={toggle}
      title={label}
      aria-label={label}
      aria-pressed={hidden}
      disabled={!ready}
      className={`inline-flex items-center justify-center rounded-lg border border-slate-200 bg-white p-2.5 text-slate-600 shadow-sm transition-colors hover:bg-slate-50 hover:text-slate-900 focus:outline-none focus-visible:ring-2 focus-visible:ring-slate-300 disabled:opacity-60 ${className}`}
    >
      <Icon name={ready && hidden ? 'eye-off' : 'eye'} className="w-[18px] h-[18px]" />
    </button>
  )
}
