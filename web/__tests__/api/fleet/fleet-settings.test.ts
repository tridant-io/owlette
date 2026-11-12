/** @jest-environment node */

/**
 * GET/PATCH /api/sites/{siteId}/fleet-settings, the grant that lets a machine
 * act on its site's machines (ADR 0017). the real `authorizedSiteHandler` runs,
 * so the membership and capability answers are the wrapper's own. the session
 * store is mocked: what is asserted is which sessions the write cuts.
 */

import { createMockRequest, parseResponse } from '../helpers/utils';
import {
  mocks,
  mockDbFactory,
  docSnapshot,
  apiKeyAuth,
  seedMember,
  seedSiteOwner,
  SITE_OWNER,
} from '../helpers/firestore-mock';

jest.mock('@sentry/nextjs', () => ({
  captureException: jest.fn(),
  captureMessage: jest.fn(),
}));

jest.mock('@/lib/firebase-admin', () => ({
  getAdminDb: () => mockDbFactory(),
  getAdminAuth: () => ({ verifyIdToken: jest.fn().mockRejectedValue(new Error('n/a')) }),
}));

jest.mock('firebase-admin/firestore', () => ({
  FieldValue: { serverTimestamp: jest.fn(() => '__SERVER_TS__') },
  Timestamp: { fromMillis: (ms: number) => ({ toMillis: () => ms }) },
}));

const mockEmitMutation = jest.fn();
jest.mock('@/lib/auditLogClient', () => ({
  emitApiKeyUsed: jest.fn(),
  emitMutation: (...a: unknown[]) => mockEmitMutation(...a),
  scopeFingerprint: jest.fn(() => 'fp'),
}));

const writeAuditEntry = jest.fn();
jest.mock('@/lib/auditLog.server', () => ({
  generateCorrelationId: jest.fn(() => 'corr-test'),
  writeAuditEntry: (...a: unknown[]) => writeAuditEntry(...a),
  writeAuditEntryBlocking: jest.fn(async () => undefined),
}));

jest.mock('@/lib/rateLimit.server', () => ({
  checkRateLimit: jest.fn(async () => ({ ok: true })),
  rateLimitHeaders: jest.fn(() => ({})),
}));

// flipped by the break-glass test; reset to on in `beforeEach`.
const capabilityEnforcement = { value: true };
jest.mock('@/lib/securityConfig.server', () => ({
  securityConfig: {
    read: jest.fn(async () => ({
      capability_enforcement: capabilityEnforcement.value,
      rate_limit_enforcement: true,
    })),
  },
}));

const mockResolveAuth = jest.fn();
jest.mock('@/lib/apiAuth.server', () => {
  const actual = jest.requireActual('@/lib/apiAuth.server');
  return { ...actual, resolveAuth: (...a: unknown[]) => mockResolveAuth(...a) };
});

const mockRevoke = jest.fn();
jest.mock('@/lib/fleet/session.server', () => ({
  revokeFleetSessions: (...a: unknown[]) => mockRevoke(...a),
}));

const mockWarn = jest.fn();
jest.mock('@/lib/logger', () => {
  const logger = {
    debug: jest.fn(),
    info: jest.fn(),
    warn: (...a: unknown[]) => mockWarn(...a),
    error: jest.fn(),
  };
  return { __esModule: true, default: logger, logger };
});

import { GET, PATCH } from '@/app/api/sites/[siteId]/fleet-settings/route';
import { MAX_FLEET_SENDERS } from '@/lib/fleet/policy.server';
import { MAX_MACHINE_SCOPE } from '@/lib/machineAccess';

const SITE = 'site-a';
const M1 = 'machine-1';
const M2 = 'machine-2';
const M3 = 'machine-3';
const ADMIN = 'user-admin';
const MEMBER = 'user-member';
const SETTINGS_PATH = `sites/${SITE}/settings/fleet`;

/** documents the routes read, keyed by their full firestore path. */
const staged = new Map<string, Record<string, unknown> | null>();

const url = `http://localhost/api/sites/${SITE}/fleet-settings`;
const siteContext = () => ({ params: Promise.resolve({ siteId: SITE }) });

function get() {
  return GET(createMockRequest(url), siteContext());
}

function patch(body: unknown) {
  return PATCH(createMockRequest(url, { method: 'PATCH', body }), siteContext());
}

function signIn(userId: string): void {
  mockResolveAuth.mockResolvedValue({ userId, keyContext: null });
}

function stageMachine(machineId: string): void {
  staged.set(`sites/${SITE}/machines/${machineId}`, { online: true });
}

/** the settings document writes: payload and options. */
function settingsWrites(): Array<[Record<string, unknown>, unknown]> {
  return mocks.set.mock.calls
    .filter(([payload]) => 'updatedAt' in (payload as object))
    .map(([payload, options]) => [payload as Record<string, unknown>, options]);
}

/** the one settings write's `senders`, as stored. */
function storedSenders(): unknown {
  const writes = settingsWrites();
  expect(writes).toHaveLength(1);
  return writes[0][0].senders;
}

/**
 * every `site_settings_refresh` queued, by machine. the command id carries the
 * machine id with `-` written as `_`, which is how it is mapped back here.
 */
function refreshes(): Array<{ machine: string; command: Record<string, unknown> }> {
  return mocks.set.mock.calls
    .map(([payload]) => payload as Record<string, Record<string, unknown>>)
    .filter((payload) => Object.keys(payload).every((k) => k.startsWith('site_settings_refresh_')))
    .flatMap((payload) =>
      Object.entries(payload).map(([id, command]) => ({
        machine: id.replace(/^site_settings_refresh_(.+)_\d+$/, '$1').replace(/_/g, '-'),
        command,
      })),
    );
}

function refreshedMachines(): string[] {
  return refreshes()
    .map((r) => r.machine)
    .sort();
}

/** the machine ids whose sessions were revoked one by one. */
function revokedMachines(): string[] {
  return mockRevoke.mock.calls
    .map(([, subject]) => (subject as { machineId?: string }).machineId)
    .filter((id): id is string => id !== undefined);
}

async function expectRefused(res: Response, status: number, code: string): Promise<void> {
  const { status: actual, body } = await parseResponse(res);
  expect(actual).toBe(status);
  expect(body.code).toBe(code);
  expect(settingsWrites()).toHaveLength(0);
  expect(mockRevoke).not.toHaveBeenCalled();
  expect(refreshes()).toHaveLength(0);
}

beforeEach(() => {
  jest.clearAllMocks();
  mocks.set.mockResolvedValue(undefined);
  mockRevoke.mockResolvedValue(0);
  capabilityEnforcement.value = true;

  staged.clear();
  for (const id of [M1, M2, M3]) stageMachine(id);
  mocks.get.mockImplementation((path: string) =>
    Promise.resolve(docSnapshot(path.split('/').pop() ?? '', staged.get(path) ?? null)),
  );

  seedSiteOwner(SITE);
  seedMember(SITE, ADMIN, 'admin');
  seedMember(SITE, MEMBER, 'member');
  signIn(ADMIN);
});

describe('who may read and change the grant', () => {
  it.each([
    ['the site owner', SITE_OWNER],
    ['a site admin', ADMIN],
  ])('%s may read and change it', async (_who, uid) => {
    signIn(uid);

    expect((await get()).status).toBe(200);
    expect((await patch({ enabled: true })).status).toBe(200);
  });

  it('refuses a member on both verbs and writes nothing', async () => {
    signIn(MEMBER);

    await expectRefused(await get(), 403, 'capability_missing');
    await expectRefused(await patch({ enabled: true }), 403, 'capability_missing');
    expect(writeAuditEntry).toHaveBeenCalledWith(
      SITE,
      expect.objectContaining({ outcome: 'deny', denyReason: 'capability_missing' }),
    );
  });

  // a grant written while the kill switch is off would outlive that window
  it('still refuses a member with capability_enforcement off', async () => {
    capabilityEnforcement.value = false;
    signIn(MEMBER);

    await expectRefused(
      await patch({ enabled: true, senders: { [M1]: { maxTier: 3, wholeSite: true } } }),
      403,
      'capability_missing',
    );
    expect(mocks.set).not.toHaveBeenCalled();
  });

  it('still lets an admin through with capability_enforcement off', async () => {
    capabilityEnforcement.value = false;

    expect((await patch({ enabled: true })).status).toBe(200);
  });

  it('refuses a site admin held to a machine scope', async () => {
    mocks.memberDocs.set(`${SITE}/${ADMIN}`, { ...mocks.memberDocs.get(`${SITE}/${ADMIN}`), machineIds: [M1] });

    await expectRefused(await patch({ enabled: true }), 403, 'capability_missing');
  });

  it('refuses an api key on PATCH, even an admin key, and writes nothing', async () => {
    mockResolveAuth.mockResolvedValue(apiKeyAuth(ADMIN));

    await expectRefused(
      await patch({ enabled: true, senders: { [M1]: { wholeSite: true } } }),
      403,
      'api_key_not_permitted',
    );
    expect(mockEmitMutation).not.toHaveBeenCalled();
  });

  it('refuses an api key on GET, as swoop-settings and display-settings do', async () => {
    mockResolveAuth.mockResolvedValue(apiKeyAuth(ADMIN));
    staged.set(SETTINGS_PATH, { enabled: true, senders: { [M1]: { maxTier: 3, wholeSite: true } } });

    const { status, body } = await parseResponse(await get());

    expect(status).toBe(403);
    expect(body.code).toBe('api_key_not_permitted');
    expect(body).not.toHaveProperty('data');
  });
});

describe('GET fleet-settings', () => {
  it('reads off with no senders when the site never set it', async () => {
    const { status, body } = await parseResponse(await get());

    expect(status).toBe(200);
    expect(body.data).toEqual({ enabled: false, senders: {} });
  });

  it('returns each sender in the shape PATCH takes', async () => {
    staged.set(SETTINGS_PATH, {
      enabled: true,
      senders: {
        [M1]: { maxTier: 2 },
        [M2]: { maxTier: 1, machineIds: [M3, M1] },
        [M3]: { maxTier: 3, wholeSite: true },
      },
    });

    const { body } = await parseResponse(await get());

    expect(body.data).toEqual({
      enabled: true,
      senders: {
        [M1]: { maxTier: 2 },
        [M2]: { maxTier: 1, machineIds: [M1, M3] },
        [M3]: { maxTier: 3, wholeSite: true },
      },
    });
  });
});

describe('PATCH fleet-settings: validation', () => {
  const tooMany = (n: number) =>
    Object.fromEntries(Array.from({ length: n }, (_, i) => [`m${String(i).padStart(3, '0')}`, {}]));

  it.each([
    ['no field', {}],
    ['a body that is not an object', ['enabled']],
    ['a non-boolean enabled', { enabled: 'true' }],
    ['senders that is not an object', { senders: [M1] }],
    ['a sender id that is not a machine id', { senders: { 'bad id': {} } }],
    ['a sender entry that is not an object', { senders: { [M1]: 2 } }],
    ['a tier outside 1 to 3', { senders: { [M1]: { maxTier: 4 } } }],
    ['a tier sent as a string', { senders: { [M1]: { maxTier: '2' } } }],
    ['a non-boolean wholeSite', { senders: { [M1]: { wholeSite: 'yes' } } }],
    ['wholeSite beside a list', { senders: { [M1]: { wholeSite: true, machineIds: [M2] } } }],
    ['a list that is not a list', { senders: { [M1]: { machineIds: M2 } } }],
    ['a null list', { senders: { [M1]: { machineIds: null } } }],
    ['a listed id that is not a machine id', { senders: { [M1]: { machineIds: [M2, 'a/b'] } } }],
    [
      'a list longer than machine scope allows',
      { senders: { [M1]: { machineIds: Array.from({ length: MAX_MACHINE_SCOPE + 1 }, (_, i) => `m${i}`) } } },
    ],
    [`${MAX_FLEET_SENDERS + 1} senders`, { senders: tooMany(MAX_FLEET_SENDERS + 1) }],
  ])('refuses %s', async (_case, body) => {
    await expectRefused(await patch(body), 400, 'validation_failed');
  });

  it('refuses a sender that is not a machine of this site', async () => {
    const res = await patch({ senders: { [M1]: {}, 'machine-gone': {} } });
    const { body } = await parseResponse(res);

    expect(res.status).toBe(400);
    expect(body.detail).toBe('not machines of this site: machine-gone');
    expect(settingsWrites()).toHaveLength(0);
  });

  it('refuses a listed machine that is not a machine of this site', async () => {
    const res = await patch({ senders: { [M1]: { machineIds: [M2, 'machine-gone'] } } });
    const { body } = await parseResponse(res);

    expect(res.status).toBe(400);
    expect(body.detail).toBe('not machines of this site: machine-gone');
    expect(settingsWrites()).toHaveLength(0);
  });

  it(`takes ${MAX_FLEET_SENDERS} senders, the most the site may keep`, async () => {
    const senders = tooMany(MAX_FLEET_SENDERS);
    for (const id of Object.keys(senders)) stageMachine(id);

    expect((await patch({ senders })).status).toBe(200);
    expect(Object.keys(storedSenders() as object)).toHaveLength(MAX_FLEET_SENDERS);
  });
});

describe('PATCH fleet-settings: what is stored', () => {
  it('stores each sender whole: no list, a sorted list, or the whole site and no list', async () => {
    const { status, body } = await parseResponse(
      await patch({
        enabled: true,
        senders: {
          [M1]: {},
          [M2]: { maxTier: 1, machineIds: [M3, M1, M3] },
          [M3]: { maxTier: 3, wholeSite: true },
        },
      }),
    );

    expect(status).toBe(200);
    const expected = {
      [M1]: { maxTier: 2 },
      [M2]: { maxTier: 1, machineIds: [M1, M3] },
      [M3]: { maxTier: 3, wholeSite: true },
    };
    expect(storedSenders()).toEqual(expected);
    expect(body.data).toEqual({ settings: { enabled: true, senders: expected } });
  });

  it('treats an empty list as no machines, and wholeSite false as a list or nothing', async () => {
    await patch({
      senders: { [M1]: { machineIds: [] }, [M2]: { wholeSite: false, machineIds: [M1] }, [M3]: { wholeSite: false } },
    });

    expect(storedSenders()).toEqual({
      [M1]: { maxTier: 2 },
      [M2]: { maxTier: 2, machineIds: [M1] },
      [M3]: { maxTier: 2 },
    });
  });

  it('replaces the senders field whole rather than merging into it', async () => {
    staged.set(SETTINGS_PATH, { enabled: true, senders: { [M1]: { maxTier: 2, machineIds: [M2] } } });

    await patch({ senders: { [M1]: { wholeSite: true } } });

    const [[payload, options]] = settingsWrites();
    expect(payload).toEqual({ senders: { [M1]: { maxTier: 2, wholeSite: true } }, updatedAt: '__SERVER_TS__' });
    // a merge: true write would deep-merge the map and keep the old list
    expect(options).toEqual({ mergeFields: ['updatedAt', 'senders'] });
  });

  it('switching a sender from a list to the whole site leaves no list behind', async () => {
    staged.set(SETTINGS_PATH, { enabled: true, senders: { [M1]: { maxTier: 2, machineIds: [M2, M3] } } });

    await patch({ senders: { [M1]: { wholeSite: true } } });

    const stored = (storedSenders() as Record<string, Record<string, unknown>>)[M1];
    expect(stored).toEqual({ maxTier: 2, wholeSite: true });
    expect(stored).not.toHaveProperty('machineIds');
  });

  it('keeps an existing sender’s tier when the request names none, and gives a new one 2', async () => {
    staged.set(SETTINGS_PATH, { enabled: true, senders: { [M1]: { maxTier: 3, machineIds: [M2] } } });

    await patch({ senders: { [M1]: { machineIds: [M2, M3] }, [M2]: {} } });

    expect(storedSenders()).toEqual({
      [M1]: { maxTier: 3, machineIds: [M2, M3] },
      [M2]: { maxTier: 2 },
    });
  });

  it('a sender may name itself among the machines it acts on', async () => {
    expect((await patch({ senders: { [M1]: { machineIds: [M1, M2] } } })).status).toBe(200);
    expect(storedSenders()).toEqual({ [M1]: { maxTier: 2, machineIds: [M1, M2] } });
  });

  it('changing only enabled writes only enabled, and leaves the senders alone', async () => {
    staged.set(SETTINGS_PATH, { enabled: false, senders: { [M1]: { maxTier: 2, machineIds: [M2] } } });

    const { body } = await parseResponse(await patch({ enabled: true }));

    expect(settingsWrites()).toEqual([
      [{ enabled: true, updatedAt: '__SERVER_TS__' }, { mergeFields: ['updatedAt', 'enabled'] }],
    ]);
    expect(body.data).toEqual({
      settings: { enabled: true, senders: { [M1]: { maxTier: 2, machineIds: [M2] } } },
    });
  });

  it('emits one site mutation saying how far each sender may go and on which machines', async () => {
    staged.set(SETTINGS_PATH, {
      enabled: true,
      senders: { [M2]: { maxTier: 2 }, [M3]: { maxTier: 2 }, 'machine-gone': { maxTier: 2 } },
    });

    await patch({ senders: { [M1]: { machineIds: [M3] }, [M3]: {}, 'machine-gone': {} } });

    expect(mockEmitMutation).toHaveBeenCalledTimes(1);
    expect(mockEmitMutation).toHaveBeenCalledWith({
      kind: 'site_mutated',
      siteId: SITE,
      actor: `user:${ADMIN}`,
      targetId: SITE,
      attributes: {
        verb: 'set_fleet_settings',
        endpoint: 'fleet-settings',
        method: 'PATCH',
        enabled: true,
        senderIds: [M1, M3],
        // the sender this write added; M3's grant is as it was
        changedSenders: { [M1]: { maxTier: 2, machineIds: [M3] } },
        revokedForSite: false,
        revokedSenderIds: [M2, 'machine-gone'],
        // the new sender and the one cut; the machine that left the site has no agent to tell
        refreshedSenderIds: [M1, M2],
        droppedMachineIds: ['machine-gone'],
      },
    });
  });
});

describe('PATCH fleet-settings: a machine that has left the site', () => {
  const GONE = 'machine-gone';

  it('drops a stored sender that has left the site rather than refusing the write', async () => {
    staged.set(SETTINGS_PATH, {
      enabled: true,
      senders: { [M1]: { maxTier: 2, machineIds: [M2] }, [GONE]: { maxTier: 3, wholeSite: true } },
    });

    const res = await patch({
      senders: { [M1]: { machineIds: [M2, M3] }, [GONE]: { maxTier: 3, wholeSite: true } },
    });

    expect(res.status).toBe(200);
    expect(storedSenders()).toEqual({ [M1]: { maxTier: 2, machineIds: [M2, M3] } });
    expect(revokedMachines()).toEqual([GONE]);
  });

  it('drops a stored list entry that has left the site rather than refusing the write', async () => {
    staged.set(SETTINGS_PATH, {
      enabled: true,
      senders: { [M1]: { maxTier: 2, machineIds: [GONE, M2] }, [M2]: { maxTier: 1, machineIds: [GONE] } },
    });

    const res = await patch({
      senders: { [M1]: { machineIds: [GONE, M2] }, [M2]: { machineIds: [GONE] } },
    });

    expect(res.status).toBe(200);
    expect(storedSenders()).toEqual({
      [M1]: { maxTier: 2, machineIds: [M2] },
      [M2]: { maxTier: 1 },
    });
  });

  it.each([
    ['as a new sender', { [M1]: { maxTier: 2, machineIds: [M2] } }, { [M1]: { machineIds: [M2] }, [GONE]: {} }],
    ['newly listed on an existing sender', { [M1]: { maxTier: 2, machineIds: [M2] } }, { [M1]: { machineIds: [M2, GONE] } }],
    ['in a list that replaces the whole site', { [M1]: { maxTier: 2, wholeSite: true } }, { [M1]: { machineIds: [GONE] } }],
    ['stored on one sender but new on another', { [M1]: { maxTier: 2, machineIds: [GONE] } }, { [M1]: { machineIds: [GONE] }, [M2]: { machineIds: [GONE] } }],
  ])('still refuses one that this write adds %s', async (_case, stored, senders) => {
    staged.set(SETTINGS_PATH, { enabled: true, senders: stored });

    const res = await patch({ senders });
    const { body } = await parseResponse(res);

    expect(res.status).toBe(400);
    expect(body.detail).toBe(`not machines of this site: ${GONE}`);
    expect(settingsWrites()).toHaveLength(0);
  });
});

describe('PATCH fleet-settings: telling a machine it was cut', () => {
  it('queues site_settings_refresh to a sender removed from an enabled site, so its agent drops its session file', async () => {
    staged.set(SETTINGS_PATH, { enabled: true, senders: { [M1]: { maxTier: 2 }, [M2]: { maxTier: 2 } } });

    await patch({ senders: { [M1]: {} } });

    expect(refreshedMachines()).toEqual([M2]);
  });

  it('queues it to every sender when the write turns the site off', async () => {
    staged.set(SETTINGS_PATH, { enabled: true, senders: { [M1]: { maxTier: 2 }, [M2]: { maxTier: 2 } } });

    await patch({ enabled: false });

    expect(refreshedMachines()).toEqual([M1, M2]);
  });

  it('queues nothing for a sender removed while the site is off: it held no session', async () => {
    staged.set(SETTINGS_PATH, { enabled: false, senders: { [M1]: { maxTier: 2 } } });

    await patch({ senders: {} });

    expect(refreshes()).toHaveLength(0);
  });

  it('queues nothing for a sender that has left the site', async () => {
    staged.set(SETTINGS_PATH, { enabled: true, senders: { 'machine-gone': { maxTier: 2 } } });

    await patch({ senders: { 'machine-gone': {} } });

    expect(refreshes()).toHaveLength(0);
  });

  it.each([
    ['the write turns the site off', { enabled: false }],
    ['the write leaves it out of the senders', { senders: { [M1]: {} } }],
  ])('queues nothing under a stored sender that has left the site when %s', async (_case, body) => {
    staged.set(SETTINGS_PATH, { enabled: true, senders: { [M1]: { maxTier: 2 }, [M2]: { maxTier: 2 }, 'machine-gone': { maxTier: 2 } } });

    await patch(body);

    expect(refreshedMachines()).not.toContain('machine-gone');
    expect(refreshedMachines()).toContain(M2);
  });

  it('says in the audit row which sender changed, and how', async () => {
    staged.set(SETTINGS_PATH, { enabled: true, senders: { [M1]: { maxTier: 1, machineIds: [M2] }, [M3]: { maxTier: 2, wholeSite: true } } });

    await patch({ senders: { [M1]: { maxTier: 2, machineIds: [M2] }, [M3]: { wholeSite: true } } });

    expect(mockEmitMutation.mock.calls[0][0].attributes.changedSenders).toEqual({ [M1]: { maxTier: 2, machineIds: [M2] } });
  });
});

describe('PATCH fleet-settings: telling a newly granted machine', () => {
  it('queues site_settings_refresh to a sender added on an enabled site, and to none whose grant stays', async () => {
    staged.set(SETTINGS_PATH, { enabled: true, senders: { [M1]: { maxTier: 2, machineIds: [M3] } } });

    await patch({ senders: { [M1]: { maxTier: 3, machineIds: [M3] }, [M2]: { machineIds: [M3] } } });

    expect(refreshedMachines()).toEqual([M2]);
    expect(refreshes()[0].command).toMatchObject({
      type: 'site_settings_refresh',
      siteId: SITE,
      status: 'pending',
      queuedBy: `user:${ADMIN}`,
      auditCorrelationId: 'corr-test',
    });
  });

  it('queues it to every sender when the write turns the site on', async () => {
    staged.set(SETTINGS_PATH, { enabled: false, senders: { [M1]: { maxTier: 2 }, [M2]: { maxTier: 2 } } });

    await patch({ enabled: true });

    expect(refreshedMachines()).toEqual([M1, M2]);
  });

  it('queues nothing for a sender added while the site is off', async () => {
    await patch({ senders: { [M1]: {} } });

    expect(refreshes()).toHaveLength(0);
  });

  it('queues nothing for a sender whose grant only changed', async () => {
    staged.set(SETTINGS_PATH, { enabled: true, senders: { [M1]: { maxTier: 1 } } });

    await patch({ senders: { [M1]: { maxTier: 3, wholeSite: true } } });

    expect(refreshes()).toHaveLength(0);
  });

  it('keeps the write when the command cannot be queued, and warns', async () => {
    staged.set(SETTINGS_PATH, { enabled: true, senders: {} });
    mocks.set.mockImplementation((payload: object) =>
      'updatedAt' in payload ? Promise.resolve(undefined) : Promise.reject(new Error('firestore down')),
    );

    const res = await patch({ senders: { [M1]: {} } });

    expect(res.status).toBe(200);
    expect(settingsWrites()).toHaveLength(1);
    expect(mockWarn).toHaveBeenCalledWith(
      expect.stringContaining('could not be told'),
      expect.objectContaining({ data: { siteId: SITE, failed: [M1] } }),
    );
  });
});

describe('PATCH fleet-settings: cutting sessions', () => {
  it('revokes every session on the site when the feature turns off', async () => {
    staged.set(SETTINGS_PATH, { enabled: true, senders: { [M1]: { maxTier: 2, machineIds: [M2] } } });

    await patch({ enabled: false });

    expect(mockRevoke).toHaveBeenCalledTimes(1);
    expect(mockRevoke).toHaveBeenCalledWith(expect.anything(), { siteId: SITE });
  });

  it('revokes nothing when the feature was already off', async () => {
    await patch({ enabled: false });

    expect(mockRevoke).not.toHaveBeenCalled();
  });

  it('revokes a sender that was removed, and only that one', async () => {
    staged.set(SETTINGS_PATH, {
      enabled: true,
      senders: { [M1]: { maxTier: 2, machineIds: [M3] }, [M2]: { maxTier: 2, machineIds: [M3] } },
    });

    await patch({ senders: { [M1]: { maxTier: 2, machineIds: [M3] } } });

    expect(mockRevoke).toHaveBeenCalledWith(expect.anything(), { siteId: SITE, machineId: M2 });
    expect(revokedMachines()).toEqual([M2]);
  });

  it('revokes every sender when the map is emptied', async () => {
    staged.set(SETTINGS_PATH, {
      enabled: true,
      senders: { [M1]: { maxTier: 1 }, [M2]: { maxTier: 1 } },
    });

    await patch({ senders: {} });

    expect(storedSenders()).toEqual({});
    expect(revokedMachines()).toEqual([M1, M2]);
  });

  // the fleet routes rebuild a machine's reach from the live grant on every
  // call, so a narrowed sender keeps its session and its calls still running
  it.each([
    ['a lower tier', { maxTier: 3, machineIds: [M2] }, { maxTier: 2, machineIds: [M2] }],
    ['a machine dropped', { maxTier: 2, machineIds: [M2, M3] }, { maxTier: 2, machineIds: [M2] }],
    ['the whole site cut to a list', { maxTier: 2, wholeSite: true }, { maxTier: 2, machineIds: [M2] }],
    ['the whole site cut to nothing', { maxTier: 2, wholeSite: true }, { maxTier: 2 }],
    ['a higher tier', { maxTier: 1, machineIds: [M2] }, { maxTier: 3, machineIds: [M2] }],
    ['a machine added', { maxTier: 2, machineIds: [M2] }, { maxTier: 2, machineIds: [M2, M3] }],
    ['a move to the whole site', { maxTier: 2, machineIds: [M2] }, { maxTier: 2, wholeSite: true }],
    ['no change', { maxTier: 2, machineIds: [M2] }, { maxTier: 2, machineIds: [M2] }],
  ])('revokes nothing for %s', async (_case, before, after) => {
    staged.set(SETTINGS_PATH, { enabled: true, senders: { [M1]: before } });

    await patch({ senders: { [M1]: after } });

    expect(mockRevoke).not.toHaveBeenCalled();
  });

  it('cuts the site once, not each sender too, when it turns off and removes senders together', async () => {
    staged.set(SETTINGS_PATH, { enabled: true, senders: { [M1]: { maxTier: 3, wholeSite: true } } });

    await patch({ enabled: false, senders: {} });

    expect(mockRevoke.mock.calls).toEqual([[expect.anything(), { siteId: SITE }]]);
  });

  it('keeps the write when a revocation fails, and says so in the log', async () => {
    staged.set(SETTINGS_PATH, { enabled: true, senders: { [M1]: { maxTier: 2 } } });
    mockRevoke.mockRejectedValueOnce(new Error('firestore down'));

    const res = await patch({ senders: {} });

    expect(res.status).toBe(200);
    expect(settingsWrites()).toHaveLength(1);
    expect(mockWarn).toHaveBeenCalledWith(
      expect.stringContaining('could not be revoked'),
      expect.objectContaining({ data: expect.objectContaining({ siteId: SITE, failed: 1 }) }),
    );
  });
});
