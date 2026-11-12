/**
 * the trial and site registration with tridant id (adr 0018). tridant
 * owns the trial; owlette starts it the first time a verified account reads its
 * plan, then registers the account's sites under the organization it created;
 * new sites are registered at creation, and the daily job repairs the rest.
 * nothing here throws, and no email is logged.
 */

import 'server-only';
import { getAdminAuth, getAdminDb } from '@/lib/firebase-admin';
import logger from '@/lib/logger';
import { plansEnforced, tridantConfigured, type Plan } from '@/lib/plan.server';
import {
  claimTrialStart,
  getPlanAccount,
  markLinkRequired,
  recordSubscribed,
  recordTrial,
  recordTrialError,
} from '@/lib/planAccounts.server';
import { invalidateSiteEntitlements } from '@/lib/tridantEntitlements.server';
import { pushSite, startTrial, type BillingResult } from '@/lib/tridantBilling.server';

const SITE_BATCH = 10;

export type TrialStatus =
  | 'off'
  | 'already_started'
  | 'unverified'
  | 'busy'
  | 'started'
  | 'link_required'
  | 'subscribed'
  | 'error';

export type SiteRegistration = BillingResult<{ created: boolean; moved: boolean }>;

const errorText = (error: unknown) => (error instanceof Error ? error.message : String(error));

function nameFor(displayName: string | undefined, email: string): string {
  return displayName || email.split('@')[0] || email;
}

/** one site. a 409 is expected (the site still runs elsewhere), so only its reason is logged. */
async function pushOne(uid: string, siteId: string, name: string): Promise<SiteRegistration> {
  const result = await pushSite({ uid, siteId, name });
  if (!result.ok) {
    logger.warn('[plan] site registration refused', {
      context: 'plan',
      data: { siteId, reason: result.reason, status: result.status, code: result.code, detail: result.detail },
    });
  }
  invalidateSiteEntitlements(siteId);
  return result;
}

/** registers every site the user owns, ten at a time. */
export async function registerOwnedSites(uid: string): Promise<void> {
  try {
    const snap = await getAdminDb().collection('sites').where('owner', '==', uid).get();
    const sites = snap.docs.map((doc) => {
      const name = doc.data().name;
      return { id: doc.id, name: typeof name === 'string' && name ? name : doc.id };
    });
    for (let start = 0; start < sites.length; start += SITE_BATCH) {
      await Promise.all(
        sites.slice(start, start + SITE_BATCH).map(async (site) => {
          try {
            await pushOne(uid, site.id, site.name);
          } catch (error) {
            logger.warn('[plan] site registration failed', {
              context: 'plan',
              data: { siteId: site.id, error: errorText(error) },
            });
          }
        }),
      );
    }
  } catch (error) {
    logger.warn('[plan] registering owned sites failed', { context: 'plan', data: { uid, error: errorText(error) } });
  }
}

/** a no-op (null) until the owner has an organization to register under. */
export async function registerSite(ownerUid: string, siteId: string, name: string): Promise<SiteRegistration | null> {
  try {
    const account = await getPlanAccount(ownerUid);
    if (!account?.orgId) return null;
    return await pushOne(ownerUid, siteId, name);
  } catch (error) {
    logger.warn('[plan] site registration failed', { context: 'plan', data: { siteId, error: errorText(error) } });
    return { ok: false, reason: 'unreachable' };
  }
}

/** why tridant will never move a site on its own. `site_running` is not one: its period only has to end. */
const STUCK_REASONS = ['site_is_default', 'subject_not_of_provider'];

/**
 * the daily job's repair for a site tridant holds under an organization that is
 * not its owner's: one handed over (adr 0018), or one whose registration never
 * landed. a billed site stays where it is paid for, and tridant moves an idle one.
 */
export async function reconcileSiteRegistration(
  siteId: string,
  siteData: Record<string, unknown>,
  answer: Pick<Extract<Plan, { enforced: true }>, 'resolved' | 'orgId' | 'billing'>,
): Promise<void> {
  try {
    const { owner, name } = siteData;
    if (answer.billing || typeof owner !== 'string' || !owner) return;
    const account = await getPlanAccount(owner);
    if (!account?.orgId || (answer.resolved && answer.orgId === account.orgId)) return;

    // pushOne, not registerSite: the owner's organization is already read.
    const result = await pushOne(owner, siteId, typeof name === 'string' && name ? name : siteId);
    if (result.ok) {
      if (result.moved) logger.info('[plan] site moved to its owner organization', { context: 'plan', data: { siteId } });
    } else if (result.detail && STUCK_REASONS.includes(result.detail)) {
      logger.error('[plan] site cannot move to its owner organization', {
        context: 'plan',
        data: { siteId, detail: result.detail },
      });
    }
  } catch (error) {
    logger.warn('[plan] site registration failed', { context: 'plan', data: { siteId, error: errorText(error) } });
  }
}

/**
 * starts the trial once per account; a failure is recorded and the next plan read retries after the claim window.
 * `beforeEnforcement` is the bulk start's: it runs before the switch, so no site reads free when the gates go on.
 * a plan read never passes it, so ordinary traffic starts no trial while plans are off.
 */
export async function ensureTrial(
  uid: string,
  options?: { beforeEnforcement?: boolean },
): Promise<{ status: TrialStatus }> {
  try {
    if (!(options?.beforeEnforcement ? tridantConfigured() : plansEnforced())) return { status: 'off' };

    const account = await getPlanAccount(uid);
    if (account?.trialStartedAt) return { status: 'already_started' };
    if (account?.linkRequired) return { status: 'link_required' };

    const user = await getAdminAuth().getUser(uid);
    if (!user.emailVerified || !user.email) return { status: 'unverified' };

    if (!(await claimTrialStart(uid))) return { status: 'busy' };

    const result = await startTrial({ uid, email: user.email, name: nameFor(user.displayName, user.email) });
    if (result.ok) {
      await recordTrial(uid, { orgId: result.orgId, endsAtMs: result.expiresAt });
      await registerOwnedSites(uid);
      return { status: 'started' };
    }
    if (result.code === 'link_required') {
      await markLinkRequired(uid);
      return { status: 'link_required' };
    }
    if (result.code === 'already_subscribed') {
      await recordSubscribed(uid);
      return { status: 'subscribed' };
    }
    const code = result.code ?? result.reason;
    await recordTrialError(uid, code);
    logger.warn('[plan] trial start failed', { context: 'plan', data: { uid, code } });
    return { status: 'error' };
  } catch (error) {
    logger.warn('[plan] trial start failed', { context: 'plan', data: { uid, error: errorText(error) } });
    return { status: 'error' };
  }
}
