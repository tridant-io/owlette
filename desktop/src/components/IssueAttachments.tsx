import { Film, Loader2, Paperclip, X } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { InlineNotice } from '@/components/ui/inline-notice'
import { Label } from '@/components/ui/label'
import { isVideo, MAX_ATTACHMENT_BYTES, usedBytes, type StagedAttachment } from '@/lib/issueAttachments'

const MB = 1024 * 1024

function megabytes(bytes: number): string {
  // a small screenshot still shows as something
  return Math.max(bytes / MB, 0.1).toFixed(1)
}

interface IssueAttachmentsProps {
  attachments: StagedAttachment[]
  /** Files are being copied in: spin until they land. */
  staging: boolean
  /** Sending or staging: no adding or removing until it settles. */
  busy: boolean
  notices: string[]
  onAdd: () => void
  onRemove: (id: string) => void
}

/** The issue dialog's screenshots and videos; the dialog owns the staged files. */
export function IssueAttachments({
  attachments,
  staging,
  busy,
  notices,
  onAdd,
  onRemove,
}: IssueAttachmentsProps) {
  const used = usedBytes(attachments)
  const screenshots = attachments.filter((attachment) => !isVideo(attachment))
  const limit = MAX_ATTACHMENT_BYTES / MB

  return (
    <div className="flex flex-col gap-2" data-testid="report-attachments">
      <Label>attachments</Label>

      {attachments.length > 0 && (
        <ul className="flex flex-wrap gap-2">
          {attachments.map((attachment) => (
            <li
              key={attachment.id}
              className="relative"
              data-testid={isVideo(attachment) ? 'report-video' : 'report-screenshot'}
            >
              {isVideo(attachment) ? (
                <div
                  title={attachment.name}
                  className="flex size-16 flex-col items-center justify-center gap-1 rounded-md border border-border bg-muted text-muted-foreground"
                >
                  <Film aria-hidden className="size-5" />
                  <span className="text-[10px] leading-none">{megabytes(attachment.size)} MB</span>
                </div>
              ) : (
                <img
                  src={attachment.preview}
                  alt={`screenshot ${screenshots.indexOf(attachment) + 1}`}
                  className="size-16 rounded-md border border-border object-cover"
                />
              )}
              <button
                type="button"
                aria-label={isVideo(attachment) ? `remove ${attachment.name}` : 'remove screenshot'}
                disabled={busy}
                onClick={() => onRemove(attachment.id)}
                className="absolute -top-1.5 -right-1.5 flex size-5 cursor-pointer items-center justify-center rounded-full border border-border bg-secondary text-secondary-foreground disabled:pointer-events-none disabled:opacity-50"
              >
                <X className="size-3" aria-hidden />
              </button>
            </li>
          ))}
        </ul>
      )}

      <div className="flex items-center gap-3">
        <Button variant="outline" size="sm" onClick={onAdd} disabled={busy} aria-busy={staging}>
          {staging ? (
            <Loader2 aria-hidden className="animate-spin" data-testid="report-attachment-spinner" />
          ) : (
            <Paperclip aria-hidden />
          )}
          add screenshots or video
        </Button>
        <span className="text-xs text-muted-foreground" data-testid="report-attachment-limit">
          {used > 0 ? `${megabytes(used)} of ${limit} MB used` : `up to ${limit} MB, or paste an image`}
        </span>
      </div>

      {notices.length > 0 && (
        <InlineNotice data-testid="report-attachment-notice">
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
