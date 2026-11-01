import Link from 'next/link'
import { createClient } from '@/lib/supabase/server'
import { fetchAllInvestments, fetchAllTransactions } from '@/lib/supabase/fetch-user-data'
import { fetchAllRows } from '@/lib/supabase/fetch-all-rows'
import { PageHeader } from '@/components/ui/page-header'
import { fmtDate } from '@/lib/format'
import { todayLocalIso } from '@/lib/domain/snapshot'

type OfficialBalanceRow = {
  platform: string
  statement_date: string
  kind: 'cash' | 'position'
  source_document: string
}

type ImportRunRow = {
  id: string
  importer: string
  status: 'started' | 'succeeded' | 'failed'
  started_at: string
  finished_at: string | null
  input_files: { name?: string; rows?: number }[]
  error: string | null
}

export default async function DataQualityPage() {
  const supabase = await createClient()
  const [investmentRes, transactionRes, balanceRes, importRes] = await Promise.all([
    fetchAllInvestments(supabase),
    fetchAllTransactions(supabase),
    fetchAllRows<OfficialBalanceRow>((from, to) =>
      supabase.from('official_balances')
        .select('platform, statement_date, kind, source_document')
        .order('statement_date', { ascending: false })
        .order('id', { ascending: true })
        .range(from, to)
        .returns<OfficialBalanceRow[]>()
    ),
    fetchAllRows<ImportRunRow>((from, to) =>
      supabase.from('import_runs')
        .select('id, importer, status, started_at, finished_at, input_files, error')
        .order('started_at', { ascending: false })
        .order('id', { ascending: false })
        .range(from, to)
        .returns<ImportRunRow[]>()
    ),
  ])

  const errors = [investmentRes.error, transactionRes.error, balanceRes.error, importRes.error].filter(Boolean)
  const investments = investmentRes.data ?? []
  const transactions = transactionRes.data ?? []
  const balances = balanceRes.data ?? []
  const imports = importRes.data ?? []
  const platforms = [...new Set([
    ...investments.map((investment) => investment.platform),
    ...balances.map((balance) => balance.platform),
  ])].sort((a, b) => a.localeCompare(b))
  const currentYear = Number(todayLocalIso().slice(0, 4))

  const duplicateSourceKeys = (() => {
    const seen = new Set<string>()
    let duplicates = 0
    for (const transaction of transactions) {
      if (!transaction.source || !transaction.external_id) continue
      const key = `${transaction.source}|${transaction.external_id}`
      if (seen.has(key)) duplicates += 1
      seen.add(key)
    }
    return duplicates
  })()

  return (
    <div className="space-y-6">
      <PageHeader
        title="Data checks"
        subtitle="A practical check of source coverage, duplicate protection and annual broker statements."
        action={
          <div className="flex flex-wrap gap-2">
            <Link href="/transactions/new" className="rounded-lg border border-slate-300 bg-white px-4 py-2 text-sm font-medium text-slate-700 hover:bg-slate-50">
              Add transaction
            </Link>
            <Link href="/contributions/new" className="rounded-lg bg-slate-900 px-4 py-2 text-sm font-medium text-white hover:bg-slate-800">
              Add money in or out
            </Link>
          </div>
        }
      />

      {errors.length > 0 && (
        <div className="rounded-2xl border border-rose-200 bg-rose-50 p-5 text-sm text-rose-800">
          One or more checks could not be loaded. No result below should be treated as complete.
        </div>
      )}

      <div className="grid gap-4 sm:grid-cols-3">
        <div className="rounded-2xl border border-slate-200 bg-white p-5">
          <p className="text-xs font-medium uppercase tracking-wide text-slate-500">Transactions</p>
          <p className="mt-2 text-2xl font-semibold text-slate-900">{transactions.length}</p>
          <p className="mt-1 text-sm text-slate-500">Across {investments.length} investment positions.</p>
        </div>
        <div className="rounded-2xl border border-slate-200 bg-white p-5">
          <p className="text-xs font-medium uppercase tracking-wide text-slate-500">Duplicate source keys</p>
          <p className={`mt-2 text-2xl font-semibold ${duplicateSourceKeys === 0 ? 'text-emerald-700' : 'text-rose-700'}`}>
            {duplicateSourceKeys}
          </p>
          <p className="mt-1 text-sm text-slate-500">A repeated import must not create a second row.</p>
        </div>
        <div className="rounded-2xl border border-slate-200 bg-white p-5">
          <p className="text-xs font-medium uppercase tracking-wide text-slate-500">Recorded imports</p>
          <p className="mt-2 text-2xl font-semibold text-slate-900">{imports.length}</p>
          <p className="mt-1 text-sm text-slate-500">Future file imports will be listed here.</p>
        </div>
      </div>

      <section className="overflow-hidden rounded-2xl border border-slate-200 bg-white">
        <div className="border-b border-slate-200 px-5 py-4">
          <h2 className="font-semibold text-slate-900">Broker coverage</h2>
          <p className="mt-1 text-sm text-slate-500">Use the broker statement once a year to confirm the calculated end positions.</p>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full min-w-[760px] text-sm">
            <thead>
              <tr className="border-b border-slate-200 text-left text-xs uppercase tracking-wide text-slate-500">
                <th className="px-5 py-3 font-medium">Platform</th>
                <th className="px-5 py-3 font-medium text-right">Positions</th>
                <th className="px-5 py-3 font-medium text-right">Transactions</th>
                <th className="px-5 py-3 font-medium">Latest transaction</th>
                <th className="px-5 py-3 font-medium">Latest official statement</th>
                <th className="px-5 py-3 font-medium">Check</th>
              </tr>
            </thead>
            <tbody>
              {platforms.map((platform) => {
                const platformInvestments = investments.filter((investment) => investment.platform === platform)
                const ids = new Set(platformInvestments.map((investment) => investment.id))
                const platformTransactions = transactions.filter((transaction) => ids.has(transaction.investment_id))
                const latestTransaction = platformTransactions.reduce<string | null>(
                  (latest, transaction) => latest === null || transaction.date > latest ? transaction.date : latest,
                  null
                )
                const latestStatement = balances
                  .filter((balance) => balance.platform === platform)
                  .sort((a, b) => b.statement_date.localeCompare(a.statement_date))[0]
                const missingSource = platformTransactions.filter((transaction) => !transaction.source || !transaction.external_id).length
                const statementCurrent = latestStatement && Number(latestStatement.statement_date.slice(0, 4)) >= currentYear - 1
                const label = duplicateSourceKeys > 0
                  ? 'Duplicate found'
                  : missingSource > 0
                    ? `${missingSource} manual row${missingSource === 1 ? '' : 's'}`
                    : statementCurrent
                      ? 'Source-backed'
                      : 'Statement due'
                const tone = duplicateSourceKeys > 0 ? 'text-rose-700 bg-rose-50' : missingSource > 0 || !statementCurrent ? 'text-amber-800 bg-amber-50' : 'text-emerald-700 bg-emerald-50'
                return (
                  <tr key={platform} className="border-b border-slate-100 last:border-0">
                    <td className="px-5 py-4 font-medium text-slate-900">{platform}</td>
                    <td className="px-5 py-4 text-right text-slate-700">{platformInvestments.length}</td>
                    <td className="px-5 py-4 text-right text-slate-700">{platformTransactions.length}</td>
                    <td className="px-5 py-4 text-slate-700">{latestTransaction ? fmtDate(latestTransaction) : '—'}</td>
                    <td className="px-5 py-4 text-slate-700">
                      {latestStatement ? (
                        <>
                          {fmtDate(latestStatement.statement_date)}
                          <span className="block max-w-[240px] truncate text-xs text-slate-400">{latestStatement.source_document}</span>
                        </>
                      ) : '—'}
                    </td>
                    <td className="px-5 py-4">
                      <span className={`inline-flex rounded-full px-2.5 py-1 text-xs font-medium ${tone}`}>{label}</span>
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      </section>

      <section className="rounded-2xl border border-slate-200 bg-white p-5">
        <h2 className="font-semibold text-slate-900">How to keep this reliable</h2>
        <ol className="mt-3 space-y-2 text-sm text-slate-600">
          <li><span className="font-medium text-slate-800">1.</span> Add every buy and sell with its broker transaction ID. A repeated ID is rejected.</li>
          <li><span className="font-medium text-slate-800">2.</span> Record money entering or leaving the investment portfolio under Contributions. A sale followed by another purchase is not a new contribution.</li>
          <li><span className="font-medium text-slate-800">3.</span> Once a year, compare each broker statement with the calculated quantities and keep the statement as the control source.</li>
        </ol>
      </section>

      {imports.length > 0 && (
        <section className="overflow-hidden rounded-2xl border border-slate-200 bg-white">
          <div className="border-b border-slate-200 px-5 py-4">
            <h2 className="font-semibold text-slate-900">Recent imports</h2>
          </div>
          <ul className="divide-y divide-slate-100">
            {imports.slice(0, 10).map((run) => (
              <li key={run.id} className="flex flex-wrap items-center justify-between gap-3 px-5 py-4 text-sm">
                <div>
                  <p className="font-medium text-slate-900">{run.importer}</p>
                  <p className="text-slate-500">{new Date(run.started_at).toLocaleString('en-GB')}</p>
                </div>
                <span className={run.status === 'succeeded' ? 'text-emerald-700' : run.status === 'failed' ? 'text-rose-700' : 'text-amber-700'}>
                  {run.status}
                </span>
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  )
}
