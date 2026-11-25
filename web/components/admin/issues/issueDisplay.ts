import type { Issue, IssueStatus } from '@/hooks/useIssues';

/**
 * What the issue pages show for an issue's fields. The statuses and the category
 * and source labels live in `lib/issues.ts`, shared with the server.
 */

export const ISSUE_STATUS_LABEL: Record<IssueStatus, string> = {
  new: 'new',
  triaged: 'triaged',
  fixed: 'fixed',
  wontfix: "won't fix",
};

/** "issue #42"; an issue filed before numbering has no number */
export function issueLabel(issue: Pick<Issue, 'number'>): string {
  return issue.number === null ? 'issue' : `issue #${issue.number}`;
}

/** the issue page, by number when it has one */
export function issueHref(issue: Pick<Issue, 'number' | 'id'>): string {
  return `/admin/issues/${issue.number ?? encodeURIComponent(issue.id)}`;
}

/** an agent issue has no email; its machine's host names it */
export function issueSender(issue: Pick<Issue, 'from' | 'host'>): string {
  return issue.from || issue.host || 'unknown sender';
}

/** "oct 15, 2026, 3:42 pm" in the browser's zone */
export function formatIssueDate(iso: string, timeFormat: '12h' | '24h' = '12h'): string {
  return new Date(iso)
    .toLocaleString('en-US', {
      month: 'short',
      day: 'numeric',
      year: 'numeric',
      hour: 'numeric',
      minute: '2-digit',
      hour12: timeFormat === '12h',
    })
    .toLowerCase();
}

/** "oct 15, 2026" */
export function formatIssueDay(iso: string): string {
  return new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }).toLowerCase();
}
