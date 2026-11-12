'use client';

/**
 * the plan picker for one site (adr 0018): upgrade it from owlette free or the
 * trial, or switch a billed site between core and pro. the server decides where
 * an upgrade goes: the owner's first billed site to stripe checkout, a later
 * one straight onto their running subscription.
 *
 * the cards are PlanTierPicker's, and a plan shows its founders price while the
 * account plan says a place is left. when the server answers that the places
 * are taken, the dialog says the list price and waits for a second confirm: the
 * card on file is never billed a price the owner has not seen.
 */

import { useEffect, useState } from 'react';
import { Loader2 } from 'lucide-react';
import { foundersPlaceLeft, PlanTierPicker } from '@/components/plan/PlanTierPicker';
import { EmailUnverifiedNotice, LinkRequiredNotice } from '@/components/plan/UpgradeNotices';
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
  const foundersLeft = (tier: BillingTier) => !soldOut.includes(tier) && foundersPlaceLeft(account, tier);
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

        <PlanTierPicker selected={selected} onSelect={setPicked} foundersLeft={foundersLeft} current={current} />

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
          <LinkRequiredNotice
            testId="upgrade-link-required"
            doing="upgrading a site"
            linkHref={
              account?.linkAvailable
                ? `/api/auth/tridant/link?return=${encodeURIComponent(siteSettingsPath(site.id, 'billing'))}`
                : null
            }
          />
        )}
        {unverified && <EmailUnverifiedNotice testId="upgrade-email-unverified" doing="upgrading a site" />}

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
