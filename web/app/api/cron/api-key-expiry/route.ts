import { NextRequest, NextResponse } from 'next/server';
import { cronSecretMatches } from '@/lib/secretMatches.server';
import { getAdminDb } from '@/lib/firebase-admin';
import { getUserAlertRecipient } from '@/lib/adminUtils.server';
import { getResend, FROM_EMAIL } from '@/lib/resendClient.server';
import {
  buildApiKeyExpiryEmail,
  apiKeyExpiryPhrase,
  safeEmailSubject,
  type ExpiringApiKey,
} from '@/lib/emailTemplates.server';
import { generateUnsubscribeToken } from '@/app/api/unsubscribe/route';
import { apiError } from '@/lib/apiErrorResponse';
import { publicOrigin } from '@/lib/publicOrigin.server';
import { EXPIRATION_WARNING_MS, toEpochMillis } from '@/lib/apiKeyTypes';

/**
 * GET /api/cron/api-key-expiry — emails each owner once per rung of the
 * 14 / 3 / 0 day ladder as their api keys approach expiry. Auth: X-Cron-Secret
 * must equal CRON_SECRET. Dedupe: `expiryNoticedStages` on the user's own key
 * document, stamped BEFORE the send.
 *
 * `usersNotified` counts owners with at least one key due a notice this run;
 * `emailsSent` counts the ones Resend accepted. Opt-outs, deleted accounts and
 * send failures are the difference between the two.
 *
 * Runs on cron-job.org, NOT Railway — register once per environment:
 *   0 8 * * *  GET https://<app>/api/cron/api-key-expiry
 *   Header: X-Cron-Secret: <that environment's CRON_SECRET>
 */

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Notice rungs, in days before expiry. A key is assigned the SMALLEST rung it
 * has fallen inside, so a scan on a day between rungs re-derives the rung
 * already sent and is skipped rather than mailing again.
 *
 * The widest rung is EXPIRATION_WARNING_MS (14 days) on purpose: the first email
 * lands the same day the dashboard row turns amber, so the two never disagree
 * about when a key started expiring.
 */
export const NOTICE_STAGE_DAYS = [0, 3, EXPIRATION_WARNING_MS / DAY_MS] as const;

/**
 * How far PAST expiry a key still earns its final notice. Bounded so the daily
 * scan does not re-read keys that expired months ago on every run — they are
 * dead, the owner has been told, and the sweep will reap their lookups.
 */
const GRACE_AFTER_EXPIRY_MS = DAY_MS;

/** The fields the rung decision reads; normalised out of the stored record. */
export interface ApiKeyExpirySnapshot {
  expiresAt: number | null;
  rotatedAt: number | null;
  revokedAt: number | null;
  noticedStages: number[];
}

export type ExpiryNoticeDecision =
  | {
      action: 'skip';
      reason: 'no-expiry' | 'rotated' | 'revoked' | 'out-of-window' | 'already-noticed';
    }
  | { action: 'notify'; stage: number; daysRemaining: number };

/**
 * Pure per-key notice decision; the GET handler maps it to a stamp and an email.
 *
 * `rotatedAt` and `revokedAt` are skips, not filters, because rotation leaves the
 * superseded document's `expiresAt` untouched and revoke is a soft delete that
 * keeps the document forever — so both classes stay inside the scan window and
 * would otherwise nag about credentials that were already replaced or killed.
 */
export function classifyApiKeyExpiry(
  k: ApiKeyExpirySnapshot,
  now: number
): ExpiryNoticeDecision {
  if (k.expiresAt === null) return { action: 'skip', reason: 'no-expiry' };
  if (k.rotatedAt !== null) return { action: 'skip', reason: 'rotated' };
  if (k.revokedAt !== null) return { action: 'skip', reason: 'revoked' };

  const msRemaining = k.expiresAt - now;
  if (msRemaining > EXPIRATION_WARNING_MS) return { action: 'skip', reason: 'out-of-window' };
  if (msRemaining <= -GRACE_AFTER_EXPIRY_MS) return { action: 'skip', reason: 'out-of-window' };

  const stage = NOTICE_STAGE_DAYS.find((days) => msRemaining <= days * DAY_MS);
  if (stage === undefined) return { action: 'skip', reason: 'out-of-window' };
  if (k.noticedStages.includes(stage)) return { action: 'skip', reason: 'already-noticed' };

  return { action: 'notify', stage, daysRemaining: Math.floor(msRemaining / DAY_MS) };
}

/** One key due a notice, carried from the scan phase into the send phase. */
interface PendingNotice extends ExpiringApiKey {
  /** Owner uid read off `doc.ref.parent.parent.id` — the send phase re-checks it. */
  ownerUid: string;
  ref: FirebaseFirestore.DocumentReference;
  stage: number;
  noticedStages: number[];
}

export async function GET(request: NextRequest) {
  if (!cronSecretMatches(request.headers.get('x-cron-secret'))) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const db = getAdminDb();
  const now = Date.now();
  const byOwner = new Map<string, PendingNotice[]>();
  let keysScanned = 0;

  try {
    // Two range filters on ONE field, so the automatic single-field index serves
    // it and no index deploy gates this route. Do NOT add an equality filter on a
    // nullable field here — that is what made functions/src/apiKeyExpire.ts inert.
    const snap = await db
      .collectionGroup('api_keys')
      .where('expiresAt', '>=', now - GRACE_AFTER_EXPIRY_MS)
      .where('expiresAt', '<=', now + EXPIRATION_WARNING_MS)
      .get();

    keysScanned = snap.size;

    for (const doc of snap.docs) {
      // users/{uid}/api_keys/{keyId} — the grandparent IS the owner. A flat
      // collection-group scan carries no other trustworthy claim of ownership.
      const ownerUid = doc.ref.parent.parent?.id;
      if (!ownerUid) {
        console.error(`[cron/api-key-expiry] key at ${doc.ref.path} has no owner document — skipped`);
        continue;
      }

      const data = doc.data();
      const expiresAt = toEpochMillis(data.expiresAt);
      const noticedStages = Array.isArray(data.expiryNoticedStages)
        ? (data.expiryNoticedStages as unknown[]).filter(
            (s): s is number => typeof s === 'number' && Number.isFinite(s)
          )
        : [];

      const decision = classifyApiKeyExpiry(
        {
          expiresAt,
          rotatedAt: toEpochMillis(data.rotatedAt),
          revokedAt: toEpochMillis(data.revokedAt),
          noticedStages,
        },
        now
      );
      // `notify` implies a non-null expiresAt — the decision's first branch.
      if (decision.action !== 'notify' || expiresAt === null) continue;

      const pending = byOwner.get(ownerUid) ?? [];
      pending.push({
        ownerUid,
        ref: doc.ref,
        stage: decision.stage,
        noticedStages,
        name: typeof data.name === 'string' && data.name ? data.name : '(unnamed key)',
        keyPrefix: typeof data.keyPrefix === 'string' ? data.keyPrefix : 'owk_',
        expiresAt,
        daysRemaining: decision.daysRemaining,
      });
      byOwner.set(ownerUid, pending);
    }
  } catch (error) {
    return apiError(error, 'cron/api-key-expiry');
  }

  const usersNotified = byOwner.size;
  if (usersNotified === 0) {
    return NextResponse.json({ ok: true, keysScanned, usersNotified: 0, emailsSent: 0 });
  }

  const resendClient = getResend();
  const baseUrl = publicOrigin(request);
  let emailsSent = 0;

  for (const [ownerUid, notices] of byOwner) {
    try {
      const recipient = await getUserAlertRecipient(ownerUid, 'apiKeyAlerts');
      if (!recipient) {
        // Deleted, no email, or opted out. Not stamped: an opt-out that is later
        // reversed should still get the remaining rungs.
        continue;
      }

      // The leakage guard. `getUserAlertRecipient` reports the uid it actually
      // read, and every notice carries the uid its document sat under, so one
      // customer's key names can only reach the inbox they belong to.
      if (recipient.userId !== ownerUid || notices.some((n) => n.ownerUid !== ownerUid)) {
        console.error(
          `[cron/api-key-expiry] owner mismatch for ${ownerUid} (resolved ${recipient.userId}) — refusing to send`
        );
        continue;
      }

      if (!resendClient) {
        console.warn('[cron/api-key-expiry] Resend not configured — skipping email');
        continue;
      }

      // Stamp BEFORE the send, per health-check: a scheduler retry or a double
      // registration must not mail the same rung twice. The stated trade is that
      // a send that fails after this loses that one email — a lost notice beats
      // an alert loop, and the next rung still fires.
      for (const notice of notices) {
        await notice.ref.set(
          { expiryNoticedStages: [...notice.noticedStages, notice.stage] },
          { merge: true }
        );
      }

      const unsubscribeUrl = `${baseUrl}/api/unsubscribe?token=${generateUnsubscribeToken(recipient.userId)}`;
      const subject =
        notices.length === 1
          ? `api key "${notices[0].name}" ${apiKeyExpiryPhrase(notices[0].daysRemaining)}`
          : `${notices.length} api keys expiring`;

      const result = await resendClient.emails.send({
        from: FROM_EMAIL,
        to: [recipient.email],
        ...(recipient.ccEmails.length > 0 ? { cc: recipient.ccEmails } : {}),
        subject: safeEmailSubject(subject),
        html: buildApiKeyExpiryEmail(
          notices.map(({ name, keyPrefix, expiresAt, daysRemaining }) => ({
            name,
            keyPrefix,
            expiresAt,
            daysRemaining,
          })),
          unsubscribeUrl
        ),
      });

      if (result.error) {
        console.error(`[cron/api-key-expiry] Resend error for ${recipient.email}:`, result.error);
      } else {
        emailsSent++;
      }
    } catch (error) {
      console.error(`[cron/api-key-expiry] Failed to notify ${ownerUid}:`, error);
    }
  }

  return NextResponse.json({ ok: true, keysScanned, usersNotified, emailsSent });
}
