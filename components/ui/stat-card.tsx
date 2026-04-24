import type { ReactNode } from 'react'

type Tone = 'neutral' | 'positive' | 'negative'

type StatCardProps = {
  label: string
  value: ReactNode
  hint?: ReactNode
  tone?: Tone
}

const toneClass: Record<Tone, string> = {
  neutral: 'text-slate-900',
  positive: 'text-emerald-600',
  negative: 'text-rose-600',
}

export function StatCard({
  label,
  value,
  hint,
  tone = 'neutral',
}: StatCardProps) {
  return (
    <div className="bg-white rounded-2xl border border-slate-200 p-5 md:p-6">
      <p className="text-xs uppercase tracking-wide text-slate-500 font-medium">
        {label}
      </p>
      <p
        className={`mt-2 text-2xl md:text-3xl font-semibold tabular-nums ${toneClass[tone]}`}
      >
        {value}
      </p>
      {hint && <p className="mt-1 text-sm text-slate-500">{hint}</p>}
    </div>
  )
}