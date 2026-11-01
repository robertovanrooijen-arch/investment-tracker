import Link from 'next/link'
import { PageHeader } from '@/components/ui/page-header'
import { TradeImporter } from '@/components/import/trade-importer'

export default function ImportsPage() {
  return <div className="space-y-6">
    <PageHeader title="Import broker trades" subtitle="Check the original export first. Only new, uniquely matched trades can be written." action={<Link href="/data-quality" className="rounded-lg border border-slate-300 bg-white px-4 py-2 text-sm font-medium text-slate-700 hover:bg-slate-50">Data checks</Link>} />
    <TradeImporter />
    <div className="rounded-2xl border border-slate-200 bg-white p-5 text-sm text-slate-600">
      <p className="font-medium text-slate-900">Holland Gold</p>
      <p className="mt-1">Holland Gold supplies invoice PDFs rather than the four supported CSV layouts. Add a new invoice through “Add transaction” for now; the app will not convert a PDF into guessed data.</p>
    </div>
  </div>
}
