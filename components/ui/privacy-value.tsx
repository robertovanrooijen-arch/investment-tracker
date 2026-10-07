'use client'

import type { ReactNode } from 'react'
import { useAccountPrivacy } from '@/lib/privacy/privacy-context'
import { money } from '@/lib/format'

/**
 * The single switch every privacy-sensitive value in the app should go
 * through, instead of a scattered `if (hidden) ... else ...` at every call
 * site. `amount` is what renders in normal mode; `privacyFallback` is what
 * renders instead while hidden (typically a percentage, or '—'). Neither
 * branch renders until the stored preference has actually been read on the
 * client, so a real amount can never flash before privacy mode applies.
 */
export function PrivacyValue({
  amount,
  privacyFallback = '—',
  className,
}: {
  amount: ReactNode
  privacyFallback?: ReactNode
  className?: string
}) {
  const { hidden, ready } = useAccountPrivacy()

  if (!ready) {
    // Same footprint either way so switching to the real content doesn't
    // visibly jump — resolved within one client-side tick after mount.
    return <span className={className}>&nbsp;</span>
  }

  return <span className={className}>{hidden ? privacyFallback : amount}</span>
}

/**
 * Hides `children` entirely in privacy mode (optionally showing `fallback`
 * instead) — for things with no sensible masked form, like a share count.
 */
export function PrivacyGate({
  children,
  fallback = null,
}: {
  children: ReactNode
  fallback?: ReactNode
}) {
  const { hidden, ready } = useAccountPrivacy()
  if (!ready) return null
  return <>{hidden ? fallback : children}</>
}

/**
 * Convenience wrapper for the common case: a money amount that should
 * collapse to a percentage (or '—') in privacy mode. `fallbackText` is taken
 * pre-formatted rather than as a raw number, since the app has two different
 * percentage conventions in play (a 0–1 fraction via lib/domain/calculations'
 * `pct()`, vs. an already-×100 number via year-analysis' `safePercent()`) —
 * callers already know which one applies, so formatting stays at the call
 * site instead of this component guessing a scale.
 */
export function PrivacyMoney({
  value,
  currency = 'EUR',
  signed = false,
  fallbackText = '—',
  className,
}: {
  value: number | null | undefined
  currency?: string
  signed?: boolean
  fallbackText?: string
  className?: string
}) {
  const amountText =
    value === null || value === undefined || Number.isNaN(value)
      ? '—'
      : signed
        ? `${value >= 0 ? '+' : ''}${money(value, currency)}`
        : money(value, currency)

  return <PrivacyValue amount={amountText} privacyFallback={fallbackText} className={className} />
}
