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

// the desktop app's limits, so a web issue takes what a desktop one does
export const ISSUE_MAX_SCREENSHOTS = 10;
/** The byte limit is what holds videos back; this only bounds the list. */
export const ISSUE_MAX_VIDEOS = 20;
export const ISSUE_SCREENSHOT_MAX_BYTES = 8 * 1024 * 1024;
/** What one issue's screenshots and videos may take together. */
export const ISSUE_ATTACHMENT_MAX_BYTES = 100 * 1024 * 1024;

/** The file types an issue takes, by the extension its stored key ends in. */
export const ISSUE_FILE_TYPES = {
  png: 'image/png',
  jpg: 'image/jpeg',
  webp: 'image/webp',
  mp4: 'video/mp4',
  mov: 'video/quicktime',
  webm: 'video/webm',
} as const;
export type IssueFileExt = keyof typeof ISSUE_FILE_TYPES;

/** The extension for a browser's `File.type`, or null when issues do not take it. */
export function issueFileExt(contentType: string): IssueFileExt | null {
  const match = Object.entries(ISSUE_FILE_TYPES).find(([, type]) => type === contentType);
  return match ? (match[0] as IssueFileExt) : null;
}

export type IssueFileKind = 'screenshot' | 'video';

export function issueFileKind(ext: IssueFileExt): IssueFileKind {
  return ISSUE_FILE_TYPES[ext].startsWith('image/') ? 'screenshot' : 'video';
}

/** Why issues refuse a file of this type, worded by its family as the desktop app words it. */
export function issueFileTypeRefusal(contentType: string): string {
  if (contentType.startsWith('image/')) return 'only png, jpeg or webp images';
  if (contentType.startsWith('video/')) return 'only mp4, mov or webm videos';
  return 'only png, jpeg or webp images, or mp4, mov or webm videos';
}

/** The desktop app's words for files over its limits, or null when they fit. */
export function issueFileLimitRefusal(files: { kind: IssueFileKind; size: number }[]): string | null {
  const screenshots = files.filter((f) => f.kind === 'screenshot');
  if (screenshots.length > ISSUE_MAX_SCREENSHOTS) return `up to ${ISSUE_MAX_SCREENSHOTS} screenshots per issue`;
  if (files.length - screenshots.length > ISSUE_MAX_VIDEOS) return `up to ${ISSUE_MAX_VIDEOS} videos per issue`;
  if (screenshots.some((f) => f.size > ISSUE_SCREENSHOT_MAX_BYTES)) return 'images must be 8 MB or smaller';
  if (files.reduce((sum, f) => sum + f.size, 0) > ISSUE_ATTACHMENT_MAX_BYTES) {
    return 'attachments must total 100 MB or less';
  }
  return null;
}
