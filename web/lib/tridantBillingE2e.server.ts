/**
 * stands in for tridant id's billing api under OWLETTE_E2E. its state lives in
 * firestore so the playwright rig can seed and read it: a billed site is the
 * `e2e_entitlements/site:{siteId}` doc the entitlement seam reads, a checkout
 * is `e2e_billing/{sessionId}`, and the calls with nothing to show are
 * appended to `e2e_billing_calls`. like tridant, it opens a checkout only for a
 * payer with no running subscription, and bills every later site on it at once.
 * a subscription keeps running at no charge once every site on it has stopped,
 * so a payer who ever completed a checkout never gets another. the trial start
 * and its preview read `e2e_billing_config/trial`: uids listed in
 * `linkRequired` must link first, and uids in `trialUsed` had their trial.
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
  TrialPreview,
  UsageEntry,
  UsageOutcome,
} from '@/lib/tridantBilling.server';

const DAY_MS = 86_400_000;
/** tridant's `site_settle_hours`: a closed period's invoice stays open this long. */
const SETTLE_MS = DAY_MS;

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
const tierOf = (billing: Record<string, unknown>): BillingTier => (billing.productId === productId('pro') ? 'pro' : 'core');
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
function monthStart(at: Date): number {
  return Date.UTC(at.getUTCFullYear(), at.getUTCMonth(), 1);
}

function monthEnd(at: Date): number {
  return Date.UTC(at.getUTCFullYear(), at.getUTCMonth() + 1, 1);
}

function billedSite(tier: BillingTier, orgId: string, founders: boolean) {
  const now = new Date();
  return {
    resolved: true,
    standing: 'active',
    ent: entFor(tier),
    orgId,
    billing: {
      periodStart: monthStart(now),
      periodEnd: monthEnd(now),
      endsAt: null,
      cancelAtPeriodEnd: false,
      productId: productId(tier),
      founders,
    },
  };
}

/** billing that has not ended: it runs, or a stop is still inside its period. */
function billingRuns(seed: Record<string, unknown> | undefined): boolean {
  const billing = seed?.billing as { endsAt?: unknown } | undefined;
  if (!billing) return false;
  return billing.endsAt === null || (typeof billing.endsAt === 'number' && billing.endsAt > Date.now());
}

/** a site billed under `orgId` that has not ended. */
function runs(seed: Record<string, unknown> | undefined, orgId: string): boolean {
  return seed?.orgId === orgId && billingRuns(seed);
}

/** tridant's refusal of a change to a site's billing: nobody bills it, or the payer named is not its payer. */
async function changeRefused(siteId: string, payerUid: string | undefined): Promise<BillingFailure | null> {
  const seed = (await siteDoc(siteId).get()).data();
  if (!seed?.billing) return refused(404, 'site_not_billed');
  if (payerUid !== undefined && seed.orgId !== orgFor(payerUid)) return refused(409, 'payer_mismatch');
  return null;
}

/** like the client it stands in for, the fake never throws: a firestore failure reads as tridant being down. */
async function guarded<T>(run: () => Promise<BillingResult<T>>): Promise<BillingResult<T>> {
  try {
    return await run();
  } catch {
    return { ok: false, reason: 'unreachable' };
  }
}

function logCall(fn: string, args: Record<string, unknown>) {
  return getAdminDb().collection('e2e_billing_calls').add({ fn, ...args, at: Date.now() });
}

function logged<T extends object>(fn: string, args: Record<string, unknown>, answer: T): Promise<BillingResult<T>> {
  return guarded(async () => {
    await logCall(fn, args);
    return { ok: true, ...answer };
  });
}

async function trialListsFor(uid: string): Promise<{ linkRequired: boolean; trialUsed: boolean }> {
  const config = (await getAdminDb().collection('e2e_billing_config').doc('trial').get()).data();
  const listed = (name: string) => Array.isArray(config?.[name]) && (config[name] as unknown[]).includes(uid);
  return { linkRequired: listed('linkRequired'), trialUsed: listed('trialUsed') };
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
  return guarded<{ already: boolean; sites: BilledSite[] }>(async () => {
    const doc = siteDoc(input.siteId);
    const seed = (await doc.get()).data();
    const billed = (tier: BillingTier, founders: boolean): BilledSite => ({
      siteId: input.siteId,
      productId: productId(tier),
      founders,
      status: 'active',
      endsAt: null,
    });
    // a site billed here already keeps its plan, whatever was asked for; a stopped one still inside its
    // period is billed afresh at the plan asked for, as tridant cancels the stop and applies it.
    const billing = seed?.billing as Record<string, unknown> | undefined;
    if (runs(seed, orgFor(input.uid)) && billing?.endsAt === null) {
      return { ok: true, already: true, sites: [billed(tierOf(billing), billing.founders === true)] };
    }
    await doc.set(billedSite(input.tier, orgFor(input.uid), input.founders));
    return { ok: true, already: false, sites: [billed(input.tier, input.founders)] };
  });
}

export function switchTier(
  siteId: string,
  tier: BillingTier,
  founders?: boolean,
  payerUid?: string,
): Promise<BillingResult> {
  return guarded(async () => {
    const refusal = await changeRefused(siteId, payerUid);
    if (refusal) return refusal;
    // without `founders`, the site keeps its rate.
    await siteDoc(siteId).update({
      ent: entFor(tier),
      'billing.productId': productId(tier),
      ...(founders === undefined ? {} : { 'billing.founders': founders }),
    });
    return { ok: true };
  });
}

export function stopSite(siteId: string, payerUid?: string): Promise<BillingResult<{ endsAt: number }>> {
  return guarded(async () => {
    const refusal = await changeRefused(siteId, payerUid);
    if (refusal) return refusal;
    const endsAt = monthEnd(new Date());
    await siteDoc(siteId).update({ 'billing.endsAt': endsAt });
    return { ok: true, endsAt };
  });
}

export function removeSite(siteId: string): Promise<BillingResult<{ removed: boolean }>> {
  return guarded(async () => {
    const doc = siteDoc(siteId);
    const running = billingRuns((await doc.get()).data());
    await logCall('removeSite', { siteId, answer: running ? 'site_running' : 'removed' });
    if (running) return refused(409, 'site_running');
    await doc.delete();
    return { ok: true, removed: true };
  });
}

export function startTrial(input: TrialInput): Promise<BillingResult<Trial>> {
  return guarded(async () => {
    const { linkRequired, trialUsed } = await trialListsFor(input.uid);
    if (linkRequired) return refused(409, 'link_required');
    if (trialUsed) return refused(409, 'trial_already_used');
    return {
      ok: true,
      orgId: orgFor(input.uid),
      expiresAt: Date.now() + PRICING_FACTS.trialDays * DAY_MS,
      already: false,
    };
  });
}

export function previewTrial(input: TrialInput): Promise<BillingResult<TrialPreview>> {
  return guarded<TrialPreview>(async () => {
    const { linkRequired, trialUsed } = await trialListsFor(input.uid);
    if (linkRequired) return { ok: true, payer: 'link_required', trial: null };
    return { ok: true, payer: 'would_create', trial: trialUsed ? 'used' : 'would_start' };
  });
}

/** recorded into the month of each entry's moment; a closed month settles for a day, then refuses. */
function usageOutcome(siteId: string, asOfMs: number): UsageOutcome {
  const periodEnd = monthEnd(new Date(asOfMs));
  const settlesAt = periodEnd + SETTLE_MS;
  const now = Date.now();
  if (settlesAt <= now) return { siteId, status: 'period_closed', recorded: false, settlesAt: null };
  const settling = periodEnd <= now;
  return { siteId, status: 'recorded', recorded: true, settlesAt: settling ? settlesAt : null };
}

export function reportUsage(
  entries: UsageEntry[],
  asOfMs: number,
): Promise<BillingResult<{ results: UsageOutcome[] }>> {
  // each entry's moment as tridant gets it, so firestore never sees an undefined `asOfMs`.
  const sent = entries.map(({ siteId, machines, asOfMs: own }) => ({ siteId, machines, asOfMs: own ?? asOfMs }));
  return logged('reportUsage', { entries: sent, asOfMs }, {
    results: sent.map((entry) => usageOutcome(entry.siteId, entry.asOfMs)),
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
