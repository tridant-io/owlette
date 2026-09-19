/**
 * @jest-environment node
 */

const mockSettingsGet = jest.fn();
const mockStepUpGet = jest.fn();
const mockStepUpSet = jest.fn().mockResolvedValue(undefined);
const mockReadMfaFactors = jest.fn();

jest.mock('@/lib/firebase-admin', () => ({
  getAdminDb: () => ({
    collection: (name: string) =>
      name === 'users'
        ? {
            doc: () => ({
              collection: () => ({
                doc: () => ({ get: mockStepUpGet, set: mockStepUpSet }),
              }),
            }),
          }
        : {
            doc: () => ({
              collection: () => ({ doc: () => ({ get: mockSettingsGet }) }),
            }),
          },
  }),
}));

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
  stepUpSessionBinding,
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
  mockReadMfaFactors.mockResolvedValue({ totp: true, passkeys: 0 });
  mockStepUpSet.mockResolvedValue(undefined);
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
    mockSettingsGet.mockResolvedValue({ exists: true, data: () => ({ enabled: true }) });
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
  const binding = stepUpSessionBinding({ userId: 'uid-1', expiresAt: 42 });

  it('binds to one login session — a new session inherits nothing', () => {
    expect(stepUpSessionBinding({ userId: 'uid-1', expiresAt: 43 })).not.toBe(binding);
    expect(stepUpSessionBinding({ userId: 'uid-2', expiresAt: 42 })).not.toBe(binding);
    expect(binding).not.toContain('uid-1');
  });

  it('opens for 10 minutes on a live proof', async () => {
    const now = 1_700_000_000_000;
    const expiresAt = await openStepUpWindow({
      userId: 'uid-1',
      binding,
      proof: { ok: true, factorUsed: 'passkey' },
      nowMs: now,
    });
    expect(expiresAt).toBe(now + SWOOP_STEP_UP_WINDOW_MS);
    expect(mockStepUpSet).toHaveBeenCalledWith(
      expect.objectContaining({ openedAt: now, expiresAt, factorUsed: 'passkey' }),
    );
  });

  it('cannot be opened from a timestamp', async () => {
    // `session.mfaCompletedAt` is set to now when a session is born from a
    // 30-day device-trust cookie with no ceremony — a freshness check against
    // it passes for a stolen cookie, so it must not open a window here.
    await expect(
      openStepUpWindow({
        userId: 'uid-1',
        binding,
        proof: { mfaCompletedAt: Date.now() } as never,
      }),
    ).rejects.toThrow(SwoopPolicyError);

    await expect(
      openStepUpWindow({ userId: 'uid-1', binding, proof: { ok: true } as never }),
    ).rejects.toThrow(/step_up_proof_invalid/);

    await expect(
      openStepUpWindow({
        userId: 'uid-1',
        binding,
        proof: { ok: false, status: 401, error: 'x', code: 'y' },
      }),
    ).rejects.toThrow(/step_up_proof_invalid/);

    expect(mockStepUpSet).not.toHaveBeenCalled();
  });

  it('refuses an account with zero enrolled factors', async () => {
    mockReadMfaFactors.mockResolvedValue({ totp: false, passkeys: 0 });
    await expect(
      openStepUpWindow({ userId: 'uid-1', binding, proof: { ok: true, factorUsed: 'totp' } }),
    ).rejects.toThrow(/no_mfa_factors/);
    expect(mockStepUpSet).not.toHaveBeenCalled();
  });

  it('reads the window back, and lets it lapse', async () => {
    const now = 1_700_000_000_000;
    mockStepUpGet.mockResolvedValue({ exists: true, data: () => ({ expiresAt: now + 1000 }) });
    expect(await hasOpenStepUpWindow({ userId: 'uid-1', binding, nowMs: now })).toBe(true);
    expect(await hasOpenStepUpWindow({ userId: 'uid-1', binding, nowMs: now + 2000 })).toBe(false);
  });

  it('is closed when there is no window document at all', async () => {
    mockStepUpGet.mockResolvedValue({ exists: false, data: () => undefined });
    expect(await hasOpenStepUpWindow({ userId: 'uid-1', binding })).toBe(false);
  });
});
