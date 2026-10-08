/**
 * plan enforcement against a faked tridant id, for suites that mock
 * `getEntitlements` from `@/lib/tridantEntitlements.server`. jest hoists
 * `jest.mock()`, so each suite declares that mock itself.
 */
import { PLAN_FLAGS } from '@/lib/plan.server';

const flags = (value: '0' | '1') => Object.fromEntries(PLAN_FLAGS.map((flag) => [flag, value]));

/** owlette free: tridant's defaults for an unmapped payer. */
export const FREE_ENTITLEMENTS = {
  ok: true,
  resolved: false,
  standing: 'expired',
  inGoodStanding: false,
  ent: flags('0'),
  epoch: 0,
};

export const PRO_ENTITLEMENTS = {
  ok: true,
  resolved: true,
  standing: 'active',
  inGoodStanding: true,
  ent: flags('1'),
  epoch: 1,
};

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
