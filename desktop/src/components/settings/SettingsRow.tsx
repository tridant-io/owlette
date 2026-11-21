import type { ReactNode } from 'react'
import { Label } from '@/components/ui/label'

/**
 * One row of a settings page: a label (with an optional hint under it) and its
 * control on the right. `htmlFor` ties the label to the control it names.
 */
export function SettingsRow({
  label,
  hint,
  htmlFor,
  children,
}: {
  label: ReactNode
  hint?: ReactNode
  htmlFor?: string
  children: ReactNode
}) {
  return (
    <div className="flex items-center justify-between gap-4 py-3">
      <div className="flex min-w-0 flex-col gap-1">
        <Label htmlFor={htmlFor} className="leading-snug">
          {label}
        </Label>
        {hint && <span className="text-xs text-muted-foreground">{hint}</span>}
      </div>
      {children}
    </div>
  )
}
