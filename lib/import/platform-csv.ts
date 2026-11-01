import { parseCsv } from '@/lib/import/csv'

export type SupportedCsvPlatform = 'trade_republic' | 'degiro' | 'bitvavo' | 'goldrepublic'

export type ParsedBrokerTrade = {
  platform: SupportedCsvPlatform
  source: string
  externalId: string
  sourceDatetime: string | null
  instrumentKey: string
  sourceName: string
  commodityKind: 'gold' | 'silver' | null
  type: 'buy' | 'sell'
  date: string
  quantity: number
  pricePerUnit: number
  amount: number
  fee: number
  priceCurrency: string
  feeCurrency: string
  fxRateToEur: number | null
  grossAmount: number
  netCashAmount: number | null
  amountSemantics: 'gross' | 'net_cash'
  calcMethod: 'source_gross_amount' | 'source_net_cash_amount'
  notes: string
}

export type BrokerCsvResult = {
  trades: ParsedBrokerTrade[]
  sourceRows: number
  ignoredRows: number
  warnings: string[]
}

const number = (value: string | undefined): number | null => {
  if (value === undefined || value.trim() === '') return null
  const n = Number(value.trim().replace(/\s/g, '').replace(',', '.'))
  return Number.isFinite(n) ? n : null
}
const magnitude = (value: string | undefined) => Math.abs(number(value) ?? 0)
const isoFromDutch = (value: string) => {
  const match = /^(\d{2})-(\d{2})-(\d{4})$/.exec(value.trim())
  if (!match) throw new Error(`Invalid DEGIRO date: ${value}`)
  return `${match[3]}-${match[2]}-${match[1]}`
}
const required = (row: Record<string, string>, key: string, rowNumber: number) => {
  const value = row[key]?.trim()
  if (!value) throw new Error(`Row ${rowNumber}: missing ${key}.`)
  return value
}

function tradeRepublic(rows: Record<string, string>[]): BrokerCsvResult {
  const trades: ParsedBrokerTrade[] = []
  let ignoredRows = 0
  for (const [index, row] of rows.entries()) {
    if (row.category !== 'TRADING' || (row.type !== 'BUY' && row.type !== 'SELL')) {
      ignoredRows += 1
      continue
    }
    const rowNumber = index + 2
    const quantity = magnitude(row.shares)
    const price = magnitude(row.price)
    const gross = magnitude(row.amount)
    const fee = magnitude(row.fee)
    const currency = required(row, 'currency', rowNumber).toUpperCase()
    if (!(quantity > 0) || !(price > 0) || !(gross > 0)) throw new Error(`Row ${rowNumber}: invalid trade amount.`)
    trades.push({
      platform: 'trade_republic', source: 'source_migration_trade_republic',
      externalId: required(row, 'transaction_id', rowNumber),
      sourceDatetime: row.datetime?.trim() || null,
      instrumentKey: `ISIN:${required(row, 'symbol', rowNumber)}`,
      sourceName: required(row, 'name', rowNumber), commodityKind: null,
      type: row.type === 'BUY' ? 'buy' : 'sell', date: required(row, 'date', rowNumber),
      quantity, pricePerUnit: price, amount: gross, fee,
      priceCurrency: currency, feeCurrency: currency,
      fxRateToEur: currency === 'EUR' ? 1 : number(row.fx_rate),
      grossAmount: gross,
      netCashAmount: row.type === 'BUY' ? gross + fee : gross - fee,
      amountSemantics: 'gross', calcMethod: 'source_gross_amount',
      notes: row.description?.trim() || `Trade Republic ${row.type.toLowerCase()}`,
    })
  }
  return { trades, sourceRows: rows.length, ignoredRows, warnings: ignoredRows ? [`${ignoredRows} cash/card row(s) were ignored; they are not investment transactions.`] : [] }
}

function degiro(rows: Record<string, string>[]): BrokerCsvResult {
  const trades: ParsedBrokerTrade[] = []
  const warnings: string[] = []
  let ignoredRows = 0
  for (const [index, row] of rows.entries()) {
    const rowNumber = index + 2
    const signedQuantity = number(row.Aantal)
    const price = magnitude(row.Koers)
    if (signedQuantity === null || signedQuantity === 0 || !(price > 0)) {
      ignoredRows += 1
      continue
    }
    const externalId = (row['Order ID'] || row.__column_17 || row['Unnamed: 17'] || '').trim()
    if (!externalId) {
      warnings.push(`Row ${rowNumber} was skipped because DEGIRO did not supply an Order ID.`)
      ignoredRows += 1
      continue
    }
    const priceCurrency = required(row, row.__column_8 !== undefined ? '__column_8' : 'Unnamed: 8', rowNumber).toUpperCase()
    const fx = number(row.Wisselkoers)
    const gross = magnitude(row['Lokale waarde'])
    const fee = magnitude(row['Transactiekosten en/of kosten van derden EUR']) + magnitude(row['AutoFX Kosten'])
    trades.push({
      platform: 'degiro', source: 'source_migration_degiro', externalId,
      sourceDatetime: `${isoFromDutch(required(row, 'Datum', rowNumber))}T${required(row, 'Tijd', rowNumber)}:00`,
      instrumentKey: `ISIN:${required(row, 'ISIN', rowNumber)}`,
      sourceName: required(row, 'Product', rowNumber), commodityKind: null,
      type: signedQuantity > 0 ? 'buy' : 'sell', date: isoFromDutch(row.Datum),
      quantity: Math.abs(signedQuantity), pricePerUnit: price, amount: gross, fee,
      priceCurrency, feeCurrency: 'EUR',
      fxRateToEur: priceCurrency === 'EUR' ? 1 : fx && fx > 0 ? 1 / fx : null,
      grossAmount: gross, netCashAmount: null,
      amountSemantics: 'gross', calcMethod: 'source_gross_amount',
      notes: `DEGIRO order ${externalId}`,
    })
  }
  return { trades, sourceRows: rows.length, ignoredRows, warnings }
}

function bitvavo(rows: Record<string, string>[]): BrokerCsvResult {
  const trades: ParsedBrokerTrade[] = []
  let ignoredRows = 0
  for (const [index, row] of rows.entries()) {
    const kind = row.Type?.toLowerCase()
    if (row.Status !== 'Completed' || (kind !== 'buy' && kind !== 'sell')) {
      ignoredRows += 1
      continue
    }
    const rowNumber = index + 2
    const quantity = magnitude(row.Amount)
    const price = magnitude(row['Quote Price'])
    const netCash = magnitude(row['Received / Paid Amount'])
    const fee = magnitude(row['Fee amount'])
    const currency = required(row, 'Quote Currency', rowNumber).toUpperCase()
    if (!(quantity > 0) || !(price > 0) || !(netCash > 0)) throw new Error(`Row ${rowNumber}: invalid Bitvavo trade.`)
    trades.push({
      platform: 'bitvavo', source: 'source_migration_bitvavo',
      externalId: required(row, 'Transaction ID', rowNumber),
      sourceDatetime: `${required(row, 'Date', rowNumber)}T${required(row, 'Time', rowNumber)}`,
      instrumentKey: `CRYPTO:${required(row, 'Currency', rowNumber).toUpperCase()}`,
      sourceName: required(row, 'Currency', rowNumber).toUpperCase(), commodityKind: null,
      type: kind, date: row.Date, quantity, pricePerUnit: price, amount: netCash, fee,
      priceCurrency: currency, feeCurrency: (row['Fee currency'] || currency).toUpperCase(),
      fxRateToEur: currency === 'EUR' ? 1 : null,
      grossAmount: quantity * price, netCashAmount: netCash,
      amountSemantics: 'net_cash', calcMethod: 'source_net_cash_amount',
      notes: `Bitvavo ${kind} ${row.Currency}`,
    })
  }
  return { trades, sourceRows: rows.length, ignoredRows, warnings: ignoredRows ? [`${ignoredRows} non-trade row(s) were ignored.`] : [] }
}

function goldRepublic(rows: Record<string, string>[]): BrokerCsvResult {
  const trades: ParsedBrokerTrade[] = []
  let ignoredRows = 0
  for (const [index, row] of rows.entries()) {
    const action = row.action?.toLowerCase()
    if (row.status !== 'Processed' || (action !== 'buy' && action !== 'sell')) {
      ignoredRows += 1
      continue
    }
    const rowNumber = index + 2
    const asset = required(row, 'asset', rowNumber).toLowerCase()
    if (asset !== 'gold' && asset !== 'silver') throw new Error(`Row ${rowNumber}: unsupported metal ${row.asset}.`)
    const quantity = magnitude(row.quantity_grams)
    const price = magnitude(row.execution_price_per_kg) / 1000
    const netCash = magnitude(row.total_amount)
    const fee = magnitude(row.transaction_fee)
    const currency = required(row, 'currency', rowNumber).toUpperCase()
    const gross = action === 'buy' ? netCash - fee : netCash + fee
    if (!(quantity > 0) || !(price > 0) || !(netCash > 0) || !(gross > 0)) throw new Error(`Row ${rowNumber}: invalid GoldRepublic order.`)
    trades.push({
      platform: 'goldrepublic', source: 'source_migration_goldrepublic',
      externalId: required(row, 'order_id', rowNumber), sourceDatetime: null,
      instrumentKey: asset === 'gold' ? 'METAL:XAU' : 'METAL:XAG',
      sourceName: asset === 'gold' ? 'Gold' : 'Silver', commodityKind: asset,
      type: action, date: required(row, 'date', rowNumber), quantity,
      pricePerUnit: price, amount: netCash, fee,
      priceCurrency: currency, feeCurrency: currency,
      fxRateToEur: currency === 'EUR' ? 1 : null,
      grossAmount: gross, netCashAmount: netCash,
      amountSemantics: 'net_cash', calcMethod: 'source_net_cash_amount',
      notes: `GoldRepublic ${action} order ${row.order_id} (${row.location || 'location unknown'})`,
    })
  }
  return { trades, sourceRows: rows.length, ignoredRows, warnings: [] }
}

export function parseBrokerCsv(platform: SupportedCsvPlatform, text: string): BrokerCsvResult {
  const rows = parseCsv(text)
  if (rows.length === 0) throw new Error('The CSV contains no data rows.')
  if (platform === 'trade_republic') return tradeRepublic(rows)
  if (platform === 'degiro') return degiro(rows)
  if (platform === 'bitvavo') return bitvavo(rows)
  return goldRepublic(rows)
}
