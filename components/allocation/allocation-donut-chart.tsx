'use client'

import { useCallback } from 'react'
import { PieChart, Pie, Cell, Tooltip, ResponsiveContainer } from 'recharts'
import { AllocationTooltip } from './allocation-tooltip'
import type { AllocationTooltipPayload } from './allocation-tooltip'

export type DonutItem = {
  key: string
  name: string
  value: number
  contextPct: number
  portfolioPct?: number
  color: string
  /** 'other' slices aren't individually selectable/highlightable. */
  selectable?: boolean
}

type CenterLabel = {
  primary: string
  secondary: string
}

type Props = {
  items: DonutItem[]
  contextLabel: string
  size?: number
  ariaLabel: string
  hoveredKey?: string | null
  selectedKey?: string | null
  onHoverKey?: (key: string | null) => void
  onSelectKey?: (key: string) => void
  /** Small text centered in the donut hole, e.g. { primary: '46.14%', secondary: 'of portfolio' }. */
  centerLabel?: CenterLabel
}

export function AllocationDonutChart({
  items,
  contextLabel,
  size = 220,
  ariaLabel,
  hoveredKey = null,
  selectedKey = null,
  onHoverKey,
  onSelectKey,
  centerLabel,
}: Props) {
  const data = items.map((item) => ({
    ...item,
    contextLabel,
  }))

  const renderTooltip = useCallback(
    (props: object) => (
      <AllocationTooltip
        {...(props as { active?: boolean; payload?: { payload: AllocationTooltipPayload }[] })}
      />
    ),
    [],
  )

  if (items.length === 0) {
    return (
      <div
        className="flex items-center justify-center text-sm text-slate-500"
        style={{ width: size, height: size }}
      >
        Nothing to show yet.
      </div>
    )
  }

  const inner = Math.round(size * 0.32)
  const outer = Math.round(size * 0.48)

  return (
    // Explicit width AND height, not just height: Recharts' ResponsiveContainer
    // measures its direct parent, and a parent with no explicit width collapses
    // to 0px inside a flex row (flex's default stretch only applies to the
    // cross axis) even though the exact same markup works fine inside a CSS
    // grid column (grid stretches items on both axes by default) — so this
    // component has to carry its own size rather than lean on the caller's layout.
    <div className="relative" style={{ width: size, height: size }} role="img" aria-label={ariaLabel}>
      <ResponsiveContainer width="100%" height="100%">
        <PieChart>
          <Pie
            data={data}
            cx="50%"
            cy="50%"
            innerRadius={inner}
            outerRadius={outer}
            // A single full-circle slice needs zero padding, otherwise Recharts
            // still carves a small gap where the (non-existent) neighbor would
            // be, leaving a visible notch in what should be an unbroken ring.
            paddingAngle={items.length > 1 ? 2 : 0}
            dataKey="value"
            onClick={(entry: { payload?: DonutItem }) => {
              const item = entry?.payload
              if (item?.key && item.selectable !== false) onSelectKey?.(item.key)
            }}
            onMouseEnter={(entry: { payload?: DonutItem }) => {
              const item = entry?.payload
              if (item?.selectable !== false) onHoverKey?.(item?.key ?? null)
            }}
            onMouseLeave={() => onHoverKey?.(null)}
          >
            {data.map((item) => {
              const isActive = item.key === hoveredKey || item.key === selectedKey
              const isDimmed =
                (hoveredKey !== null || selectedKey !== null) &&
                !isActive &&
                (hoveredKey ?? selectedKey) !== null
              return (
                <Cell
                  key={item.key}
                  fill={item.color}
                  // A thin white separator between slices at rest (subtle, not a
                  // gap — still a fully unbroken ring for a single slice), a
                  // bolder dark ring when a slice is explicitly selected.
                  stroke={item.key === selectedKey ? '#0f172a' : '#ffffff'}
                  strokeWidth={item.key === selectedKey ? 2 : 1}
                  opacity={isDimmed ? 0.45 : 1}
                  className={item.selectable === false ? undefined : 'cursor-pointer transition-opacity'}
                />
              )
            })}
          </Pie>
          <Tooltip
            content={renderTooltip}
            // Let the tooltip render outside the chart's own (small) viewBox
            // instead of being clamped inside it — a 170px chart can never fit
            // a ~200px tooltip without escaping, and clamping is exactly what
            // was forcing it to collapse into the center, on top of the label.
            allowEscapeViewBox={{ x: true, y: true }}
            wrapperStyle={{ zIndex: 50, pointerEvents: 'none' }}
            isAnimationActive={false}
          />
        </PieChart>
      </ResponsiveContainer>

      {centerLabel && (
        // Fades out while a slice is hovered so it never collides with the
        // tooltip — tied to the same hoveredKey state the chart/rows already
        // share, not a CSS-only hover selector (this has to fade in sync with
        // row hovers coming from outside the chart too).
        <div
          className={`pointer-events-none absolute inset-0 flex flex-col items-center justify-center transition-opacity duration-150 ${
            hoveredKey !== null ? 'opacity-0' : 'opacity-100'
          }`}
        >
          <span className="text-sm font-semibold text-slate-900 tabular-nums">
            {centerLabel.primary}
          </span>
          <span className="text-xs text-slate-500">{centerLabel.secondary}</span>
        </div>
      )}
    </div>
  )
}
