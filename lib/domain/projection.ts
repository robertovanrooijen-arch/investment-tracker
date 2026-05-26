// Portfolio projection / compound growth calculator.
//
// Convention:
//   • recurringAmount is the per-PERIOD amount:
//       Monthly frequency → recurringAmount is per month (×12 = annual total)
//       Yearly  frequency → recurringAmount is per year
//   • Contributions are added at the BEGINNING of each period, then growth
//     is applied (annuity-due).
//   • Monthly mode compounds at annualReturn / 12 per month.
//   • contributionGrowthPct increases the per-period amount by that percentage
//     each year (same factor for all 12 months within a year).
//
// This module is pure — no React, no Supabase, no side effects.

export type RecurringFrequency = 'monthly' | 'yearly'

export interface ProjectionInput {
  startingValue: number           // current portfolio value in EUR
  oneTimeContribution: number     // lump sum added at t=0, before any compounding
  annualReturnPct: number         // e.g. 7 for 7%
  years: number                   // projection horizon (integer)
  recurringAmount: number         // per-period contribution
  recurringFrequency: RecurringFrequency
  contributionGrowthPct: number   // annual increase in recurring amount, e.g. 2 for 2%
  targetAmount: number | null     // optional goal; null = no target
}

export interface ProjectionRow {
  year: number
  portfolioValue: number    // end-of-year portfolio value
  capitalIn: number         // startingValue + totalContributed so far
  totalContributed: number  // cumulative contributions added (excl. starting value)
  growth: number            // portfolioValue - capitalIn (pure investment return)
  yearContrib: number       // amount contributed during this specific year/period
}

export interface ProjectionResult {
  rows: ProjectionRow[]
  finalValue: number
  totalContributed: number  // sum of all contributions (one-time + recurring)
  totalGrowth: number       // finalValue - startingValue - totalContributed
  targetReachedYear: number | null
}

export function computeProjection(input: ProjectionInput): ProjectionResult {
  const {
    startingValue,
    oneTimeContribution,
    annualReturnPct,
    years,
    recurringAmount,
    recurringFrequency,
    contributionGrowthPct,
    targetAmount,
  } = input

  const r  = annualReturnPct / 100
  const rm = r / 12                      // monthly rate
  const g  = contributionGrowthPct / 100

  let value            = startingValue + oneTimeContribution
  let totalContributed = oneTimeContribution
  let targetReachedYear: number | null = null

  const rows: ProjectionRow[] = [{
    year:            0,
    portfolioValue:  value,
    capitalIn:       startingValue + totalContributed,
    totalContributed,
    growth:          0,
    yearContrib:     oneTimeContribution,
  }]

  if (targetAmount !== null && value >= targetAmount) {
    targetReachedYear = 0
  }

  for (let yr = 1; yr <= years; yr++) {
    const growthFactor = Math.pow(1 + g, yr - 1)
    let yearTotalContrib: number

    if (recurringFrequency === 'yearly') {
      const contrib = recurringAmount * growthFactor
      value = (value + contrib) * (1 + r)
      yearTotalContrib = contrib
    } else {
      // recurringAmount is per-month; compound monthly
      const monthlyAmount = recurringAmount * growthFactor
      for (let m = 0; m < 12; m++) {
        value = (value + monthlyAmount) * (1 + rm)
      }
      yearTotalContrib = monthlyAmount * 12
    }

    totalContributed += yearTotalContrib
    const capitalIn = startingValue + totalContributed
    const growth    = value - capitalIn

    rows.push({ year: yr, portfolioValue: value, capitalIn, totalContributed, growth, yearContrib: yearTotalContrib })

    if (targetAmount !== null && targetReachedYear === null && value >= targetAmount) {
      targetReachedYear = yr
    }
  }

  return {
    rows,
    finalValue:       value,
    totalContributed,
    totalGrowth:      value - startingValue - totalContributed,
    targetReachedYear,
  }
}
