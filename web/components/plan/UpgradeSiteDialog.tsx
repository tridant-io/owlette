'use client';

/**
 * the plan picker for one site (adr 0018): upgrade it from owlette free or the
 * trial, or switch a billed site between core and pro. the server decides where
 * an upgrade goes: the owner's first billed site to stripe checkout, a later
 * one straight onto their running subscription.
 *
 * prices are PRICING_FACTS, and a plan shows its founders price while the
 * account plan says a place is left. when the server answers that the places
 * are taken, the dialog says the list price and waits for a second confirm: the
 * card on file is never billed a price the owner has not seen.
 */

import { useEffect, useState } from 'react';
import { Check, Loader2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { InlineNotice } from '@/components/ui/inline-notice';
import { usePlan } from '@/hooks/usePlan';
import { useSiteBilling, type BillingTier } from '@/hooks/useSiteBilling';
import { PRICING_FACTS, usd } from '@/lib/product-facts';
import { siteSettingsPath } from '@/lib/siteSettingsPath';
import { toast } from '@/lib/toast';
import { cn } from '@/lib/utils';

const TIERS: readonly BillingTier[] = ['core', 'pro'];

const FEATURES: Record<BillingTier, readonly string[]> = {
  core: [
    'everything in owlette free',
    'remote control: commands, process restart and kill, display restore, screenshots',
    'unlimited machines on this site',
  ],
  pro: ['everything in core', 'deployments and roost', 'swoop, hoot and talons', 'webhooks and API keys'],
};

interface UpgradeSiteDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  site: { id: string; name: string };
  /** the plan the site is billed at, which makes this a switch to the other one. */
  current?: BillingTier;
}

export function UpgradeSiteDialog({ open, onOpenChange, site, current }: UpgradeSiteDialogProps) {
  const { plan, refresh: refreshAccount } = usePlan();
  const { upgrade, switchTier } = useSiteBilling(site.id);
  const [picked, setPicked] = useState<BillingTier | null>(null);
  const [submitting, setSubmitting] = useState(false);

  // back from stripe restores this page from the back-forward cache with the request still
  // marked pending, and nothing would ever clear it.
  useEffect(() => {
    const restored = (event: PageTransitionEvent) => {
      if (event.persisted) setSubmitting(false);
    };
    window.addEventListener('pageshow', restored);
    return () => window.removeEventListener('pageshow', restored);
  }, []);
  const [refusal, setRefusal] = useState<'link_required' | 'email_unverified' | null>(null);
  // the plans the server refused the founders rate for: its count can be minutes ahead of the account plan's
  const [soldOut, setSoldOut] = useState<readonly BillingTier[]>([]);

  const account = plan?.enforced ? plan : null;
  const selected = picked ?? (current === 'pro' ? 'core' : 'pro');
  const foundersLeft = (tier: BillingTier) =>
    !soldOut.includes(tier) && (account?.foundersRemaining?.[tier] ?? 0) > 0;
  // a guess at the server's choice, for the wording only: with another site billed, there is no checkout.
  const subscribed =
    !current && !!account?.sites.some((s) => s.siteId !== site.id && s.billing !== null && s.inGoodStanding);
  const linkRequired = refusal === 'link_required' || account?.trial.status === 'link_required';
  const unverified = refusal === 'email_unverified' || account?.emailVerified === false;

  // every close comes through here, so a reopened dialog starts clean
  const close = () => {
    setPicked(null);
    setRefusal(null);
    setSoldOut([]);
    onOpenChange(false);
  };

  const handleOpenChange = (next: boolean) => {
    if (next) onOpenChange(true);
    // a request in flight still answers: closed now, the dialog could be reopened to send a second one
    else if (!submitting) close();
  };

  const submit = async () => {
    setSubmitting(true);
    setRefusal(null);
    const founders = foundersLeft(selected);
    const result = current ? await switchTier(selected, founders) : await upgrade(selected, founders);
    if (result.ok && 'checkoutUrl' in result) {
      // still submitting: the page is leaving for checkout
      window.location.assign(result.checkoutUrl);
      return;
    }
    setSubmitting(false);
    if (!result.ok) {
      if (result.code === 'founders_sold_out' && founders) {
        setSoldOut((tiers) => [...tiers, selected]);
        void refreshAccount();
      } else if (result.code === 'link_required' || result.code === 'email_unverified') {
        setRefusal(result.code);
      } else {
        toast.error(current ? 'could not switch the plan' : 'could not upgrade the site', {
          description: result.detail,
        });
      }
      return;
    }
    toast.success(`${site.name} is on ${selected}`);
    close();
  };

  const action = current ? `switch to ${selected}` : subscribed ? 'upgrade site' : 'continue to checkout';
  const working = current ? 'switching…' : subscribed ? 'upgrading…' : 'starting checkout…';

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className="max-h-[calc(100dvh-2rem)] overflow-y-auto p-4 sm:max-w-2xl sm:p-6">
        <DialogHeader>
          {/* a site name can be one unbroken word wider than a phone */}
          <DialogTitle className="wrap-anywhere">{current ? 'switch plan' : `upgrade ${site.name}`}</DialogTitle>
          <DialogDescription>
            {current
              ? 'the switch is immediate, and the whole billing period is billed at the plan the site is on when it ends.'
              : `billed ${PRICING_FACTS.billingUnit}. ${PRICING_FACTS.activeMachine}.`}
          </DialogDescription>
        </DialogHeader>

        <div role="radiogroup" aria-label="plan" className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          {TIERS.map((tier) => {
            const facts = PRICING_FACTS[tier];
            const founders = foundersLeft(tier);
            const isCurrent = tier === current;
            const isSelected = tier === selected;
            return (
              <button
                key={tier}
                type="button"
                role="radio"
                aria-checked={isSelected}
                disabled={isCurrent}
                onClick={() => setPicked(tier)}
                className={cn(
                  'flex cursor-pointer flex-col rounded-lg border p-3 text-left outline-none transition-colors focus-visible:ring-1 focus-visible:ring-ring/20 disabled:cursor-default disabled:opacity-60 sm:p-4',
                  isSelected ? 'border-accent-cyan/50 bg-accent-cyan/10' : 'border-border bg-background',
                )}
              >
                <span className="flex flex-wrap items-baseline justify-between gap-x-2">
                  <span className="text-base font-semibold text-foreground">{tier}</span>
                  {isCurrent && <span className="text-xs text-muted-foreground">current plan</span>}
                </span>
                <span className="mt-1 flex flex-wrap items-baseline gap-x-1.5">
                  <span className="text-2xl font-bold tabular-nums text-foreground">
                    {usd(founders ? facts.founders : facts.list)}
                  </span>
                  <span className="text-sm text-muted-foreground">{PRICING_FACTS.billingUnit}</span>
                </span>
                {founders && (
                  <span className="mt-0.5 text-xs text-muted-foreground">
                    founders rate. the list price is {usd(facts.list)}.
                  </span>
                )}
                {'minMachines' in facts && (
                  <span className="mt-0.5 text-xs text-muted-foreground">
                    bills at least {facts.minMachines} machines.
                  </span>
                )}
                <ul className="mt-3 flex flex-col gap-1.5">
                  {FEATURES[tier].map((feature) => (
                    <li key={feature} className="flex items-start gap-2 text-xs text-muted-foreground">
                      <Check className="mt-0.5 size-3 shrink-0 text-accent-cyan" aria-hidden="true" />
                      <span>{feature}</span>
                    </li>
                  ))}
                </ul>
              </button>
            );
          })}
        </div>

        {subscribed && (
          <p className="text-xs text-muted-foreground">
            this site goes on your subscription and is billed to the card on file. there is no checkout.
          </p>
        )}

        {soldOut.includes(selected) && (
          <InlineNotice data-testid="upgrade-founders-sold-out">
            <p className="text-sm text-foreground">
              the founders places for {selected} are taken. the price is now {usd(PRICING_FACTS[selected].list)}{' '}
              {PRICING_FACTS.billingUnit}.
            </p>
          </InlineNotice>
        )}
        {linkRequired && (
          <InlineNotice data-testid="upgrade-link-required">
            <p className="text-sm text-foreground">this email already has a tridant account.</p>
            {account?.linkAvailable ? (
              <Button asChild size="sm">
                <a href={`/api/auth/tridant/link?return=${encodeURIComponent(siteSettingsPath(site.id, 'billing'))}`}>
                  link it
                </a>
              </Button>
            ) : (
              <p className="text-sm text-muted-foreground">contact support to link it.</p>
            )}
          </InlineNotice>
        )}
        {unverified && (
          <InlineNotice data-testid="upgrade-email-unverified">
            <p className="text-sm text-foreground">
              verify your email before upgrading a site. the banner at the top of the page sends the verification
              email again.
            </p>
          </InlineNotice>
        )}

        <DialogFooter>
          <Button variant="outline" onClick={() => handleOpenChange(false)} disabled={submitting}>
            cancel
          </Button>
          <Button onClick={() => void submit()} disabled={submitting}>
            {submitting && <Loader2 className="animate-spin" aria-hidden="true" />}
            {submitting ? working : action}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
