/**
 * Issues: what users file with "submit issue", stored in `bug_reports`. Looks
 * one up by number or doc id, splits the agent's combined description back into
 * its parts, and serializes a doc to the issue JSON the admin routes return.
 */

import 'server-only';
import type { DocumentSnapshot, Firestore } from 'firebase-admin/firestore';
import { timestampToIso, timestampToMs } from '@/lib/firestoreTime.server';
import { trustedBaseUrl } from '@/lib/resendClient.server';
import { ISSUE_STATUSES, type IssueStatus } from '@/lib/issues';

export interface IssueDescription {
  text: string;
  systemInfo: string;
  logTail: string;
  notes: string[];
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

/** A `bug_reports` doc as the issue JSON the admin routes return. */
export function serializeIssue(doc: DocumentSnapshot): Issue {
  const data = doc.data() ?? {};
  const logs = (data.logs ?? {}) as Record<string, unknown>;
  const hasZip = typeof logs.key === 'string';
  const expiresMs = hasZip ? timestampToMs(logs.expiresAt) : null;
  const screenshots = hasZip ? count(logs.screenshots) : 0;
  const videos = hasZip ? count(logs.videos) : 0;
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
      size: hasZip && typeof logs.size === 'number' ? logs.size : null,
      expiresAt: expiresMs === null ? null : new Date(expiresMs).toISOString(),
      screenshots,
      videos,
      // a doc from before `hasLogs` was stored: a zip with no screenshots or videos
      // holds only logs
      logs: hasZip && (typeof logs.hasLogs === 'boolean' ? logs.hasLogs : !screenshots && !videos),
    },
  };
}

/** The superadmin page for one issue, by its number. */
export function issuePageUrl(number: number): string {
  return `${trustedBaseUrl()}/admin/issues/${number}`;
}
