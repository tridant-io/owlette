/**
 * The pure `computeIsSuperadmin` / `computeIsSiteAdmin` / `shouldListenerBootstrap`
 * helpers, extracted from AuthContext so they test without mounting the provider
 * and its Firebase deps.
 *
 * Role matrix (compute*): {null, member, admin, superadmin} global tier x the
 * caller's PER-SITE role on the site being asked about.
 *
 * `computeIsSiteAdmin` takes a role map now, not a `sites[]` array: site standing
 * is a membership document, and the global role no longer participates beyond
 * superadmin. The `admin` blocks below are where that shows — a global admin with
 * no membership is denied, which is the point of the migration.
 */

import {
  computeIsSuperadmin,
  computeIsSiteAdmin,
  computeAdministersAnySite,
  computeIsSiteOwner,
  computeMachineScope,
  computeIsMachineAdmin,
  computeSiteRole,
  computeSwoopMode,
  shouldListenerBootstrap,
} from '@/contexts/AuthContext';
import type { SiteRole } from '@/hooks/useFirestore';
import type { SwoopMode } from '@/lib/swoopMode';

const SITE_IN = 'site-A';
const SITE_OUT = 'site-B';

const roles = (entries: Record<string, SiteRole>) =>
  new Map<string, SiteRole>(Object.entries(entries));

/** The caller administers site A and has no standing on site B. */
const ADMIN_ON_A = roles({ [SITE_IN]: 'admin' });
/** The caller is a plain member of site A. */
const MEMBER_ON_A = roles({ [SITE_IN]: 'member' });
/** The caller owns site A. */
const OWNER_ON_A = roles({ [SITE_IN]: 'owner' });
/** No memberships at all. */
const NO_SITES = roles({});

describe('computeIsSuperadmin', () => {
  it('is false for null role (pre-auth / missing user doc / listener error)', () => {
    expect(computeIsSuperadmin(null)).toBe(false);
  });

  it('is false for member role', () => {
    expect(computeIsSuperadmin('member')).toBe(false);
  });

  it('is false for site-scoped admin role', () => {
    // The middle tier must NOT be confused with platform god-mode.
    expect(computeIsSuperadmin('admin')).toBe(false);
  });

  it('is true for superadmin role', () => {
    expect(computeIsSuperadmin('superadmin')).toBe(true);
  });
});

describe('computeIsSiteAdmin', () => {
  describe('null global role', () => {
    it('is false even holding an admin membership', () => {
      // Role null means the user document has not resolved. Nothing is granted
      // off a half-loaded session.
      expect(computeIsSiteAdmin(null, ADMIN_ON_A, SITE_IN, new Map())).toBe(false);
    });

    it('is false for a site with no membership', () => {
      expect(computeIsSiteAdmin(null, ADMIN_ON_A, SITE_OUT, new Map())).toBe(false);
    });
  });

  describe('per-site role decides, not the global tier', () => {
    it('is false for a plain member of the site', () => {
      expect(computeIsSiteAdmin('member', MEMBER_ON_A, SITE_IN, new Map())).toBe(false);
    });

    it('is true for a per-site admin', () => {
      expect(computeIsSiteAdmin('member', ADMIN_ON_A, SITE_IN, new Map())).toBe(true);
    });

    it('is true for the site owner (owner outranks admin)', () => {
      expect(computeIsSiteAdmin('member', OWNER_ON_A, SITE_IN, new Map())).toBe(true);
    });

    it('is false for a site the caller holds no membership on', () => {
      expect(computeIsSiteAdmin('member', ADMIN_ON_A, SITE_OUT, new Map())).toBe(false);
    });
  });

  describe('global admin - the headline change', () => {
    it('is FALSE without a membership on the site', () => {
      // Before per-site roles this was true for every site in `sites[]`. A global
      // admin now carries no site privilege it was not explicitly granted.
      expect(computeIsSiteAdmin('admin', NO_SITES, SITE_IN, new Map())).toBe(false);
    });

    it('is false on a site where it is only a member', () => {
      expect(computeIsSiteAdmin('admin', MEMBER_ON_A, SITE_IN, new Map())).toBe(false);
    });

    it('is true only where it holds an admin membership', () => {
      expect(computeIsSiteAdmin('admin', ADMIN_ON_A, SITE_IN, new Map())).toBe(true);
      expect(computeIsSiteAdmin('admin', ADMIN_ON_A, SITE_OUT, new Map())).toBe(false);
    });
  });

  describe('superadmin role (god-mode)', () => {
    it('is true for a site it holds a membership on', () => {
      expect(computeIsSiteAdmin('superadmin', ADMIN_ON_A, SITE_IN, new Map())).toBe(true);
    });

    it('is true for a site it holds no membership on', () => {
      // Mirrors firestore.rules canAccessSite: superadmins short-circuit before
      // the membership term and deliberately hold no member rows.
      expect(computeIsSiteAdmin('superadmin', ADMIN_ON_A, SITE_OUT, new Map())).toBe(true);
    });

    it('is true with no memberships at all', () => {
      expect(computeIsSiteAdmin('superadmin', NO_SITES, SITE_OUT, new Map())).toBe(true);
    });
  });
});

describe('machine scope', () => {
  const scopes = (entries: Record<string, readonly string[]>) =>
    new Map<string, readonly string[]>(Object.entries(entries));
  const NO_SCOPES = scopes({});
  /** the caller's row on site A lists m1 only */
  const SCOPED_ON_A = scopes({ [SITE_IN]: ['m1'] });

  describe('a scoped admin', () => {
    it('is not a site admin', () => {
      expect(computeIsSiteAdmin('member', ADMIN_ON_A, SITE_IN, SCOPED_ON_A)).toBe(false);
    });

    it('is a machine admin on its machine only', () => {
      expect(computeIsMachineAdmin('member', ADMIN_ON_A, SCOPED_ON_A, SITE_IN, 'm1')).toBe(true);
      expect(computeIsMachineAdmin('member', ADMIN_ON_A, SCOPED_ON_A, SITE_IN, 'm2')).toBe(false);
    });

    it('administers no site, unless another site is a whole-site admin row', () => {
      expect(computeAdministersAnySite('member', ADMIN_ON_A, SCOPED_ON_A)).toBe(false);
      const alsoAdminOnB = roles({ [SITE_IN]: 'admin', [SITE_OUT]: 'admin' });
      expect(computeAdministersAnySite('member', alsoAdminOnB, SCOPED_ON_A)).toBe(true);
    });

    it('with no machines is a machine admin nowhere', () => {
      const none = scopes({ [SITE_IN]: [] });
      expect(computeIsMachineAdmin('member', ADMIN_ON_A, none, SITE_IN, 'm1')).toBe(false);
    });
  });

  it('a malformed scoped owner row is not the owner, nor a site admin', () => {
    // owners are never scoped; the server reads such a row as scoped too
    expect(computeIsSiteOwner('member', OWNER_ON_A, SITE_IN, SCOPED_ON_A)).toBe(false);
    expect(computeIsSiteAdmin('member', OWNER_ON_A, SITE_IN, SCOPED_ON_A)).toBe(false);
    expect(computeAdministersAnySite('member', OWNER_ON_A, SCOPED_ON_A)).toBe(false);
  });

  it('a scoped member is a machine admin nowhere, in scope or not', () => {
    expect(computeIsMachineAdmin('member', MEMBER_ON_A, SCOPED_ON_A, SITE_IN, 'm1')).toBe(false);
  });

  it('a whole-site row is unchanged', () => {
    expect(computeIsSiteAdmin('member', ADMIN_ON_A, SITE_IN, NO_SCOPES)).toBe(true);
    expect(computeIsSiteOwner('member', OWNER_ON_A, SITE_IN, NO_SCOPES)).toBe(true);
    expect(computeAdministersAnySite('member', ADMIN_ON_A, NO_SCOPES)).toBe(true);
    expect(computeIsMachineAdmin('member', ADMIN_ON_A, NO_SCOPES, SITE_IN, 'm2')).toBe(true);
    expect(computeIsMachineAdmin('member', MEMBER_ON_A, NO_SCOPES, SITE_IN, 'm1')).toBe(false);
  });

  it("another site's scope does not narrow this one", () => {
    const scopedOnB = scopes({ [SITE_OUT]: ['m1'] });
    expect(computeIsSiteAdmin('member', ADMIN_ON_A, SITE_IN, scopedOnB)).toBe(true);
    expect(computeIsMachineAdmin('member', ADMIN_ON_A, scopedOnB, SITE_IN, 'm2')).toBe(true);
  });

  it('a superadmin is true everywhere, whatever the scope map holds', () => {
    expect(computeIsSiteAdmin('superadmin', ADMIN_ON_A, SITE_IN, SCOPED_ON_A)).toBe(true);
    expect(computeIsSiteOwner('superadmin', ADMIN_ON_A, SITE_IN, SCOPED_ON_A)).toBe(true);
    expect(computeAdministersAnySite('superadmin', ADMIN_ON_A, SCOPED_ON_A)).toBe(true);
    expect(computeIsMachineAdmin('superadmin', ADMIN_ON_A, SCOPED_ON_A, SITE_IN, 'm2')).toBe(true);
    expect(computeIsMachineAdmin('superadmin', NO_SITES, NO_SCOPES, SITE_OUT, 'm9')).toBe(true);
  });

  it('isMachineAdmin is false while the session is unresolved', () => {
    expect(computeIsMachineAdmin(null, ADMIN_ON_A, NO_SCOPES, SITE_IN, 'm1')).toBe(false);
  });

  describe('computeMachineScope', () => {
    it("is the row's machines on a scoped site", () => {
      expect(computeMachineScope('member', SCOPED_ON_A, SITE_IN)).toEqual(['m1']);
    });

    it('is [] for a row that reaches no machines', () => {
      expect(computeMachineScope('member', scopes({ [SITE_IN]: [] }), SITE_IN)).toEqual([]);
    });

    it('is null (whole site) on a site the map does not hold', () => {
      expect(computeMachineScope('member', SCOPED_ON_A, SITE_OUT)).toBeNull();
      expect(computeMachineScope('member', NO_SCOPES, SITE_IN)).toBeNull();
    });

    it('is null for a superadmin', () => {
      expect(computeMachineScope('superadmin', SCOPED_ON_A, SITE_IN)).toBeNull();
    });
  });

  describe('computeSiteRole', () => {
    it("returns the row's role, scoped or not", () => {
      const mixed = roles({ [SITE_IN]: 'admin', [SITE_OUT]: 'member' });
      expect(computeSiteRole(mixed, SITE_IN)).toBe('admin');
      expect(computeSiteRole(mixed, SITE_OUT)).toBe('member');
      // the scoped admin's label still says admin while its gate says no
      expect(computeIsSiteAdmin('member', mixed, SITE_IN, SCOPED_ON_A)).toBe(false);
    });

    it('is null with no row', () => {
      expect(computeSiteRole(NO_SITES, SITE_IN)).toBeNull();
    });
  });
});

describe('computeSwoopMode', () => {
  const modes = (entries: Record<string, SwoopMode>) =>
    new Map<string, SwoopMode>(Object.entries(entries));
  const NO_MODES = modes({});

  it.each<[string, SwoopMode, Map<string, SiteRole>, Map<string, SwoopMode>, boolean]>([
    ['a member set to none', 'none', MEMBER_ON_A, modes({ [SITE_IN]: 'none' }), true],
    ['a member set to watch, members may not watch', 'view', MEMBER_ON_A, modes({ [SITE_IN]: 'view' }), false],
    ['a member with no mode, members may watch', 'view', MEMBER_ON_A, NO_MODES, true],
    ['a member with no mode, members may not watch', 'none', MEMBER_ON_A, NO_MODES, false],
    ['an admin with no mode', 'control', ADMIN_ON_A, NO_MODES, false],
    ['an admin set to none', 'none', ADMIN_ON_A, modes({ [SITE_IN]: 'none' }), true],
    ['the owner, even with a stray none', 'control', OWNER_ON_A, modes({ [SITE_IN]: 'none' }), false],
    ['someone with no row', 'none', NO_SITES, NO_MODES, true],
  ])('%s is %s', (_label, expected, roleMap, swoopMap, membersMayWatch) => {
    expect(computeSwoopMode('member', roleMap, swoopMap, SITE_IN, membersMayWatch)).toBe(expected);
  });

  it('a superadmin controls on a site where they hold no row', () => {
    expect(computeSwoopMode('superadmin', NO_SITES, NO_MODES, SITE_IN, false)).toBe('control');
  });

  it('is none while the session is unresolved', () => {
    expect(computeSwoopMode(null, MEMBER_ON_A, NO_MODES, SITE_IN, true)).toBe('none');
  });

  it("another site's mode does not reach this one", () => {
    const both = roles({ [SITE_IN]: 'member', [SITE_OUT]: 'member' });
    expect(computeSwoopMode('member', both, modes({ [SITE_OUT]: 'none' }), SITE_IN, true)).toBe('view');
  });
});

describe('computeAdministersAnySite', () => {
  const roles = (entries: Record<string, SiteRole>) =>
    new Map<string, SiteRole>(Object.entries(entries));

  it('is true for an owner of any site', () => {
    expect(computeAdministersAnySite('member', roles({ 'site-a': 'owner' }), new Map())).toBe(true);
  });

  it('is true for an admin of any site', () => {
    expect(computeAdministersAnySite('member', roles({ 'site-a': 'admin' }), new Map())).toBe(true);
  });

  it('is false for someone who is only ever a member', () => {
    expect(
      computeAdministersAnySite('member', roles({ 'site-a': 'member', 'site-b': 'member' }), new Map())
    ).toBe(false);
  });

  it('is true for a superadmin holding no memberships', () => {
    expect(computeAdministersAnySite('superadmin', roles({}), new Map())).toBe(true);
  });

  it('is FALSE for a global admin holding no memberships', () => {
    // Before wave 5.1 this user reached every site-scoped admin page, saw an
    // empty list on each, and had every write refused server-side.
    expect(computeAdministersAnySite('admin', roles({}), new Map())).toBe(false);
  });

  it('is false while the session is unresolved', () => {
    expect(computeAdministersAnySite(null, roles({ 'site-a': 'owner' }), new Map())).toBe(false);
  });
});

describe('computeIsSiteOwner', () => {
  const roles = (entries: Record<string, SiteRole>) =>
    new Map<string, SiteRole>(Object.entries(entries));

  it('is true only for the owner row', () => {
    expect(computeIsSiteOwner('member', roles({ 'site-a': 'owner' }), 'site-a', new Map())).toBe(true);
  });

  it('is FALSE for a site admin — SITE_DELETE is the one thing they lack', () => {
    expect(computeIsSiteOwner('member', roles({ 'site-a': 'admin' }), 'site-a', new Map())).toBe(false);
  });

  it('is false for a plain member', () => {
    expect(computeIsSiteOwner('member', roles({ 'site-a': 'member' }), 'site-a', new Map())).toBe(false);
  });

  it('does not leak ownership across sites', () => {
    expect(computeIsSiteOwner('member', roles({ 'site-a': 'owner' }), 'site-b', new Map())).toBe(false);
  });

  it('is true for a superadmin holding no membership', () => {
    expect(computeIsSiteOwner('superadmin', roles({}), 'site-a', new Map())).toBe(true);
  });

  it('is false while the session is unresolved', () => {
    expect(computeIsSiteOwner(null, roles({ 'site-a': 'owner' }), 'site-a', new Map())).toBe(false);
  });
});

describe('shouldListenerBootstrap', () => {
  it('bootstraps when nothing is in flight (google sign-in / cold recovery)', async () => {
    await expect(shouldListenerBootstrap(null)).resolves.toBe(true);
  });

  it('stands down while the tokened signUp bootstrap is still in flight', async () => {
    // The listener has no Turnstile token; racing signUp spent a rejected
    // challenge on every email/password signup (drift-audit item 9).
    let resolve!: (value: { alreadyExists: boolean }) => void;
    const pending = new Promise<{ alreadyExists: boolean }>(r => { resolve = r; });

    const decision = shouldListenerBootstrap(pending);
    resolve({ alreadyExists: false });

    await expect(decision).resolves.toBe(false);
  });

  it('still bootstraps when the signUp attempt actually failed — the recovery path', async () => {
    // Standing down must not cost us the reason this path exists.
    const failed = Promise.reject(new Error('siteverify blip'));
    await expect(shouldListenerBootstrap(failed)).resolves.toBe(true);
  });
});
