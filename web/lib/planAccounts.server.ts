/**
 * server-only plan stores (plan.md, trial and purchase). `firestore.rules` has no
 * rule for either: the catch-all deny covers them, and
 * `__tests__/rules/planCollections.test.ts` holds it there.
 *
 * - `plan_accounts/{uid}`: trial and tridant-link state for an account.
 * - `billing_checkouts/{sessionId}`: what a checkout was started for, so the
 *   return can be matched to the site that asked.
 */

import 'server-only';
import { FieldValue } from 'firebase-admin/firestore';
import { getAdminDb } from '@/lib/firebase-admin';

/** a claim younger than this blocks another trial start, so concurrent reads start one. */
export const TRIAL_CLAIM_WINDOW_MS = 60 * 1000;

export interface PlanAccount {
  trialStartedAt: number | null;
  trialEndsAt: number | null;
  orgId: string | null;
  linkRequired: boolean;
  trialError: string | null;
  claimedAt: number | null;
}

export interface BillingCheckout {
  uid: string;
  siteId: string;
  tier: 'core' | 'pro';
  founders: boolean;
}

const accountRef = (uid: string) => getAdminDb().collection('plan_accounts').doc(uid);

const num = (value: unknown): number | null => (typeof value === 'number' && Number.isFinite(value) ? value : null);
const str = (value: unknown): string | null => (typeof value === 'string' && value ? value : null);

function toAccount(data: Record<string, unknown>): PlanAccount {
  return {
    trialStartedAt: num(data.trialStartedAt),
    trialEndsAt: num(data.trialEndsAt),
    orgId: str(data.orgId),
    linkRequired: data.linkRequired === true,
    trialError: str(data.trialError),
    claimedAt: num(data.claimedAt),
  };
}

export async function getPlanAccount(uid: string): Promise<PlanAccount | null> {
  const snap = await accountRef(uid).get();
  return snap.exists ? toAccount(snap.data() ?? {}) : null;
}

/** true when this caller may start the trial: none recorded, no link needed, no fresh claim. */
export async function claimTrialStart(uid: string, now: number = Date.now()): Promise<boolean> {
  const ref = accountRef(uid);
  return getAdminDb().runTransaction(async (transaction) => {
    const snap = await transaction.get(ref);
    if (snap.exists) {
      const account = toAccount(snap.data() ?? {});
      if (account.trialStartedAt !== null || account.linkRequired) return false;
      if (account.claimedAt !== null && now - account.claimedAt < TRIAL_CLAIM_WINDOW_MS) return false;
    }
    // epoch ms, not a server timestamp: the next claim compares against it.
    transaction.set(ref, { claimedAt: now, updatedAt: FieldValue.serverTimestamp() }, { merge: true });
    return true;
  });
}

/** `endsAtMs` is tridant's `expires_at`, epoch ms. */
export async function recordTrial(uid: string, { orgId, endsAtMs }: { orgId: string; endsAtMs: number }): Promise<void> {
  await accountRef(uid).set(
    {
      trialStartedAt: Date.now(),
      trialEndsAt: endsAtMs,
      orgId,
      linkRequired: false,
      trialError: null,
      updatedAt: FieldValue.serverTimestamp(),
    },
    { merge: true },
  );
}

/** a purchase or a link with no trial. */
export async function recordOrg(uid: string, orgId: string): Promise<void> {
  await accountRef(uid).set(
    { orgId, linkRequired: false, updatedAt: FieldValue.serverTimestamp() },
    { merge: true },
  );
}

export async function markLinkRequired(uid: string): Promise<void> {
  await accountRef(uid).set({ linkRequired: true, updatedAt: FieldValue.serverTimestamp() }, { merge: true });
}

/** also drops the claim the refused attempt left, so the trial can start right after the link. */
export async function clearLinkRequired(uid: string): Promise<void> {
  await accountRef(uid).set(
    { linkRequired: false, claimedAt: null, updatedAt: FieldValue.serverTimestamp() },
    { merge: true },
  );
}

export async function recordTrialError(uid: string, code: string): Promise<void> {
  await accountRef(uid).set({ trialError: code, updatedAt: FieldValue.serverTimestamp() }, { merge: true });
}

export async function recordCheckout(sessionId: string, checkout: BillingCheckout): Promise<void> {
  await getAdminDb()
    .collection('billing_checkouts')
    .doc(sessionId)
    .set({ ...checkout, createdAt: FieldValue.serverTimestamp() });
}

export async function getCheckout(sessionId: string): Promise<BillingCheckout | null> {
  const snap = await getAdminDb().collection('billing_checkouts').doc(sessionId).get();
  if (!snap.exists) return null;
  const data = snap.data() ?? {};
  if (typeof data.uid !== 'string' || typeof data.siteId !== 'string') return null;
  if (data.tier !== 'core' && data.tier !== 'pro') return null;
  return { uid: data.uid, siteId: data.siteId, tier: data.tier, founders: data.founders === true };
}
