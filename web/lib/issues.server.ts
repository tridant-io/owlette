/**
 * Issues: what users file with "submit issue", stored in `bug_reports`. Looks
 * one up by number or doc id, splits the agent's combined description back into
 * its parts, and serializes a doc to the issue JSON the admin routes return.
 */

import 'server-only';
import type { DocumentSnapshot, Firestore } from 'firebase-admin/firestore';
import { timestampToIso, timestampToMs } from '@/lib/firestoreTime.server';
import { trustedBaseUrl } from '@/lib/resendClient.server';
import {
  ISSUE_FILE_TYPES,
  ISSUE_STATUSES,
  issueFileKind,
  type IssueFileExt,
  type IssueFileKind,
  type IssueStatus,
} from '@/lib/issues';

export interface IssueDescription {
  text: string;
  systemInfo: string;
  logTail: string;
  notes: string[];
}

export interface IssueFile {
  /** 1-based, its place in the stored list; `GET /api/admin/issues/{id}/files/{index}` */
  index: number;
  kind: IssueFileKind;
  ext: IssueFileExt;
  size: number;
}

export interface Issue {
  id: string;
  number: number | null;
  status: IssueStatus;
  category: string;
  title: string;
  source: string;
  createdAt: string | null;
  appVersion: string | null;
  siteId: string | null;
  machineId: string | null;
  from: string;
  host: string | null;
  description: IssueDescription;
  triageNote: string | null;
  statusUpdatedAt: string | null;
  statusUpdatedBy: string | null;
  attachments: {
    available: boolean;
    size: number | null;
    expiresAt: string | null;
    screenshots: number;
    videos: number;
    logs: boolean;
    files: IssueFile[];
  };
}

// the markers agent/src/configure_site.py submit_report writes; the server trims
// the description, so a marker may also open it
const LOG_TAIL_RE = /(?:^|\n\n)--- recent logs \(last ~100 lines\) ---(?:\n|$)/;
const SYSTEM_INFO_RE = /(?:^|\n\n)--- system info ---(?:\n|$)/;
const NOTE_RE = /^(?:screenshots attached: \d+|videos attached: \d+|attachments could not be sent: .+)$/;

const NUMBER_RE = /^\d{1,9}$/;
const DOC_ID_RE = /^[A-Za-z0-9_-]{1,128}$/;

/** Splits an issue's description into the user's text and what the agent appended. Never throws. */
export function parseIssueDescription(description: unknown): IssueDescription {
  const parsed: IssueDescription = { text: '', systemInfo: '', logTail: '', notes: [] };
  if (typeof description !== 'string') return parsed;

  // the log tail comes last, so its first marker ends everything before it
  let head = description;
  const logs = LOG_TAIL_RE.exec(head);
  if (logs) {
    parsed.logTail = head.slice(logs.index + logs[0].length);
    head = head.slice(0, logs.index);
  }
  const info = SYSTEM_INFO_RE.exec(head);
  if (info) {
    parsed.systemInfo = head.slice(info.index + info[0].length);
    head = head.slice(0, info.index);
  }

  // note lines follow the user's text, one paragraph each; only trailing ones are notes
  const paragraphs = head.split('\n\n');
  while (paragraphs.length && NOTE_RE.test(paragraphs[paragraphs.length - 1])) {
    parsed.notes.unshift(paragraphs.pop() as string);
  }
  parsed.text = paragraphs.join('\n\n').trim();
  return parsed;
}

// the agent sends `Owlette Agent v<version> / <os>` as its browserUA
const AGENT_UA_VERSION_RE = /^Owlette Agent v(\S+) \//;

/** The agent version an agent's browserUA names, or null. */
export function agentVersionFromUA(ua: unknown): string | null {
  return typeof ua === 'string' ? (AGENT_UA_VERSION_RE.exec(ua)?.[1] ?? null) : null;
}

/** The agent posts `pageUrl` as `agent://<hostname>`; '' for anything else. */
export function hostFromPageUrl(pageUrl: unknown): string {
  return typeof pageUrl === 'string' && pageUrl.startsWith('agent://')
    ? pageUrl.slice('agent://'.length)
    : '';
}

/** An issue by its number (1-9 digits) or its doc id; null when absent or malformed. */
export async function findIssue(db: Firestore, idOrNumber: string): Promise<DocumentSnapshot | null> {
  const issues = db.collection('bug_reports');
  if (NUMBER_RE.test(idOrNumber)) {
    const snap = await issues.where('number', '==', Number(idOrNumber)).limit(1).get();
    return snap.empty ? null : snap.docs[0];
  }
  if (!DOC_ID_RE.test(idOrNumber)) return null;
  const snap = await issues.doc(idOrNumber).get();
  return snap.exists ? snap : null;
}

function str(value: unknown): string | null {
  return typeof value === 'string' && value ? value : null;
}

function count(value: unknown): number {
  return typeof value === 'number' && Number.isInteger(value) && value > 0 ? value : 0;
}

/**
 * The files a browser attached to a web issue, with their keys, from the stored
 * `files` list. A malformed entry is skipped but keeps its place, so an index
 * always names the same stored file.
 */
export function issueFiles(files: unknown): Array<IssueFile & { key: string }> {
  if (!Array.isArray(files)) return [];
  return files.flatMap((file: unknown, i) => {
    const f = (file ?? {}) as Record<string, unknown>;
    if (typeof f.key !== 'string' || typeof f.ext !== 'string') return [];
    if (!Object.prototype.hasOwnProperty.call(ISSUE_FILE_TYPES, f.ext)) return [];
    const ext = f.ext as IssueFileExt;
    const kind = issueFileKind(ext);
    if (f.kind !== kind || typeof f.size !== 'number' || !Number.isInteger(f.size) || f.size < 0) return [];
    return [{ index: i + 1, kind, ext, size: f.size, key: f.key }];
  });
}

/** A `bug_reports` doc as the issue JSON the admin routes return. */
export function serializeIssue(doc: DocumentSnapshot): Issue {
  const data = doc.data() ?? {};
  const logs = (data.logs ?? {}) as Record<string, unknown>;
  const hasZip = typeof logs.key === 'string';
  // a machine attaches one zip, a browser separate files; never both. keys stay server-side
  const files: IssueFile[] = hasZip
    ? []
    : issueFiles(data.files).map(({ index, kind, ext, size }) => ({ index, kind, ext, size }));
  let expiresMs: number | null = null;
  let size: number | null = null;
  if (hasZip) {
    expiresMs = timestampToMs(logs.expiresAt);
    size = typeof logs.size === 'number' ? logs.size : null;
  } else if (files.length) {
    expiresMs = timestampToMs(data.filesExpireAt);
    size = files.reduce((sum, f) => sum + f.size, 0);
  }
  const screenshots = hasZip ? count(logs.screenshots) : files.filter((f) => f.kind === 'screenshot').length;
  const videos = hasZip ? count(logs.videos) : files.filter((f) => f.kind === 'video').length;
  const status = ISSUE_STATUSES.includes(data.status) ? (data.status as IssueStatus) : 'new';

  return {
    id: doc.id,
    number: typeof data.number === 'number' && Number.isInteger(data.number) ? data.number : null,
    status,
    category: str(data.category) ?? '',
    title: str(data.title) ?? '',
    source: str(data.source) ?? '',
    createdAt: timestampToIso(data.createdAt),
    // the stored appVersion is the web server's; an agent issue names its own in browserUA
    appVersion: (data.source === 'agent' && agentVersionFromUA(data.browserUA)) || str(data.appVersion),
    siteId: str(data.siteId),
    machineId: str(data.machineId),
    from: str(data.userEmail) ?? '',
    host: hostFromPageUrl(data.pageUrl) || null,
    description: parseIssueDescription(data.description),
    triageNote: str(data.triageNote),
    statusUpdatedAt: timestampToIso(data.statusUpdatedAt),
    statusUpdatedBy: str(data.statusUpdatedBy),
    attachments: {
      available: expiresMs !== null && expiresMs > Date.now(),
      size,
      expiresAt: expiresMs === null ? null : new Date(expiresMs).toISOString(),
      screenshots,
      videos,
      // a doc from before `hasLogs` was stored: a zip with no screenshots or videos
      // holds only logs
      logs: hasZip && (typeof logs.hasLogs === 'boolean' ? logs.hasLogs : !screenshots && !videos),
      files,
    },
  };
}

/** The superadmin page for one issue, by its number. */
export function issuePageUrl(number: number): string {
  return `${trustedBaseUrl()}/admin/issues/${number}`;
}
