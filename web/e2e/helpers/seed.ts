/**
 * Deterministic test data for the Firestore + Auth emulators. Called by
 * global-setup; specs may also call these to extend the baseline.
 */

import { FieldValue } from 'firebase-admin/firestore';
import { getAdminAuth, getAdminDb } from './emulator';

/**
 * FIXTURE identities, not global roles. `owner` is the important one: a global
 * `member` who OWNS a site, which is what every self-serve customer actually is
 * (`bootstrapUser.server.ts` creates them as `member`, and `POST /api/sites` has
 * no capability gate). That shape is the one that shipped a production bug —
 * Davor, 2026-09-04 — and the suite could not express it until now.
 */
export type TestRole = 'member' | 'admin' | 'superadmin' | 'owner';

/** What actually lands in `users/{uid}.role`. */
export type GlobalRole = 'member' | 'admin' | 'superadmin';

export interface TestUser {
  uid: string;
  email: string;
  password: string;
  /** GLOBAL role. Grants nothing on a site since wave 5.1. */
  role: GlobalRole;
  sites: string[];
  /**
   * Per-site standing, overriding the global-role mirror `seedUser` applies.
   * This is how a fixture can be a global `member` and a site `owner` at once.
   */
  siteRoles?: Record<string, SeedMemberRole>;
  displayName?: string;
}

/**
 * Canonical test-user fleet. admin-uid is a site-admin on site-A via its member
 * ROW, not a platform superadmin; super-uid reaches every site through the
 * superadmin short-circuit in `canAccessSite`, which runs before membership is
 * consulted at all.
 *
 * The rules matrix these once mirrored (`scripts/checks/test-rules.mjs`) was
 * deleted 2026-09-07: it seeded `users/{uid}.sites[]` with no member rows and
 * asserted the site read SUCCEEDED, which the per-site-roles migration made
 * false. It ran in no CI job, so it sat red and unread — and the obvious way to
 * "fix" that red is to make the rules honour `sites[]` again, reopening the
 * escalation the migration closed. Its coverage lives in `web/__tests__/rules/`,
 * which the `rules` CI job actually runs.
 */
export const TEST_USERS: Record<TestRole, TestUser> = {
  member: {
    uid: 'member-uid',
    email: 'member@e2e.test',
    password: 'e2e-member-password',
    role: 'member',
    sites: ['site-A'],
    displayName: 'E2E Member',
  },
  admin: {
    uid: 'admin-uid',
    email: 'admin@e2e.test',
    password: 'e2e-admin-password',
    role: 'admin',
    sites: ['site-A'],
    displayName: 'E2E Admin',
  },
  superadmin: {
    uid: 'super-uid',
    email: 'super@e2e.test',
    password: 'e2e-super-password',
    role: 'superadmin',
    sites: [],
    displayName: 'E2E Superadmin',
  },
  // A global `member` who owns site-C. The global role grants nothing; the
  // `owner` membership is the whole of their authority, which is exactly the
  // real customer shape and the one the old superadmin-only suite could not test.
  owner: {
    uid: 'owner-uid',
    email: 'owner@e2e.test',
    password: 'e2e-owner-password',
    role: 'member',
    sites: ['site-C'],
    siteRoles: { 'site-C': 'owner' },
    displayName: 'E2E Owner',
  },
};

/**
 * Create the Auth account (if missing) and the Firestore users/{uid} doc.
 * MFA is pre-satisfied so the redirect gates in dashboard/ and login/ don't
 * trip the E2E flow.
 */
export async function seedUser(user: TestUser): Promise<void> {
  const auth = getAdminAuth();
  const db = getAdminDb();

  // Idempotent: update if the uid/email already exists.
  try {
    await auth.createUser({
      uid: user.uid,
      email: user.email,
      password: user.password,
      displayName: user.displayName,
      emailVerified: true,
    });
  } catch (err: unknown) {
    const code = (err as { code?: string })?.code;
    if (code === 'auth/uid-already-exists' || code === 'auth/email-already-exists') {
      await auth.updateUser(user.uid, {
        email: user.email,
        password: user.password,
        displayName: user.displayName,
        emailVerified: true,
      });
    } else {
      throw err;
    }
  }

  await db.collection('users').doc(user.uid).set({
    email: user.email,
    role: user.role,
    // Membership is granted below, through grantMembership — seeded empty here
    // so there is exactly one writer of `sites[]`.
    sites: [],
    displayName: user.displayName ?? '',
    createdAt: new Date(),
    // MFA bypass — avoids the /setup-2fa and /verify-2fa redirect gates.
    // `mfaFactors` is what the app reads (lib/mfaFactors.server.ts derives
    // mfaEnrolled from it); seed it explicitly or the fixture looks like an
    // account whose inventory was never computed. Legacy `passkeyEnrolled` is
    // deliberately not seeded — nothing reads it any more.
    mfaEnrolled: false,
    requiresMfaSetup: false,
    mfaFactors: { totp: false, passkeys: 0 },
    preferences: {
      temperatureUnit: 'C',
      timezone: 'UTC',
      timeFormat: '12h',
      timeDisplayMode: 'machine',
      healthAlerts: true,
      processAlerts: true,
      thresholdAlerts: true,
      cortexAlerts: true,
      mutedMachines: [],
      alertCcEmails: [],
      statsExpanded: true,
      processesExpanded: true,
    },
  });

  // One writer, not two: the user document above no longer carries membership.
  //
  // The GLOBAL role is mirrored onto each of the fixture's sites, because that is
  // what it used to confer there — the `admin` fixture was a site admin on site-A,
  // and 61 of 81 spec files depend on it staying one. Superadmins get no row,
  // matching production: they reach every site by global role and hold none.
  for (const siteId of user.sites) {
    if (user.role === 'superadmin') continue;
    const explicit = user.siteRoles?.[siteId];
    await grantMembership(
      siteId,
      user.uid,
      explicit ?? (user.role === 'admin' ? 'admin' : 'member')
    );
  }
}

/** Per-site standing a fixture can grant. Mirrors the production role set. */
export type SeedMemberRole = 'owner' | 'admin' | 'member';

/**
 * THE seeding entry point for site membership. Every fixture that needs a user
 * on a site goes through here — nothing writes `users/{uid}.sites[]` or
 * `sites/{siteId}.owner` directly.
 *
 * `sites/{siteId}/members/{uid}` is what GRANTS access, as of wave 5.1: both the
 * rules and the server matrix resolve from it, and neither reads the legacy
 * fields any more. Those are still written because wave 6.1 has not stripped
 * them yet and the client still unions them in — but they confer nothing, so a
 * fixture seeded without a member row is simply denied.
 *
 * That the seam existed is why this is one edit instead of one per spec file.
 */
export async function grantMembership(
  siteId: string,
  uid: string,
  role: SeedMemberRole = 'member',
): Promise<void> {
  const db = getAdminDb();
  await db
    .collection('users')
    .doc(uid)
    .set({ sites: FieldValue.arrayUnion(siteId) }, { merge: true });
  if (role === 'owner') {
    await db.collection('sites').doc(siteId).set({ owner: uid }, { merge: true });
  }
  await seedMemberRow(siteId, uid, role);
}

/**
 * Write ONLY `sites/{siteId}/members/{uid}` — no user document, no `sites[]`.
 *
 * Split out of `grantMembership` for two callers that must not mint a user doc:
 * `seedSite`, whose TEST_SITES owners are deliberately not real users, and the
 * api specs that seed a site inline. Since wave 5.1 this row is what GRANTS, so
 * a site seeded without one is unreadable even by the uid its `owner` field
 * names — which is exactly how the owner-delete spec started failing.
 */
export async function seedMemberRow(
  siteId: string,
  uid: string,
  role: SeedMemberRole = 'member',
): Promise<void> {
  await getAdminDb()
    .collection('sites')
    .doc(siteId)
    .collection('members')
    .doc(uid)
    .set({
      uid,
      role,
      status: 'active',
      addedAt: new Date(0),
      addedBy: 'system:e2e-seed',
    });
}

export interface TestSite {
  id: string;
  name: string;
  owner: string; // uid of site owner; doesn't have to be a test user
  timezone?: string;
}

export const TEST_SITES: TestSite[] = [
  { id: 'site-A', name: 'Site A (Assigned)', owner: 'someone-else', timezone: 'UTC' },
  { id: 'site-B', name: 'Site B (Unassigned)', owner: 'someone-else', timezone: 'UTC' },
  // Owned by a REAL fixture, unlike A and B whose 'someone-else' owner is not a
  // user. Sorts after both by name, so it never displaces site-A as the default
  // selection for the fixtures that already depend on that.
  { id: 'site-C', name: 'Site C (Owned)', owner: 'owner-uid', timezone: 'UTC' },
];

export async function seedSite(site: TestSite): Promise<void> {
  const db = getAdminDb();
  await db.collection('sites').doc(site.id).set({
    name: site.name,
    // `owner` stays part of the SITE document rather than going through
    // grantMembership: TEST_SITES owners are deliberately NOT test users
    // ('someone-else'), which is what makes site-A "assigned but not owned".
    // Routing it through the membership helper would mint phantom user
    // documents for owners that are not meant to exist.
    owner: site.owner,
    timezone: site.timezone ?? 'UTC',
    createdAt: new Date(),
  });
  // Ownership is a member row since wave 5.1; the `owner` field above grants
  // nothing. Written through `seedMemberRow` rather than `grantMembership` so a
  // non-user owner like 'someone-else' still gets no phantom user document.
  await seedMemberRow(site.id, site.owner, 'owner');
}

/**
 * Revoke one fixture's membership of a site WITHOUT deleting the site.
 *
 * The counterpart to `releaseFixtureSite`, which is for sites a spec created and
 * must remove entirely. Use this when a spec borrows a BASELINE site (site-A/B/C)
 * for a fixture that does not normally hold it — the grant has to come back off,
 * or site auto-selection carries it into every later spec.
 */
export async function revokeMembership(siteId: string, uid: string): Promise<void> {
  const db = getAdminDb();
  await db
    .collection('users')
    .doc(uid)
    .update({ sites: FieldValue.arrayRemove(siteId) })
    .catch(() => undefined);
  await db
    .collection('sites')
    .doc(siteId)
    .collection('members')
    .doc(uid)
    .delete()
    .catch(() => undefined);
}

/**
 * Undo a spec's temporary site grant. Call it from `afterAll` in any spec that
 * seeds a site of its own onto a shared fixture.
 *
 * Leaving the grant behind makes site auto-selection prefer the spec's site over
 * `site-A` for every LATER spec, whose own seeds then never render — the suite
 * runs `workers: 1`, so this is ordinary sequential contamination, and it cost 9
 * co-run specs on 2026-08-12.
 *
 * It matters more since wave 5.1. Before it, a leftover site was invisible
 * anyway: the fixture held no member row, so the client listener was denied and
 * the site never entered the switcher. Now that specs seed the row that grants,
 * the leftover site is fully visible and the hazard is live again.
 */
export async function releaseFixtureSite(siteId: string, uid = 'admin-uid'): Promise<void> {
  const db = getAdminDb();
  await db
    .collection('users')
    .doc(uid)
    .update({ sites: FieldValue.arrayRemove(siteId) })
    .catch(() => undefined);
  await db
    .collection('sites')
    .doc(siteId)
    .collection('members')
    .doc(uid)
    .delete()
    .catch(() => undefined);
  await db.collection('sites').doc(siteId).delete().catch(() => undefined);
}

/** The canonical baseline: three users + two sites. Called by global-setup. */
export async function seedBaseline(): Promise<void> {
  // Sites first — some rules guards reference site docs via get().
  await Promise.all(TEST_SITES.map(seedSite));
  await Promise.all(Object.values(TEST_USERS).map(seedUser));
}

export interface SeedMachineOptions {
  /** Custom display name (defaults to machineId). */
  displayName?: string;
  /** Seconds to backdate `lastHeartbeat`. >300 reads as offline (useMachines). */
  heartbeatOffsetSec?: number;
  /** Monitors in the display profile. Default 2; 0 writes no display subdoc. */
  monitorCount?: number;
  /**
   * Explicit per-monitor specs — overrides `monitorCount`'s uniform dual
   * 1920×1080. Added when the mixed-states fleet read as fake: every machine
   * carried the same two "Test Monitor" screens on camera. Positions are
   * computed left-to-right; rotation 90/270 swaps the footprint.
   */
  monitors?: Array<{
    widthPx: number;
    heightPx: number;
    rotation?: 0 | 90 | 180 | 270;
    friendlyName?: string;
  }>;
  /**
   * Seconds until an in-flight reboot fires. Writes `rebooting` +
   * `rebootScheduledAt` so MachineStatusPill renders its countdown variant.
   */
  rebootingInSec?: number;
  /**
   * The amber "reboot pending" banner (card view only), which the agent writes
   * after a process crash. `true` for defaults, or an object to override.
   */
  rebootPending?:
    | boolean
    | {
        processName?: string;
        reason?: string;
      };
}

/**
 * Set a site's swoop policy (`sites/{siteId}/settings/swoop`, merged) and return
 * a function that puts it back exactly as it was found: site-A is shared, and
 * the machine menu offers swoop only where the site has it on.
 */
export async function setSiteSwoop(
  siteId: string,
  patch: Record<string, unknown>,
): Promise<() => Promise<void>> {
  const ref = getAdminDb().doc(`sites/${siteId}/settings/swoop`);
  const before = (await ref.get()).data();
  await ref.set(patch, { merge: true });
  return async () => {
    if (before) await ref.set(before);
    else await ref.delete();
  };
}

/**
 * Seed a machine with enough state for the dashboard card AND for
 * DisplayLayoutPanel to mount a real profile. Writes the status doc plus
 * `hardware/display` (what `useDisplayState` subscribes to). The Admin SDK
 * bypasses firestore.rules, so auth state is irrelevant. Overwrites on re-run.
 */
export async function seedMachine(
  siteId: string,
  machineId: string,
  opts: SeedMachineOptions = {},
): Promise<void> {
  const db = getAdminDb();
  const nowSec = Math.floor(Date.now() / 1000);
  const heartbeat = nowSec - (opts.heartbeatOffsetSec ?? 0);
  const monitorCount = opts.monitorCount ?? 2;

  // Mirrors what the agent writes mid-reboot. `rebootScheduledAt` is Unix
  // seconds; `rebooting: true` keeps the pill active past the target time.
  const rebootingExtras =
    typeof opts.rebootingInSec === 'number'
      ? {
          rebooting: true,
          rebootScheduledAt: nowSec + opts.rebootingInSec,
        }
      : {};

  const rebootPendingExtras = opts.rebootPending
    ? {
        rebootPending: {
          active: true,
          processName:
            typeof opts.rebootPending === 'object'
              ? opts.rebootPending.processName ?? 'test-process'
              : 'test-process',
          reason:
            typeof opts.rebootPending === 'object'
              ? opts.rebootPending.reason ?? 'process crashed'
              : 'process crashed',
          timestamp: nowSec,
        },
      }
    : {};

  // Status doc for useMachines. Empty `metrics` keeps the card minimal — the
  // display-panel test needs no sparkline data.
  await db
    .collection('sites')
    .doc(siteId)
    .collection('machines')
    .doc(machineId)
    .set({
      online: true,
      lastHeartbeat: heartbeat,
      agent_version: '2.9.0',
      machine_timezone_iana: 'UTC',
      // Without the capability handshake the recall button stays disabled on an
      // "agent too old" tooltip, breaking every recall spec.
      capabilities: { displayRemoteApply: 1 },
      metrics: {
        schemaVersion: 2,
        timestamp: new Date(),
      },
      ...rebootingExtras,
      ...rebootPendingExtras,
    });

  // Offset positions so DisplayCanvas has something non-trivial to render.
  // `edidHash` is the drift-matching identity key — synthetic but stable, so
  // re-runs are deterministic.
  const monitorSpecs =
    opts.monitors ??
    (monitorCount > 0
      ? Array.from({ length: monitorCount }, () => ({
          widthPx: 1920,
          heightPx: 1080,
          rotation: 0 as const,
          friendlyName: undefined,
        }))
      : []);
  if (monitorSpecs.length > 0) {
    let cursorX = 0;
    const monitors = monitorSpecs.map((m, i) => {
      const rotated = m.rotation === 90 || m.rotation === 270;
      const rec = {
        id: `MONITOR\\TEST${i}`,
        edidHash: `hash-${machineId}-${i}`,
        manufacturerId: 'TST',
        productCode: `000${i}`,
        serialNumber: `SN${i}`,
        friendlyName: m.friendlyName ?? `Test Monitor ${i + 1}`,
        position: { x: cursorX, y: 0 },
        resolution: { width: m.widthPx, height: m.heightPx },
        refreshHz: 60,
        rotation: m.rotation ?? 0,
        scalePct: 100,
        primary: i === 0,
        connectionType: 'dp',
        adapterLuid: '0:0',
        targetId: i,
      };
      cursorX += rotated ? m.heightPx : m.widthPx;
      return rec;
    });

    await db
      .collection('sites')
      .doc(siteId)
      .collection('machines')
      .doc(machineId)
      .collection('hardware')
      .doc('display')
      .set({
        schemaVersion: 1,
        signatureHash: `sig-${machineId}`,
        capturedAt: Date.now(),
        monitors,
        mosaicActive: false,
      });
  }
}

export interface SeedRoostOptions {
  /** Display name. Defaults to the roostId. */
  name?: string;
  /** Machine ids this roost deploys to. Defaults to []. */
  targets?: string[];
  /** Optional extract path on the agent side. */
  extractPath?: string;
  /** Starting version counter. Defaults to 0 (no versions yet). */
  versionCounter?: number;
}

/**
 * Roost doc only — version pointers stay null until `seedVersion` /
 * `seedRoostWithVersionHistory` populate them. Idempotent via merge.
 */
export async function seedRoost(
  siteId: string,
  roostId: string,
  opts: SeedRoostOptions = {},
): Promise<void> {
  const db = getAdminDb();
  const extractPathField =
    typeof opts.extractPath === 'string' ? { extractPath: opts.extractPath } : {};

  await db
    .collection('sites')
    .doc(siteId)
    .collection('roosts')
    .doc(roostId)
    .set(
      {
        schemaVersion: 2,
        name: opts.name ?? roostId,
        targets: opts.targets ?? [],
        versionCounter: opts.versionCounter ?? 0,
        currentVersionId: null,
        previousVersionId: null,
        deletedAt: null,
        createdAt: FieldValue.serverTimestamp(),
        updatedAt: FieldValue.serverTimestamp(),
        createdBy: 'e2e-seed',
        ...extractPathField,
      },
      { merge: true },
    );
}

export interface SeedVersionFile {
  path: string;
  size: number;
  chunks: Array<{ hash: string; size: number }>;
}

export interface SeedVersionOptions {
  versionId: string;
  versionNumber: number;
  description?: string | null;
  files?: SeedVersionFile[];
  /** Override createdAt (ms since epoch). Defaults to now. */
  createdAt?: number;
  /** Optional parent version id (for history chains). */
  parentVersionId?: string | null;
}

/**
 * Version doc only. Does NOT touch the roost's currentVersionId — use
 * `seedRoostWithVersionHistory` for the full happy path. Idempotent.
 */
export async function seedVersion(
  siteId: string,
  roostId: string,
  opts: SeedVersionOptions,
): Promise<void> {
  const db = getAdminDb();
  const files = opts.files ?? [];
  const totalSize =
    files.length > 0 ? files.reduce((n, f) => n + f.size, 0) : 1024;
  const totalFiles = files.length > 0 ? files.length : 1;

  await db
    .collection('sites')
    .doc(siteId)
    .collection('roosts')
    .doc(roostId)
    .collection('versions')
    .doc(opts.versionId)
    .set(
      {
        versionId: opts.versionId,
        versionNumber: opts.versionNumber,
        description: opts.description ?? null,
        versionUrl: `https://e2e-seed.test/version-${opts.versionId}.json`,
        createdAt: new Date(opts.createdAt ?? Date.now()),
        createdBy: 'e2e-seed',
        totalSize,
        totalFiles,
        parentVersionId: opts.parentVersionId ?? null,
      },
      { merge: true },
    );
}

export interface SeedRoostWithVersionHistoryOptions {
  /** Display name. Defaults to the roostId. */
  name?: string;
  /** Machine ids this roost deploys to. Defaults to []. */
  targets?: string[];
  /** Optional extract path on the agent side. */
  extractPath?: string;
  /** How many versions to create. Versions number 1..N. */
  versionCount: number;
  /**
   * Per-version descriptions; index N-1 is the description for version #N.
   * Missing entries default to null.
   */
  descriptions?: Array<string | null>;
}

/**
 * Roost + N versions, with the roost's pointers aimed at the head — the state
 * of a roost pushed `versionCount` times.
 */
export async function seedRoostWithVersionHistory(
  siteId: string,
  roostId: string,
  opts: SeedRoostWithVersionHistoryOptions,
): Promise<void> {
  if (!Number.isInteger(opts.versionCount) || opts.versionCount < 1) {
    throw new Error(
      `seedRoostWithVersionHistory: versionCount must be a positive integer (got ${opts.versionCount})`,
    );
  }

  await seedRoost(siteId, roostId, {
    name: opts.name,
    targets: opts.targets,
    extractPath: opts.extractPath,
    versionCounter: 0,
  });

  const versionIdFor = (n: number) => `vrs_${roostId}_v${n}`;

  // Ascending so parentVersionId chains and createdAt order match publish order.
  const baseTime = Date.now() - opts.versionCount * 1000;
  for (let n = 1; n <= opts.versionCount; n++) {
    await seedVersion(siteId, roostId, {
      versionId: versionIdFor(n),
      versionNumber: n,
      description: opts.descriptions?.[n - 1] ?? null,
      createdAt: baseTime + n * 1000,
      parentVersionId: n > 1 ? versionIdFor(n - 1) : null,
    });
  }

  const headNumber = opts.versionCount;
  const headId = versionIdFor(headNumber);
  const previousId = headNumber > 1 ? versionIdFor(headNumber - 1) : null;
  const headDescription = opts.descriptions?.[headNumber - 1] ?? null;

  const db = getAdminDb();
  await db
    .collection('sites')
    .doc(siteId)
    .collection('roosts')
    .doc(roostId)
    .set(
      {
        versionCounter: headNumber,
        currentVersionId: headId,
        previousVersionId: previousId,
        currentVersionNumber: headNumber,
        currentVersionDescription: headDescription,
        versionUrl: `https://e2e-seed.test/version-${headId}.json`,
        updatedAt: FieldValue.serverTimestamp(),
      },
      { merge: true },
    );
}

/**
 * `siteChunks/{digest}` docs so version finalisation's chunk-presence check
 * sees the hashes as already uploaded. Minimum surface a `hasChunk()` needs.
 */
export async function seedChunks(siteId: string, digests: string[]): Promise<void> {
  if (digests.length === 0) return;
  const db = getAdminDb();
  await Promise.all(
    digests.map((digest) =>
      db
        .collection('siteChunks')
        .doc(digest)
        .set(
          {
            siteId,
            hash: digest,
            size: 4096,
            createdAt: FieldValue.serverTimestamp(),
          },
          { merge: true },
        ),
    ),
  );
}
