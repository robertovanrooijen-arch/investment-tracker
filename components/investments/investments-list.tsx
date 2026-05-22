'use client'

import { useState, useMemo } from 'react'
import Link from 'next/link'
import { money, fmtDate } from '@/lib/format'
import { pct } from '@/lib/domain/calculations'
import { CATEGORIES } from '@/lib/domain/constants'
import { InvestmentRow } from './investment-row'
import type { InvestmentMetrics } from '@/lib/domain/calculations'
import type { Investment, InvestmentType } from '@/types/database'

export type PreparedRow = {
  inv: Investment
  m: InvestmentMetrics
  dailyChangeEur: number | null
  dailyChangePct: number | null
}

type SortKey =
  | 'name'
  | 'type'
  | 'platform'
  | 'value'
  | 'pl_eur'
  | 'pl_pct'
  | 'daily_eur'
  | 'daily_pct'
  | 'updated'
type SortDir = 'asc' | 'desc'

const DEFAULT_DIR: Record<SortKey, SortDir> = {
  name: 'asc',
  type: 'asc',
  platform: 'asc',
  value: 'desc',
  pl_eur: 'desc',
  pl_pct: 'desc',
  daily_eur: 'desc',
  daily_pct: 'desc',
  updated: 'desc',
}

const MOBILE_SORT_OPTIONS: { label: string; value: string }[] = [
  { label: 'Value: high → low', value: 'value:desc' },
  { label: 'Value: low → high', value: 'value:asc' },
  { label: 'P/L €: best first', value: 'pl_eur:desc' },
  { label: 'P/L €: worst first', value: 'pl_eur:asc' },
  { label: 'P/L %: best first', value: 'pl_pct:desc' },
  { label: 'P/L %: worst first', value: 'pl_pct:asc' },
  { label: 'Daily €: best first', value: 'daily_eur:desc' },
  { label: 'Daily %: best first', value: 'daily_pct:desc' },
  { label: 'Name: A → Z', value: 'name:asc' },
  { label: 'Name: Z → A', value: 'name:desc' },
  { label: 'Updated: newest', value: 'updated:desc' },
  { label: 'Updated: oldest', value: 'updated:asc' },
]

type SortThProps = {
  label: string
  col: SortKey
  currentKey: SortKey
  currentDir: SortDir
  onSort: (key: SortKey) => void
  className?: string
}

function SortTh({ label, col, currentKey, currentDir, onSort, className = '' }: SortThProps) {
  const active = col === currentKey
  return (
    <th
      className={`px-6 py-3 font-medium cursor-pointer select-none whitespace-nowrap transition-colors ${
        active ? 'text-slate-900' : 'text-slate-500 hover:text-slate-700'
      } ${className}`}
      onClick={() => onSort(col)}
    >
      {label}
      {active && (
        <span className="ml-1 text-slate-400">{currentDir === 'asc' ? '↑' : '↓'}</span>
      )}
    </th>
  )
}

type FilterPillProps = {
  label: string
  active: boolean
  onClick: () => void
  tone?: 'green' | 'red'
}

function FilterPill({ label, active, onClick, tone }: FilterPillProps) {
  const activeClass =
    active && tone === 'green'
      ? 'bg-emerald-600 border-emerald-600 text-white'
      : active && tone === 'red'
        ? 'bg-rose-600 border-rose-600 text-white'
        : active
          ? 'bg-slate-900 border-slate-900 text-white'
          : 'bg-white border-slate-200 text-slate-600 hover:bg-slate-50'

  return (
    <button
      type="button"
      onClick={onClick}
      className={`px-2.5 py-0.5 rounded-full text-xs font-medium border transition-colors ${activeClass}`}
    >
      {label}
    </button>
  )
}

const selectClass =
  'rounded-md border border-slate-300 px-2 py-1 text-xs text-slate-700 bg-white focus:outline-none focus:ring-2 focus:ring-slate-300'

export function InvestmentsList({ rows }: { rows: PreparedRow[] }) {
  const [search, setSearch] = useState('')
  const [typeFilter, setTypeFilter] = useState<InvestmentType | 'all'>('all')
  const [platformFilter, setPlatformFilter] = useState('all')
  const [profitFilter, setProfitFilter] = useState<'all' | 'winners' | 'losers' | 'neutral'>('all')
  const [positionFilter, setPositionFilter] = useState<'all' | 'open' | 'closed'>('all')
  const [sortKey, setSortKey] = useState<SortKey>('value')
  const [sortDir, setSortDir] = useState<SortDir>('desc')

  const platforms = useMemo(
    () => Array.from(new Set(rows.map((r) => r.inv.platform))).sort((a, b) => a.localeCompare(b)),
    [rows],
  )

  const filtered = useMemo(() => {
    let result = rows

    if (search.trim()) {
      const q = search.trim().toLowerCase()
      result = result.filter(
        (r) =>
          r.inv.name.toLowerCase().includes(q) ||
          (r.inv.ticker?.toLowerCase().includes(q) ?? false) ||
          r.inv.platform.toLowerCase().includes(q) ||
          r.inv.type.toLowerCase().includes(q),
      )
    }

    if (typeFilter !== 'all') {
      result = result.filter((r) => r.inv.type === typeFilter)
    }

    if (platformFilter !== 'all') {
      result = result.filter((r) => r.inv.platform === platformFilter)
    }

    if (profitFilter !== 'all') {
      result = result.filter((r) => {
        if (profitFilter === 'winners') return r.m.totalProfit > 0
        if (profitFilter === 'losers') return r.m.totalProfit < 0
        return r.m.totalProfit === 0
      })
    }

    if (positionFilter !== 'all') {
      result = result.filter((r) =>
        positionFilter === 'closed' ? r.m.isClosed : !r.m.isClosed,
      )
    }

    const factor = sortDir === 'asc' ? 1 : -1
    return [...result].sort((a, b) => {
      type V = number | string | null
      let av: V
      let bv: V
      switch (sortKey) {
        case 'name':      av = a.inv.name;          bv = b.inv.name;          break
        case 'type':      av = a.inv.type;          bv = b.inv.type;          break
        case 'platform':  av = a.inv.platform;      bv = b.inv.platform;      break
        case 'value':     av = a.m.currentValue;    bv = b.m.currentValue;    break
        case 'pl_eur':    av = a.m.totalProfit;     bv = b.m.totalProfit;     break
        case 'pl_pct':    av = a.m.totalProfitPct;  bv = b.m.totalProfitPct;  break
        case 'daily_eur': av = a.dailyChangeEur;    bv = b.dailyChangeEur;    break
        case 'daily_pct': av = a.dailyChangePct;    bv = b.dailyChangePct;    break
        case 'updated':   av = a.inv.updated_at;    bv = b.inv.updated_at;    break
        default:          return 0
      }
      if (av === null && bv === null) return 0
      if (av === null) return 1
      if (bv === null) return -1
      if (typeof av === 'string' && typeof bv === 'string') return factor * av.localeCompare(bv)
      return factor * ((av as number) - (bv as number))
    })
  }, [rows, search, typeFilter, platformFilter, profitFilter, positionFilter, sortKey, sortDir])

  function handleSort(key: SortKey) {
    if (key === sortKey) {
      setSortDir((d) => (d === 'asc' ? 'desc' : 'asc'))
    } else {
      setSortKey(key)
      setSortDir(DEFAULT_DIR[key])
    }
  }

  function clearFilters() {
    setSearch('')
    setTypeFilter('all')
    setPlatformFilter('all')
    setProfitFilter('all')
    setPositionFilter('all')
  }

  const hasActiveFilters =
    !!search.trim() ||
    typeFilter !== 'all' ||
    platformFilter !== 'all' ||
    profitFilter !== 'all' ||
    positionFilter !== 'all'

  return (
    <div className="space-y-4">
      {/* Search */}
      <input
        type="search"
        placeholder="Search by name, ticker, platform, or type…"
        value={search}
        onChange={(e) => setSearch(e.target.value)}
        className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm text-slate-900 placeholder:text-slate-400 focus:outline-none focus:ring-2 focus:ring-slate-300"
      />

      {/* Type filter */}
      <div className="flex flex-wrap items-center gap-1.5">
        <span className="text-xs font-medium uppercase tracking-wide text-slate-400 mr-0.5">
          Type
        </span>
        <FilterPill label="All" active={typeFilter === 'all'} onClick={() => setTypeFilter('all')} />
        {CATEGORIES.map((t) => (
          <FilterPill
            key={t}
            label={t}
            active={typeFilter === t}
            onClick={() => setTypeFilter(t)}
          />
        ))}
      </div>

      {/* Platform + Profit + Position + Mobile sort */}
      <div className="flex flex-wrap items-center gap-x-5 gap-y-2">
        <div className="flex items-center gap-2">
          <span className="text-xs font-medium uppercase tracking-wide text-slate-400 shrink-0">
            Platform
          </span>
          <select
            value={platformFilter}
            onChange={(e) => setPlatformFilter(e.target.value)}
            className={selectClass}
          >
            <option value="all">All</option>
            {platforms.map((p) => (
              <option key={p} value={p}>
                {p}
              </option>
            ))}
          </select>
        </div>

        <div className="flex flex-wrap items-center gap-1.5">
          <span className="text-xs font-medium uppercase tracking-wide text-slate-400 mr-0.5">
            Status
          </span>
          <FilterPill
            label="All"
            active={profitFilter === 'all'}
            onClick={() => setProfitFilter('all')}
          />
          <FilterPill
            label="Winners"
            active={profitFilter === 'winners'}
            onClick={() => setProfitFilter('winners')}
            tone="green"
          />
          <FilterPill
            label="Losers"
            active={profitFilter === 'losers'}
            onClick={() => setProfitFilter('losers')}
            tone="red"
          />
          <FilterPill
            label="Neutral"
            active={profitFilter === 'neutral'}
            onClick={() => setProfitFilter('neutral')}
          />
        </div>

        <div className="flex flex-wrap items-center gap-1.5">
          <span className="text-xs font-medium uppercase tracking-wide text-slate-400 mr-0.5">
            Position
          </span>
          <FilterPill
            label="All"
            active={positionFilter === 'all'}
            onClick={() => setPositionFilter('all')}
          />
          <FilterPill
            label="Open"
            active={positionFilter === 'open'}
            onClick={() => setPositionFilter('open')}
          />
          <FilterPill
            label="Closed"
            active={positionFilter === 'closed'}
            onClick={() => setPositionFilter('closed')}
          />
        </div>

        {/* Mobile sort — hidden on md+ where table headers are clickable */}
        <div className="flex items-center gap-2 md:hidden">
          <span className="text-xs font-medium uppercase tracking-wide text-slate-400 shrink-0">
            Sort
          </span>
          <select
            value={`${sortKey}:${sortDir}`}
            onChange={(e) => {
              const [k, d] = e.target.value.split(':') as [SortKey, SortDir]
              setSortKey(k)
              setSortDir(d)
            }}
            className={selectClass}
          >
            {MOBILE_SORT_OPTIONS.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </select>
        </div>
      </div>

      {/* Summary line */}
      <p className="text-xs text-slate-500">
        Showing {filtered.length} of {rows.length} investment
        {rows.length !== 1 ? 's' : ''}
        {hasActiveFilters && filtered.length < rows.length && (
          <>
            {' · '}
            <button
              onClick={clearFilters}
              className="text-slate-700 underline hover:text-slate-900"
            >
              clear filters
            </button>
          </>
        )}
      </p>

      {filtered.length === 0 ? (
        <div className="bg-white rounded-2xl border border-slate-200 p-10 text-center">
          <p className="text-slate-900 font-medium">No investments match your filters</p>
          <button
            onClick={clearFilters}
            className="mt-3 text-sm text-slate-500 hover:text-slate-900 underline"
          >
            Clear filters
          </button>
        </div>
      ) : (
        <div className="bg-white rounded-2xl border border-slate-200 overflow-hidden">
          {/* Desktop table */}
          <table className="hidden md:table w-full">
            <thead>
              <tr className="text-left text-xs uppercase tracking-wide border-b border-slate-200">
                <SortTh
                  label="Name"
                  col="name"
                  currentKey={sortKey}
                  currentDir={sortDir}
                  onSort={handleSort}
                />
                <SortTh
                  label="Type"
                  col="type"
                  currentKey={sortKey}
                  currentDir={sortDir}
                  onSort={handleSort}
                />
                <SortTh
                  label="Platform"
                  col="platform"
                  currentKey={sortKey}
                  currentDir={sortDir}
                  onSort={handleSort}
                />
                <SortTh
                  label="Value EUR"
                  col="value"
                  currentKey={sortKey}
                  currentDir={sortDir}
                  onSort={handleSort}
                  className="text-right"
                />
                <SortTh
                  label="P / L EUR"
                  col="pl_eur"
                  currentKey={sortKey}
                  currentDir={sortDir}
                  onSort={handleSort}
                  className="text-right"
                />
                <SortTh
                  label="Daily"
                  col="daily_eur"
                  currentKey={sortKey}
                  currentDir={sortDir}
                  onSort={handleSort}
                  className="text-right"
                />
                <SortTh
                  label="Updated"
                  col="updated"
                  currentKey={sortKey}
                  currentDir={sortDir}
                  onSort={handleSort}
                />
              </tr>
            </thead>
            <tbody>
              {filtered.map(({ inv, m, dailyChangeEur, dailyChangePct }) => (
                <InvestmentRow
                  key={inv.id}
                  inv={inv}
                  m={m}
                  dailyChangeEur={dailyChangeEur}
                  dailyChangePct={dailyChangePct}
                />
              ))}
            </tbody>
          </table>

          {/* Mobile cards */}
          <ul className="md:hidden divide-y divide-slate-100">
            {filtered.map(({ inv, m, dailyChangeEur, dailyChangePct }) => {
              const showPL = m.totalEverInvested > 0
              const plTone =
                m.totalProfit > 0
                  ? 'text-emerald-600'
                  : m.totalProfit < 0
                    ? 'text-rose-600'
                    : 'text-slate-500'
              const dailyTone =
                dailyChangeEur === null
                  ? 'text-slate-400'
                  : dailyChangeEur > 0
                    ? 'text-emerald-600'
                    : dailyChangeEur < 0
                      ? 'text-rose-600'
                      : 'text-slate-500'

              return (
                <li key={inv.id}>
                  <Link
                    href={`/investments/${inv.id}`}
                    className="flex items-center justify-between px-5 py-4 hover:bg-slate-50"
                  >
                    <div className="min-w-0">
                      <div className="font-medium text-slate-900 truncate flex items-center gap-2">
                        {inv.name}
                        {m.isClosed && (
                          <span className="inline-flex items-center rounded-full bg-slate-100 px-2 py-0.5 text-xs font-medium text-slate-500">
                            Closed
                          </span>
                        )}
                      </div>
                      <div className="mt-1 flex items-center gap-2 text-xs text-slate-500">
                        <span>{inv.type}</span>
                        <span>·</span>
                        <span>{inv.platform}</span>
                        <span>·</span>
                        <span>{inv.currency ?? 'EUR'}</span>
                      </div>
                    </div>
                    <div className="text-right shrink-0">
                      <div className="text-sm text-slate-900 tabular-nums">
                        {money(m.currentValue, 'EUR')}
                      </div>
                      <div className={`text-xs tabular-nums ${plTone}`}>
                        {showPL
                          ? m.totalProfitPct !== null
                            ? pct(m.totalProfitPct)
                            : '—'
                          : '—'}
                      </div>
                      {dailyChangeEur !== null && (
                        <div className={`text-xs tabular-nums ${dailyTone}`}>
                          {dailyChangeEur >= 0 ? '+' : ''}
                          {money(dailyChangeEur, 'EUR')}
                          {dailyChangePct !== null && (
                            <>
                              {' '}
                              ({dailyChangePct >= 0 ? '+' : ''}
                              {dailyChangePct.toFixed(2)}%)
                            </>
                          )}
                        </div>
                      )}
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
