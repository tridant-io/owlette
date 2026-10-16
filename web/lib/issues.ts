/**
 * Issue constants and copy shared by the server (routes, the issue email) and the
 * superadmin issue pages. Browser-safe: no server imports.
 */

export const ISSUE_STATUSES = ['new', 'triaged', 'fixed', 'wontfix'] as const;
export type IssueStatus = (typeof ISSUE_STATUSES)[number];

/** The longest triage note a status change may carry. */
export const ISSUE_NOTE_MAX = 2000;

/** The categories "submit issue" offers, in its order, with the words it shows. */
export const ISSUE_CATEGORY_LABELS: Record<string, string> = {
  bug: 'something broke',
  feature_request: "wouldn't it be nice if...",
  other: "it's complicated",
  compliment: "actually, you're doing great",
  rant: 'i just need to vent',
};

export const ISSUE_SOURCE_LABELS: Record<string, string> = {
  web: 'dashboard',
  agent: 'desktop app',
};

export function issueCategoryLabel(category: string): string {
  return ISSUE_CATEGORY_LABELS[category] ?? category;
}

export function issueSourceLabel(source: string): string {
  return ISSUE_SOURCE_LABELS[source] ?? source;
}

export function plural(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? '' : 's'}`;
}

/** "logs, 3 screenshots and 1 video", or '' when nothing is attached */
export function issueAttachmentsSummary({
  logs,
  screenshots,
  videos,
}: {
  logs: boolean;
  screenshots: number;
  videos: number;
}): string {
  const parts = [
    ...(logs ? ['logs'] : []),
    ...(screenshots > 0 ? [plural(screenshots, 'screenshot')] : []),
    ...(videos > 0 ? [plural(videos, 'video')] : []),
  ];
  const last = parts.pop();
  return parts.length ? `${parts.join(', ')} and ${last}` : (last ?? '');
}
