import type { Investment, Transaction } from '@/types/database'
import type { ContribRow } from '@/lib/domain/contributions'
import { txNativeToEur } from '@/lib/domain/calculations'
import type { FxRates } from '@/lib/domain/fx'

// ---------------------------------------------------------------------------
// Two different questions about money moving in and out:
//
// 1. RETURN FLOWS — money crossing the boundary of the tracked portfolio
//    (positions + broker cash). These are neutralised by the time-weighted
//    return. Every deposit, withdrawal, Round Up, Saveback and external
//    reward is one, including sale proceeds that were withdrawn to the bank
//    and later deposited again.
// 2. NEW PERSONAL CONTRIBUTION — "how much did I put in myself?". Re-used
//    sale proceeds are NOT new money; platform-funded money (Saveback,
//    cashback, referral bonuses) is shown separately.
//
// Classification never guesses from amounts and dates: a flow is
// 'reused_sale_proceeds' only by an explicit label (reviewed by the owner).
// ---------------------------------------------------------------------------

export type FlowKind =
  | 'bank_deposit' // own bank money (iDEAL, savings plan, order paid from the bank)
  | 'round_up' // Trade Republic Round Up (own money, card-spend rounding)
  | 'saveback' // Trade Republic Saveback / cashback (platform-funded)
  | 'external_reward' // other platform money, e.g. a referral bonus
  | 'reused_sale_proceeds' // earlier sale proceeds deposited again (explicit label only)
  | 'withdrawal' // money out of the portfolio

export const FLOW_KIND_LABEL: Record<FlowKind, string> = {
  bank_deposit: 'Own bank money',
  round_up: 'Round Ups',
  saveback: 'Saveback / cashback',
  external_reward: 'Other rewards',
  reused_sale_proceeds: 'Re-used sale proceeds',
  withdrawal: 'Withdrawal',
}

export type ReturnFlow = {
  id: string
  date: string
  platform: string
  amountEur: number // + into the portfolio, − out of it
  kind: FlowKind
  label: string
  origin: 'capital_flow' | 'reward_transaction' | 'proposed'
  // Proposed flows are NOT in the database (e.g. a missing deposit the owner
  // described); results using them are never 'confirmed'.
  proposed: boolean
}

// Referral/bonus payments are booked as 'interest' by the import, but they
// are not earned by the investments: money from outside (an external reward).
export function isRewardTransaction(tx: Pick<Transaction, 'type' | 'notes'>): boolean {
  return tx.type === 'interest' && /^\s*BONUS:|referral/i.test(tx.notes ?? '')
}

function kindFromNotes(direction: 'to_portfolio' | 'from_portfolio', notes: string | null): FlowKind {
  if (direction === 'from_portfolio') return 'withdrawal'
  const n = notes ?? ''
  if (/round\s*up/i.test(n)) return 'round_up'
  if (/saveback|cashback/i.test(n)) return 'saveback'
  return 'bank_deposit'
}

export type ProposedFlow = { id: string; date: string; platform: string; amountEur: number; kind: FlowKind; label: string }

export function classifyReturnFlows(input: {
  externalRows: ContribRow[] // buildExternalCashFlowRows(...).rows (+ fxMissingRows)
  transactions: Transaction[]
  investments: Investment[]
  fxRates?: FxRates
  // Owner-reviewed labels by flow id (e.g. 'reused_sale_proceeds').
  labels?: Record<string, FlowKind>
  proposed?: ProposedFlow[]
}): ReturnFlow[] {
  const platformOf = new Map(input.investments.map((i) => [i.id, i.platform]))
  const flows: ReturnFlow[] = input.externalRows.map((r) => {
    const amount = r.direction === 'to_portfolio' ? r.amount_eur : -r.amount_eur
    const kind = input.labels?.[r.id] ?? kindFromNotes(r.direction, r.notes)
    return {
      id: r.id, date: r.flow_date, platform: r.platform, amountEur: amount, kind,
      label: (r.notes ?? '').replace(/\s*\[external_id=[^\]]*\]?/, '').slice(0, 80) || FLOW_KIND_LABEL[kind],
      origin: 'capital_flow', proposed: false,
    }
  })
  for (const tx of input.transactions) {
    if (!isRewardTransaction(tx)) continue
    const gross = txNativeToEur(tx.amount ?? 0, tx, input.fxRates)
    flows.push({
      id: `reward:${tx.id}`, date: tx.date, platform: platformOf.get(tx.investment_id) ?? 'Unknown', amountEur: gross,
      kind: 'external_reward', label: (tx.notes ?? '').slice(0, 80), origin: 'reward_transaction', proposed: false,
    })
  }
  for (const p of input.proposed ?? []) flows.push({ ...p, origin: 'proposed', proposed: true })
  return flows.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : a.id.localeCompare(b.id)))
}

// Money concepts, kept strictly apart:
//  * fresh contributions = money that entered the portfolio for the first
//    time: own money (bank, Round Ups) + platform money (Saveback, rewards);
//  * re-used sale proceeds = earlier proceeds coming back — never new money;
//  * net external cash flow = all money in − all money out. It is NOT a
//    "net personal contribution": without tracing where each withdrawn euro
//    came from, a withdrawal may contain original capital or profit.
export type ContributionSummary = {
  ownBankEur: number
  roundUpEur: number
  grossOwnContributionsEur: number // own bank money + Round Ups
  savebackEur: number
  otherRewardsEur: number
  grossPlatformContributionsEur: number // Saveback/cashback + referral and other rewards
  grossFreshContributionsEur: number // own + platform; re-used proceeds excluded
  reusedSaleProceedsEur: number
  grossInflowsEur: number // fresh + re-used
  grossWithdrawalsEur: number
  netExternalCashFlowEur: number // grossInflows − grossWithdrawals (not a contribution)
  proposedCount: number // flows used that are not recorded yet
  unknownCount: number // flows with an unknown EUR amount (missing FX)
}

export function summarizeContributions(flows: ReturnFlow[], from?: string, to?: string): ContributionSummary {
  const s: ContributionSummary = {
    ownBankEur: 0, roundUpEur: 0, grossOwnContributionsEur: 0, savebackEur: 0, otherRewardsEur: 0,
    grossPlatformContributionsEur: 0, grossFreshContributionsEur: 0, reusedSaleProceedsEur: 0, grossInflowsEur: 0,
    grossWithdrawalsEur: 0, netExternalCashFlowEur: 0, proposedCount: 0, unknownCount: 0,
  }
  for (const f of flows) {
    if ((from && f.date < from) || (to && f.date > to)) continue
    if (!Number.isFinite(f.amountEur)) {
      s.unknownCount++
      continue
    }
    if (f.proposed) s.proposedCount++
    if (f.amountEur < 0) {
      s.grossWithdrawalsEur -= f.amountEur
      continue
    }
    s.grossInflowsEur += f.amountEur
    if (f.kind === 'round_up') s.roundUpEur += f.amountEur
    else if (f.kind === 'saveback') s.savebackEur += f.amountEur
    else if (f.kind === 'external_reward') s.otherRewardsEur += f.amountEur
    else if (f.kind === 'reused_sale_proceeds') s.reusedSaleProceedsEur += f.amountEur
    else s.ownBankEur += f.amountEur
  }
  s.grossOwnContributionsEur = s.ownBankEur + s.roundUpEur
  s.grossPlatformContributionsEur = s.savebackEur + s.otherRewardsEur
  s.grossFreshContributionsEur = s.grossOwnContributionsEur + s.grossPlatformContributionsEur
  s.netExternalCashFlowEur = s.unknownCount ? NaN : s.grossInflowsEur - s.grossWithdrawalsEur
  if (s.unknownCount) {
    s.grossInflowsEur = NaN
    s.grossFreshContributionsEur = NaN
  }
  return s
}
