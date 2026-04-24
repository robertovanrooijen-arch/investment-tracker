import type { ReactNode } from 'react'

export type IconName =
  | 'dashboard'
  | 'investments'
  | 'transactions'
  | 'user'
  | 'logout'
  | 'chevron'

const paths: Record<IconName, ReactNode> = {
  dashboard: (
    <>
      <rect x="3" y="3" width="7" height="9" rx="1.5" />
      <rect x="14" y="3" width="7" height="5" rx="1.5" />
      <rect x="14" y="12" width="7" height="9" rx="1.5" />
      <rect x="3" y="16" width="7" height="5" rx="1.5" />
    </>
  ),
  investments: (
    <>
      <path d="M3 17l6-6 4 4 7-8" />
      <path d="M14 7h6v6" />
    </>
  ),
  transactions: (
    <>
      <path d="M7 7h10l-3-3" />
      <path d="M17 17H7l3 3" />
    </>
  ),
  user: (
    <>
      <circle cx="12" cy="8" r="4" />
      <path d="M4 21c0-4 4-6 8-6s8 2 8 6" />
    </>
  ),
  logout: (
    <>
      <path d="M15 12H3" />
      <path d="M11 8l-4 4 4 4" />
      <path d="M15 4h4a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2h-4" />
    </>
  ),
  chevron: <path d="M9 6l6 6-6 6" />,
}

export function Icon({
  name,
  className = 'w-5 h-5',
}: {
  name: IconName
  className?: string
}) {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
    >
      {paths[name]}
    </svg>
  )
}