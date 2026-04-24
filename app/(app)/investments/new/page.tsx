import { PageHeader } from '@/components/ui/page-header'
import { InvestmentForm } from '@/components/investments/investment-form'

export default function NewInvestmentPage() {
  return (
    <div className="space-y-6">
      <PageHeader
        title="Add investment"
        subtitle="Create a new position in your portfolio."
      />
      <InvestmentForm />
    </div>
  )
}