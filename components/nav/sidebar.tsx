'use client'

import Link from 'next/link'
import { usePathname } from 'next/navigation'
import { Icon } from '@/components/ui/icon'
import { NAV_ITEMS } from './nav-items'
import { SignOutButton } from './sign-out-button'

export function Sidebar({ userEmail }: { userEmail: string }) {
  const pathname = usePathname()

  const isActive = (href: string) =>
    pathname === href || pathname.startsWith(href + '/')

  return (
    <aside className="hidden md:flex fixed inset-y-0 left-0 w-64 bg-white border-r border-slate-200 flex-col px-4 py-6 z-20">
      <div className="flex items-center gap-2.5 px-2 mb-8">
        <div className="w-9 h-9 rounded-xl bg-slate-900 text-white flex items-center justify-center font-bold">
          P
        </div>
        <div>
          <div className="font-semibold text-slate-900 leading-tight">Portfolio</div>
          <div className="text-xs text-slate-500">MVP</div>
        </div>
      </div>

      <nav className="flex flex-col gap-1">
        {NAV_ITEMS.map((item) => {
          const active = isActive(item.href)
          return (
            <Link
              key={item.href}
              href={item.href}
              className={`flex items-center gap-3 px-3 py-2.5 rounded-xl text-sm font-medium transition ${
                active
                  ? 'bg-slate-900 text-white shadow-sm'
                  : 'text-slate-600 hover:bg-slate-100 hover:text-slate-900'
              }`}
            >
              <Icon name={item.icon} className="w-[18px] h-[18px]" />
              {item.label}
            </Link>
          )
        })}
      </nav>

      <div className="mt-auto pt-6 border-t border-slate-100 space-y-2">
        <div className="flex items-center gap-3 px-2">
          <div className="w-9 h-9 rounded-full bg-gradient-to-br from-indigo-500 to-indigo-700 text-white flex items-center justify-center text-sm font-semibold">
            {userEmail.charAt(0).toUpperCase() || 'U'}
          </div>
          <div className="min-w-0">
            <div className="text-sm font-medium text-slate-800 truncate">{userEmail}</div>
            <div className="text-xs text-slate-500">Base currency: EUR</div>
          </div>
        </div>
        <SignOutButton />
      </div>
    </aside>
  )
}