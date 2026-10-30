import Link from 'next/link'
import { redirect } from 'next/navigation'
import { createClient } from '@/lib/supabase/server'
import { PageHeader } from '@/components/ui/page-header'
import { DataQualityNotice } from '@/components/ui/data-quality-notice'
import { StatCard } from '@/components/ui/stat-card'
import { money, fmtDate } from '@/lib/format'
import type { CapitalFlowEntry, Transaction } from '@/types/database'
import { buildExternalCashFlowRows, type ContribRow } from '@/lib/domain/contributions'
import { deriveAvailableYears } from '@/lib/domain/available-years'
import { fetchAllRows } from '@/lib/supabase/fetch-all-rows'
import { PrivacyGate } from '@/components/ui/privacy-value'

export const dynamic = 'force-dynamic'

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

type ContribTx = Transaction & { investment: { platform: string } | null }

// ── Helpers ────────────────────────────────────────────────────────────────

function sumEur(entries: ContribRow[]): number {
  return entries.reduce((s, e) => s + Number(e.amount_eur), 0)
}

function directionLabel(d: string): string {
  return d === 'to_portfolio' ? 'To portfolio' : 'From portfolio'
}

function directionBadgeClass(d: string): string {
  return d === 'to_portfolio'
    ? 'bg-emerald-50 text-emerald-700 border border-emerald-200'
    : 'bg-rose-50 text-rose-700 border border-rose-200'
}

function sourceLabel(row: ContribRow): string {
  if (row.source !== 'transaction') return 'Manual'
  return row.direction === 'from_portfolio' ? 'Withdrawal' : 'Contribution'
}

function sourceBadgeClass(row: ContribRow): string {
  if (row.source !== 'transaction') return 'bg-slate-100 text-slate-500 border border-slate-200'
  return row.direction === 'from_portfolio'
    ? 'bg-amber-50 text-amber-700 border border-amber-200'
    : 'bg-blue-50 text-blue-700 border border-blue-200'
}

// ── Page ──────────────────────────────────────────────────────────────────

export default async function ContributionsPage({
  searchParams,
}: {
  searchParams: Promise<{ year?: string }>
}) {
  const { year: yearParam } = await searchParams

  const supabase = await createClient()

  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) redirect('/login')

  // Whole ledger (paginated past the 1000-row API limit) so years can be
  // derived from the data and a capital flow can supersede a legacy
  // transaction regardless of year.
  const [ledgerRes, txRes] = await Promise.all([
    fetchAllRows<CapitalFlowEntry>((from, to) =>
      supabase
        .from('capital_flow_entries')
        .select('*')
        .order('id', { ascending: true })
        .range(from, to)
        .returns<CapitalFlowEntry[]>()
    ),
    fetchAllRows<ContribTx>((from, to) =>
      supabase
        .from('transactions')
        .select('*, investment:investments(platform)')
        // Legacy compatibility: only rows still flagged as a contribution.
        .eq('is_contribution', true)
        .order('id', { ascending: true })
        .range(from, to)
        .returns<ContribTx[]>()
    ),
  ])

  const external = buildExternalCashFlowRows(ledgerRes.data ?? [], txRes.data ?? [])

  // Legacy rows with an unknown EUR amount (missing FX) stay IN the list with
  // amount NaN: every total they belong to then shows '—' (fail-closed) and
  // the notice below explains why — never a silently lower total.
  const allRows = [...external.rows, ...external.fxMissingRows]
  // Per-year totals over ALL years (plain sums: an unknown row → '—').
  const perYear = Array.from(
    allRows.reduce((m, r) => {
      const y = m.get(r.year) ?? { inEur: 0, outEur: 0 }
      if (r.direction === 'to_portfolio') y.inEur += Number(r.amount_eur)
      else y.outEur += Number(r.amount_eur)
      return m.set(r.year, y)
    }, new Map<number, { inEur: number; outEur: number }>())
  ).sort((a, b) => a[0] - b[0])
  const availableYears = deriveAvailableYears(allRows.map((r) => r.flow_date))
  const requestedYear = Number(yearParam)
  const year = availableYears.includes(requestedYear)
    ? requestedYear
    : availableYears[availableYears.length - 1]

  const yearRows = allRows.filter((r) => r.year === year)
  const fxMissingInYear = external.fxMissingRows.filter((r) => r.year === year).length
  const legacyCountInYear = yearRows.filter((r) => r.source === 'transaction').length

  const entries = [...yearRows].sort((a, b) => {
    if (a.flow_date !== b.flow_date) return a.flow_date > b.flow_date ? -1 : 1
    return a.created_at > b.created_at ? -1 : 1
  })

  const inflows     = entries.filter((e) => e.direction === 'to_portfolio')
  const outflows    = entries.filter((e) => e.direction === 'from_portfolio')

  const grossIn     = sumEur(inflows)
  const totalOut    = sumEur(outflows)
  const netContrib  = grossIn - totalOut
  const entryCount  = entries.length

  // ── Platform breakdown ──────────────────────────────────────────────────

  const platformMap = new Map<string, { toP: number; fromP: number }>()
  for (const e of entries) {
    const row = platformMap.get(e.platform) ?? { toP: 0, fromP: 0 }
    if (e.direction === 'to_portfolio')   row.toP   += Number(e.amount_eur)
    else                                   row.fromP += Number(e.amount_eur)
    platformMap.set(e.platform, row)
  }
  const platforms = Array.from(platformMap.entries())
    .map(([name, { toP, fromP }]) => ({ name, toP, fromP, net: toP - fromP }))
    .sort((a, b) => b.net - a.net)

  // ── Monthly breakdown ───────────────────────────────────────────────────

  const monthly = Array.from({ length: 12 }, (_, i) => ({
    month: MONTHS[i],
    toP:   0,
    fromP: 0,
  }))
  for (const e of entries) {
    const idx = Number(e.monthKey.slice(5, 7)) - 1   // 'YYYY-MM' → 0-based month index
    if (idx >= 0 && idx < 12) {
      if (e.direction === 'to_portfolio') monthly[idx].toP   += Number(e.amount_eur)
      else                                monthly[idx].fromP += Number(e.amount_eur)
    }
  }

  const hasEntries = entries.length > 0

  // ── Shared table cell classes ───────────────────────────────────────────

  const thClass = 'text-xs font-medium text-slate-500 uppercase tracking-wide py-3 whitespace-nowrap'
  const tdNet   = (net: number) =>
    net > 0 ? 'text-emerald-700' : net < 0 ? 'text-rose-700' : 'text-slate-400'

  return (
    <div className="space-y-6">

      {/* ── Header ── */}
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <PageHeader
          title="Capital contributions"
          subtitle="Money flows between your bank / income and portfolio platforms."
        />
        <Link
          href="/contributions/new"
          className="inline-flex items-center rounded-lg bg-slate-900 px-4 py-2 text-sm font-medium text-white hover:bg-slate-800 whitespace-nowrap shrink-0"
        >
          + Add capital flow
        </Link>
      </div>

      {/* ── All years ── */}
      {perYear.length > 0 && (
        <div className="bg-white rounded-2xl border border-slate-200 overflow-hidden">
          <div className="px-5 md:px-6 py-4 border-b border-slate-100">
            <h2 className="text-base font-semibold text-slate-900">External money per year</h2>
            <p className="text-xs text-slate-500 mt-1">
              Only money moving between your bank and a platform. Sales, re-investments and confirmed internal
              transfers between platforms are not contributions.
            </p>
          </div>
          <table className="w-full text-sm">
            <thead>
              <tr className="bg-slate-50 border-b border-slate-100 text-xs text-slate-500">
                <th className="text-left px-5 py-2 font-medium">Year</th>
                <th className="text-right px-4 py-2 font-medium">Gross deposits</th>
                <th className="text-right px-4 py-2 font-medium">Gross withdrawals</th>
                <th className="text-right px-5 py-2 font-medium">Net contributed</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {perYear.map(([y, v]) => (
                <tr key={y}>
                  <td className="px-5 py-2 text-slate-900">{y}</td>
                  <td className="px-4 py-2 text-right tabular-nums"><PrivacyGate fallback="—"><>{money(v.inEur, 'EUR')}</></PrivacyGate></td>
                  <td className="px-4 py-2 text-right tabular-nums"><PrivacyGate fallback="—"><>{money(v.outEur, 'EUR')}</></PrivacyGate></td>
                  <td className="px-5 py-2 text-right tabular-nums font-medium"><PrivacyGate fallback="—"><>{money(v.inEur - v.outEur, 'EUR')}</></PrivacyGate></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* ── Year selector ── */}
      <div className="inline-flex rounded-lg border border-slate-200 bg-slate-50 p-0.5">
        {availableYears.map((y) => (
          <Link
            key={y}
            href={`/contributions?year=${y}`}
            className={`px-5 py-1.5 rounded-md text-sm font-medium transition-colors ${
              year === y
                ? 'bg-white text-slate-900 shadow-sm'
                : 'text-slate-500 hover:text-slate-700'
            }`}
          >
            {y}
          </Link>
        ))}
      </div>

      <DataQualityNotice legacyContributionsSkippedFx={fxMissingInYear} />

      {legacyCountInYear > 0 && (
        <div className="rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-800">
          {legacyCountInYear} {legacyCountInYear === 1 ? 'entry' : 'entries'} in {year} still{' '}
          {legacyCountInYear === 1 ? 'comes' : 'come'} from a transaction flagged as a contribution
          (legacy). They keep counting until a capital flow is recorded for them; new external money
          is recorded only as a capital flow.
        </div>
      )}

      {/* ── Summary cards ── */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        <StatCard
          label="Gross cash in"
          value={<PrivacyGate fallback="—"><>{money(grossIn, 'EUR')}</></PrivacyGate>}
          hint={`${inflows.length} inflow${inflows.length !== 1 ? 's' : ''}`}
          tone="positive"
        />
        <StatCard
          label="Cash out"
          value={<PrivacyGate fallback="—"><>{totalOut > 0 ? money(totalOut, 'EUR') : '—'}</></PrivacyGate>}
          hint={`${outflows.length} outflow${outflows.length !== 1 ? 's' : ''}`}
          tone={totalOut > 0 ? 'negative' : 'neutral'}
        />
        <StatCard
          label="Net contributed"
          value={<PrivacyGate fallback="—"><>{money(netContrib, 'EUR')}</></PrivacyGate>}
          hint="Gross in minus cash out"
          tone={netContrib > 0 ? 'positive' : netContrib < 0 ? 'negative' : 'neutral'}
        />
        <StatCard
          label="Entries"
          value={String(entryCount)}
          hint={`for ${year}`}
        />
      </div>

      {!hasEntries && (
        <div className="bg-white rounded-2xl border border-slate-200 p-8 text-center text-sm text-slate-500">
          No capital flow entries for {year}.{' '}
          <Link href="/contributions/new" className="font-medium text-slate-900 underline">
            Add the first one
          </Link>

          .
        </div>
      )}

      {hasEntries && (
        <>
          {/* ── Platform breakdown ── */}
          <div className="bg-white rounded-2xl border border-slate-200 overflow-hidden">
            <div className="px-5 md:px-6 py-4 border-b border-slate-100">
              <h2 className="text-base font-semibold text-slate-900">By platform</h2>
            </div>
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="bg-slate-50 border-b border-slate-100">
                    <th className={`text-left  px-5 md:px-6 ${thClass}`}>Platform</th>
                    <th className={`text-right px-4       ${thClass}`}>To portfolio</th>
                    <th className={`text-right px-4       ${thClass}`}>From portfolio</th>
                    <th className={`text-right px-5 md:px-6 ${thClass}`}>Net</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-50">
                  {platforms.map((row) => (
                    <tr key={row.name} className="hover:bg-slate-50 transition-colors">
                      <td className="px-5 md:px-6 py-3 font-medium text-slate-800">
                        {row.name}
                      </td>
                      <td className="px-4 py-3 text-right tabular-nums text-emerald-700">
                        <PrivacyGate fallback="—"><>{row.toP > 0 ? money(row.toP, 'EUR') : '—'}</></PrivacyGate>
                      </td>
                      <td className="px-4 py-3 text-right tabular-nums text-rose-700">
                        <PrivacyGate fallback="—"><>{row.fromP > 0 ? money(row.fromP, 'EUR') : '—'}</></PrivacyGate>
                      </td>
                      <td className={`px-5 md:px-6 py-3 text-right tabular-nums font-semibold ${tdNet(row.net)}`}>
                        <PrivacyGate fallback="—"><>{(row.net >= 0 ? '+' : '') + money(row.net, 'EUR')}</></PrivacyGate>
                      </td>
                    </tr>
                  ))}
                </tbody>
                <tfoot>
                  <tr className="border-t-2 border-slate-200 bg-slate-50">
                    <td className="px-5 md:px-6 py-3 text-xs font-semibold text-slate-500 uppercase tracking-wide">
                      Total
                    </td>
                    <td className="px-4 py-3 text-right tabular-nums font-semibold text-emerald-700">
                      <PrivacyGate fallback="—"><>{money(grossIn, 'EUR')}</></PrivacyGate>
                    </td>
                    <td className="px-4 py-3 text-right tabular-nums font-semibold text-rose-700">
                      <PrivacyGate fallback="—"><>{totalOut > 0 ? money(totalOut, 'EUR') : '—'}</></PrivacyGate>
                    </td>
                    <td className={`px-5 md:px-6 py-3 text-right tabular-nums font-semibold ${tdNet(netContrib)}`}>
                      <PrivacyGate fallback="—"><>{(netContrib >= 0 ? '+' : '') + money(netContrib, 'EUR')}</></PrivacyGate>
                    </td>
                  </tr>
                </tfoot>
              </table>
            </div>
          </div>

          {/* ── Monthly breakdown ── */}
          <div className="bg-white rounded-2xl border border-slate-200 overflow-hidden">
            <div className="px-5 md:px-6 py-4 border-b border-slate-100">
              <h2 className="text-base font-semibold text-slate-900">Monthly breakdown</h2>
            </div>
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="bg-slate-50 border-b border-slate-100">
                    <th className={`text-left  px-5 md:px-6 ${thClass}`}>Month</th>
                    <th className={`text-right px-4       ${thClass}`}>To portfolio</th>
                    <th className={`text-right px-4       ${thClass}`}>From portfolio</th>
                    <th className={`text-right px-5 md:px-6 ${thClass}`}>Net</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-50">
                  {monthly.map((row) => {
                    const net     = row.toP - row.fromP
                    const isEmpty = row.toP === 0 && row.fromP === 0
                    return (
                      <tr
                        key={row.month}
                        className={`transition-colors ${isEmpty ? 'opacity-40' : 'hover:bg-slate-50'}`}
                      >
                        <td className="px-5 md:px-6 py-3 font-medium text-slate-700">
                          {row.month} {year}
                        </td>
                        <td className="px-4 py-3 text-right tabular-nums text-emerald-700">
                          <PrivacyGate fallback="—"><>{row.toP > 0 ? money(row.toP, 'EUR') : '—'}</></PrivacyGate>
                        </td>
                        <td className="px-4 py-3 text-right tabular-nums text-rose-700">
                          <PrivacyGate fallback="—"><>{row.fromP > 0 ? money(row.fromP, 'EUR') : '—'}</></PrivacyGate>
                        </td>
                        <td className={`px-5 md:px-6 py-3 text-right tabular-nums font-medium ${
                          isEmpty ? 'text-slate-400' : tdNet(net)
                        }`}>
                          <PrivacyGate fallback="—"><>{isEmpty ? '—' : (net >= 0 ? '+' : '') + money(net, 'EUR')}</></PrivacyGate>
                        </td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            </div>
          </div>

          {/* ── All entries ── */}
          <div className="bg-white rounded-2xl border border-slate-200 overflow-hidden">
            <div className="px-5 md:px-6 py-4 border-b border-slate-100">
              <h2 className="text-base font-semibold text-slate-900">All entries</h2>
            </div>
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="bg-slate-50 border-b border-slate-100">
                    <th className={`text-left  px-5 md:px-6 ${thClass}`}>Date</th>
                    <th className={`text-left  px-4       ${thClass}`}>Platform</th>
                    <th className={`text-left  px-4       ${thClass} hidden sm:table-cell`}>Direction</th>
                    <th className={`text-right px-4       ${thClass}`}>Amount</th>
                    <th className={`text-left  px-4       ${thClass} hidden sm:table-cell`}>Source</th>
                    <th className={`text-left  px-5 md:px-6 ${thClass} hidden md:table-cell`}>Notes</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-50">
                  {entries.map((e) => {
                    const isIn = e.direction === 'to_portfolio'
                    return (
                      <tr key={e.id} className="hover:bg-slate-50 transition-colors">
                        <td className="px-5 md:px-6 py-3 text-slate-500 tabular-nums whitespace-nowrap">
                          {fmtDate(e.flow_date)}
                        </td>
                        <td className="px-4 py-3 text-slate-800 font-medium whitespace-nowrap">
                          {e.platform}
                        </td>
                        <td className="px-4 py-3 whitespace-nowrap hidden sm:table-cell">
                          <span className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium ${directionBadgeClass(e.direction)}`}>
                            {directionLabel(e.direction)}
                          </span>
                        </td>
                        <td className={`px-4 py-3 text-right tabular-nums font-medium whitespace-nowrap ${
                          isIn ? 'text-emerald-700' : 'text-rose-700'
                        }`}>
                          <PrivacyGate fallback="—">
                            <>{isIn ? '+' : '−'}{money(Number(e.amount_eur), 'EUR')}</>
                          </PrivacyGate>
                        </td>
                        <td className="px-4 py-3 whitespace-nowrap hidden sm:table-cell">
                          <span className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium ${sourceBadgeClass(e)}`}>
                            {sourceLabel(e)}
                          </span>
                        </td>
                        <td className="px-5 md:px-6 py-3 text-slate-400 text-xs hidden md:table-cell max-w-[200px] truncate">
                          {e.notes ?? '—'}
                        </td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            </div>
          </div>
        </>
      )}

      {/* ── Definition ── */}
      <p className="text-xs text-slate-400 leading-relaxed px-1">
        <span className="font-medium text-slate-500">Definition: </span>
        Net contribution = money sent from bank / income to portfolio platforms
        minus money received back. Reinvestments, sells, dividends, and reallocations
        between platforms are not tracked here.
      </p>

    </div>
  )
}
