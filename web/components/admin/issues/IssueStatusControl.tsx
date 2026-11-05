'use client';

import { useState, type FormEvent } from 'react';
import { Check, Loader2 } from 'lucide-react';
import type { Issue, IssueStatus } from '@/hooks/useIssues';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Textarea } from '@/components/ui/textarea';
import { ISSUE_NOTE_MAX, ISSUE_STATUSES } from '@/lib/issues';
import { toast } from '@/lib/toast';
import { formatRelativeTime } from '@/lib/timeUtils';
import { cn } from '@/lib/utils';
import { ISSUE_STATUS_LABEL, issueLabel } from './issueDisplay';

// light takes the family surface; dark a tint of the solid, as the alert severity badges do.
// new is amber because it is the queue waiting on someone
const STATUS_TONE: Record<IssueStatus, string> = {
  new: 'border-warning-border bg-warning-surface text-warning dark:border-transparent dark:bg-warning-solid/20',
  triaged: 'border-info-border bg-info-surface text-info dark:border-transparent dark:bg-info-solid/20',
  fixed: 'border-success-border bg-success-surface text-success dark:border-transparent dark:bg-success-solid/20',
  wontfix: 'border-border bg-transparent text-muted-foreground',
};

export function IssueStatusBadge({ status, className }: { status: IssueStatus; className?: string }) {
  return (
    <Badge variant="outline" className={cn(STATUS_TONE[status], className)}>
      {ISSUE_STATUS_LABEL[status]}
    </Badge>
  );
}

/**
 * Sets an issue's triage status with an optional note. Mount it keyed on the
 * issue's last status change, so a saved issue resets the form to what it holds.
 */
export function IssueStatusControl({
  issue,
  onSave,
  className,
}: {
  issue: Issue;
  onSave: (status: IssueStatus, note?: string) => Promise<Issue>;
  className?: string;
}) {
  const savedNote = issue.triageNote ?? '';
  const [status, setStatus] = useState<IssueStatus>(issue.status);
  const [note, setNote] = useState(savedNote);
  const [saving, setSaving] = useState(false);

  const noteChanged = note.trim() !== savedNote;
  const dirty = status !== issue.status || noteChanged;

  const handleSubmit = async (event: FormEvent) => {
    event.preventDefault();
    if (!dirty || saving) return;
    setSaving(true);
    try {
      // an untouched note is left out, so a status change never rewrites it
      await onSave(status, noteChanged ? note.trim() : undefined);
      toast.success(
        status === issue.status
          ? `note saved on ${issueLabel(issue)}`
          : `${issueLabel(issue)} marked ${ISSUE_STATUS_LABEL[status]}`,
      );
    } catch (err) {
      toast.error('could not update the issue', {
        description: err instanceof Error ? err.message : String(err),
      });
    } finally {
      setSaving(false);
    }
  };

  return (
    <form
      onSubmit={handleSubmit}
      aria-labelledby="issue-triage-heading"
      className={cn('rounded-xl border border-border bg-card p-4', className)}
    >
      <h2 id="issue-triage-heading" className="text-sm font-semibold text-foreground">
        triage
      </h2>

      <div className="mt-3 space-y-1.5">
        <Label htmlFor="issue-status" className="text-xs text-muted-foreground">
          status
        </Label>
        <Select value={status} onValueChange={(value) => setStatus(value as IssueStatus)} disabled={saving}>
          <SelectTrigger id="issue-status" className="w-full">
            <SelectValue />
          </SelectTrigger>
          <SelectContent className="border-border bg-card text-foreground">
            {ISSUE_STATUSES.map((option) => (
              <SelectItem key={option} value={option}>
                {ISSUE_STATUS_LABEL[option]}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      <div className="mt-3 space-y-1.5">
        <div className="flex items-baseline justify-between gap-2">
          <Label htmlFor="issue-note" className="text-xs text-muted-foreground">
            note
          </Label>
          {note.length > ISSUE_NOTE_MAX * 0.9 && (
            <span className="text-xs tabular-nums text-muted-foreground">
              {note.length}/{ISSUE_NOTE_MAX}
            </span>
          )}
        </div>
        <Textarea
          id="issue-note"
          value={note}
          onChange={(event) => setNote(event.target.value)}
          maxLength={ISSUE_NOTE_MAX}
          disabled={saving}
          placeholder="what you found, or a link to the fix"
          className="max-h-60 min-h-20"
        />
      </div>

      <div className="mt-3 flex items-center justify-between gap-3">
        <p className="min-w-0 text-xs text-muted-foreground">
          {issue.statusUpdatedAt
            ? `status set ${formatRelativeTime(Date.parse(issue.statusUpdatedAt) / 1000)}`
            : 'not triaged yet'}
        </p>
        <Button type="submit" size="sm" disabled={!dirty || saving}>
          {saving ? <Loader2 className="animate-spin" /> : <Check />}
          save
        </Button>
      </div>
    </form>
  );
}
