import type { ButtonHTMLAttributes } from 'react'

type Variant = 'primary' | 'secondary' | 'danger'

type ButtonProps = ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: Variant
}

const variantStyles: Record<Variant, string> = {
  primary:
    'bg-slate-900 text-white hover:bg-slate-800 disabled:bg-slate-400',
  secondary:
    'bg-white text-slate-900 border border-slate-300 hover:bg-slate-50 disabled:opacity-60',
  danger:
    'bg-white text-rose-600 border border-rose-200 hover:bg-rose-50 disabled:opacity-60',
}

export function Button({
  variant = 'primary',
  className = '',
  children,
  ...rest
}: ButtonProps) {
  return (
    <button
      {...rest}
      className={
        'inline-flex items-center justify-center gap-2 rounded-lg px-4 py-2 text-sm font-medium transition disabled:cursor-not-allowed ' +
        variantStyles[variant] +
        (className ? ' ' + className : '')
      }
    >
      {children}
    </button>
  )
}