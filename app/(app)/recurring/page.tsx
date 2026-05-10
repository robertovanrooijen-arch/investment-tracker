import Link from 'next/link'
import { redirect } from 'next/navigation'
import { createClient } from '@/lib/supabase/server'
import { PageHeader } from '@/components/ui/page-header'
import { Badge } from '@/components/ui/badge'
import { fmtDate } from '@/lib/format'
import { computeNextDueDate } from '@/lib/domain/recurring'
import type { RecurringTransaction } from '@/types/database'

export const dynamic = 'force-dynamic'

type RuleRow = RecurringTransaction & {
  investment: { name: string; currency: string } | null
}

function ordinal(n: number): string {
  const s = ['th', 'st', 'nd', 'rd']
  const v = n % 100
  return n + (s[(v - 20) % 10] || s[v] || s[0])
}

const DAY_NAMES = [
  'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday',
]

function describeSchedule(rule: RecurringTransaction): string {
  if (rule.frequency === 'weekly' && rule.day_of_week !== null) {
    return `Every ${DAY_NAMES[rule.day_of_week] ?? String(rule.day_of_week)}`
  }
  if (rule.day_of_month !== null) {
    const label = rule.frequency === 'quarterly' ? 'Quarterly' : 'Monthly'
    return `${label} on the ${ordinal(rule.day_of_month)}`
  }
  return rule.frequency
}

function safeNextDue(rule: RecurringTransaction): string | null {
  try {
    return computeNextDueDate(rule).toISOString().slice(0, 10)
  } catch {
    return null
  }
}

export default async function RecurringPage() {
  const supabase = await createClient()

  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) redirect('/login')

  const { data, error } = await supabase
    .from('recurring_transactions')
    .select('*, investment:investments(name, currency)')
    .eq('user_id', user.id)
    .order('created_at', { ascending: false })
    .returns<RuleRow[]>()

  const rules = data ?? []

  return (
    <div className="space-y-6">
      <PageHeader
        title="Recurring rules"
        subtitle="Automatic transactions generated on a schedule."
        action={
          <Link
            href="/recurring/new"
            className="inline-flex items-center justify-center rounded-lg bg-slate-900 px-4 py-2 text-sm font-medium text-white hover:bg-slate-800"
          >
            + Add rule
          </Link>
        }
      />

      {error && (
        <div className="bg-white rounded-2xl border border-rose-200 p-6 text-sm text-rose-600">
          Could not load rules: {error.message}
        </div>
      )}

      {!error && rules.length === 0 && (
        <div className="bg-white rounded-2xl border border-slate-200 p-10 text-center">
          <p className="text-slate-900 font-medium">No recurring rules yet</p>
          <p className="text-sm text-slate-500 mt-1">
            Add a rule to automatically generate buys or fees on a schedule.
          </p>
          <Link
            href="/recurring/new"
            className="mt-4 inline-flex items-center justify-center rounded-lg bg-slate-900 px-4 py-2 text-sm font-medium text-white hover:bg-slate-800"
          >
            + Add rule
          </Link>
        </div>
      )}

      {!error && rules.length > 0 && (
        <div className="bg-white rounded-2xl border border-slate-200 overflow-hidden">
          {/* Desktop table */}
          <table className="hidden md:table w-full">
            <thead>
              <tr className="text-left text-xs uppercase tracking-wide text-slate-500 border-b border-slate-200">
                <th className="px-6 py-3 font-medium">Investment</th>
                <th className="px-6 py-3 font-medium">Type</th>
                <th className="px-6 py-3 font-medium">Schedule</th>
                <th className="px-6 py-3 font-medium">Amount</th>
                <th className="px-6 py-3 font-medium">Next due</th>
                <th className="px-6 py-3 font-medium">Status</th>
                <th className="px-6 py-3" />
              </tr>
            </thead>
            <tbody>
              {rules.map((rule) => {
                const nextDue = safeNextDue(rule)
                const isEnded =
                  rule.end_date !== null &&
                  nextDue !== null &&
                  nextDue > rule.end_date
                const statusLabel = !rule.active
                  ? 'Paused'
                  : isEnded
                    ? 'Ended'
                    : 'Active'
                const statusClass = !rule.active
                  ? 'bg-slate-100 text-slate-500'
                  : isEnded
                    ? 'bg-slate-100 text-slate-500'
                    : 'bg-emerald-100 text-emerald-700'

                return (
                  <tr
                    key={rule.id}
                    className="border-b last:border-b-0 border-slate-100 hover:bg-slate-50"
                  >
                    <td className="px-6 py-4">
                      <div className="font-medium text-slate-900">
                        {rule.investment?.name ?? 'Unknown'}
                      </div>
                      <div className="text-xs text-slate-500">
                        {rule.investment?.currency}
                      </div>
                    </td>
                    <td className="px-6 py-4">
                      <Badge className="bg-slate-100 text-slate-700">
                        {rule.type}
                      </Badge>
                    </td>
                    <td className="px-6 py-4 text-sm text-slate-700">
                      {describeSchedule(rule)}
                    </td>
                    <td className="px-6 py-4 text-sm text-slate-700">
                      {rule.fixed_amount !== null
                        ? `${rule.fixed_amount} ${rule.fixed_amount_currency ?? ''}`
                        : '—'}
                    </td>
                    <td className="px-6 py-4 text-sm text-slate-700">
                      {isEnded ? '—' : nextDue ? fmtDate(nextDue) : '—'}
                    </td>
                    <td className="px-6 py-4">
                      <Badge className={statusClass}>{statusLabel}</Badge>
                    </td>
                    <td className="px-6 py-4 text-right">
                      <Link
                        href={`/recurring/${rule.id}/edit`}
                        className="text-sm font-medium text-slate-700 hover:text-slate-900"
                      >
                        Edit
                      </Link>
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>

          {/* Mobile cards */}
          <ul className="md:hidden divide-y divide-slate-100">
            {rules.map((rule) => {
              const nextDue = safeNextDue(rule)
              const isEnded =
                rule.end_date !== null &&
                nextDue !== null &&
                nextDue > rule.end_date
              const statusLabel = !rule.active
                ? 'Paused'
                : isEnded
                  ? 'Ended'
                  : 'Active'
              const statusClass = !rule.active || isEnded
                ? 'bg-slate-100 text-slate-500'
                : 'bg-emerald-100 text-emerald-700'

              return (
                <li key={rule.id}>
                  <Link
                    href={`/recurring/${rule.id}/edit`}
                    className="block px-5 py-4 hover:bg-slate-50"
                  >
                    <div className="flex items-start justify-between gap-3">
                      <div className="min-w-0">
                        <div className="font-medium text-slate-900 truncate">
                          {rule.investment?.name ?? 'Unknown'}
                        </div>
                        <div className="mt-1 flex flex-wrap items-center gap-2 text-xs text-slate-500">
                          <Badge className="bg-slate-100 text-slate-700">
                            {rule.type}
                          </Badge>
                          <span>·</span>
                          <span>{describeSchedule(rule)}</span>
                        </div>
                        <div className="mt-1 text-xs text-slate-500">
                          {rule.fixed_amount} {rule.fixed_amount_currency}
                        </div>
                      </div>
                      <div className="text-right shrink-0">
                        <Badge className={statusClass}>{statusLabel}</Badge>
                        {!isEnded && nextDue && (
                          <div className="mt-1 text-xs text-slate-500">
                            {fmtDate(nextDue)}
                          </div>
                        )}
                      </div>
                    </div>
                  </Link>
                </li>
              )
            })}
          </ul>
        </div>
      )}
    </div>
  )
}
