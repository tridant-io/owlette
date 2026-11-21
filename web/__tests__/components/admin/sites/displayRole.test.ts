/** @jest-environment node */

/**
 * site-scoped role labelling.
 *
 * Guards rosco's rule: `superadmin` is internal vocabulary and must never reach
 * a customer's screen. A superadmin listed on a site reads as `admin` — the tier
 * they behave as there — so a regression that leaks the platform word fails here
 * rather than in front of a customer.
 */

import { displayRole } from '@/components/admin/sites/displayRole';

describe('displayRole', () => {
  it('keeps owner distinct', () => {
    expect(displayRole('owner')).toBe('owner');
  });

  it('collapses superadmin into admin', () => {
    expect(displayRole('superadmin')).toBe('admin');
  });

  it('passes admin and member through', () => {
    expect(displayRole('admin')).toBe('admin');
    expect(displayRole('member')).toBe('member');
  });

  it('never returns the platform tier for any per-site role', () => {
    const roles = ['owner', 'superadmin', 'admin', 'member'] as const;
    for (const role of roles) {
      expect(displayRole(role)).not.toBe('superadmin');
    }
  });
});
