import { createHash } from 'node:crypto'
import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { createAdminClient } from '@/lib/supabase/admin'
import { fetchAllInvestments, fetchAllTransactions } from '@/lib/supabase/fetch-user-data'
import { parseBrokerCsv, type SupportedCsvPlatform } from '@/lib/import/platform-csv'
import { resolveInvestmentForTrade, toTradeImportRow, type TradeImportRow } from '@/lib/import/resolve-investments'
import type { Transaction } from '@/types/database'

const SUPPORTED = new Set<SupportedCsvPlatform>(['trade_republic', 'degiro', 'bitvavo', 'goldrepublic'])
function sameNumber(a: number | null | undefined, b: number | null | undefined, tolerance = 1e-8) {
  if (a == null || b == null) return a == null && b == null
  return Math.abs(Number(a) - Number(b)) <= tolerance
}
function sameTrade(existing: Transaction, row: TradeImportRow): boolean {
  return existing.investment_id === row.investment_id && existing.type === row.type && existing.date === row.date
    && sameNumber(existing.quantity, row.quantity) && sameNumber(existing.price_per_unit, row.price_per_unit)
    && sameNumber(existing.amount, row.amount) && sameNumber(existing.fee, row.fee)
    && (existing.price_currency ?? 'EUR') === row.price_currency
    && (existing.fee_currency ?? existing.price_currency ?? 'EUR') === row.fee_currency
    && sameNumber(existing.fx_rate_to_eur, row.fx_rate_to_eur)
}

export async function POST(request: Request) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Not signed in.' }, { status: 401 })
  const form = await request.formData()
  const file = form.get('file')
  const platform = String(form.get('platform') ?? '') as SupportedCsvPlatform
  const mode = String(form.get('mode') ?? 'preview')
  if (!(file instanceof File)) return NextResponse.json({ error: 'Choose a CSV file.' }, { status: 400 })
  if (!SUPPORTED.has(platform)) return NextResponse.json({ error: 'Unsupported platform.' }, { status: 400 })
  if (mode !== 'preview' && mode !== 'apply') return NextResponse.json({ error: 'Invalid import mode.' }, { status: 400 })
  if (file.size > 10 * 1024 * 1024) return NextResponse.json({ error: 'CSV is larger than 10 MB.' }, { status: 400 })
  try {
    const text = await file.text()
    const [investmentRes, transactionRes] = await Promise.all([fetchAllInvestments(supabase), fetchAllTransactions(supabase)])
    if (investmentRes.error) throw new Error(`Could not load investments: ${investmentRes.error.message}`)
    if (transactionRes.error) throw new Error(`Could not load transactions: ${transactionRes.error.message}`)
    const parsed = parseBrokerCsv(platform, text)
    const unresolved: { instrumentKey: string; name: string; reason: string }[] = []
    const resolved = parsed.trades.flatMap((trade) => {
      const match = resolveInvestmentForTrade(trade, investmentRes.data ?? [])
      if (!match.ok) {
        unresolved.push({ instrumentKey: trade.instrumentKey, name: trade.sourceName, reason: match.reason })
        return []
      }
      return [{ trade, investment: match.investment, row: toTradeImportRow(trade, match.investment.id) }]
    })
    const existing = transactionRes.data ?? []
    const byKey = new Map(existing.filter((tx) => tx.source && tx.external_id).map((tx) => [`${tx.source}|${tx.external_id}`, tx]))
    const conflicts: string[] = []
    let alreadyPresent = 0
    const ready = resolved.filter(({ row }) => {
      const current = byKey.get(`${row.source}|${row.external_id}`)
      if (!current) return true
      if (sameTrade(current, row)) { alreadyPresent += 1; return false }
      conflicts.push(`${row.date} ${row.external_id}: the existing source key has different content.`)
      return false
    })
    const uniqueUnresolved = [...new Map(unresolved.map((item) => [item.instrumentKey, item])).values()]
    const canApply = ready.length > 0 && uniqueUnresolved.length === 0 && conflicts.length === 0
    const preview = {
      file: { name: file.name, rows: parsed.sourceRows, sha256: createHash('sha256').update(text).digest('hex') },
      summary: { sourceRows: parsed.sourceRows, tradesFound: parsed.trades.length, ready: ready.length, alreadyPresent, ignoredRows: parsed.ignoredRows, unresolvedInstruments: uniqueUnresolved.length, conflicts: conflicts.length },
      warnings: parsed.warnings, unresolved: uniqueUnresolved, conflicts, canApply,
      trades: resolved.slice(0, 50).map(({ trade, investment, row }) => ({
        date: row.date, type: row.type, sourceName: trade.sourceName, investmentName: investment.name,
        quantity: row.quantity, amount: row.amount, currency: row.price_currency,
        status: byKey.has(`${row.source}|${row.external_id}`) ? 'already present' : 'new',
      })),
    }
    if (mode === 'preview') return NextResponse.json(preview)
    if (!canApply) return NextResponse.json({ error: 'Import is blocked until every instrument and conflict is resolved.', ...preview }, { status: 409 })
    const { data, error } = await createAdminClient().rpc('apply_trade_import_atomic', {
      p_user_id: user.id, p_importer: `${platform}_csv`, p_input_files: [preview.file],
      p_rows: resolved.map(({ row }) => row),
    })
    if (error) throw new Error(error.message)
    return NextResponse.json({ ...preview, applied: data })
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : 'Import failed.' }, { status: 400 })
  }
}
