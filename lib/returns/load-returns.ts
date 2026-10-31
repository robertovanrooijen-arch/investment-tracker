import type { SupabaseClient } from '@supabase/supabase-js'
import type { CapitalFlowEntry } from '@/types/database'
import { fetchAllInvestments, fetchAllTransactions } from '@/lib/supabase/fetch-user-data'
import { fetchAllRows } from '@/lib/supabase/fetch-all-rows'
import { loadFxRates } from '@/lib/domain/fx'
import { hasUnits } from '@/lib/domain/constants'
import { buildExternalCashFlowRows } from '@/lib/domain/contributions'
import {
  classifyReturnFlows,
  summarizeContributions,
  type ContributionSummary,
  type FlowKind,
} from '@/lib/domain/flow-classification'
import {
  addDays,
  buildTwrLedger,
  type AccountingTreatment,
  type OfficialAnchor,
  type QualityIssue,
} from '@/lib/domain/twr-ledger'
import { computeTwr, type TwrResult } from '@/lib/domain/twr'
import { allTimeMoneyWeightedReturn, modifiedDietz, type MoneyWeightedReturn } from '@/lib/domain/returns'
import { buildPositionOverview, type ClosedPositionRow, type OpenPositionRow } from '@/lib/domain/position-overview'
import { fetchEcbFxHistory, fetchPriceHistory } from '@/lib/market/history'

// Everything the Returns page shows, computed on the server from the
// account's records + public market history (read-only).

export type PeriodKey = 'ytd' | '1y' | 'all'

export type PeriodReturn = {
  key: PeriodKey
  label: string
  start: string
  twr: TwrResult
  // Modified Dietz only as a labelled ESTIMATE when no TWR can be computed.
  modifiedDietzEstimate: number | null
  notes: string[]
  qualityIssues: QualityIssue[] // every reason for 'estimated', separately
}

export type ReturnsData = {
  endDate: string
  periods: PeriodReturn[]
  xirr: MoneyWeightedReturn
  contributionsAllTime: ContributionSummary
  contributionsYtd: ContributionSummary
  open: OpenPositionRow[]
  closed: ClosedPositionRow[]
  ytd: TwrResult
  sleeveNames: Record<string, string>
  anchorSource: string | null
  dataNotes: string[]
}

const FLOW_KINDS: FlowKind[] = ['bank_deposit', 'round_up', 'saveback', 'external_reward', 'reused_sale_proceeds', 'withdrawal']

type OfficialBalanceRow = {
  statement_date: string
  platform: string
  kind: 'cash' | 'position'
  investment_id: string | null
  quantity: number | string | null
  value_eur: number | string
  source_document: string
}

type AccountingTreatmentRow = {
  platform: string
  treatment: AccountingTreatment['kind']
  effective_date: string
  amount_eur: number | string | null
  notes: string
}

export async function loadReturns(supabase: SupabaseClient, today: string): Promise<ReturnsData> {
  const year = Number(today.slice(0, 4))
  const yearEnd = `${year - 1}-12-31`
  const dataNotes: string[] = []

  const [invRes, txRes, flowRes, fxRes, officialRes, treatmentRes] = await Promise.all([
    fetchAllInvestments(supabase),
    fetchAllTransactions(supabase),
    fetchAllRows<CapitalFlowEntry & { flow_kind?: string | null }>((from, to) =>
      supabase.from('capital_flow_entries').select('*').order('id', { ascending: true }).range(from, to)
        .returns<(CapitalFlowEntry & { flow_kind?: string | null })[]>()
    ),
    loadFxRates(supabase),
    // Exists only after the official-balances migration; any error → no anchor.
    supabase.from('official_balances').select('*').eq('statement_date', yearEnd).returns<OfficialBalanceRow[]>(),
    supabase.from('portfolio_accounting_treatments').select('*').order('effective_date', { ascending: true })
      .returns<AccountingTreatmentRow[]>(),
  ])
  if (invRes.error || txRes.error || flowRes.error) {
    throw new Error('Could not load your investments, transactions or cash flows.')
  }
  const investments = invRes.data ?? []
  const transactions = txRes.data ?? []
  const capitalFlows = flowRes.data ?? []
  const fxRates = fxRes.rates
  const accountingTreatments: AccountingTreatment[] = treatmentRes.error
    ? []
    : (treatmentRes.data ?? []).map((row): AccountingTreatment | null => {
        if (row.treatment === 'storage_costs_paid_privately') {
          return {
            kind: row.treatment,
            platform: row.platform,
            effectiveDate: row.effective_date,
            amountEur: null,
            notes: row.notes,
          }
        }
        const amountEur = Number(row.amount_eur)
        if (!Number.isFinite(amountEur) || amountEur <= 0) return null
        return {
          kind: row.treatment,
          platform: row.platform,
          effectiveDate: row.effective_date,
          amountEur,
          notes: row.notes,
        }
      }).filter((row): row is AccountingTreatment => row !== null)
  if (treatmentRes.error) {
    dataNotes.push('Accounting treatments could not be loaded; no owner-approved reconciliations were applied.')
  }

  let anchor: OfficialAnchor | undefined
  if (!officialRes.error && officialRes.data?.length) {
    anchor = {
      date: yearEnd,
      positions: officialRes.data.filter((r) => r.kind === 'position' && r.investment_id).map((r) => ({
        investmentId: r.investment_id as string, valueEur: Number(r.value_eur),
        quantity: r.quantity == null ? null : Number(r.quantity), source: r.source_document,
      })),
      cash: officialRes.data.filter((r) => r.kind === 'cash').map((r) => ({ platform: r.platform, amountEur: Number(r.value_eur), source: r.source_document })),
    }
  } else {
    dataNotes.push(`No official statement values for ${yearEnd} are stored yet: the start value is reconstructed from market closes, and metals are only an estimate.`)
  }

  // Owner-reviewed flow kinds (column flow_kind, migration M6) when present.
  const labels: Record<string, FlowKind> = {}
  for (const f of capitalFlows) {
    if (f.flow_kind && (FLOW_KINDS as string[]).includes(f.flow_kind)) labels[f.id] = f.flow_kind as FlowKind
  }
  const ext = buildExternalCashFlowRows(capitalFlows, transactions, fxRates)
  const flows = classifyReturnFlows({ externalRows: [...ext.rows, ...ext.fxMissingRows], transactions, investments, fxRates, labels })

  const firstDate = [...transactions.map((t) => t.date), ...flows.map((f) => f.date)].sort()[0] ?? today
  const inception = addDays(firstDate, -1)
  const histFrom = addDays(inception, -20)
  const tickers = investments.filter((i) => hasUnits(i.type) && i.ticker).map((i) => (i.ticker as string).trim())
  const { prices, errors } = await fetchPriceHistory(tickers, histFrom)
  for (const [t, e] of Object.entries(errors)) dataNotes.push(`No price history for ${t} (${e}).`)
  let fx = {}
  try {
    fx = await fetchEcbFxHistory([...new Set([...prices.values()].map((p) => p.currency))], histFrom, today)
  } catch (e) {
    dataNotes.push(`No historical exchange rates (${e instanceof Error ? e.message : String(e)}).`)
  }
  const liveQuotes = new Map(
    investments
      .filter((i) => i.current_price != null && i.price_last_updated_at)
      .map((i) => [i.id, { price: Number(i.current_price), currency: i.currency ?? 'EUR', asOf: i.price_last_updated_at as string }])
  )

  const defs: { key: PeriodKey; label: string; start: string }[] = [
    { key: 'ytd', label: `YTD ${year}`, start: yearEnd },
    { key: '1y', label: '1 year', start: addDays(today, -365) },
    { key: 'all', label: 'Since start', start: inception },
  ]
  const periods: PeriodReturn[] = []
  let ytdOverview: { open: OpenPositionRow[]; closed: ClosedPositionRow[] } = { open: [], closed: [] }
  let sleeveNames: Record<string, string> = {}
  for (const def of defs) {
    const start = def.start < inception ? inception : def.start
    const ledger = buildTwrLedger({
      investments, transactions, flows, prices, fx, fxRates, startDate: start, endDate: today,
      anchor, accountingTreatments, liveQuotes,
    })
    const twr = computeTwr(ledger.input, { allowTruncation: true })
    let estimate: number | null = null
    if (twr.status !== 'ok' && twr.startValueEur !== null) {
      const inPeriod = flows.filter((f) => f.date > start && f.date <= today).map((f) => ({ date: f.date, amountEur: f.amountEur }))
      const md = modifiedDietz(twr.startValueEur, twr.endValueEur ?? NaN, inPeriod, start, today)
      estimate = md.returnPercent === null ? null : md.returnPercent / 100
    }
    periods.push({
      key: def.key, label: def.label, start, twr, modifiedDietzEstimate: estimate, notes: ledger.notes,
      qualityIssues: ledger.qualityIssues.filter((i) => i.from <= twr.endDate),
    })
    if (def.key === 'ytd') {
      ytdOverview = buildPositionOverview({ investments, transactions, ledger, twr, prices, fxRates, periodStart: start, periodEnd: today })
      sleeveNames = Object.fromEntries(Object.entries(ledger.sleeves).map(([id, s]) => [id, s.kind === 'cash' ? s.name : `${s.name} (${s.platform})`]))
    }
  }
  const all = periods.find((p) => p.key === 'all')!.twr
  const xirr = allTimeMoneyWeightedReturn(
    flows.filter((f) => f.date <= all.endDate).map((f) => ({ date: f.date, amountEur: f.amountEur })),
    all.endValueEur ?? NaN,
    all.endDate
  )
  const ytd = periods.find((p) => p.key === 'ytd')!.twr
  return {
    endDate: today,
    periods,
    xirr,
    contributionsAllTime: summarizeContributions(flows),
    contributionsYtd: summarizeContributions(flows, `${year}-01-01`, today),
    open: ytdOverview.open,
    closed: ytdOverview.closed,
    ytd,
    sleeveNames,
    anchorSource: anchor ? [...new Set([...anchor.positions.map((p) => p.source), ...anchor.cash.map((c) => c.source)])].join(', ') : null,
    dataNotes,
  }
}
