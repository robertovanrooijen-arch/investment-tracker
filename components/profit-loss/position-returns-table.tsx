import { PrivacyMoney, PrivacyGate } from '@/components/ui/privacy-value'
import { money } from '@/lib/format'

export type PositionReturnRow = {
  id: string
  name: string
  platform: string
  isClosed: boolean
  // Realized on what was SOLD (moving average cost).
  soldCostEur: number
  saleProceedsEur: number
  tradeRealizedEur: number
  realizedReturnPct: number | null // fraction
  // Dividend/interest net of tax, minus separate fee rows.
  incomeAndFeesEur: number
  // Unrealized on what is still HELD.
  remainingCostEur: number
  currentValueEur: number
  unrealizedEur: number
  unrealizedReturnPct: number | null // fraction
}

function fmtPct(n: number | null): string {
  if (n === null || !Number.isFinite(n)) return '—'
  return `${n >= 0 ? '+' : ''}${(n * 100).toFixed(2)}%`
}

function tone(n: number): string {
  if (!Number.isFinite(n) || n === 0) return 'text-slate-900'
  return n > 0 ? 'text-emerald-700' : 'text-rose-700'
}

const th = 'px-3 py-2 text-xs font-medium text-slate-500 text-right whitespace-nowrap'
const td = 'px-3 py-2 text-sm tabular-nums text-right whitespace-nowrap'

export function PositionReturnsTable({ rows }: { rows: PositionReturnRow[] }) {
  const sold = rows.filter((r) => r.soldCostEur > 0)
  const open = rows.filter((r) => !r.isClosed && r.remainingCostEur > 0)

  return (
    <div className="space-y-6">
      <section className="bg-white rounded-2xl border border-slate-200 overflow-hidden">
        <div className="px-5 py-4 border-b border-slate-100">
          <h2 className="text-base font-semibold text-slate-900">Realized result per sold position</h2>
          <p className="text-xs text-slate-500 mt-1">
            Return = (net sale proceeds − cost of what was sold) ÷ cost of what was sold. Cost uses the moving
            average; a fully closed position always realises total proceeds − total cost. Dividends, interest and
            separate fees are shown apart and are not part of this percentage.
          </p>
        </div>
        {sold.length === 0 ? (
          <p className="px-5 py-6 text-sm text-slate-500">Nothing has been sold yet.</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full">
              <thead className="bg-slate-50">
                <tr>
                  <th className={`${th} text-left`}>Position</th>
                  <th className={th}>Cost sold</th>
                  <th className={th}>Net proceeds</th>
                  <th className={th}>Realized</th>
                  <th className={th}>Return</th>
                  <th className={th}>Div./interest/fees</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {sold.map((r) => (
                  <tr key={r.id}>
                    <td className="px-3 py-2 text-sm text-slate-900">
                      {r.name} <span className="text-xs text-slate-400">· {r.platform}{r.isClosed ? ' · closed' : ''}</span>
                    </td>
                    <td className={td}><PrivacyMoney value={r.soldCostEur} fallbackText="—" /></td>
                    <td className={td}><PrivacyMoney value={r.saleProceedsEur} fallbackText="—" /></td>
                    <td className={`${td} ${tone(r.tradeRealizedEur)}`}>
                      <PrivacyMoney value={r.tradeRealizedEur} signed fallbackText="—" />
                    </td>
                    <td className={`${td} ${tone(r.tradeRealizedEur)}`}>{fmtPct(r.realizedReturnPct)}</td>
                    <td className={td}>
                      <PrivacyGate fallback="—">
                        <>{Math.abs(r.incomeAndFeesEur) >= 0.005 ? money(r.incomeAndFeesEur, 'EUR') : '—'}</>
                      </PrivacyGate>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <section className="bg-white rounded-2xl border border-slate-200 overflow-hidden">
        <div className="px-5 py-4 border-b border-slate-100">
          <h2 className="text-base font-semibold text-slate-900">Unrealized result per open position</h2>
          <p className="text-xs text-slate-500 mt-1">
            Return = (current value − remaining cost) ÷ remaining cost of what you still hold, at today&apos;s prices.
          </p>
        </div>
        {open.length === 0 ? (
          <p className="px-5 py-6 text-sm text-slate-500">No open positions.</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full">
              <thead className="bg-slate-50">
                <tr>
                  <th className={`${th} text-left`}>Position</th>
                  <th className={th}>Remaining cost</th>
                  <th className={th}>Value</th>
                  <th className={th}>Unrealized</th>
                  <th className={th}>Return</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {open.map((r) => (
                  <tr key={r.id}>
                    <td className="px-3 py-2 text-sm text-slate-900">
                      {r.name} <span className="text-xs text-slate-400">· {r.platform}</span>
                    </td>
                    <td className={td}><PrivacyMoney value={r.remainingCostEur} fallbackText="—" /></td>
                    <td className={td}><PrivacyMoney value={r.currentValueEur} fallbackText="—" /></td>
                    <td className={`${td} ${tone(r.unrealizedEur)}`}>
                      <PrivacyMoney value={r.unrealizedEur} signed fallbackText="—" />
                    </td>
                    <td className={`${td} ${tone(r.unrealizedEur)}`}>{fmtPct(r.unrealizedReturnPct)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  )
}
