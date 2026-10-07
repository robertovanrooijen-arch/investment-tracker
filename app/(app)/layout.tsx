import { redirect } from 'next/navigation'
import { createClient } from '@/lib/supabase/server'
import { Sidebar } from '@/components/nav/sidebar'
import { BottomNav } from '@/components/nav/bottom-nav'
import { MobileTopBar } from '@/components/nav/mobile-topbar'
import { AccountPrivacyProvider } from '@/lib/privacy/privacy-context'

export default async function AppLayout({
  children,
}: {
  children: React.ReactNode
}) {
  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()

  if (!user) {
    redirect('/login')
  }

  return (
    <AccountPrivacyProvider>
      <div className="min-h-screen bg-slate-50 text-slate-900">
        <Sidebar userEmail={user.email ?? ''} />
        <BottomNav />
        <MobileTopBar />
        <main className="md:ml-64 pt-14 pb-24 md:pt-0 md:pb-10">
          <div className="max-w-6xl mx-auto px-4 md:px-8 py-6 md:py-10">
            {children}
          </div>
        </main>
      </div>
    </AccountPrivacyProvider>
  )
}