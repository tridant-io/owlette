import { NextRequest, NextResponse } from 'next/server';
import { getAdminAuth, getAdminDb } from '@/lib/firebase-admin';
import { FieldValue, Timestamp } from 'firebase-admin/firestore';
import { requireSession, ApiAuthError } from '@/lib/apiAuth.server';
import { withRateLimit } from '@/lib/withRateLimit';
import { getResend, FROM_EMAIL, ENV_LABEL, trustedBaseUrl } from '@/lib/resendClient.server';
import { wrapEmailLayout, emailDataTable, emailTimestamp, EMAIL_COLORS } from '@/lib/emailTemplates.server';
import { apiError } from '@/lib/apiErrorResponse';
import { ISSUE_LOGS_RETENTION_DAYS, headIssueLogs } from '@/lib/issueLogsStorage.server';

/**
 * POST /api/bug-report — writes the top-level `bug_reports` doc and emails
 * ISSUE_EMAIL, or ADMIN_EMAIL when that is unset. Body: title (<=200),
 * category, description (<=50,000), browserUA,
 * pageUrl, and from an agent only, logsKey, screenshots, videos and logs.
 *
 * An agent is recognised by its verified token's `role=agent` claim, never by
 * browserUA, and its report records the token's site and machine. `logsKey` names
 * a zip the agent uploaded through `issue-logs/upload-url`; it must sit under that
 * same machine's prefix and exist, else 400, and the agent resends without it.
 * The zip may hold screenshots and a video too; the agent then sends
 * `screenshots`, their count (1-5), `videos: 1`, and `logs: true` when it holds
 * logs as well, all read only alongside an accepted logsKey. The description's
 * `screenshots attached: N` and `video attached: 1` lines are for people and
 * never parsed.
 */

// the uuid file name `issueLogsKey` mints; no further path segments
const LOGS_KEY_FILE_RE = /^[A-Za-z0-9-]+\.zip$/;

// the most screenshots the desktop app lets an issue carry
const MAX_SCREENSHOTS = 5;

// the only video count the desktop app sends
const MAX_VIDEOS = 1;

const VALID_CATEGORIES = ['bug', 'feature_request', 'other', 'compliment', 'rant'] as const;

const CATEGORY_LABELS: Record<string, string> = {
  bug: 'something broke',
  feature_request: "wouldn't it be nice if...",
  other: "it's complicated",
  compliment: "actually, you're doing great",
  rant: 'i just need to vent',
};

const isProduction =
  process.env.NODE_ENV === 'production' &&
  !process.env.NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN?.includes('dev');

const ADMIN_EMAIL = isProduction
  ? process.env.ADMIN_EMAIL_PROD
  : process.env.ADMIN_EMAIL_DEV;

function attachmentsLine(url: string, screenshots: number, videos: number, hasLogs: boolean): string {
  const link = (text: string) => `<a href="${url}" style="color:${EMAIL_COLORS.cyan};">${text}</a>`;
  if (!screenshots && !videos) return `logs are attached to this issue: ${link('download logs')}`;
  const parts = [
    ...(hasLogs ? ['logs'] : []),
    ...(screenshots ? [`${screenshots} screenshot${screenshots === 1 ? '' : 's'}`] : []),
    ...(videos ? ['a video'] : []),
  ];
  const last = parts.pop();
  const what = parts.length ? `${parts.join(', ')} and ${last}` : last;
  const plural = parts.length > 0 || screenshots > 1;
  return `${what} ${plural ? 'are' : 'is'} attached to this issue: ${link('download attachments')}`;
}

function buildBugReportEmail(
  category: string,
  title: string,
  description: string,
  userEmail: string,
  source: string,
  pageUrl: string,
  logsUrl: string | null,
  screenshots: number,
  videos: number,
  hasLogs: boolean,
): string {
  const categoryLabel = CATEGORY_LABELS[category] || category;
  const color = category === 'compliment' ? EMAIL_COLORS.cyan
    : category === 'rant' ? EMAIL_COLORS.amber
    : EMAIL_COLORS.blue;

  const content = `
    <h2 style="color:${color};margin:0 0 12px;font-size:18px;font-weight:700;text-transform:lowercase;">new feedback: ${categoryLabel}</h2>
    <p style="margin:0 0 20px;color:${EMAIL_COLORS.muted};">a user submitted feedback via the ${source} app.</p>
    ${emailDataTable([
      { label: 'title', value: title },
      { label: 'category', value: categoryLabel },
      { label: 'from', value: userEmail || 'unknown' },
      { label: 'page', value: pageUrl || 'n/a' },
      { label: 'time', value: emailTimestamp() },
      { label: 'environment', value: ENV_LABEL },
    ])}
    ${logsUrl ? `<p style="margin:20px 0 0;color:${EMAIL_COLORS.muted};">${attachmentsLine(logsUrl, screenshots, videos, hasLogs)} (superadmin only, kept ${ISSUE_LOGS_RETENTION_DAYS} days).</p>` : ''}
    <div style="margin:20px 0 0;padding:16px;background:${EMAIL_COLORS.altRow};border-radius:8px;border:1px solid ${EMAIL_COLORS.border};">
      <p style="margin:0 0 8px;color:${EMAIL_COLORS.muted};font-size:12px;text-transform:uppercase;letter-spacing:0.5px;">description</p>
      <p style="margin:0;color:${EMAIL_COLORS.text};font-size:14px;line-height:1.6;white-space:pre-wrap;">${description.replace(/</g, '&lt;').replace(/>/g, '&gt;')}</p>
    </div>
  `;
  return wrapEmailLayout(content, { preheader: `${categoryLabel}: ${title}` });
}

export const POST = withRateLimit(
  async (request: NextRequest) => {
    try {
      // session first, then Bearer — web users and agents both post here
      let userId: string;
      let agent: { siteId: string; machineId: string } | null = null;
      try {
        userId = await requireSession(request);
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
      const { title, category, description, browserUA, pageUrl, logsKey } = body;

      if (!title || typeof title !== 'string' || title.trim().length === 0) {
        return NextResponse.json({ error: 'Title is required' }, { status: 400 });
      }
      if (title.trim().length > 200) {
        return NextResponse.json({ error: 'Title must be 200 characters or less' }, { status: 400 });
      }
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

      let logs: { key: string; size: number; expiresAt: Timestamp; screenshots?: number; videos?: number } | null = null;
      let zipHoldsLogs = false;
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
        // prefix is set, so this is an agent; anything but an integer 1-5 counts as none
        const sent: unknown = body.screenshots;
        const screenshots =
          typeof sent === 'number' && Number.isInteger(sent) && sent >= 1 && sent <= MAX_SCREENSHOTS
            ? sent
            : 0;
        // anything but exactly 1 counts as none
        const videos = body.videos === MAX_VIDEOS ? MAX_VIDEOS : 0;
        // an agent before 4.1.14 sends none of these fields, and its zip holds only logs
        zipHoldsLogs = body.logs === true || (!screenshots && !videos);
        logs = {
          key: logsKey,
          size: head.size,
          expiresAt: Timestamp.fromMillis(Date.now() + ISSUE_LOGS_RETENTION_DAYS * 24 * 60 * 60 * 1000),
          ...(screenshots ? { screenshots } : {}),
          ...(videos ? { videos } : {}),
        };
      }

      const ua = typeof browserUA === 'string' ? browserUA.slice(0, 500) : '';
      const isAgent = agent !== null;
      const source = isAgent ? 'agent' : 'web';

      // agents have no email; browserUA identifies them instead
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
      const fromLabel = userEmail || (isAgent ? ua : userId);

      const db = getAdminDb();
      const docRef = db.collection('bug_reports').doc();

      await docRef.set({
        source,
        category,
        title: title.trim(),
        description: description.trim(),
        status: 'new',
        createdAt: FieldValue.serverTimestamp(),
        userId,
        userEmail,
        browserUA: ua,
        pageUrl: typeof pageUrl === 'string' ? pageUrl.slice(0, 500) : '',
        appVersion: process.env.NEXT_PUBLIC_APP_VERSION ?? null,
        siteId: agent?.siteId ?? null,
        machineId: agent?.machineId ?? null,
        ...(logs ? { logs } : {}),
      });

      console.log(`[bug-report] Submitted by ${fromLabel}: ${title.trim()}`);

      // non-blocking
      const resendClient = getResend();
      const issueEmail = process.env.ISSUE_EMAIL || ADMIN_EMAIL;
      if (resendClient && issueEmail) {
        const categoryLabel = CATEGORY_LABELS[category] || category;
        resendClient.emails.send({
          from: FROM_EMAIL,
          to: issueEmail,
          subject: `[${ENV_LABEL}] feedback: ${categoryLabel} — ${title.trim()}`,
          html: buildBugReportEmail(
            category,
            title.trim(),
            description.trim(),
            fromLabel,
            source,
            typeof pageUrl === 'string' ? pageUrl : '',
            logs ? `${trustedBaseUrl()}/api/admin/issues/${docRef.id}/logs` : null,
            logs?.screenshots ?? 0,
            logs?.videos ?? 0,
            zipHoldsLogs,
          ),
        }).catch((err) => {
          console.error('[bug-report] Failed to send email notification:', err);
        });
      }

      return NextResponse.json({ success: true, id: docRef.id });
    } catch (error: unknown) {
      if (error instanceof ApiAuthError) {
        return NextResponse.json({ error: error.message }, { status: error.status });
      }
      return apiError(error, 'bug-report');
    }
  },
  { strategy: 'user', identifier: 'ip' }
);
