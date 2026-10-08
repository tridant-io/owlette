'use client';

/**
 * Tells a payer on a pro trial or on owlette free where they stand, with a way
 * to the plan page. Mounted under the app header beside VerifyEmailBanner.
 *
 * The plan is the signed-in user's own, as the payer for the sites they own,
 * so a member never sees another account's plan here. Renders null while the
 * plan loads, when plans are not enforced, and on core and pro.
 *
 * Tridant id sends no trial end date yet (tridant-id#76), so the trial state
 * has no countdown.
 */

import Link from 'next/link';
import { useState } from 'react';
import { Sparkles, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { IconButton } from '@/components/ui/icon-button';
import { useDevicePrefNumber } from '@/hooks/useDevicePrefFlag';
import { usePlan } from '@/hooks/usePlan';
import { PRICING_FACTS } from '@/lib/product-facts';

/** how long a dismissal holds before the banner returns. */
export const DISMISS_DAYS = 7;
const DISMISS_MS = DISMISS_DAYS * 24 * 60 * 60 * 1000;
/** epoch ms on `users/{uid}/devicePrefs/global`, so a dismissal follows the account across devices. */
export const DISMISSED_AT_FIELD = 'planBannerDismissedAt';

type BannerKind = 'trial' | 'free';

export function TrialBanner() {
  const { plan } = usePlan();
  if (!plan?.enforced || (plan.plan !== 'trial' && plan.plan !== 'free')) return null;
  return <DismissibleBanner kind={plan.plan} />;
}

// split out so the dismissal is read only when there is a banner to show.
function DismissibleBanner({ kind }: { kind: BannerKind }) {
  const dismissedAt = useDevicePrefNumber(DISMISSED_AT_FIELD, 0, 0, Number.MAX_SAFE_INTEGER);
  const [now, setNow] = useState(() => Date.now());

  // a future stamp (clock skew) holds nothing, so it can't hide the banner indefinitely.
  const age = now - dismissedAt.value;
  const dismissed = dismissedAt.value > 0 && age >= 0 && age < DISMISS_MS;
  // held until the stored dismissal is read, so a dismissed banner never flashes in.
  if (!dismissedAt.ready || dismissed) return null;

  const dismiss = () => {
    const at = Date.now();
    setNow(at);
    dismissedAt.setValue(at);
  };

  return (
    <div
      data-testid="trial-banner"
      data-banner-state={kind}
      role="status"
      className="relative z-10 border-b border-border bg-accent-cyan/10"
    >
      <div className="relative mx-auto flex max-w-screen-2xl flex-wrap items-center justify-center gap-x-2 gap-y-1 py-1 pl-4 pr-12 text-sm sm:px-12">
        <Sparkles className="h-4 w-4 shrink-0 text-accent-cyan" aria-hidden />
        {kind === 'trial' ? (
          <span className="text-foreground">you&apos;re on a pro trial.</span>
        ) : (
          <span className="text-foreground">
            you&apos;re on owlette free
            {/* the scope is dropped on a phone so the banner stays one row */}
            <span className="hidden sm:inline">
              {' '}
              — {PRICING_FACTS.free.machines} machine, monitoring only
            </span>
            .
          </span>
        )}
        <Button asChild variant="link" size="sm">
          <Link href="/settings/plan">{kind === 'trial' ? 'view plan' : 'upgrade'}</Link>
        </Button>
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
