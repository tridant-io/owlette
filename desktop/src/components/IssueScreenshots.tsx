import { ImagePlus, X } from 'lucide-react'
import type { ReactNode } from 'react'
import { Button } from '@/components/ui/button'
import { InlineNotice } from '@/components/ui/inline-notice'
import { Label } from '@/components/ui/label'
import { MAX_SCREENSHOTS, type StagedScreenshot } from '@/lib/issueScreenshots'

interface IssueScreenshotsProps {
  screenshots: StagedScreenshot[]
  /** Sending or staging: no adding or removing until it settles. */
  busy: boolean
  notices: string[]
  onAdd: () => void
  onRemove: (id: string) => void
  /** More buttons for the same row, set to its right. */
  children?: ReactNode
}

/** The screenshots part of the issue dialog; the dialog owns the staged files. */
export function IssueScreenshots({
  screenshots,
  busy,
  notices,
  onAdd,
  onRemove,
  children,
}: IssueScreenshotsProps) {
  const full = screenshots.length >= MAX_SCREENSHOTS

  return (
    <div className="flex flex-col gap-2" data-testid="report-screenshots">
      <div className="flex items-center justify-between">
        <Label>screenshots</Label>
        <span className="text-xs text-muted-foreground" data-testid="report-screenshot-count">
          {screenshots.length} of {MAX_SCREENSHOTS}
        </span>
      </div>

      {screenshots.length > 0 && (
        <ul className="flex flex-wrap gap-2">
          {screenshots.map((shot, index) => (
            <li key={shot.id} className="relative" data-testid="report-screenshot">
              <img
                src={shot.preview}
                alt={`screenshot ${index + 1}`}
                className="size-16 rounded-md border border-border object-cover"
              />
              <button
                type="button"
                aria-label="remove screenshot"
                disabled={busy}
                onClick={() => onRemove(shot.id)}
                className="absolute -top-1.5 -right-1.5 flex size-5 cursor-pointer items-center justify-center rounded-full border border-border bg-secondary text-secondary-foreground disabled:pointer-events-none disabled:opacity-50"
              >
                <X className="size-3" aria-hidden />
              </button>
            </li>
          ))}
        </ul>
      )}

      <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
        <Button variant="outline" size="sm" onClick={onAdd} disabled={busy || full}>
          <ImagePlus aria-hidden />
          add screenshots
        </Button>
        <span className="text-xs text-muted-foreground">or paste an image</span>
        {children && <div className="ml-auto">{children}</div>}
      </div>

      {notices.length > 0 && (
        <InlineNotice data-testid="report-screenshot-notice">
          {notices.map((notice, index) => (
            <p key={index} className="text-sm">
              {notice}
            </p>
          ))}
        </InlineNotice>
      )}
    </div>
  )
}
