/** @jest-environment node */
import { NextRequest } from 'next/server';

jest.mock('@/lib/withRateLimit', () => ({
  withRateLimit: <H,>(handler: H): H => handler,
}));

jest.mock('@/lib/logger', () => ({
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
  __esModule: true,
}));

jest.mock('@/lib/pairPhrases', () => ({
  generatePairPhrase: jest.fn().mockReturnValue('test-pair-phrase'),
  normalizePairPhrase: jest.fn((p: string) => (p ? p.toLowerCase().trim() : null)),
}));

const mockGetSession = jest.fn();
jest.mock('@/lib/sessionManager.server', () => ({
  getSessionFromRequest: (...args: unknown[]) => mockGetSession(...args),
}));

const mockEmitMutation = jest.fn();
jest.mock('@/lib/auditLogClient', () => ({
  emitMutation: (...args: unknown[]) => mockEmitMutation(...args),
}));

jest.mock('firebase-admin/firestore', () => ({
  FieldValue: {
    serverTimestamp: jest.fn().mockReturnValue('SERVER_TIMESTAMP'),
    delete: jest.fn().mockReturnValue('__DELETE__'),
  },
  Timestamp: {
    fromDate: jest.fn((d: Date) => ({ toMillis: () => d.getTime() })),
  },
}));

const mockRequireSession = jest.fn().mockResolvedValue('user-123');
const mockAssertUserHasSiteAccess = jest
  .fn()
  .mockResolvedValue({ siteId: 'site-1', siteData: {} });

jest.mock('@/lib/apiAuth.server', () => {
  class _ApiAuthError extends Error {
    status: number;
    constructor(status: number, message: string) {
      super(message);
      this.status = status;
    }
  }
  return {
    requireSession: (...args: unknown[]) => mockRequireSession(...args),
    assertUserHasSiteAccess: (...args: unknown[]) =>
      mockAssertUserHasSiteAccess(...args),
    // The route requires MACHINE_ENROLL now, not bare membership: authorising a
    // pairing phrase mints an agent identity plus a never-expiring refresh
    // token, and revoking one is site-admin.
    assertUserHasSiteCapability: (...args: unknown[]) =>
      mockAssertUserHasSiteAccess(...args),
    ApiAuthError: _ApiAuthError,
  };
});

const mockGetEntitlements = jest.fn();
jest.mock('@/lib/tridantEntitlements.server', () => ({
  getEntitlements: (uid: string) => mockGetEntitlements(uid),
}));

const mockDocGet = jest.fn();
const mockDocSet = jest.fn();
const mockWhereGet = jest.fn();
const mockTransactionGet = jest.fn();
const mockTransactionSet = jest.fn();
const mockTransactionUpdate = jest.fn();
const mockTransactionDelete = jest.fn();
const mockRunTransaction = jest.fn();
const mockCreateCustomToken = jest.fn().mockResolvedValue('mock-custom-token');
const mockSetCustomUserClaims = jest.fn().mockResolvedValue(undefined);

// what the real plan resolver reads: site owners and the machine docs under each site
let mockSites: Record<string, { owner: string; machines: Record<string, Record<string, unknown>> }> = {};
const mockPlanRead = jest.fn();

function mockOtherDocGet(collectionPath: string, id: string) {
  const [root, siteId] = collectionPath.split('/');
  if (collectionPath === 'sites' || collectionPath === 'users') mockPlanRead(collectionPath, id);
  const data =
    collectionPath === 'sites'
      ? mockSites[id] && { owner: mockSites[id].owner }
      : root === 'sites' && siteId
        ? mockSites[siteId]?.machines[id]
        : undefined;
  return Promise.resolve({ exists: data !== undefined, data: () => data });
}

const mockMakeDocRef = (collectionPath: string, id: string): Record<string, unknown> => ({
  id,
  path: `${collectionPath}/${id}`,
  collectionPath,
  get: collectionPath === 'device_codes' ? mockDocGet : () => mockOtherDocGet(collectionPath, id),
  set: mockDocSet,
  collection: (sub: string) => ({
    doc: (subId: string) => mockMakeDocRef(`${collectionPath}/${id}/${sub}`, subId),
    select: () => ({
      get: async () => ({
        docs: Object.keys(mockSites[id]?.machines ?? {}).map((machineId) => ({ id: machineId })),
      }),
    }),
  }),
});

const mockDocRef = mockMakeDocRef('device_codes', 'test-pair-phrase');

// device-code docs come from mockTransactionGet; machine docs (the pairedAt stamp) from mockSites
const mockTxGet = (ref: { collectionPath: string; id: string }) =>
  ref.collectionPath === 'device_codes' ? mockTransactionGet(ref) : mockOtherDocGet(ref.collectionPath, ref.id);

jest.mock('@/lib/firebase-admin', () => ({
  getAdminDb: () => ({
    collection: (name: string) => ({
      doc: (id: string) => mockMakeDocRef(name, id),
      where: (field: string, _op: string, value: unknown) => ({
        limit: (_n: number) => ({
          get: mockWhereGet,
        }),
        select: () => ({
          get: async () => {
            mockPlanRead(name, `${field}==${String(value)}`);
            return {
              docs: Object.keys(mockSites)
                .filter((siteId) => mockSites[siteId].owner === value)
                .map((siteId) => ({ id: siteId, ref: mockMakeDocRef('sites', siteId) })),
            };
          },
        }),
      }),
    }),
    runTransaction: (fn: (tx: unknown) => Promise<unknown>) => mockRunTransaction(fn),
  }),
  getAdminAuth: () => ({
    createCustomToken: mockCreateCustomToken,
    setCustomUserClaims: mockSetCustomUserClaims,
  }),
}));

import { POST as generatePOST } from '@/app/api/agent/auth/device-code/route';
import { POST as pollPOST } from '@/app/api/agent/auth/device-code/poll/route';
import { POST as authorizePOST } from '@/app/api/agent/auth/device-code/authorize/route';
import { MACHINE_LIMIT_ERROR } from '@/lib/pairingPlan.server';

const FREE = {
  ok: true,
  resolved: false,
  standing: 'expired',
  inGoodStanding: false,
  ent: { 'owlette.machines': '1', 'owlette.sites': '1', 'owlette.control': '0' },
  epoch: 0,
};

/** enforcement on, tridant configured, and every payer on owlette free. */
function enforceFree() {
  process.env.PLAN_ENFORCEMENT = 'on';
  process.env.TRIDANT_API_URL = 'https://id.tridant.test';
  process.env.TRIDANT_LICENSE_KEY = 'test-license-key';
  mockGetEntitlements.mockResolvedValue(FREE);
}

afterEach(() => {
  delete process.env.PLAN_ENFORCEMENT;
  delete process.env.TRIDANT_API_URL;
  delete process.env.TRIDANT_LICENSE_KEY;
  mockSites = {};
});

/** the pairedAt stamp written to a machine doc, if any. */
function pairedAtWrite(siteId: string, machineId: string) {
  return mockTransactionSet.mock.calls.find(
    ([ref]) => ref.path === `sites/${siteId}/machines/${machineId}`,
  );
}

function makeRequest(
  path: string,
  body: Record<string, unknown>,
): NextRequest {
  return new NextRequest(new URL(`http://localhost${path}`), {
    method: 'POST',
    body: JSON.stringify(body),
    headers: { 'content-type': 'application/json' },
  });
}

async function parseResponse(res: Response) {
  return { status: res.status, body: await res.json() };
}

describe('POST /api/agent/auth/device-code (generate)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockDocGet.mockResolvedValue({ exists: false });
    mockDocSet.mockResolvedValue(undefined);
    // Default: no session → anonymous installer call → interactive flow
    mockGetSession.mockResolvedValue({ userId: null, expiresAt: null });
  });

  it('returns pairing phrase, deviceCode, and URLs on success', async () => {
    const req = makeRequest('/api/agent/auth/device-code', {
      machineId: 'test-machine',
      version: '2.5.9',
    });

    const { status, body } = await parseResponse(await generatePOST(req));

    expect(status).toBe(200);
    expect(body.pairPhrase).toBe('test-pair-phrase');
    expect(body.deviceCode).toBeDefined();
    expect(body.verificationUri).toMatch(/\/add$/);
    expect(body.pairingUrl).toContain('/add?code=');
    expect(body.expiresIn).toBe(600);
    expect(body.interval).toBe(5);
    expect(mockDocSet).toHaveBeenCalledTimes(1);
  });

  it('persists deviceCode and wrapVersion on interactive (anonymous) start', async () => {
    const req = makeRequest('/api/agent/auth/device-code', {
      machineId: 'test-machine',
      version: '2.5.9',
    });

    await generatePOST(req);

    const written = mockDocSet.mock.calls[0]![0] as Record<string, unknown>;
    expect(written.wrapVersion).toBe('v1');
    expect(typeof written.deviceCode).toBe('string');
    expect((written.deviceCode as string).length).toBeGreaterThan(40);
    expect(written.preauthorizedIntent).toBeUndefined();
  });

  it('marks dashboard-originated codes as preauthorizedIntent and omits deviceCode', async () => {
    mockGetSession.mockResolvedValue({
      userId: 'user-123',
      expiresAt: Date.now() + 60_000,
    });

    const req = makeRequest('/api/agent/auth/device-code', {});
    await generatePOST(req);

    const written = mockDocSet.mock.calls[0]![0] as Record<string, unknown>;
    expect(written.preauthorizedIntent).toBe(true);
    expect(written.deviceCode).toBeUndefined();
  });

  it('returns 500 after 5 collision attempts', async () => {
    mockDocGet.mockResolvedValue({ exists: true });

    const req = makeRequest('/api/agent/auth/device-code', {
      machineId: 'test-machine',
      version: '2.5.9',
    });

    const { status, body } = await parseResponse(await generatePOST(req));

    expect(status).toBe(500);
    expect(body.error).toContain('unique pairing phrase');
    expect(mockDocGet).toHaveBeenCalledTimes(5);
  });
});

describe('POST /api/agent/auth/device-code/poll', () => {
  const mockTransaction = {
    get: mockTxGet,
    set: mockTransactionSet,
    update: mockTransactionUpdate,
    delete: mockTransactionDelete,
  };
  const originalFetch = global.fetch;

  beforeEach(() => {
    jest.clearAllMocks();
    mockRunTransaction.mockImplementation(async (fn: (tx: unknown) => unknown) =>
      fn(mockTransaction),
    );
    process.env.NEXT_PUBLIC_FIREBASE_API_KEY = 'test-api-key';
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        idToken: 'mock-id-token',
        refreshToken: 'mock-refresh',
      }),
    });
  });

  afterAll(() => {
    global.fetch = originalFetch;
  });

  it('returns 400 when neither deviceCode nor pairPhrase provided', async () => {
    const req = makeRequest('/api/agent/auth/device-code/poll', {});
    const { status, body } = await parseResponse(await pollPOST(req));

    expect(status).toBe(400);
    expect(body.error).toContain('Missing required field');
  });

  it('returns 400 for invalid pairPhrase format', async () => {
    const { normalizePairPhrase } = jest.requireMock('@/lib/pairPhrases');
    normalizePairPhrase.mockReturnValueOnce(null);

    const req = makeRequest('/api/agent/auth/device-code/poll', {
      pairPhrase: 'bad',
    });
    const { status, body } = await parseResponse(await pollPOST(req));

    expect(status).toBe(400);
    expect(body.error).toContain('Invalid pairing phrase format');
    expect(mockDocGet).not.toHaveBeenCalled();
  });

  it('returns 404 for invalid deviceCode', async () => {
    mockWhereGet.mockResolvedValue({ empty: true });

    const req = makeRequest('/api/agent/auth/device-code/poll', {
      deviceCode: 'invalid-code',
    });
    const { status, body } = await parseResponse(await pollPOST(req));

    expect(status).toBe(404);
    expect(body.error).toContain('Invalid device code');
  });

  it('returns 202 with pending status', async () => {
    mockDocGet.mockResolvedValue({ exists: true });
    const futureTime = Date.now() + 600_000;
    mockTransactionGet.mockResolvedValue({
      exists: true,
      data: () => ({
        status: 'pending',
        expiresAt: { toMillis: () => futureTime },
      }),
    });

    const req = makeRequest('/api/agent/auth/device-code/poll', {
      pairPhrase: 'test-pair-phrase',
    });
    const { status, body } = await parseResponse(await pollPOST(req));

    expect(status).toBe(202);
    expect(body.status).toBe('pending');
  });

  it('returns 200 with plaintext tokens when polling a pre-authorised doc by phrase', async () => {
    mockDocGet.mockResolvedValue({ exists: true });
    const futureTime = Date.now() + 600_000;
    mockTransactionGet.mockResolvedValue({
      exists: true,
      data: () => ({
        status: 'authorized',
        preauthorized: true,
        accessToken: 'mock-access-token',
        refreshToken: 'mock-refresh-token',
        siteId: 'site-1',
        expiresAt: { toMillis: () => futureTime },
      }),
    });

    const req = makeRequest('/api/agent/auth/device-code/poll', {
      pairPhrase: 'test-pair-phrase',
    });
    const { status, body } = await parseResponse(await pollPOST(req));

    expect(status).toBe(200);
    expect(body.accessToken).toBe('mock-access-token');
    expect(body.refreshToken).toBe('mock-refresh-token');
    expect(body.expiresIn).toBe(3600);
    expect(body.siteId).toBe('site-1');
    expect(mockTransactionDelete).toHaveBeenCalled();
  });

  it('mints deferred pre-authorized tokens with the supplied machineId and consumes the doc', async () => {
    const host = 'DESKTOP-CRA2RC0';
    mockDocGet.mockResolvedValue({
      exists: true,
      data: () => ({
        status: 'authorized',
        deferTokenMint: true,
      }),
    });
    const futureTime = Date.now() + 600_000;
    mockTransactionGet
      .mockResolvedValueOnce({
        exists: true,
        data: () => ({
          status: 'authorized',
          deferTokenMint: true,
          siteId: 'site-1',
          authorizedBy: 'user-123',
          expiresAt: { toMillis: () => futureTime },
        }),
      })
      .mockResolvedValueOnce({
        exists: true,
        data: () => ({
          status: 'authorized',
          deferTokenMint: true,
          siteId: 'site-1',
          authorizedBy: 'user-123',
          expiresAt: { toMillis: () => futureTime },
          mintMachineId: host,
          mintClaimExpiresAt: Date.now() + 60_000,
        }),
      });

    const req = makeRequest('/api/agent/auth/device-code/poll', {
      pairPhrase: 'test-pair-phrase',
      machineId: host,
      version: '2.5.9',
    });
    const { status, body } = await parseResponse(await pollPOST(req));

    expect(status).toBe(200);
    expect(body.accessToken).toBe('mock-id-token');
    expect(body.refreshToken).toBeDefined();
    expect(body.siteId).toBe('site-1');
    // claim, finalize, then the pairedAt stamp
    expect(mockRunTransaction).toHaveBeenCalledTimes(3);
    expect(pairedAtWrite('site-1', host)?.slice(1)).toEqual([
      { pairedAt: 'SERVER_TIMESTAMP' },
      { merge: true },
    ]);
    expect(mockTransactionUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        collectionPath: 'device_codes',
        id: 'test-pair-phrase',
      }),
      expect.objectContaining({
        mintMachineId: host,
        mintVersion: '2.5.9',
        mintClaimExpiresAt: expect.any(Number),
      }),
    );

    expect(mockCreateCustomToken).toHaveBeenCalledTimes(2);
    for (const call of mockCreateCustomToken.mock.calls) {
      expect(call[1]).toEqual(expect.objectContaining({ machine_id: host }));
      expect(String(call[1].machine_id)).not.toMatch(/^pending_/);
    }
    expect(mockSetCustomUserClaims).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ machine_id: host }),
    );

    const refreshWrite = mockTransactionSet.mock.calls.find(
      ([ref]) => ref.collectionPath === 'agent_refresh_tokens',
    );
    expect(refreshWrite).toBeDefined();
    const [refreshRef, refreshPayload] = refreshWrite!;
    const crypto = await import('crypto');
    const expectedHash = crypto.createHash('sha256').update(body.refreshToken).digest('hex');
    expect(refreshRef).toEqual(
      expect.objectContaining({
        collectionPath: 'agent_refresh_tokens',
        id: expectedHash,
      }),
    );
    expect(refreshPayload).toEqual(
      expect.objectContaining({
        siteId: 'site-1',
        machineId: host,
        version: '2.5.9',
        createdBy: 'user-123',
        agentUid: 'agent_site_1_DESKTOP_CRA2RC0',
      }),
    );

    expect(mockTransactionDelete).toHaveBeenCalledWith(
      expect.objectContaining({
        collectionPath: 'device_codes',
        id: 'test-pair-phrase',
      }),
    );
  });

  it.each([
    ['missing', undefined],
    ['slash', 'DESKTOP/CRA2RC0'],
    ['control char', 'DESKTOP\u0001CRA2RC0'],
    ['too long', 'A'.repeat(129)],
    ['empty after trim', '   '],
  ])('returns 400 for %s deferred machineId without minting or consuming', async (_case, value) => {
    mockDocGet.mockResolvedValue({
      exists: true,
      data: () => ({
        status: 'authorized',
        deferTokenMint: true,
      }),
    });

    const payload: Record<string, unknown> = {
      pairPhrase: 'test-pair-phrase',
      version: '2.5.9',
    };
    if (value !== undefined) {
      payload.machineId = value;
    }

    const req = makeRequest('/api/agent/auth/device-code/poll', payload);
    const { status } = await parseResponse(await pollPOST(req));

    expect(status).toBe(400);
    expect(mockCreateCustomToken).not.toHaveBeenCalled();
    expect(mockSetCustomUserClaims).not.toHaveBeenCalled();
    expect(global.fetch).not.toHaveBeenCalled();
    expect(mockTransactionSet).not.toHaveBeenCalled();
    expect(mockDocSet).not.toHaveBeenCalled();
    expect(mockTransactionDelete).not.toHaveBeenCalled();
  });

  it('returns 410 for an expired deferred pairing phrase without minting', async () => {
    mockDocGet.mockResolvedValue({
      exists: true,
      data: () => ({
        status: 'authorized',
        deferTokenMint: true,
      }),
    });
    const pastTime = Date.now() - 1000;
    mockTransactionGet.mockResolvedValue({
      exists: true,
      data: () => ({
        status: 'authorized',
        deferTokenMint: true,
        siteId: 'site-1',
        authorizedBy: 'user-123',
        expiresAt: { toMillis: () => pastTime },
      }),
    });

    const req = makeRequest('/api/agent/auth/device-code/poll', {
      pairPhrase: 'test-pair-phrase',
      machineId: 'DESKTOP-CRA2RC0',
      version: '2.5.9',
    });
    const { status, body } = await parseResponse(await pollPOST(req));

    expect(status).toBe(410);
    expect(body.error).toBe('expired');
    expect(mockCreateCustomToken).not.toHaveBeenCalled();
    expect(mockSetCustomUserClaims).not.toHaveBeenCalled();
    expect(global.fetch).not.toHaveBeenCalled();
    expect(mockTransactionDelete).toHaveBeenCalled();
    expect(mockTransactionSet).not.toHaveBeenCalled();
  });

  it('returns 404 when a deferred pairing phrase has already been consumed', async () => {
    mockDocGet.mockResolvedValue({ exists: false });

    const req = makeRequest('/api/agent/auth/device-code/poll', {
      pairPhrase: 'test-pair-phrase',
      machineId: 'DESKTOP-CRA2RC0',
      version: '2.5.9',
    });
    const { status, body } = await parseResponse(await pollPOST(req));

    expect(status).toBe(404);
    expect(body.error).toContain('Invalid pairing phrase');
    expect(mockCreateCustomToken).not.toHaveBeenCalled();
    expect(mockSetCustomUserClaims).not.toHaveBeenCalled();
    expect(global.fetch).not.toHaveBeenCalled();
    expect(mockTransactionDelete).not.toHaveBeenCalled();
  });

  it('rejects phrase-based polling for an interactive (v1) doc', async () => {
    mockDocGet.mockResolvedValue({ exists: true });
    const futureTime = Date.now() + 600_000;
    mockTransactionGet.mockResolvedValue({
      exists: true,
      data: () => ({
        status: 'authorized',
        wrapVersion: 'v1',
        encryptedCredentials: 'AAAA',
        siteId: 'site-1',
        expiresAt: { toMillis: () => futureTime },
      }),
    });

    const req = makeRequest('/api/agent/auth/device-code/poll', {
      pairPhrase: 'test-pair-phrase',
    });
    const { status, body } = await parseResponse(await pollPOST(req));

    expect(status).toBe(403);
    expect(body.error).toContain('device code');
    expect(mockTransactionDelete).not.toHaveBeenCalled();
  });

  it('returns 200 with encrypted blob when polling a v1 doc by deviceCode', async () => {
    mockWhereGet.mockResolvedValue({
      empty: false,
      docs: [{ ref: { ...mockDocRef, id: 'test-pair-phrase' } }],
    });
    const futureTime = Date.now() + 600_000;
    mockTransactionGet.mockResolvedValue({
      exists: true,
      data: () => ({
        status: 'authorized',
        wrapVersion: 'v1',
        encryptedCredentials: 'ENC',
        siteId: 'site-1',
        machineId: 'test-machine',
        expiresAt: { toMillis: () => futureTime },
      }),
    });

    const req = makeRequest('/api/agent/auth/device-code/poll', {
      deviceCode: 'opaque-device-code',
    });
    const { status, body } = await parseResponse(await pollPOST(req));

    expect(status).toBe(200);
    expect(body.wrapVersion).toBe('v1');
    expect(body.encryptedCredentials).toBe('ENC');
    expect(body.phrase).toBe('test-pair-phrase');
    expect(mockTransactionDelete).toHaveBeenCalled();
    // the handover is when the machine is paired, so it stamps here
    expect(pairedAtWrite('site-1', 'test-machine')?.slice(1)).toEqual([
      { pairedAt: 'SERVER_TIMESTAMP' },
      { merge: true },
    ]);
  });

  it('keeps the first pairedAt when a machine re-pairs', async () => {
    mockSites = { 'site-1': { owner: 'owner-1', machines: { 'test-machine': { pairedAt: 'FIRST' } } } };
    mockWhereGet.mockResolvedValue({ empty: false, docs: [{ ref: mockDocRef }] });
    mockTransactionGet.mockResolvedValue({
      exists: true,
      data: () => ({
        status: 'authorized',
        wrapVersion: 'v1',
        encryptedCredentials: 'ENC',
        siteId: 'site-1',
        machineId: 'test-machine',
        expiresAt: { toMillis: () => Date.now() + 600_000 },
      }),
    });

    const req = makeRequest('/api/agent/auth/device-code/poll', { deviceCode: 'opaque-device-code' });
    const { status } = await parseResponse(await pollPOST(req));

    expect(status).toBe(200);
    expect(pairedAtWrite('site-1', 'test-machine')).toBeUndefined();
  });

  it('rejects phrase-based polling for a legacy doc that is not preauthorised', async () => {
    mockDocGet.mockResolvedValue({ exists: true });
    const futureTime = Date.now() + 600_000;
    mockTransactionGet.mockResolvedValue({
      exists: true,
      data: () => ({
        status: 'authorized',
        // no wrapVersion, no preauthorized flag
        accessToken: 'mock-access-token',
        refreshToken: 'mock-refresh-token',
        siteId: 'site-1',
        expiresAt: { toMillis: () => futureTime },
      }),
    });

    const req = makeRequest('/api/agent/auth/device-code/poll', {
      pairPhrase: 'test-pair-phrase',
    });
    const { status, body } = await parseResponse(await pollPOST(req));

    expect(status).toBe(403);
    expect(body.error).toContain('device code');
    expect(mockTransactionDelete).not.toHaveBeenCalled();
  });

  it('returns 410 when device code is expired', async () => {
    mockDocGet.mockResolvedValue({ exists: true });
    const pastTime = Date.now() - 1000;
    mockTransactionGet.mockResolvedValue({
      exists: true,
      data: () => ({
        status: 'pending',
        expiresAt: { toMillis: () => pastTime },
      }),
    });

    const req = makeRequest('/api/agent/auth/device-code/poll', {
      pairPhrase: 'test-pair-phrase',
    });
    const { status, body } = await parseResponse(await pollPOST(req));

    expect(status).toBe(410);
    expect(body.error).toBe('expired');
    expect(mockTransactionDelete).toHaveBeenCalled();
  });

  it('answers a code refused at authorize with 402 and only its reason, which every agent shows', async () => {
    mockWhereGet.mockResolvedValue({ empty: false, docs: [{ ref: mockDocRef }] });
    mockTransactionGet.mockResolvedValue({
      exists: true,
      data: () => ({
        status: 'refused',
        refusedReason: MACHINE_LIMIT_ERROR,
        expiresAt: { toMillis: () => Date.now() + 600_000 },
      }),
    });

    const req = makeRequest('/api/agent/auth/device-code/poll', { deviceCode: 'opaque-device-code' });
    const { status, body } = await parseResponse(await pollPOST(req));

    expect(status).toBe(402);
    expect(body).toEqual({ error: MACHINE_LIMIT_ERROR });
    expect(mockTransactionDelete).not.toHaveBeenCalled();
  });

  describe('deferred (/ADD=) mint and the machine limit', () => {
    // a refusal never reaches the finalise read, so its queued doc must not leak into the next test
    afterEach(() => mockTransactionGet.mockReset());

    /** a pre-authorised phrase for site-1, claimed and then finalised for `machineId`. */
    function deferredPhrase(machineId: string) {
      const live = {
        status: 'authorized',
        deferTokenMint: true,
        siteId: 'site-1',
        authorizedBy: 'user-123',
        expiresAt: { toMillis: () => Date.now() + 600_000 },
      };
      mockDocGet.mockResolvedValue({ exists: true, data: () => live });
      mockTransactionGet
        .mockResolvedValueOnce({ exists: true, data: () => live })
        .mockResolvedValueOnce({
          exists: true,
          data: () => ({ ...live, mintMachineId: machineId, mintClaimExpiresAt: Date.now() + 60_000 }),
        });
      return makeRequest('/api/agent/auth/device-code/poll', {
        pairPhrase: 'test-pair-phrase',
        machineId,
        version: '4.1.7',
      });
    }

    it('refuses a new machine past the limit with 402 { error }, minting nothing and leaving the phrase', async () => {
      enforceFree();
      mockSites = { 'site-1': { owner: 'owner-1', machines: { 'OTHER-PC': {} } } };

      const { status, body } = await parseResponse(await pollPOST(deferredPhrase('NEW-PC')));

      expect(status).toBe(402);
      expect(body).toEqual({ error: MACHINE_LIMIT_ERROR });
      expect(mockGetEntitlements).toHaveBeenCalledWith('owner-1');
      expect(mockCreateCustomToken).not.toHaveBeenCalled();
      expect(mockSetCustomUserClaims).not.toHaveBeenCalled();
      expect(global.fetch).not.toHaveBeenCalled();
      expect(mockTransactionSet).not.toHaveBeenCalled();
      expect(mockTransactionDelete).not.toHaveBeenCalled();
    });

    it("lets a machine already in the payer's sites re-pair", async () => {
      enforceFree();
      mockSites = {
        'site-1': { owner: 'owner-1', machines: {} },
        'site-2': { owner: 'owner-1', machines: { 'HOME-PC': {} } },
      };

      const { status, body } = await parseResponse(await pollPOST(deferredPhrase('HOME-PC')));

      expect(status).toBe(200);
      expect(body.accessToken).toBe('mock-id-token');
      expect(mockCreateCustomToken).toHaveBeenCalled();
    });

    it('mints past the limit with enforcement off, never reading the plan', async () => {
      mockSites = { 'site-1': { owner: 'owner-1', machines: { 'OTHER-PC': {} } } };
      mockGetEntitlements.mockResolvedValue(FREE);

      const { status } = await parseResponse(await pollPOST(deferredPhrase('NEW-PC')));

      expect(status).toBe(200);
      expect(mockGetEntitlements).not.toHaveBeenCalled();
      expect(mockPlanRead).not.toHaveBeenCalled();
    });
  });
});

describe('POST /api/agent/auth/device-code/authorize', () => {
  const mockTransaction = {
    get: mockTxGet,
    set: mockTransactionSet,
    update: mockTransactionUpdate,
    delete: mockTransactionDelete,
  };

  const originalFetch = global.fetch;

  beforeEach(() => {
    jest.clearAllMocks();
    mockRequireSession.mockResolvedValue('user-123');
    mockAssertUserHasSiteAccess.mockResolvedValue({
      siteId: 'site-1',
      siteData: {},
    });
    mockRunTransaction.mockImplementation(async (fn: (tx: unknown) => unknown) =>
      fn(mockTransaction),
    );
    process.env.NEXT_PUBLIC_FIREBASE_API_KEY = 'test-api-key';
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        idToken: 'mock-id-token',
        refreshToken: 'mock-refresh',
      }),
    });
  });

  afterAll(() => {
    global.fetch = originalFetch;
  });

  it('returns 400 when pairPhrase is missing', async () => {
    const req = makeRequest('/api/agent/auth/device-code/authorize', {
      siteId: 'site-1',
    });
    const { status, body } = await parseResponse(await authorizePOST(req));

    expect(status).toBe(400);
    expect(body.error).toContain('Missing required fields');
  });

  it('returns 400 when siteId is missing', async () => {
    const req = makeRequest('/api/agent/auth/device-code/authorize', {
      pairPhrase: 'test-pair-phrase',
    });
    const { status, body } = await parseResponse(await authorizePOST(req));

    expect(status).toBe(400);
    expect(body.error).toContain('Missing required fields');
  });

  it('returns 400 for invalid phrase format', async () => {
    const { normalizePairPhrase } = jest.requireMock('@/lib/pairPhrases');
    normalizePairPhrase.mockReturnValueOnce(null);

    const req = makeRequest('/api/agent/auth/device-code/authorize', {
      pairPhrase: 'bad',
      siteId: 'site-1',
    });
    const { status, body } = await parseResponse(await authorizePOST(req));

    expect(status).toBe(400);
    expect(body.error).toContain('Invalid pairing phrase format');
  });

  it('returns 401 when not authenticated', async () => {
    const { ApiAuthError } = jest.requireMock('@/lib/apiAuth.server');
    mockRequireSession.mockRejectedValueOnce(
      new ApiAuthError(401, 'Unauthorized'),
    );

    const req = makeRequest('/api/agent/auth/device-code/authorize', {
      pairPhrase: 'test-pair-phrase',
      siteId: 'site-1',
    });
    const { status, body } = await parseResponse(await authorizePOST(req));

    expect(status).toBe(401);
    expect(body.error).toBe('Unauthorized');
  });

  it('returns 404 when phrase not found in Firestore', async () => {
    mockTransactionGet.mockResolvedValue({ exists: false });

    const req = makeRequest('/api/agent/auth/device-code/authorize', {
      pairPhrase: 'test-pair-phrase',
      siteId: 'site-1',
    });
    const { status, body } = await parseResponse(await authorizePOST(req));

    expect(status).toBe(404);
    expect(body.error).toContain('not found');
  });

  it('returns 409 when phrase already authorized', async () => {
    const futureTime = Date.now() + 600_000;
    mockTransactionGet.mockResolvedValue({
      exists: true,
      data: () => ({
        status: 'authorized',
        expiresAt: { toMillis: () => futureTime },
      }),
    });

    const req = makeRequest('/api/agent/auth/device-code/authorize', {
      pairPhrase: 'test-pair-phrase',
      siteId: 'site-1',
    });
    const { status, body } = await parseResponse(await authorizePOST(req));

    expect(status).toBe(409);
    expect(body.error).toContain('already been used');
  });

  it('authorizes interactive (v1) docs by encrypting credentials and wiping plaintext fields', async () => {
    const futureTime = Date.now() + 600_000;
    mockTransactionGet.mockResolvedValue({
      exists: true,
      data: () => ({
        status: 'pending',
        machineId: 'test-machine',
        version: '2.5.9',
        wrapVersion: 'v1',
        deviceCode: 'a'.repeat(86), // base64url of 64 random bytes
        expiresAt: { toMillis: () => futureTime },
      }),
    });

    const req = makeRequest('/api/agent/auth/device-code/authorize', {
      pairPhrase: 'test-pair-phrase',
      siteId: 'site-1',
    });
    const { status, body } = await parseResponse(await authorizePOST(req));

    expect(status).toBe(200);
    expect(body.success).toBe(true);
    expect(body.machineId).toBe('test-machine');
    expect(mockCreateCustomToken).toHaveBeenCalled();
    expect(mockTransactionSet).toHaveBeenCalled();
    expect(mockTransactionUpdate).toHaveBeenCalled();
    expect(global.fetch).toHaveBeenCalledTimes(2);

    const update = mockTransactionUpdate.mock.calls[0]![1] as Record<string, unknown>;
    expect(update.status).toBe('authorized');
    expect(update.wrapVersion).toBe('v1');
    expect(typeof update.encryptedCredentials).toBe('string');
    // Plaintext credential fields and the cleartext deviceCode must all
    // be wiped — they are set to the FieldValue.delete() sentinel
    // ('__DELETE__' in the test mock), not a live string.
    expect(update.accessToken).toBe('__DELETE__');
    expect(update.refreshToken).toBe('__DELETE__');
    expect(update.deviceCode).toBe('__DELETE__');

    // pairedAt waits for the agent to collect the credentials at poll
    expect(pairedAtWrite('site-1', 'test-machine')).toBeUndefined();

    // The machineId IS known on this path, so the audit binds it.
    expect(mockEmitMutation).toHaveBeenCalledTimes(1);
    const audit = mockEmitMutation.mock.calls[0]![0] as {
      kind: string;
      siteId: string;
      actor: string;
      targetId: string;
      attributes: Record<string, unknown>;
    };
    expect(audit.kind).toBe('site_mutated');
    expect(audit.siteId).toBe('site-1');
    expect(audit.actor).toBe('user:user-123');
    expect(audit.targetId).toBe('test-machine');
    expect(audit.attributes).toMatchObject({
      verb: 'machine.pair',
      endpoint: '/api/agent/auth/device-code/authorize',
      method: 'POST',
      siteId: 'site-1',
      machineId: 'test-machine',
      deferredTokenMint: false,
    });
    // The pairing phrase is a bearer credential — it must never be recorded.
    expect(JSON.stringify(audit)).not.toContain('test-pair-phrase');
  });

  it('defers token minting for pre-authorised docs', async () => {
    const futureTime = Date.now() + 600_000;
    mockTransactionGet.mockResolvedValue({
      exists: true,
      data: () => ({
        status: 'pending',
        machineId: null,
        version: '2.5.9',
        wrapVersion: 'v1',
        preauthorizedIntent: true,
        // deviceCode absent — dashboard origin
        expiresAt: { toMillis: () => futureTime },
      }),
    });

    const req = makeRequest('/api/agent/auth/device-code/authorize', {
      pairPhrase: 'test-pair-phrase',
      siteId: 'site-1',
    });
    const { status, body } = await parseResponse(await authorizePOST(req));

    expect(status).toBe(200);
    expect(body.success).toBe(true);
    expect(body.machineId).toBeNull();
    const update = mockTransactionUpdate.mock.calls[0]![1] as Record<string, unknown>;
    expect(update.status).toBe('authorized');
    expect(update.siteId).toBe('site-1');
    expect(update.authorizedBy).toBe('user-123');
    expect(update.authorizedAt).toBe('SERVER_TIMESTAMP');
    expect(update.deferTokenMint).toBe(true);
    expect(update.accessToken).toBeUndefined();
    expect(update.refreshToken).toBeUndefined();
    expect(update.encryptedCredentials).toBeUndefined();
    expect(mockCreateCustomToken).not.toHaveBeenCalled();
    expect(mockSetCustomUserClaims).not.toHaveBeenCalled();
    expect(mockTransactionSet).not.toHaveBeenCalled();
    expect(global.fetch).not.toHaveBeenCalled();

    // Deferred mint: the machine is not bound yet, so the row records the site
    // it was authorized onto and says so — it does not invent a machineId.
    expect(mockEmitMutation).toHaveBeenCalledTimes(1);
    const audit = mockEmitMutation.mock.calls[0]![0] as {
      targetId: string;
      attributes: Record<string, unknown>;
    };
    expect(audit.targetId).toBe('site-1');
    expect(audit.attributes).toMatchObject({
      verb: 'machine.pair',
      siteId: 'site-1',
      deferredTokenMint: true,
    });
    expect(audit.attributes).not.toHaveProperty('machineId');
  });

  it('emits no audit row when the phrase is already used', async () => {
    const futureTime = Date.now() + 600_000;
    mockTransactionGet.mockResolvedValue({
      exists: true,
      data: () => ({
        status: 'authorized',
        expiresAt: { toMillis: () => futureTime },
      }),
    });

    const req = makeRequest('/api/agent/auth/device-code/authorize', {
      pairPhrase: 'test-pair-phrase',
      siteId: 'site-1',
    });
    const { status } = await parseResponse(await authorizePOST(req));

    expect(status).toBe(409);
    expect(mockEmitMutation).not.toHaveBeenCalled();
  });

  it('rejects pending docs without encryption support as invalid state', async () => {
    const futureTime = Date.now() + 600_000;
    mockTransactionGet.mockResolvedValue({
      exists: true,
      data: () => ({
        status: 'pending',
        machineId: null,
        version: '2.5.9',
        expiresAt: { toMillis: () => futureTime },
      }),
    });

    const req = makeRequest('/api/agent/auth/device-code/authorize', {
      pairPhrase: 'test-pair-phrase',
      siteId: 'site-1',
    });
    const { status, body } = await parseResponse(await authorizePOST(req));

    expect(status).toBe(400);
    expect(body.error).toContain('Invalid device code state');
    expect(mockCreateCustomToken).not.toHaveBeenCalled();
    expect(mockSetCustomUserClaims).not.toHaveBeenCalled();
    expect(mockTransactionSet).not.toHaveBeenCalled();
    expect(mockTransactionUpdate).not.toHaveBeenCalled();
    expect(global.fetch).not.toHaveBeenCalled();
  });

  describe('the machine limit', () => {
    /** an interactive code for `machineId`, authorised onto site-1, which owner-1 pays for. */
    function interactiveCode(machineId: string) {
      mockAssertUserHasSiteAccess.mockResolvedValue({ siteId: 'site-1', siteData: { owner: 'owner-1' } });
      mockTransactionGet.mockResolvedValue({
        exists: true,
        data: () => ({
          status: 'pending',
          machineId,
          version: '4.1.7',
          wrapVersion: 'v1',
          deviceCode: 'a'.repeat(86),
          expiresAt: { toMillis: () => Date.now() + 600_000 },
        }),
      });
      return makeRequest('/api/agent/auth/device-code/authorize', {
        pairPhrase: 'test-pair-phrase',
        siteId: 'site-1',
      });
    }

    it('refuses a new machine past the limit with 402 and marks the code refused for the agent', async () => {
      enforceFree();
      mockSites = { 'site-1': { owner: 'owner-1', machines: { 'other-machine': {} } } };

      const { status, body } = await parseResponse(await authorizePOST(interactiveCode('test-machine')));

      expect(status).toBe(402);
      expect(body).toEqual({ error: MACHINE_LIMIT_ERROR });
      expect(mockTransactionUpdate).toHaveBeenCalledTimes(1);
      expect(mockTransactionUpdate).toHaveBeenCalledWith(
        expect.objectContaining({ collectionPath: 'device_codes', id: 'test-pair-phrase' }),
        { status: 'refused', refusedReason: MACHINE_LIMIT_ERROR },
      );
      expect(mockGetEntitlements).toHaveBeenCalledWith('owner-1');
      // the payer comes from the site data the access check already read
      expect(mockPlanRead).not.toHaveBeenCalledWith('sites', 'site-1');
      expect(mockCreateCustomToken).not.toHaveBeenCalled();
      expect(global.fetch).not.toHaveBeenCalled();
      expect(mockTransactionSet).not.toHaveBeenCalled();
      expect(mockEmitMutation).not.toHaveBeenCalled();
    });

    it("lets a machine already in the payer's sites re-pair", async () => {
      enforceFree();
      mockSites = { 'site-1': { owner: 'owner-1', machines: { 'test-machine': {} } } };

      const { status, body } = await parseResponse(await authorizePOST(interactiveCode('test-machine')));

      expect(status).toBe(200);
      expect(body.machineId).toBe('test-machine');
      expect(mockCreateCustomToken).toHaveBeenCalled();
    });

    it('pairs past the limit with enforcement off, never reading the plan', async () => {
      mockSites = { 'site-1': { owner: 'owner-1', machines: { 'other-machine': {} } } };
      mockGetEntitlements.mockResolvedValue(FREE);

      const { status } = await parseResponse(await authorizePOST(interactiveCode('test-machine')));

      expect(status).toBe(200);
      expect(mockGetEntitlements).not.toHaveBeenCalled();
      expect(mockPlanRead).not.toHaveBeenCalled();
    });
  });
});
