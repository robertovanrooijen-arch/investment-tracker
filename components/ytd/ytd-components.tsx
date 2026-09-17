// Presentation-only pieces for the YTD page. No calculations happen here —
// every number displayed is passed in already computed by
// lib/domain/year-analysis.ts (computeMonthlyYtdPerformance,
// computeInvestmentYtdRows, computeAssetClassYtd, computeAssetClassSummaries).
'use client'

import { money } from '@/lib/format'
import type { MonthlyYtdRow, InvestmentYtdRow, AssetClassSummary, AssetClassYtd } from '@/lib/domain/year-analysis'
import type { Investment, InvestmentType } from '@/types/database'

// ── Shared formatting (year-analysis.ts percentages are already ×100 —
// never run through lib/domain/calculations.ts's pct(), which expects a
// fraction) ─────────────────────────────────────────────────────────────────

function fmtPercent(n: number | null, digits = 1): string {
  if (n === null || !Number.isFinite(n)) return '—'
  return `${n >= 0 ? '+' : ''}${n.toFixed(digits)}%`
}

function fmtSigned(n: number | null): string {
  if (n === null || !Number.isFinite(n)) return '—'
  return `${n >= 0 ? '+' : ''}${money(n, 'EUR')}`
}

function toneClass(n: number | null, neutral = 'text-slate-500'): string {
  if (n === null || !Number.isFinite(n) || n === 0) return neutral
  return n > 0 ? 'text-emerald-600' : 'text-rose-600'
}

const TYPE_LABELS: Record<string, string> = {
  stock: 'Stocks',
  ETF: 'ETFs',
  crypto: 'Crypto',
  cash: 'Cash',
  'real estate': 'Real estate',
  commodity: 'Commodities',
  custom: 'Custom',
}

// ── Monthly performance table ───────────────────────────────────────────────

export function MonthlyPerformanceTable({ rows }: { rows: MonthlyYtdRow[] }) {
  if (rows.length === 0) {
    return (
      <div className="rounded-xl border border-dashed border-slate-200 bg-slate-50 p-6 text-center text-sm text-slate-500">
        No months to show yet this year.
      </div>
    )
  }

  return (
    <div className="overflow-x-auto -mx-1 px-1">
      <table className="w-full text-sm">
        <thead>
          <tr className="border-b border-slate-100 text-left text-xs uppercase tracking-wide text-slate-500">
            <th className="py-2 pr-3 font-medium">Month</th>
            <th className="py-2 pr-3 font-medium text-right">Gain / loss</th>
            <th className="py-2 pr-3 font-medium text-right">Return</th>
            <th className="py-2 pr-3 font-medium text-right">Net contribution</th>
            <th className="py-2 pr-3 font-medium text-right">End-of-month value</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.month} className="border-b border-slate-50 last:border-0">
              <td
                className="py-2.5 pr-3 font-medium text-slate-900"
                title={r.spansMultipleMonths ? `${r.periodStartIso} → ${r.periodEndIso}` : undefined}
              >
                {r.spansMultipleMonths ? r.periodLabel : r.label}
                {r.isCurrentMonth && (
                  <span className="ml-1.5 rounded-full bg-slate-100 px-1.5 py-0.5 text-[10px] font-normal text-slate-500">
                    so far
                  </span>
                )}
              </td>
              {r.unavailableReason !== null ? (
                <td colSpan={3} className="py-2.5 pr-3 text-right text-slate-400" title={r.unavailableReason}>
                  {r.unavailableReason}
                </td>
              ) : (
                <>
                  <td className={`py-2.5 pr-3 text-right tabular-nums font-medium ${toneClass(r.gainLossEur)}`}>
                    {fmtSigned(r.gainLossEur)}
                  </td>
                  <td
                    className={`py-2.5 pr-3 text-right tabular-nums ${toneClass(r.returnPercent)}`}
                    title={
                      r.spansMultipleMonths
                        ? `Return for ${r.periodLabel}, not ${r.label} alone — no snapshot exists for the skipped month(s).`
                        : undefined
                    }
                  >
                    {fmtPercent(r.returnPercent)}
                    {r.spansMultipleMonths && <span className="ml-1 text-slate-400">*</span>}
                  </td>
                  <td className={`py-2.5 pr-3 text-right tabular-nums ${toneClass(r.netContributionEur, 'text-slate-600')}`}>
                    {fmtSigned(r.netContributionEur)}
                  </td>
                </>
              )}
              <td className="py-2.5 pr-3 text-right tabular-nums text-slate-700">
                {r.endValueEur !== null ? money(r.endValueEur, 'EUR') : '—'}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {rows.some((r) => r.spansMultipleMonths) && (
        <p className="mt-2 text-xs text-slate-400">
          * The Month column shows the real period the row covers (e.g. &quot;Jan–May&quot;) whenever one or more
          earlier months had no portfolio snapshot — the gain/loss and return shown are for that whole period, not
          the single month alone.
        </p>
      )}
    </div>
  )
}

// ── Best / worst performer YTD ──────────────────────────────────────────────

function performerLabel(row: InvestmentYtdRow, investments: Investment[]): { name: string; platform: string } {
  const inv = investments.find((i) => i.id === row.investmentId)
  return { name: inv?.name ?? 'Unknown', platform: inv?.platform ?? '' }
}

export function BestWorstCards({
  rows,
  investments,
}: {
  rows: InvestmentYtdRow[]
  investments: Investment[]
}) {
  const ranked = rows.filter((r) => r.ytdReturnPercent !== null)
  if (ranked.length === 0) {
    return (
      <div className="rounded-xl border border-dashed border-slate-200 bg-slate-50 p-6 text-center text-sm text-slate-500">
        No holdings have a reliable YTD return yet — see the Investments page for why individual positions may be
        excluded.
      </div>
    )
  }

  const best = ranked.reduce((a, b) => (b.ytdReturnPercent! > a.ytdReturnPercent! ? b : a))
  const worst = ranked.reduce((a, b) => (b.ytdReturnPercent! < a.ytdReturnPercent! ? b : a))

  return (
    <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
      <PerformerCard row={best} tone="positive" investments={investments} />
      {best.investmentId !== worst.investmentId && (
        <PerformerCard row={worst} tone="negative" investments={investments} />
      )}
    </div>
  )
}

function PerformerCard({
  row,
  tone,
  investments,
}: {
  row: InvestmentYtdRow
  tone: 'positive' | 'negative'
  investments: Investment[]
}) {
  const { name, platform } = performerLabel(row, investments)
  return (
    <div className="bg-white rounded-2xl border border-slate-200 p-5 md:p-6">
      <p className="text-xs uppercase tracking-wide text-slate-500 font-medium">
        {tone === 'positive' ? 'Best performer YTD' : 'Worst performer YTD'}
      </p>
      <p className="mt-2 text-lg font-semibold text-slate-900 truncate">{name}</p>
      <p className="text-xs text-slate-400">{platform}</p>
      <div className="mt-3 flex items-baseline gap-2">
        <span className={`text-2xl font-semibold tabular-nums ${tone === 'positive' ? 'text-emerald-600' : 'text-rose-600'}`}>
          {fmtPercent(row.ytdReturnPercent)}
        </span>
        <span className="text-sm tabular-nums text-slate-500">{fmtSigned(row.ytdGrowthEur)}</span>
      </div>
    </div>
  )
}

// ── Asset class YTD breakdown table ─────────────────────────────────────────

export function AssetBreakdownTable({
  summaries,
  classYtd,
}: {
  summaries: AssetClassSummary[]
  classYtd: AssetClassYtd[]
}) {
  const ytdByType = new Map<InvestmentType, AssetClassYtd>(classYtd.map((c) => [c.type, c]))
  const rows = summaries.filter((s) => !s.isCashClass)

  if (rows.length === 0) {
    return (
      <div className="rounded-xl border border-dashed border-slate-200 bg-slate-50 p-6 text-center text-sm text-slate-500">
        No non-cash holdings to break down yet.
      </div>
    )
  }

  return (
    <div className="overflow-x-auto -mx-1 px-1">
      <table className="w-full text-sm">
        <thead>
          <tr className="border-b border-slate-100 text-left text-xs uppercase tracking-wide text-slate-500">
            <th className="py-2 pr-3 font-medium">Asset class</th>
            <th className="py-2 pr-3 font-medium text-right">Current value</th>
            <th className="py-2 pr-3 font-medium text-right">YTD gain / loss</th>
            <th className="py-2 pr-3 font-medium text-right">YTD return</th>
            <th className="py-2 pr-3 font-medium text-right">Share of portfolio</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((s) => {
            const ytd = ytdByType.get(s.type)
            return (
              <tr key={s.type} className="border-b border-slate-50 last:border-0">
                <td className="py-2.5 pr-3 font-medium text-slate-900">{TYPE_LABELS[s.type] ?? s.type}</td>
                <td className="py-2.5 pr-3 text-right tabular-nums text-slate-700">{money(s.currentValueEur, 'EUR')}</td>
                {ytd && ytd.growthEur !== null ? (
                  <>
                    <td className={`py-2.5 pr-3 text-right tabular-nums font-medium ${toneClass(ytd.growthEur)}`}>
                      {fmtSigned(ytd.growthEur)}
                    </td>
                    <td
                      className={`py-2.5 pr-3 text-right tabular-nums ${toneClass(ytd.returnPercent)}`}
                      title={ytd.returnPercent === null ? ytd.percentUnavailableReason ?? undefined : undefined}
                    >
                      {fmtPercent(ytd.returnPercent)}
                    </td>
                  </>
                ) : (
                  <td colSpan={2} className="py-2.5 pr-3 text-right text-slate-400">
                    No reliable start-of-year valuation
                  </td>
                )}
                <td className="py-2.5 pr-3 text-right tabular-nums text-slate-600">
                  {s.pctOfPortfolio.toFixed(1)}%
                </td>
              </tr>
            )
          })}
        </tbody>
      </table>
      {rows.some((s) => {
        const ytd = ytdByType.get(s.type)
        return ytd && ytd.excludedCount > 0
      }) && (
        <p className="mt-2 text-xs text-amber-600">
          Some holdings are excluded from one or more classes&apos; YTD figures — no reliable year-start valuation.
          Current value and share of portfolio are unaffected.
        </p>
      )}
    </div>
  )
}
