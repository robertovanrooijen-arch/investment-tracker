import Link from 'next/link'
import { createClient } from '@/lib/supabase/server'
import { PageHeader } from '@/components/ui/page-header'
import { StatCard } from '@/components/ui/stat-card'
import { PrivacyMoney, PrivacyGate } from '@/components/ui/privacy-value'
import { YtdBridgeBar } from '@/components/profit-loss/ytd-bridge-bar'
import { PositionReturnsTable, type PositionReturnRow } from '@/components/profit-loss/position-returns-table'
import { categoryLabel } from '@/lib/domain/allocation'
import { money } from '@/lib/format'
import { todayLocalIso } from '@/lib/domain/snapshot'
import { RESULT_TOLERANCE_EUR, type ResultColumn, type ResultRow } from '@/lib/domain/investment-result'
import { loadReturns } from '@/lib/returns/load-returns'
import type { InvestmentType } from '@/types/database'

export const dynamic = 'force-dynamic'

// Every figure on this page comes from the central valuation and investment
// result (lib/returns/load-returns): the cards, the component table, the
// asset-class table and the position tables are the SAME numbers, so the
// tables add up to the cards. When the central engine is unavailable the
// page shows '—' and the reason — never figures from another calculation.

function fmtPercent(n: number | null, digits = 2): string {
  if (n === null || !Number.isFinite(n)) return '—'
  return `${n >= 0 ? '+' : ''}${n.toFixed(digits)}%`
}

function tone(n: number | null): 'positive' | 'negative' | 'neutral' {
  if (n === null || n === 0) return 'neutral'
  return n > 0 ? 'positive' : 'negative'
}

function textTone(n: number): string {
  if (!Number.isFinite(n) || Math.abs(n) < 0.005) return 'text-slate-900'
  return n > 0 ? 'text-emerald-700' : 'text-rose-700'
}

type Column = ResultColumn & { byInvestment: ResultRow[] }

const sumRows = (rows: ResultRow[], k: keyof Omit<ResultRow, 'investmentId'>) => rows.reduce((s, r) => s + r[k], 0)

export default async function ProfitLossDetailsPage() {
  const supabase = await createClient()
  const todayIso = todayLocalIso()
  const year = todayIso.slice(0, 4)
  const data = await loadReturns(supabase, todayIso)
  const h = data.headline
  const result = data.investmentResult
  const valuation = data.valuation

  const header = (
    <>
      <div>
        <Link href="/dashboard" className="text-sm text-slate-500 hover:text-slate-700">
          ← Portfolio
        </Link>
      </div>
      <PageHeader
        title="Profit / Loss Details"
        subtitle="Where your investment result comes from: realised, unrealised, income, costs and taxes."
      />
    </>
  )

  if (valuation.positions.length === 0 && data.contributionsAllTime.grossInflowsEur === 0) {
    return (
      <div className="space-y-6">
        {header}
        <div className="bg-white rounded-2xl border border-slate-200 p-10 text-center">
          <p className="text-slate-900 font-medium">Nothing to show yet</p>
          <p className="text-sm text-slate-500 mt-1">Add an investment to start tracking performance.</p>
        </div>
      </div>
    )
  }

  const meta = data.investmentsMeta
  const currentById = new Map(valuation.positions.map((p) => [p.investmentId, p]))

  // Positions: the since-start column of the central result, per investment.
  const positionRows: PositionReturnRow[] = (result?.sinceStart.byInvestment ?? []).map((r) => {
    const cur = currentById.get(r.investmentId)
    return {
      id: r.investmentId,
      name: meta[r.investmentId]?.name ?? r.investmentId,
      platform: meta[r.investmentId]?.platform ?? '',
      isClosed: r.heldAtEnd <= 0,
      soldCostEur: r.soldCostEur,
      saleProceedsEur: r.netProceedsEur,
      tradeRealizedEur: r.realisedEur,
      realizedReturnPct: r.soldCostEur > 0 ? r.realisedEur / r.soldCostEur : null,
      incomeAndFeesEur: r.dividendsInterestEur - r.costsEur - r.taxesEur,
      remainingCostEur: r.remainingCostEur,
      currentValueEur: cur?.valueEur ?? 0,
      unrealizedEur: r.unrealisedEndEur,
      unrealizedReturnPct: r.remainingCostEur > 0 ? r.unrealisedEndEur / r.remainingCostEur : null,
    }
  }).sort((a, b) => b.tradeRealizedEur + b.unrealizedEur - (a.tradeRealizedEur + a.unrealizedEur))

  // Asset classes: the same rows grouped by type (YTD and since start).
  const typeOf = (id: string): InvestmentType | null => meta[id]?.type ?? null
  const classRows = (() => {
    if (!result) return []
    const m = new Map<string, { ytd: number; all: number; unrealised: number; cost: number }>()
    const add = (col: Column, key: 'ytd' | 'all') => {
      for (const r of col.byInvestment) {
        const t = typeOf(r.investmentId) ?? 'custom'
        const b = m.get(t) ?? { ytd: 0, all: 0, unrealised: 0, cost: 0 }
        b[key] += r.totalEur
        if (key === 'all') { b.unrealised += r.unrealisedEndEur; b.cost += r.remainingCostEur }
        m.set(t, b)
      }
    }
    add(result.period, 'ytd')
    add(result.sinceStart, 'all')
    return [...m].map(([type, v]) => ({ type, ...v })).sort((a, b) => b.all - a.all)
  })()

  const components = (col: Column) => [
    { label: 'Realised profit/loss (units sold)', value: col.realisedEur },
    { label: 'Unrealised profit/loss (change)', value: col.unrealisedChangeEur },
    { label: 'Dividends and interest', value: col.dividendsInterestEur },
    { label: 'Separate costs (storage, connection fees, negative interest)', value: -col.costsEur },
    { label: 'Taxes withheld', value: -col.taxesEur },
  ]
  const basisRow = (col: Column) => col.valuationBasisAdjustmentEur
  // Reconciliation: the position rows must add up to the column total.
  const check = (col: Column) => {
    const rowsTotal = sumRows(col.byInvestment, 'totalEur')
    return { rowsTotal, difference: rowsTotal - col.totalEur, ok: Math.abs(rowsTotal - col.totalEur) <= RESULT_TOLERANCE_EUR }
  }
  const checks = result ? { ytd: check(result.period), all: check(result.sinceStart) } : null
  const tablesFinal = !!checks && checks.ytd.ok && checks.all.ok

  const ytdTwr = data.ytd
  const bridgeAmounts = result && ytdTwr.status === 'ok'
    ? {
        startValueEur: result.period.valueStartEur,
        netContributionsEur: ytdTwr.externalInEur - ytdTwr.externalOutEur,
        investmentProfitEur: result.period.totalEur,
        endValueEur: result.period.valueEndEur,
      }
    : null
  const unavailable = h.resultsUnavailableReason ?? 'the central calculation is unavailable'

  return (
    <div className="space-y-6">
      {header}

      {!h.resultsAvailable && (
        <p className="rounded-xl border border-rose-200 bg-rose-50 px-4 py-3 text-sm text-rose-900">
          — Results are not shown: {unavailable}{' '}
          <Link href="/returns" className="underline">See every missing source</Link>.
        </p>
      )}

      {/* A. Total performance */}
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
        <StatCard
          label="Total investment result"
          value={
            <PrivacyMoney
              value={h.totalResultSinceStartEur}
              signed
              fallbackText={h.xirrAnnualRate !== null ? `${fmtPercent(h.xirrAnnualRate * 100)} / yr XIRR` : '—'}
            />
          }
          hint={
            h.totalResultSinceStartEur === null ? unavailable : (
              <>
                Since start: realised and unrealised result, dividends and interest, minus separate costs and taxes.{' '}
                {h.xirrAnnualRate !== null && `Your personal money-weighted return (XIRR): ${fmtPercent(h.xirrAnnualRate * 100)} per year.`}
              </>
            )
          }
          tone={tone(h.totalResultSinceStartEur)}
        />
        <StatCard
          label="Realized"
          value={<PrivacyMoney value={h.realisedSinceStartEur} signed fallbackText="Closed and partly sold positions" />}
          hint={h.realisedSinceStartEur === null ? unavailable : 'Net proceeds of units sold − their average cost (incl. fees)'}
          tone={tone(h.realisedSinceStartEur)}
        />
        <StatCard
          label="Unrealized"
          value={<PrivacyMoney value={h.unrealisedNowEur} signed fallbackText="Open positions" />}
          hint={h.unrealisedNowEur === null ? unavailable : 'Current value − remaining cost of what you still hold'}
          tone={tone(h.unrealisedNowEur)}
        />
      </div>

      {/* B. YTD performance */}
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
        <StatCard
          label={`Investment result YTD (${year})`}
          value={
            <PrivacyMoney
              value={h.totalResultYtdEur}
              signed
              fallbackText={h.twrYtd === null ? '—' : fmtPercent(h.twrYtd * 100)}
            />
          }
          hint={
            h.twrYtd === null ? unavailable : (
              <PrivacyGate>
                <>{fmtPercent(h.twrYtd * 100)} · time-weighted return, since Jan 1</>
              </PrivacyGate>
            )
          }
          tone={tone(h.totalResultYtdEur)}
        />
        <StatCard
          label="Own money added YTD"
          value={<PrivacyMoney value={h.ownContributionsYtdEur} fallbackText="—" />}
          hint={`${money(h.platformContributionsYtdEur, 'EUR')} platform-funded · ${money(h.reusedSaleProceedsYtdEur, 'EUR')} re-used sale proceeds (not new money)`}
        />
      </div>

      {result && checks && (
        <>
          {/* C. Components — the same totals as the cards */}
          <div className="bg-white rounded-2xl border border-slate-200 overflow-hidden">
            <div className="px-5 py-4 border-b border-slate-100">
              <h2 className="text-base font-semibold text-slate-900">Where the result comes from</h2>
              <p className="text-xs text-slate-500 mt-1">
                Buy and sell fees ({money(result.sinceStart.transactionFeesIncludedEur, 'EUR')} since start) are already inside
                realised and unrealised and are not subtracted again.
              </p>
            </div>
            <div className="overflow-x-auto">
              <table className="min-w-full text-sm">
                <thead className="bg-slate-50">
                  <tr>
                    <th className="px-4 py-2 text-left text-xs font-medium text-slate-500">Component</th>
                    <th className="px-4 py-2 text-right text-xs font-medium text-slate-500">{year}</th>
                    <th className="px-4 py-2 text-right text-xs font-medium text-slate-500">Since start</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {components(result.period).map((row, i) => {
                    const all = components(result.sinceStart)[i].value
                    return (
                      <tr key={row.label}>
                        <td className="px-4 py-2 text-slate-700">{row.label}</td>
                        <td className={`px-4 py-2 text-right tabular-nums ${textTone(row.value)}`}><PrivacyMoney value={row.value} signed /></td>
                        <td className={`px-4 py-2 text-right tabular-nums ${textTone(all)}`}><PrivacyMoney value={all} signed /></td>
                      </tr>
                    )
                  })}
                  <tr className="bg-slate-50 font-medium">
                    <td className="px-4 py-2">Total investment result</td>
                    <td className={`px-4 py-2 text-right tabular-nums ${textTone(result.period.totalEur)}`}><PrivacyMoney value={result.period.totalEur} signed /></td>
                    <td className={`px-4 py-2 text-right tabular-nums ${textTone(result.sinceStart.totalEur)}`}><PrivacyMoney value={result.sinceStart.totalEur} signed /></td>
                  </tr>
                  <tr title="A change of valuation source (statement → market, a new dealer value): it moves the value but is no result.">
                    <td className="px-4 py-2 text-xs text-slate-500">Valuation basis adjustment (not in the result)</td>
                    <td className="px-4 py-2 text-right text-xs tabular-nums text-slate-500"><PrivacyMoney value={basisRow(result.period)} signed /></td>
                    <td className="px-4 py-2 text-right text-xs tabular-nums text-slate-500"><PrivacyMoney value={basisRow(result.sinceStart)} signed /></td>
                  </tr>
                  <tr>
                    <td className="px-4 py-2 text-xs text-slate-500">Check: sum of the position rows below</td>
                    <td className="px-4 py-2 text-right text-xs tabular-nums text-slate-500">
                      <PrivacyMoney value={checks.ytd.rowsTotal} signed /> {checks.ytd.ok ? <span className="text-emerald-700">✓</span> : <span className="text-rose-700">≠ <PrivacyMoney value={checks.ytd.difference} signed /></span>}
                    </td>
                    <td className="px-4 py-2 text-right text-xs tabular-nums text-slate-500">
                      <PrivacyMoney value={checks.all.rowsTotal} signed /> {checks.all.ok ? <span className="text-emerald-700">✓</span> : <span className="text-rose-700">≠ <PrivacyMoney value={checks.all.difference} signed /></span>}
                    </td>
                  </tr>
                </tbody>
              </table>
            </div>
          </div>

          {/* D. Per asset class — the same rows, grouped */}
          <div className="bg-white rounded-2xl border border-slate-200 overflow-hidden">
            <div className="px-5 py-4 border-b border-slate-100">
              <h2 className="text-base font-semibold text-slate-900">By asset class{tablesFinal ? '' : ' (not final: does not add up)'}</h2>
              <p className="text-xs text-slate-500 mt-1">Investment result in euros; unrealised % = unrealised ÷ remaining cost of what is still held. Broker cash is not an asset class.</p>
            </div>
            <div className="overflow-x-auto">
              <table className="min-w-full text-sm">
                <thead className="bg-slate-50">
                  <tr>
                    <th className="px-4 py-2 text-left text-xs font-medium text-slate-500">Asset class</th>
                    <th className="px-4 py-2 text-right text-xs font-medium text-slate-500">Result {year}</th>
                    <th className="px-4 py-2 text-right text-xs font-medium text-slate-500">Result since start</th>
                    <th className="px-4 py-2 text-right text-xs font-medium text-slate-500">Unrealised now</th>
                    <th className="px-4 py-2 text-right text-xs font-medium text-slate-500">Unrealised %</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {classRows.map((c) => (
                    <tr key={c.type}>
                      <td className="px-4 py-2 text-slate-700">{categoryLabel(c.type as InvestmentType)}</td>
                      <td className={`px-4 py-2 text-right tabular-nums ${textTone(c.ytd)}`}><PrivacyMoney value={c.ytd} signed /></td>
                      <td className={`px-4 py-2 text-right tabular-nums ${textTone(c.all)}`}><PrivacyMoney value={c.all} signed /></td>
                      <td className={`px-4 py-2 text-right tabular-nums ${textTone(c.unrealised)}`}><PrivacyMoney value={c.unrealised} signed /></td>
                      <td className="px-4 py-2 text-right tabular-nums">{c.cost > 0 ? fmtPercent((c.unrealised / c.cost) * 100) : '—'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>

          <div>
            {!tablesFinal && (
              <p className="mb-2 text-sm text-rose-700">These tables do not add up to the totals above and are not final.</p>
            )}
            <PositionReturnsTable rows={positionRows} />
          </div>
        </>
      )}

      {/* E. YTD breakdown */}
      <div className="bg-white rounded-2xl border border-slate-200 p-5 md:p-6">
        <h2 className="text-base font-semibold text-slate-900 mb-1">YTD breakdown</h2>
        <p className="text-sm text-slate-500 mb-4">
          Value on 31 Dec + net external cash flow + investment result + valuation basis adjustment = value now. These
          values include broker cash ({result ? money(result.period.valueEndEur - (h.currentValueEur ?? 0), 'EUR') : '—'} now), because
          the return runs through it; the portfolio value elsewhere shows investment positions only. External money is never
          counted as investment profit.
        </p>
        {bridgeAmounts ? (
          <YtdBridgeBar amounts={bridgeAmounts} />
        ) : (
          <p className="text-sm text-slate-500">— Not available: {unavailable}.</p>
        )}
      </div>

      <p className="text-xs text-slate-400 px-1">
        All figures come from the same central valuation and investment result as Dashboard, Returns, History and
        Asset Allocation — deposits/withdrawals are never counted as investment profit, and a fee is applied once.
      </p>
    </div>
  )
}
