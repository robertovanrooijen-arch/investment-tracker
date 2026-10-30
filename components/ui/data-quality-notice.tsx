// Visible data-quality warnings for EUR figures. Rendered whenever a page's
// numbers depend on a missing or approximate FX rate, so an unknown total
// ('—') is always explained and an approximate one is never silent.

type Props = {
  // Positions whose EUR figures are unknown because an FX rate is missing.
  fxIncompleteCount?: number
  // Positions with a legacy, manually-entered row converted at TODAY's rate.
  fxLiveFallbackCount?: number
  // Legacy contribution rows whose EUR amount is unknown (missing FX).
  legacyContributionsSkippedFx?: number
  // Platforms where purchases are not funded in the books (see unfundedPlatforms).
  unfundedPlatforms?: { platform: string; shortfallEur: number }[]
}

function plural(n: number, one: string, many: string): string {
  return `${n} ${n === 1 ? one : many}`
}

export function DataQualityNotice({
  fxIncompleteCount = 0,
  fxLiveFallbackCount = 0,
  legacyContributionsSkippedFx = 0,
  unfundedPlatforms = [],
}: Props) {
  const messages: string[] = []
  for (const u of unfundedPlatforms) {
    messages.push(
      `${u.platform}: purchases worth €${u.shortfallEur.toFixed(2)} have no recorded funding (no contribution, sale, ` +
        'income or official broker cash). Their value currently counts as gain, so XIRR and YTD return are too high ' +
        'until the funding is recorded.'
    )
  }
  if (fxIncompleteCount > 0) {
    messages.push(
      `Historical FX missing for ${plural(fxIncompleteCount, 'position', 'positions')}: totals that include ` +
        'them are shown as “—” instead of an incomplete sum, and no snapshot is stored until the rate is known.'
    )
  }
  if (legacyContributionsSkippedFx > 0) {
    messages.push(
      `${plural(legacyContributionsSkippedFx, 'legacy contribution has', 'legacy contributions have')} no known EUR ` +
        'amount (missing FX): contribution totals and time-weighted returns that include them are shown as “—”.'
    )
  }
  if (fxLiveFallbackCount > 0) {
    messages.push(
      `${plural(fxLiveFallbackCount, 'position uses', 'positions use')} today’s exchange rate for an older, ` +
        'manually entered transaction without its own rate: those figures are approximate.'
    )
  }
  if (messages.length === 0) return null

  return (
    <div
      role="status"
      className="rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-800 space-y-1"
    >
      {messages.map((m) => (
        <p key={m}>{m}</p>
      ))}
    </div>
  )
}
