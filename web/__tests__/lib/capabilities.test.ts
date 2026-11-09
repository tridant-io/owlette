/**
 * @jest-environment node
 */
import {
  Capability,
  SiteRoleCapabilityMatrix,
  GlobalRoleCapabilityMatrix,
  SystemCapabilityMatrix,
  hasCapability,
  isMachineCapability,
  isSiteScopedCapability,
  MACHINE_CAPABILITIES,
  machineScopeOf,
  siteStanding,
  type Actor,
  type MemberStanding,
  type SiteRole,
  type SystemActorName,
  type UserActor,
  type SystemActor,
} from '@/lib/capabilities';
import { grantedSwoopMode, type SwoopMode } from '@/lib/swoopMode';

const ALL_CAPABILITIES: Capability[] = Object.values(Capability);

const SITE_SCOPED: Capability[] = [
  Capability.MACHINE_EXEC_COMMAND,
  Capability.MACHINE_VIEW,
  Capability.MACHINE_REMOTE_CONTROL,
  Capability.MACHINE_REMOTE_VIEW,
  Capability.SWOOP_SETTINGS_MANAGE,
  Capability.MACHINE_CONFIG_WRITE,
  Capability.MACHINE_REMOVE,
  Capability.DEPLOYMENT_MANAGE,
  Capability.DISTRIBUTION_MANAGE,
  Capability.UNINSTALL_TRIGGER,
  Capability.PRESET_MANAGE,
  Capability.SITE_MEMBER_MANAGE,
  Capability.WEBHOOK_MANAGE,
  Capability.SITE_LOGS_MANAGE,
  Capability.TALON_MANAGE,
  Capability.AGENT_TOKEN_REVOKE,
  Capability.MACHINE_ENROLL,
  Capability.ALERT_RULES_MANAGE,
  Capability.SITE_DELETE,
];

const GLOBAL_CAPABILITIES: Capability[] = ALL_CAPABILITIES.filter(
  (c) => !SITE_SCOPED.includes(c)
);

/** whole site on every site in siteRoles, as siteStanding writes it, unless overridden. */
function userActor(overrides: Partial<UserActor> = {}): UserActor {
  const siteRoles = overrides.siteRoles ?? {};
  return {
    type: 'user',
    userId: 'uid_default',
    role: 'member',
    siteRoles,
    swoopModes: {},
    machineScopes: Object.fromEntries(Object.keys(siteRoles).map((siteId) => [siteId, null])),
    ...overrides,
  };
}

/** only an untyped literal can leave the map out; a missing scope must not widen. */
function noMapActor(role: UserActor['role'], siteRole: SiteRole): UserActor {
  return { type: 'user', userId: 'uid_default', role, siteRoles: { site_a: siteRole }, swoopModes: {} } as unknown as UserActor;
}

function systemActor(overrides: Partial<SystemActor> = {}): SystemActor {
  return {
    type: 'system',
    name: 'cortex_autonomous',
    siteId: 'site_default',
    ...overrides,
  };
}

describe('Capability enum', () => {
  it('exposes the full vocabulary expected by the security-boundary plan', () => {
    expect(new Set(ALL_CAPABILITIES)).toEqual(
      new Set([
        'MACHINE_EXEC_COMMAND',
        'MACHINE_VIEW',
        'MACHINE_REMOTE_CONTROL',
        'MACHINE_REMOTE_VIEW',
        'SWOOP_SETTINGS_MANAGE',
        'MACHINE_CONFIG_WRITE',
        'MACHINE_REMOVE',
        'DEPLOYMENT_MANAGE',
        'DISTRIBUTION_MANAGE',
        'UNINSTALL_TRIGGER',
        'PRESET_MANAGE',
        'SITE_MEMBER_MANAGE',
        'SITE_DELETE',
        'WEBHOOK_MANAGE',
        'SITE_LOGS_MANAGE',
        'TALON_MANAGE',
        'ALERT_RULES_MANAGE',
        'AGENT_TOKEN_REVOKE',
        'MACHINE_ENROLL',
        'USER_ROLE_MANAGE',
        'USER_DELETE',
        'SYSTEM_PRESET_MANAGE',
        'INSTALLER_MANAGE',
        'ISSUE_MANAGE',
        'GLOBAL_SETTINGS_WRITE',
        'USER_SELF_PREFS',
        'USER_SELF_DELETE',
      ])
    );
  });
});

describe('SiteRoleCapabilityMatrix', () => {
  it('member is a read-only operator: it may watch a machine and nothing else', () => {
    // Both watch capabilities, no control one: MACHINE_VIEW is the screenshot /
    // live-view slideshow, MACHINE_REMOTE_VIEW the swoop feed (owner ruling —
    // members watch by default, gated per site by `membersMayWatch` in policy).
    expect([...SiteRoleCapabilityMatrix.member].sort()).toEqual(
      ['MACHINE_VIEW', 'MACHINE_REMOTE_VIEW'].sort()
    );
  });

  it('admin adds every site-scoped write, but NOT destroying the site', () => {
    expect([...SiteRoleCapabilityMatrix.admin].sort()).toEqual(
      [
        'MACHINE_VIEW',
        'MACHINE_REMOTE_VIEW',
        'MACHINE_REMOTE_CONTROL',
        'MACHINE_EXEC_COMMAND',
        'SWOOP_SETTINGS_MANAGE',
        'MACHINE_CONFIG_WRITE',
        'MACHINE_REMOVE',
        'DEPLOYMENT_MANAGE',
        'DISTRIBUTION_MANAGE',
        'UNINSTALL_TRIGGER',
        'PRESET_MANAGE',
        'WEBHOOK_MANAGE',
        'SITE_LOGS_MANAGE',
        'SITE_MEMBER_MANAGE',
        'TALON_MANAGE',
        'AGENT_TOKEN_REVOKE',
        'MACHINE_ENROLL',
        'ALERT_RULES_MANAGE',
      ].sort()
    );
    expect(SiteRoleCapabilityMatrix.admin).not.toContain(Capability.SITE_DELETE);
  });

  it('owner is admin plus SITE_DELETE, and nothing else', () => {
    expect([...SiteRoleCapabilityMatrix.owner].sort()).toEqual(
      [...SiteRoleCapabilityMatrix.admin, Capability.SITE_DELETE].sort()
    );
  });

  it('no per-site role reaches a platform capability', () => {
    // Owning a site must never be a route to installer uploads or role
    // management. This is the containment the whole per-site model rests on.
    for (const role of ['owner', 'admin', 'member'] as SiteRole[]) {
      for (const cap of GLOBAL_CAPABILITIES) {
        expect(SiteRoleCapabilityMatrix[role]).not.toContain(cap);
      }
    }
  });

  it('every per-site capability is declared site-scoped', () => {
    // A capability in the site matrix that is not site-scoped would be granted
    // globally by `hasCapability`'s non-scoped branch.
    for (const role of ['owner', 'admin', 'member'] as SiteRole[]) {
      for (const cap of SiteRoleCapabilityMatrix[role]) {
        expect(isSiteScopedCapability(cap)).toBe(true);
      }
    }
  });
});

describe('GlobalRoleCapabilityMatrix', () => {
  it('a global role grants self-service and nothing more', () => {
    expect([...GlobalRoleCapabilityMatrix.member].sort()).toEqual(
      ['USER_SELF_DELETE', 'USER_SELF_PREFS'].sort()
    );
  });

  it('global `admin` is worth exactly what `member` is', () => {
    // The migration's headline change. `admin` used to carry every site-scoped
    // write on each site in `sites[]`; per-site standing carries that now, so
    // the global tier confers nothing on its own.
    expect([...GlobalRoleCapabilityMatrix.admin].sort()).toEqual(
      [...GlobalRoleCapabilityMatrix.member].sort()
    );
  });

  it('superadmin gets every capability', () => {
    expect([...GlobalRoleCapabilityMatrix.superadmin].sort()).toEqual(
      [...ALL_CAPABILITIES].sort()
    );
  });
});

describe('SystemCapabilityMatrix', () => {
  it('cortex_autonomous allowlist is exactly [MACHINE_EXEC_COMMAND, MACHINE_CONFIG_WRITE]', () => {
    expect([...SystemCapabilityMatrix.cortex_autonomous].sort()).toEqual(
      ['MACHINE_CONFIG_WRITE', 'MACHINE_EXEC_COMMAND'].sort()
    );
  });

  it('cortex_provisioning has no capabilities by default', () => {
    expect(SystemCapabilityMatrix.cortex_provisioning).toEqual([]);
  });

  it('scheduled_cleanup carries cleanup-oriented capabilities only', () => {
    expect([...SystemCapabilityMatrix.scheduled_cleanup].sort()).toEqual(
      ['DEPLOYMENT_MANAGE', 'MACHINE_REMOVE'].sort()
    );
  });

  it('talon_runner allowlist is exactly [MACHINE_EXEC_COMMAND]', () => {
    expect([...SystemCapabilityMatrix.talon_runner]).toEqual([
      'MACHINE_EXEC_COMMAND',
    ]);
  });
});

describe('isSiteScopedCapability', () => {
  it.each(SITE_SCOPED)('%s is site-scoped', (cap) => {
    expect(isSiteScopedCapability(cap)).toBe(true);
  });

  it.each(GLOBAL_CAPABILITIES)('%s is global (not site-scoped)', (cap) => {
    expect(isSiteScopedCapability(cap)).toBe(false);
  });
});

describe('hasCapability — inherited property names are not roles', () => {
  // `actor.siteRoles[siteId]` is a bare object lookup. A siteId spelling an
  // Object.prototype member ('constructor', 'toString', '__proto__', …) returns
  // an inherited function, which survives an `=== undefined` guard and then
  // indexes SiteRoleCapabilityMatrix with a function — a TypeError, i.e. a 500
  // on an auth path. CodeQL filed this against the writes that build siteRoles
  // (alerts 311, 313); the reachable hazard is the read.
  const PROTOTYPE_KEYS = ['constructor', 'toString', 'valueOf', 'hasOwnProperty', '__proto__'];

  for (const key of PROTOTYPE_KEYS) {
    it(`denies a site-scoped capability for siteId "${key}" with no membership`, () => {
      const actor = userActor({ role: 'member', siteRoles: {} });
      expect(() => hasCapability(actor, Capability.MACHINE_VIEW, key)).not.toThrow();
      expect(hasCapability(actor, Capability.MACHINE_VIEW, key)).toBe(false);
    });

    it(`denies siteId "${key}" even when another site is held`, () => {
      const actor = userActor({ role: 'member', siteRoles: { site_a: 'owner' } });
      expect(() => hasCapability(actor, Capability.MACHINE_VIEW, key)).not.toThrow();
      expect(hasCapability(actor, Capability.MACHINE_VIEW, key)).toBe(false);
    });
  }

  it('still grants a genuinely held site', () => {
    const actor = userActor({ role: 'member', siteRoles: { site_a: 'owner' } });
    expect(hasCapability(actor, Capability.MACHINE_VIEW, 'site_a')).toBe(true);
  });
});

describe('hasCapability — per-site role × every capability', () => {
  const siteRoles: SiteRole[] = ['member', 'admin', 'owner'];

  for (const siteRole of siteRoles) {
    for (const cap of ALL_CAPABILITIES) {
      const grants = SiteRoleCapabilityMatrix[siteRole].includes(cap);
      const isScoped = SITE_SCOPED.includes(cap);

      it(`${siteRole} on site_a × ${cap} — granted=${grants}`, () => {
        // Global role `member`: the standing under test must be the only source
        // of authority, so a global tier that granted anything would mask it.
        const actor = userActor({ role: 'member', siteRoles: { site_a: siteRole } });

        if (isScoped) {
          expect(hasCapability(actor, cap, 'site_a')).toBe(grants);
          // Standing on site_a says nothing about site_b.
          expect(hasCapability(actor, cap, 'site_b')).toBe(false);
          // A site-scoped capability with no site named is always denied.
          expect(hasCapability(actor, cap)).toBe(false);
          return;
        }

        // Not site-scoped: only the self-service pair is reachable without
        // superadmin, and per-site standing cannot add to it.
        const selfService =
          cap === Capability.USER_SELF_PREFS || cap === Capability.USER_SELF_DELETE;
        expect(hasCapability(actor, cap)).toBe(selfService);
        expect(hasCapability(actor, cap, 'site_a')).toBe(selfService);
      });
    }
  }

  it('a global admin with no membership is denied every site-scoped capability', () => {
    const actor = userActor({ role: 'admin', siteRoles: {} });
    for (const cap of SITE_SCOPED) {
      expect(hasCapability(actor, cap, 'site_a')).toBe(false);
    }
  });

  it('superadmin holds every capability while holding no membership at all', () => {
    // Superadmins deliberately have no member rows; they short-circuit above the
    // site matrix, so an empty `siteRoles` must not narrow them.
    const actor = userActor({ role: 'superadmin', siteRoles: {} });
    for (const cap of ALL_CAPABILITIES) {
      expect(hasCapability(actor, cap)).toBe(true);
      expect(hasCapability(actor, cap, 'site_anything')).toBe(true);
    }
  });
});

describe('hasCapability — site-scope enforcement edge cases', () => {
  it('admin with empty sites array is denied every site-scoped capability', () => {
    const actor = userActor({ role: 'admin', siteRoles: {} });
    for (const cap of SITE_SCOPED) {
      expect(hasCapability(actor, cap, 'site_a')).toBe(false);
    }
  });

  it('admin without siteId argument is denied site-scoped capabilities', () => {
    const actor = userActor({ role: 'admin', siteRoles: { ['site_a']: 'admin' } });
    for (const cap of SITE_SCOPED) {
      if (!SiteRoleCapabilityMatrix.admin.includes(cap)) continue;
      expect(hasCapability(actor, cap)).toBe(false);
    }
  });

  it('admin granted only on assigned site', () => {
    const actor = userActor({ role: 'admin', siteRoles: { ['site_a']: 'admin', ['site_b']: 'admin' } });
    expect(hasCapability(actor, Capability.DEPLOYMENT_MANAGE, 'site_a')).toBe(true);
    expect(hasCapability(actor, Capability.DEPLOYMENT_MANAGE, 'site_b')).toBe(true);
    expect(hasCapability(actor, Capability.DEPLOYMENT_MANAGE, 'site_c')).toBe(false);
  });

  it('superadmin bypasses site-scope check entirely (no siteId required)', () => {
    const actor = userActor({ role: 'superadmin', siteRoles: {} });
    for (const cap of SITE_SCOPED) {
      expect(hasCapability(actor, cap)).toBe(true);
      expect(hasCapability(actor, cap, 'site_anything')).toBe(true);
    }
  });

  it('member is denied site-scoped WRITE capabilities even on their assigned site (but the watch capabilities are allowed)', () => {
    const actor = userActor({ role: 'member', siteRoles: { ['site_a']: 'member' } });
    for (const cap of SITE_SCOPED) {
      // The two read-class capabilities members hold: MACHINE_VIEW (screenshot /
      // live view) and MACHINE_REMOTE_VIEW (watching a swoop stream). Every
      // other site-scoped cap is a write or a control verb, and denied.
      const expected =
        cap === Capability.MACHINE_VIEW || cap === Capability.MACHINE_REMOTE_VIEW;
      expect(hasCapability(actor, cap, 'site_a')).toBe(expected);
    }
  });

  it('member gets MACHINE_VIEW only on assigned sites, never unscoped', () => {
    const actor = userActor({ role: 'member', siteRoles: { ['site_a']: 'member' } });
    expect(hasCapability(actor, Capability.MACHINE_VIEW, 'site_a')).toBe(true);
    expect(hasCapability(actor, Capability.MACHINE_VIEW, 'site_other')).toBe(false);
    expect(hasCapability(actor, Capability.MACHINE_VIEW)).toBe(false);
  });

  it('member retains self-prefs and self-delete (global, no siteId required)', () => {
    const actor = userActor({ role: 'member', siteRoles: {} });
    expect(hasCapability(actor, Capability.USER_SELF_PREFS)).toBe(true);
    expect(hasCapability(actor, Capability.USER_SELF_DELETE)).toBe(true);
  });
});

describe('hasCapability — system actor allowlist', () => {
  const allActors: SystemActorName[] = [
    'cortex_autonomous',
    'cortex_provisioning',
    'scheduled_cleanup',
    'talon_runner',
  ];

  for (const name of allActors) {
    for (const cap of ALL_CAPABILITIES) {
      const allowed = SystemCapabilityMatrix[name].includes(cap);
      const isScoped = SITE_SCOPED.includes(cap);

      it(`${name} × ${cap} — allowed=${allowed}, scoped=${isScoped}`, () => {
        const actor = systemActor({ name, siteId: 'site_a' });

        if (!allowed) {
          expect(hasCapability(actor, cap, 'site_a')).toBe(false);
          expect(hasCapability(actor, cap)).toBe(false);
          return;
        }

        if (isScoped) {
          expect(hasCapability(actor, cap, 'site_a')).toBe(true);
          expect(hasCapability(actor, cap, 'site_other')).toBe(false);
          expect(hasCapability(actor, cap)).toBe(false);
        } else {
          expect(hasCapability(actor, cap)).toBe(true);
          expect(hasCapability(actor, cap, 'site_a')).toBe(true);
        }
      });
    }
  }

  it('cortex_provisioning is denied every capability (empty allowlist)', () => {
    const actor = systemActor({ name: 'cortex_provisioning', siteId: 'site_a' });
    for (const cap of ALL_CAPABILITIES) {
      expect(hasCapability(actor, cap, 'site_a')).toBe(false);
    }
  });

  it('cortex_autonomous denied non-allowlisted site-scoped capabilities', () => {
    const actor = systemActor({ name: 'cortex_autonomous', siteId: 'site_a' });
    expect(hasCapability(actor, Capability.MACHINE_REMOVE, 'site_a')).toBe(false);
    expect(hasCapability(actor, Capability.DEPLOYMENT_MANAGE, 'site_a')).toBe(false);
    expect(hasCapability(actor, Capability.WEBHOOK_MANAGE, 'site_a')).toBe(false);
  });

  it('cortex_autonomous denied non-allowlisted global capabilities', () => {
    const actor = systemActor({ name: 'cortex_autonomous', siteId: 'site_a' });
    expect(hasCapability(actor, Capability.INSTALLER_MANAGE)).toBe(false);
    expect(hasCapability(actor, Capability.USER_ROLE_MANAGE)).toBe(false);
    expect(hasCapability(actor, Capability.GLOBAL_SETTINGS_WRITE)).toBe(false);
  });

  it('scheduled_cleanup can perform cleanup capabilities only on its assigned siteId', () => {
    const actor = systemActor({ name: 'scheduled_cleanup', siteId: 'site_cleanup' });
    expect(hasCapability(actor, Capability.MACHINE_REMOVE, 'site_cleanup')).toBe(true);
    expect(hasCapability(actor, Capability.DEPLOYMENT_MANAGE, 'site_cleanup')).toBe(true);
    expect(hasCapability(actor, Capability.MACHINE_REMOVE, 'site_other')).toBe(false);
    expect(hasCapability(actor, Capability.DEPLOYMENT_MANAGE, 'site_other')).toBe(false);
  });

  it('system actor without siteId argument denied site-scoped capabilities', () => {
    const actor = systemActor({ name: 'cortex_autonomous', siteId: 'site_a' });
    expect(hasCapability(actor, Capability.MACHINE_EXEC_COMMAND)).toBe(false);
    expect(hasCapability(actor, Capability.MACHINE_CONFIG_WRITE)).toBe(false);
  });
});

describe('ALERT_RULES_MANAGE — site-admin grant for PUT /api/sites/{siteId}/alerts', () => {
  const admin = userActor({ userId: 'u1', role: 'admin', siteRoles: { ['s1']: 'admin' } });

  it('admin holds it on an assigned site only', () => {
    expect(hasCapability(admin, Capability.ALERT_RULES_MANAGE, 's1')).toBe(true);
    expect(hasCapability(admin, Capability.ALERT_RULES_MANAGE, 's2')).toBe(false);
    expect(hasCapability(admin, Capability.ALERT_RULES_MANAGE)).toBe(false);
  });

  it('member never holds it, even on their own site', () => {
    const member = userActor({ userId: 'u1', role: 'member', siteRoles: { ['s1']: 'member' } });
    expect(hasCapability(member, Capability.ALERT_RULES_MANAGE, 's1')).toBe(false);
  });

  it('superadmin holds it unscoped', () => {
    const superadmin = userActor({ userId: 'u0', role: 'superadmin', siteRoles: {} });
    expect(hasCapability(superadmin, Capability.ALERT_RULES_MANAGE)).toBe(true);
    expect(hasCapability(superadmin, Capability.ALERT_RULES_MANAGE, 's2')).toBe(true);
  });

  it('opening alerts to admins did NOT hand them GLOBAL_SETTINGS_WRITE', () => {
    // Negative control: the alerts route traded GLOBAL_SETTINGS_WRITE for the new
    // site-scoped capability. Granting the old one to admins would silently open
    // every platform settings route — this assertion must fail if that happens.
    expect(hasCapability(admin, Capability.GLOBAL_SETTINGS_WRITE, 's1')).toBe(false);
    expect(SiteRoleCapabilityMatrix.admin).not.toContain(Capability.GLOBAL_SETTINGS_WRITE);
  });
});

describe('AGENT_TOKEN_REVOKE — site-admin grant for the agent-tokens list + revoke routes', () => {
  // The role × capability sweep above derives its expectations from
  // SiteRoleCapabilityMatrix, so it stays green whether or not admins hold this
  // capability. These assertions pin the grant itself: GET/POST
  // /api/sites/{siteId}/agent-tokens both run on it, and the admin tokens page
  // 403s the moment it is withdrawn.
  const admin = userActor({ userId: 'u1', role: 'admin', siteRoles: { ['s1']: 'admin' } });

  it('admin holds it on an assigned site only', () => {
    expect(hasCapability(admin, Capability.AGENT_TOKEN_REVOKE, 's1')).toBe(true);
    expect(hasCapability(admin, Capability.AGENT_TOKEN_REVOKE, 's2')).toBe(false);
    expect(hasCapability(admin, Capability.AGENT_TOKEN_REVOKE)).toBe(false);
  });

  it('member never holds it, even on their own site', () => {
    const member = userActor({ userId: 'u2', role: 'member', siteRoles: { ['s1']: 'member' } });
    expect(hasCapability(member, Capability.AGENT_TOKEN_REVOKE, 's1')).toBe(false);
  });

  it('superadmin holds it unscoped', () => {
    const superadmin = userActor({ userId: 'u0', role: 'superadmin', siteRoles: {} });
    expect(hasCapability(superadmin, Capability.AGENT_TOKEN_REVOKE)).toBe(true);
    expect(hasCapability(superadmin, Capability.AGENT_TOKEN_REVOKE, 's2')).toBe(true);
  });
});

describe('swoop — MACHINE_REMOTE_VIEW vs MACHINE_REMOTE_CONTROL', () => {
  const member = userActor({ userId: 'u1', role: 'member', siteRoles: { ['s1']: 'member' } });
  const admin = userActor({ userId: 'u2', role: 'admin', siteRoles: { ['s1']: 'admin' } });
  const owner = userActor({ userId: 'u3', role: 'member', siteRoles: { ['s1']: 'owner' } });

  it('a site member may watch but may not control', () => {
    // The split is the whole point: watching a machine is a confidentiality
    // decision the site makes with `membersMayWatch`; driving its keyboard as
    // SYSTEM is an admin one. A member holding both would collapse them.
    expect(hasCapability(member, Capability.MACHINE_REMOTE_VIEW, 's1')).toBe(true);
    expect(hasCapability(member, Capability.MACHINE_REMOTE_CONTROL, 's1')).toBe(false);
  });

  it('admins and owners inherit watching and add control', () => {
    for (const actor of [admin, owner]) {
      expect(hasCapability(actor, Capability.MACHINE_REMOTE_VIEW, 's1')).toBe(true);
      expect(hasCapability(actor, Capability.MACHINE_REMOTE_CONTROL, 's1')).toBe(true);
    }
  });

  it('both are site-scoped: standing on one site never reaches another, and neither is held unscoped', () => {
    for (const cap of [Capability.MACHINE_REMOTE_VIEW, Capability.MACHINE_REMOTE_CONTROL]) {
      expect(isSiteScopedCapability(cap)).toBe(true);
      expect(hasCapability(admin, cap, 's2')).toBe(false);
      expect(hasCapability(admin, cap)).toBe(false);
    }
  });

  it('no system actor can start or watch a swoop session', () => {
    // Hoot, talons and the cleanup sweep act unattended; a remote-control grant
    // there would be an unattended interactive session on a customer machine.
    for (const name of Object.keys(SystemCapabilityMatrix) as SystemActorName[]) {
      const actor = systemActor({ name, siteId: 's1' });
      expect(hasCapability(actor, Capability.MACHINE_REMOTE_VIEW, 's1')).toBe(false);
      expect(hasCapability(actor, Capability.MACHINE_REMOTE_CONTROL, 's1')).toBe(false);
    }
  });

  it('MACHINE_VIEW does not imply either of them', () => {
    // Negative control: swoop deliberately did not reuse MACHINE_VIEW. If these
    // ever become aliases, a continuous feed with audio inherits the screenshot
    // capability's much wider reach.
    expect(Capability.MACHINE_REMOTE_VIEW).not.toBe(Capability.MACHINE_VIEW);
    expect(Capability.MACHINE_REMOTE_CONTROL).not.toBe(Capability.MACHINE_VIEW);
  });

  it('SWOOP_SETTINGS_MANAGE is site admin/owner, never a member', () => {
    // The site's own switch for the feature. A member holds the watch
    // capability on merit, so granting them the switch would let them enable
    // what they may then watch.
    expect(hasCapability(member, Capability.SWOOP_SETTINGS_MANAGE, 's1')).toBe(false);
    for (const actor of [admin, owner]) {
      expect(hasCapability(actor, Capability.SWOOP_SETTINGS_MANAGE, 's1')).toBe(true);
    }
    expect(isSiteScopedCapability(Capability.SWOOP_SETTINGS_MANAGE)).toBe(true);
    expect(hasCapability(admin, Capability.SWOOP_SETTINGS_MANAGE, 's2')).toBe(false);
    expect(hasCapability(admin, Capability.SWOOP_SETTINGS_MANAGE)).toBe(false);
  });
});

describe('hasCapability — discriminated union routing', () => {
  it('routes user actor through SiteRoleCapabilityMatrix', () => {
    const actor: Actor = {
      type: 'user',
      userId: 'uid_x',
      role: 'admin',
      siteRoles: { ['site_a']: 'admin' },
      swoopModes: {},
      machineScopes: { site_a: null },
    };
    expect(hasCapability(actor, Capability.DEPLOYMENT_MANAGE, 'site_a')).toBe(true);
  });

  it('routes system actor through SystemCapabilityMatrix', () => {
    const actor: Actor = {
      type: 'system',
      name: 'cortex_autonomous',
      siteId: 'site_a',
    };
    expect(hasCapability(actor, Capability.MACHINE_EXEC_COMMAND, 'site_a')).toBe(true);
  });
});

const VIEW = Capability.MACHINE_REMOTE_VIEW;
const CONTROL = Capability.MACHINE_REMOTE_CONTROL;

/** a map whose one own key is `key`, which a literal cannot spell for `__proto__`. */
function ownKeyMap<T>(key: string, value: T): Record<string, T> {
  const map: Record<string, T> = Object.create(null);
  map[key] = value;
  return map;
}

describe("hasCapability — a person's swoop mode (owner rulings 13-14)", () => {
  const MODES: Array<SwoopMode | null> = [null, 'none', 'view', 'control'];

  function withMode(siteRole: SiteRole, mode: SwoopMode | null): UserActor {
    return userActor({
      role: 'member',
      siteRoles: { site_a: siteRole },
      ...(mode === null ? {} : { swoopModes: { site_a: mode } }),
    });
  }

  for (const siteRole of ['member', 'admin', 'owner'] as SiteRole[]) {
    for (const mode of MODES) {
      const granted = grantedSwoopMode(siteRole, mode);

      it(`${siteRole} with mode ${mode ?? 'absent'} — watch=${granted !== 'none'}, control=${granted === 'control'}`, () => {
        const actor = withMode(siteRole, mode);
        expect(hasCapability(actor, VIEW, 'site_a')).toBe(granted !== 'none');
        expect(hasCapability(actor, CONTROL, 'site_a')).toBe(granted === 'control');
      });
    }
  }

  it('the role defaults agree with the matrix', () => {
    for (const siteRole of ['member', 'admin', 'owner'] as SiteRole[]) {
      const granted = grantedSwoopMode(siteRole, null);
      expect(SiteRoleCapabilityMatrix[siteRole].includes(CONTROL)).toBe(granted === 'control');
      expect(SiteRoleCapabilityMatrix[siteRole].includes(VIEW)).toBe(granted !== 'none');
    }
  });

  it('a member set to control gains control and nothing else', () => {
    const actor = withMode('member', 'control');
    for (const cap of [
      Capability.MACHINE_EXEC_COMMAND,
      Capability.MACHINE_CONFIG_WRITE,
      Capability.SWOOP_SETTINGS_MANAGE,
      Capability.SITE_MEMBER_MANAGE,
      Capability.MACHINE_ENROLL,
    ]) {
      expect(hasCapability(actor, cap, 'site_a')).toBe(false);
    }
  });

  it('an admin held to view or none keeps running the site, and loses control', () => {
    for (const mode of ['view', 'none'] as SwoopMode[]) {
      const actor = withMode('admin', mode);
      expect(hasCapability(actor, Capability.SITE_MEMBER_MANAGE, 'site_a')).toBe(true);
      expect(hasCapability(actor, Capability.SWOOP_SETTINGS_MANAGE, 'site_a')).toBe(true);
      expect(hasCapability(actor, Capability.MACHINE_EXEC_COMMAND, 'site_a')).toBe(true);
      expect(hasCapability(actor, CONTROL, 'site_a')).toBe(false);
      expect(hasCapability(actor, VIEW, 'site_a')).toBe(mode === 'view');
    }
  });

  it('an owner with a mode in a hand-built actor still holds both', () => {
    for (const mode of ['none', 'view'] as SwoopMode[]) {
      const actor = withMode('owner', mode);
      expect(hasCapability(actor, VIEW, 'site_a')).toBe(true);
      expect(hasCapability(actor, CONTROL, 'site_a')).toBe(true);
    }
  });

  it('a mode on site_a says nothing about site_b', () => {
    const heldBack = userActor({
      siteRoles: { site_a: 'admin', site_b: 'admin' },
      swoopModes: { site_a: 'none' },
    });
    expect(hasCapability(heldBack, CONTROL, 'site_a')).toBe(false);
    expect(hasCapability(heldBack, CONTROL, 'site_b')).toBe(true);
    expect(hasCapability(heldBack, VIEW, 'site_b')).toBe(true);

    const raised = userActor({
      siteRoles: { site_a: 'member', site_b: 'member' },
      swoopModes: { site_a: 'control' },
    });
    expect(hasCapability(raised, CONTROL, 'site_a')).toBe(true);
    expect(hasCapability(raised, CONTROL, 'site_b')).toBe(false);

    // a mode for a site the person is not on grants nothing there
    const stray = userActor({ siteRoles: { site_a: 'member' }, swoopModes: { site_b: 'control' } });
    expect(hasCapability(stray, VIEW, 'site_b')).toBe(false);
    expect(hasCapability(stray, CONTROL, 'site_b')).toBe(false);
  });

  it('a swoopModes keyed constructor or __proto__ never throws or grants', () => {
    for (const key of ['constructor', '__proto__']) {
      const stranger = userActor({ siteRoles: { site_a: 'member' }, swoopModes: ownKeyMap<SwoopMode>(key, 'control') });
      for (const cap of [VIEW, CONTROL]) {
        expect(() => hasCapability(stranger, cap, key)).not.toThrow();
        expect(hasCapability(stranger, cap, key)).toBe(false);
      }

      // an inherited name on a plain map is no mode, so the role decides
      const admin = userActor({ siteRoles: ownKeyMap<SiteRole>(key, 'admin'), swoopModes: { site_a: 'none' } });
      expect(() => hasCapability(admin, CONTROL, key)).not.toThrow();
      expect(hasCapability(admin, CONTROL, key)).toBe(true);
      const member = userActor({ siteRoles: ownKeyMap<SiteRole>(key, 'member'), swoopModes: { site_a: 'control' } });
      expect(hasCapability(member, CONTROL, key)).toBe(false);
    }
  });

  it('superadmin is unchanged by a mode', () => {
    const actor = userActor({
      role: 'superadmin',
      siteRoles: { site_a: 'member' },
      swoopModes: { site_a: 'none' },
    });
    expect(hasCapability(actor, VIEW, 'site_a')).toBe(true);
    expect(hasCapability(actor, CONTROL, 'site_a')).toBe(true);
    expect(hasCapability(actor, CONTROL, 'site_b')).toBe(true);
  });
});

describe('siteStanding', () => {
  it('carries each site role, a mode only where the row has one, and every scope', () => {
    expect(
      siteStanding([
        ['site_a', { role: 'member', swoopMode: 'control', machineIds: null }],
        ['site_b', { role: 'admin', swoopMode: null, machineIds: null }],
      ]),
    ).toEqual({
      siteRoles: { site_a: 'member', site_b: 'admin' },
      swoopModes: { site_a: 'control' },
      machineScopes: { site_a: null, site_b: null },
    });
  });

  it('skips a site with no role, and its mode and scope with it', () => {
    expect(siteStanding([['site_a', { role: null, swoopMode: 'control', machineIds: ['m1'] }]])).toEqual({
      siteRoles: {},
      swoopModes: {},
      machineScopes: {},
    });
  });

  it("drops an owner's mode", () => {
    expect(siteStanding([['site_a', { role: 'owner', swoopMode: 'none', machineIds: null }]])).toEqual({
      siteRoles: { site_a: 'owner' },
      swoopModes: {},
      machineScopes: { site_a: null },
    });
  });

  it('returns all three maps, swoopModes empty, when no site has a mode', () => {
    const standing = siteStanding([
      ['site_a', { role: 'member', swoopMode: null, machineIds: null }],
      ['site_b', { role: 'owner', swoopMode: 'view', machineIds: null }],
      ['site_c', { role: null, swoopMode: 'control', machineIds: null }],
    ]);
    expect(Object.keys(standing).sort()).toEqual(['machineScopes', 'siteRoles', 'swoopModes']);
    expect(Object.keys(standing.swoopModes)).toEqual([]);
  });

  it('keeps __proto__ as an own key, and leaves Object.prototype untouched', () => {
    const prototypeBefore = Object.getOwnPropertyNames(Object.prototype).sort();
    const standing = siteStanding([['__proto__', { role: 'admin', swoopMode: 'view', machineIds: null }]]);

    expect(Object.prototype.hasOwnProperty.call(standing.siteRoles, '__proto__')).toBe(true);
    expect(standing.siteRoles['__proto__']).toBe('admin');
    expect(Object.prototype.hasOwnProperty.call(standing.swoopModes, '__proto__')).toBe(true);
    expect(standing.swoopModes['__proto__']).toBe('view');
    expect(Object.getOwnPropertyNames(Object.prototype).sort()).toEqual(prototypeBefore);
    expect(Object.getPrototypeOf({})).toBe(Object.prototype);

    // and the gate reads the site it names
    const actor = userActor(standing);
    expect(hasCapability(actor, VIEW, '__proto__')).toBe(true);
    expect(hasCapability(actor, CONTROL, '__proto__')).toBe(false);
    expect(hasCapability(actor, Capability.SITE_MEMBER_MANAGE, '__proto__')).toBe(true);
  });

  it('writes a machine scope for every site in siteRoles, and none for a null role', () => {
    const standing = siteStanding([
      ['site_a', { role: 'member', swoopMode: 'control', machineIds: ['m1', 'm2'] }],
      ['site_b', { role: 'admin', swoopMode: null, machineIds: null }],
      ['site_c', { role: 'owner', swoopMode: null, machineIds: ['m3'] }],
      ['site_d', { role: null, swoopMode: null, machineIds: ['m1'] }],
    ]);
    expect(standing.machineScopes).toEqual({ site_a: ['m1', 'm2'], site_b: null, site_c: ['m3'] });
    expect(Object.keys(standing.machineScopes).sort()).toEqual(Object.keys(standing.siteRoles).sort());
  });

  it('writes null for a whole-site site, and all three maps when no site is given', () => {
    const standing = siteStanding([
      ['site_a', { role: 'admin', swoopMode: null, machineIds: null }],
      ['site_b', { role: null, swoopMode: null, machineIds: ['m1'] }],
    ]);
    expect(standing.machineScopes).toEqual({ site_a: null });
    expect(siteStanding([])).toEqual({ siteRoles: {}, swoopModes: {}, machineScopes: {} });
  });

  it('reads a standing with no machineIds as no machines, never as the whole site', () => {
    // only an untyped literal can leave it out; a missing scope must not widen
    const standing = siteStanding([['site_a', { role: 'admin', swoopMode: null } as unknown as MemberStanding]]);
    const actor = userActor(standing);
    expect(machineScopeOf(actor, 'site_a')).toEqual([]);
    expect(hasCapability(actor, Capability.MACHINE_EXEC_COMMAND, 'site_a', 'm1')).toBe(false);
    expect(hasCapability(actor, Capability.SITE_MEMBER_MANAGE, 'site_a')).toBe(false);
  });
});

describe('MACHINE_CAPABILITIES', () => {
  const MACHINE = [
    Capability.MACHINE_VIEW,
    Capability.MACHINE_REMOTE_VIEW,
    Capability.MACHINE_EXEC_COMMAND,
    Capability.MACHINE_REMOTE_CONTROL,
    Capability.MACHINE_CONFIG_WRITE,
  ];

  it('is exactly the five that act on one machine, each of them site-scoped', () => {
    expect(new Set(MACHINE_CAPABILITIES)).toEqual(new Set(MACHINE));
    for (const cap of MACHINE) expect(isSiteScopedCapability(cap)).toBe(true);
  });

  it.each(ALL_CAPABILITIES)('isMachineCapability(%s) agrees with the set', (cap) => {
    expect(isMachineCapability(cap)).toBe(MACHINE.includes(cap));
  });

  it('leaves the machine-sized site-wide ones out', () => {
    for (const cap of [
      Capability.MACHINE_REMOVE,
      Capability.UNINSTALL_TRIGGER,
      Capability.MACHINE_ENROLL,
      Capability.AGENT_TOKEN_REVOKE,
      Capability.SWOOP_SETTINGS_MANAGE,
    ]) {
      expect(isMachineCapability(cap)).toBe(false);
    }
  });
});

describe('machineScopeOf', () => {
  it('reads an actor with no map as no machines, and a superadmin with none as the whole site', () => {
    expect(machineScopeOf(noMapActor('member', 'admin'), 'site_a')).toEqual([]);
    expect(machineScopeOf(noMapActor('admin', 'owner'), 'site_a')).toEqual([]);
    expect(machineScopeOf(noMapActor('superadmin', 'member'), 'site_a')).toBeNull();
  });

  it('fails closed on a map without the site', () => {
    expect(machineScopeOf(userActor({ machineScopes: {} }), 'site_a')).toEqual([]);
    expect(machineScopeOf(userActor({ machineScopes: { site_b: null } }), 'site_a')).toEqual([]);
  });

  it('reads null as the whole site, a list as that list, and anything else as no machines', () => {
    expect(machineScopeOf(userActor({ machineScopes: { site_a: null } }), 'site_a')).toBeNull();
    expect(machineScopeOf(userActor({ machineScopes: { site_a: ['m1'] } }), 'site_a')).toEqual(['m1']);
    for (const bad of ['m1', { m1: true }, 1, undefined]) {
      const actor = userActor({ machineScopes: { site_a: bad as unknown as string[] } });
      expect(machineScopeOf(actor, 'site_a')).toEqual([]);
    }
  });

  it('reads own keys only', () => {
    for (const key of ['constructor', '__proto__', 'toString']) {
      expect(machineScopeOf(userActor({ machineScopes: { site_a: null } }), key)).toEqual([]);
    }
  });
});

describe('hasCapability — machine scope after the role and the swoop mode (owner decisions 1, 3, 13, 14)', () => {
  const SITE_WIDE = SITE_SCOPED.filter((cap) => !MACHINE_CAPABILITIES.has(cap));

  /** an actor as every builder makes one: through siteStanding. */
  function standingActor(
    siteRole: SiteRole,
    swoopMode: SwoopMode | null,
    machineIds: readonly string[] | null,
  ): UserActor {
    return userActor(siteStanding([['site_a', { role: siteRole, swoopMode, machineIds }]]));
  }

  /** what the three steps should give, worked out from the rules rather than the code. */
  function oracle(
    siteRole: SiteRole,
    mode: SwoopMode | null,
    scope: readonly string[] | null,
    machineId: string | undefined,
    cap: Capability,
  ): boolean {
    const onMachine = scope === null || (machineId !== undefined && scope.includes(machineId));
    const granted = grantedSwoopMode(siteRole, mode);
    switch (cap) {
      case Capability.MACHINE_REMOTE_CONTROL:
        return granted === 'control' && onMachine;
      case Capability.MACHINE_REMOTE_VIEW:
        return granted !== 'none' && onMachine;
      case Capability.MACHINE_EXEC_COMMAND:
      case Capability.MACHINE_CONFIG_WRITE:
        return siteRole !== 'member' && onMachine;
      case Capability.MACHINE_VIEW:
        return onMachine;
      default:
        return scope === null && SiteRoleCapabilityMatrix[siteRole].includes(cap);
    }
  }

  const ROWS: Array<{
    siteRole: SiteRole;
    mode: SwoopMode | null;
    scope: readonly string[] | null;
    machineId: string | undefined;
    cap: Capability;
  }> = [];
  for (const siteRole of ['member', 'admin', 'owner'] as SiteRole[]) {
    for (const mode of [null, 'none', 'view', 'control'] as Array<SwoopMode | null>) {
      for (const scope of [null, ['m1']] as Array<readonly string[] | null>) {
        for (const machineId of ['m1', 'm2', undefined]) {
          for (const cap of SITE_SCOPED) ROWS.push({ siteRole, mode, scope, machineId, cap });
        }
      }
    }
  }

  it.each(ROWS)(
    '$siteRole, mode $mode, scope $scope, machine $machineId × $cap',
    ({ siteRole, mode, scope, machineId, cap }) => {
      const actor = standingActor(siteRole, mode, scope);
      expect(hasCapability(actor, cap, 'site_a', machineId)).toBe(oracle(siteRole, mode, scope, machineId, cap));
    },
  );

  it("every site-wide capability is false on a scope, the owner's SITE_DELETE included", () => {
    expect(SITE_WIDE).toContain(Capability.SITE_DELETE);
    for (const machineId of ['m1', undefined]) {
      for (const cap of SITE_WIDE) {
        expect(hasCapability(standingActor('owner', null, ['m1']), cap, 'site_a', machineId)).toBe(false);
      }
    }
  });

  it('a member set to control on m1 controls m1 and nothing else', () => {
    const actor = standingActor('member', 'control', ['m1']);
    expect(hasCapability(actor, CONTROL, 'site_a', 'm1')).toBe(true);
    expect(hasCapability(actor, CONTROL, 'site_a', 'm2')).toBe(false);
    expect(hasCapability(actor, CONTROL, 'site_a')).toBe(false);
    expect(hasCapability(actor, Capability.MACHINE_EXEC_COMMAND, 'site_a', 'm1')).toBe(false);

    const held = (machineId?: string) => SITE_SCOPED.filter((cap) => hasCapability(actor, cap, 'site_a', machineId));
    expect(held('m1').sort()).toEqual([Capability.MACHINE_REMOTE_CONTROL, Capability.MACHINE_REMOTE_VIEW, Capability.MACHINE_VIEW].sort());
    expect(held('m2')).toEqual([]);
    expect(held()).toEqual([]);
  });

  it('an admin set to view on m1 runs commands there, and never controls', () => {
    const actor = standingActor('admin', 'view', ['m1']);
    expect(hasCapability(actor, Capability.MACHINE_EXEC_COMMAND, 'site_a', 'm1')).toBe(true);
    expect(hasCapability(actor, VIEW, 'site_a', 'm1')).toBe(true);
    expect(hasCapability(actor, CONTROL, 'site_a', 'm1')).toBe(false);
  });

  it('an admin set to none on m1 has no swoop there, and keeps machine config', () => {
    const actor = standingActor('admin', 'none', ['m1']);
    expect(hasCapability(actor, VIEW, 'site_a', 'm1')).toBe(false);
    expect(hasCapability(actor, CONTROL, 'site_a', 'm1')).toBe(false);
    expect(hasCapability(actor, Capability.MACHINE_CONFIG_WRITE, 'site_a', 'm1')).toBe(true);
  });

  it('fails closed: a present map without the site, an empty list, or a malformed entry reaches nothing', () => {
    const actors = [
      userActor({ siteRoles: { site_a: 'admin' }, machineScopes: {} }),
      userActor({ siteRoles: { site_a: 'admin' }, machineScopes: { site_a: [] } }),
      userActor({ siteRoles: { site_a: 'admin' }, machineScopes: { site_a: 'm1' as unknown as string[] } }),
      userActor({ siteRoles: { site_a: 'admin' }, machineScopes: { site_a: { m1: true } as unknown as string[] } }),
    ];
    for (const actor of actors) {
      for (const cap of SITE_SCOPED) {
        for (const machineId of ['m1', undefined]) {
          expect(hasCapability(actor, cap, 'site_a', machineId)).toBe(false);
        }
      }
    }
  });

  it('a scope on site_a says nothing about site_b', () => {
    const actor = userActor(
      siteStanding([
        ['site_a', { role: 'admin', swoopMode: null, machineIds: ['m1'] }],
        ['site_b', { role: 'admin', swoopMode: null, machineIds: null }],
      ]),
    );
    expect(hasCapability(actor, Capability.SITE_MEMBER_MANAGE, 'site_b')).toBe(true);
    expect(hasCapability(actor, Capability.SITE_MEMBER_MANAGE, 'site_a')).toBe(false);
    expect(hasCapability(actor, Capability.MACHINE_EXEC_COMMAND, 'site_b', 'm2')).toBe(true);
    expect(hasCapability(actor, Capability.MACHINE_EXEC_COMMAND, 'site_a', 'm2')).toBe(false);
  });

  it('a machine id that names an Object.prototype member is no machine in scope', () => {
    const actor = standingActor('admin', null, ['m1']);
    for (const machineId of ['__proto__', 'constructor']) {
      for (const cap of SITE_SCOPED) {
        expect(() => hasCapability(actor, cap, 'site_a', machineId)).not.toThrow();
        expect(hasCapability(actor, cap, 'site_a', machineId)).toBe(false);
      }
    }
  });

  it('keeps a site id __proto__ as an own key of machineScopes, and the gate reads it', () => {
    const standing = siteStanding([['__proto__', { role: 'admin', swoopMode: null, machineIds: ['m1'] }]]);
    expect(Object.prototype.hasOwnProperty.call(standing.machineScopes, '__proto__')).toBe(true);
    expect(Object.getPrototypeOf({})).toBe(Object.prototype);

    const actor = userActor(standing);
    expect(hasCapability(actor, Capability.MACHINE_EXEC_COMMAND, '__proto__', 'm1')).toBe(true);
    expect(hasCapability(actor, Capability.MACHINE_EXEC_COMMAND, '__proto__', 'm2')).toBe(false);
    expect(hasCapability(actor, Capability.SITE_MEMBER_MANAGE, '__proto__')).toBe(false);
  });

  it('a superadmin with a scope entry holds everything', () => {
    const actor = userActor({
      role: 'superadmin',
      siteRoles: { site_a: 'member' },
      machineScopes: { site_a: ['m1'] },
    });
    for (const cap of ALL_CAPABILITIES) {
      expect(hasCapability(actor, cap, 'site_a', 'm2')).toBe(true);
      expect(hasCapability(actor, cap, 'site_a')).toBe(true);
    }
  });

  it('an actor with no machineScopes key holds nothing site-scoped, with or without a machine', () => {
    for (const siteRole of ['member', 'admin', 'owner'] as SiteRole[]) {
      const actor = noMapActor('member', siteRole);
      for (const cap of ALL_CAPABILITIES) {
        const expected = !isSiteScopedCapability(cap) && GlobalRoleCapabilityMatrix.member.includes(cap);
        for (const machineId of [undefined, 'm2']) {
          expect(hasCapability(actor, cap, 'site_a', machineId)).toBe(expected);
        }
      }
    }
  });

  it('a whole-site actor gives exactly the matrix, with or without a machine', () => {
    for (const siteRole of ['member', 'admin', 'owner'] as SiteRole[]) {
      const actor = userActor({ siteRoles: { site_a: siteRole } });
      expect(actor.machineScopes).toEqual({ site_a: null });
      for (const cap of ALL_CAPABILITIES) {
        const today = isSiteScopedCapability(cap)
          ? SiteRoleCapabilityMatrix[siteRole].includes(cap)
          : GlobalRoleCapabilityMatrix.member.includes(cap);
        for (const machineId of [undefined, 'm2']) {
          expect(hasCapability(actor, cap, 'site_a', machineId)).toBe(today);
        }
      }
    }
  });
});
