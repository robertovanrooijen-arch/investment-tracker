'use client'

import { useState } from 'react'

type Preview = {
  summary: { sourceRows: number; tradesFound: number; ready: number; alreadyPresent: number; ignoredRows: number; unresolvedInstruments: number; conflicts: number }
  warnings: string[]
  unresolved: { reason: string }[]
  conflicts: string[]
  canApply: boolean
  trades: { date: string; type: string; investmentName: string; quantity: number; amount: number; currency: string; status: string }[]
  applied?: { inserted?: number; already_present?: number }
}

export function TradeImporter() {
  const [file, setFile] = useState<File | null>(null)
  const [platform, setPlatform] = useState('trade_republic')
  const [preview, setPreview] = useState<Preview | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  async function submit(mode: 'preview' | 'apply') {
    if (!file) return setError('Choose a CSV file first.')
    setBusy(true)
    setError(null)
    try {
      const form = new FormData()
      form.set('file', file)
      form.set('platform', platform)
      form.set('mode', mode)
      const response = await fetch('/api/import/trades', { method: 'POST', body: form })
      const body = await response.json() as Preview & { error?: string }
      if (!response.ok) throw new Error(body.error || 'Import failed.')
      setPreview(body)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Import failed.')
    } finally {
      setBusy(false)
    }
  }

  const messages = preview ? [...preview.warnings, ...preview.unresolved.map((item) => item.reason), ...preview.conflicts] : []
  return (
    <div className="space-y-5">
      <section className="rounded-2xl border border-slate-200 bg-white p-5">
        <div className="grid gap-4 sm:grid-cols-[220px_1fr_auto] sm:items-end">
          <label className="block text-sm font-medium text-slate-700">
            Platform
            <select value={platform} onChange={(event) => { setPlatform(event.target.value); setPreview(null) }} className="mt-2 w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm">
              <option value="trade_republic">Trade Republic</option><option value="degiro">DEGIRO</option>
              <option value="bitvavo">Bitvavo</option><option value="goldrepublic">GoldRepublic</option>
            </select>
          </label>
          <label className="block text-sm font-medium text-slate-700">
            Original CSV export
            <input type="file" accept=".csv,text/csv" onChange={(event) => { setFile(event.target.files?.[0] ?? null); setPreview(null) }} className="mt-2 block w-full text-sm text-slate-600 file:mr-3 file:rounded-lg file:border-0 file:bg-slate-100 file:px-3 file:py-2 file:font-medium file:text-slate-700" />
          </label>
          <button type="button" disabled={busy || !file} onClick={() => submit('preview')} className="rounded-lg bg-slate-900 px-4 py-2 text-sm font-medium text-white hover:bg-slate-800 disabled:opacity-50">
            {busy ? 'Checking…' : 'Check file'}
          </button>
        </div>
        <p className="mt-4 text-xs text-slate-500">This imports buys and sells only. Trade Republic card payments stay outside the tracker. Money entering or leaving the investment portfolio remains a separate Contribution.</p>
      </section>

      {error && <div className="rounded-xl border border-rose-200 bg-rose-50 px-4 py-3 text-sm text-rose-800">{error}</div>}
      {preview && (
        <>
          <section className="rounded-2xl border border-slate-200 bg-white p-5">
            <div className="grid gap-3 sm:grid-cols-3 lg:grid-cols-6">
              {[
                ['Source rows', preview.summary.sourceRows], ['Trades found', preview.summary.tradesFound], ['New', preview.summary.ready],
                ['Already present', preview.summary.alreadyPresent], ['Unresolved', preview.summary.unresolvedInstruments], ['Conflicts', preview.summary.conflicts],
              ].map(([label, value]) => <div key={String(label)} className="rounded-xl bg-slate-50 p-3"><p className="text-xs text-slate-500">{label}</p><p className="mt-1 text-lg font-semibold text-slate-900">{value}</p></div>)}
            </div>
            {messages.length > 0 && <ul className="mt-4 space-y-1 text-sm text-amber-800">{messages.map((message, index) => <li key={`${index}-${message}`}>• {message}</li>)}</ul>}
            {preview.applied ? (
              <p className="mt-4 rounded-xl bg-emerald-50 px-4 py-3 text-sm font-medium text-emerald-800">Import complete: {preview.applied.inserted ?? 0} new trade(s), {preview.applied.already_present ?? 0} already present.</p>
            ) : preview.summary.ready === 0 && preview.summary.unresolvedInstruments === 0 && preview.summary.conflicts === 0 ? (
              <p className="mt-4 rounded-xl bg-slate-50 px-4 py-3 text-sm font-medium text-slate-700">No new trades to import. Every recognised trade is already present.</p>
            ) : preview.canApply ? (
              <button type="button" disabled={busy} onClick={() => submit('apply')} className="mt-4 rounded-lg bg-emerald-700 px-4 py-2 text-sm font-medium text-white hover:bg-emerald-600 disabled:opacity-50">{busy ? 'Importing…' : `Import ${preview.summary.ready} new trade${preview.summary.ready === 1 ? '' : 's'}`}</button>
            ) : <p className="mt-4 text-sm font-medium text-rose-700">Nothing will be written until every unresolved instrument or conflict is fixed.</p>}
          </section>

          {preview.trades.length > 0 && <section className="overflow-hidden rounded-2xl border border-slate-200 bg-white">
            <div className="border-b border-slate-200 px-5 py-4"><h2 className="font-semibold text-slate-900">Preview</h2></div>
            <div className="overflow-x-auto"><table className="w-full min-w-[760px] text-sm"><thead><tr className="border-b border-slate-200 text-left text-xs uppercase tracking-wide text-slate-500">
              <th className="px-5 py-3">Date</th><th className="px-5 py-3">Investment</th><th className="px-5 py-3">Type</th><th className="px-5 py-3 text-right">Quantity</th><th className="px-5 py-3 text-right">Broker amount</th><th className="px-5 py-3">Status</th>
            </tr></thead><tbody>{preview.trades.map((trade, index) => <tr key={`${trade.date}-${trade.investmentName}-${index}`} className="border-b border-slate-100 last:border-0">
              <td className="px-5 py-3">{trade.date}</td><td className="px-5 py-3 font-medium text-slate-900">{trade.investmentName}</td><td className="px-5 py-3">{trade.type}</td><td className="px-5 py-3 text-right">{trade.quantity}</td><td className="px-5 py-3 text-right">{trade.amount.toFixed(2)} {trade.currency}</td><td className="px-5 py-3">{trade.status}</td>
            </tr>)}</tbody></table></div>
          </section>}
        </>
      )}
    </div>
  )
}
