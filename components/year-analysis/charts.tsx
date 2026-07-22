'use client'

import { useCallback } from 'react'
import type { ReactNode } from 'react'
import {
  BarChart,
  Bar,
  Cell,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
  PieChart,
  Pie,
  ReferenceLine,
} from 'recharts'
import { money } from '@/lib/format'
import type {
  BridgeStep,
  AssetClassSummary,
  AssetPnlRankingRow,
  MonthlyCashflowRow,
} from '@/lib/domain/year-analysis'

// ── Shared style helpers ────────────────────────────────────────────────────

const TONE_COLOR = {
  positive: '#10b981', // emerald-500
  negative: '#ef4444', // rose-500
  neutral: '#0f172a',  // slate-900
} as const

const TYPE_COLORS: Record<string, string> = {
  stock: '#3b82f6',
  ETF: '#8b5cf6',
  crypto: '#f59e0b',
  cash: '#10b981',
  'real estate': '#ef4444',
  commodity: '#d97706',
  custom: '#6b7280',
}

const TYPE_LABELS: Record<string, string> = {
  stock: 'Stock',
  ETF: 'ETF',
  crypto: 'Crypto',
  cash: 'Cash',
  'real estate': 'Real Estate',
  commodity: 'Commodity',
  custom: 'Custom',
}

function fmtSigned(n: number): string {
  return `${n >= 0 ? '+' : ''}${money(n, 'EUR')}`
}

function TooltipBox({ children }: { children: ReactNode }) {
  return (
    <div className="min-w-[160px] rounded-xl border border-slate-200 bg-white px-3 py-2 shadow-lg text-xs">
      {children}
    </div>
  )
}

function EmptyChartCard({ message }: { message: string }) {
  return (
    <div className="rounded-xl border border-dashed border-slate-200 bg-slate-50 p-6 text-center text-sm text-slate-500">
      {message}
    </div>
  )
}

// ── 1. Portfolio bridge / waterfall ─────────────────────────────────────────

function BridgeTooltip({ active, payload }: { active?: boolean; payload?: { payload: BridgeStep }[] }) {
  if (!active || !payload?.length) return null
  const step = payload[0].payload
  return (
    <TooltipBox>
      <p className="font-medium text-slate-700">{step.label}</p>
      <p className="tabular-nums text-slate-900 font-semibold">
        {step.isTotal ? money(step.amount, 'EUR') : fmtSigned(step.amount)}
      </p>
    </TooltipBox>
  )
}

export function PortfolioBridgeChart({ steps }: { steps: BridgeStep[] | null }) {
  if (!steps) {
    return (
      <EmptyChartCard message="No start-of-year snapshot yet — the value bridge needs one to compare against." />
    )
  }

  return (
    <div className="h-64 w-full md:h-80">
      <ResponsiveContainer width="100%" height="100%">
        <BarChart data={steps} margin={{ top: 8, right: 8, bottom: 0, left: 0 }}>
          <CartesianGrid strokeDasharray="3 3" stroke="#e2e8f0" vertical={false} />
          <XAxis dataKey="label" tick={{ fontSize: 12, fill: '#64748b' }} stroke="#cbd5e1" />
          <YAxis
            tickFormatter={(v) => money(typeof v === 'number' ? v : Number(v), 'EUR')}
            tick={{ fontSize: 12, fill: '#64748b' }}
            stroke="#cbd5e1"
            width={90}
          />
          <Tooltip content={<BridgeTooltip />} cursor={{ fill: '#f1f5f9' }} />
          <Bar dataKey="base" stackId="bridge" fill="transparent" isAnimationActive={false} />
          <Bar dataKey="value" stackId="bridge" radius={[4, 4, 0, 0]} isAnimationActive={false}>
            {steps.map((s) => (
              <Cell key={s.key} fill={s.isTotal ? '#0f172a' : TONE_COLOR[s.tone]} />
            ))}
          </Bar>
        </BarChart>
      </ResponsiveContainer>
    </div>
  )
}

// ── 2. Allocation by asset class (donut) ────────────────────────────────────

type AllocTooltipPayload = { name: string; value: number; payload: { isCashClass: boolean } }

function AllocationTooltip({
  active,
  payload,
  total,
}: {
  active?: boolean
  payload?: AllocTooltipPayload[]
  total: number
}) {
  if (!active || !payload?.length) return null
  const { name, value, payload: row } = payload[0]
  const pct = total > 0 ? (value / total) * 100 : 0
  return (
    <TooltipBox>
      <p className="font-medium text-slate-700">
        {name}
        {row.isCashClass ? ' · Cash' : ''}
      </p>
      <p className="tabular-nums text-slate-900">{money(value, 'EUR')}</p>
      <p className="text-slate-500">{pct.toFixed(1)}%</p>
    </TooltipBox>
  )
}

export function AssetClassAllocationChart({ classSummaries }: { classSummaries: AssetClassSummary[] }) {
  const total = classSummaries.reduce((s, c) => s + c.currentValueEur, 0)

  const renderTooltip = useCallback(
    (props: object) => (
      <AllocationTooltip {...(props as { active?: boolean; payload?: AllocTooltipPayload[] })} total={total} />
    ),
    [total]
  )

  if (classSummaries.length === 0 || total <= 0) {
    return <EmptyChartCard message="No portfolio value to allocate yet." />
  }

  return (
    <div>
      <div className="h-52">
        <ResponsiveContainer width="100%" height="100%">
          <PieChart>
            <Pie
              data={classSummaries.map((c) => ({ ...c, name: TYPE_LABELS[c.type] ?? c.type }))}
              cx="50%"
              cy="50%"
              innerRadius={52}
              outerRadius={84}
              paddingAngle={2}
              dataKey="currentValueEur"
            >
              {classSummaries.map((c) => (
                <Cell key={c.type} fill={TYPE_COLORS[c.type] ?? '#9ca3af'} />
              ))}
            </Pie>
            <Tooltip content={renderTooltip} />
          </PieChart>
        </ResponsiveContainer>
      </div>
      <ul className="mt-3 space-y-2">
        {classSummaries.map((c) => (
          <li key={c.type} className="flex items-center justify-between text-sm">
            <div className="flex items-center gap-2 min-w-0">
              <span
                className="inline-block h-2.5 w-2.5 shrink-0 rounded-full"
                style={{ backgroundColor: TYPE_COLORS[c.type] ?? '#9ca3af' }}
              />
              <span className="truncate text-slate-700">
                {TYPE_LABELS[c.type] ?? c.type}
                {c.isCashClass && <span className="ml-1.5 text-xs font-medium text-sky-600">Cash</span>}
              </span>
            </div>
            <div className="flex items-center gap-3 shrink-0">
              <span className="text-slate-500 tabular-nums">{c.pctOfPortfolio.toFixed(1)}%</span>
              <span className="font-medium text-slate-900 tabular-nums">{money(c.currentValueEur, 'EUR')}</span>
            </div>
          </li>
        ))}
      </ul>
    </div>
  )
}

// ── 3. P/L by asset class ────────────────────────────────────────────────────

type ClassPnlRow = AssetClassSummary & { label: string }

function ClassPnlTooltip({ active, payload }: { active?: boolean; payload?: { payload: ClassPnlRow }[] }) {
  if (!active || !payload?.length) return null
  const row = payload[0].payload
  return (
    <TooltipBox>
      <p className="font-medium text-slate-700">{row.label}</p>
      <p className="tabular-nums text-slate-900 font-semibold">
        {row.totalPLEur !== null ? fmtSigned(row.totalPLEur) : 'Not applicable'}
      </p>
      {row.totalPLPercent !== null && <p className="text-slate-500">{fmtSigned(row.totalPLPercent)}%</p>}
    </TooltipBox>
  )
}

export function AssetClassPnlChart({ classSummaries }: { classSummaries: AssetClassSummary[] }) {
  const rows: ClassPnlRow[] = classSummaries
    .filter((c) => !c.isCashClass && c.totalPLEur !== null)
    .map((c) => ({ ...c, label: TYPE_LABELS[c.type] ?? c.type }))
    .sort((a, b) => (b.totalPLEur ?? 0) - (a.totalPLEur ?? 0))

  if (rows.length === 0) {
    return <EmptyChartCard message="No investment P/L to show yet this year." />
  }

  return (
    <div>
      <div style={{ height: Math.max(rows.length * 44, 140) }}>
        <ResponsiveContainer width="100%" height="100%">
          <BarChart data={rows} layout="vertical" margin={{ top: 4, right: 24, bottom: 4, left: 8 }}>
            <CartesianGrid strokeDasharray="3 3" stroke="#e2e8f0" horizontal={false} />
            <XAxis
              type="number"
              tickFormatter={(v) => money(typeof v === 'number' ? v : Number(v), 'EUR')}
              tick={{ fontSize: 12, fill: '#64748b' }}
              stroke="#cbd5e1"
            />
            <YAxis
              type="category"
              dataKey="label"
              width={100}
              tick={{ fontSize: 12, fill: '#334155' }}
              stroke="#cbd5e1"
            />
            <ReferenceLine x={0} stroke="#cbd5e1" />
            <Tooltip content={<ClassPnlTooltip />} cursor={{ fill: '#f1f5f9' }} />
            <Bar dataKey="totalPLEur" radius={4} isAnimationActive={false}>
              {rows.map((r) => (
                <Cell key={r.type} fill={(r.totalPLEur ?? 0) >= 0 ? TONE_COLOR.positive : TONE_COLOR.negative} />
              ))}
            </Bar>
          </BarChart>
        </ResponsiveContainer>
      </div>
      <p className="mt-2 text-xs text-slate-400">Cash excluded from investment P/L.</p>
    </div>
  )
}

// ── 4. Top winners / losers ──────────────────────────────────────────────────

type RankingRow = AssetPnlRankingRow & { label: string }

function RankingTooltip({ active, payload }: { active?: boolean; payload?: { payload: RankingRow }[] }) {
  if (!active || !payload?.length) return null
  const row = payload[0].payload
  return (
    <TooltipBox>
      <p className="font-medium text-slate-700">{row.name}</p>
      <p className="text-slate-500">
        {row.platform} · {TYPE_LABELS[row.type] ?? row.type}
      </p>
      <p className="tabular-nums text-slate-900 font-semibold">{fmtSigned(row.totalPLEur)}</p>
      {row.totalPLPercent !== null && <p className="text-slate-500">{fmtSigned(row.totalPLPercent)}%</p>}
    </TooltipBox>
  )
}

export function AssetPnlRankingChart({ rows }: { rows: AssetPnlRankingRow[] }) {
  if (rows.length === 0) {
    return <EmptyChartCard message="No non-cash P/L to rank yet this year." />
  }

  const data: RankingRow[] = rows.map((r) => ({ ...r, label: `${r.name} · ${r.platform}` }))

  return (
    <div style={{ height: Math.max(data.length * 40, 160) }}>
      <ResponsiveContainer width="100%" height="100%">
        <BarChart data={data} layout="vertical" margin={{ top: 4, right: 24, bottom: 4, left: 8 }}>
          <CartesianGrid strokeDasharray="3 3" stroke="#e2e8f0" horizontal={false} />
          <XAxis
            type="number"
            tickFormatter={(v) => money(typeof v === 'number' ? v : Number(v), 'EUR')}
            tick={{ fontSize: 12, fill: '#64748b' }}
            stroke="#cbd5e1"
          />
          <YAxis
            type="category"
            dataKey="label"
            width={170}
            tick={{ fontSize: 11, fill: '#334155' }}
            stroke="#cbd5e1"
          />
          <ReferenceLine x={0} stroke="#cbd5e1" />
          <Tooltip content={<RankingTooltip />} cursor={{ fill: '#f1f5f9' }} />
          <Bar dataKey="totalPLEur" radius={4} isAnimationActive={false}>
            {data.map((r) => (
              <Cell key={r.investmentId} fill={r.totalPLEur >= 0 ? TONE_COLOR.positive : TONE_COLOR.negative} />
            ))}
          </Bar>
        </BarChart>
      </ResponsiveContainer>
    </div>
  )
}

// ── 5. Monthly cashflow ──────────────────────────────────────────────────────

function CashflowTooltip({
  active,
  payload,
  label,
}: {
  active?: boolean
  payload?: { payload: MonthlyCashflowRow }[]
  label?: string
}) {
  if (!active || !payload?.length) return null
  const row = payload[0].payload
  return (
    <TooltipBox>
      <p className="font-medium text-slate-700">{label}</p>
      {row.inflowEur > 0 && <p className="tabular-nums text-emerald-600">+{money(row.inflowEur, 'EUR')} in</p>}
      {row.outflowEur > 0 && <p className="tabular-nums text-rose-600">−{money(row.outflowEur, 'EUR')} out</p>}
      <p className="tabular-nums font-medium text-slate-900">Net {fmtSigned(row.netEur)}</p>
    </TooltipBox>
  )
}

export function MonthlyCashflowChart({ rows }: { rows: MonthlyCashflowRow[] }) {
  const hasAny = rows.some((r) => r.inflowEur > 0 || r.outflowEur > 0)
  if (!hasAny) {
    return <EmptyChartCard message="No contributions or withdrawals recorded this year." />
  }

  const data = rows.map((r) => ({ ...r, negOutflowEur: -r.outflowEur }))

  return (
    <div className="h-64 w-full md:h-72">
      <ResponsiveContainer width="100%" height="100%">
        <BarChart data={data} margin={{ top: 8, right: 8, bottom: 0, left: 0 }}>
          <CartesianGrid strokeDasharray="3 3" stroke="#e2e8f0" vertical={false} />
          <XAxis dataKey="label" tick={{ fontSize: 12, fill: '#64748b' }} stroke="#cbd5e1" />
          <YAxis
            tickFormatter={(v) => money(typeof v === 'number' ? v : Number(v), 'EUR')}
            tick={{ fontSize: 12, fill: '#64748b' }}
            stroke="#cbd5e1"
            width={90}
          />
          <ReferenceLine y={0} stroke="#cbd5e1" />
          <Tooltip content={<CashflowTooltip />} cursor={{ fill: '#f1f5f9' }} />
          <Bar dataKey="inflowEur" fill="#0ea5e9" radius={[3, 3, 0, 0]} isAnimationActive={false} name="In" />
          <Bar dataKey="negOutflowEur" fill="#f59e0b" radius={[0, 0, 3, 3]} isAnimationActive={false} name="Out" />
        </BarChart>
      </ResponsiveContainer>
    </div>
  )
}
