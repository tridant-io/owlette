import { scopeCovers } from '@/lib/machineAccess';
import type { SwoopMode } from '@/lib/swoopMode';

export const Capability = {
  MACHINE_EXEC_COMMAND: 'MACHINE_EXEC_COMMAND',
  // View-only machine commands (screenshot, live view). Read-class: granted to
  // members so non-admins can observe a machine's screen without holding the
  // mutating MACHINE_EXEC_COMMAND capability. Site-scoped like the other
  // machine capabilities.
  MACHINE_VIEW: 'MACHINE_VIEW',
  // interactive control of a machine through swoop: keyboard, mouse and
  // clipboard injected as SYSTEM, including on the logon, lock and UAC
  // desktops. split from MACHINE_REMOTE_VIEW because control is an integrity
  // boundary where watching is only a confidentiality one. by default it
  // belongs to site admins and owners. a person's swoop mode on their member
  // row widens or narrows this and MACHINE_REMOTE_VIEW, and nothing else (owner
  // ruling, 2026-11-04). exempt from the capability_enforcement bypass
  // (BYPASS_EXEMPT_CAPABILITIES, lib/authorizedHandler.server.ts).
  MACHINE_REMOTE_CONTROL: 'MACHINE_REMOTE_CONTROL',
  // watching a swoop stream: a continuous screen feed plus system audio. this
  // is deliberately not MACHINE_VIEW: that one gates a 5-60 s screenshot
  // slideshow, and a live feed with sound is a different exposure, so it gets
  // its own capability instead of riding on the existing one. by default it
  // belongs to members, and so to admins and owners too; a member with no swoop
  // mode of their own watches only where the site's `membersMayWatch` allows,
  // which lib/swoop/policy.server.ts enforces and this matrix never does. a
  // person's swoop mode on their member row widens or narrows this and
  // MACHINE_REMOTE_CONTROL, and nothing else (owner ruling, 2026-11-04). exempt
  // from the capability_enforcement bypass, as MACHINE_REMOTE_CONTROL is.
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
  // granting machines of a site the fleet mcp (ADR 0017): which machines may
  // act, at what tier, on which machines. site admin and owner, and site-wide,
  // so a scoped admin never holds it: a grant reaches machines beyond theirs.
  FLEET_SETTINGS_MANAGE: 'FLEET_SETTINGS_MANAGE',
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
  // Putting a site on the owner's card: checkout, plan changes, the billing portal.
  // Owner row only, like SITE_DELETE: an admin must not spend the owner's money.
  SITE_BILLING_MANAGE: 'SITE_BILLING_MANAGE',
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
  // Enrolling a machine: authorising a device-code pairing phrase. The MIRROR of
  // AGENT_TOKEN_REVOKE — it mints an agent identity plus a refresh token that
  // never expires, and revoking one
  // is site-admin, so issuing one cannot be less. It was site MEMBERSHIP until
  // the per-site-roles migration made `member` read-only, at which point a
  // read-only user could mint credentials it could not then revoke.
  MACHINE_ENROLL: 'MACHINE_ENROLL',
  USER_ROLE_MANAGE: 'USER_ROLE_MANAGE',
  USER_DELETE: 'USER_DELETE',
  SYSTEM_PRESET_MANAGE: 'SYSTEM_PRESET_MANAGE',
  INSTALLER_MANAGE: 'INSTALLER_MANAGE',
  // triage status on the issues users submit to owlette support
  ISSUE_MANAGE: 'ISSUE_MANAGE',
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
  /**
   * explicit swoop modes by site, from the member row's `swoop`. a site absent
   * here follows its role. only MACHINE_REMOTE_VIEW and MACHINE_REMOTE_CONTROL
   * read it. required, and written only by `siteStanding`, so the compiler names
   * any builder that skips it: a dropped mode hands an admin held to view their
   * control back.
   */
  swoopModes: Readonly<Record<string, SwoopMode>>;
  /**
   * machine scopes by site, from the member row's `machineIds`: the machines
   * the person reaches there, or null for the whole site. `siteStanding` writes
   * an entry for every site in `siteRoles`. a site with no entry reaches
   * nothing. required, so the compiler names any builder that skips
   * `siteStanding`: a dropped scope hands a scoped member the whole site.
   */
  machineScopes: Readonly<Record<string, readonly string[] | null>>;
};

export type SystemActor = {
  type: 'system';
  name: SystemActorName;
  siteId: string;
};

/**
 * a machine a site admin has granted, calling the fleet routes with its fleet
 * session (ADR 0017). it exists only on those routes: nothing that resolves a
 * person or a member row ever sees one.
 */
export type MachineActor = {
  type: 'machine';
  siteId: string;
  machineId: string;
  maxTier: 1 | 2 | 3;
  /** the machines it may act on, as `scopeCovers` reads them: null only for an explicit whole-site grant, `[]` for none */
  machineIds: readonly string[] | null;
};

export type Actor = UserActor | SystemActor | MachineActor;

/** one site's standing as its member row states it. */
export interface MemberStanding {
  role: SiteRole | null;
  swoopMode: SwoopMode | null;
  /** the member row's machine scope (`parseMachineIds`); null means the whole site. */
  machineIds: readonly string[] | null;
}

/**
 * every UserActor built from a member row gets its per-site fields here, so
 * whatever the row carries reaches every gate. a builder that dropped the mode
 * would hand an admin held to view their control back, and one that dropped
 * the scope would hand a scoped member the whole site.
 *
 * takes `[siteId, standing]` pairs, not a record keyed by site id: a request's
 * site id as a computed key, or written as one, reads as prototype pollution
 * to the code scanner (js/remote-property-injection, 311-313 and 425-429),
 * however the object was made. pairs say the same thing without one.
 *
 * all three maps are always returned. `swoopModes` holds the sites with a
 * mode. `machineScopes` holds an entry for every site in `siteRoles`, null for
 * the whole site, owner rows included: the rules scope an owner row that
 * carries the field, and the writers never put it there.
 */
export function siteStanding(bySite: Iterable<readonly [string, MemberStanding]>): {
  siteRoles: Record<string, SiteRole>;
  swoopModes: Record<string, SwoopMode>;
  machineScopes: Record<string, readonly string[] | null>;
} {
  const roles: Array<readonly [string, SiteRole]> = [];
  const modes: Array<readonly [string, SwoopMode]> = [];
  const scopes: Array<readonly [string, readonly string[] | null]> = [];
  for (const [siteId, { role, swoopMode, machineIds }] of bySite) {
    if (role === null) continue;
    roles.push([siteId, role]);
    // the owner always controls, so an owner row's mode is never carried
    if (role !== 'owner' && swoopMode !== null) modes.push([siteId, swoopMode]);
    scopes.push([siteId, machineIds]);
  }
  return {
    siteRoles: recordOf(roles),
    swoopModes: recordOf(modes),
    machineScopes: recordOf(scopes),
  };
}

/**
 * a record with no prototype: SITE_ID_RE admits `__proto__` as a site id, and
 * a site that is not there must look up as nothing, not as Object.prototype.
 */
function recordOf<V>(entries: ReadonlyArray<readonly [string, V]>): Record<string, V> {
  return Object.setPrototypeOf(Object.fromEntries(entries), null) as Record<string, V>;
}

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
  Capability.FLEET_SETTINGS_MANAGE,
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

/** Per-site `owner`: everything an admin holds, plus destroying the site and paying for it. */
const SITE_OWNER_CAPABILITIES: readonly Capability[] = [
  ...SITE_ADMIN_CAPABILITIES,
  Capability.SITE_DELETE,
  Capability.SITE_BILLING_MANAGE,
];

const SITE_SCOPED_CAPABILITIES: ReadonlySet<Capability> = new Set<Capability>([
  Capability.MACHINE_EXEC_COMMAND,
  Capability.MACHINE_VIEW,
  Capability.MACHINE_REMOTE_CONTROL,
  Capability.MACHINE_REMOTE_VIEW,
  Capability.SWOOP_SETTINGS_MANAGE,
  Capability.FLEET_SETTINGS_MANAGE,
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
  Capability.SITE_BILLING_MANAGE,
]);

/**
 * these act on one machine, and they are the only capabilities a scoped actor
 * can hold. every other site-scoped capability is site-wide, the machine-sized
 * ones included: MACHINE_REMOVE changes the site's fleet, UNINSTALL_TRIGGER is
 * the deploy page's surface, MACHINE_ENROLL and AGENT_TOKEN_REVOKE mint and
 * revoke the site's agent credentials, and SWOOP_SETTINGS_MANAGE also gates
 * kill and the site's swoop sessions list (release 2). the owner kept the first
 * two site-wide (open question 2, 2026-11-04).
 */
export const MACHINE_CAPABILITIES: ReadonlySet<Capability> = new Set<Capability>([
  Capability.MACHINE_VIEW,
  Capability.MACHINE_REMOTE_VIEW,
  Capability.MACHINE_EXEC_COMMAND,
  Capability.MACHINE_REMOTE_CONTROL,
  Capability.MACHINE_CONFIG_WRITE,
]);

export function isMachineCapability(capability: Capability): boolean {
  return MACHINE_CAPABILITIES.has(capability);
}

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

/** the person's explicit swoop mode on a site, or null when their role decides. */
export function explicitSwoopMode(actor: Actor, siteId: string): SwoopMode | null {
  if (actor.type !== 'user' || !actor.swoopModes) return null;
  // own properties only, for the reason `hasCapability` gives for siteRoles
  if (!Object.prototype.hasOwnProperty.call(actor.swoopModes, siteId)) return null;
  return actor.swoopModes[siteId];
}

/**
 * the machines a person reaches on a site, or null for the whole site. a map
 * without the site, or an entry that is neither null nor a list, reaches
 * nothing. the map is required, so only a test literal, which tsc never
 * checks, can lack it; such an actor reaches nothing too. a superadmin without
 * one stays whole-site, though every caller answers a superadmin before asking.
 */
export function machineScopeOf(actor: UserActor, siteId: string): readonly string[] | null {
  if (!actor.machineScopes) return actor.role === 'superadmin' ? null : [];
  // own properties only, for the reason `hasCapability` gives for siteRoles
  if (!Object.prototype.hasOwnProperty.call(actor.machineScopes, siteId)) return [];
  const machineScope = actor.machineScopes[siteId];
  if (machineScope === null) return null;
  return Array.isArray(machineScope) ? machineScope : [];
}

/**
 * may this actor do this, on this site, on this machine?
 *
 * system actors answer from SystemCapabilityMatrix, and a superadmin holds
 * everything. a granted machine holds MACHINE_VIEW and MACHINE_EXEC_COMMAND on
 * its own site and nothing else: on a named machine only when its grant covers
 * it, MACHINE_EXEC_COMMAND only at tier 2 or 3, and with no machine named only
 * MACHINE_VIEW, the fleet routes' list call.
 * a person's site-scoped capability passes three steps, in order:
 * 1. the role matrix, from their site role;
 * 2. their swoop mode (release 2), which alone decides MACHINE_REMOTE_VIEW and
 *    MACHINE_REMOTE_CONTROL when the row sets one, never on an owner row;
 * 3. their machine scope: a scoped actor holds only the machine-class
 *    capabilities (MACHINE_CAPABILITIES), and only on a machine in scope. no
 *    `machineId` denies a scoped actor, so a site-level check never reaches a
 *    scoped person, and a whole-site person never needs one.
 */
export function hasCapability(
  actor: Actor,
  capability: Capability,
  siteId?: string,
  machineId?: string
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

  if (actor.type === 'machine') {
    if (capability !== Capability.MACHINE_VIEW && capability !== Capability.MACHINE_EXEC_COMMAND) return false;
    if (!siteId || actor.siteId !== siteId) return false;
    // a malformed list reaches nothing, as a person's scope does in machineScopeOf
    if (actor.machineIds !== null && !Array.isArray(actor.machineIds)) return false;
    // tier 1 only reads, and a tier that is not 2 or 3 is read as tier 1
    if (capability === Capability.MACHINE_EXEC_COMMAND && actor.maxTier !== 2 && actor.maxTier !== 3) return false;
    // with no machine named it may only list; a command always names its machine
    if (machineId === undefined) return capability === Capability.MACHINE_VIEW;
    return scopeCovers(actor.machineIds, machineId);
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
    //
    // Own properties only. A siteId spelling an Object.prototype member
    // ('constructor', 'toString', '__proto__', …) returns an inherited function,
    // which survives the `=== undefined` guard and then indexes the matrix below
    // with a function — a TypeError on an auth path. Every caller today resolves
    // the site before asking, so this is defence in depth at the one choke point
    // rather than in all 14 of them.
    if (!Object.prototype.hasOwnProperty.call(actor.siteRoles, siteId)) return false;
    const siteRole = actor.siteRoles[siteId];
    if (siteRole === undefined) return false;
    // 1. the role matrix, 2. a person's swoop mode. the owner always controls,
    // whatever a hand-built actor carries
    let held = SiteRoleCapabilityMatrix[siteRole].includes(capability);
    if (
      (capability === Capability.MACHINE_REMOTE_VIEW || capability === Capability.MACHINE_REMOTE_CONTROL) &&
      siteRole !== 'owner'
    ) {
      const mode = explicitSwoopMode(actor, siteId);
      if (mode !== null) {
        held = capability === Capability.MACHINE_REMOTE_CONTROL ? mode === 'control' : mode !== 'none';
      }
    }
    if (!held) return false;
    // 3. machine scope: a scoped actor holds machine-class capabilities on its machines only
    const machineScope = machineScopeOf(actor, siteId);
    if (machineScope === null) return true;
    if (!MACHINE_CAPABILITIES.has(capability)) return false;
    return machineId !== undefined && machineScope.includes(machineId);
  }

  // Not site-scoped: the global role grants self-service and nothing else.
  // Platform capabilities (USER_ROLE_MANAGE, INSTALLER_MANAGE,
  // GLOBAL_SETTINGS_WRITE …) are superadmin-only and were answered above.
  return GlobalRoleCapabilityMatrix[actor.role].includes(capability);
}
