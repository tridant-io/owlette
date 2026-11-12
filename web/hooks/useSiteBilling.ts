'use client';

import { useCallback, useMemo } from 'react';
import { usePlan } from '@/hooks/usePlan';
import { useSitePlan } from '@/hooks/useSitePlan';
import type { SiteBilling } from '@/lib/sitePlanResponse';

/**
 * the owner's changes to a site's billing (adr 0018): upgrade, switch plan,
 * stop, and the confirm after checkout. a change that lands reloads the site's
 * plan and the account plan, which every gate and the billing section read.
 * nothing here throws: a refusal comes back with the problem's `code` and
 * `detail`. a change is sent once: a refusal is never asked again at another
 * price, since the card on file would be billed a price the owner has not seen.
 */

export type BillingTier = SiteBilling['tier'];

export interface BillingRefusal {
  ok: false;
  /** the http status; 0 when the request got no answer. */
  status: number;
  /** the problem's `code`, empty when it carried none. */
  code: string;
  detail: string;
}

export type UpgradeResult =
  | { ok: true; checkoutUrl: string }
  | { ok: true; added: true }
  | BillingRefusal;

export type BillingChangeResult = { ok: true; billing: SiteBilling } | BillingRefusal;

export type CheckoutResult =
  | { ok: true; status: 'pending' | 'complete' | 'failed'; tier: BillingTier }
  | BillingRefusal;

type Answer = { ok: true; data: Record<string, unknown> } | BillingRefusal;

async function send(url: string, method: string, body?: unknown): Promise<Answer> {
  try {
    const response = await fetch(url, {
      method,
      cache: 'no-store',
      ...(body === undefined ? {} : { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }),
    });
    const data = (await response.json().catch(() => null)) as Record<string, unknown> | null;
    if (response.ok) return { ok: true, data: data ?? {} };
    return {
      ok: false,
      status: response.status,
      code: typeof data?.code === 'string' ? data.code : '',
      detail: typeof data?.detail === 'string' ? data.detail : `the request failed (${response.status}).`,
    };
  } catch {
    return { ok: false, status: 0, code: '', detail: 'could not reach owlette. check your connection and try again.' };
  }
}

export function useSiteBilling(siteId: string) {
  const { refresh: refreshAccount } = usePlan();
  const { refresh: refreshSite } = useSitePlan(siteId);
  const url = `/api/sites/${encodeURIComponent(siteId)}/billing`;

  const refresh = useCallback(async () => {
    await Promise.all([refreshSite(), refreshAccount()]);
  }, [refreshSite, refreshAccount]);

  /** puts the site on a paid plan, or back on the one it was stopping. */
  const upgrade = useCallback(
    async (tier: BillingTier, founders: boolean): Promise<UpgradeResult> => {
      const answer = await send(url, 'POST', { tier, founders });
      if (!answer.ok) return answer;
      const { checkoutUrl } = answer.data;
      // nothing is billed until the checkout is paid, so there is nothing to reload yet.
      if (typeof checkoutUrl === 'string') return { ok: true, checkoutUrl };
      await refresh();
      return { ok: true, added: true };
    },
    [url, refresh],
  );

  const switchTier = useCallback(
    async (tier: BillingTier, founders: boolean): Promise<BillingChangeResult> => {
      const answer = await send(url, 'PATCH', { tier, founders });
      if (!answer.ok) return answer;
      await refresh();
      return { ok: true, billing: answer.data.billing as SiteBilling };
    },
    [url, refresh],
  );

  const stop = useCallback(async (): Promise<BillingChangeResult> => {
    const answer = await send(url, 'DELETE');
    if (!answer.ok) return answer;
    await refresh();
    return { ok: true, billing: answer.data.billing as SiteBilling };
  }, [url, refresh]);

  /** asks whether a checkout is fulfilled; the server records the site's billing once it is. */
  const confirmCheckout = useCallback(
    async (sessionId: string): Promise<CheckoutResult> => {
      const answer = await send(`/api/billing/checkout/${encodeURIComponent(sessionId)}`, 'GET');
      if (!answer.ok) return answer;
      const { status, tier } = answer.data as { status: 'pending' | 'complete' | 'failed'; tier: BillingTier };
      if (status === 'complete') await refresh();
      return { ok: true, status, tier };
    },
    [refresh],
  );

  return useMemo(
    () => ({ upgrade, switchTier, stop, confirmCheckout }),
    [upgrade, switchTier, stop, confirmCheckout],
  );
}
