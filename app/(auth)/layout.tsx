import { redirect } from 'next/navigation'
import { createClient } from '@/lib/supabase/server'

export default async function AuthLayout({
  children,
}: {
  children: React.ReactNode
}) {
  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()

  if (user) {
    redirect('/dashboard')
  }

  return (
    <div className="min-h-screen bg-slate-50 flex flex-col items-center justify-center px-4">
      <div className="mb-6 flex items-center gap-2.5">
        <div className="w-9 h-9 rounded-xl bg-slate-900 text-white flex items-center justify-center font-bold">
          I
        </div>
        <span className="font-semibold text-slate-900">Investie</span>
      </div>
      <div className="w-full max-w-sm bg-white rounded-2xl border border-slate-200 p-6 md:p-8">
        {children}
      </div>
    </div>
  )
}