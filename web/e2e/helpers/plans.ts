/**
 * plans in the e2e rig (adr 0018). the server runs with PLAN_ENFORCEMENT=on and
 * OWLETTE_E2E=1, so a site's plan is whatever `e2e_entitlements/site:{siteId}`
 * holds, and a site without that doc fails open (playwright.config.ts). the
 * billing fake (`lib/tridantBillingE2e.server.ts`) writes the same docs when a
 * spec buys, switches or stops a plan, with the billed product and rate in
 * `billing.productId` and `billing.founders`. its trial start and preview read
 * `e2e_billing_config/trial` (`linkRequired`, `trialUsed`: lists of uids).
 */

import { expect, type Page } from '@playwright/test';
import { getAdminDb } from './emulator';
import type { TestUser } from './seed';

const CORE_FLAGS = ['owlette.control', 'owlette.swoop'];

const PRO_FLAGS = [
  'owlette.deployments',
  'owlette.hoot',
  'owlette.roost',
  'owlette.talons',
  'owlette.webhooks',
  'owlette.api_keys',
];

/** as tridant id sends them: flags as booleans. */
function flags(core: boolean, pro: boolean): Record<string, boolean> {
  return {
    ...Object.fromEntries(CORE_FLAGS.map((flag) => [flag, core])),
    ...Object.fromEntries(PRO_FLAGS.map((flag) => [flag, pro])),
  };
}

/** owlette free: tridant's answer for a site nobody pays for. */
export const FREE = {
  resolved: false,
  standing: 'expired',
  ent: { ...flags(false, false), 'owlette.machines': 1, 'owlette.sites': 1 },
};

/** core: control and swoop on one site; deployments, hoot and the rest of pro withheld. */
export const CORE = {
  resolved: true,
  standing: 'active',
  ent: { ...flags(true, false), 'owlette.machines': 'unlimited', 'owlette.sites': 1 },
};

export const siteEntitlements = (siteId: string) => getAdminDb().collection('e2e_entitlements').doc(`site:${siteId}`);

/** the organization the fake bills and starts trials under for an account. */
export const orgFor = (uid: string) => `org_e2e_${uid}`;

export const DAY_MS = 86_400_000;

/**
 * a site under its owner's pro trial: pro's values under the owner's
 * organization, and no billing. `trialEndsAt` (epoch ms) is the end tridant id
 * answers for the trial, as after it extends one.
 */
export function trialing(uid: string, trialEndsAt?: number) {
  return {
    resolved: true,
    standing: 'trialing',
    ent: { ...flags(true, true), 'owlette.machines': 'unlimited', 'owlette.sites': 'unlimited' },
    orgId: orgFor(uid),
    ...(trialEndsAt === undefined ? {} : { trialEndsAt }),
  };
}

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
    .set({ trialStartedAt: now - 21 * DAY_MS, trialEndsAt: now - 7 * DAY_MS, orgId: orgFor(uid) });
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
 * sites: the seam docs, the trial record, checkouts, the fake's records, and the
 * removal record a deleted site's tridant removal leaves.
 */
export async function clearPlanState(uids: string[], siteIds: string[]): Promise<void> {
  const db = getAdminDb();
  const records = await Promise.all([
    ...['billing_checkouts', 'e2e_billing', 'e2e_billing_calls'].map((name) =>
      db.collection(name).where('uid', 'in', uids).get(),
    ),
    // a site's removal is logged with no uid.
    db.collection('e2e_billing_calls').where('siteId', 'in', siteIds).get(),
  ]);
  await Promise.all([
    ...siteIds.map((siteId) => siteEntitlements(siteId).delete()),
    ...siteIds.map((siteId) => db.collection('tridant_site_removals').doc(siteId).delete()),
    ...uids.map((uid) => db.collection('plan_accounts').doc(uid).delete()),
    ...records.flatMap((snap) => snap.docs.map((doc) => doc.ref.delete())),
  ]);
}
