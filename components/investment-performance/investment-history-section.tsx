'use client'

import { useState } from 'react'
import { InvestmentDetailChart } from '@/components/investments/investment-detail-chart'
import { categoryLabel } from '@/lib/domain/allocation'
import type { ChartPoint } from '@/lib/domain/chart-timeline'
import type { Investment } from '@/types/database'

type Props = {
  investments: Investment[]
  chartPointsByInvestmentId: Record<string, ChartPoint[]>
}

export function InvestmentHistorySection({ investments, chartPointsByInvestmentId }: Props) {
  const [selectedId, setSelectedId] = useState(investments[0]?.id ?? '')
  const chartPoints = chartPointsByInvestmentId[selectedId] ?? []

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2 className="text-base font-semibold text-slate-900">Position history</h2>
        <select
          value={selectedId}
          onChange={(e) => setSelectedId(e.target.value)}
          className="rounded-md border border-slate-300 bg-white px-3 py-1.5 text-sm text-slate-900 focus:outline-none focus:ring-2 focus:ring-slate-300"
        >
          {investments.map((inv) => (
            <option key={inv.id} value={inv.id}>
              {inv.name} ({categoryLabel(inv.type)})
            </option>
          ))}
        </select>
      </div>
      <InvestmentDetailChart chartPoints={chartPoints} initialPreset="ytd" />
    </div>
  )
}
