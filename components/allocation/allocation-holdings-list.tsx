'use client'

import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { money } from '@/lib/format'
import { pct } from '@/lib/domain/calculations'

export type HoldingListItem = {
  key: string
  name: string
  ticker?: string | null
  /** Only rendered when `showCategoryColumn` is set (table layout, e.g. the flattened "Holdings" view). */
  category?: string
  value: number
  contextPct: number
  portfolioPct?: number
  color: string
  selectable?: boolean
}

type Props = {
  items: HoldingListItem[]
  contextLabel: string
  /**
   * 'stacked' — one holding per row, full width, no headers: name+ticker
   * left, value right, "% of X · % of portfolio" as muted subtext below.
   * Used inside the narrow category cards, at every viewport width.
   *
   * 'table' — classic column table on wider viewports (falls back to the
   * same stacked rows below `sm`). Used where there's real horizontal room,
   * e.g. the full-width "Holdings" view.
   */
  layout?: 'stacked' | 'table'
  showPortfolioColumn?: boolean
  showCategoryColumn?: boolean
  selectedKey?: string | null
  hoveredKey?: string | null
  onHoverKey?: (key: string | null) => void
  onSelectKey?: (key: string) => void
  linkForKey?: (key: string) => string
  emptyMessage?: string
}

export function AllocationHoldingsList({
  items,
  contextLabel,
  layout = 'table',
  showPortfolioColumn = true,
  showCategoryColumn = false,
  selectedKey = null,
  hoveredKey = null,
  onHoverKey,
  onSelectKey,
  linkForKey,
  emptyMessage = 'Nothing to show yet.',
}: Props) {
  if (items.length === 0) {
    return <p className="text-sm text-slate-500">{emptyMessage}</p>
  }

  const rows = items.map((item) => ({
    item,
    isActive: item.key === hoveredKey || item.key === selectedKey,
    interactive: (!!linkForKey || !!onSelectKey) && item.selectable !== false,
    href: item.selectable !== false ? linkForKey?.(item.key) : undefined,
  }))

  if (layout === 'stacked') {
    return (
      <ul className="divide-y divide-slate-100">
        {rows.map(({ item, isActive, interactive, href }) => (
          <HoldingLi
            key={item.key}
            item={item}
            isActive={isActive}
            interactive={interactive}
            href={href}
            contextLabel={contextLabel}
            showPortfolioPct={item.portfolioPct !== undefined}
            onHoverKey={onHoverKey}
            onSelectKey={onSelectKey}
          />
        ))}
      </ul>
    )
  }

  return (
    <>
      {/* Table — wide viewports only, there's enough room for real columns. */}
      <table className="hidden sm:table w-full text-sm">
        <thead>
          <tr className="text-left text-xs uppercase tracking-wide text-slate-500">
            <th className="pb-2 font-medium">Holding</th>
            {showCategoryColumn && <th className="pb-2 font-medium">Category</th>}
            <th className="pb-2 font-medium text-right">Value</th>
            {showPortfolioColumn ? (
              <th className="pb-2 font-medium text-right">% of portfolio</th>
            ) : (
              <th className="pb-2 font-medium text-right">% of {contextLabel}</th>
            )}
          </tr>
        </thead>
        <tbody>
          {rows.map(({ item, isActive, interactive, href }) => (
            <HoldingTr
              key={item.key}
              item={item}
              isActive={isActive}
              interactive={interactive}
              href={href}
              showCategoryColumn={showCategoryColumn}
              showPortfolioColumn={showPortfolioColumn}
              onHoverKey={onHoverKey}
              onSelectKey={onSelectKey}
            />
          ))}
        </tbody>
      </table>

      {/* Narrow viewports — same stacked rows as the category-card layout. */}
      <ul className="sm:hidden divide-y divide-slate-100">
        {rows.map(({ item, isActive, interactive, href }) => (
          <HoldingLi
            key={item.key}
            item={item}
            isActive={isActive}
            interactive={interactive}
            href={href}
            contextLabel={contextLabel}
            showPortfolioPct={showPortfolioColumn && item.portfolioPct !== undefined}
            onHoverKey={onHoverKey}
            onSelectKey={onSelectKey}
          />
        ))}
      </ul>
    </>
  )
}

function NameCell({ item }: { item: HoldingListItem }) {
  return (
    <div className="flex items-center gap-2 min-w-0">
      <span
        className="inline-block h-2.5 w-2.5 shrink-0 rounded-full"
        style={{ backgroundColor: item.color }}
      />
      <span className="truncate">
        <span className="text-slate-900 font-medium">{item.name}</span>
        {item.ticker && <span className="ml-1.5 text-xs text-slate-500">{item.ticker}</span>}
      </span>
    </div>
  )
}

function HoldingTr({
  item,
  isActive,
  interactive,
  href,
  showCategoryColumn,
  showPortfolioColumn,
  onHoverKey,
  onSelectKey,
}: {
  item: HoldingListItem
  isActive: boolean
  interactive: boolean
  href?: string
  showCategoryColumn: boolean
  showPortfolioColumn: boolean
  onHoverKey?: (key: string | null) => void
  onSelectKey?: (key: string) => void
}) {
  const router = useRouter()
  const pctValue = showPortfolioColumn ? item.portfolioPct : item.contextPct

  const cells = (
    <>
      <td className="py-2.5 pr-2">
        <NameCell item={item} />
      </td>
      {showCategoryColumn && (
        <td className="py-2.5 pr-2 text-slate-500">{item.category ?? '—'}</td>
      )}
      <td className="py-2.5 text-right tabular-nums text-slate-900">{money(item.value)}</td>
      <td className="py-2.5 text-right tabular-nums text-slate-500">
        {pctValue !== undefined ? pct(pctValue) : '—'}
      </td>
    </>
  )

  const rowClass = `border-t border-slate-100 transition-colors ${isActive ? 'bg-slate-50' : ''}`

  if (!interactive) {
    return <tr className={rowClass}>{cells}</tr>
  }

  function activate() {
    if (href) router.push(href)
    else onSelectKey?.(item.key)
  }

  return (
    <tr
      className={`${rowClass} cursor-pointer hover:bg-slate-50 focus:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-slate-300`}
      tabIndex={0}
      role={href ? 'link' : 'button'}
      onClick={activate}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault()
          activate()
        }
      }}
      onMouseEnter={() => onHoverKey?.(item.key)}
      onMouseLeave={() => onHoverKey?.(null)}
      onFocus={() => onHoverKey?.(item.key)}
      onBlur={() => onHoverKey?.(null)}
    >
      {cells}
    </tr>
  )
}

function HoldingLi({
  item,
  isActive,
  interactive,
  href,
  contextLabel,
  showPortfolioPct,
  onHoverKey,
  onSelectKey,
}: {
  item: HoldingListItem
  isActive: boolean
  interactive: boolean
  href?: string
  contextLabel: string
  showPortfolioPct: boolean
  onHoverKey?: (key: string | null) => void
  onSelectKey?: (key: string) => void
}) {
  const content = (
    <div className="py-3">
      <div className="flex items-center justify-between gap-3">
        <NameCell item={item} />
        <span className="shrink-0 tabular-nums text-sm font-medium text-slate-900">
          {money(item.value)}
        </span>
      </div>
      <div className="mt-0.5 tabular-nums text-xs text-slate-500">
        {item.category && <>{item.category} · </>}
        {pct(item.contextPct)} of {contextLabel}
        {showPortfolioPct && item.portfolioPct !== undefined
          ? ` · ${pct(item.portfolioPct)} of portfolio`
          : ''}
      </div>
    </div>
  )

  const wrapperClass = isActive ? 'bg-slate-50 -mx-2 px-2 rounded-lg' : ''
  const handlers = {
    onMouseEnter: () => onHoverKey?.(item.key),
    onMouseLeave: () => onHoverKey?.(null),
  }

  if (!interactive) {
    return <li className={wrapperClass}>{content}</li>
  }

  if (href) {
    return (
      <li className={wrapperClass} {...handlers}>
        <Link
          href={href}
          className="block focus:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-slate-300 rounded-lg"
        >
          {content}
        </Link>
      </li>
    )
  }

  return (
    <li className={wrapperClass} {...handlers}>
      <button
        type="button"
        className="w-full text-left focus:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-slate-300 rounded-lg"
        onClick={() => onSelectKey?.(item.key)}
      >
        {content}
      </button>
    </li>
  )
}
