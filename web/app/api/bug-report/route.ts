import { NextRequest, NextResponse } from 'next/server';
import { getAdminAuth, getAdminDb } from '@/lib/firebase-admin';
import { FieldValue, Timestamp } from 'firebase-admin/firestore';
import { requireSession, ApiAuthError } from '@/lib/apiAuth.server';
import { withRateLimit } from '@/lib/withRateLimit';
import { getResend, FROM_EMAIL, ENV_LABEL } from '@/lib/resendClient.server';
import { buildIssueEmail } from '@/lib/emailTemplates.server';
import { apiError } from '@/lib/apiErrorResponse';
import { ISSUE_LOGS_RETENTION_DAYS, headIssueLogs, webIssueFileExt } from '@/lib/issueLogsStorage.server';
import {
  ISSUE_CATEGORY_LABELS,
  ISSUE_MAX_SCREENSHOTS,
  ISSUE_MAX_VIDEOS,
  type IssueFileExt,
  type IssueFileKind,
  issueCategoryLabel,
  issueFileKind,
  issueFileLimitRefusal,
} from '@/lib/issues';
import { agentVersionFromUA, hostFromPageUrl, issuePageUrl, parseIssueDescription } from '@/lib/issues.server';

/**
 * POST /api/bug-report — writes the top-level `bug_reports` doc, numbered from
 * `counters/bug_reports` in the same transaction, and emails ISSUE_EMAIL, or
 * ADMIN_EMAIL when that is unset. Answers `{ success, id, number }`. Body: title (<=200),
 * category, description (<=50,000), browserUA,
 * pageUrl, from a session only, files, and from an agent only, logsKey, screenshots,
 * videos and logs.
 *
 * The title is optional. When it is missing, blank or the agent's placeholder
 * `agent feedback`, it is the first line of the user's text, cut to 120
 * characters, or the category's label when there is no text.
 *
 * `files` names the screenshots and videos a signed-in user uploaded through
 * `issue-attachments/upload-url`: keys under that user's own `issues/web/` prefix.
 * Each is HEADed for its size, never trusting the client, and the issue takes
 * them only within the desktop app's limits, else 400. They are stored as
 * `files` with `filesExpireAt`; a web issue never carries `logs`.
 *
 * An agent is recognised by its verified token's `role=agent` claim, never by
 * browserUA, and its report records the token's site and machine. `logsKey` names
 * a zip the agent uploaded through `issue-logs/upload-url`; it must sit under that
 * same machine's prefix and exist, else 400, and the agent resends without it.
 * The zip may hold screenshots and videos too; the agent then sends their
 * counts as `screenshots` (1-10) and `videos` (1-20), and `logs: true` when it
 * holds logs as well, all read only alongside an accepted logsKey. The
 * description's `screenshots attached: N` and `videos attached: N` lines are
 * for people and never parsed.
 */

// the uuid file name `issueLogsKey` mints; no further path segments
const LOGS_KEY_FILE_RE = /^[A-Za-z0-9-]+\.zip$/;

// an integer 1 to max, else 0: none
function attachedCount(sent: unknown, max: number): number {
  return typeof sent === 'number' && Number.isInteger(sent) && sent >= 1 && sent <= max ? sent : 0;
}

// the title the agent sends when its user gave none (agent/src/configure_site.py)
const AGENT_PLACEHOLDER_TITLE = 'agent feedback';
const DERIVED_TITLE_MAX = 120;

function derivedTitle(description: string, category: string): string {
  const line = parseIssueDescription(description)
    .text.split('\n')
    .map((l) => l.replace(/\s+/g, ' ').trim())
    .find(Boolean);
  if (!line) return issueCategoryLabel(category);
  return line.length > DERIVED_TITLE_MAX ? `${line.slice(0, DERIVED_TITLE_MAX - 1).trimEnd()}…` : line;
}

function retentionEnd(): Timestamp {
  return Timestamp.fromMillis(Date.now() + ISSUE_LOGS_RETENTION_DAYS * 24 * 60 * 60 * 1000);
}

type StoredIssueFile = { key: string; ext: IssueFileExt; kind: IssueFileKind; size: number };

const VALID_CATEGORIES = Object.keys(ISSUE_CATEGORY_LABELS);

const isProduction =
  process.env.NODE_ENV === 'production' &&
  !process.env.NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN?.includes('dev');

const ADMIN_EMAIL = isProduction
  ? process.env.ADMIN_EMAIL_PROD
  : process.env.ADMIN_EMAIL_DEV;

export const POST = withRateLimit(
  async (request: NextRequest) => {
    try {
      // session first, then Bearer — web users and agents both post here
      let userId: string;
      let agent: { siteId: string; machineId: string } | null = null;
      let isSession = false;
      try {
        userId = await requireSession(request);
        isSession = true;
      } catch {
        const authHeader = request.headers.get('authorization') || '';
        const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : null;
        if (!token) {
          return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
        }
        try {
          const decoded = await getAdminAuth().verifyIdToken(token);
          userId = decoded.uid;
          if (
            decoded.role === 'agent' &&
            typeof decoded.site_id === 'string' &&
            typeof decoded.machine_id === 'string'
          ) {
            agent = { siteId: decoded.site_id, machineId: decoded.machine_id };
          }
        } catch {
          return NextResponse.json({ error: 'Unauthorized: Invalid token' }, { status: 401 });
        }
      }

      const body = await request.json();
      const { title, category, description, browserUA, pageUrl, logsKey, files: fileKeys } = body;

      if (!category || !VALID_CATEGORIES.includes(category)) {
        return NextResponse.json(
          { error: `Category must be one of: ${VALID_CATEGORIES.join(', ')}` },
          { status: 400 }
        );
      }
      if (!description || typeof description !== 'string' || description.trim().length === 0) {
        return NextResponse.json({ error: 'Description is required' }, { status: 400 });
      }
      const maxDescLength = 50000; // allow long descriptions for agent log attachments
      if (description.trim().length > maxDescLength) {
        return NextResponse.json({ error: `Description must be ${maxDescLength} characters or less` }, { status: 400 });
      }
      const sentTitle = typeof title === 'string' ? title.trim() : '';
      if (sentTitle.length > 200) {
        return NextResponse.json({ error: 'Title must be 200 characters or less' }, { status: 400 });
      }
      const issueTitle =
        sentTitle && sentTitle !== AGENT_PLACEHOLDER_TITLE ? sentTitle : derivedTitle(description.trim(), category);

      let logs: {
        key: string;
        size: number;
        expiresAt: Timestamp;
        hasLogs: boolean;
        screenshots?: number;
        videos?: number;
      } | null = null;
      if (logsKey !== undefined && logsKey !== null) {
        const prefix = agent ? `issues/${agent.siteId}/${agent.machineId}/` : null;
        if (
          !prefix ||
          typeof logsKey !== 'string' ||
          !logsKey.startsWith(prefix) ||
          !LOGS_KEY_FILE_RE.test(logsKey.slice(prefix.length))
        ) {
          return NextResponse.json({ error: "logsKey is not this machine's upload" }, { status: 400 });
        }
        // a storage error answers 400 as well: the agent resends without logs,
        // and the issue itself still lands
        const head = await headIssueLogs(logsKey).catch((err) => {
          console.error('[bug-report] could not check the logs upload:', err);
          return null;
        });
        if (!head) {
          return NextResponse.json({ error: 'logsKey names no uploaded logs' }, { status: 400 });
        }
        // prefix is set, so this is an agent
        const screenshots = attachedCount(body.screenshots, ISSUE_MAX_SCREENSHOTS);
        const videos = attachedCount(body.videos, ISSUE_MAX_VIDEOS);
        logs = {
          key: logsKey,
          size: head.size,
          expiresAt: retentionEnd(),
          // an agent before 4.1.14 sends none of these fields, and its zip holds only logs
          hasLogs: body.logs === true || (!screenshots && !videos),
          ...(screenshots ? { screenshots } : {}),
          ...(videos ? { videos } : {}),
        };
      }

      let files: StoredIssueFile[] | null = null;
      if (fileKeys !== undefined && fileKeys !== null) {
        if (!isSession) {
          return NextResponse.json({ error: 'files are accepted only from a signed-in user' }, { status: 400 });
        }
        const maxFiles = ISSUE_MAX_SCREENSHOTS + ISSUE_MAX_VIDEOS;
        if (
          !Array.isArray(fileKeys) ||
          fileKeys.length < 1 ||
          fileKeys.length > maxFiles ||
          !fileKeys.every((k) => typeof k === 'string')
        ) {
          return NextResponse.json({ error: `files must list 1 to ${maxFiles} attachment keys` }, { status: 400 });
        }
        const keys = fileKeys as string[];
        if (new Set(keys).size !== keys.length) {
          return NextResponse.json({ error: 'files names an attachment twice' }, { status: 400 });
        }
        const exts: IssueFileExt[] = [];
        for (const key of keys) {
          const ext = webIssueFileExt(key, userId);
          if (!ext) {
            return NextResponse.json({ error: 'files names an attachment that is not yours' }, { status: 400 });
          }
          exts.push(ext);
        }
        const kinds = exts.map(issueFileKind);
        // counts first, so a list over them is refused before any HEAD
        const tooMany = issueFileLimitRefusal(kinds.map((kind) => ({ kind, size: 0 })));
        if (tooMany) {
          return NextResponse.json({ error: tooMany }, { status: 400 });
        }
        // a storage error answers 400 as well, and the user sends again
        const heads = await Promise.all(
          keys.map((key) =>
            headIssueLogs(key).catch((err) => {
              console.error('[bug-report] could not check an attachment upload:', err);
              return null;
            }),
          ),
        );
        const sizes: number[] = [];
        for (const head of heads) {
          if (!head) {
            return NextResponse.json({ error: 'an attachment did not finish uploading' }, { status: 400 });
          }
          sizes.push(head.size);
        }
        files = keys.map((key, i) => ({ key, ext: exts[i], kind: kinds[i], size: sizes[i] }));
        const tooBig = issueFileLimitRefusal(files);
        if (tooBig) {
          return NextResponse.json({ error: tooBig }, { status: 400 });
        }
      }

      const ua = typeof browserUA === 'string' ? browserUA.slice(0, 500) : '';
      const isAgent = agent !== null;
      const source = isAgent ? 'agent' : 'web';

      const page = typeof pageUrl === 'string' ? pageUrl.slice(0, 500) : '';
      const appVersion = process.env.NEXT_PUBLIC_APP_VERSION ?? null;

      // agents have no email; the machine's host names them instead
      let userEmail = '';
      if (!isAgent) {
        try {
          const adminAuth = getAdminAuth();
          const userRecord = await adminAuth.getUser(userId);
          userEmail = userRecord.email || '';
        } catch {
          // non-critical
        }
      }
      const host = hostFromPageUrl(page) || null;
      const fromLabel = userEmail || (isAgent ? (host ? `owlette agent on ${host}` : 'owlette agent') : userId);

      const db = getAdminDb();
      const docRef = db.collection('bug_reports').doc();
      const counterRef = db.collection('counters').doc('bug_reports');

      // the counter advances only inside a committed transaction, so a retried
      // loser reads the new value and two issues never share a number
      const number = await db.runTransaction(async (tx) => {
        const counter = await tx.get(counterRef);
        const next = counter.data()?.next;
        const n = (typeof next === 'number' ? next : 0) + 1;
        tx.set(docRef, {
          source,
          category,
          title: issueTitle,
          description: description.trim(),
          status: 'new',
          createdAt: FieldValue.serverTimestamp(),
          userId,
          userEmail,
          browserUA: ua,
          pageUrl: page,
          appVersion,
          siteId: agent?.siteId ?? null,
          machineId: agent?.machineId ?? null,
          number: n,
          ...(logs ? { logs } : {}),
          ...(files ? { files, filesExpireAt: retentionEnd() } : {}),
        });
        tx.set(counterRef, { next: n }, { merge: true });
        return n;
      });

      console.log(`[bug-report] issue #${number} submitted by ${fromLabel}: ${issueTitle}`);

      // non-blocking
      const resendClient = getResend();
      const issueEmail = process.env.ISSUE_EMAIL || ADMIN_EMAIL;
      if (resendClient && issueEmail) {
        const { subject, html } = buildIssueEmail({
          number,
          categoryLabel: issueCategoryLabel(category),
          title: issueTitle,
          text: parseIssueDescription(description.trim()).text,
          from: fromLabel,
          host,
          siteId: agent?.siteId ?? null,
          appVersion: (isAgent && agentVersionFromUA(ua)) || appVersion,
          source,
          envLabel: ENV_LABEL,
          attachments: files
            ? {
                screenshots: files.filter((f) => f.kind === 'screenshot').length,
                videos: files.filter((f) => f.kind === 'video').length,
                logs: false,
              }
            : {
                screenshots: logs?.screenshots ?? 0,
                videos: logs?.videos ?? 0,
                logs: logs?.hasLogs ?? false,
              },
          issueUrl: issuePageUrl(number),
        });
        resendClient.emails.send({ from: FROM_EMAIL, to: issueEmail, subject, html }).catch((err) => {
          console.error('[bug-report] Failed to send email notification:', err);
        });
      }

      return NextResponse.json({ success: true, id: docRef.id, number });
    } catch (error: unknown) {
      if (error instanceof ApiAuthError) {
        return NextResponse.json({ error: error.message }, { status: error.status });
      }
      return apiError(error, 'bug-report');
    }
  },
  { strategy: 'user', identifier: 'ip' }
);
