import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { parseBrokerCsv } from '@/lib/import/platform-csv'

describe('broker CSV parsers', () => {
  test('Trade Republic imports trades and excludes ordinary card cash', () => {
    const csv = `datetime,date,account_type,category,type,asset_class,name,symbol,shares,price,amount,fee,tax,currency,original_amount,original_currency,fx_rate,description,transaction_id,counterparty_name,counterparty_iban,payment_reference,mcc_code
2026-10-29T13:34:00Z,2026-10-29,DEFAULT,TRADING,BUY,STOCK,Alphabet Class C,US02079K1079,1.737405,252.1,-438,-1,,EUR,,,,Buy trade,order-1,,,,
2026-10-29T14:00:00Z,2026-10-29,DEFAULT,CASH,CARD_TRANSACTION,,Shop,,,,,-12,,,EUR,,,,Shop,card-1,,,,5411`
    const parsed = parseBrokerCsv('trade_republic', csv)
    assert.equal(parsed.trades.length, 1)
    assert.equal(parsed.ignoredRows, 1)
    assert.equal(parsed.trades[0].amount, 438)
    assert.equal(parsed.trades[0].fee, 1)
    assert.equal(parsed.trades[0].instrumentKey, 'ISIN:US02079K1079')
  })

  test('DEGIRO converts its quoted FX convention and keeps EUR fees separate', () => {
    const csv = `Datum,Tijd,Product,ISIN,Beurs,Uitvoeringsplaats,Aantal,Koers ,,Lokale waarde,,Waarde EUR,Wisselkoers,AutoFX Kosten,Transactiekosten en/of kosten van derden EUR,Totaal EUR,Order ID,
14-05-2026,18:55,TAKE-TWO INTERACTIVE SOFTWARE INC,US8740541094,NDQ,ARCX,2,240,USD,-480,USD,-411.172656,1.1674,-1.02793164,-2,-414.20058764,order-2`
    const [trade] = parseBrokerCsv('degiro', csv).trades
    assert.equal(trade.type, 'buy')
    assert.ok(Math.abs((trade.fxRateToEur ?? 0) - 1 / 1.1674) < 1e-12)
    assert.ok(Math.abs(trade.fee - 3.02793164) < 1e-12)
  })

  test('DEGIRO accepts exports that put the order ID in the trailing unnamed column', () => {
    const csv = `Datum,Tijd,Product,ISIN,Beurs,Uitvoeringsplaats,Aantal,Koers ,,Lokale waarde,,Waarde EUR,Wisselkoers,AutoFX Kosten,Transactiekosten en/of kosten van derden EUR,Totaal EUR,Order ID,
26-05-2026,15:20,INVESCO EQQQ NASDAQ-100 UCITS ETF ACC,IE00BFZXGZ54,TDG,XGAT,-3,439,EUR,1317,EUR,1317,1,0,-1,1316,,bc3f75e0-9f50-47a4-8cd9-0c2ec6ddaa08`
    const [trade] = parseBrokerCsv('degiro', csv).trades
    assert.equal(trade.externalId, 'bc3f75e0-9f50-47a4-8cd9-0c2ec6ddaa08')
    assert.equal(trade.type, 'sell')
  })

  test('Bitvavo keeps the broker net cash amount and its fee', () => {
    const csv = `Timezone,Date,Time,Type,Currency,Amount,Quote Currency,Quote Price,Received / Paid Currency,Received / Paid Amount,Fee currency,Fee amount,Status,Transaction ID,Address
Europe/Amsterdam,2026-07-21,04:41:27.405,buy,BTC,0.00078493,EUR,57177,EUR,-45,EUR,0.12005739,Completed,id-3,`
    const [trade] = parseBrokerCsv('bitvavo', csv).trades
    assert.equal(trade.amountSemantics, 'net_cash')
    assert.equal(trade.amount, 45)
    assert.equal(trade.fee, 0.12005739)
  })

  test('GoldRepublic stores grams and derives the pre-fee metal value', () => {
    const csv = `order_id,date,action,type,asset,location,quantity_grams,price_per_gram,transaction_fee,execution_price_per_kg,total_amount,currency,status
1549502,2026-05-26,buy,Market,Silver,Zurich,191.941,2.21,3.37,2187.65,425,EUR,Processed`
    const [trade] = parseBrokerCsv('goldrepublic', csv).trades
    assert.equal(trade.commodityKind, 'silver')
    assert.equal(trade.quantity, 191.941)
    assert.equal(trade.pricePerUnit, 2.18765)
    assert.equal(trade.grossAmount, 421.63)
  })
})
