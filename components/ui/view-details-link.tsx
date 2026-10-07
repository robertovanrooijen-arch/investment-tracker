import Link from 'next/link'

/**
 * Shared "jump to the detail page" affordance for a card header — introduced
 * for the Asset Allocation donut, reused here for Profit/Loss so every
 * "there's more detail behind this card" link looks and behaves the same.
 */
export function ViewDetailsLink({ href, label = 'View details' }: { href: string; label?: string }) {
  return (
    <Link href={href} className="text-xs font-medium text-slate-500 hover:text-slate-900 shrink-0">
      {label} →
    </Link>
  )
}
