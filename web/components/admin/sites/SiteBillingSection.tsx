'use client';

/**
 * site settings → billing (adr 0018), the owner's alone: the site's plan, what
 * it is billed, and the owner's changes to it. stripe checkout returns here
 * with `session_id`, which is confirmed with the server and then dropped from
 * the url.
 *
 * the plan is the site's (`useSitePlan`); the trial's end and the machine count
 * come from the account plan (`usePlan`).
 */

import { useEffect, useState, type ReactNode } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { Loader2 } from 'lucide-react';
import { Panel } from '@/components/admin/Panel';
import { UpgradeSiteDialog } from '@/components/plan/UpgradeSiteDialog';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { usePlan } from '@/hooks/usePlan';
import { useSiteBilling, type BillingTier } from '@/hooks/useSiteBilling';
import { useSitePlan } from '@/hooks/useSitePlan';
import type { AccountPlanOn } from '@/lib/planResponse';
import { FREE_COVERS, PRICING_FACTS, usd } from '@/lib/product-facts';
import type { SiteBilling, SitePlanResponse } from '@/lib/sitePlanResponse';
import { siteSettingsPath } from '@/lib/siteSettingsPath';
import { formatDay } from '@/lib/timeUtils';
import { toast } from '@/lib/toast';
import { cn } from '@/lib/utils';

const POLL_MS = 2_000;
// a checkout still pending after 30 s is left for a reload
const MAX_POLLS = 30_000 / POLL_MS;

type Checkout =
  | { status: 'complete'; tier: BillingTier }
  | { status: 'failed' }
  | { status: 'slow' }
  | { status: 'error'; detail: string };

type Tone = 'info' | 'success' | 'warning' | 'danger';

const TONES: Record<Tone, string> = {
  info: 'border-border bg-secondary/60 text-foreground',
  success: 'border-success-border bg-success-surface text-success',
  warning: 'border-warning-border bg-warning-surface text-warning',
  danger: 'border-danger-border bg-danger-surface text-danger',
};

function Notice({ tone, testId, children }: { tone: Tone; testId: string; children: ReactNode }) {
  return (
    <div
      role={tone === 'danger' ? 'alert' : 'status'}
      data-testid={testId}
      className={cn('flex items-start gap-2 rounded-md border p-3 text-sm', TONES[tone])}
    >
      {children}
    </div>
  );
}

/** a billing period ends on the 1st at 00:00 UTC, so the day it runs to is the one before. */
const lastDay = (endMs: number) => formatDay(endMs - 1, { utc: true });

/** what the site is billed as now: owlette's record of it, while that has not run out. */
function billedAs(plan: SitePlanResponse, now: number): SiteBilling | null {
  const { billing, tier } = plan;
  if (billing && (billing.endsAt === null || billing.endsAt > now)) return billing;
  // a checkout whose return never loaded leaves a billed site with no record, and the server
  // switches or stops it all the same.
  return tier === 'core' || tier === 'pro' ? { tier, founders: false, endsAt: null } : null;
}

/** plans switched off on this deployment, as opposed to tridant id failing to answer for the site. */
const switchedOff = (plan: SitePlanResponse) =>
  !plan.enforced && (plan.reason === 'enforcement_off' || plan.reason === 'not_configured');

export function SiteBillingSection({ site }: { site: { id: string; name: string } }) {
  const router = useRouter();
  const sessionId = useSearchParams().get('session_id');
  const { plan, loading, error, refresh } = useSitePlan(site.id);
  const { plan: account } = usePlan();
  const { confirmCheckout } = useSiteBilling(site.id);
  const [checkout, setCheckout] = useState<Checkout | null>(null);
  const [now] = useState(() => Date.now());
  // tridant id bills a billed site whatever the switch says, so with plans off its owner can still stop it
  const billedWhileOff = !!plan && switchedOff(plan) && billedAs(plan, now) !== null;

  useEffect(() => {
    if (!sessionId) return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let polls = 0;

    const poll = async () => {
      const result = await confirmCheckout(sessionId);
      if (cancelled) return;
      // a request that got no answer, or a 5xx, may only be tridant id catching up.
      const pending = result.ok ? result.status === 'pending' : result.status === 0 || result.status >= 500;
      if (pending) {
        if (++polls > MAX_POLLS) {
          // the session id stays in the url, so a reload asks again.
          setCheckout({ status: 'slow' });
        } else {
          timer = setTimeout(() => void poll(), POLL_MS);
        }
        return;
      }
      if (!result.ok) setCheckout({ status: 'error', detail: result.detail });
      else if (result.status === 'complete') setCheckout({ status: 'complete', tier: result.tier });
      else setCheckout({ status: 'failed' });
      router.replace(siteSettingsPath(site.id, 'billing'), { scroll: false });
    };

    void poll();
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [sessionId, site.id, confirmCheckout, router]);

  return (
    <Panel id="site-section-billing" title="billing" description="this site's plan, and what you are billed for it.">
      <div className="space-y-3">
        {sessionId && !checkout && (
          <Notice tone="info" testId="checkout-confirming">
            <Loader2 className="mt-0.5 size-4 shrink-0 animate-spin" aria-hidden="true" />
            confirming your payment…
          </Notice>
        )}
        {checkout?.status === 'complete' && (
          <Notice tone="success" testId="checkout-complete">
            payment confirmed. this site is on {checkout.tier}.
          </Notice>
        )}
        {checkout?.status === 'failed' && (
          <Notice tone="danger" testId="checkout-failed">
            the payment was not taken, and nothing is billed. try again.
          </Notice>
        )}
        {checkout?.status === 'slow' && (
          <Notice tone="info" testId="checkout-slow">
            the payment is not confirmed yet. it can take a minute: reload this page to check again.
          </Notice>
        )}
        {checkout?.status === 'error' && (
          <Notice tone="danger" testId="checkout-error">
            could not confirm the checkout. {checkout.detail}
          </Notice>
        )}

        {plan && (plan.enforced || billedWhileOff) ? (
          <BillingDetails site={site} plan={plan} account={account?.enforced ? account : null} now={now} />
        ) : loading ? (
          <p role="status" className="flex items-center gap-2 text-sm text-muted-foreground">
            <Loader2 className="size-4 shrink-0 animate-spin" aria-hidden="true" />
            loading this site&apos;s plan…
          </p>
        ) : (
          <>
            {plan ? (
              <Notice tone="info" testId="billing-unrestricted">
                this site&apos;s plan can&apos;t be read right now, so nothing on it is limited and its billing
                can&apos;t be changed here.
              </Notice>
            ) : (
              <Notice tone="danger" testId="billing-error">
                could not read this site&apos;s plan. {error}
              </Notice>
            )}
            <Button variant="outline" onClick={() => void refresh()}>
              try again
            </Button>
          </>
        )}
      </div>
    </Panel>
  );
}

function Fact({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex flex-col gap-x-4 py-1.5 sm:flex-row sm:items-baseline">
      <dt className="shrink-0 text-xs text-muted-foreground sm:w-48">{label}</dt>
      <dd className="min-w-0 text-sm tabular-nums text-foreground">{children}</dd>
    </div>
  );
}

function BillingDetails({
  site,
  plan,
  account,
  now,
}: {
  site: { id: string; name: string };
  plan: SitePlanResponse;
  account: AccountPlanOn | null;
  now: number;
}) {
  const { upgrade, stop } = useSiteBilling(site.id);
  const [picking, setPicking] = useState(false);
  const [confirmingStop, setConfirmingStop] = useState(false);
  const [busy, setBusy] = useState(false);
  // a plan read before the transfer does not say so yet, so the refusal counts too
  const [refusedAsNewOwner, setRefusedAsNewOwner] = useState(false);

  const billing = billedAs(plan, now);
  const endsAt = billing?.endsAt ?? null;
  const onTrial = plan.tier === 'trial';
  const trialEnds = onTrial ? (account?.trial.endsAt ?? null) : null;
  const machines = account?.sites.find((s) => s.siteId === site.id)?.activeMachinesThisPeriod ?? null;
  const previousOwner = plan.isOwner && (plan.billedByPreviousOwner || refusedAsNewOwner);
  // with plans off the server starts no checkout, so a billed site can only be stopped
  const canChange = plan.enforced && plan.isOwner && !previousOwner;
  // the new owner may stop what the previous owner still pays for, and nothing else
  const canStop = plan.isOwner && billing !== null && endsAt === null;
  const minMachines = billing?.tier === 'pro' ? PRICING_FACTS.pro.minMachines : 0;
  const portalUrl = account?.portalUrl ?? null;

  const resume = async () => {
    if (!billing) return;
    setBusy(true);
    const result = await upgrade(billing.tier, billing.founders);
    if (result.ok && 'checkoutUrl' in result) {
      // still busy: the page is leaving for checkout
      window.location.assign(result.checkoutUrl);
      return;
    }
    setBusy(false);
    if (result.ok) {
      toast.success('billing resumed', { description: `${site.name} stays on ${billing.tier}.` });
    } else if (result.code === 'billed_by_previous_owner') {
      setRefusedAsNewOwner(true);
    } else {
      toast.error('could not resume billing', { description: result.detail });
    }
  };

  const confirmStop = async () => {
    setBusy(true);
    const result = await stop();
    setBusy(false);
    if (!result.ok) {
      toast.error('could not stop billing', { description: result.detail });
      return;
    }
    const until = result.billing.endsAt;
    toast.success('billing stopped', {
      description: until === null ? undefined : `${site.name} is billed until ${lastDay(until)}.`,
    });
    setConfirmingStop(false);
  };

  return (
    <>
      <div className="flex flex-wrap items-center gap-1.5">
        {billing ? (
          <Badge>{billing.tier}</Badge>
        ) : onTrial ? (
          <Badge>pro</Badge>
        ) : (
          <Badge variant="secondary">owlette free</Badge>
        )}
        {billing?.founders && <Badge variant="outline">founders rate</Badge>}
        {onTrial && (
          <Badge variant="outline">{trialEnds === null ? 'trial' : `trial until ${formatDay(trialEnds)}`}</Badge>
        )}
        {plan.standing === 'past_due' && (
          <Badge variant="outline" className="border-warning-border bg-warning-surface text-warning">
            past due
          </Badge>
        )}
        {endsAt !== null && <Badge variant="outline">ends {lastDay(endsAt)}</Badge>}
      </div>

      {!plan.enforced && (
        <Notice tone="info" testId="billing-plans-off">
          {`plans are switched off right now, so nothing on this site is limited${canStop ? ', and its billing can be stopped here' : ''}.`}
        </Notice>
      )}
      {plan.standing === 'past_due' && (
        <Notice tone="warning" testId="billing-past-due">
          {/* one child: the notice is a flex row, which would set the link apart from its sentence */}
          <span>
            the last payment for this site failed{plan.inGoodStanding ? '' : ', so it is on owlette free'}. update the
            card in{' '}
            {portalUrl ? (
              <a
                href={`${portalUrl}/billing`}
                target="_blank"
                rel="noopener noreferrer"
                className="hl-link text-accent-cyan"
              >
                your tridant account
              </a>
            ) : (
              'your tridant account'
            )}
            .
          </span>
        </Notice>
      )}
      {previousOwner && (
        <Notice tone="info" testId="billing-previous-owner">
          {endsAt === null
            ? 'this site is still billed to its previous owner. you can upgrade it once that billing has ended.'
            : `this site is billed to its previous owner until ${lastDay(endsAt)}. you can upgrade it after that billing period ends.`}
        </Notice>
      )}
      {!plan.isOwner && (
        <Notice tone="info" testId="billing-not-owner">
          only the site owner can change a site&apos;s billing.
        </Notice>
      )}

      {billing ? (
        <>
          <dl className="divide-y divide-border">
            {plan.period && (
              <Fact label="billing period">
                {formatDay(plan.period.start, { utc: true })} to {lastDay(plan.period.end)}
              </Fact>
            )}
            {machines !== null && (
              <Fact label="active machines this period">
                {machines}
                {machines < minMachines && `, billed as ${minMachines}`}
              </Fact>
            )}
            {/* without owlette's record the rate is not known, so no price is claimed */}
            {plan.billing && (
              <Fact label="price">
                {usd(PRICING_FACTS[billing.tier][billing.founders ? 'founders' : 'list'])} {PRICING_FACTS.billingUnit}
                {billing.founders && ', founders rate'}.{minMachines > 0 && ` pro bills at least ${minMachines} machines.`}
              </Fact>
            )}
          </dl>
          {onTrial && (
            <p className="text-sm text-muted-foreground">
              the pro trial covers this site{trialEnds === null ? '' : ` until ${formatDay(trialEnds)}`}.
            </p>
          )}
          {endsAt !== null && (
            <p className="text-sm text-muted-foreground">
              billed until {lastDay(endsAt)}.
              {plan.enforced && ` this site stays on ${billing.tier} until then, then goes to owlette free.`}
            </p>
          )}
        </>
      ) : onTrial ? (
        <p className="text-sm text-muted-foreground">
          this site is on the pro trial{trialEnds === null ? '' : ` until ${formatDay(trialEnds)}`}. when the trial ends
          it goes to owlette free, unless you upgrade it.
        </p>
      ) : (
        <p className="text-sm text-muted-foreground">this site is on owlette free. it covers {FREE_COVERS}.</p>
      )}

      {(canChange || canStop) && (
        <div className="flex flex-wrap gap-2">
          {!billing ? (
            <Button onClick={() => setPicking(true)}>upgrade</Button>
          ) : endsAt !== null ? (
            <Button onClick={() => void resume()} disabled={busy}>
              {busy ? 'resuming…' : 'resume billing'}
            </Button>
          ) : (
            <>
              {canChange && (
                <Button variant="outline" onClick={() => setPicking(true)}>
                  switch plan
                </Button>
              )}
              <Button variant="outline" onClick={() => setConfirmingStop(true)}>
                stop billing
              </Button>
            </>
          )}
        </div>
      )}

      <UpgradeSiteDialog
        open={picking}
        onOpenChange={setPicking}
        site={site}
        current={billing && endsAt === null ? billing.tier : undefined}
      />

      {/* its own dialog, not ConfirmDialog, which closes before the request answers: a failure has to leave it open */}
      <Dialog
        open={confirmingStop}
        onOpenChange={(next) => {
          if (!busy) setConfirmingStop(next);
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>stop billing</DialogTitle>
            {/* a site name can be one unbroken word wider than a phone */}
            <DialogDescription className="wrap-anywhere">
              {`stop billing ${site.name}? it stays on ${billing?.tier ?? 'its plan'} until ${
                plan.period ? lastDay(plan.period.end) : 'the end of the billing period'
              }, and that billing period is still billed. after that it goes to owlette free.`}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setConfirmingStop(false)} disabled={busy}>
              cancel
            </Button>
            <Button variant="destructive" onClick={() => void confirmStop()} disabled={busy}>
              {busy ? 'stopping…' : 'stop billing'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
