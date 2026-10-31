import type { SupabaseClient } from '@supabase/supabase-js'
import type { CapitalFlowEntry, Investment, Transaction } from '@/types/database'
import { fetchAllInvestments, fetchAllTransactions } from '@/lib/supabase/fetch-user-data'
import { fetchAllRows } from '@/lib/supabase/fetch-all-rows'
import type { FxRates } from '@/lib/domain/fx'
import { hasUnits } from '@/lib/domain/constants'
import { buildExternalCashFlowRows } from '@/lib/domain/contributions'
import {
  classifyReturnFlows,
  summarizeContributions,
  type ContributionSummary,
  type FlowKind,
  type ReturnFlow,
} from '@/lib/domain/flow-classification'
import {
  addDays,
  buildTwrLedger,
  type AccountingTreatment,
  type OfficialAnchor,
  type QualityIssue,
} from '@/lib/domain/twr-ledger'
import { computeTwr, CONTRIBUTION_TOLERANCE, type TwrResult } from '@/lib/domain/twr'
import { allTimeMoneyWeightedReturn, type MoneyWeightedReturn } from '@/lib/domain/returns'
import { buildPositionOverview, type ClosedPositionRow, type OpenPositionRow } from '@/lib/domain/position-overview'
import { fetchEcbFxHistory, fetchPriceHistory } from '@/lib/market/history'
import { computeInvestmentResult, type InvestmentResult } from '@/lib/domain/investment-result'
import {
  computeCurrentValuation,
  endValuesFrom,
  dealerAnchorsFrom,
  type CashPolicy,
  type CurrentOfficialValue,
  type CurrentValuation,
  type CurrentValueQuality,
  type DataGap,
  type FxRow,
} from '@/lib/domain/current-valuation'
import type { BrokerValueObservation, ObservationEvidence, ObservationPriceUnit } from '@/lib/domain/broker-observation'
import { BROKER_CASH_POLICY } from '@/lib/returns/account-decisions'
import type { DealerAnchor } from '@/lib/domain/dealer-anchor'
import type { FxSeries, PriceSeries } from '@/lib/valuation/historical-valuation'

// Everything the Returns page shows — and the headline figures every other
// page shows — computed on the server from the account's records + public
// market history (read-only).
//
// FAIL-CLOSED: a return, XIRR or euro result is only produced when the
// current valuation is complete, every needed price and FX series is there,
// every period ends today without truncation and the figures reconcile.
// Otherwise every gap is listed and the results are null — never a shorter
// period, a partial value or a figure from another engine.

export type PeriodKey = 'ytd' | '1y' | 'all'

export type PeriodReturn = {
  key: PeriodKey
  label: string
  start: string
  twr: TwrResult
  notes: string[]
  qualityIssues: QualityIssue[] // every reason for 'estimated', separately
}

// The figures every page shows in its headline, from ONE place.
export type PortfolioHeadline = {
  asOf: string
  currentValueEur: number | null
  brokerCash: CurrentValuation['brokerCash'] // kept apart or in the value, per the cash policy
  currentValueQuality: CurrentValueQuality | null
  currentValueUnavailableReason: string | null
  costOfOpenPositionsEur: number | null
  previousDayValueEur: number | null
  resultsAvailable: boolean
  resultsUnavailableReason: string | null
  realisedSinceStartEur: number | null
  unrealisedNowEur: number | null
  unrealisedGainsEur: number | null
  unrealisedLossesEur: number | null
  totalResultSinceStartEur: number | null
  realisedYtdEur: number | null
  totalResultYtdEur: number | null
  twrYtd: number | null
  xirrAnnualRate: number | null
  ownContributionsYtdEur: number
  platformContributionsYtdEur: number
  reusedSaleProceedsYtdEur: number
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
  investmentsMeta: Record<string, { name: string; platform: string; type: Investment['type'] }>
  anchorSource: string | null
  dataNotes: string[]
  investmentResult: InvestmentResult | null // null unless every check passes
  // Daily, reconstructed portfolio values from the same Yahoo/ECB series and
  // transaction ledger as the TWR, ending on the current valuation. Empty
  // when the reconstruction is incomplete (never shown as if complete).
  reconstructedHistory: { date: string; valueEur: number }[]
  lastMarketCloseDate: string | null
  valuation: CurrentValuation
  availability: { ok: boolean; gaps: DataGap[] }
  headline: PortfolioHeadline
}

const FLOW_KINDS: FlowKind[] = ['bank_deposit', 'round_up', 'saveback', 'external_reward', 'reused_sale_proceeds', 'withdrawal']
export const MARKET_FETCH_TIMEOUT_MS = 15_000

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

type ObservationRow = {
  investment_id: string
  quantity: number | string
  quantity_unit: BrokerValueObservation['quantityUnit']
  price: number | string
  price_unit: ObservationPriceUnit
  currency: string
  total_value: number | string
  observed_at: string
  source: string
  evidence: ObservationEvidence
}

export type PortfolioRecords = {
  investments: Investment[]
  transactions: Transaction[]
  flows: ReturnFlow[]
  fxRows: FxRow[]
  fxRates: FxRates
  anchor: OfficialAnchor | undefined
  accountingTreatments: AccountingTreatment[]
  officialValues: CurrentOfficialValue[]
  observations: BrokerValueObservation[]
  dealerAnchors: DealerAnchor[]
  cashPolicy: CashPolicy
  dataNotes: string[]
}

export type PortfolioState = PortfolioRecords & { valuation: CurrentValuation }

type Market = { prices: Map<string, PriceSeries>; fx: FxSeries }

function valuePortfolio(r: PortfolioRecords, today: string, now: string, market: Market): CurrentValuation {
  return computeCurrentValuation({
    investments: r.investments, transactions: r.transactions, flows: r.flows, fxRows: r.fxRows, now, today, anchor: r.anchor,
    accountingTreatments: r.accountingTreatments, officialValues: r.officialValues, observations: r.observations,
    prices: market.prices, fx: market.fx, cashPolicy: r.cashPolicy,
  })
}

/**
 * The records + the central current valuation. Only the benchmark closes on
 * the dealer-value dates of metals are fetched (no full history); when they
 * cannot be fetched those metals — and so the total — are unavailable.
 */
export async function loadPortfolioState(
  supabase: SupabaseClient,
  today: string,
  now = new Date().toISOString(),
  // Server jobs with the service role (no RLS) MUST pass the user.
  options: { userId?: string } = {}
): Promise<PortfolioState> {
  const records = await loadPortfolioRecords(supabase, today, now, options.userId)
  const metalIds = new Set(records.dealerAnchors.map((a) => a.investmentId))
  const tickers = records.investments.filter((i) => metalIds.has(i.id) && i.ticker).map((i) => (i.ticker as string).trim())
  const market: Market = { prices: new Map(), fx: {} }
  if (tickers.length) {
    const from = addDays(records.dealerAnchors.map((a) => a.date).sort()[0], -10)
    market.prices = (await fetchPriceHistory(tickers, from, MARKET_FETCH_TIMEOUT_MS)).prices
    const currencies = [...new Set([...market.prices.values()].map((p) => p.currency))].filter((c) => c !== 'EUR')
    try {
      market.fx = await fetchEcbFxHistory(currencies, from, today, MARKET_FETCH_TIMEOUT_MS)
    } catch {
      market.fx = {} // → the anchored metals get a gap in the valuation
    }
  }
  return { ...records, valuation: valuePortfolio(records, today, now, market) }
}

async function loadPortfolioRecords(supabase: SupabaseClient, today: string, now: string, userId?: string): Promise<PortfolioRecords> {
  const yearEnd = `${Number(today.slice(0, 4)) - 1}-12-31`
  const dataNotes: string[] = []
  // Pages rely on RLS; a service-role job scopes every user table explicitly.
  const own = <Q,>(q: Q): Q => (userId ? (q as unknown as { eq: (c: string, v: string) => Q }).eq('user_id', userId) : q)

  const [invRes, txRes, flowRes, fxRes, officialRes, treatmentRes, obsRes] = await Promise.all([
    fetchAllInvestments(supabase, '*', { userId }),
    fetchAllTransactions(supabase, '*', { userId }),
    fetchAllRows<CapitalFlowEntry & { flow_kind?: string | null }>((from, to) =>
      own(supabase.from('capital_flow_entries').select('*')).order('id', { ascending: true }).range(from, to)
        .returns<(CapitalFlowEntry & { flow_kind?: string | null })[]>()
    ),
    supabase.from('fx_rates').select('currency, eur_per_unit, fetched_at').returns<{ currency: string; eur_per_unit: number | string; fetched_at: string | null }[]>(),
    // Exists only after the official-balances migration; any error → no statements.
    own(supabase.from('official_balances').select('*')).returns<OfficialBalanceRow[]>(),
    own(supabase.from('portfolio_accounting_treatments').select('*')).order('effective_date', { ascending: true })
      .returns<AccountingTreatmentRow[]>(),
    // Proposed table (M13); absent → no observations, metals stay on the benchmark.
    own(supabase.from('broker_value_observations').select('*')).returns<ObservationRow[]>(),
  ])
  // A failed read must never become an empty portfolio.
  if (invRes.error) throw new Error(`Failed to load investments: ${invRes.error.message}`)
  if (txRes.error) throw new Error(`Failed to load transactions: ${txRes.error.message}`)
  if (flowRes.error) throw new Error(`Failed to load cash flows: ${(flowRes.error as { message?: string }).message ?? 'unknown error'}`)
  if (fxRes.error) throw new Error(`Failed to load current exchange rates: ${fxRes.error.message}`)
  if (officialRes.error) throw new Error(`Failed to load official balances: ${officialRes.error.message}`)
  if (treatmentRes.error) throw new Error(`Failed to load accounting treatments: ${treatmentRes.error.message}`)
  if (obsRes.error) throw new Error(`Failed to load broker observations: ${obsRes.error.message}`)
  const investments = invRes.data ?? []
  const transactions = txRes.data ?? []
  const capitalFlows = flowRes.data ?? []
  const fxRows: FxRow[] = (fxRes.data ?? []).map((r) => ({ currency: r.currency, eurPerUnit: Number(r.eur_per_unit), fetchedAt: r.fetched_at }))
  const fxRates: FxRates = { EUR: 1, ...Object.fromEntries(fxRows.map((r) => [r.currency, r.eurPerUnit])) }

  const storedTreatments: AccountingTreatment[] = (treatmentRes.data ?? []).map((row): AccountingTreatment | null => {
        if (row.treatment === 'storage_costs_paid_privately') {
          return { kind: row.treatment, platform: row.platform, effectiveDate: row.effective_date, amountEur: null, notes: row.notes }
        }
        const amountEur = Number(row.amount_eur)
        if (!Number.isFinite(amountEur) || amountEur <= 0) return null
        return { kind: row.treatment, platform: row.platform, effectiveDate: row.effective_date, amountEur, notes: row.notes }
      }).filter((row): row is AccountingTreatment => row !== null)
  const officialRows = officialRes.data ?? []
  const anchorRows = officialRows.filter((r) => r.statement_date === yearEnd)
  let anchor: OfficialAnchor | undefined
  if (anchorRows.length) {
    anchor = {
      date: yearEnd,
      positions: anchorRows.filter((r) => r.kind === 'position' && r.investment_id).map((r) => ({
        investmentId: r.investment_id as string, valueEur: Number(r.value_eur),
        quantity: r.quantity == null ? null : Number(r.quantity), source: r.source_document,
      })),
      cash: anchorRows.filter((r) => r.kind === 'cash').map((r) => ({ platform: r.platform, amountEur: Number(r.value_eur), source: r.source_document })),
    }
  } else {
    dataNotes.push(`No official statement values for ${yearEnd} are stored yet: the start value is reconstructed from market closes, and metals are only an estimate.`)
  }
  const officialValues: CurrentOfficialValue[] = officialRows
    .filter((r) => r.kind === 'position' && r.investment_id)
    .map((r) => ({
      investmentId: r.investment_id as string, statementDate: r.statement_date, valueEur: Number(r.value_eur),
      quantity: r.quantity == null ? null : Number(r.quantity), source: r.source_document,
    }))
  const observations: BrokerValueObservation[] = (obsRes.data ?? []).map((r) => ({
    investmentId: r.investment_id, quantity: Number(r.quantity), quantityUnit: r.quantity_unit, price: Number(r.price),
    priceUnit: r.price_unit, currency: r.currency, totalValue: Number(r.total_value), observedAt: r.observed_at,
    source: r.source, evidence: r.evidence,
  }))

  // Owner-reviewed flow kinds (column flow_kind, migration M6) when present.
  const labels: Record<string, FlowKind> = {}
  for (const f of capitalFlows) {
    if (f.flow_kind && (FLOW_KINDS as string[]).includes(f.flow_kind)) labels[f.id] = f.flow_kind as FlowKind
  }
  const ext = buildExternalCashFlowRows(capitalFlows, transactions, fxRates)
  const flows = classifyReturnFlows({ externalRows: [...ext.rows, ...ext.fxMissingRows], transactions, investments, fxRates, labels })

  return {
    investments, transactions, flows, fxRows, fxRates, anchor, accountingTreatments: storedTreatments,
    officialValues, observations, dealerAnchors: dealerAnchorsFrom(investments, officialValues, observations, now),
    cashPolicy: BROKER_CASH_POLICY, dataNotes,
  }
}

const firstReason = (gaps: DataGap[]) => (gaps.length ? gaps[0].reason : null)

// A period that may not be shown: every figure removed, the reason kept.
function blockedTwr(t: TwrResult): TwrResult {
  return {
    ...t, status: 'unavailable', quality: 'unavailable', twr: null, gainEur: null, startValueEur: null, endValueEur: null,
    sumOfContributions: null, residual: null, reconciled: false, daily: [],
  }
}

export async function loadReturns(supabase: SupabaseClient, today: string, options: { now?: string } = {}): Promise<ReturnsData> {
  const year = Number(today.slice(0, 4))
  const yearEnd = `${year - 1}-12-31`
  const now = options.now ?? new Date().toISOString()
  const records = await loadPortfolioRecords(supabase, today, now)
  const { investments, transactions, flows, fxRates, anchor, accountingTreatments, dealerAnchors } = records
  const dataNotes = [...records.dataNotes]
  const gaps: DataGap[] = []
  const addGap = (g: DataGap) => {
    if (!gaps.some((x) => x.source === g.source && x.reason === g.reason)) gaps.push(g)
  }

  const firstDate = [...transactions.map((t) => t.date), ...flows.map((f) => f.date)].sort()[0] ?? today
  const inception = addDays(firstDate, -1)
  const histFrom = addDays(inception, -20)
  const tickers = investments.filter((i) => hasUnits(i.type) && i.ticker).map((i) => (i.ticker as string).trim())
  const { prices, errors } = await fetchPriceHistory(tickers, histFrom, MARKET_FETCH_TIMEOUT_MS)
  for (const [t, e] of Object.entries(errors)) {
    addGap({ source: 'yahoo_history', item: t, requestedFrom: histFrom, requestedTo: today, lastAvailableDate: null, reason: `No price history for ${t} (${e}).` })
  }
  let fx = {}
  const currencies = [...new Set([...prices.values()].map((p) => p.currency))].filter((c) => c !== 'EUR')
  try {
    fx = await fetchEcbFxHistory(currencies, histFrom, today, MARKET_FETCH_TIMEOUT_MS)
  } catch (e) {
    addGap({
      source: 'ecb_fx', item: currencies.join(', ') || 'FX', requestedFrom: histFrom, requestedTo: today, lastAvailableDate: null,
      reason: `No historical exchange rates (${e instanceof Error ? e.message : String(e)}).`,
    })
  }
  // The central valuation on the same market history as the return.
  const valuation = valuePortfolio(records, today, now, { prices, fx })
  for (const g of valuation.gaps) addGap(g)
  const lastMarketCloseDate = [...prices.values()].map((p) => p.closes.at(-1)?.date).filter((d): d is string => !!d).sort().at(-1) ?? null

  const endValues = endValuesFrom(valuation)
  const defs: { key: PeriodKey; label: string; start: string }[] = [
    { key: 'ytd', label: `YTD ${year}`, start: yearEnd },
    { key: '1y', label: '1 year', start: addDays(today, -365) },
    { key: 'all', label: 'Since start', start: inception },
  ]
  const periods: PeriodReturn[] = []
  const ledgers: Record<PeriodKey, ReturnType<typeof buildTwrLedger>> = {} as never
  for (const def of defs) {
    const start = def.start < inception ? inception : def.start
    const ledger = buildTwrLedger({
      investments, transactions, flows, prices, fx, fxRates, startDate: start, endDate: today,
      anchor, accountingTreatments, endValues, dealerAnchors,
    })
    ledgers[def.key] = ledger
    // No truncation: a single missing day makes the period unavailable.
    const twr = computeTwr(ledger.input)
    if (twr.status !== 'ok') {
      const m = twr.missing[0]
      const sleeve = m ? ledger.sleeves[m.sleeve] : undefined
      const item = sleeve?.kind === 'position'
        ? (investments.find((i) => i.id === sleeve.investmentId)?.ticker ?? sleeve.name)
        : sleeve?.name ?? m?.sleeve ?? def.label
      addGap({
        source: 'return_period', item, requestedFrom: start, requestedTo: today,
        lastAvailableDate: m ? addDays(m.date, -1) : null,
        reason: `${def.label}: ${m?.reason ?? 'incomplete data'} (first missing day ${m?.date ?? '—'}).`,
      })
    } else if (twr.endDate !== today) {
      addGap({ source: 'return_period', item: def.label, requestedFrom: start, requestedTo: today, lastAvailableDate: twr.endDate, reason: `${def.label}: the reconstruction ends on ${twr.endDate}, not today.` })
    } else if (twr.residual === null || Math.abs(twr.residual) > CONTRIBUTION_TOLERANCE) {
      addGap({ source: 'consistency', item: def.label, requestedFrom: start, requestedTo: today, lastAvailableDate: null, reason: `${def.label}: the contributions do not add up to the return.` })
    }
    periods.push({
      key: def.key, label: def.label, start, twr, notes: ledger.notes,
      qualityIssues: ledger.qualityIssues.filter((i) => i.from <= twr.endDate),
    })
  }
  const allRaw = periods.find((p) => p.key === 'all')!.twr
  const ytdRaw = periods.find((p) => p.key === 'ytd')!.twr
  // The ledger (positions + broker cash) must end exactly on the central valuation.
  if (allRaw.status === 'ok' && valuation.ledgerTotalEur !== null && Math.abs((allRaw.endValueEur ?? NaN) - valuation.ledgerTotalEur) > 0.005) {
    addGap({
      source: 'consistency', item: 'end value', requestedFrom: null, requestedTo: today, lastAvailableDate: null,
      reason: `The return ends at ${allRaw.endValueEur?.toFixed(2)} EUR but the current valuation is ${valuation.ledgerTotalEur.toFixed(2)} EUR.`,
    })
  }
  // History is shown on the same basis as the current value: with cash kept
  // apart, investment positions only (cash stays in the ledger for the return).
  const shown = (sleeves: { sleeve: string; valueEur: number | null }[]) =>
    sleeves.reduce((t, x) => t + (records.cashPolicy.presentation === 'separate' && x.sleeve.startsWith('cash:') ? 0 : x.valueEur ?? NaN), 0)
  const lastDay = ledgers.all.input.days.at(-1)
  if (allRaw.status === 'ok' && lastDay && valuation.totalEur !== null && Math.abs(shown(lastDay.sleeves) - valuation.totalEur) > 0.005) {
    addGap({
      source: 'consistency', item: 'history', requestedFrom: null, requestedTo: today, lastAvailableDate: null,
      reason: `The last history point (${shown(lastDay.sleeves).toFixed(2)} EUR) differs from the current value (${valuation.totalEur.toFixed(2)} EUR).`,
    })
  }
  let investmentResult: InvestmentResult | null = null
  if (gaps.length === 0) {
    investmentResult = computeInvestmentResult({ investments, transactions, flows, fxRates, periodTwr: ytdRaw, sinceStartTwr: allRaw })
    for (const [label, c] of [[`YTD ${year}`, investmentResult.period], ['Since start', investmentResult.sinceStart]] as const) {
      if (!c.reconciled) {
        addGap({
          source: 'consistency', item: label, requestedFrom: c.from, requestedTo: c.to, lastAvailableDate: null,
          reason: `${label}: the investment result differs ${c.differenceEur.toFixed(2)} EUR from the value change − external cash flow.`,
        })
      }
    }
  }
  const ok = gaps.length === 0
  if (!ok) {
    investmentResult = null
    for (const p of periods) p.twr = blockedTwr(p.twr)
  }

  const ytd = periods.find((p) => p.key === 'ytd')!.twr
  const all = periods.find((p) => p.key === 'all')!.twr
  const rawXirr = allTimeMoneyWeightedReturn(
    flows.filter((f) => f.date <= today).map((f) => ({ date: f.date, amountEur: f.amountEur })),
    ok ? (all.endValueEur ?? NaN) : NaN,
    today
  )
  const xirr: MoneyWeightedReturn = ok ? rawXirr : { ...rawXirr, annualRate: null, unavailableReason: firstReason(gaps) }

  let open: OpenPositionRow[] = []
  let closed: ClosedPositionRow[] = []
  let sleeveNames: Record<string, string> = {}
  if (ok) {
    const overview = buildPositionOverview({ investments, transactions, ledger: ledgers.ytd, twr: ytd, prices, fxRates, periodStart: ytd.startDate, periodEnd: today })
    open = overview.open
    closed = overview.closed
    sleeveNames = Object.fromEntries(Object.entries(ledgers.ytd.sleeves).map(([id, s]) => [id, s.kind === 'cash' ? s.name : `${s.name} (${s.platform})`]))
  }
  const allInput = ledgers.all.input
  const reconstructedHistory = ok
    ? [
        { date: allInput.startDate, valueEur: shown(allInput.startValues) },
        ...allInput.days.map((day) => ({ date: day.date, valueEur: shown(day.sleeves) })),
      ]
    : []
  if (ok) reconstructedHistory[reconstructedHistory.length - 1].valueEur = valuation.totalEur as number

  const contributionsAllTime = summarizeContributions(flows)
  const contributionsYtd = summarizeContributions(flows, `${year}-01-01`, today)
  const r = investmentResult
  const headline: PortfolioHeadline = {
    asOf: today,
    currentValueEur: valuation.totalEur,
    brokerCash: valuation.brokerCash,
    currentValueQuality: valuation.quality,
    currentValueUnavailableReason: valuation.status === 'ok' ? null : firstReason(valuation.gaps),
    costOfOpenPositionsEur: valuation.status === 'ok' ? valuation.costOfOpenPositionsEur : null,
    previousDayValueEur: reconstructedHistory.length >= 2 ? reconstructedHistory[reconstructedHistory.length - 2].valueEur : null,
    resultsAvailable: ok,
    resultsUnavailableReason: firstReason(gaps),
    realisedSinceStartEur: r?.sinceStart.realisedEur ?? null,
    unrealisedNowEur: r?.netUnrealisedEur ?? null,
    unrealisedGainsEur: r?.grossUnrealisedGainsEur ?? null,
    unrealisedLossesEur: r?.grossUnrealisedLossesEur ?? null,
    totalResultSinceStartEur: r?.sinceStart.totalEur ?? null,
    realisedYtdEur: r?.period.realisedEur ?? null,
    totalResultYtdEur: r?.period.totalEur ?? null,
    twrYtd: ok ? ytd.twr : null,
    xirrAnnualRate: xirr.annualRate,
    ownContributionsYtdEur: contributionsYtd.grossOwnContributionsEur,
    platformContributionsYtdEur: contributionsYtd.grossPlatformContributionsEur,
    reusedSaleProceedsYtdEur: contributionsYtd.reusedSaleProceedsEur,
  }

  return {
    endDate: today,
    periods,
    xirr,
    contributionsAllTime,
    contributionsYtd,
    open,
    closed,
    ytd,
    sleeveNames,
    investmentsMeta: Object.fromEntries(investments.map((i) => [i.id, { name: i.name, platform: i.platform, type: i.type }])),
    anchorSource: anchor ? [...new Set([...anchor.positions.map((p) => p.source), ...anchor.cash.map((c) => c.source)])].join(', ') : null,
    dataNotes,
    investmentResult,
    reconstructedHistory,
    lastMarketCloseDate,
    valuation,
    availability: { ok, gaps },
    headline,
  }
}
