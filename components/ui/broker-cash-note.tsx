import { money } from '@/lib/format'
import { PrivacyGate } from '@/components/ui/privacy-value'
import type { BrokerCash } from '@/lib/domain/current-valuation'

// How broker cash relates to the shown portfolio value (one wording for every page).
export function BrokerCashNote({ cash }: { cash: BrokerCash }) {
  if (cash.totalEur === null) return null
  if (cash.presentation === 'in_headline') {
    return <PrivacyGate fallback="Incl. broker cash"><>Incl. broker cash {money(cash.totalEur, 'EUR')}</></PrivacyGate>
  }
  const material = cash.byPlatform.filter((c) => !c.withinTolerance)
  if (material.length) {
    return (
      <span className="text-amber-700">
        Investment positions only.{' '}
        <PrivacyGate fallback="Broker cash above the rounding tolerance is kept apart">
          <>
            Broker cash {material.map((c) => `${c.platform} ${money(c.valueEur, 'EUR')}`).join(', ')} is above the rounding
            tolerance ({money(cash.roundingToleranceEur, 'EUR')}) and is not in this value — a policy decision is needed.
          </>
        </PrivacyGate>
      </span>
    )
  }
  return (
    <>
      Investment positions only ·{' '}
      <PrivacyGate fallback="broker cash kept apart">
        <>broker cash {money(cash.totalEur, 'EUR')} kept apart (rounding, ≤ {money(cash.roundingToleranceEur, 'EUR')} per platform)</>
      </PrivacyGate>
    </>
  )
}
