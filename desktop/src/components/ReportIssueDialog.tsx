import { Loader2 } from 'lucide-react'
import { useCallback, useEffect, useState } from 'react'
import { toast } from 'sonner'
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
 * asked for: false means the issue went without them.
 */
interface ReportIssueDone {
  category: string
  logsAttached?: boolean
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

  useEffect(() => {
    if (!open) return
    setCategory('bug')
    setDescription('')
    setAttachLogs(false)
    setSubmitting(false)
    setError(null)
    setStatus('')
  }, [open])

  const submit = useCallback(() => {
    const trimmed = description.trim()
    if (!trimmed) {
      setError('please describe the issue before submitting.')
      return
    }

    setSubmitting(true)
    setError(null)

    void runAgent('report-issue', {
      payload: { category, description: trimmed, attachLogs },
      onEvent: (event) => {
        if (event.event === 'status') setStatus(event.value)
      },
    })
      .then((outcome) => {
        // partial: a done line from an older helper carries none of these fields
        const done: Partial<ReportIssueDone> =
          outcome.terminal?.event === 'done' ? outcome.terminal.value : {}
        if (done.logsAttached === false) {
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
        setError(cause instanceof Error ? cause.message : String(cause))
      })
      .finally(() => {
        setSubmitting(false)
        setStatus('')
      })
  }, [attachLogs, category, description, onClose])

  const remaining = MAX_DESCRIPTION - description.length

  return (
    <Dialog open={open} onOpenChange={(next) => !next && !submitting && onClose()}>
      <DialogContent className="sm:max-w-md" data-testid="report-issue-dialog">
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
          <Button onClick={submit} disabled={submitting || description.trim().length === 0}>
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
