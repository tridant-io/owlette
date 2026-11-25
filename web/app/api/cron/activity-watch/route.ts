import { NextRequest, NextResponse } from 'next/server';
import { cronSecretMatches } from '@/lib/secretMatches.server';
import { getAdminDb } from '@/lib/firebase-admin';
import { getResend, FROM_EMAIL, ENV_LABEL, trustedBaseUrl } from '@/lib/resendClient.server';
import {
  buildActivityFindingEmail,
  buildActivityDigestEmail,
  type ActivityEmailFinding,
} from '@/lib/emailTemplates.server';
import { apiError } from '@/lib/apiErrorResponse';
import logger from '@/lib/logger';
import { loadActivitySince } from '@/lib/activity/feed.server';
import { loadOldestQueued } from '@/lib/activity/auditQueues.server';
import { evaluateAuditQueues, evaluateRules, type RuleInput } from '@/lib/activity/rules';
import { fromDecisionDoc } from '@/lib/activity/rows';
import { loadUserLabels } from '@/lib/activity/labels.server';
import {
  claimDigest,
  claimForEmail,
  markDigested,
  readState,
  saveNewFindings,
  writeScannedThrough,
} from '@/lib/activity/findings.server';
import { ACTIVITY_FINDINGS_COLLECTION, type ActivityRow, type Finding } from '@/lib/activity/types';

/**
 * GET /api/cron/activity-watch — one pass over the platform's activity since the last
 * scan: runs the detection rules, flags any site whose audit queue has waited past 5 minutes,
 * stores the new findings, emails each new high one (the audit drainer adds its own),
 * and, once a day from 16:00 utc, a digest of the findings nobody has been mailed about.
 * Auth: X-Cron-Secret must equal CRON_SECRET. Dedupe: findings have deterministic ids,
 * and `emailedAt` and the digest day are claimed BEFORE the send, so a retry cannot mail
 * twice. Mail goes to the addresses listed on admin → alerts (until a list is saved, the
 * configured address); switched off there, or with the list emptied, nothing is mailed or claimed.
 *
 * Answers `{ ok, rowsScanned, findingsCreated, emailsSent }`.
 *
 * Runs on cron-job.org, NOT Railway — register once per environment:
 *   *\/5 * * * *  GET https://<app>/api/cron/activity-watch
 *   Header: X-Cron-Secret: <that environment's CRON_SECRET>
 */

const MINUTE_MS = 60 * 1000;
const DAY_MS = 24 * 60 * MINUTE_MS;
const OVERLAP_MS = 20 * MINUTE_MS;
// rows still being written when the scan runs are picked up by the next one
const SETTLE_MS = 30 * 1000;
const MAX_LOOKBACK_MS = DAY_MS;
const HISTORY_MS = 90 * DAY_MS;
const DIGEST_HOUR_UTC = 16;

type Db = FirebaseFirestore.Firestore;
type Role = 'owner' | 'admin' | 'member';
type StoredFinding = Finding & { detectedAt: number; emailedAt: number | null; digestedAt: number | null };

const ROLE_RANK: Record<Role, number> = { owner: 3, admin: 2, member: 1 };

const isNewSignIn = (r: ActivityRow) =>
  r.kind === 'sign_in' && r.action === 'sign_in' && r.outcome === 'allow' && r.actor.type === 'user';

function rowUids(rows: ActivityRow[]): Set<string> {
  const uids = new Set<string>();
  for (const r of rows) {
    if (r.actor.type === 'user' && r.actor.id) uids.add(r.actor.id);
    if (r.target?.id && /^(user|site_member)_mutated:/.test(r.action)) uids.add(r.target.id);
  }
  return uids;
}

// what the new-network rule needs per user: the networks of their earlier sign-ins, and their top site role
async function loadSignInContext(
  db: Db,
  rows: ActivityRow[],
  now: number,
): Promise<Pick<RuleInput, 'knownNetworks' | 'hasHistory' | 'siteRoles'>> {
  const firstSeen = new Map<string, number>();
  for (const r of rows.filter((r) => isNewSignIn(r) && r.network?.key)) {
    firstSeen.set(r.actor.id, Math.min(firstSeen.get(r.actor.id) ?? Infinity, r.at));
  }
  const context: Pick<RuleInput, 'knownNetworks' | 'hasHistory' | 'siteRoles'> = {
    knownNetworks: {},
    hasHistory: {},
    siteRoles: {},
  };
  const entries = db.collection('global').doc('audit_log').collection('entries');

  await Promise.all(
    [...firstSeen].map(async ([uid, before]) => {
      const [history, memberships] = await Promise.all([
        entries
          .where('actor.userId', '==', uid)
          .where('capability', '==', 'AUTH_SIGN_IN')
          .where('timestamp', '>', new Date(now - HISTORY_MS))
          .orderBy('timestamp', 'desc')
          .limit(200)
          .get(),
        db.collectionGroup('members').where('uid', '==', uid).get(),
      ]);
      const earlier = history.docs
        .map((d) => fromDecisionDoc(d, 'platform', null))
        .filter((r) => isNewSignIn(r) && r.at < before);
      context.hasHistory[uid] = earlier.length > 0;
      context.knownNetworks[uid] = earlier.flatMap((r) => (r.network ? [r.network.key] : []));
      const roles = memberships.docs.map((d) => d.get('role') as Role).filter((role) => role in ROLE_RANK);
      context.siteRoles[uid] = roles.sort((a, b) => ROLE_RANK[b] - ROLE_RANK[a])[0] ?? null;
    }),
  );
  return context;
}

function forEmail(f: Finding, labels: Record<string, string>): ActivityEmailFinding {
  const userId = f.subject.userId;
  return {
    title: f.title,
    severity: f.severity,
    summary: f.summary,
    subject: (userId && (labels[userId] ?? userId)) || f.subject.actor || f.subject.siteId || 'platform',
    facts: f.facts.map((x): [string, string] => [x.label, x.value]),
    at: f.at,
  };
}

export async function GET(request: NextRequest) {
  if (!cronSecretMatches(request.headers.get('x-cron-secret'))) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const db = getAdminDb();
  const now = Date.now();
  const end = now - SETTLE_MS;
  const resend = getResend();
  const activityUrl = `${trustedBaseUrl()}/admin/activity?view=flagged`;
  let emailsSent = 0;

  let to: string[] = [];

  // one failed send is logged, never allowed to fail the run or hold back the next finding
  const send = async (message: { subject: string; html: string }, what: string) => {
    try {
      const result = await resend!.emails.send({ from: FROM_EMAIL, to, ...message });
      if (result.error) logger.error(`activity-watch: ${what} email failed`, { context: 'cron/activity-watch', data: { error: result.error } });
      else emailsSent++;
    } catch (error) {
      logger.error(`activity-watch: ${what} email failed`, { context: 'cron/activity-watch', data: { error: String(error) } });
    }
  };

  try {
    const { scannedThrough, email } = await readState(db);
    to = email.recipients;
    const start = Math.max(Math.min(scannedThrough ?? Infinity, now - OVERLAP_MS), now - MAX_LOOKBACK_MS);

    const [all, queues] = await Promise.all([loadActivitySince(db, start), loadOldestQueued(db)]);
    const rows = all.filter((r) => r.at <= end);
    const [labels, signInContext] = await Promise.all([loadUserLabels(db, rowUids(rows)), loadSignInContext(db, rows, now)]);
    const created = await saveNewFindings(
      db,
      [...evaluateRules({ rows, labels, ...signInContext }), ...evaluateAuditQueues(queues, now)],
      now,
    );

    const canMail = email.enabled && !!resend && to.length > 0;
    if (!email.enabled) logger.info('activity-watch: activity emails are switched off, skipping email', { context: 'cron/activity-watch' });
    else if (!canMail) logger.warn('activity-watch: Resend or a recipient is not configured, skipping email', { context: 'cron/activity-watch' });

    if (canMail) {
      const recent = (
        await db
          .collection(ACTIVITY_FINDINGS_COLLECTION)
          .where('detectedAt', '>', now - 2 * DAY_MS)
          .orderBy('detectedAt', 'desc')
          .get()
      ).docs.map((d) => d.data() as StoredFinding);
      const recentLabels = await loadUserLabels(
        db,
        recent.flatMap((f) => (f.subject.userId ? [f.subject.userId] : [])),
      );

      // every unmailed high finding of the last day, not only this run's: a run that died or had no resend must not lose the email
      for (const finding of recent.filter((f) => f.severity === 'high' && f.emailedAt == null && f.detectedAt > now - DAY_MS)) {
        // claim before send: a lost email beats a loop
        if (!(await claimForEmail(db, finding.id, now))) continue;
        await send(
          buildActivityFindingEmail({ envLabel: ENV_LABEL, finding: forEmail(finding, recentLabels), activityUrl }),
          `finding ${finding.id}`,
        );
      }

      const day = new Date(now).toISOString().slice(0, 10);
      if (new Date(now).getUTCHours() >= DIGEST_HOUR_UTC && (await claimDigest(db, day))) {
        const review = recent.filter((f) => f.severity === 'digest' && f.digestedAt == null);
        if (review.length > 0) {
          await markDigested(db, review.map((f) => f.id), now);
          await send(
            buildActivityDigestEmail({
              envLabel: ENV_LABEL,
              findings: review.map((f) => forEmail(f, recentLabels)),
              alreadyEmailed: recent
                .filter((f) => f.severity === 'high' && f.detectedAt > now - DAY_MS)
                .map((f) => forEmail(f, recentLabels)),
              periodEnd: now,
              activityUrl,
            }),
            'digest',
          );
        }
      }
    }

    await writeScannedThrough(db, end);
    return NextResponse.json({ ok: true, rowsScanned: rows.length, findingsCreated: created.length, emailsSent });
  } catch (error) {
    return apiError(error, 'cron/activity-watch');
  }
}
