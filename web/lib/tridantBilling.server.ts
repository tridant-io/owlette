/**
 * tridant id's site billing api as owlette calls it: checkout, the trial,
 * linking, billed sites, usage and site registration and removal. the shapes
 * follow tridant-id `internal-docs/api/billing.md` and `entitlements.md`
 * (`POST /v1/sites`, `DELETE /v1/sites/:ref`). never throws, and never logs an
 * email or a token. under OWLETTE_E2E every call is answered by
 * tridantBillingE2e.server.ts instead.
 */

import 'server-only';
import logger from '@/lib/logger';
import { PRICING_FACTS } from '@/lib/product-facts';
import {
  tridantApiUrl,
  tridantFetch,
  type TridantFailure,
  type TridantFailureReason,
  type TridantRequest,
} from '@/lib/tridant.server';
import * as fake from '@/lib/tridantBillingE2e.server';

const PROVIDER = 'owlette';
const REF_PREFIX = `${PROVIDER}:`;

export const PRODUCT = { core: 'prd_owlette_core', pro: 'prd_owlette_pro' } as const;
export type BillingTier = keyof typeof PRODUCT;

export const subjectFor = (uid: string) => `${REF_PREFIX}${uid}`;
export const siteRef = (siteId: string) => `${REF_PREFIX}${siteId}`;

/** tridant's limit per usage call. */
const USAGE_CHUNK = 500;
const FOUNDERS_TTL_MS = 5 * 60_000;
const FOUNDERS_RETRY_MS = 60_000;
const FOUNDERS_TIMEOUT_MS = 5000;

/** `code` is tridant's `error` string and `detail` its `reason`, when the answer carries them. */
export type BillingFailure = {
  ok: false;
  reason: TridantFailureReason;
  status?: number;
  code?: string;
  detail?: string;
};

export type BillingResult<T = object> = ({ ok: true } & T) | BillingFailure;

export type CheckoutInput = {
  uid: string;
  /** the payer's verified email. */
  email: string;
  name: string;
  siteId: string;
  siteName: string;
  tier: BillingTier;
  founders: boolean;
  /** tridant accepts https on the product's own hosts only; stripe fills `{CHECKOUT_SESSION_ID}`. */
  successUrl: string;
  cancelUrl: string;
};
export type Checkout = { checkoutUrl: string; sessionId: string };

export type BilledSite = {
  siteId: string;
  productId: string;
  founders: boolean;
  status: string;
  endsAt: number | null;
};
export type CheckoutConfirmation = {
  status: 'pending' | 'complete' | 'failed';
  /** why a failed purchase failed; tridant has cancelled its stripe subscription. */
  error?: string;
  /** null until the purchase is fulfilled. */
  orgId: string | null;
  sites: BilledSite[];
};

export type AddSiteInput = { uid: string; siteId: string; siteName: string; tier: BillingTier; founders: boolean };
export type TrialInput = { uid: string; email: string; name: string };
export type Trial = { orgId: string; expiresAt: number; already: boolean };

const PREVIEW_PAYERS = ['linked', 'would_create', 'link_required'] as const;
const PREVIEW_TRIALS = ['would_start', 'already', 'already_subscribed', 'used'] as const;
/** `trial` is null when tridant names no outcome, as with `payer: 'link_required'`. */
export type TrialPreview = {
  payer: (typeof PREVIEW_PAYERS)[number];
  trial: (typeof PREVIEW_TRIALS)[number] | null;
  orgId: string | null;
};
export type PushSiteInput = { uid: string; siteId: string; name: string };
export type LinkInput = { uid: string; orgId: string; idToken: string };
/** null: the tier has no founders cap, or tridant does not list it. */
export type FoundersRemaining = { core: number | null; pro: number | null };

const USAGE_STATUSES = [
  'recorded',
  'stale',
  'period_rolled_over',
  'period_closed',
  'site_not_found',
  'site_not_billed',
  'product_not_in_key_scope',
  'invalid_site_ref',
  'invalid_machines',
  'invalid_as_of',
] as const;

/** tridant's per-entry status, or why the entry's chunk got no usable answer. */
export type UsageStatus = (typeof USAGE_STATUSES)[number] | 'unreachable' | 'rejected' | 'malformed_response';
/** `asOfMs` overrides the call's moment for this entry. */
export type UsageEntry = { siteId: string; machines: number; asOfMs?: number };
/**
 * `settling`: recorded into a period that has closed, whose invoice tridant
 * holds open until `settlesAt`. the period, set on a recorded entry only, is
 * the one it landed in.
 */
export type UsageOutcome = {
  siteId: string;
  status: UsageStatus;
  recorded: boolean;
  settling: boolean;
  settlesAt: number | null;
  periodStart: number | null;
  periodEnd: number | null;
};

const e2e = () => process.env.OWLETTE_E2E === '1';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function call(path: string, method: TridantRequest['method'], body?: unknown) {
  return tridantFetch(path, { key: process.env.TRIDANT_LICENSE_KEY, keyName: 'TRIDANT_LICENSE_KEY', method, body });
}

function failure(result: TridantFailure): BillingFailure {
  const body = isRecord(result.json) ? result.json : {};
  return {
    ok: false,
    reason: result.reason,
    ...(result.status === undefined ? {} : { status: result.status }),
    ...(typeof body.error === 'string' ? { code: body.error } : {}),
    ...(typeof body.reason === 'string' ? { detail: body.reason } : {}),
  };
}

/** one call; `parse` answers null when the body lacks what the caller needs. */
async function request<T extends object>(
  path: string,
  method: TridantRequest['method'],
  body: unknown,
  parse: (json: Record<string, unknown>) => T | null,
): Promise<BillingResult<T>> {
  const response = await call(path, method, body);
  if (!response.ok) return failure(response);
  const parsed = parse(isRecord(response.json) ? response.json : {});
  if (!parsed) {
    logger.warn('[tridant] billing answer has an unexpected shape', {
      context: 'tridant',
      // as tridantFetch logs it: a query can carry the payer.
      data: { method, path: path.split('?')[0] },
    });
    return { ok: false, reason: 'malformed_response', status: response.status };
  }
  return { ok: true, ...parsed };
}

const sitePath = (siteId: string) => `/v1/billing/sites/${REF_PREFIX}${encodeURIComponent(siteId)}`;

function parseSites(value: unknown): BilledSite[] | null {
  if (!Array.isArray(value)) return null;
  const sites: BilledSite[] = [];
  for (const entry of value) {
    if (
      !isRecord(entry) ||
      typeof entry.site !== 'string' ||
      typeof entry.product_id !== 'string' ||
      typeof entry.status !== 'string'
    ) {
      return null;
    }
    // a site tridant holds no owlette reference for answers with its own id; it is not one of ours.
    if (!entry.site.startsWith(REF_PREFIX)) continue;
    sites.push({
      siteId: entry.site.slice(REF_PREFIX.length),
      productId: entry.product_id,
      founders: entry.founders === true,
      status: entry.status,
      endsAt: typeof entry.ends_at === 'number' ? entry.ends_at : null,
    });
  }
  return sites;
}

/** the payer's first purchase. `code: 'subscription_exists'` means `addSite` is the call to make. */
export function startCheckout(input: CheckoutInput): Promise<BillingResult<Checkout>> {
  if (e2e()) return fake.startCheckout(input);
  return request(
    '/v1/billing/checkout',
    'POST',
    {
      payer: { subject: subjectFor(input.uid), email: input.email, name: input.name },
      site: { ref: siteRef(input.siteId), name: input.siteName },
      product: PRODUCT[input.tier],
      founders: input.founders,
      success_url: input.successUrl,
      cancel_url: input.cancelUrl,
    },
    (json) =>
      typeof json.checkout_url === 'string' && typeof json.session_id === 'string'
        ? { checkoutUrl: json.checkout_url, sessionId: json.session_id }
        : null,
  );
}

export function confirmCheckout(sessionId: string): Promise<BillingResult<CheckoutConfirmation>> {
  if (e2e()) return fake.confirmCheckout(sessionId);
  return request(`/v1/billing/checkout/${encodeURIComponent(sessionId)}`, 'GET', undefined, (json) => {
    const { status } = json;
    const sites = parseSites(json.sites);
    if (!sites || (status !== 'pending' && status !== 'complete' && status !== 'failed')) return null;
    return {
      status,
      ...(typeof json.error === 'string' ? { error: json.error } : {}),
      orgId: typeof json.org_id === 'string' ? json.org_id : null,
      sites,
    };
  });
}

/** bills another site on the payer's running subscription; no checkout, the card is on file. */
export function addSite(input: AddSiteInput): Promise<BillingResult<{ already: boolean; sites: BilledSite[] }>> {
  if (e2e()) return fake.addSite(input);
  return request(
    '/v1/billing/sites',
    'POST',
    {
      payer: { subject: subjectFor(input.uid) },
      site: { ref: siteRef(input.siteId), name: input.siteName },
      product: PRODUCT[input.tier],
      founders: input.founders,
    },
    // a stopped site still inside its period comes back at the product and rate asked for, with `already: false`.
    (json) => ({ already: json.already === true, sites: parseSites(json.sites) ?? [] }),
  );
}

/**
 * without `founders`, tridant keeps the site's current rate. with `payerUid`,
 * a payer whose organization does not pay for the site gets 409
 * `payer_mismatch`, and nothing changes.
 */
export function switchTier(
  siteId: string,
  tier: BillingTier,
  founders?: boolean,
  payerUid?: string,
): Promise<BillingResult> {
  if (e2e()) return fake.switchTier(siteId, tier, founders, payerUid);
  return request(
    sitePath(siteId),
    'PATCH',
    {
      product: PRODUCT[tier],
      founders,
      ...(payerUid === undefined ? {} : { payer: { subject: subjectFor(payerUid) } }),
    },
    () => ({}),
  );
}

/** the site runs, and is billed, to `endsAt`. `payerUid` as for `switchTier`. */
export function stopSite(siteId: string, payerUid?: string): Promise<BillingResult<{ endsAt: number }>> {
  if (e2e()) return fake.stopSite(siteId, payerUid);
  const payer = payerUid === undefined ? '' : `?payer_subject=${encodeURIComponent(subjectFor(payerUid))}`;
  return request(`${sitePath(siteId)}${payer}`, 'DELETE', undefined, (json) =>
    typeof json.ends_at === 'number' ? { endsAt: json.ends_at } : null,
  );
}

/**
 * forgets the site at tridant. 409 `site_running` while a licence or billing
 * runs on it (a stopped site's billing closes once its period is invoiced);
 * 404 `site_not_found` means it is gone already.
 */
export function removeSite(siteId: string): Promise<BillingResult<{ removed: boolean }>> {
  if (e2e()) return fake.removeSite(siteId);
  return request(`/v1/sites/${REF_PREFIX}${encodeURIComponent(siteId)}`, 'DELETE', undefined, (json) => ({
    removed: json.removed === true,
  }));
}

function trialBody(input: TrialInput) {
  return {
    payer: { subject: subjectFor(input.uid), email: input.email, name: input.name },
    product: PRODUCT.pro,
    days: PRICING_FACTS.trialDays,
  };
}

/**
 * one trial per organization, ever: a repeat answers the first one with `already: true`. one per
 * payer too: a payer whose organization with a trial was closed gets 409 `trial_already_used`.
 */
export function startTrial(input: TrialInput): Promise<BillingResult<Trial>> {
  if (e2e()) return fake.startTrial(input);
  return request('/v1/billing/trial', 'POST', trialBody(input), (json) => {
    const expiresAt = isRecord(json.license) ? json.license.expires_at : null;
    return typeof json.org_id === 'string' && typeof expiresAt === 'number'
      ? { orgId: json.org_id, expiresAt, already: json.already === true }
      : null;
  });
}

/** what `startTrial` would answer, without writing anything. */
export function previewTrial(input: TrialInput): Promise<BillingResult<TrialPreview>> {
  if (e2e()) return fake.previewTrial(input);
  return request('/v1/billing/trial/preview', 'POST', trialBody(input), (json) => {
    const payer = PREVIEW_PAYERS.find((known) => known === json.payer);
    if (!payer) return null;
    return {
      payer,
      trial: PREVIEW_TRIALS.find((known) => known === json.trial) ?? null,
      orgId: typeof json.org_id === 'string' ? json.org_id : null,
    };
  });
}

const numberOrNull = (value: unknown) => (typeof value === 'number' ? value : null);

function unanswered(siteId: string, status: UsageStatus): UsageOutcome {
  return { siteId, status, recorded: false, settling: false, settlesAt: null, periodStart: null, periodEnd: null };
}

/**
 * machines active at each site so far in its billing period, counted at
 * `asOfMs` or the entry's own. one outcome per entry, in the order given; a
 * chunk tridant did not answer marks its entries with the reason, and the
 * other chunks still go.
 */
export async function reportUsage(
  entries: UsageEntry[],
  asOfMs: number,
): Promise<BillingResult<{ results: UsageOutcome[] }>> {
  if (e2e()) return fake.reportUsage(entries, asOfMs);
  const results: UsageOutcome[] = [];
  for (let start = 0; start < entries.length; start += USAGE_CHUNK) {
    const chunk = entries.slice(start, start + USAGE_CHUNK);
    const response = await call('/v1/usage', 'POST', {
      sites: chunk.map((entry) => ({
        site: siteRef(entry.siteId),
        machines: entry.machines,
        as_of: entry.asOfMs ?? asOfMs,
      })),
    });
    if (!response.ok) {
      if (response.reason === 'not_configured') return failure(response);
      const status = response.reason;
      results.push(...chunk.map(({ siteId }) => unanswered(siteId, status)));
      continue;
    }
    // tridant answers per entry, in the order sent.
    const answers = isRecord(response.json) && Array.isArray(response.json.results) ? response.json.results : [];
    chunk.forEach(({ siteId }, index) => {
      const answer: unknown = answers[index];
      const status =
        isRecord(answer) && answer.site === siteRef(siteId)
          ? USAGE_STATUSES.find((known) => known === answer.status)
          : undefined;
      if (status === undefined || !isRecord(answer)) {
        results.push(unanswered(siteId, 'malformed_response'));
        return;
      }
      // on period_closed and period_rolled_over, tridant's period is the subscription's current one, not the entry's.
      const recorded = status === 'recorded';
      results.push({
        siteId,
        status,
        recorded: answer.recorded === true,
        settling: answer.settling === true,
        settlesAt: numberOrNull(answer.settles_at),
        periodStart: recorded ? numberOrNull(answer.period_start) : null,
        periodEnd: recorded ? numberOrNull(answer.period_end) : null,
      });
    });
  }
  return { ok: true, results };
}

/**
 * registers the site under the owner's organization, or renames it there. a
 * site that cannot move yet answers 409 `site_belongs_to_another_org`, with
 * `detail` naming why (`site_running`, `site_is_default`, `subject_not_of_provider`).
 */
export function pushSite(input: PushSiteInput): Promise<BillingResult<{ created: boolean; moved: boolean }>> {
  if (e2e()) return fake.pushSite(input);
  return request(
    '/v1/sites',
    'POST',
    { subject: subjectFor(input.uid), provider: PROVIDER, external_id: input.siteId, name: input.name },
    (json) => ({ created: json.created === true, moved: json.moved === true }),
  );
}

/** `idToken` is the organization owner's consent, fresh within ten minutes. */
export function linkAccount(input: LinkInput): Promise<BillingResult<{ already: boolean }>> {
  if (e2e()) return fake.linkAccount(input);
  return request(
    '/v1/billing/link',
    'POST',
    { subject: subjectFor(input.uid), org_id: input.orgId, id_token: input.idToken },
    (json) => ({ already: json.already === true }),
  );
}

/** forgets the mapping only; the organization, its sites and their billing stay. */
export function unlinkAccount(uid: string): Promise<BillingResult> {
  if (e2e()) return fake.unlinkAccount(uid);
  return request(`/v1/billing/link/${REF_PREFIX}${encodeURIComponent(uid)}`, 'DELETE', undefined, () => ({}));
}

let founders: { expiresAt: number; result: Promise<BillingResult<FoundersRemaining>> } | null = null;

/** tridant's public catalogue, so no key goes out with it. */
async function fetchFounders(): Promise<BillingResult<FoundersRemaining>> {
  const base = tridantApiUrl();
  if (!base) return { ok: false, reason: 'not_configured' };
  let status: number;
  let json: unknown;
  try {
    const response = await fetch(`${base}/v1/products`, {
      headers: { Accept: 'application/json' },
      signal: AbortSignal.timeout(FOUNDERS_TIMEOUT_MS),
    });
    status = response.status;
    json = await response.json().catch(() => undefined);
  } catch {
    return { ok: false, reason: 'unreachable' };
  }
  if (status === 429 || status >= 500) return { ok: false, reason: 'unreachable', status };
  if (status < 200 || status >= 300) return { ok: false, reason: 'rejected', status };
  const products = isRecord(json) ? json.products : null;
  if (!Array.isArray(products)) return { ok: false, reason: 'malformed_response', status };

  const remaining = (productId: string): number | null => {
    const product: unknown = products.find((entry) => isRecord(entry) && entry.id === productId);
    return isRecord(product) && typeof product.founders_remaining === 'number' ? product.founders_remaining : null;
  };
  return { ok: true, core: remaining(PRODUCT.core), pro: remaining(PRODUCT.pro) };
}

/** founders places left per tier, cached for five minutes. checkout counts again, so this only decides what to offer. */
export function foundersRemaining(): Promise<BillingResult<FoundersRemaining>> {
  if (e2e()) return fake.foundersRemaining();
  const now = Date.now();
  if (founders && founders.expiresAt > now) return founders.result;

  const entry = { expiresAt: now + FOUNDERS_TTL_MS, result: fetchFounders() };
  founders = entry;
  // a failure is kept for a minute, not five, so an outage costs one timeout a minute and ends when tridant is back.
  void entry.result.then((result) => {
    if (!result.ok) entry.expiresAt = now + FOUNDERS_RETRY_MS;
  });
  return entry.result;
}

export function __resetForTests(): void {
  founders = null;
}
