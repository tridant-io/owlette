export const Capability = {
  MACHINE_EXEC_COMMAND: 'MACHINE_EXEC_COMMAND',
  // View-only machine commands (screenshot, live view). Read-class: granted to
  // members so non-admins can observe a machine's screen without holding the
  // mutating MACHINE_EXEC_COMMAND capability. Site-scoped like the other
  // machine capabilities.
  MACHINE_VIEW: 'MACHINE_VIEW',
  // Interactive control of a machine through swoop: keyboard, mouse and
  // clipboard injected as SYSTEM, including on the logon, lock and UAC
  // desktops. Split from MACHINE_REMOTE_VIEW because control is an integrity
  // boundary where watching is only a confidentiality one — site admin/owner
  // only, and exempt from the capability_enforcement bypass
  // (BYPASS_EXEMPT_CAPABILITIES, lib/authorizedHandler.server.ts).
  MACHINE_REMOTE_CONTROL: 'MACHINE_REMOTE_CONTROL',
  // Watching a swoop stream: a continuous screen feed plus system audio. This
  // is deliberately NOT MACHINE_VIEW — that one gates a 5-60 s screenshot
  // slideshow, and a live feed with sound is a different exposure, so it gets
  // its own capability instead of riding on the existing one. Members hold it;
  // whether a member may actually watch is the site's `membersMayWatch`
  // setting, enforced in lib/swoop/policy.server.ts and never in this matrix.
  MACHINE_REMOTE_VIEW: 'MACHINE_REMOTE_VIEW',
  // Turning swoop ON for a site, and the policy around it: excluded machines,
  // `membersMayWatch`, and the on-machine indicator. Its OWN capability rather
  // than MACHINE_CONFIG_WRITE because it is the switch in FRONT of the two
  // above, and a switch has to be at least as protected as the thing it
  // controls. Both of those are exempt from the capability_enforcement bypass
  // (BYPASS_EXEMPT_CAPABILITIES, lib/authorizedHandler.server.ts) and this one
  // is too; MACHINE_CONFIG_WRITE could not be, because it also gates the
  // process, schedule and display config the kill switch exists to keep
  // reachable. Site admin/owner, exactly as it was under MACHINE_CONFIG_WRITE.
  SWOOP_SETTINGS_MANAGE: 'SWOOP_SETTINGS_MANAGE',
  MACHINE_CONFIG_WRITE: 'MACHINE_CONFIG_WRITE',
  MACHINE_REMOVE: 'MACHINE_REMOVE',
  DEPLOYMENT_MANAGE: 'DEPLOYMENT_MANAGE',
  DISTRIBUTION_MANAGE: 'DISTRIBUTION_MANAGE',
  UNINSTALL_TRIGGER: 'UNINSTALL_TRIGGER',
  PRESET_MANAGE: 'PRESET_MANAGE',
  SITE_MEMBER_MANAGE: 'SITE_MEMBER_MANAGE',
  // Deleting the site itself, as distinct from administering it. Site-scoped and
  // deliberately ABSENT from SITE_ADMIN_CAPABILITIES: an admin manages a site's
  // members, machines and deployments; only the OWNER destroys it. That is now a
  // plain matrix entry on the owner row — the ownership short-circuits that used
  // to stand in for it are gone.
  SITE_DELETE: 'SITE_DELETE',
  WEBHOOK_MANAGE: 'WEBHOOK_MANAGE',
  SITE_LOGS_MANAGE: 'SITE_LOGS_MANAGE',
  TALON_MANAGE: 'TALON_MANAGE',
  // Per-site alert-rule authoring (`sites/{siteId}/settings/alerts`). Site-scoped
  // rather than global: the rules only ever govern one site's machines, so gating
  // them on GLOBAL_SETTINGS_WRITE would have forced superadmin for a purely
  // site-local setting.
  ALERT_RULES_MANAGE: 'ALERT_RULES_MANAGE',
  // Per-site agent refresh-token revocation. Site-scoped rather than global:
  // MACHINE_REMOVE (already a site-admin capability) deletes the same
  // agent_refresh_tokens rows via the same siteId+machineId query — see
  // lib/actions/removeMachine.server.ts — so an admin who can remove a machine
  // can already destroy its credential. This exposes the narrower action
  // without handing out GLOBAL_SETTINGS_WRITE.
  AGENT_TOKEN_REVOKE: 'AGENT_TOKEN_REVOKE',
  // Enrolling a machine: setup tokens, installer generation, and authorising a
  // device-code pairing phrase. The MIRROR of AGENT_TOKEN_REVOKE — all three mint
  // an agent identity plus a refresh token that never expires, and revoking one
  // is site-admin, so issuing one cannot be less. It was site MEMBERSHIP until
  // the per-site-roles migration made `member` read-only, at which point a
  // read-only user could mint credentials it could not then revoke.
  MACHINE_ENROLL: 'MACHINE_ENROLL',
  USER_ROLE_MANAGE: 'USER_ROLE_MANAGE',
  USER_DELETE: 'USER_DELETE',
  SYSTEM_PRESET_MANAGE: 'SYSTEM_PRESET_MANAGE',
  INSTALLER_MANAGE: 'INSTALLER_MANAGE',
  GLOBAL_SETTINGS_WRITE: 'GLOBAL_SETTINGS_WRITE',
  USER_SELF_PREFS: 'USER_SELF_PREFS',
  USER_SELF_DELETE: 'USER_SELF_DELETE',
} as const;

export type Capability = (typeof Capability)[keyof typeof Capability];

/**
 * GLOBAL role. Only `superadmin` carries authority here; `admin` and `member`
 * are indistinguishable, because a global role no longer confers anything on a
 * site. Wave 5.2 narrows the stored values to `user` | `superadmin`; the parser
 * accepts both spellings meanwhile.
 */
export type Role = 'member' | 'admin' | 'superadmin';

/** PER-SITE role, from `sites/{siteId}/members/{uid}`. This is what grants. */
export type SiteRole = 'owner' | 'admin' | 'member';

export type SystemActorName =
  | 'cortex_autonomous'
  | 'cortex_provisioning'
  | 'scheduled_cleanup'
  | 'talon_runner';

export type UserActor = {
  type: 'user';
  userId: string;
  /** Present when the user is acting through an API key. */
  apiKeyId?: string;
  role: Role;
  /**
   * Per-site standing for the sites resolved for THIS request, keyed by site id.
   *
   * A site absent from the map means no active membership was found, and every
   * site-scoped capability denies. That is the point: the previous shape carried
   * `sites: string[]` and combined it with the GLOBAL role, so one global `admin`
   * held site-admin on every site in the array. Membership now carries the role
   * itself, so standing cannot leak from one site to another.
   *
   * Usually holds exactly one entry — the site the request names. Resolving the
   * caller's full membership would cost a collection-group query per request.
   */
  siteRoles: Readonly<Record<string, SiteRole>>;
};

export type SystemActor = {
  type: 'system';
  name: SystemActorName;
  siteId: string;
};

export type Actor = UserActor | SystemActor;

/**
 * Held by every authenticated user, on no site in particular. Self-service only:
 * anything a user does to their OWN account. A global role adds nothing to this
 * list — superadmin short-circuits before any lookup, and every other global
 * value grants exactly this.
 */
const SELF_CAPABILITIES: readonly Capability[] = [
  Capability.USER_SELF_PREFS,
  Capability.USER_SELF_DELETE,
];

/** Per-site `member`: a read-only operator who may observe a machine's screen. */
const SITE_MEMBER_CAPABILITIES: readonly Capability[] = [
  Capability.MACHINE_VIEW,
  Capability.MACHINE_REMOTE_VIEW,
];

const SITE_ADMIN_CAPABILITIES: readonly Capability[] = [
  ...SITE_MEMBER_CAPABILITIES,
  Capability.MACHINE_EXEC_COMMAND,
  Capability.MACHINE_REMOTE_CONTROL,
  Capability.SWOOP_SETTINGS_MANAGE,
  Capability.MACHINE_CONFIG_WRITE,
  // Site-scoped (see SITE_SCOPED_CAPABILITIES): admins can remove machines on their
  // OWN assigned sites; superadmins on any site.
  Capability.MACHINE_REMOVE,
  Capability.DEPLOYMENT_MANAGE,
  Capability.DISTRIBUTION_MANAGE,
  Capability.UNINSTALL_TRIGGER,
  Capability.PRESET_MANAGE,
  Capability.WEBHOOK_MANAGE,
  Capability.SITE_LOGS_MANAGE,
  Capability.SITE_MEMBER_MANAGE,
  Capability.TALON_MANAGE,
  Capability.AGENT_TOKEN_REVOKE,
  Capability.MACHINE_ENROLL,
  Capability.ALERT_RULES_MANAGE,
  // NOTE: SITE_DELETE is deliberately absent — see its definition above. It sits
  // on the owner row below, and on nothing else but superadmin.
];

/** Per-site `owner`: everything an admin holds, plus destroying the site. */
const SITE_OWNER_CAPABILITIES: readonly Capability[] = [
  ...SITE_ADMIN_CAPABILITIES,
  Capability.SITE_DELETE,
];

const SITE_SCOPED_CAPABILITIES: ReadonlySet<Capability> = new Set<Capability>([
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
]);

/** What each PER-SITE role grants on the site it is held for. */
export const SiteRoleCapabilityMatrix: Readonly<Record<SiteRole, readonly Capability[]>> = {
  member: SITE_MEMBER_CAPABILITIES,
  admin: SITE_ADMIN_CAPABILITIES,
  owner: SITE_OWNER_CAPABILITIES,
};

/**
 * What each GLOBAL role grants on its own. `member` and `admin` are identical
 * and always will be — the entry exists so the exhaustiveness of `Role` is
 * checked, not because the tiers differ. Superadmin never reaches this table;
 * `hasCapability` short-circuits above it.
 */
export const GlobalRoleCapabilityMatrix: Readonly<Record<Role, readonly Capability[]>> = {
  member: SELF_CAPABILITIES,
  admin: SELF_CAPABILITIES,
  superadmin: Object.values(Capability),
};

export const SystemCapabilityMatrix: Readonly<
  Record<SystemActorName, readonly Capability[]>
> = {
  cortex_autonomous: [
    Capability.MACHINE_EXEC_COMMAND,
    Capability.MACHINE_CONFIG_WRITE,
  ],
  cortex_provisioning: [],
  scheduled_cleanup: [
    Capability.MACHINE_REMOVE,
    Capability.DEPLOYMENT_MANAGE,
  ],
  talon_runner: [Capability.MACHINE_EXEC_COMMAND],
};

export function isSiteScopedCapability(capability: Capability): boolean {
  return SITE_SCOPED_CAPABILITIES.has(capability);
}

export function hasCapability(
  actor: Actor,
  capability: Capability,
  siteId?: string
): boolean {
  if (actor.type === 'system') {
    const allowed = SystemCapabilityMatrix[actor.name];
    if (!allowed.includes(capability)) return false;
    if (isSiteScopedCapability(capability)) {
      if (!siteId) return false;
      if (actor.siteId !== siteId) return false;
    }
    return true;
  }

  // Superadmin short-circuits BEFORE any lookup. It is a platform-wide role, not
  // a per-site one, and superadmins deliberately hold no member rows — routing
  // them through the site matrix would deny them everything.
  if (actor.role === 'superadmin') return true;

  if (isSiteScopedCapability(capability)) {
    if (!siteId) return false;
    // Absent membership denies. The caller is responsible for populating
    // `siteRoles` for the site it is asking about; an unresolved site must never
    // read as a grant.
    const siteRole = actor.siteRoles[siteId];
    if (siteRole === undefined) return false;
    return SiteRoleCapabilityMatrix[siteRole].includes(capability);
  }

  // Not site-scoped: the global role grants self-service and nothing else.
  // Platform capabilities (USER_ROLE_MANAGE, INSTALLER_MANAGE,
  // GLOBAL_SETTINGS_WRITE …) are superadmin-only and were answered above.
  return GlobalRoleCapabilityMatrix[actor.role].includes(capability);
}
