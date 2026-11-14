'use client';

/**
 * /settings/plan — the signed-in user's account as an owner who pays for sites
 * (adr 0018): their trial, how much of owlette free they use, each site they
 * own with its plan, and the prices. every 402 `plan_required` points here
 * (`upgradeUrl`).
 *
 * nothing is bought here: each site row links to that site's billing section,
 * where its owner upgrades, switches or stops. linking an existing tridant
 * account comes back here with its result in `?link=`.
 *
 * while plans are not enforced the page says so and nothing else.
 */

import Link from 'next/link';
import { Suspense, useEffect, useId, useRef, useState, type ReactNode } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { CreditCard, Loader2 } from 'lucide-react';
import { useAuth } from '@/contexts/AuthContext';
import { usePlan } from '@/hooks/usePlan';
import { useSendVerification } from '@/hooks/useSendVerification';
import { PageCascade } from '@/components/PageCascade';
import { PageHeader } from '@/components/PageHeader';
import { PlanBadge } from '@/components/plan/PlanBadge';
import { LINK_TRIDANT_HREF } from '@/components/plan/TrialBanner';
import { siteBillingPath } from '@/components/plan/UpgradeGate';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { InlineNotice } from '@/components/ui/inline-notice';
import type { AccountPlanFree, AccountPlanOn, AccountPlanSite } from '@/lib/planResponse';
import { PRICING_FACTS, perMachineMonth } from '@/lib/product-facts';
import { formatDay } from '@/lib/timeUtils';
import { toast } from '@/lib/toast';

const SUPPORT_HREF = 'mailto:support@tridant.io';

/** a billing period starts and ends at a UTC midnight, so its days are UTC days. */
const utcDay = (ms: number) => formatDay(ms, { year: false, utc: true });
// a period ends at the next month's first instant; its last day is the day before.
const lastUtcDay = (endMs: number) => utcDay(endMs - 1);

function plural(n: number, noun: string): string {
  return `${n} ${noun}${n === 1 ? '' : 's'}`;
}

interface TridantAccount {
  id: string;
  name: string;
}

type LinkResult =
  | { kind: 'done' }
  | { kind: 'choose'; accounts: TridantAccount[] }
  | { kind: 'no_org' }
  | { kind: 'failed'; code: string | null };

const ACCOUNT_ID = /^org_[A-Za-z0-9_-]{1,64}$/;
const FAILURE_CODE = /^[a-z0-9_]{1,64}$/;
const MAX_ACCOUNTS = 20;
const ACCOUNT_NAME_MAX = 80;

/**
 * the tridant accounts to choose from, as the link callback put them in the
 * url. anyone can write a url, so whatever is not a well-formed entry is
 * dropped and the names are only ever rendered as text.
 */
function readAccounts(encoded: string | null): TridantAccount[] {
  if (!encoded) return [];
  try {
    const binary = atob(encoded.replace(/-/g, '+').replace(/_/g, '/'));
    const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0));
    const parsed: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
    if (!Array.isArray(parsed)) return [];

    const names = new Map<string, string>();
    for (const entry of parsed) {
      if (names.size >= MAX_ACCOUNTS) break;
      if (typeof entry !== 'object' || entry === null) continue;
      const { id, name } = entry as { id?: unknown; name?: unknown };
      if (typeof id !== 'string' || !ACCOUNT_ID.test(id)) continue;
      const shown = typeof name === 'string' ? name.trim().slice(0, ACCOUNT_NAME_MAX) : '';
      names.set(id, shown || id);
    }
    return Array.from(names, ([id, name]) => ({ id, name }));
  } catch {
    return [];
  }
}

/** the result of linking a tridant account, from /api/auth/tridant/callback. null when the url carries none. */
function readLinkResult(params: { get(name: string): string | null }): LinkResult | null {
  switch (params.get('link')) {
    case 'done':
      return { kind: 'done' };
    case 'no_org':
      return { kind: 'no_org' };
    case 'choose': {
      const accounts = readAccounts(params.get('orgs'));
      return accounts.length > 0 ? { kind: 'choose', accounts } : { kind: 'failed', code: null };
    }
    case 'failed': {
      const code = params.get('code');
      return { kind: 'failed', code: code !== null && FAILURE_CODE.test(code) ? code : null };
    }
    default:
      return null;
  }
}

const NOT_OWNED = "you don't own that tridant account, so it wasn't linked. choose one you own.";
const EXPIRED = 'the link attempt expired before it finished. start it again.';
// a map, not an object: the code comes out of the url, and `constructor` is a key of every object.
const LINK_FAILURES = new Map([
  ['org_not_owned', NOT_OWNED],
  ['owner_required', NOT_OWNED],
  [
    'id_token_not_fresh',
    'that tridant sign-in was more than 10 minutes old, which is too old to link with. link it again and sign in when asked.',
  ],
  [
    'subject_linked_elsewhere',
    'this owlette account is already linked to another tridant account. contact support to move it.',
  ],
  ['access_denied', 'the tridant sign-in was cancelled, so nothing was linked.'],
  ['state_missing', EXPIRED],
  ['state_mismatch', EXPIRED],
  [
    'session_mismatch',
    'you came back signed in to a different owlette account than the one that started linking. nothing was linked.',
  ],
]);

function linkFailure(code: string | null): string {
  if (code === null) return 'linking your tridant account failed. try again.';
  return (
    LINK_FAILURES.get(code) ??
    `linking your tridant account failed (${code}). try again, or contact support with that code.`
  );
}

function LinkNotice({ result }: { result: Exclude<LinkResult, { kind: 'done' }> }) {
  if (result.kind === 'choose') {
    return (
      <InlineNotice data-testid="link-choose">
        <p className="text-sm text-foreground">
          you own more than one tridant account. choose the one to link:
        </p>
        <div className="flex flex-wrap gap-2">
          {result.accounts.map(({ id, name }) => (
            <Button key={id} asChild variant="outline" size="sm" className="max-w-full">
              <a href={`${LINK_TRIDANT_HREF}&org=${id}`}>
                <span className="truncate">{name}</span>
              </a>
            </Button>
          ))}
        </div>
      </InlineNotice>
    );
  }
  return (
    <InlineNotice data-testid={result.kind === 'no_org' ? 'link-no-org' : 'link-failed'}>
      <p className="text-sm text-foreground">
        {result.kind === 'no_org'
          ? "that tridant sign-in doesn't own a tridant account, so there was nothing to link. sign in as the owner and link again."
          : linkFailure(result.code)}
      </p>
    </InlineNotice>
  );
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  const id = useId();
  return (
    <section aria-labelledby={id}>
      <h2 id={id} className="mb-3 text-sm font-medium text-foreground">
        {title}
      </h2>
      {children}
    </section>
  );
}

const ON_FREE = "a site you haven't upgraded is on owlette free.";

function TrialCard({ plan }: { plan: AccountPlanOn }) {
  const { send, sending } = useSendVerification();
  const { status, endsAt } = plan.trial;

  let title: string;
  let detail: string;
  let action: ReactNode = null;
  if (status === 'active') {
    title = endsAt === null ? 'pro trial' : `pro trial until ${formatDay(endsAt)}`;
    detail = "it covers every site you own. when it ends, a site you haven't upgraded goes to owlette free.";
  } else if (status === 'unverified') {
    title = `verify your email to start your ${PRICING_FACTS.trialDays}-day pro trial`;
    detail = 'no card needed. until you do, your account is on owlette free.';
    action = (
      <Button type="button" size="sm" onClick={send} disabled={sending}>
        {sending ? 'sending...' : 'send verification email'}
      </Button>
    );
  } else if (status === 'link_required') {
    title = 'this email already has a tridant account';
    if (plan.linkAvailable) {
      detail =
        "link it to this owlette account to start your pro trial or upgrade a site. you sign in to tridant to confirm it's yours.";
      action = (
        <Button asChild size="sm">
          {/* an api route that redirects to tridant id: a plain anchor, never a prefetched Link */}
          <a href={LINK_TRIDANT_HREF}>link it</a>
        </Button>
      );
    } else {
      detail =
        "it has to be linked to this owlette account before a trial or an upgrade, and linking isn't available here yet.";
      action = (
        <Button asChild variant="outline" size="sm">
          <a href={SUPPORT_HREF}>contact support</a>
        </Button>
      );
    }
  } else if (status === 'ended' && endsAt !== null) {
    title = `your pro trial ended ${formatDay(endsAt)}`;
    detail = ON_FREE;
  } else if (status === 'ended') {
    // an account that was paying before it ever read its plan.
    title = 'no pro trial';
    detail = `this account was already paying for a site, so no trial started. ${ON_FREE}`;
  } else {
    title = "your pro trial hasn't started";
    detail = `owlette tries again when this page loads. until then, ${ON_FREE}`;
  }

  return (
    <Card data-testid="trial-card" data-trial-state={status} className="gap-0 py-0">
      <div className="flex flex-col items-start gap-3 px-4 py-4 sm:flex-row sm:items-center sm:justify-between sm:px-6">
        <div className="min-w-0">
          <p className="text-lg font-semibold text-foreground">{title}</p>
          <p className="mt-1 text-sm text-muted-foreground">{detail}</p>
        </div>
        {action}
      </div>
    </Card>
  );
}

function FreeUsage({ free }: { free: AccountPlanFree }) {
  const usage = [
    { label: 'sites', used: free.sitesUsed, limit: free.sitesLimit },
    { label: 'machines', used: free.machinesUsed, limit: free.machinesLimit },
  ];
  return (
    <Card data-testid="free-usage" className="gap-0 py-0">
      <dl className="grid grid-cols-2 gap-x-6 px-4 py-4 sm:px-6">
        {usage.map(({ label, used, limit }) => (
          <div key={label}>
            <dt className="text-sm text-muted-foreground">{label}</dt>
            <dd className="mt-1 text-lg font-medium text-foreground">
              {limit === null ? `${used} (unlimited)` : `${used} of ${limit}`}
            </dd>
          </div>
        ))}
      </dl>
      <p className="border-t border-border px-4 py-3 text-xs text-muted-foreground sm:px-6">
        the sites you own that aren&apos;t billed or in a trial share this allowance. every further site you
        create goes on core or pro.
      </p>
    </Card>
  );
}

function siteDetails(site: AccountPlanSite): string[] {
  const details: string[] = [];
  if (site.tier === null) {
    const unread =
      site.reason === 'unreachable' || site.reason === 'rejected' || site.reason === 'malformed_response';
    details.push(
      unread ? "unrestricted: its plan couldn't be read just now" : "unrestricted: plans aren't enforced for this site",
    );
  }
  if (site.billing && site.tier !== null && site.tier !== site.billing.tier) {
    details.push(`billed as ${site.billing.tier}`);
  }
  if (site.period) details.push(`billing period ${utcDay(site.period.start)} – ${lastUtcDay(site.period.end)}`);
  if (site.activeMachinesThisPeriod !== null) {
    details.push(
      `${plural(site.activeMachinesThisPeriod, 'active machine')} ${site.period ? 'this period' : 'this month'}`,
    );
  }
  if (site.billing?.endsAt) details.push(`billed until ${lastUtcDay(site.billing.endsAt)}`);
  return details;
}

function Sites({ sites }: { sites: AccountPlanSite[] }) {
  if (sites.length === 0) {
    return (
      <Card className="gap-0 px-4 py-4 sm:px-6">
        <p className="text-sm text-muted-foreground">you don&apos;t own a site yet.</p>
      </Card>
    );
  }
  return (
    <Card className="gap-0 py-0">
      <ul className="divide-y divide-border">
        {sites.map((site) => (
          // no wrap: the details wrap beside the button, so every row keeps its button on the right
          <li
            key={site.siteId}
            data-testid={`plan-site-${site.siteId}`}
            className="flex items-center justify-between gap-x-4 px-4 py-3 sm:px-6"
          >
            <div className="min-w-0 flex-1">
              <div className="flex flex-wrap items-center gap-2">
                <span className="truncate text-sm font-medium text-foreground">{site.name}</span>
                {/* a site whose plan is not enforced has no plan to name */}
                {site.tier !== null && <PlanBadge tier={site.tier} />}
                {site.standing === 'past_due' && <Badge variant="destructive">past due</Badge>}
              </div>
              <p className="mt-1 flex flex-wrap gap-x-3 gap-y-0.5 text-xs text-muted-foreground">
                {siteDetails(site).map((detail) => (
                  <span key={detail}>{detail}</span>
                ))}
              </p>
            </div>
            <Button asChild variant="outline" size="sm">
              <Link href={siteBillingPath(site.siteId)} aria-label={`billing for ${site.name}`}>
                billing
              </Link>
            </Button>
          </li>
        ))}
      </ul>
    </Card>
  );
}

function Prices({ plan }: { plan: AccountPlanOn }) {
  const { portalUrl } = plan;
  return (
    <Card data-testid="plan-prices" className="gap-0 py-0">
      <ul className="divide-y divide-border">
        {(['core', 'pro'] as const).map((tier) => {
          const places = plan.foundersRemaining?.[tier] ?? 0;
          // tridant id keeps the rate for an owner who holds it, past the cap
          const held = plan.foundersHeld?.[tier] === true;
          const founders = perMachineMonth(PRICING_FACTS[tier].founders);
          return (
            // the tier keeps its own column, so a price that wraps stays beside it
            <li key={tier} className="flex items-baseline gap-x-4 px-4 py-3 sm:px-6">
              <span className="w-10 shrink-0 text-sm font-medium text-foreground">{tier}</span>
              <span className="flex min-w-0 flex-wrap gap-x-4 gap-y-1 text-sm">
                <span className="text-foreground">
                  {perMachineMonth(PRICING_FACTS[tier].list)}
                  {/* a narrow column breaks after the comma, never inside "3-machine" */}
                  {tier === 'pro' && (
                    <>
                      , <span className="whitespace-nowrap">{PRICING_FACTS.pro.minMachines}-machine minimum</span>
                    </>
                  )}
                </span>
                {held ? (
                  <span className="text-muted-foreground">your founders price {founders}</span>
                ) : (
                  places > 0 && (
                    <span className="text-muted-foreground">
                      founders price {founders}, {plural(places, 'place')} left
                    </span>
                  )
                )}
              </span>
            </li>
          );
        })}
      </ul>
      <p className="border-t border-border px-4 py-3 text-xs text-muted-foreground sm:px-6">
        each site is billed on its own, {PRICING_FACTS.billingUnit}. {PRICING_FACTS.activeMachine}, and a
        billing period is a calendar month from the 1st, 00:00 UTC. to upgrade a site, or switch or stop
        its billing, open its billing section.
      </p>
      {portalUrl && (
        <p className="border-t border-border px-4 py-3 text-xs text-muted-foreground sm:px-6">
          invoices and your card are in{' '}
          <a
            href={`${portalUrl}/billing`}
            target="_blank"
            rel="noopener noreferrer"
            className="hl-link text-accent-cyan"
          >
            your tridant account
          </a>
          .
        </p>
      )}
    </Card>
  );
}

function PlanSettings() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const { user, loading: authLoading } = useAuth();
  const { plan, loading, error, refresh } = usePlan();
  // read once: the result is dropped from the url below, and the notice outlives it.
  const [linkResult] = useState(() => readLinkResult(searchParams));
  const linkHandled = useRef(false);

  useEffect(() => {
    if (authLoading) return;
    if (!user) router.push('/login');
  }, [user, authLoading, router]);

  useEffect(() => {
    if (!linkResult || linkHandled.current || authLoading || !user) return;
    linkHandled.current = true;
    if (linkResult.kind === 'done') {
      toast.success('your tridant account is linked');
      // a plan read before the link is stale. one not read yet comes after it,
      // and a second read beside it would race it to start the trial.
      if (plan) void refresh();
    }
    // so a reload does not repeat the toast or the notice.
    router.replace('/settings/plan', { scroll: false });
  }, [linkResult, authLoading, user, plan, refresh, router]);

  if (authLoading || !user) return null;

  let body: ReactNode = null;
  if (plan) {
    if (plan.enforced) {
      body = (
        <div className="space-y-6">
          {linkResult && linkResult.kind !== 'done' && <LinkNotice result={linkResult} />}
          <Section title="trial">
            <TrialCard plan={plan} />
          </Section>
          <Section title="owlette free">
            <FreeUsage free={plan.free} />
          </Section>
          <Section title="your sites">
            <Sites sites={plan.sites} />
          </Section>
          <Section title="prices">
            <Prices plan={plan} />
          </Section>
        </div>
      );
    }
  } else if (loading) {
    body = (
      <div className="flex justify-center py-12">
        <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" aria-label="loading" />
      </div>
    );
  } else {
    body = (
      <div className="flex flex-wrap items-center gap-3">
        <p className="text-sm text-muted-foreground">{error ?? 'failed to load plan'}</p>
        <Button type="button" size="sm" variant="outline" onClick={() => void refresh()}>
          try again
        </Button>
      </div>
    );
  }

  return (
    <PageCascade className="min-h-screen bg-background sm:pb-24">
      <PageHeader currentPage="plan" />
      <main className="relative z-10 mx-auto max-w-4xl px-4 py-6 sm:px-6 sm:py-8">
        <div className="mb-6">
          <h1 className="flex items-center gap-2 text-2xl font-semibold text-foreground">
            <CreditCard className="h-5 w-5" aria-hidden />
            plan
          </h1>
          {plan &&
            (plan.enforced ? (
              <p className="mt-1 text-sm text-muted-foreground">
                each site has its own plan, and its owner pays for it. this is your account: your trial
                and the sites you own.
              </p>
            ) : (
              <p data-testid="plans-not-active" className="mt-1 text-sm text-muted-foreground">
                plans aren&apos;t active during beta, so every feature is included.
              </p>
            ))}
        </div>
        {body}
      </main>
    </PageCascade>
  );
}

export default function PlanSettingsPage() {
  // useSearchParams needs a suspense boundary above it.
  return (
    <Suspense fallback={null}>
      <PlanSettings />
    </Suspense>
  );
}
