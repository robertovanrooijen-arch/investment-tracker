// Trade Republic funding ledger (pure; never writes anything).
//
// Trade Republic is both a broker and a current account (card payments,
// transfers). To decide which part of each purchase is NEW external money,
// the importer replays the TR cash account in a hidden ledger. Card payments
// and ordinary bank traffic are used for that classification only — they
// never become investment transactions or contributions in the UI.
//
// The ledger keeps three internal pools (all in integer cents):
//   external — money transferred in from the bank and not yet invested;
//   reinvest — money that already belongs to the portfolio: net sale proceeds
//              and realized returns (TR interest, referral bonus, dividends);
//   reward   — Saveback credits waiting for their savings-plan execution.
//
// Rules (agreed economic model):
//   * ordinary buy / savings plan: consumes `reinvest` first; only the
//     remainder is new money → one to_portfolio capital flow for that part.
//   * Saveback and Round Up count as contributions in full (user's definition).
//   * a buy whose kind is not yet known (`pending_classification`) also counts
//     in full — amount and direction are certain, only the label is open.
//   * a sale is NOT an outflow: proceeds move to `reinvest`.
//   * interest / referral / dividend are realized return → `reinvest`; they
//     never become a contribution when reinvested later.
//   * card payments and outbound transfers consume `external` first (spending
//     money that was never invested). Only the part that has to come from
//     `reinvest` left the portfolio → from_portfolio capital flow.
//   * any pool going negative means the export is incomplete → error.

export type TrBuyKind = 'order' | 'savings_plan' | 'saveback' | 'round_up' | 'pending_classification'

export type TrLedgerEvent =
  | { id: string; datetime: string; kind: 'bank_in' | 'card_refund'; amount: number }
  | { id: string; datetime: string; kind: 'bank_out' | 'card'; amount: number }
  | { id: string; datetime: string; kind: 'sell'; amount: number } // net proceeds
  | { id: string; datetime: string; kind: 'interest' | 'referral' | 'dividend'; amount: number }
  | { id: string; datetime: string; kind: 'saveback_credit'; amount: number }
  | { id: string; datetime: string; kind: 'buy'; amount: number; buyKind: TrBuyKind } // total paid incl. fee

export type TrFlowKind = 'order_payment' | 'savings_plan' | 'saveback' | 'round_up' | 'bank_withdrawal' | 'sale_payout'

export type TrLedgerFlow = {
  externalId: string            // 'tr:<source event id>' — stable, one flow per event at most
  sourceEventId: string
  date: string                  // 'YYYY-MM-DD'
  direction: 'to_portfolio' | 'from_portfolio'
  amountCents: number
  flowKind: TrFlowKind | null   // null only while pending_classification
  status: 'final' | 'pending_classification'
}

export type TrLedgerResult = {
  ok: boolean
  errors: string[]
  warnings: string[]
  flows: TrLedgerFlow[]
  // Realized returns found on the cash account (to be booked as income).
  income: { sourceEventId: string; date: string; kind: 'interest' | 'referral' | 'dividend'; amountCents: number }[]
  endPoolsCents: { external: number; reinvest: number; reward: number }
}

const toCents = (eur: number) => Math.round(eur * 100)

const BUY_FLOW_KIND: Record<Exclude<TrBuyKind, 'pending_classification'>, TrFlowKind> = {
  order: 'order_payment',
  savings_plan: 'savings_plan',
  saveback: 'saveback',
  round_up: 'round_up',
}

export function runTradeRepublicLedger(
  events: TrLedgerEvent[],
  options: { expectedEndCashCents?: number } = {}
): TrLedgerResult {
  const errors: string[] = []
  const warnings: string[] = []
  const flows: TrLedgerFlow[] = []
  const income: TrLedgerResult['income'] = []

  // Deterministic order: by instant, then by id for identical instants.
  const sorted = [...events].sort((a, b) =>
    a.datetime < b.datetime ? -1 : a.datetime > b.datetime ? 1 : a.id < b.id ? -1 : a.id > b.id ? 1 : 0
  )
  const seen = new Set<string>()

  // Takes `amount` from the pools in the given order. The pools are one real
  // cash account split for classification only, so a shortfall in the
  // preferred pool is covered by the others (with a warning) — only a
  // shortfall in TOTAL cash is an error (the export is then incomplete).
  type Pool = 'external' | 'reinvest' | 'reward'
  const pools: Record<Pool, number> = { external: 0, reinvest: 0, reward: 0 }
  function take(amount: number, order: Pool[]): Record<Pool, number> & { short: number } {
    const used = { external: 0, reinvest: 0, reward: 0, short: 0 }
    let remaining = amount
    for (const pool of order) {
      const t = Math.min(pools[pool], remaining)
      pools[pool] -= t
      used[pool] += t
      remaining -= t
    }
    used.short = remaining
    return used
  }

  for (const e of sorted) {
    if (seen.has(e.id)) {
      errors.push(`Duplicate event ${e.id}.`)
      continue
    }
    seen.add(e.id)
    const amount = toCents(e.amount)
    const date = e.datetime.slice(0, 10)
    if (!(amount >= 0)) {
      errors.push(`Event ${e.id}: amount must be a non-negative magnitude.`)
      continue
    }
    const shortError = () =>
      errors.push(`Event ${e.id} (${e.kind}, ${date}): total cash would go negative — export incomplete?`)

    switch (e.kind) {
      case 'bank_in':
      case 'card_refund':
        pools.external += amount
        break
      case 'sell':
        pools.reinvest += amount
        break
      case 'interest':
      case 'referral':
      case 'dividend':
        pools.reinvest += amount
        income.push({ sourceEventId: e.id, date, kind: e.kind, amountCents: amount })
        break
      case 'saveback_credit':
        pools.reward += amount
        break
      case 'card':
      case 'bank_out': {
        // Spending money first; portfolio money only when it must → outflow.
        const used = take(amount, ['external', 'reward', 'reinvest'])
        if (used.reward > 0) warnings.push(`Event ${e.id} (${e.kind}, ${date}): paid partly from an unexecuted Saveback credit.`)
        if (used.short > 0) shortError()
        if (used.reinvest > 0) {
          flows.push({
            externalId: `tr:${e.id}`,
            sourceEventId: e.id,
            date,
            direction: 'from_portfolio',
            amountCents: used.reinvest,
            flowKind: e.kind === 'bank_out' ? 'bank_withdrawal' : 'sale_payout',
            status: 'final',
          })
        }
        break
      }
      case 'buy': {
        if (e.buyKind === 'order' || e.buyKind === 'savings_plan') {
          // Portfolio money first; only the rest is new money.
          const used = take(amount, ['reinvest', 'external', 'reward'])
          if (used.reward > 0) warnings.push(`Event ${e.id} (${e.buyKind}, ${date}): paid partly from a Saveback credit.`)
          if (used.short > 0) shortError()
          const newMoney = amount - used.reinvest
          if (newMoney > 0) {
            flows.push({
              externalId: `tr:${e.id}`,
              sourceEventId: e.id,
              date,
              direction: 'to_portfolio',
              amountCents: newMoney,
              flowKind: BUY_FLOW_KIND[e.buyKind],
              status: 'final',
            })
          }
        } else {
          // Saveback / Round Up / pending: a contribution in full, by definition.
          const order: Pool[] =
            e.buyKind === 'saveback' ? ['reward', 'external', 'reinvest'] : ['external', 'reward', 'reinvest']
          const used = take(amount, order)
          if (used.reinvest > 0) {
            warnings.push(
              `Event ${e.id} (${e.buyKind}, ${date}): partly paid from portfolio money but counted as a full contribution by definition.`
            )
          }
          if (used.short > 0) shortError()
          flows.push({
            externalId: `tr:${e.id}`,
            sourceEventId: e.id,
            date,
            direction: 'to_portfolio',
            amountCents: amount,
            flowKind: e.buyKind === 'pending_classification' ? null : BUY_FLOW_KIND[e.buyKind],
            status: e.buyKind === 'pending_classification' ? 'pending_classification' : 'final',
          })
        }
        break
      }
    }
  }

  const { external, reinvest, reward } = pools
  const endCash = external + reinvest + reward
  if (options.expectedEndCashCents !== undefined && endCash !== options.expectedEndCashCents) {
    errors.push(`End cash ${endCash / 100} does not match the statement (${options.expectedEndCashCents / 100}).`)
  }

  return {
    ok: errors.length === 0,
    errors,
    warnings,
    flows,
    income,
    endPoolsCents: { external, reinvest, reward },
  }
}
