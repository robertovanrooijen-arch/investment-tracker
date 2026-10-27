'use client'

import { useMemo, useState } from 'react'
import Link from 'next/link'
import { money } from '@/lib/format'
import { pct } from '@/lib/domain/calculations'
import { PrivacyGate, PrivacyMoney } from '@/components/ui/privacy-value'
import { categoryLabel } from '@/lib/domain/allocation'
import type { Investment } from '@/types/database'

export type PerformanceRow = {
  inv: Investment
  marketYtdPercent: number | null
  marketYtdAsOfDate: string | null
  startValueEur: number | null
  amountBoughtInYearEur: number
  amountSoldInYearEur: number
  currentValueEur: number
  ytdGrowthEur: number | null
  ytdReturnPercent: number | null
  unavailableReason: string | null
  percentUnavailableReason: string | null
  portfolioWeightPct: number | null
  // false for a position with zero activity in the selected year AND
  // nothing left to value — e.g. closed in a prior year and dormant since.
  // Shown separately so the main comparison table isn't cluttered with
  // all-zero rows that have nothing to compare this year.
  hasActivityThisYear: boolean
}

type SortKey =
  | 'name'
  | 'market_ytd'
  | 'start_value'
  | 'bought'
  | 'sold'
  | 'current_value'
  | 'result_eur'
  | 'personal_ytd'

type SortDir = 'asc' | 'desc'

const DEFAULT_DIR: Record<SortKey, SortDir> = {
  name: 'asc',
  market_ytd: 'desc',
  start_value: 'desc',
  bought: 'desc',
  sold: 'desc',
  current_value: 'desc',
  result_eur: 'desc',
  personal_ytd: 'desc',
}

function pctText(n: number | null, digits = 1): string {
  if (n === null) return '—'
  return `${n >= 0 ? '+' : ''}${n.toFixed(digits)}%`
}

function toneClass(n: number | null): string {
  if (n === null) return 'text-slate-400'
  if (n > 0) return 'text-emerald-600'
  if (n < 0) return 'text-rose-600'
  return 'text-slate-500'
}

type SortThProps = {
  label: string
  col: SortKey
  currentKey: SortKey
  currentDir: SortDir
  onSort: (key: SortKey) => void
  className?: string
  title?: string
}

function SortTh({ label, col, currentKey, currentDir, onSort, className = '', title }: SortThProps) {
  const active = col === currentKey
  return (
    <th
      className={`px-4 py-3 font-medium cursor-pointer select-none whitespace-nowrap transition-colors ${
        active ? 'text-slate-900' : 'text-slate-500 hover:text-slate-700'
      } ${className}`}
      onClick={() => onSort(col)}
      title={title}
    >
      {label}
      {active && <span className="ml-1 text-slate-400">{currentDir === 'asc' ? '↑' : '↓'}</span>}
    </th>
  )
}

function NameCell({ r }: { r: PerformanceRow }) {
  return (
    <>
      <Link href={`/investments/${r.inv.id}`} className="font-medium text-slate-900 hover:underline">
        {r.inv.name}
      </Link>
      <div className="mt-0.5 flex items-center gap-1.5 text-xs text-slate-500">
        {r.inv.ticker && <span>{r.inv.ticker}</span>}
        <span>·</span>
        <span>{categoryLabel(r.inv.type)}</span>
        <span className="inline-flex items-center rounded-full bg-slate-100 px-1.5 py-0.5 text-[11px] font-medium text-slate-600">
          {r.inv.platform}
        </span>
      </div>
    </>
  )
}

function ResultCell({ r }: { r: PerformanceRow }) {
  if (r.unavailableReason) {
    return (
      <span className="text-xs text-slate-400" title={r.unavailableReason}>
        No activity this year
      </span>
    )
  }
  return (
    <div>
      <div className={toneClass(r.ytdGrowthEur)}>
        <PrivacyMoney value={r.ytdGrowthEur} signed fallbackText={pctText(r.ytdReturnPercent)} />
      </div>
      {r.percentUnavailableReason && (
        <div className="mt-0.5 text-[11px] font-normal text-slate-400" title={r.percentUnavailableReason}>
          % not stable yet
        </div>
      )}
    </div>
  )
}

export function PerformanceTable({ rows, year }: { rows: PerformanceRow[]; year: number }) {
  const [sortKey, setSortKey] = useState<SortKey>('result_eur')
  const [sortDir, setSortDir] = useState<SortDir>('desc')

  const active = useMemo(() => rows.filter((r) => r.hasActivityThisYear), [rows])
  const dormant = useMemo(() => rows.filter((r) => !r.hasActivityThisYear), [rows])

  const sorted = useMemo(() => {
    const factor = sortDir === 'asc' ? 1 : -1
    return [...active].sort((a, b) => {
      let av: number | string | null
      let bv: number | string | null
      switch (sortKey) {
        case 'name':          av = a.inv.name;               bv = b.inv.name;               break
        case 'market_ytd':    av = a.marketYtdPercent;       bv = b.marketYtdPercent;       break
        case 'start_value':   av = a.startValueEur;          bv = b.startValueEur;          break
        case 'bought':        av = a.amountBoughtInYearEur;  bv = b.amountBoughtInYearEur;  break
        case 'sold':          av = a.amountSoldInYearEur;    bv = b.amountSoldInYearEur;    break
        case 'current_value': av = a.currentValueEur;        bv = b.currentValueEur;        break
        case 'result_eur':    av = a.ytdGrowthEur;           bv = b.ytdGrowthEur;           break
        case 'personal_ytd':  av = a.ytdReturnPercent;       bv = b.ytdReturnPercent;       break
        default:              return 0
      }
      if (av === null && bv === null) return 0
      if (av === null) return 1
      if (bv === null) return -1
      if (typeof av === 'string' && typeof bv === 'string') return factor * av.localeCompare(bv)
      return factor * ((av as number) - (bv as number))
    })
  }, [active, sortKey, sortDir])

  // Pure selection over already-computed rows — picks the extremes a reader
  // wants first. No new calculation happens here, so these can never
  // disagree with the table they're drawn from.
  const { topContributor, biggestDrag } = useMemo(() => {
    const withResult = active.filter((r): r is PerformanceRow & { ytdGrowthEur: number } => r.ytdGrowthEur !== null)
    if (withResult.length === 0) return { topContributor: null, biggestDrag: null }
    const top = withResult.reduce((a, b) => (b.ytdGrowthEur > a.ytdGrowthEur ? b : a))
    const drag = withResult.reduce((a, b) => (b.ytdGrowthEur < a.ytdGrowthEur ? b : a))
    return {
      topContributor: top.ytdGrowthEur > 0 ? top : null,
      biggestDrag: drag.ytdGrowthEur < 0 ? drag : null,
    }
  }, [active])

  function handleSort(key: SortKey) {
    if (key === sortKey) {
      setSortDir((d) => (d === 'asc' ? 'desc' : 'asc'))
    } else {
      setSortKey(key)
      setSortDir(DEFAULT_DIR[key])
    }
  }

  return (
    <div className="space-y-3">
      {(topContributor || biggestDrag) && (
        <div className="flex flex-wrap gap-3 text-sm">
          {topContributor && (
            <div className="flex-1 min-w-[220px] rounded-xl border border-emerald-200 bg-emerald-50 px-4 py-3">
              <p className="text-xs font-medium uppercase tracking-wide text-emerald-700">Top contributor YTD</p>
              <p className="mt-1 font-medium text-slate-900">{topContributor.inv.name}</p>
              <p className="text-emerald-700 tabular-nums">
                <PrivacyMoney value={topContributor.ytdGrowthEur} signed fallbackText={pctText(topContributor.ytdReturnPercent)} />
              </p>
            </div>
          )}
          {biggestDrag && (
            <div className="flex-1 min-w-[220px] rounded-xl border border-rose-200 bg-rose-50 px-4 py-3">
              <p className="text-xs font-medium uppercase tracking-wide text-rose-700">Biggest drag YTD</p>
              <p className="mt-1 font-medium text-slate-900">{biggestDrag.inv.name}</p>
              <p className="text-rose-700 tabular-nums">
                <PrivacyMoney value={biggestDrag.ytdGrowthEur} signed fallbackText={pctText(biggestDrag.ytdReturnPercent)} />
              </p>
            </div>
          )}
        </div>
      )}

      <div className="bg-white rounded-2xl border border-slate-200 overflow-hidden">
        {/* Desktop table */}
        <table className="hidden md:table w-full">
          <thead>
            <tr className="text-left text-xs uppercase tracking-wide border-b border-slate-200">
              <SortTh label="Investment" col="name" currentKey={sortKey} currentDir={sortDir} onSort={handleSort} />
              <SortTh
                label="Market YTD"
                col="market_ytd"
                currentKey={sortKey}
                currentDir={sortDir}
                onSort={handleSort}
                className="text-right"
                title={`The security's own price return since its last close on/before Jan 1, ${year}, in its own trading currency.`}
              />
              <SortTh
                label="Value 1 Jan"
                col="start_value"
                currentKey={sortKey}
                currentDir={sortDir}
                onSort={handleSort}
                className="text-right"
              />
              <SortTh
                label="Bought YTD"
                col="bought"
                currentKey={sortKey}
                currentDir={sortDir}
                onSort={handleSort}
                className="text-right"
              />
              <SortTh
                label="Sold YTD"
                col="sold"
                currentKey={sortKey}
                currentDir={sortDir}
                onSort={handleSort}
                className="text-right"
              />
              <SortTh
                label="Current value"
                col="current_value"
                currentKey={sortKey}
                currentDir={sortDir}
                onSort={handleSort}
                className="text-right"
              />
              <SortTh
                label="Result YTD"
                col="result_eur"
                currentKey={sortKey}
                currentDir={sortDir}
                onSort={handleSort}
                className="text-right"
                title="End value minus start value minus net buys/sells this year — never counts a buy/sell itself as profit."
              />
              <SortTh
                label="Personal YTD"
                col="personal_ytd"
                currentKey={sortKey}
                currentDir={sortDir}
                onSort={handleSort}
                className="text-right"
                title="Modified Dietz (time-weighted) return on your own position this year — not a naive profit ÷ money-in ratio."
              />
            </tr>
          </thead>
          <tbody>
            {sorted.map((r) => (
              <tr key={r.inv.id} className="border-b last:border-b-0 border-slate-100 hover:bg-slate-50">
                <td className="px-4 py-3.5">
                  <NameCell r={r} />
                </td>
                <td
                  className={`px-4 py-3.5 text-right tabular-nums ${toneClass(r.marketYtdPercent)}`}
                  title={r.marketYtdAsOfDate ? `vs. close on ${r.marketYtdAsOfDate}` : 'Market YTD unavailable — could not fetch a historical price for this ticker.'}
                >
                  {pctText(r.marketYtdPercent)}
                </td>
                <td className="px-4 py-3.5 text-right tabular-nums text-slate-700">
                  <PrivacyGate fallback="—">
                    <>{r.startValueEur !== null ? money(r.startValueEur, 'EUR') : '—'}</>
                  </PrivacyGate>
                </td>
                <td className="px-4 py-3.5 text-right tabular-nums text-slate-700">
                  <PrivacyGate fallback="—">
                    <>{money(r.amountBoughtInYearEur, 'EUR')}</>
                  </PrivacyGate>
                </td>
                <td className="px-4 py-3.5 text-right tabular-nums text-slate-700">
                  <PrivacyGate fallback="—">
                    <>{money(r.amountSoldInYearEur, 'EUR')}</>
                  </PrivacyGate>
                </td>
                <td className="px-4 py-3.5 text-right tabular-nums text-slate-900">
                  <PrivacyGate fallback={r.portfolioWeightPct !== null ? `${pct(r.portfolioWeightPct / 100)} weight` : '—'}>
                    <>{money(r.currentValueEur, 'EUR')}</>
                  </PrivacyGate>
                </td>
                <td className="px-4 py-3.5 text-right tabular-nums">
                  <ResultCell r={r} />
                </td>
                <td className={`px-4 py-3.5 text-right tabular-nums ${toneClass(r.ytdReturnPercent)}`}>
                  {r.unavailableReason ? (
                    <span className="text-slate-400">—</span>
                  ) : r.percentUnavailableReason ? (
                    <span className="text-slate-400" title={r.percentUnavailableReason}>
                      —
                    </span>
                  ) : (
                    pctText(r.ytdReturnPercent)
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>

        {/* Mobile cards */}
        <ul className="md:hidden divide-y divide-slate-100">
          {sorted.map((r) => (
            <li key={r.inv.id}>
              <Link href={`/investments/${r.inv.id}`} className="flex items-center justify-between px-5 py-4 hover:bg-slate-50">
                <div className="min-w-0">
                  <div className="font-medium text-slate-900 truncate">{r.inv.name}</div>
                  <div className="mt-1 flex items-center gap-1.5 text-xs text-slate-500">
                    <span>{categoryLabel(r.inv.type)}</span>
                    <span className="inline-flex items-center rounded-full bg-slate-100 px-1.5 py-0.5 text-[11px] font-medium text-slate-600">
                      {r.inv.platform}
                    </span>
                  </div>
                  <div className={`mt-1 text-xs tabular-nums ${toneClass(r.marketYtdPercent)}`}>
                    Market {pctText(r.marketYtdPercent)}
                  </div>
                </div>
                <div className="text-right shrink-0">
                  <div className="text-sm text-slate-900 tabular-nums">
                    <PrivacyGate fallback={r.portfolioWeightPct !== null ? `${pct(r.portfolioWeightPct / 100)} weight` : '—'}>
                      <>{money(r.currentValueEur, 'EUR')}</>
                    </PrivacyGate>
                  </div>
                  <div className={`text-xs tabular-nums ${toneClass(r.ytdReturnPercent)}`}>
                    Personal{' '}
                    {r.unavailableReason || r.percentUnavailableReason ? '—' : pctText(r.ytdReturnPercent)}
                  </div>
                </div>
              </Link>
            </li>
          ))}
        </ul>
      </div>

      {dormant.length > 0 && (
        <details className="group rounded-2xl border border-slate-200 bg-white">
          <summary className="cursor-pointer list-none px-5 py-3.5 text-sm font-medium text-slate-600 hover:text-slate-900">
            {dormant.length} closed position{dormant.length !== 1 ? 's' : ''} with no activity in {year}
          </summary>
          <ul className="divide-y divide-slate-100 border-t border-slate-100">
            {dormant.map((r) => (
              <li key={r.inv.id}>
                <Link
                  href={`/investments/${r.inv.id}`}
                  className="flex items-center justify-between px-5 py-3 text-sm hover:bg-slate-50"
                >
                  <span className="text-slate-700">{r.inv.name}</span>
                  <span className="text-xs text-slate-400">{r.inv.platform}</span>
                </Link>
              </li>
            ))}
          </ul>
        </details>
      )}
    </div>
  )
}
