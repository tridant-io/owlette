import { open as openPicker } from '@tauri-apps/plugin-dialog'
import { Loader2 } from 'lucide-react'
import { useCallback, useEffect, useRef, useState, type ClipboardEvent } from 'react'
import { toast } from 'sonner'
import { IssueAttachments } from '@/components/IssueAttachments'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { InlineNotice } from '@/components/ui/inline-notice'
import { Label } from '@/components/ui/label'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { Textarea } from '@/components/ui/textarea'
import { runAgent } from '@/lib/agentCli'
import {
  discardAttachments,
  IMAGE_EXTENSIONS,
  isVideo,
  MAX_ATTACHMENT_BYTES,
  MAX_SCREENSHOTS,
  MAX_VIDEOS,
  stageScreenshotFromBytes,
  stageScreenshotFromPath,
  stageVideoFromPath,
  VIDEO_EXTENSIONS,
  usedBytes,
  type StagedAttachment,
} from '@/lib/issueAttachments'

/** Categories the web API accepts (`web/app/api/bug-report/route.ts`). */
const CATEGORIES = [
  { value: 'bug', label: 'something broke' },
  { value: 'feature_request', label: "wouldn't it be nice if..." },
  { value: 'compliment', label: "actually, you're doing great" },
  { value: 'rant', label: 'i just need to vent' },
  { value: 'other', label: "it's complicated" },
] as const

/**
 * Description limit, matching the legacy dialog's counter
 * (`report_issue.ReportIssueApp.MAX_CHARS`). The API allows 50 000, but the rest
 * of that budget is the system info and log tail the agent attaches.
 */
export const MAX_DESCRIPTION = 1000

/**
 * The `report-issue` run's done value. `logsAttached` is present only when logs were
 * asked for: false means the issue went without them. `screenshotsAttached` and
 * `videosAttached` are present only when screenshots or videos were sent.
 */
interface ReportIssueDone {
  category: string
  logsAttached?: boolean
  screenshotsAttached?: number
  videosAttached?: number
}

/** The refusal for anything past MAX_ATTACHMENT_BYTES: the host's `ATTACHMENTS_TOO_BIG`. */
const TOO_BIG = 'attachments must total 100 MB or less'

/** One file to stage, named for the notice if it is refused. */
interface AttachmentSource {
  label: string
  video: boolean
  /** Stage it within `room` bytes; a screenshot is held to that once it lands. */
  stage: (room: number) => Promise<StagedAttachment>
}

function message(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause)
}

function fileName(path: string): string {
  return path.split(/[\\/]/).pop() || path
}

function extension(path: string): string {
  const name = fileName(path)
  return name.includes('.') ? name.split('.').pop()!.toLowerCase() : ''
}

/** What of `sent` did not go, worded ("the video", "the 2 screenshots", "1 of 3 screenshots") and counted. */
function missed(noun: string, sent: number, attached: number | undefined): { what: string[]; count: number } {
  if (attached === undefined || attached >= sent) return { what: [], count: 0 }
  const count = sent - attached
  if (attached > 0) return { what: [`${count} of ${sent} ${noun}s`], count }
  return { what: [sent === 1 ? `the ${noun}` : `the ${sent} ${noun}s`], count }
}

function counted(count: number | undefined, noun: string): string[] {
  return count ? [`${count} ${noun}${count === 1 ? '' : 's'}`] : []
}

/** `a`, `a and b`, `a, b and c`. */
function listOf(items: string[]): string {
  return items.length > 2 ? `${items.slice(0, -1).join(', ')} and ${items.at(-1)}` : items.join(' and ')
}

function forget(ids: string[]) {
  // best effort: a file left behind is harmless, and the operator cannot act on it
  if (ids.length > 0) void discardAttachments(ids).catch(() => {})
}

interface ReportIssueDialogProps {
  open: boolean
  onClose: () => void
}

/**
 * An issue, with the machine's own diagnostics attached.
 *
 * Nothing is gathered here: `configure_site.py --report-issue` collects the system
 * metrics and the last ~100 lines of the service log and posts them with the agent's own
 * token — same shape as the legacy `report_issue.py`, landing in `bug_reports` with
 * `source: 'agent'`.
 */
export function ReportIssueDialog({ open, onClose }: ReportIssueDialogProps) {
  const [category, setCategory] = useState<string>('bug')
  const [description, setDescription] = useState('')
  const [attachLogs, setAttachLogs] = useState(false)
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [status, setStatus] = useState('')
  const [attachments, setAttachments] = useState<StagedAttachment[]>([])
  const [staging, setStaging] = useState(false)
  const [notices, setNotices] = useState<string[]>([])
  // the staged files still ours to discard, read outside render by the close cleanup
  const stagedRef = useRef<StagedAttachment[]>([])
  // bumped on every close, so a staging that lands after it is discarded, not shown
  const visitRef = useRef(0)

  const keepAttachments = useCallback((next: StagedAttachment[]) => {
    stagedRef.current = next
    setAttachments(next)
  }, [])

  // reset while rendering the reopen, so the last visit never flashes
  const [wasOpen, setWasOpen] = useState(open)
  if (open !== wasOpen) {
    setWasOpen(open)
    if (open) {
      setCategory('bug')
      setDescription('')
      setAttachLogs(false)
      setSubmitting(false)
      setError(null)
      setStatus('')
      setAttachments([])
      setStaging(false)
      setNotices([])
    }
  }

  useEffect(() => {
    if (!open) return
    return () => {
      // closed or unmounted without sending: nothing will use the staged files now
      visitRef.current += 1
      forget(stagedRef.current.map((attachment) => attachment.id))
      stagedRef.current = []
    }
  }, [open])

  // one at a time, so each knows the room the ones before it left
  const stage = useCallback(
    async (sources: AttachmentSource[]) => {
      if (sources.length === 0) return
      const visit = visitRef.current
      setStaging(true)
      setNotices([])
      const refused = new Set<string>()
      for (const source of sources) {
        const held = stagedRef.current
        const videos = held.filter(isVideo).length
        if (source.video ? videos >= MAX_VIDEOS : held.length - videos >= MAX_SCREENSHOTS) {
          refused.add(
            source.video ? `up to ${MAX_VIDEOS} videos per issue` : `up to ${MAX_SCREENSHOTS} screenshots per issue`,
          )
          continue
        }
        const room = MAX_ATTACHMENT_BYTES - usedBytes(held)
        try {
          const staged = await source.stage(room)
          if (visit !== visitRef.current) {
            forget([staged.id])
            return
          }
          if (staged.size > room) {
            forget([staged.id])
            refused.add(`${source.label}: ${TOO_BIG}`)
            continue
          }
          keepAttachments([...stagedRef.current, staged])
        } catch (cause) {
          if (visit !== visitRef.current) return
          refused.add(`${source.label}: ${message(cause)}`)
        }
      }
      setNotices([...refused])
      setStaging(false)
    },
    [keepAttachments],
  )

  const pick = useCallback(() => {
    void openPicker({
      multiple: true,
      filters: [{ name: 'screenshots and videos', extensions: [...IMAGE_EXTENSIONS, ...VIDEO_EXTENSIONS] }],
    })
      .then((picked) => {
        const paths = picked === null ? [] : Array.isArray(picked) ? picked : [picked]
        return stage(
          paths.map((path) => {
            const video = VIDEO_EXTENSIONS.includes(extension(path))
            return {
              label: fileName(path),
              video,
              stage: (room: number) => (video ? stageVideoFromPath(path, room) : stageScreenshotFromPath(path)),
            }
          }),
        )
      })
      .catch((cause: unknown) => setNotices([message(cause)]))
  }, [stage])

  const busy = submitting || staging

  const pasteScreenshots = (event: ClipboardEvent) => {
    const items = Array.from(event.clipboardData?.items ?? [])
    // a copy from a web page or an office app carries an image beside its text; the text box wants it
    if (items.some((item) => item.type === 'text/plain')) return
    const files = items
      .filter((item) => item.type.startsWith('image/'))
      .map((item) => item.getAsFile())
      .filter((file): file is File => file !== null)
    if (files.length === 0) return
    event.preventDefault()
    if (busy) return
    void stage(
      files.map((file) => ({
        label: 'pasted image',
        video: false,
        stage: async () => stageScreenshotFromBytes(new Uint8Array(await file.arrayBuffer())),
      })),
    )
  }

  const remove = (id: string) => {
    keepAttachments(stagedRef.current.filter((attachment) => attachment.id !== id))
    forget([id])
  }

  const submit = useCallback(() => {
    const trimmed = description.trim()
    if (!trimmed) {
      setError('please describe the issue before submitting.')
      return
    }

    setSubmitting(true)
    setError(null)
    const sentShots = attachments.filter((attachment) => !isVideo(attachment)).map((shot) => shot.id)
    const sentVideos = attachments.filter(isVideo).map((video) => video.id)

    void runAgent('report-issue', {
      payload: { category, description: trimmed, attachLogs, screenshots: sentShots, videos: sentVideos },
      onEvent: (event) => {
        if (event.event === 'status') setStatus(event.value)
      },
    })
      .then((outcome) => {
        // the agent deletes what it was sent once the issue is filed, attached or not
        keepAttachments([])
        // partial: a done line from an older helper carries none of these fields
        const done: Partial<ReportIssueDone> =
          outcome.terminal?.event === 'done' ? outcome.terminal.value : {}
        const logsFailed = done.logsAttached === false
        const shots = missed('screenshot', sentShots.length, done.screenshotsAttached)
        const videos = missed('video', sentVideos.length, done.videosAttached)
        // one toast names everything that did not go
        const failed = [...(logsFailed ? ['the logs'] : []), ...shots.what, ...videos.what]
        if (failed.length > 0) {
          const resend =
            failed.length > 1 ? 'them' : logsFailed ? 'the logs folder' : shots.count + videos.count === 1 ? 'it' : 'them'
          toast.warning(`your issue was sent, but ${listOf(failed)} could not be attached`, {
            description: `try again, or send ${resend} another way.`,
          })
        } else {
          const went = [
            'system info',
            done.logsAttached === true ? 'the logs' : 'the last lines of the service log',
            ...counted(done.screenshotsAttached, 'screenshot'),
            ...counted(done.videosAttached, 'video'),
          ]
          toast.success('thanks — your issue was sent', { description: `${listOf(went)} went with it.` })
        }
        onClose()
      })
      .catch((cause: unknown) => {
        // the issue was not filed, so the agent kept the attachments: they stay for a retry
        setError(message(cause))
      })
      .finally(() => {
        setSubmitting(false)
        setStatus('')
      })
  }, [attachLogs, attachments, category, description, keepAttachments, onClose])

  const remaining = MAX_DESCRIPTION - description.length

  return (
    <Dialog open={open} onOpenChange={(next) => !next && !submitting && onClose()}>
      <DialogContent
        className="sm:max-w-md"
        data-testid="report-issue-dialog"
        onPaste={pasteScreenshots}
      >
        <DialogHeader>
          <DialogTitle>submit issue</DialogTitle>
          <DialogDescription>
            help us improve owlette. system info and the last lines of the service log always go
            with it.
          </DialogDescription>
        </DialogHeader>

        <div className="flex flex-col gap-2">
          <Label htmlFor="feedback-category">category</Label>
          <Select value={category} onValueChange={setCategory} disabled={submitting}>
            <SelectTrigger id="feedback-category" className="w-full" data-testid="report-category">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {CATEGORIES.map((option) => (
                <SelectItem key={option.value} value={option.value}>
                  {option.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        <div className="flex flex-col gap-2">
          <Label htmlFor="feedback-description">description</Label>
          <Textarea
            id="feedback-description"
            rows={6}
            maxLength={MAX_DESCRIPTION}
            disabled={submitting}
            value={description}
            data-testid="report-description"
            onChange={(event) => setDescription(event.target.value.slice(0, MAX_DESCRIPTION))}
            placeholder="what happened, and what did you expect instead?"
          />
          <p className="text-right text-xs text-muted-foreground" data-testid="report-remaining">
            {remaining} characters left
          </p>
        </div>

        <IssueAttachments
          attachments={attachments}
          staging={staging}
          busy={busy}
          notices={notices}
          onAdd={pick}
          onRemove={remove}
        />

        <div className="flex flex-col gap-1.5">
          <div className="flex items-center gap-2">
            <Checkbox
              id="feedback-attach-logs"
              checked={attachLogs}
              disabled={submitting}
              data-testid="report-attach-logs"
              aria-describedby="feedback-attach-logs-help"
              onCheckedChange={(checked) => setAttachLogs(checked === true)}
            />
            <Label htmlFor="feedback-attach-logs">attach logs</Label>
          </div>
          <p id="feedback-attach-logs-help" className="text-xs text-muted-foreground">
            includes this machine's owlette logs, owlette swoop's log, crash reports where the
            system keeps them, and a file list. they can contain hostnames, user names, file paths
            and process names.
            kept 30 days, seen only by owlette support.
          </p>
        </div>

        {error && (
          <InlineNotice data-testid="report-error">
            <p className="text-sm">could not send the report</p>
            <p className="font-mono text-xs text-muted-foreground">{error}</p>
          </InlineNotice>
        )}

        <DialogFooter className="sm:items-center">
          {submitting && (
            <p className="text-xs text-muted-foreground sm:mr-auto" aria-live="polite" data-testid="report-status">
              {status}
            </p>
          )}
          <Button variant="outline" onClick={onClose} disabled={submitting}>
            cancel
          </Button>
          <Button
            onClick={submit}
            disabled={busy || description.trim().length === 0}
          >
            {submitting && (
              <Loader2 aria-hidden className="animate-spin" data-testid="report-spinner" />
            )}
            {submitting ? 'sending…' : 'submit'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
