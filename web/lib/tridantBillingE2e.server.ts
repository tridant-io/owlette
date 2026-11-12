/**
 * stands in for tridant id's billing api under OWLETTE_E2E. its state lives in
 * firestore so the playwright rig can seed and read it: a billed site is the
 * `e2e_entitlements/site:{siteId}` doc the entitlement seam reads, a checkout
 * is `e2e_billing/{sessionId}`, and the calls with nothing to show are
 * appended to `e2e_billing_calls`.
 */

import 'server-only';
import { randomBytes } from 'crypto';
import { getAdminDb } from '@/lib/firebase-admin';
import { PRICING_FACTS } from '@/lib/product-facts';
import type {
  AddSiteInput,
  BillingFailure,
  BillingResult,
  BillingTier,
  Checkout,
  CheckoutConfirmation,
  CheckoutInput,
  FoundersRemaining,
  LinkInput,
  PRODUCT,
  PushSiteInput,
  Trial,
  TrialInput,
  UsageEntry,
  UsageOutcome,
} from '@/lib/tridantBilling.server';

const DAY_MS = 86_400_000;

const PRO_ONLY_FLAGS = [
  'owlette.deployments',
  'owlette.swoop',
  'owlette.hoot',
  'owlette.roost',
  'owlette.talons',
  'owlette.webhooks',
  'owlette.api_keys',
];

// typed against the real ids, so a renamed product fails to compile here.
const productId = (tier: BillingTier): (typeof PRODUCT)[BillingTier] => `prd_owlette_${tier}`;
const orgFor = (uid: string) => `org_e2e_${uid}`;
const siteDoc = (siteId: string) => getAdminDb().collection('e2e_entitlements').doc(`site:${siteId}`);
const refused = (status: number, code: string): BillingFailure => ({ ok: false, reason: 'rejected', status, code });

/** a tier's values as tridant sends them: flags as booleans, limits as a number or 'unlimited'. */
function entFor(tier: BillingTier): Record<string, boolean | number | string> {
  const pro = tier === 'pro';
  return {
    'owlette.machines': 'unlimited',
    'owlette.sites': pro ? 'unlimited' : 1,
    'owlette.control': true,
    ...Object.fromEntries(PRO_ONLY_FLAGS.map((flag) => [flag, pro])),
  };
}

/** tridant bills calendar months from the 1st, 00:00 utc. */
function monthEnd(now: Date): number {
  return Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1);
}

function billedSite(tier: BillingTier, orgId: string) {
  const now = new Date();
  return {
    resolved: true,
    standing: 'active',
    ent: entFor(tier),
    orgId,
    billing: {
      periodStart: Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1),
      periodEnd: monthEnd(now),
      endsAt: null,
      cancelAtPeriodEnd: false,
    },
  };
}

/** like the client it stands in for, the fake never throws: a firestore failure reads as tridant being down. */
async function guarded<T>(run: () => Promise<BillingResult<T>>): Promise<BillingResult<T>> {
  try {
    return await run();
  } catch {
    return { ok: false, reason: 'unreachable' };
  }
}

function logged<T extends object>(fn: string, args: Record<string, unknown>, answer: T): Promise<BillingResult<T>> {
  return guarded(async () => {
    await getAdminDb().collection('e2e_billing_calls').add({ fn, ...args, at: Date.now() });
    return { ok: true, ...answer };
  });
}

export function startCheckout(input: CheckoutInput): Promise<BillingResult<Checkout>> {
  return guarded(async () => {
    const sessionId = `e2e_${randomBytes(8).toString('hex')}`;
    await getAdminDb().collection('e2e_billing').doc(sessionId).set({
      uid: input.uid,
      siteId: input.siteId,
      tier: input.tier,
      founders: input.founders,
      createdAt: Date.now(),
    });
    // no stripe page: the browser goes straight to the return url, as after a paid checkout.
    return { ok: true, checkoutUrl: input.successUrl.replace('{CHECKOUT_SESSION_ID}', sessionId), sessionId };
  });
}

export function confirmCheckout(sessionId: string): Promise<BillingResult<CheckoutConfirmation>> {
  return guarded(async () => {
    const session = (await getAdminDb().collection('e2e_billing').doc(sessionId).get()).data();
    if (!session) return refused(404, 'checkout_not_found');
    const { uid, siteId, tier, founders } = session as { uid: string; siteId: string; tier: BillingTier; founders: boolean };
    const orgId = orgFor(uid);
    await siteDoc(siteId).set(billedSite(tier, orgId));
    return {
      ok: true,
      status: 'complete',
      orgId,
      sites: [{ siteId, productId: productId(tier), founders, status: 'active', endsAt: null }],
    };
  });
}

export function addSite(input: AddSiteInput): Promise<BillingResult<{ already: boolean }>> {
  return guarded(async () => {
    await siteDoc(input.siteId).set(billedSite(input.tier, orgFor(input.uid)));
    return { ok: true, already: false };
  });
}

export function switchTier(siteId: string, tier: BillingTier): Promise<BillingResult> {
  return guarded(async () => {
    const doc = siteDoc(siteId);
    if (!(await doc.get()).data()?.billing) return refused(404, 'site_not_billed');
    await doc.update({ ent: entFor(tier) });
    return { ok: true };
  });
}

export function stopSite(siteId: string): Promise<BillingResult<{ endsAt: number }>> {
  return guarded(async () => {
    const doc = siteDoc(siteId);
    if (!(await doc.get()).data()?.billing) return refused(404, 'site_not_billed');
    const endsAt = monthEnd(new Date());
    await doc.update({ 'billing.endsAt': endsAt });
    return { ok: true, endsAt };
  });
}

export function startTrial(input: TrialInput): Promise<BillingResult<Trial>> {
  return guarded(async () => {
    const config = (await getAdminDb().collection('e2e_billing_config').doc('trial').get()).data();
    if (Array.isArray(config?.linkRequired) && config.linkRequired.includes(input.uid)) {
      return refused(409, 'link_required');
    }
    return {
      ok: true,
      orgId: orgFor(input.uid),
      expiresAt: Date.now() + PRICING_FACTS.trialDays * DAY_MS,
      already: false,
    };
  });
}

export function reportUsage(
  entries: UsageEntry[],
  asOfMs: number,
): Promise<BillingResult<{ results: UsageOutcome[] }>> {
  return logged('reportUsage', { entries, asOfMs }, {
    results: entries.map(({ siteId }): UsageOutcome => ({ siteId, status: 'recorded', recorded: true })),
  });
}

export function pushSite(input: PushSiteInput): Promise<BillingResult<{ created: boolean; moved: boolean }>> {
  return logged('pushSite', input, { created: true, moved: false });
}

// the id token stays out of the call log, as it stays out of every other log.
export function linkAccount({ uid, orgId }: LinkInput): Promise<BillingResult<{ already: boolean }>> {
  return logged('linkAccount', { uid, orgId }, { already: false });
}

export function unlinkAccount(uid: string): Promise<BillingResult> {
  return logged('unlinkAccount', { uid }, {});
}

export function foundersRemaining(): Promise<BillingResult<FoundersRemaining>> {
  const places = PRICING_FACTS.foundersCohort;
  return Promise.resolve({ ok: true, core: places, pro: places });
}
