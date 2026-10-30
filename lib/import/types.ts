// Canonical, platform-independent records produced by a platform parser from
// an ORIGINAL broker export. The importer never reads the old database and
// never reads estimated sources (e.g. *_even_monthly_* capital flows).

export type PlatformCode = 'degiro' | 'trade_republic' | 'bitvavo' | 'goldrepublic' | 'holland_gold'

export type ImportFlowKind =
  | 'bank_deposit'
  | 'bank_withdrawal'
  | 'savings_plan'
  | 'saveback'
  | 'round_up'
  | 'order_payment'
  | 'sale_payout'
  | 'other'
  | 'pending_classification'

/** A source file as read from disk; its hash is stored on the import run. */
export type SourceFile = { name: string; sha256: string; rows: number }

/** One position (account × instrument) the import expects to exist. */
export type ImportPosition = {
  platform: PlatformCode
  // Stable instrument key: 'ISIN:IE00B4L5Y983' | 'METAL:XAU' | 'CRYPTO:BTC'.
  instrumentKey: string
  name: string
  type: 'stock' | 'ETF' | 'crypto' | 'commodity'
  currency: string // ISO 4217, the instrument's quote currency
  quantityUnit: 'unit' | 'gram' | 'troy_ounce'
}

export type ImportTransaction = {
  platform: PlatformCode
  source: string        // e.g. 'degiro_transactions_csv'
  externalId: string    // stable id from the source (see source-id.ts)
  sourceDatetime: string | null // full ISO instant when the export has one
  instrumentKey: string
  type: 'buy' | 'sell' | 'dividend' | 'interest' | 'fee'
  date: string          // 'YYYY-MM-DD'
  quantity: number | null
  pricePerUnit: number | null
  amount: number | null
  fee: number
  priceCurrency: string
  feeCurrency: string
  fxRateToEur: number | null // required for non-EUR price currencies
  orderGroupId: string | null // groups fills of one economic order
  isContribution: false // imports never flag contributions (capital flows do)
}

export type ImportCapitalFlow = {
  platform: PlatformCode
  source: string
  externalId: string
  sourceDatetime: string | null
  date: string
  direction: 'to_portfolio' | 'from_portfolio'
  amountEur: number
  flowKind: ImportFlowKind
}

/** Verified end position from the platform's own statement/overview. */
export type ExpectedPosition = {
  platform: PlatformCode
  instrumentKey: string
  quantity: number
  tolerance?: number // absolute; default 1e-9
}

export type ImportBatch = {
  files: SourceFile[]
  positions: ImportPosition[]
  transactions: ImportTransaction[]
  capitalFlows: ImportCapitalFlow[]
  expectedPositions: ExpectedPosition[]
  // Verified per-platform totals the dry run must reproduce exactly.
  expectedCounts?: Partial<Record<PlatformCode, { transactions?: number; capitalFlows?: number }>>
}
