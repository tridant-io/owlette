/**
 * stands in for tridant id's billing api under OWLETTE_E2E. its state lives in
 * firestore so the playwright rig can seed and read it: a billed site is the
 * `e2e_entitlements/site:{siteId}` doc the entitlement seam reads, a checkout
 * is `e2e_billing/{sessionId}`, and the calls with nothing to show are
 * appended to `e2e_billing_calls`. like tridant, it opens a checkout only for a
 * payer with no running subscription, and bills every later site on it at once.
 * a subscription keeps running at no charge once every site on it has stopped,
 * so a payer who ever completed a checkout never gets another.
 */

import 'server-only';
import { randomBytes } from 'crypto';
import { getAdminDb } from '@/lib/firebase-admin';
import { PRICING_FACTS } from '@/lib/product-facts';
import type {
  AddSiteInput,
  BilledSite,
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

// `founders` is the fake's own field: the entitlement seam reads the rest, as tridant's answer.
function billedSite(tier: BillingTier, orgId: string, founders: boolean) {
  const now = new Date();
  return {
    resolved: true,
    standing: 'active',
    ent: entFor(tier),
    orgId,
    founders,
    billing: {
      periodStart: Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1),
      periodEnd: monthEnd(now),
      endsAt: null,
      cancelAtPeriodEnd: false,
    },
  };
}

/** a site billed under `orgId` that has not ended: billing that runs, or a stop still inside its period. */
function runs(seed: Record<string, unknown> | undefined, orgId: string): boolean {
  const billing = seed?.billing as { endsAt?: unknown } | undefined;
  if (seed?.orgId !== orgId || !billing) return false;
  return billing.endsAt === null || (typeof billing.endsAt === 'number' && billing.endsAt > Date.now());
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
    const orgId = orgFor(input.uid);
    const [billed, checkouts] = await Promise.all([
      getAdminDb().collection('e2e_entitlements').where('orgId', '==', orgId).get(),
      getAdminDb().collection('e2e_billing').where('uid', '==', input.uid).get(),
    ]);
    const subscribed =
      billed.docs.some((doc) => runs(doc.data(), orgId)) || checkouts.docs.some((doc) => doc.data().completed === true);
    if (subscribed) return refused(409, 'subscription_exists');
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
    await siteDoc(siteId).set(billedSite(tier, orgId, founders));
    // the payer's subscription from here on, whatever becomes of this site.
    await getAdminDb().collection('e2e_billing').doc(sessionId).update({ completed: true });
    return {
      ok: true,
      status: 'complete',
      orgId,
      sites: [{ siteId, productId: productId(tier), founders, status: 'active', endsAt: null }],
    };
  });
}

export function addSite(input: AddSiteInput): Promise<BillingResult<{ already: boolean; sites: BilledSite[] }>> {
  return guarded(async () => {
    const doc = siteDoc(input.siteId);
    const seed = (await doc.get()).data();
    const billed = (tier: BillingTier, founders: boolean): BilledSite => ({
      siteId: input.siteId,
      productId: productId(tier),
      founders,
      status: 'active',
      endsAt: null,
    });
    // a site billed here, or whose removal is pending, keeps the plan it had, whatever was asked for.
    if (runs(seed, orgFor(input.uid))) {
      const tier: BillingTier = (seed?.ent as Record<string, unknown>)?.['owlette.deployments'] === true ? 'pro' : 'core';
      const already = (seed?.billing as { endsAt: unknown }).endsAt === null;
      if (!already) await doc.update({ 'billing.endsAt': null });
      return { ok: true, already, sites: [billed(tier, seed?.founders === true)] };
    }
    await doc.set(billedSite(input.tier, orgFor(input.uid), input.founders));
    return { ok: true, already: false, sites: [billed(input.tier, input.founders)] };
  });
}

export function switchTier(siteId: string, tier: BillingTier, founders?: boolean): Promise<BillingResult> {
  return guarded(async () => {
    const doc = siteDoc(siteId);
    if (!(await doc.get()).data()?.billing) return refused(404, 'site_not_billed');
    // without `founders`, the site keeps its rate.
    await doc.update({ ent: entFor(tier), ...(founders === undefined ? {} : { founders }) });
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
