import type { Investment } from '@/types/database'
import type { ParsedBrokerTrade, SupportedCsvPlatform } from '@/lib/import/platform-csv'

const PLATFORM_NAMES: Record<SupportedCsvPlatform, string[]> = {
  trade_republic: ['trade republic'],
  degiro: ['degiro', 'degiro flatex'],
  bitvavo: ['bitvavo'],
  goldrepublic: ['goldrepublic', 'gold republic'],
}

const STOP_WORDS = new Set([
  'inc', 'incorporated', 'nv', 'plc', 'class', 'usd', 'eur', 'acc', 'dis',
  'ucits', 'the', 'eo', 'dl', 'inh', 'holdings', 'holding',
])

function words(value: string): string[] {
  return value.toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .split(/\s+/)
    .filter((word) => word && !STOP_WORDS.has(word))
    .map((word) => {
      if (word === 'semiconductors') return 'semiconductor'
      if (word === 'industries') return 'industry'
      return word
    })
}

function nameScore(source: string, target: string): number {
  const a = new Set(words(source))
  const b = new Set(words(target))
  if (a.size === 0 || b.size === 0) return 0
  let overlap = 0
  for (const word of a) if (b.has(word)) overlap += 1
  return overlap / Math.min(a.size, b.size)
}

function platformMatches(code: SupportedCsvPlatform, platform: string): boolean {
  const normalized = platform.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim()
  return PLATFORM_NAMES[code].includes(normalized)
}

export type InvestmentResolution =
  | { ok: true; investment: Investment; score: number }
  | { ok: false; reason: string; candidates: { id: string; name: string; score: number }[] }

/** Resolves only when the source identifies exactly one safe existing position. */
export function resolveInvestmentForTrade(trade: ParsedBrokerTrade, investments: Investment[]): InvestmentResolution {
  const platform = investments.filter((investment) => platformMatches(trade.platform, investment.platform))
  if (trade.commodityKind) {
    const exact = platform.filter((investment) => investment.commodity_kind === trade.commodityKind)
    if (exact.length === 1) return { ok: true, investment: exact[0], score: 1 }
  }
  if (trade.instrumentKey.startsWith('CRYPTO:')) {
    const symbol = trade.instrumentKey.slice('CRYPTO:'.length)
    const exact = platform.filter((investment) => investment.ticker?.toUpperCase().startsWith(`${symbol}-`) || investment.name.toUpperCase() === symbol)
    if (exact.length === 1) return { ok: true, investment: exact[0], score: 1 }
  }
  const scored = platform.map((investment) => ({ investment, score: nameScore(trade.sourceName, investment.name) }))
    .sort((a, b) => b.score - a.score || a.investment.id.localeCompare(b.investment.id))
  const best = scored[0]
  const second = scored[1]
  if (best && best.score >= 0.66 && (!second || best.score - second.score >= 0.15)) {
    return { ok: true, investment: best.investment, score: best.score }
  }
  return {
    ok: false,
    reason: platform.length === 0 ? `No ${trade.platform} investment exists yet.` : `No unique existing investment matches "${trade.sourceName}". Create or rename the position first.`,
    candidates: scored.slice(0, 3).map(({ investment, score }) => ({ id: investment.id, name: investment.name, score })),
  }
}

export type TradeImportRow = {
  investment_id: string; type: 'buy' | 'sell'; quantity: number; price_per_unit: number
  amount: number; fee: number; date: string; notes: string; price_currency: string
  fee_currency: string; fx_rate_to_eur: number | null; source: string; external_id: string
  source_datetime: string | null; order_group_id: null; amount_semantics: 'gross' | 'net_cash'
  gross_amount: number; net_cash_amount: number | null; fx_rate_date: string | null
  amount_quality: 'exact'; calc_method: 'source_gross_amount' | 'source_net_cash_amount'; value_date: null
}

export function toTradeImportRow(trade: ParsedBrokerTrade, investmentId: string): TradeImportRow {
  return {
    investment_id: investmentId, type: trade.type, quantity: trade.quantity,
    price_per_unit: trade.pricePerUnit, amount: trade.amount, fee: trade.fee,
    date: trade.date, notes: trade.notes, price_currency: trade.priceCurrency,
    fee_currency: trade.feeCurrency, fx_rate_to_eur: trade.fxRateToEur,
    source: trade.source, external_id: trade.externalId, source_datetime: trade.sourceDatetime,
    order_group_id: null, amount_semantics: trade.amountSemantics,
    gross_amount: trade.grossAmount, net_cash_amount: trade.netCashAmount,
    fx_rate_date: trade.fxRateToEur === null ? null : trade.date,
    amount_quality: 'exact', calc_method: trade.calcMethod, value_date: null,
  }
}
