import type { IconName } from '@/components/ui/icon'

export type NavItem = {
  href: string
  label: string
  icon: IconName
}

export const NAV_ITEMS: NavItem[] = [
  { href: '/dashboard', label: 'Dashboard', icon: 'dashboard' },
  { href: '/investments', label: 'Investments', icon: 'investments' },
  { href: '/transactions', label: 'Transactions', icon: 'transactions' },
]