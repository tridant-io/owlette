import { open as openPicker } from '@tauri-apps/plugin-dialog'
import { Loader2 } from 'lucide-react'
import { useCallback, useEffect, useRef, useState, type ClipboardEvent } from 'react'
import { toast } from 'sonner'
import { IssueScreenshots } from '@/components/IssueScreenshots'
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
  discardScreenshots,
  MAX_SCREENSHOTS,
  stageScreenshotFromBytes,
  stageScreenshotFromPath,
  type StagedScreenshot,
} from '@/lib/issueScreenshots'

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
 * asked for: false means the issue went without them. `screenshotsAttached` is present
 * only when screenshots were sent.
 */
interface ReportIssueDone {
  category: string
  logsAttached?: boolean
  screenshotsAttached?: number
}

/** One image to stage, named for the notice if it is refused. */
interface ScreenshotSource {
  label: string
  stage: () => Promise<StagedScreenshot>
}

function message(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause)
}

function forget(ids: string[]) {
  // best effort: a file left behind is harmless, and the operator cannot act on it
  if (ids.length > 0) void discardScreenshots(ids).catch(() => {})
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
  const [screenshots, setScreenshots] = useState<StagedScreenshot[]>([])
  const [staging, setStaging] = useState(false)
  const [screenshotNotices, setScreenshotNotices] = useState<string[]>([])
  // the staged files still ours to discard, read outside render by the close cleanup
  const stagedRef = useRef<StagedScreenshot[]>([])
  // bumped on every close, so a staging that lands after it is discarded, not shown
  const visitRef = useRef(0)

  const keepScreenshots = useCallback((next: StagedScreenshot[]) => {
    stagedRef.current = next
    setScreenshots(next)
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
      setScreenshots([])
      setStaging(false)
      setScreenshotNotices([])
    }
  }

  useEffect(() => {
    if (!open) return
    return () => {
      // closed or unmounted without sending: nothing will use the staged files now
      visitRef.current += 1
      forget(stagedRef.current.map((shot) => shot.id))
      stagedRef.current = []
    }
  }, [open])

  const stage = useCallback(
    async (sources: ScreenshotSource[]) => {
      const room = MAX_SCREENSHOTS - stagedRef.current.length
      const taken = sources.slice(0, Math.max(room, 0))
      const notices =
        taken.length < sources.length ? [`up to ${MAX_SCREENSHOTS} screenshots per issue`] : []
      if (taken.length === 0) {
        setScreenshotNotices(notices)
        return
      }

      const visit = visitRef.current
      setStaging(true)
      setScreenshotNotices([])
      const results = await Promise.allSettled(taken.map((source) => source.stage()))
      const staged = results.flatMap((result) => (result.status === 'fulfilled' ? [result.value] : []))
      if (visit !== visitRef.current) {
        forget(staged.map((shot) => shot.id))
        return
      }

      results.forEach((result, index) => {
        if (result.status === 'rejected') notices.push(`${taken[index].label}: ${message(result.reason)}`)
      })
      keepScreenshots([...stagedRef.current, ...staged])
      setScreenshotNotices(notices)
      setStaging(false)
    },
    [keepScreenshots],
  )

  const pickScreenshots = useCallback(() => {
    void openPicker({
      multiple: true,
      filters: [{ name: 'images', extensions: ['png', 'jpg', 'jpeg', 'webp'] }],
    })
      .then((picked) => {
        const paths = picked === null ? [] : Array.isArray(picked) ? picked : [picked]
        return stage(
          paths.map((path) => ({
            label: path.split(/[\\/]/).pop() || path,
            stage: () => stageScreenshotFromPath(path),
          })),
        )
      })
      .catch((cause: unknown) => setScreenshotNotices([message(cause)]))
  }, [stage])

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
    if (submitting || staging) return
    void stage(
      files.map((file) => ({
        label: 'pasted image',
        stage: async () => stageScreenshotFromBytes(new Uint8Array(await file.arrayBuffer())),
      })),
    )
  }

  const removeScreenshot = (id: string) => {
    keepScreenshots(stagedRef.current.filter((shot) => shot.id !== id))
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
    const sent = screenshots.map((shot) => shot.id)

    void runAgent('report-issue', {
      payload: { category, description: trimmed, attachLogs, screenshots: sent },
      onEvent: (event) => {
        if (event.event === 'status') setStatus(event.value)
      },
    })
      .then((outcome) => {
        // the agent deletes what it was sent once the issue is filed, attached or not
        keepScreenshots([])
        // partial: a done line from an older helper carries none of these fields
        const done: Partial<ReportIssueDone> =
          outcome.terminal?.event === 'done' ? outcome.terminal.value : {}
        const attachedShots = done.screenshotsAttached
        const screenshotsFailed = sent.length > 0 && attachedShots === 0
        if (done.logsAttached === false && screenshotsFailed) {
          toast.warning('your issue was sent, but the logs and screenshots could not be attached', {
            description: 'try again, or send them another way.',
          })
        } else if (screenshotsFailed) {
          toast.warning('your issue was sent, but the screenshots could not be attached', {
            description: 'try again, or send them another way.',
          })
        } else if (attachedShots !== undefined && attachedShots < sent.length) {
          toast.warning(
            `your issue was sent, but only ${attachedShots} of ${sent.length} screenshots could be attached`,
            { description: 'try again, or send them another way.' },
          )
        } else if (done.logsAttached === false) {
          toast.warning('your issue was sent, but the logs could not be attached', {
            description: 'try again, or send the logs folder another way.',
          })
        } else if (done.logsAttached === true) {
          toast.success('thanks — your issue was sent', {
            description: 'system info and the logs went with it.',
          })
        } else {
          toast.success('thanks — your issue was sent', {
            description: 'system info and the last lines of the service log went with it.',
          })
        }
        onClose()
      })
      .catch((cause: unknown) => {
        // the issue was not filed, so the agent kept the screenshots: they stay for a retry
        setError(message(cause))
      })
      .finally(() => {
        setSubmitting(false)
        setStatus('')
      })
  }, [attachLogs, category, description, keepScreenshots, onClose, screenshots])

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

        <IssueScreenshots
          screenshots={screenshots}
          busy={submitting || staging}
          notices={screenshotNotices}
          onAdd={pickScreenshots}
          onRemove={removeScreenshot}
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
            disabled={submitting || staging || description.trim().length === 0}
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
