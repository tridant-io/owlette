/**
 * @jest-environment node
 */
import {
  Capability,
  SiteRoleCapabilityMatrix,
  GlobalRoleCapabilityMatrix,
  SystemCapabilityMatrix,
  hasCapability,
  isSiteScopedCapability,
  type Actor,
  type SiteRole,
  type SystemActorName,
  type UserActor,
  type SystemActor,
} from '@/lib/capabilities';

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

function userActor(overrides: Partial<UserActor> = {}): UserActor {
  return {
    type: 'user',
    userId: 'uid_default',
    role: 'member',
    siteRoles: {},
    ...overrides,
  };
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
