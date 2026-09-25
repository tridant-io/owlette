/**
 * @jest-environment node
 */

/**
 * A path-keyed Firestore. Which document a window is stored under IS the
 * security property here — a window that can be read back for another user or
 * another machine is the bug — so the mock records full paths rather than
 * answering every `doc()` with the same stub.
 */
const mockDocs = new Map<string, Record<string, unknown>>();
const mockWrites: Array<{ path: string; data: Record<string, unknown> }> = [];
const mockReadMfaFactors = jest.fn();

jest.mock('@/lib/firebase-admin', () => {
  const doc = (path: string) => ({
    get: async () => ({
      exists: mockDocs.has(path),
      data: () => mockDocs.get(path),
    }),
    set: async (data: Record<string, unknown>) => {
      mockWrites.push({ path, data });
      mockDocs.set(path, data);
    },
    collection: (name: string) => collection(`${path}/${name}`),
  });
  const collection = (path: string) => ({ doc: (id: string) => doc(`${path}/${id}`) });
  return { getAdminDb: () => ({ collection: (name: string) => collection(name) }) };
});

jest.mock('firebase-admin/firestore', () => ({
  FieldValue: { serverTimestamp: jest.fn(() => '__SERVER_TS__') },
}));

jest.mock('@/lib/mfaFactors.server', () => ({
  readMfaFactors: (...args: unknown[]) => mockReadMfaFactors(...args),
  deriveMfaEnrolled: (inv: { totp: boolean; passkeys: number }) => inv.totp || inv.passkeys > 0,
}));

import type { Actor } from '@/lib/capabilities';
import {
  SWOOP_SESSION_CAP_SECONDS,
  SWOOP_SETTINGS_DEFAULTS,
  SWOOP_STEP_UP_WINDOW_MS,
  SwoopPolicyError,
  evaluateLeaseRenewal,
  evaluateSwoopAccess,
  hasOpenStepUpWindow,
  loadSwoopSettings,
  openStepUpWindow,
  parseSwoopSettings,
  revokeStepUpWindows,
  stepUpMachineBinding,
  type SwoopSiteSettings,
} from '@/lib/swoop/policy.server';

const SITE = 'site-a';
const MACHINE = 'machine-x';

const member: Actor = { type: 'user', userId: 'm', role: 'member', siteRoles: { [SITE]: 'member' } };
const admin: Actor = { type: 'user', userId: 'a', role: 'member', siteRoles: { [SITE]: 'admin' } };
const owner: Actor = { type: 'user', userId: 'o', role: 'member', siteRoles: { [SITE]: 'owner' } };
const outsider: Actor = { type: 'user', userId: 'x', role: 'member', siteRoles: {} };

const ON: SwoopSiteSettings = { ...SWOOP_SETTINGS_DEFAULTS, enabled: true };

function access(over: Partial<Parameters<typeof evaluateSwoopAccess>[0]>) {
  return evaluateSwoopAccess({
    actor: member,
    siteId: SITE,
    machineId: MACHINE,
    intent: 'view',
    viaApiKey: false,
    settings: ON,
    ...over,
  });
}

beforeEach(() => {
  jest.clearAllMocks();
  mockDocs.clear();
  mockWrites.length = 0;
  mockReadMfaFactors.mockResolvedValue({ totp: true, passkeys: 0 });
});

describe('parseSwoopSettings', () => {
  it('defaults to off, with members allowed to watch once a site opts in', () => {
    expect(parseSwoopSettings(null)).toEqual({
      enabled: false,
      excludedMachineIds: [],
      membersMayWatch: true,
      indicator: 'banner',
    });
  });

  it('only the literal true enables — a string "true" is not a grant', () => {
    expect(parseSwoopSettings({ enabled: 'true' }).enabled).toBe(false);
    expect(parseSwoopSettings({ enabled: true }).enabled).toBe(true);
  });

  it('keeps a known indicator and discards an unknown one', () => {
    expect(parseSwoopSettings({ indicator: 'tray' }).indicator).toBe('tray');
    expect(parseSwoopSettings({ indicator: 'fireworks' }).indicator).toBe('banner');
  });

  it('reads the site settings document', async () => {
    mockDocs.set(`sites/${SITE}/settings/swoop`, { enabled: true });
    expect(await loadSwoopSettings(SITE)).toMatchObject({ enabled: true });
  });
});

describe('evaluateSwoopAccess', () => {
  it('refuses an api-key caller first, whatever else is true', () => {
    expect(access({ actor: owner, intent: 'control', viaApiKey: true, stepUpOpen: true })).toEqual({
      ok: false,
      status: 403,
      code: 'api_key_not_permitted',
      error: expect.any(String),
    });
  });

  it('refuses when the site has not enabled swoop', () => {
    expect(access({ settings: SWOOP_SETTINGS_DEFAULTS })).toMatchObject({
      code: 'swoop_disabled',
    });
  });

  it('refuses an excluded machine', () => {
    expect(access({ settings: { ...ON, excludedMachineIds: [MACHINE] } })).toMatchObject({
      code: 'machine_excluded',
    });
  });

  /**
   * The window is a NECESSARY condition and never a sufficient one — every
   * other bar is read first, so disabling swoop or excluding a machine ends a
   * control session that holds a live window.
   */
  it('is not satisfied by an open window when any earlier bar refuses', () => {
    expect(
      access({ actor: admin, intent: 'control', stepUpOpen: true, settings: SWOOP_SETTINGS_DEFAULTS }),
    ).toMatchObject({ code: 'swoop_disabled' });
    expect(
      access({
        actor: admin,
        intent: 'control',
        stepUpOpen: true,
        settings: { ...ON, excludedMachineIds: [MACHINE] },
      }),
    ).toMatchObject({ code: 'machine_excluded' });
    expect(access({ actor: outsider, intent: 'control', stepUpOpen: true })).toMatchObject({
      code: 'capability_missing',
    });
  });

  it('refuses a member asking for control — that is an admin capability', () => {
    expect(access({ intent: 'control', stepUpOpen: true })).toMatchObject({
      code: 'capability_missing',
    });
  });

  it('refuses a non-member outright', () => {
    expect(access({ actor: outsider })).toMatchObject({ code: 'capability_missing' });
  });

  it('refuses a member to watch when membersMayWatch is off', () => {
    expect(access({ settings: { ...ON, membersMayWatch: false } })).toEqual({
      ok: false,
      status: 403,
      code: 'members_may_not_watch',
      error: expect.any(String),
    });
  });

  it('still lets a site admin watch when membersMayWatch is off', () => {
    expect(access({ actor: admin, settings: { ...ON, membersMayWatch: false } })).toEqual({
      ok: true,
      ctl: false,
    });
  });

  it('allows a member to watch on the default settings', () => {
    expect(access({})).toEqual({ ok: true, ctl: false });
  });

  it('refuses control without an open step-up window, and allows it with one', () => {
    expect(access({ actor: admin, intent: 'control' })).toEqual({
      ok: false,
      status: 401,
      code: 'step_up_required',
      error: expect.any(String),
    });
    expect(access({ actor: admin, intent: 'control', stepUpOpen: true })).toEqual({
      ok: true,
      ctl: true,
    });
  });
});

describe('evaluateLeaseRenewal', () => {
  const started = 1_000_000;

  it('renews while the authorization still holds', () => {
    expect(
      evaluateLeaseRenewal({
        actor: member,
        siteId: SITE,
        machineId: MACHINE,
        intent: 'view',
        viaApiKey: false,
        settings: ON,
        startedAt: started,
        nowMs: started + 60_000,
      }),
    ).toEqual({ ok: true, ctl: false });
  });

  it('refuses past the 12 hour absolute cap', () => {
    expect(
      evaluateLeaseRenewal({
        actor: member,
        siteId: SITE,
        machineId: MACHINE,
        intent: 'view',
        viaApiKey: false,
        settings: ON,
        startedAt: started,
        nowMs: started + SWOOP_SESSION_CAP_SECONDS * 1000,
      }),
    ).toMatchObject({ code: 'session_cap_reached' });
  });

  it('refuses a renewal once membership is gone', () => {
    expect(
      evaluateLeaseRenewal({
        actor: outsider,
        siteId: SITE,
        machineId: MACHINE,
        intent: 'view',
        viaApiKey: false,
        settings: ON,
        startedAt: started,
        nowMs: started + 60_000,
      }),
    ).toMatchObject({ code: 'capability_missing' });
  });

  it('refuses a renewal once the site turns swoop off', () => {
    expect(
      evaluateLeaseRenewal({
        actor: member,
        siteId: SITE,
        machineId: MACHINE,
        intent: 'view',
        viaApiKey: false,
        settings: SWOOP_SETTINGS_DEFAULTS,
        startedAt: started,
        nowMs: started + 60_000,
      }),
    ).toMatchObject({ code: 'swoop_disabled' });
  });
});


describe('step-up window', () => {
  const USER = 'uid-1';
  const OTHER_USER = 'uid-2';
  const OTHER_MACHINE = 'machine-y';
  const OTHER_SITE = 'site-b';
  const NOW = 1_700_000_000_000;

  const target = { userId: USER, siteId: SITE, machineId: MACHINE };
  const windowPath = (t: { userId: string; siteId: string; machineId: string }) =>
    `users/${t.userId}/swoop_step_up/${stepUpMachineBinding(t)}`;

  const proof = { ok: true, factorUsed: 'passkey' } as const;

  /**
   * Read the window the way a session that ran its own ceremony does. Every
   * case below is about the window itself; the session's half of the gate has
   * its own cases at the end of this block.
   */
  const readWindow = (over: Partial<Parameters<typeof hasOpenStepUpWindow>[0]> = {}) =>
    hasOpenStepUpWindow({ ...target, sessionPassedCeremony: true, ...over });

  it('binds to one (user, machine) pair, and names neither in the document id', () => {
    const binding = stepUpMachineBinding(target);
    expect(stepUpMachineBinding({ ...target, userId: OTHER_USER })).not.toBe(binding);
    expect(stepUpMachineBinding({ ...target, machineId: OTHER_MACHINE })).not.toBe(binding);
    expect(stepUpMachineBinding({ ...target, siteId: OTHER_SITE })).not.toBe(binding);
    expect(binding).not.toContain(USER);
    expect(binding).not.toContain(MACHINE);
  });

  it('opens for 12 hours from the ceremony, on the (user, machine) document', async () => {
    const expiresAt = await openStepUpWindow({ ...target, proof, nowMs: NOW });

    expect(expiresAt).toBe(NOW + SWOOP_STEP_UP_WINDOW_MS);
    expect(mockWrites).toEqual([
      {
        path: windowPath(target),
        data: expect.objectContaining({
          openedAt: NOW,
          expiresAt,
          factorUsed: 'passkey',
        }),
      },
    ]);
  });

  it('cannot be opened from a timestamp', async () => {
    // `session.mfaCompletedAt` is set to now when a session is born from a
    // 30-day device-trust cookie with no ceremony — a freshness check against
    // it passes for a stolen cookie, so it must not open a window here.
    await expect(
      openStepUpWindow({ ...target, proof: { mfaCompletedAt: Date.now() } as never }),
    ).rejects.toThrow(SwoopPolicyError);

    await expect(
      openStepUpWindow({ ...target, proof: { ok: true } as never }),
    ).rejects.toThrow(/step_up_proof_invalid/);

    await expect(
      openStepUpWindow({ ...target, proof: { ok: false, status: 401, error: 'x', code: 'y' } }),
    ).rejects.toThrow(/step_up_proof_invalid/);

    expect(mockWrites).toHaveLength(0);
  });

  it('refuses to open for an account with zero enrolled factors', async () => {
    mockReadMfaFactors.mockResolvedValue({ totp: false, passkeys: 0 });

    await expect(
      openStepUpWindow({ ...target, proof: { ok: true, factorUsed: 'totp' } }),
    ).rejects.toThrow(/no_mfa_factors/);
    expect(mockWrites).toHaveLength(0);
  });

  it('is closed when there is no window document at all', async () => {
    expect(await readWindow({ nowMs: NOW })).toBe(false);
  });

  /**
   * The bug this keying exists to fix: a page reload ends the swoop session and
   * starts a new one, and the ceremony must not run again for each.
   */
  it('lets a reconnect inside the 12 hours through without a second ceremony', async () => {
    await openStepUpWindow({ ...target, proof, nowMs: NOW });
    mockWrites.length = 0;

    expect(await readWindow({ nowMs: NOW + 1_000 })).toBe(true);
    expect(await readWindow({ nowMs: NOW + 120_000 })).toBe(true);
    expect(
      await readWindow({ nowMs: NOW + SWOOP_STEP_UP_WINDOW_MS - 1 }),
    ).toBe(true);
    // Reading a window never writes one: reuse cannot slide the 12 hours on.
    expect(mockWrites).toHaveLength(0);
  });

  it('refuses a reconnect after the 12 hours have run out', async () => {
    await openStepUpWindow({ ...target, proof, nowMs: NOW });

    expect(await readWindow({ nowMs: NOW + SWOOP_STEP_UP_WINDOW_MS })).toBe(
      false,
    );
    expect(
      await readWindow({ nowMs: NOW + SWOOP_STEP_UP_WINDOW_MS + 60_000 }),
    ).toBe(false);
  });

  it('caps a stored expiry at 10 minutes from the ceremony, whatever the document says', async () => {
    mockDocs.set(windowPath(target), {
      openedAt: NOW,
      expiresAt: NOW + 30 * 24 * 60 * 60 * 1000,
      factorUsed: 'totp',
    });

    expect(await readWindow({ nowMs: NOW + 60_000 })).toBe(true);
    expect(await readWindow({ nowMs: NOW + SWOOP_STEP_UP_WINDOW_MS })).toBe(
      false,
    );
  });

  it('reads as closed when a field is missing or the wrong type', async () => {
    mockDocs.set(windowPath(target), { expiresAt: NOW + 60_000 });
    expect(await readWindow({ nowMs: NOW })).toBe(false);

    mockDocs.set(windowPath(target), { openedAt: NOW, expiresAt: '9999999999999' });
    expect(await readWindow({ nowMs: NOW })).toBe(false);
  });

  it('does not cross machines — a proof for one machine is not a proof for another', async () => {
    await openStepUpWindow({ ...target, proof, nowMs: NOW });

    expect(
      await readWindow({ machineId: OTHER_MACHINE, nowMs: NOW + 1_000 }),
    ).toBe(false);
    expect(
      await readWindow({ siteId: OTHER_SITE, nowMs: NOW + 1_000 }),
    ).toBe(false);
  });

  it('does not cross users — one operator cannot ride another operator proof', async () => {
    await openStepUpWindow({ ...target, proof, nowMs: NOW });

    expect(
      await readWindow({ userId: OTHER_USER, nowMs: NOW + 1_000 }),
    ).toBe(false);
  });

  it('closes when the account loses its last second factor', async () => {
    await openStepUpWindow({ ...target, proof, nowMs: NOW });
    expect(await readWindow({ nowMs: NOW + 1_000 })).toBe(true);

    mockReadMfaFactors.mockResolvedValue({ totp: false, passkeys: 0 });
    expect(await readWindow({ nowMs: NOW + 1_000 })).toBe(false);
  });

  it('closes on a kill, for every user on that machine, and not for any other machine', async () => {
    await openStepUpWindow({ ...target, proof, nowMs: NOW });
    await openStepUpWindow({ ...target, userId: OTHER_USER, proof, nowMs: NOW });
    await openStepUpWindow({ ...target, machineId: OTHER_MACHINE, proof, nowMs: NOW });

    await revokeStepUpWindows({ siteId: SITE, machineId: MACHINE, nowMs: NOW + 1_000 });

    expect(await readWindow({ nowMs: NOW + 2_000 })).toBe(false);
    expect(
      await readWindow({ userId: OTHER_USER, nowMs: NOW + 2_000 }),
    ).toBe(false);
    expect(
      await readWindow({ machineId: OTHER_MACHINE, nowMs: NOW + 2_000 }),
    ).toBe(true);
  });

  it('lets a ceremony run after a kill open a fresh window', async () => {
    await revokeStepUpWindows({ siteId: SITE, machineId: MACHINE, nowMs: NOW });
    await openStepUpWindow({ ...target, proof, nowMs: NOW + 1_000 });

    expect(await readWindow({ nowMs: NOW + 2_000 })).toBe(true);
  });

  /**
   * The (user, machine) keying is what lets a reload reuse a window; this is
   * what stops it handing one to the 30-day device-trust cookie. plan.md D10:
   * step-up is a live proof, never a freshness timestamp, and a device-trust
   * birth stamps `mfaCompletedAt = now` having proved nothing.
   */
  it('refuses a session that ran no ceremony of its own, however live the window', async () => {
    await openStepUpWindow({ ...target, proof, nowMs: NOW });

    expect(await readWindow({ nowMs: NOW + 1_000 })).toBe(true);
    expect(
      await hasOpenStepUpWindow({ ...target, sessionPassedCeremony: false, nowMs: NOW + 1_000 }),
    ).toBe(false);
  });

  it('does not read the window at all for a session that ran no ceremony', async () => {
    await openStepUpWindow({ ...target, proof, nowMs: NOW });
    mockReadMfaFactors.mockClear();

    expect(
      await hasOpenStepUpWindow({ ...target, sessionPassedCeremony: false, nowMs: NOW + 1_000 }),
    ).toBe(false);
    expect(mockReadMfaFactors).not.toHaveBeenCalled();
  });
});
