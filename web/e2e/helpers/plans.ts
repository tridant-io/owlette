/**
 * plans in the e2e rig (adr 0018). the server runs with PLAN_ENFORCEMENT=on and
 * OWLETTE_E2E=1, so a site's plan is whatever `e2e_entitlements/site:{siteId}`
 * holds, and a site without that doc fails open (playwright.config.ts). the
 * billing fake (`lib/tridantBillingE2e.server.ts`) writes the same docs when a
 * spec buys, switches or stops a plan, and its trial start reads
 * `e2e_billing_config/trial`.
 */

import { expect, type Page } from '@playwright/test';
import { getAdminDb } from './emulator';
import type { TestUser } from './seed';

const PRO_FLAGS = [
  'owlette.deployments',
  'owlette.swoop',
  'owlette.hoot',
  'owlette.roost',
  'owlette.talons',
  'owlette.webhooks',
  'owlette.api_keys',
];

/** as tridant id sends them: flags as booleans. */
function flags(control: boolean, pro: boolean): Record<string, boolean> {
  return { 'owlette.control': control, ...Object.fromEntries(PRO_FLAGS.map((flag) => [flag, pro])) };
}

/** owlette free: tridant's answer for a site nobody pays for. */
export const FREE = {
  resolved: false,
  standing: 'expired',
  ent: { ...flags(false, false), 'owlette.machines': 1, 'owlette.sites': 1 },
};

/** core: control on one site; deployments, swoop, hoot and the rest of pro withheld. */
export const CORE = {
  resolved: true,
  standing: 'active',
  ent: { ...flags(true, false), 'owlette.machines': 'unlimited', 'owlette.sites': 1 },
};

export const siteEntitlements = (siteId: string) => getAdminDb().collection('e2e_entitlements').doc(`site:${siteId}`);

const DAY_MS = 86_400_000;

/**
 * an account whose 14-day trial ended a week ago, as `recordTrial` leaves one:
 * the trial start skips it, so a site it creates once its free site is taken
 * needs a plan. a running trial lets every site through.
 */
export async function endTrial(uid: string): Promise<void> {
  const now = Date.now();
  await getAdminDb()
    .collection('plan_accounts')
    .doc(uid)
    .set({ trialStartedAt: now - 21 * DAY_MS, trialEndsAt: now - 7 * DAY_MS, orgId: `org_e2e_${uid}` });
}

export async function signIn(page: Page, user: TestUser): Promise<void> {
  await page.goto('/login');
  await page.getByLabel(/email/i).fill(user.email);
  await page.getByLabel(/password/i).first().fill(user.password);
  await page.getByRole('button', { name: /sign in with email/i }).click();
  await expect(page).toHaveURL(/\/dashboard/, { timeout: 20_000 });
}

/**
 * removes what reading and changing plans leaves behind for these accounts and
 * sites: the seam docs, the trial record, checkouts, and the fake's records.
 */
export async function clearPlanState(uids: string[], siteIds: string[]): Promise<void> {
  const db = getAdminDb();
  const byUid = await Promise.all(
    ['billing_checkouts', 'e2e_billing', 'e2e_billing_calls'].map((name) =>
      db.collection(name).where('uid', 'in', uids).get(),
    ),
  );
  await Promise.all([
    ...siteIds.map((siteId) => siteEntitlements(siteId).delete()),
    ...uids.map((uid) => db.collection('plan_accounts').doc(uid).delete()),
    ...byUid.flatMap((snap) => snap.docs.map((doc) => doc.ref.delete())),
  ]);
}
