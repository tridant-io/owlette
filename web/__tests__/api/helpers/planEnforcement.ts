/**
 * plan enforcement against a faked tridant id, for suites that mock
 * `getSiteEntitlements` from `@/lib/tridantEntitlements.server` and answer per
 * site. jest hoists `jest.mock()`, so each suite declares that mock itself.
 * values are the strings the parser normalises tridant's answer to.
 */
import { PLAN_FLAGS } from '@/lib/plan.server';
import type { Entitlements } from '@/lib/tridantEntitlements.server';

const flags = (value: '0' | '1') => Object.fromEntries(PLAN_FLAGS.map((flag) => [flag, value]));

/** owlette free: tridant's defaults for a site it does not know. */
export const FREE_ENTITLEMENTS: Entitlements = {
  ok: true,
  resolved: false,
  standing: 'expired',
  inGoodStanding: false,
  graceUntil: null,
  ent: { ...flags('0'), 'owlette.machines': '1', 'owlette.sites': '1' },
  epoch: 0,
  orgId: null,
  billing: null,
};

/** a site billed at pro, inside november 2026. */
export const PRO_ENTITLEMENTS: Entitlements = {
  ok: true,
  resolved: true,
  standing: 'active',
  inGoodStanding: true,
  graceUntil: null,
  ent: { ...flags('1'), 'owlette.machines': 'unlimited', 'owlette.sites': 'unlimited' },
  epoch: 1,
  orgId: 'org_1',
  billing: {
    periodStart: Date.UTC(2026, 10, 1),
    periodEnd: Date.UTC(2026, 11, 1),
    endsAt: null,
    cancelAtPeriodEnd: false,
  },
};

/** a site billed at core: remote control; deployments, swoop, hoot and the rest of pro withheld. */
export const CORE_ENTITLEMENTS: Entitlements = {
  ...PRO_ENTITLEMENTS,
  ent: { ...PRO_ENTITLEMENTS.ent, ...flags('0'), 'owlette.control': '1' },
};

/** a site under its owner's trial: pro values, and no billing period. */
export const TRIAL_ENTITLEMENTS: Entitlements = { ...PRO_ENTITLEMENTS, standing: 'trialing', billing: null };

export function enforcePlans(): void {
  process.env.PLAN_ENFORCEMENT = 'on';
  process.env.TRIDANT_API_URL = 'https://api-staging.tridant.io';
  process.env.TRIDANT_LICENSE_KEY = 'tid_license_read_key';
}

export function stopEnforcingPlans(): void {
  delete process.env.PLAN_ENFORCEMENT;
  delete process.env.TRIDANT_API_URL;
  delete process.env.TRIDANT_LICENSE_KEY;
}
