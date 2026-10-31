import { PrivacyMoney } from '@/components/ui/privacy-value'
import { fmtDate } from '@/lib/format'
import type { ReturnsData, PeriodReturn } from '@/lib/returns/load-returns'
import type { ReturnQuality } from '@/lib/domain/twr'
import { CONTRIBUTION_TOLERANCE } from '@/lib/domain/twr'
import { PERSONAL_RETURN_EXPLANATION } from '@/lib/domain/position-overview'
import { DataQualityPanel, InvestmentResultBlock } from '@/components/returns/result-panels'
import type { ContributionSummary } from '@/lib/domain/flow-classification'

function pct(n: number | null | undefined, digits = 2): string {
  if (n === null || n === undefined || !Number.isFinite(n)) return '—'
  return `${n >= 0 ? '+' : ''}${(n * 100).toFixed(digits)}%`
}
function pp(n: number | null | undefined): string {
  if (n === null || n === undefined || !Number.isFinite(n)) return '—'
  return `${n >= 0 ? '+' : ''}${(n * 100).toFixed(2)} pp`
}
function tone(n: number | null | undefined): string {
  if (n === null || n === undefined || !Number.isFinite(n) || n === 0) return 'text-slate-900'
  return n > 0 ? 'text-emerald-700' : 'text-rose-700'
}

const QUALITY_TEXT: Record<ReturnQuality, { label: string; cls: string; help: string }> = {
  confirmed: { label: 'confirmed', cls: 'bg-emerald-50 text-emerald-700 border-emerald-200', help: 'Every value comes from an official statement.' },
  reconstructed: { label: 'reconstructed', cls: 'bg-sky-50 text-sky-700 border-sky-200', help: 'Daily values rebuilt from your records and market closes.' },
  estimated: { label: 'estimated', cls: 'bg-amber-50 text-amber-800 border-amber-200', help: 'Part of the values is an estimate (e.g. metals priced with a market benchmark only).' },
  unavailable: { label: 'unavailable', cls: 'bg-slate-100 text-slate-600 border-slate-200', help: 'A price, exchange rate or cash balance is missing, so no percentage is shown.' },
}

export function QualityBadge({ quality }: { quality: ReturnQuality }) {
  const q = QUALITY_TEXT[quality]
  return (
    <span title={q.help} className={`inline-flex items-center rounded-full border px-2 py-0.5 text-xs font-medium ${q.cls}`}>
      {q.label}
    </span>
  )
}

function PeriodCard({ period, primary }: { period: PeriodReturn; primary?: boolean }) {
  const t = period.twr
  const ok = t.status === 'ok'
  return (
    <div className={`bg-white rounded-2xl border p-5 ${primary ? 'border-slate-300' : 'border-slate-200'}`}>
      <div className="flex items-center justify-between gap-2">
        <p className="text-xs uppercase tracking-wide text-slate-500 font-medium">
          Portfolio return {period.label}
        </p>
        <QualityBadge quality={t.quality} />
      </div>
      <p className={`mt-2 font-semibold tabular-nums ${primary ? 'text-3xl md:text-4xl' : 'text-2xl md:text-3xl'} ${tone(t.twr)}`}>
        {ok ? pct(t.twr, 1) : '—'}
        {ok && <span className="ml-1 text-sm font-medium text-slate-500">{period.key === 'all' ? 'in total' : period.key === 'ytd' ? 'YTD' : 'over 1 year'}</span>}
      </p>
      <p className="mt-1 text-xs text-slate-500">Time-weighted · not per year</p>
      <dl className="mt-3 space-y-1 text-xs text-slate-600">
        <div className="flex justify-between gap-2">
          <dt>Period</dt>
          <dd className="tabular-nums">{fmtDate(period.start)} → {fmtDate(t.endDate)}</dd>
        </div>
        <div className="flex justify-between gap-2">
          <dt>Start value</dt>
          <dd><PrivacyMoney value={t.startValueEur} /></dd>
        </div>
        <div className="flex justify-between gap-2">
          <dt>End value</dt>
          <dd><PrivacyMoney value={t.endValueEur} /></dd>
        </div>
      </dl>
      {ok && t.truncated && (
        <p className="mt-2 text-xs text-amber-800">
          Only up to {fmtDate(t.endDate)}: later data is incomplete ({t.missing[0]?.reason ?? 'missing value'}).
        </p>
      )}
      {!ok && (
        <p className="mt-2 text-xs text-slate-600">
          Not available: {t.missing[0]?.reason ?? 'missing data'}
          {period.modifiedDietzEstimate !== null && (
            <> Rough estimate (Modified Dietz): <span className="tabular-nums">{pct(period.modifiedDietzEstimate, 1)}</span>.</>
          )}
        </p>
      )}
    </div>
  )
}

function ContributionTable({ ytd, all, year }: { ytd: ContributionSummary; all: ContributionSummary; year: string }) {
  const rows: { label: string; key: keyof ContributionSummary; strong?: boolean; indent?: boolean; help?: string }[] = [
    { label: 'Own money added', key: 'grossOwnContributionsEur', strong: true, help: 'Your own bank money plus Round Ups.' },
    { label: 'of which bank deposits', key: 'ownBankEur', indent: true },
    { label: 'of which Round Ups', key: 'roundUpEur', indent: true },
    { label: 'Platform-funded contributions', key: 'grossPlatformContributionsEur', strong: true, help: 'Saveback/cashback and referral or other rewards, paid by the platform.' },
    { label: 'Fresh money in total', key: 'grossFreshContributionsEur', strong: true, help: 'Own money + platform money. Re-used sale proceeds are not included.' },
    { label: 'Re-used sale proceeds', key: 'reusedSaleProceedsEur', help: 'Money from earlier sales that was withdrawn and later put back. Never new money.' },
    { label: 'Gross withdrawals', key: 'grossWithdrawalsEur' },
    { label: 'Net external cash flow', key: 'netExternalCashFlowEur', strong: true, help: 'All money in − all money out. Not your personal contribution: a withdrawal can contain original money or profit.' },
  ]
  return (
    <div className="max-w-full overflow-x-auto rounded-2xl border border-slate-200 bg-white">
      <table className="min-w-full text-sm">
        <thead className="bg-slate-50">
          <tr>
            <th className="px-4 py-2 text-left text-xs font-medium text-slate-500">Contributions</th>
            <th className="px-4 py-2 text-right text-xs font-medium text-slate-500">{year}</th>
            <th className="px-4 py-2 text-right text-xs font-medium text-slate-500">Since start</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-slate-100">
          {rows.map((r) => (
            <tr key={r.key} title={r.help}>
              <td className={`px-4 py-2 ${r.indent ? 'pl-8 text-slate-500' : ''} ${r.strong ? 'font-medium text-slate-900' : 'text-slate-700'}`}>{r.label}</td>
              <td className="px-4 py-2 text-right tabular-nums"><PrivacyMoney value={ytd[r.key] as number} /></td>
              <td className="px-4 py-2 text-right tabular-nums"><PrivacyMoney value={all[r.key] as number} /></td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

const th = 'px-3 py-2 text-xs font-medium text-slate-500 text-right whitespace-nowrap'
const thL = 'px-3 py-2 text-xs font-medium text-slate-500 text-left whitespace-nowrap'
const td = 'px-3 py-2 text-sm tabular-nums text-right whitespace-nowrap'
const tdL = 'px-3 py-2 text-sm text-left whitespace-nowrap'
// First column stays visible while the table scrolls sideways.
const stickyTh = 'sticky left-0 z-10 bg-slate-50 px-3 py-2 text-xs font-medium text-slate-500 text-left whitespace-nowrap shadow-[1px_0_0_0_#e2e8f0]'
const stickyTd = 'sticky left-0 z-10 bg-white px-3 py-2 text-sm text-left shadow-[1px_0_0_0_#e2e8f0] min-w-[11rem] max-w-[14rem]'
const scrollBox = 'max-w-full overflow-x-auto rounded-2xl border border-slate-200 bg-white'

function price(p: { price: number; currency: string } | null, unit: string | null) {
  if (!p) return '—'
  const digits = p.price < 10 ? 4 : 2
  return `${p.price.toFixed(digits)} ${p.currency}${unit ? `/${unit === 'troy_ounce' ? 'oz' : 'g'}` : ''}`
}

export function ReturnsView({ data }: { data: ReturnsData }) {
  const ytdPeriod = data.periods.find((p) => p.key === 'ytd')!
  const year = data.endDate.slice(0, 4)
  const t = data.ytd
  const openIds = new Set(data.open.map((o) => o.investmentId))
  const closedIds = new Set(data.closed.filter((c) => c.fullyClosed).map((c) => c.investmentId))
  const group = (pred: (id: string) => boolean) =>
    Object.entries(t.bySleeve).filter(([id]) => pred(id)).reduce((s, [, v]) => s + v.contribution, 0)
  const groups = [
    { label: 'Open positions', value: group((id) => openIds.has(id)) },
    { label: 'Closed positions', value: group((id) => closedIds.has(id)) },
    { label: 'Broker cash (interest, costs)', value: group((id) => id.startsWith('cash:')) },
    { label: 'Other positions (held earlier, no sale this year)', value: group((id) => !id.startsWith('cash:') && !openIds.has(id) && !closedIds.has(id)) },
  ]
  const components = [
    { label: 'Price movement', value: t.byComponent.market },
    { label: 'Currency effect', value: t.byComponent.fx },
    { label: 'Dividends and interest', value: t.byComponent.income },
    { label: 'Transaction and other costs', value: t.byComponent.fees },
    { label: 'Taxes withheld', value: t.byComponent.taxes },
  ]
  const ok = t.status === 'ok'
  const matches = ok && t.residual !== null && Math.abs(t.residual) <= CONTRIBUTION_TOLERANCE

  return (
    <div className="space-y-8 min-w-0">
      <section className="grid grid-cols-1 md:grid-cols-3 gap-4 [&>*]:min-w-0">
        {data.periods.map((p) => (
          <PeriodCard key={p.key} period={p} primary={p.key === 'ytd'} />
        ))}
      </section>

      <DataQualityPanel data={data} />

      <section className="grid grid-cols-1 md:grid-cols-2 gap-4 [&>*]:min-w-0">
        <div className="bg-white rounded-2xl border border-slate-200 p-5">
          <p className="text-xs uppercase tracking-wide text-slate-500 font-medium">Money-weighted return (XIRR) · per year</p>
          <p className={`mt-2 text-2xl font-semibold tabular-nums ${tone(data.xirr.annualRate)}`}>
            {data.xirr.annualRate === null ? '—' : `${pct(data.xirr.annualRate, 1)} per year`}
          </p>
          <p className="mt-1 text-xs text-slate-500">
            {data.xirr.unavailableReason ??
              'Secondary figure. It depends on how much you added and when: a large deposit just before a rise or fall moves it, unlike the time-weighted return above.'}
          </p>
        </div>
        <div className="bg-white rounded-2xl border border-slate-200 p-5 text-sm text-slate-600 space-y-1">
          <p className="font-medium text-slate-900">What the time-weighted return includes</p>
          <p>Open and sold positions, realised and unrealised results, dividends and interest, transaction, storage and other costs, taxes withheld, broker cash and currency effects.</p>
          <p>Deposits and withdrawals are taken out of the calculation: a deposit is counted from the start of its day. Buying with money from a sale is not new money.</p>
          {data.anchorSource ? (
            <p>Start {fmtDate(ytdPeriod.start)}: official statements ({data.anchorSource}).</p>
          ) : null}
          {data.dataNotes.map((n) => (
            <p key={n} className="text-amber-800">{n}</p>
          ))}
        </div>
      </section>

      <InvestmentResultBlock data={data} />

      <section className="space-y-3 min-w-0">
        <h2 className="text-lg font-semibold">Open positions · {ytdPeriod.label}</h2>
        <p className="text-xs text-slate-500">Hover a column title for exactly what is divided by what. Scroll sideways for details; the instrument stays on the left.</p>
        <div className={scrollBox}>
          <table className="min-w-full border-separate border-spacing-0">
            <thead>
              <tr className="text-[11px] uppercase tracking-wide">
                <th className="sticky left-0 z-10 bg-slate-50" />
                <th colSpan={2} className="bg-sky-50 px-3 pt-2 text-center font-semibold text-sky-800 border-l border-white">Return (%)</th>
                <th colSpan={3} className="bg-emerald-50 px-3 pt-2 text-center font-semibold text-emerald-800 border-l border-white">Result (€)</th>
                <th className="bg-violet-50 px-3 pt-2 text-center font-semibold text-violet-800 border-l border-white">Portfolio</th>
                <th colSpan={6} className="bg-slate-50 px-3 pt-2 text-left font-semibold text-slate-500 border-l border-white">Details</th>
              </tr>
              <tr>
                <th className={stickyTh}>Instrument</th>
                <th className={`${th} bg-sky-50`} title="(price now − price on 31 Dec) ÷ price on 31 Dec, in the instrument’s own currency, without dividends. For positions bought later in the year this is only a market comparison.">Market YTD</th>
                <th className={`${th} bg-sky-50`} title={PERSONAL_RETURN_EXPLANATION}>Your return since buying</th>
                <th className={`${th} bg-emerald-50`} title="Value now − remaining cost of the units you still hold (moving average, incl. buy fees). Only what you still hold.">Unrealised P/L now</th>
                <th className={`${th} bg-emerald-50`} title={`Net proceeds of units of this position sold in ${year} − the average cost of those units. Units still held are not in here.`}>Realised P/L {year}</th>
                <th className={`${th} bg-emerald-50`} title={`Value now − value on 31 Dec − purchases + net sale proceeds + net dividends − separate costs, in ${year}.`}>Total result {year}</th>
                <th className={`${th} bg-violet-50`} title="Each day: this position’s result ÷ the portfolio’s invested capital, compounded with the portfolio return before that day. All contributions add up to the portfolio return.">Contribution to portfolio return</th>
                <th className={thL}>First bought</th>
                <th className={th}>Quantity</th>
                <th className={th}>Price 31 Dec</th>
                <th className={th}>Price now</th>
                <th className={th} title="Remaining cost of what you still hold ÷ quantity (moving average, incl. fees).">Avg. cost</th>
                <th className={thL}>Source</th>
              </tr>
            </thead>
            <tbody>
              {data.open.map((r) => (
                  <tr key={r.investmentId} className="[&>td]:border-t [&>td]:border-slate-100">
                    <td className={stickyTd}>
                      <div className="font-medium text-slate-900 truncate" title={r.name}>{r.name}</div>
                      <div className="text-xs text-slate-500">
                        {r.platform}
                        {r.openedInPeriod && <span className="ml-1 rounded bg-slate-100 px-1">new in {year}</span>}
                      </div>
                    </td>
                    <td className={`${td} bg-sky-50/40 ${tone(r.marketReturn)}`} title={r.openedInPeriod ? 'Market comparison: you bought later in the year.' : undefined}>
                      {pct(r.marketReturn)}{r.openedInPeriod ? '*' : ''}
                    </td>
                    <td className={`${td} bg-sky-50/40 font-medium ${tone(r.personalReturn)}`} title={PERSONAL_RETURN_EXPLANATION + (r.hasRebuysAfterSale ? ' Money re-bought after a sale is counted again in the purchases.' : '')}>
                      {pct(r.personalReturn)}
                    </td>
                    <td className={`${td} ${tone(r.unrealizedEur)}`}><PrivacyMoney value={r.unrealizedEur} signed /></td>
                    <td className={`${td} ${tone(r.realizedInPeriodEur)}`}>
                      {Math.abs(r.realizedInPeriodEur) < 0.005 ? <span className="text-slate-400">—</span> : <PrivacyMoney value={r.realizedInPeriodEur} signed />}
                    </td>
                    <td className={`${td} font-medium ${tone(r.periodGainEur)}`}><PrivacyMoney value={r.periodGainEur} signed /></td>
                    <td className={`${td} bg-violet-50/40 ${tone(r.contribution)}`}>{ok && r.contribution !== null ? pp(r.contribution) : '—'}</td>
                    <td className={`${tdL} text-slate-500`}>{r.firstBuyDate ? fmtDate(r.firstBuyDate) : '—'}</td>
                    <td className={`${td} text-slate-500`}>{Number(r.quantity.toFixed(6))}{r.unit ? (r.unit === 'gram' ? ' g' : ' oz') : ''}</td>
                    <td className={`${td} text-slate-500`}>{price(r.startPrice, r.unit)}</td>
                    <td className={`${td} text-slate-500`}>{price(r.endPrice, r.unit)}</td>
                    <td className={`${td} text-slate-500`}><PrivacyMoney value={r.averageCostEur} /></td>
                    <td className={`${tdL} text-xs text-slate-500`}>{r.valueSource} · <QualityBadge quality={r.quality as ReturnQuality} /></td>
                  </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p className="text-xs text-slate-500">
          * Bought during {year}: Market YTD is a comparison only; “Your return since buying” is what you made (current holding, since it was last opened).
          The instrument’s market return including dividends is not shown: there is no reliable dividend history per instrument.
        </p>
      </section>

      <section className="space-y-3 min-w-0">
        <h2 className="text-lg font-semibold">Sold in {year} (fully or partly)</h2>
        {data.closed.length === 0 ? (
          <p className="text-sm text-slate-500">Nothing sold in this period.</p>
        ) : (
          <div className={scrollBox}>
            <table className="min-w-full border-separate border-spacing-0">
              <thead className="bg-slate-50">
                <tr>
                  <th className={stickyTh}>Instrument</th>
                  <th className={th} title="Realised ÷ cost of what was sold.">Realised %</th>
                  <th className={th}>Realised profit/loss</th>
                  <th className={th}>Contribution to return</th>
                  <th className={th}>Cost of what was sold</th>
                  <th className={th}>Net proceeds</th>
                  <th className={th}>Dividends</th>
                  <th className={th}>Costs</th>
                  <th className={thL}>Bought</th>
                  <th className={thL}>Sold</th>
                </tr>
              </thead>
              <tbody>
                {data.closed.map((r) => (
                  <tr key={r.investmentId} className="[&>td]:border-t [&>td]:border-slate-100">
                    <td className={stickyTd}>
                      <div className="font-medium text-slate-900 truncate" title={r.name}>{r.name}</div>
                      <div className="text-xs text-slate-500">
                        {r.platform}
                        {!r.fullyClosed && <span className="ml-1 rounded bg-slate-100 px-1">partly sold</span>}
                      </div>
                    </td>
                    <td className={`${td} ${tone(r.realizedReturn)}`}>{pct(r.realizedReturn)}</td>
                    <td className={`${td} ${tone(r.realizedEur)}`}><PrivacyMoney value={r.realizedEur} signed /></td>
                    <td className={`${td} ${tone(r.contribution)}`} title={r.fullyClosed ? undefined : 'Still partly held: its contribution is in the open positions table.'}>
                      {r.fullyClosed ? (ok ? pp(r.contribution) : '—') : 'in open table'}
                    </td>
                    <td className={td}><PrivacyMoney value={r.soldCostEur} /></td>
                    <td className={td}><PrivacyMoney value={r.netProceedsEur} /></td>
                    <td className={td}><PrivacyMoney value={r.incomeEur} /></td>
                    <td className={td}><PrivacyMoney value={r.costsEur} /></td>
                    <td className={tdL}>{r.buyFrom ? `${fmtDate(r.buyFrom)}${r.buyTo && r.buyTo !== r.buyFrom ? ` – ${fmtDate(r.buyTo)}` : ''}` : '—'}</td>
                    <td className={tdL}>{fmtDate(r.sellFrom)}{r.sellTo !== r.sellFrom ? ` – ${fmtDate(r.sellTo)}` : ''}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <p className="text-xs text-slate-500">
          A partly sold position appears here for its sold units and in the open table for the rest; in the investment result every sale is counted once.
        </p>
      </section>

      <section className="space-y-3">
        <h2 className="text-lg font-semibold">Where the {ytdPeriod.label} return came from</h2>
        {!ok ? (
          <p className="text-sm text-slate-500">Not available while the return itself is unavailable.</p>
        ) : (
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4 [&>*]:min-w-0">
            {[{ title: 'By position group', rows: groups }, { title: 'By source of result', rows: components }].map((block) => (
              <div key={block.title} className={scrollBox}>
                <table className="min-w-full text-sm">
                  <thead className="bg-slate-50">
                    <tr>
                      <th className={thL}>{block.title}</th>
                      <th className={th}>Contribution</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100">
                    {block.rows.map((r) => (
                      <tr key={r.label}>
                        <td className="px-3 py-2 text-slate-700">{r.label}</td>
                        <td className={`${td} ${tone(r.value)}`}>{pp(r.value)}</td>
                      </tr>
                    ))}
                    <tr>
                      <td className="px-3 py-2 text-slate-500">Rounding difference</td>
                      <td className={td}>{pp(t.residual)}</td>
                    </tr>
                    <tr className="bg-slate-50 font-medium">
                      <td className="px-3 py-2">Sum of contributions = total return</td>
                      <td className={td}>
                        {pp(t.sumOfContributions)} = {pct(t.twr)}{' '}
                        {matches ? (
                          <span className="text-emerald-700" title="Matches within 0.01 percentage point.">✓</span>
                        ) : (
                          <span className="text-rose-700">does not match ({pp(t.residual)})</span>
                        )}
                      </td>
                    </tr>
                  </tbody>
                </table>
              </div>
            ))}
          </div>
        )}
      </section>

      <section className="space-y-3">
        <h2 className="text-lg font-semibold">Contributions</h2>
        <ContributionTable ytd={data.contributionsYtd} all={data.contributionsAllTime} year={year} />
        <p className="text-xs text-slate-500">
          Selling and buying again inside your portfolio is never new money. Re-used sale proceeds are shown apart and never count as new money.
          The net external cash flow is all money in minus all money out — not your personal contribution, because a withdrawal can contain original money or profit.
          Deposits count as own bank money unless they are marked as re-used sale proceeds; withdrawals and later deposits are never matched automatically.
        </p>
      </section>
    </div>
  )
}
