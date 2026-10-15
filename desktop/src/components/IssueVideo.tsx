import { Film, Loader2, X } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { InlineNotice } from '@/components/ui/inline-notice'
import { MAX_VIDEO_BYTES, type StagedVideo } from '@/lib/issueScreenshots'

const MB = 1024 * 1024

interface AddVideoButtonProps {
  disabled: boolean
  /** A picked video is being copied: spin until it lands. */
  staging: boolean
  onAdd: () => void
}

/** Sits in the screenshots' button row; the dialog owns the staged file. */
export function AddVideoButton({ disabled, staging, onAdd }: AddVideoButtonProps) {
  return (
    <Button variant="outline" size="sm" onClick={onAdd} disabled={disabled} aria-busy={staging}>
      {staging ? (
        <Loader2 aria-hidden className="animate-spin" data-testid="report-video-spinner" />
      ) : (
        <Film aria-hidden />
      )}
      add video
    </Button>
  )
}

interface IssueVideoProps {
  video: StagedVideo | null
  /** Sending or staging: no removing until it settles. */
  busy: boolean
  notice: string | null
  onRemove: () => void
}

/** The staged video, the limit and any refusal, under the screenshots. */
export function IssueVideo({ video, busy, notice, onRemove }: IssueVideoProps) {
  return (
    <div className="flex flex-col gap-2" data-testid="report-videos">
      {video && (
        <div
          className="flex items-center gap-2 rounded-md border border-border px-2.5 py-1.5"
          data-testid="report-video"
        >
          <Film aria-hidden className="size-4 shrink-0 text-muted-foreground" />
          <span className="min-w-0 flex-1 truncate text-sm" title={video.name}>
            {video.name}
          </span>
          <span className="shrink-0 text-xs text-muted-foreground">
            {(video.size / MB).toFixed(1)} MB
          </span>
          <button
            type="button"
            aria-label="remove video"
            disabled={busy}
            onClick={onRemove}
            className="flex size-5 shrink-0 cursor-pointer items-center justify-center rounded-full border border-border bg-secondary text-secondary-foreground disabled:pointer-events-none disabled:opacity-50"
          >
            <X className="size-3" aria-hidden />
          </button>
        </div>
      )}

      <p className="text-xs text-muted-foreground">one video, up to {MAX_VIDEO_BYTES / MB} MB</p>

      {notice && (
        <InlineNotice data-testid="report-video-notice">
          <p className="text-sm">{notice}</p>
        </InlineNotice>
      )}
    </div>
  )
}
