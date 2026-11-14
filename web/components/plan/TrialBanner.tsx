'use client';

/**
 * tells a site owner where their account stands and what to do next: a pro
 * trial and the day it ends, an email to verify (which starts the trial), or an
 * email that already has a tridant account (which is linked first). on a page
 * about one site (`siteId`) it also tells anyone who views that site that it is
 * on owlette free. mounted under the app header.
 *
 * the account's states come from the signed-in user's own account plan, which
 * lists only the sites they own (adr 0018), so a member never sees an owner's
 * state here. owlette free is a site's plan (`useSitePlan`), the same for every
 * viewer: its owner gets a link to the site's billing section, anyone else is
 * told to ask the owner. renders null while the plans load, when plans are not
 * enforced, and when neither applies.
 *
 * the unverified state says what verifying gets and carries the resend, so
 * PageHeader leaves VerifyEmailBanner out while it applies: one prompt, not two.
 * a dismissal takes only the trial pitch away: VerifyEmailBanner, which can't
 * be dismissed, is rendered here in its place.
 */

import Link from 'next/link';
import { useState } from 'react';
import { Mail, Sparkles, X } from 'lucide-react';
import type { PlanSite } from '@/components/plan/MachinePlanNotice';
import { ASK_OWNER, siteBillingPath } from '@/components/plan/UpgradeGate';
import { Button } from '@/components/ui/button';
import { IconButton } from '@/components/ui/icon-button';
import { VerifyEmailBanner } from '@/components/VerifyEmailBanner';
import { useDevicePrefNumber } from '@/hooks/useDevicePrefFlag';
import { useEmailVerifiedOnReturn } from '@/hooks/useEmailVerifiedOnReturn';
import { usePlan } from '@/hooks/usePlan';
import { useSendVerification } from '@/hooks/useSendVerification';
import { useSitePlan } from '@/hooks/useSitePlan';
import type { AccountPlanOn, AccountPlanResponse } from '@/lib/planResponse';
import { PRICING_FACTS } from '@/lib/product-facts';
import type { SitePlanResponse } from '@/lib/sitePlanResponse';
import { formatDay } from '@/lib/timeUtils';

/** how long a dismissal holds before the banner returns. */
export const DISMISS_DAYS = 7;
const DISMISS_MS = DISMISS_DAYS * 24 * 60 * 60 * 1000;
/** epoch ms on `users/{uid}/devicePrefs/global`, so a dismissal follows the account across devices. */
export const DISMISSED_AT_FIELD = 'planBannerDismissedAt';

/** starts linking an existing tridant account; the result comes back to the plan page in `?link=`. */
export const LINK_TRIDANT_HREF = '/api/auth/tridant/link?return=/settings/plan';

export type PlanBannerKind = 'unverified' | 'link' | 'trial' | 'free';

/**
 * the banner's state, before any dismissal. null is no banner. `site` is the
 * plan of the site the page is about; without one there is no free state.
 */
export function planBannerKind(
  plan: AccountPlanResponse | undefined,
  site?: SitePlanResponse,
): PlanBannerKind | null {
  // the account plan lists only the sites the user owns, so none means not an owner.
  if (plan?.enforced && plan.sites.length > 0) {
    if (plan.trial.status === 'unverified') return 'unverified';
    if (plan.trial.status === 'link_required') return 'link';
    if (plan.sites.some((owned) => owned.tier === 'trial')) return 'trial';
  }
  return site?.enforced && site.tier === 'free' ? 'free' : null;
}

export function TrialBanner({ siteId }: { siteId?: string }) {
  const { plan, refresh } = usePlan();
  const { plan: site } = useSitePlan(siteId);
  const kind = planBannerKind(plan, site);

  // once this tab comes back verified, the next plan read starts the trial, whether or not the banner was dismissed.
  useEmailVerifiedOnReturn(kind === 'unverified', refresh);

  if (!kind) return null;
  return (
    <DismissibleBanner
      kind={kind}
      account={plan?.enforced ? plan : null}
      site={siteId ? { siteId, isOwner: !!site?.isOwner } : null}
    />
  );
}

function PlanLink({ label, href = '/settings/plan' }: { label: string; href?: string }) {
  return (
    <Button asChild variant="link" size="sm">
      <Link href={href}>{label}</Link>
    </Button>
  );
}

function SendVerificationLink() {
  const { send, sending } = useSendVerification();
  return (
    <Button
      type="button"
      variant="link"
      size="sm"
      onClick={send}
      disabled={sending}
      aria-label="send verification email"
    >
      {sending ? (
        'sending...'
      ) : (
        <>
          <span className="sm:hidden">send link</span>
          <span className="hidden sm:inline">send verification email</span>
        </>
      )}
    </Button>
  );
}

// split out so the dismissal is read only when there is a banner to show.
function DismissibleBanner({
  kind,
  account,
  site,
}: {
  kind: PlanBannerKind;
  account: AccountPlanOn | null;
  site: PlanSite | null;
}) {
  const dismissedAt = useDevicePrefNumber(DISMISSED_AT_FIELD, 0, 0, Number.MAX_SAFE_INTEGER);
  const [now, setNow] = useState(() => Date.now());

  // a future stamp (clock skew) holds nothing, so it can't hide the banner indefinitely.
  const age = now - dismissedAt.value;
  const dismissed = dismissedAt.value > 0 && age >= 0 && age < DISMISS_MS;
  // held until the stored dismissal is read, so a dismissed banner never flashes in.
  if (!dismissedAt.ready) return null;
  // the unverified prompt stood in for VerifyEmailBanner, so dismissing it must not leave an owner with neither.
  if (dismissed) return kind === 'unverified' ? <VerifyEmailBanner /> : null;

  const dismiss = () => {
    const at = Date.now();
    setNow(at);
    dismissedAt.setValue(at);
  };

  const Icon = kind === 'unverified' ? Mail : Sparkles;
  const trialEndsAt = account?.trial.status === 'active' ? account.trial.endsAt : null;

  return (
    <div
      data-testid="trial-banner"
      data-banner-state={kind}
      role="status"
      className="relative z-10 border-b border-border bg-accent-cyan/10"
    >
      {/* each state has shorter copy below sm to keep to one row on a phone; past that it wraps, never clips */}
      <div className="relative mx-auto flex max-w-screen-2xl flex-wrap items-center justify-center gap-x-2 gap-y-1 py-1 pl-4 pr-12 text-sm sm:px-12">
        <Icon className="h-4 w-4 shrink-0 text-accent-cyan" aria-hidden />
        {kind === 'unverified' && (
          <>
            <span className="text-foreground">
              <span className="sm:hidden">verify to start your pro trial.</span>
              <span className="hidden sm:inline">
                verify your email to start your {PRICING_FACTS.trialDays}-day pro trial.
              </span>
            </span>
            <SendVerificationLink />
          </>
        )}
        {kind === 'link' && (
          <>
            <span className="text-foreground">
              <span className="sm:hidden">you have a tridant account.</span>
              <span className="hidden sm:inline">this email already has a tridant account.</span>
            </span>
            {account?.linkAvailable ? (
              <Button asChild variant="link" size="sm">
                {/* an api route that redirects to tridant id: a plain anchor, never a prefetched Link */}
                <a href={LINK_TRIDANT_HREF}>link it</a>
              </Button>
            ) : (
              <PlanLink label="view plan" />
            )}
          </>
        )}
        {kind === 'trial' && (
          <>
            <span className="text-foreground">
              <span className="hidden sm:inline">you&apos;re on a </span>
              pro trial{trialEndsAt === null ? '' : ` until ${formatDay(trialEndsAt, { year: false })}`}.
            </span>
            <PlanLink label="view plan" />
          </>
        )}
        {kind === 'free' && (
          <>
            <span className="text-foreground">
              this site is on owlette free
              {/* the scope, and whom anyone but the owner should ask, are dropped on a phone */}
              <span className="hidden sm:inline">
                {' '}
                — {PRICING_FACTS.free.machines} machine, monitoring only
              </span>
              .{!site?.isOwner && <span className="hidden sm:inline"> {ASK_OWNER}.</span>}
            </span>
            {site?.isOwner && <PlanLink label="upgrade" href={siteBillingPath(site.siteId)} />}
          </>
        )}
        <IconButton
          label="dismiss"
          tooltip={false}
          variant="ghost"
          size="icon-sm"
          onClick={dismiss}
          className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground"
        >
          <X aria-hidden />
        </IconButton>
      </div>
    </div>
  );
}
