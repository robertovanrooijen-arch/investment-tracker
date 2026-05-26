'use client'

import { useState, useMemo } from 'react'
import type { ReactNode } from 'react'
import {
  LineChart,
  Line,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
  ReferenceLine,
} from 'recharts'
import { money } from '@/lib/format'
import { computeProjection } from '@/lib/domain/projection'
import type { ProjectionInput, RecurringFrequency } from '@/lib/domain/projection'

// ── Input helpers ──────────────────────────────────────────────────────────

function parseNum(s: string, fallback = 0): number {
  const n = parseFloat(s.replace(',', '.'))
  return Number.isFinite(n) ? n : fallback
}

function clamp(n: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, n))
}

// ── Sub-components ─────────────────────────────────────────────────────────

function Field({
  label,
  hint,
  children,
}: {
  label: string
  hint?: string
  children: ReactNode
}) {
  return (
    <div>
      <label className="block text-sm font-medium text-slate-700">{label}</label>
      {hint && <p className="text-xs text-slate-400 mt-0.5">{hint}</p>}
      <div className="mt-1.5">{children}</div>
    </div>
  )
}

function NumInput({
  value,
  onChange,
  placeholder,
  prefix,
  suffix,
  min,
  step,
}: {
  value: string
  onChange: (v: string) => void
  placeholder?: string
  prefix?: string
  suffix?: string
  min?: number
  step?: number
}) {
  return (
    <div className="relative">
      {prefix && (
        <span className="absolute inset-y-0 left-3 flex items-center text-sm text-slate-400 pointer-events-none select-none">
          {prefix}
        </span>
      )}
      <input
        type="number"
        inputMode="decimal"
        value={value}
        min={min}
        step={step}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder ?? '0'}
        className={`w-full rounded-lg border border-slate-200 bg-white py-2 text-sm text-slate-900 placeholder:text-slate-400 focus:border-slate-400 focus:outline-none focus:ring-1 focus:ring-slate-300 ${
          prefix ? 'pl-7 pr-3' : suffix ? 'pl-3 pr-8' : 'px-3'
        }`}
      />
      {suffix && (
        <span className="absolute inset-y-0 right-3 flex items-center text-sm text-slate-400 pointer-events-none select-none">
          {suffix}
        </span>
      )}
    </div>
  )
}

function Presets({
  value,
  options,
  onSelect,
  suffix = '',
}: {
  value: string
  options: (number | string)[]
  onSelect: (v: string) => void
  suffix?: string
}) {
  return (
    <div className="flex flex-wrap gap-1.5 mt-2">
      {options.map((opt) => {
        const str    = String(opt)
        const active = value === str
        return (
          <button
            key={str}
            type="button"
            onClick={() => onSelect(str)}
            className={`px-2.5 py-0.5 rounded-md text-xs font-medium border transition-colors ${
              active
                ? 'bg-slate-900 text-white border-slate-900'
                : 'bg-white text-slate-600 border-slate-200 hover:border-slate-400 hover:text-slate-800'
            }`}
          >
            {opt}{suffix}
          </button>
        )
      })}
    </div>
  )
}

function ResultCard({
  label,
  value,
  sub,
  tone = 'neutral',
}: {
  label: string
  value: string
  sub?: string
  tone?: 'positive' | 'negative' | 'neutral'
}) {
  const valueClass =
    tone === 'positive' ? 'text-emerald-700' :
    tone === 'negative' ? 'text-rose-700' :
    'text-slate-900'

  return (
    <div className="bg-white rounded-2xl border border-slate-200 p-4 md:p-5">
      <p className="text-xs font-medium text-slate-500 uppercase tracking-wide">{label}</p>
      <p className={`mt-1 text-xl font-semibold tabular-nums leading-tight ${valueClass}`}>{value}</p>
      {sub && <p className="mt-0.5 text-xs text-slate-400 leading-snug">{sub}</p>}
    </div>
  )
}

type TooltipEntry = { name: string; value: number; color: string }

function ChartTooltip({
  active,
  payload,
  label,
}: {
  active?: boolean
  payload?: readonly TooltipEntry[]
  label?: number
}) {
  if (!active || !payload?.length) return null
  return (
    <div className="rounded-xl border border-slate-200 bg-white px-3 py-2.5 shadow-lg text-xs min-w-[160px]">
      <p className="font-medium text-slate-700 mb-1.5">
        {label === 0 ? 'Now (year 0)' : `Year ${label}`}
      </p>
      {payload.map((entry) => (
        <div key={entry.name} className="flex items-center justify-between gap-3">
          <div className="flex items-center gap-1.5">
            <span
              className="inline-block h-2 w-2 rounded-full shrink-0"
              style={{ backgroundColor: entry.color }}
            />
            <span className="text-slate-600">{entry.name}</span>
          </div>
          <span className="font-medium text-slate-900 tabular-nums">
            {money(entry.value, 'EUR')}
          </span>
        </div>
      ))}
    </div>
  )
}

// ── Main component ─────────────────────────────────────────────────────────

export function ProjectionCalculator({
  currentPortfolioValue,
}: {
  currentPortfolioValue: number
}) {
  const [startVal,     setStartVal]     = useState(String(Math.round(currentPortfolioValue)))
  const [returnPct,    setReturnPct]    = useState('7')
  const [yearsStr,     setYearsStr]     = useState('20')
  const [oneTime,      setOneTime]      = useState('0')
  const [recurring,    setRecurring]    = useState('0')
  const [freq,         setFreq]         = useState<RecurringFrequency>('monthly')
  const [contribGrow,  setContribGrow]  = useState('0')
  const [target,       setTarget]       = useState('')

  const parsed = useMemo((): ProjectionInput => ({
    startingValue:         clamp(parseNum(startVal),       0, 1e10),
    oneTimeContribution:   clamp(parseNum(oneTime),        0, 1e10),
    annualReturnPct:       clamp(parseNum(returnPct),      0,   50),
    years:                 Math.round(clamp(parseNum(yearsStr, 20), 1, 50)),
    recurringAmount:       clamp(parseNum(recurring),      0, 1e10),
    recurringFrequency:    freq,
    contributionGrowthPct: clamp(parseNum(contribGrow),    0,  100),
    targetAmount:          target.trim() ? (clamp(parseNum(target), 1, 1e12) || null) : null,
  }), [startVal, returnPct, yearsStr, oneTime, recurring, freq, contribGrow, target])

  const result = useMemo(() => computeProjection(parsed), [parsed])

  const chartData = result.rows.map((row) => ({
    year:              row.year,
    'Portfolio value': Math.round(row.portfolioValue),
    'Capital in':      Math.round(row.capitalIn),
  }))

  const growth         = result.totalGrowth
  const growthTone     = growth > 100 ? 'positive' : growth < -100 ? 'negative' : 'neutral'
  const totalCapitalIn = parsed.startingValue + result.totalContributed
  const growthPct      = totalCapitalIn > 0 ? (growth / totalCapitalIn) * 100 : null
  const hasTarget      = parsed.targetAmount !== null

  return (
    <div className="space-y-5">

      {/* ── Inputs ── */}
      <div className="bg-white rounded-2xl border border-slate-200 p-5 md:p-6">
        <h2 className="text-base font-semibold text-slate-900 mb-5">Scenario assumptions</h2>

        <div className="grid grid-cols-1 sm:grid-cols-2 gap-5">

          {/* Starting value */}
          <Field label="Starting portfolio value" hint="Pre-filled from your current portfolio">
            <NumInput
              value={startVal}
              onChange={setStartVal}
              prefix="€"
              placeholder={String(Math.round(currentPortfolioValue))}
              min={0}
            />
          </Field>

          {/* Annual return */}
          <Field label="Expected annual return">
            <NumInput value={returnPct} onChange={setReturnPct} suffix="%" min={0} step={0.5} />
            <Presets value={returnPct} options={[5, 7, 8, 10]} onSelect={setReturnPct} suffix="%" />
          </Field>

          {/* Years */}
          <Field label="Projection period">
            <NumInput value={yearsStr} onChange={setYearsStr} suffix="yr" min={1} step={1} />
            <Presets value={yearsStr} options={[10, 20, 30, 40]} onSelect={setYearsStr} suffix="yr" />
          </Field>

          {/* Target */}
          <Field label="Target amount" hint="Optional — leave blank for no target">
            <NumInput
              value={target}
              onChange={setTarget}
              prefix="€"
              placeholder="e.g. 1000000"
              min={0}
            />
          </Field>

          {/* One-time contribution */}
          <Field label="One-time extra contribution" hint="Added immediately at start, before growth">
            <NumInput value={oneTime} onChange={setOneTime} prefix="€" min={0} />
          </Field>

          {/* Recurring + frequency + growth */}
          <div className="space-y-3">
            <Field label="Recurring contribution">
              <NumInput value={recurring} onChange={setRecurring} prefix="€" min={0} />
            </Field>

            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="block text-xs font-medium text-slate-600 mb-1">Frequency</label>
                <div className="inline-flex rounded-lg border border-slate-200 bg-slate-50 p-0.5 w-full">
                  {(['monthly', 'yearly'] as const).map((f) => (
                    <button
                      key={f}
                      type="button"
                      onClick={() => setFreq(f)}
                      className={`flex-1 rounded-md py-1.5 text-xs font-medium transition-colors ${
                        freq === f
                          ? 'bg-white text-slate-900 shadow-sm'
                          : 'text-slate-500 hover:text-slate-700'
                      }`}
                    >
                      {f === 'monthly' ? 'Monthly' : 'Yearly'}
                    </button>
                  ))}
                </div>
              </div>

              <div>
                <label className="block text-xs font-medium text-slate-600 mb-1">Annual growth</label>
                <NumInput
                  value={contribGrow}
                  onChange={setContribGrow}
                  suffix="%"
                  min={0}
                  step={0.5}
                  placeholder="0"
                />
                <Presets
                  value={contribGrow}
                  options={[0, 2, 5]}
                  onSelect={setContribGrow}
                  suffix="%"
                />
              </div>
            </div>
          </div>

        </div>

        {/* Convention note */}
        <p className="mt-5 text-xs text-slate-500 bg-slate-50 rounded-lg px-3 py-2.5 leading-relaxed">
          Contributions are added at the <span className="font-medium text-slate-700">beginning</span> of each period,
          then growth is applied. Monthly mode compounds at{' '}
          <span className="font-medium text-slate-700">annual rate ÷ 12</span> per month.
          Contribution growth increases the recurring amount by the given percentage each year.
        </p>
      </div>

      {/* ── Summary cards ── */}
      <div className={`grid grid-cols-2 gap-3 ${hasTarget ? 'md:grid-cols-4' : 'md:grid-cols-3'}`}>
        <ResultCard
          label="Final value"
          value={money(result.finalValue, 'EUR')}
          sub={`After ${parsed.years} year${parsed.years !== 1 ? 's' : ''}`}
        />
        <ResultCard
          label="Capital in"
          value={money(parsed.startingValue + result.totalContributed, 'EUR')}
          sub={result.totalContributed > 0
            ? `${money(result.totalContributed, 'EUR')} contributed`
            : 'No contributions'}
        />
        <ResultCard
          label="Investment growth"
          value={`${growth >= 0 ? '+' : ''}${money(growth, 'EUR')}`}
          sub={growthPct !== null
            ? `${growthPct >= 0 ? '+' : ''}${growthPct.toFixed(2)}% return on capital`
            : 'Pure returns on top of capital'}
          tone={growthTone}
        />
        {hasTarget && (
          <ResultCard
            label="Target"
            value={result.targetReachedYear !== null
              ? `Year ${result.targetReachedYear}`
              : 'Not reached'}
            sub={result.targetReachedYear !== null
              ? `${money(parsed.targetAmount!, 'EUR')} goal reached`
              : `Goal: ${money(parsed.targetAmount!, 'EUR')}`}
            tone={result.targetReachedYear !== null ? 'positive' : 'negative'}
          />
        )}
      </div>

      {/* ── Chart ── */}
      <div className="bg-white rounded-2xl border border-slate-200 p-5 md:p-6">
        <div className="flex flex-wrap items-center gap-x-5 gap-y-2 mb-4">
          <h2 className="text-base font-semibold text-slate-900">Growth projection</h2>
          <div className="flex items-center gap-4 text-xs text-slate-500">
            <span className="flex items-center gap-1.5">
              <span className="inline-block h-2.5 w-5 rounded-full bg-slate-900" />
              Portfolio value
            </span>
            <span className="flex items-center gap-1.5">
              <span
                className="inline-block h-0 w-5 border-t-2 border-dashed"
                style={{ borderColor: '#94a3b8' }}
              />
              Capital in
            </span>
          </div>
        </div>

        <div className="h-64 md:h-80">
          <ResponsiveContainer width="100%" height="100%">
            <LineChart data={chartData} margin={{ top: 8, right: 8, bottom: 8, left: 0 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="#e2e8f0" />

              <XAxis
                dataKey="year"
                tick={{ fontSize: 12, fill: '#64748b' }}
                stroke="#cbd5e1"
                label={{
                  value: 'Years',
                  position: 'insideBottomRight',
                  offset: -4,
                  fontSize: 11,
                  fill: '#94a3b8',
                }}
              />

              <YAxis
                tickFormatter={(v) => money(typeof v === 'number' ? v : Number(v), 'EUR')}
                tick={{ fontSize: 11, fill: '#64748b' }}
                stroke="#cbd5e1"
                width={90}
              />

              <Tooltip
                content={(props) =>
                  <ChartTooltip
                    active={(props as unknown as { active?: boolean }).active}
                    payload={(props as unknown as { payload?: readonly TooltipEntry[] }).payload}
                    label={(props as unknown as { label?: number }).label}
                  />
                }
              />

              {parsed.targetAmount && (
                <ReferenceLine
                  y={parsed.targetAmount}
                  stroke="#f59e0b"
                  strokeDasharray="4 4"
                  strokeWidth={1.5}
                  label={{
                    value: `Target: ${money(parsed.targetAmount, 'EUR')}`,
                    position: 'insideTopLeft',
                    fontSize: 10,
                    fill: '#b45309',
                  }}
                />
              )}

              <Line
                type="monotone"
                dataKey="Portfolio value"
                stroke="#0f172a"
                strokeWidth={2.5}
                dot={false}
                activeDot={{ r: 4 }}
              />
              <Line
                type="monotone"
                dataKey="Capital in"
                stroke="#94a3b8"
                strokeWidth={1.5}
                strokeDasharray="5 3"
                dot={false}
                activeDot={{ r: 3 }}
              />
            </LineChart>
          </ResponsiveContainer>
        </div>
      </div>

      {/* ── Year-by-year table ── */}
      <div className="bg-white rounded-2xl border border-slate-200 overflow-hidden">
        <div className="px-5 md:px-6 py-4 border-b border-slate-100">
          <h2 className="text-base font-semibold text-slate-900">Year-by-year breakdown</h2>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="bg-slate-50 border-b border-slate-100">
                <th className="text-left px-5 md:px-6 py-3 text-xs font-medium text-slate-500 uppercase tracking-wide whitespace-nowrap">
                  Year
                </th>
                <th className="text-right px-4 py-3 text-xs font-medium text-slate-500 uppercase tracking-wide whitespace-nowrap">
                  Portfolio value
                </th>
                <th className="text-right px-4 py-3 text-xs font-medium text-slate-500 uppercase tracking-wide whitespace-nowrap">
                  Capital in
                </th>
                <th className="text-right px-4 py-3 text-xs font-medium text-slate-500 uppercase tracking-wide whitespace-nowrap hidden sm:table-cell">
                  Growth
                </th>
                <th className="text-right px-5 md:px-6 py-3 text-xs font-medium text-slate-500 uppercase tracking-wide whitespace-nowrap hidden sm:table-cell">
                  Added
                </th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-50">
              {result.rows.map((row) => {
                const isTarget = hasTarget && result.targetReachedYear === row.year
                return (
                  <tr
                    key={row.year}
                    className={`transition-colors ${
                      isTarget ? 'bg-emerald-50' : 'hover:bg-slate-50'
                    }`}
                  >
                    <td className="px-5 md:px-6 py-3 font-medium text-slate-700 tabular-nums whitespace-nowrap">
                      {row.year === 0 ? 'Now' : row.year}
                      {isTarget && (
                        <span className="ml-2 text-xs font-medium text-emerald-600">
                          ✓ target
                        </span>
                      )}
                    </td>
                    <td className="px-4 py-3 text-right font-semibold text-slate-900 tabular-nums">
                      {money(row.portfolioValue, 'EUR')}
                    </td>
                    <td className="px-4 py-3 text-right text-slate-500 tabular-nums">
                      {money(row.capitalIn, 'EUR')}
                    </td>
                    <td className="px-4 py-3 text-right tabular-nums hidden sm:table-cell">
                      <span className={row.growth > 0 ? 'text-emerald-700' : row.growth < 0 ? 'text-rose-700' : 'text-slate-500'}>
                        {row.growth >= 0 ? '+' : ''}{money(row.growth, 'EUR')}
                      </span>
                    </td>
                    <td className="px-5 md:px-6 py-3 text-right text-slate-400 tabular-nums hidden sm:table-cell">
                      {row.yearContrib > 0 ? money(row.yearContrib, 'EUR') : '—'}
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      </div>

      {/* ── Disclaimer ── */}
      <p className="text-xs text-slate-400 leading-relaxed px-1">
        <span className="font-medium text-slate-500">Disclaimer: </span>
        This is a projection based on assumptions, not financial advice. Real returns, taxes,
        inflation, currency changes, and fees are not included. Past performance does not
        guarantee future results.
      </p>
    </div>
  )
}
