/**
 * a site's billing as its owner changes it (adr 0018): upgrade, switch, stop,
 * and the return from checkout. tridant id bills; `sites/{id}.billing` is a
 * pointer to what it bills, kept for the ui. it is written here, and by an
 * ownership transfer when it stops the outgoing owner's billing. a tridant
 * failure comes back as a refusal for the route to answer, never as a throw.
 */

import 'server-only';
import type { NextResponse } from 'next/server';
import { FieldValue } from 'firebase-admin/firestore';
import { problem, ProblemType } from '@/lib/apiErrors';
import { getAdminAuth, getAdminDb } from '@/lib/firebase-admin';
import logger from '@/lib/logger';
import {
  plansEnforced,
  planTier,
  readBillingPointer,
  resolveSitePlan,
  type BillingPointer,
  type Plan,
} from '@/lib/plan.server';
import {
  getCheckout,
  getPlanAccount,
  markLinkRequired,
  recordCheckout,
  recordOrg,
} from '@/lib/planAccounts.server';
import { trustedBaseUrl } from '@/lib/resendClient.server';
import type { SiteBilling } from '@/lib/sitePlanResponse';
import {
  addSite,
  confirmCheckout,
  PRODUCT,
  startCheckout,
  stopSite,
  switchTier,
  type BillingFailure,
  type BillingTier,
} from '@/lib/tridantBilling.server';
import { invalidateSiteEntitlements } from '@/lib/tridantEntitlements.server';

export type BillingRefusal = { ok: false; status: 403 | 404 | 409 | 502 | 503; code: string; detail: string };

export type UpgradeResult = { ok: true; checkoutUrl: string } | { ok: true; added: true } | BillingRefusal;
export type BillingChange = { ok: true; billing: SiteBilling } | BillingRefusal;
export type CheckoutOutcome =
  | { ok: true; status: 'pending' | 'complete' | 'failed'; siteId: string; tier: BillingTier; error?: string }
  | BillingRefusal;

type SiteData = Record<string, unknown>;

const refuse = (status: BillingRefusal['status'], code: string, detail: string): BillingRefusal => ({
  ok: false,
  status,
  code,
  detail,
});

const UNAVAILABLE = refuse(503, 'billing_unavailable', 'billing is not available right now. try again later.');
const NOT_OWNER = refuse(403, 'not_owner', "only the site owner can change a site's billing.");
const NOT_BILLED = refuse(404, 'not_billed', 'this site is not billed.');
const CHECKOUT_NOT_FOUND = refuse(404, 'not_found', 'checkout not found');
const PREVIOUS_OWNER = refuse(
  409,
  'billed_by_previous_owner',
  'this site is billed to its previous owner until the billing period ends. you can change its plan after that.',
);

/** tridant's refusals an owner can act on, answered 409 under tridant's own code. */
const CONFLICTS = new Map([
  ['link_required', 'your email already has a tridant account. link it, then try again.'],
  ['site_billed_elsewhere', 'this site is already billed under another tridant account.'],
  ['founders_sold_out', 'the founders places for this plan are taken.'],
  ['site_is_default', 'this site belongs to another tridant account and cannot move to yours.'],
  ['subscription_paused', 'your subscription is paused. resume it before adding a site.'],
]);

const PROBLEMS: Record<BillingRefusal['status'], { type: string; title: string }> = {
  403: { type: ProblemType.Forbidden, title: 'forbidden' },
  404: { type: ProblemType.NotFound, title: 'not found' },
  409: { type: ProblemType.Conflict, title: 'conflict' },
  502: { type: ProblemType.ServiceUnavailable, title: 'billing unavailable' },
  503: { type: ProblemType.ServiceUnavailable, title: 'billing unavailable' },
};

export function billingProblem({ status, code, detail }: BillingRefusal): NextResponse {
  return problem({ ...PROBLEMS[status], status, code, detail });
}

function refusalFor(failure: BillingFailure, call: string, siteId: string): BillingRefusal {
  const conflict = failure.code === undefined ? undefined : CONFLICTS.get(failure.code);
  if (failure.code && conflict) return refuse(409, failure.code, conflict);
  if (failure.code === 'site_not_billed') return NOT_BILLED;
  if (failure.reason === 'unreachable' || failure.reason === 'not_configured') return UNAVAILABLE;
  // the code only: tridant's body can carry the payer.
  logger.error('[billing] tridant id refused a billing call', {
    context: 'billing',
    data: { call, siteId, reason: failure.reason, status: failure.status, code: failure.code },
  });
  return refuse(502, 'billing_upstream', 'billing answered something unexpected. try again, or contact support.');
}

/** the part of the pointer the ui shows. */
export function billingSummary({ tier, founders, endsAt }: BillingPointer): SiteBilling {
  return { tier, founders, endsAt };
}

/** the cache goes first: if the write fails, the next read still asks tridant what it now bills. */
async function writePointer(siteId: string, pointer: BillingPointer): Promise<void> {
  invalidateSiteEntitlements(siteId);
  // update, not set: a site deleted meanwhile must not come back as a stub.
  await getAdminDb()
    .collection('sites')
    .doc(siteId)
    .update({ billing: { ...pointer, updatedAt: FieldValue.serverTimestamp() } });
}

/** the site, when `uid` owns it. a superadmin holds the capability too, but the payer is always the owner. */
async function ownedSite(siteId: string, uid: string): Promise<SiteData | null> {
  const data = (await getAdminDb().collection('sites').doc(siteId).get()).data();
  return data && data.owner === uid ? data : null;
}

/** what tridant bills for a site, as a pointer. `payerUid` is empty when the organization billed is not the owner's. */
async function liveBilling(siteId: string, site: SiteData, plan?: Plan): Promise<BillingPointer | null> {
  const resolved = plan ?? (await resolveSitePlan(siteId, site));
  if (!resolved.enforced || !resolved.billing) return null;
  const owner = typeof site.owner === 'string' ? site.owner : '';
  const account = owner ? await getPlanAccount(owner) : null;
  return {
    tier: planTier(resolved) === 'pro' ? 'pro' : 'core',
    // tridant's answer does not say; the pointer only labels the ui.
    founders: false,
    payerUid: account?.orgId && account.orgId === resolved.orgId ? owner : '',
    endsAt: resolved.billing.endsAt,
  };
}

/**
 * the site's pointer. a checkout whose return never loaded leaves a billed site
 * with none, so then tridant is asked: the owner must still be able to stop it.
 */
async function billedPointer(siteId: string, site: SiteData): Promise<BillingPointer | null> {
  const pointer = readBillingPointer(site);
  if (pointer) return pointer;
  invalidateSiteEntitlements(siteId);
  return liveBilling(siteId, site);
}

/**
 * puts the site on a paid plan: a stripe checkout for the owner's first billed
 * site, or straight onto their running subscription (the card is on file).
 */
export async function upgradeSite(input: {
  siteId: string;
  uid: string;
  tier: BillingTier;
  founders: boolean;
}): Promise<UpgradeResult> {
  const { siteId, uid, tier, founders } = input;
  if (!plansEnforced()) return UNAVAILABLE;
  const site = await ownedSite(siteId, uid);
  if (!site) return NOT_OWNER;
  const user = await getAdminAuth().getUser(uid);
  if (!user.emailVerified || !user.email) {
    return refuse(403, 'email_unverified', 'verify your email before upgrading a site.');
  }
  const pointer = readBillingPointer(site);
  // after a transfer the outgoing owner pays to the end of the period; tridant would refuse too.
  if (pointer && pointer.payerUid !== uid && (pointer.endsAt === null || pointer.endsAt > Date.now())) {
    return PREVIOUS_OWNER;
  }
  if (pointer?.endsAt === null) {
    return refuse(409, 'already_billed', 'this site is already billed. switch its plan instead.');
  }

  const siteName = typeof site.name === 'string' && site.name ? site.name : siteId;
  // a base url with a trailing slash would make `//admin`, which tridant refuses as a return url.
  const section = `${trustedBaseUrl().replace(/\/+$/, '')}/admin/sites/${siteId}?section=billing`;
  const checkout = await startCheckout({
    uid,
    email: user.email,
    name: user.displayName || user.email.split('@')[0] || user.email,
    siteId,
    siteName,
    tier,
    founders,
    successUrl: `${section}&session_id={CHECKOUT_SESSION_ID}`,
    cancelUrl: section,
  });
  if (checkout.ok) {
    await recordCheckout(checkout.sessionId, { uid, siteId, tier, founders });
    return { ok: true, checkoutUrl: checkout.checkoutUrl };
  }
  if (checkout.code === 'link_required') {
    // so the plan page offers the link, as it does when the trial start hits the same refusal.
    await markLinkRequired(uid);
  }
  if (checkout.code !== 'subscription_exists') return refusalFor(checkout, 'checkout', siteId);

  const added = await addSite({ uid, siteId, siteName, tier, founders });
  if (!added.ok) return refusalFor(added, 'add_site', siteId);
  // a site whose removal was pending resumes at the plan it had, whatever was asked for, so
  // the plan is switched to match before anything is recorded as billed.
  const billed = added.sites.find((entry) => entry.siteId === siteId);
  const billedTier = tierOf(billed?.productId);
  if (billed && billedTier && (billedTier !== tier || billed.founders !== founders)) {
    const switched = await switchTier(siteId, tier, founders);
    if (!switched.ok) {
      await writePointer(siteId, { tier: billedTier, founders: billed.founders, payerUid: uid, endsAt: null });
      return refusalFor(switched, 'switch_tier', siteId);
    }
  }
  await writePointer(siteId, { tier, founders, payerUid: uid, endsAt: null });
  return { ok: true, added: true };
}

/**
 * core to pro or back. without `founders`, the site keeps its rate. refused while
 * plans are off, like an upgrade: only stopping stays open then.
 */
export async function switchSiteTier(input: {
  siteId: string;
  uid: string;
  tier: BillingTier;
  founders?: boolean;
}): Promise<BillingChange> {
  const { siteId, uid, tier, founders } = input;
  if (!plansEnforced()) return UNAVAILABLE;
  const site = await ownedSite(siteId, uid);
  if (!site) return NOT_OWNER;
  const pointer = await billedPointer(siteId, site);
  if (!pointer) return NOT_BILLED;
  // a period is billed at the plan held when its invoice is written, so a new owner
  // switching it would change what the outgoing owner pays.
  if (pointer.payerUid !== uid) return PREVIOUS_OWNER;

  const switched = await switchTier(siteId, tier, founders);
  if (!switched.ok) return refusalFor(switched, 'switch_tier', siteId);
  const next = { ...pointer, tier, founders: founders ?? pointer.founders };
  await writePointer(siteId, next);
  return { ok: true, billing: billingSummary(next) };
}

/** stops billing; the site keeps its plan to `endsAt`, the end of the billing period. */
export async function stopSiteBilling(input: { siteId: string; uid: string }): Promise<BillingChange> {
  const { siteId, uid } = input;
  const site = await ownedSite(siteId, uid);
  if (!site) return NOT_OWNER;
  const pointer = await billedPointer(siteId, site);
  if (!pointer) return NOT_BILLED;

  const stopped = await stopSite(siteId);
  if (!stopped.ok) return refusalFor(stopped, 'stop_site', siteId);
  const next = { ...pointer, endsAt: stopped.endsAt };
  await writePointer(siteId, next);
  return { ok: true, billing: billingSummary(next) };
}

/**
 * stops billing for a site whose pointer names a payer who no longer owns it: an
 * ownership transfer whose stop did not land. the daily job calls it for every
 * site, so the outgoing owner is billed no further than the next run. never throws.
 */
export async function stopStrandedBilling(siteId: string, siteData: SiteData | null | undefined): Promise<void> {
  try {
    const pointer = readBillingPointer(siteData);
    if (!pointer || pointer.endsAt !== null || pointer.payerUid === siteData?.owner) return;
    const stopped = await stopSite(siteId);
    if (stopped.ok) {
      await writePointer(siteId, { ...pointer, endsAt: stopped.endsAt });
    } else if (stopped.code === 'site_not_billed') {
      // tridant bills nothing here, so the pointer is what is stale.
      await writePointer(siteId, { ...pointer, endsAt: Date.now() });
    } else {
      logger.error('[billing] stranded billing not stopped', {
        context: 'billing',
        data: { siteId, reason: stopped.reason, status: stopped.status, code: stopped.code },
      });
    }
  } catch (error) {
    logger.error('[billing] stranded billing check failed', {
      context: 'billing',
      data: { siteId, error: error instanceof Error ? error.message : String(error) },
    });
  }
}

/**
 * writes the pointer for a site tridant bills under its owner's organization and
 * owlette has none for: a checkout whose return never loaded. the daily job calls
 * it with the plan it already read. never throws.
 */
export async function adoptBilling(siteId: string, siteData: SiteData | null | undefined, plan: Plan): Promise<void> {
  try {
    if (!siteData || readBillingPointer(siteData)) return;
    const live = await liveBilling(siteId, siteData, plan);
    if (live?.payerUid) await writePointer(siteId, live);
  } catch (error) {
    logger.warn('[billing] billing pointer not adopted', {
      context: 'billing',
      data: { siteId, error: error instanceof Error ? error.message : String(error) },
    });
  }
}

const tierOf = (productId: string | undefined): BillingTier | undefined =>
  productId === PRODUCT.core ? 'core' : productId === PRODUCT.pro ? 'pro' : undefined;

/** the return from checkout. only the account that started the checkout may confirm it. */
export async function confirmSiteCheckout(uid: string, sessionId: string): Promise<CheckoutOutcome> {
  const checkout = await getCheckout(sessionId);
  // someone else's checkout reads as none at all.
  if (!checkout || checkout.uid !== uid) return CHECKOUT_NOT_FOUND;
  const { siteId } = checkout;

  const confirmation = await confirmCheckout(sessionId);
  if (!confirmation.ok) {
    return confirmation.code === 'checkout_not_found'
      ? CHECKOUT_NOT_FOUND
      : refusalFor(confirmation, 'confirm_checkout', siteId);
  }
  if (confirmation.status !== 'complete') {
    return {
      ok: true,
      status: confirmation.status,
      siteId,
      tier: checkout.tier,
      ...(confirmation.error ? { error: confirmation.error } : {}),
    };
  }

  // tridant lists what it bills now, so a return url opened again after a switch or a stop
  // writes today's state, and a site it no longer bills gets no pointer back.
  const billed = confirmation.sites.find((site) => site.siteId === siteId);
  const tier = tierOf(billed?.productId) ?? checkout.tier;
  if (billed) {
    await writePointer(siteId, { tier, founders: billed.founders, payerUid: uid, endsAt: billed.endsAt });
  } else {
    invalidateSiteEntitlements(siteId);
  }
  if (confirmation.orgId) await recordOrg(uid, confirmation.orgId);
  return { ok: true, status: 'complete', siteId, tier };
}
