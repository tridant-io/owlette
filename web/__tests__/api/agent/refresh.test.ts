/** @jest-environment node */

/**
 * Refresh-token rotation for /api/agent/auth/refresh: the endpoint rotates on
 * every success and keeps the old token usable for a 5-minute grace window
 * (REFRESH_TOKEN_GRACE_MS), so a retry after a lost response doesn't kill the
 * session. After grace the old token must be rejected.
 */

import crypto from 'crypto';
import { createMockRequest } from '../helpers/utils';

const mockSetCustomUserClaims = jest.fn();
const mockCreateCustomToken = jest.fn();
const mockRunTransaction = jest.fn();

interface StoredToken {
  siteId: string;
  machineId: string;
  version: string;
  createdBy: string;
  agentUid: string;
  supersededAt?: number;
  supersededBy?: string;
  retiresAt?: number;
  expiresAt?: number;
  predecessorHash?: string;
}

const tokenStore = new Map<string, StoredToken>();

function tokenRef(hash: string) {
  return {
    hash,
    async get() {
      const data = tokenStore.get(hash);
      return {
        exists: !!data,
        data: () =>
          data
            ? {
                ...data,
                expiresAt: data.expiresAt
                  ? { toMillis: () => data.expiresAt as number }
                  : undefined,
                retiresAt: data.retiresAt
                  ? { toMillis: () => data.retiresAt as number }
                  : undefined,
              }
            : undefined,
      };
    },
  };
}

jest.mock('@/lib/firebase-admin', () => ({
  getAdminAuth: () => ({
    setCustomUserClaims: (...a: unknown[]) => mockSetCustomUserClaims(...a),
    createCustomToken: (...a: unknown[]) => mockCreateCustomToken(...a),
  }),
  getAdminDb: () => ({
    collection: (name: string) => ({
      doc: (id: string) =>
        name === 'agent_refresh_tokens'
          ? tokenRef(id)
          : { get: async () => ({ exists: false, data: () => undefined }) },
    }),
    runTransaction: (cb: (tx: unknown) => Promise<unknown>) => {
      mockRunTransaction(cb);
      // The callback drives read → supersession/expiry check → write new token →
      // mark old superseded.
      const tx = {
        async get(ref: { hash: string }) {
          const data = tokenStore.get(ref.hash);
          return {
            exists: !!data,
            // Real DocumentSnapshots expose `.ref`; the rotation GC deletes the
            // predecessor via snapshot.ref, so the mock must provide it.
            ref: { hash: ref.hash },
            data: () =>
              data
                ? {
                    ...data,
                    expiresAt: data.expiresAt
                      ? { toMillis: () => data.expiresAt as number }
                      : undefined,
                    retiresAt: data.retiresAt
                      ? { toMillis: () => data.retiresAt as number }
                      : undefined,
                  }
                : undefined,
          };
        },
        delete(ref: { hash: string }) {
          tokenStore.delete(ref.hash);
        },
        update(ref: { hash: string }, payload: Record<string, unknown>) {
          const existing = tokenStore.get(ref.hash);
          if (!existing) return;
          // Apply only fields present in the payload — unconditionally writing
          // supersededAt broke the legacy-agent tests.
          const next: StoredToken = { ...existing };
          if ('supersededAt' in payload) {
            next.supersededAt =
              typeof payload.supersededAt === 'number'
                ? (payload.supersededAt as number)
                : Date.now(); // serverTimestamp() sentinel — approximate
          }
          if ('supersededBy' in payload && typeof payload.supersededBy === 'string') {
            next.supersededBy = payload.supersededBy;
          }
          if ('retiresAt' in payload) {
            const r = payload.retiresAt as { toMillis?: () => number } | number | undefined;
            if (typeof r === 'number') {
              next.retiresAt = r;
            } else if (r && typeof r.toMillis === 'function') {
              next.retiresAt = r.toMillis();
            }
          }
          // `lastUsed` etc. aren't modeled in StoredToken; ignore.
          tokenStore.set(ref.hash, next);
        },
        set(ref: { hash: string }, payload: Record<string, unknown>) {
          tokenStore.set(ref.hash, {
            siteId: (payload.siteId as string) ?? 'site-a',
            machineId: (payload.machineId as string) ?? 'm-1',
            version: (payload.version as string) ?? '2.11.3',
            createdBy: (payload.createdBy as string) ?? 'installer',
            agentUid: (payload.agentUid as string) ?? 'agent-uid',
            // Back-pointer to the superseded token; the NEXT rotation reads it to
            // GC the grandparent.
            predecessorHash:
              typeof payload.predecessorHash === 'string'
                ? (payload.predecessorHash as string)
                : undefined,
          });
        },
      };
      return cb(tx);
    },
  }),
}));

jest.mock('@/lib/withRateLimit', () => ({
  withRateLimit: (h: unknown) => h,
}));

jest.mock('@/lib/logger', () => ({
  __esModule: true,
  default: {
    debug: jest.fn(),
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
  },
}));

jest.mock('@sentry/nextjs', () => ({
  captureException: jest.fn(),
  captureMessage: jest.fn(),
}));

// every fielded agent deletes its tokens on a refresh 401/403, so a plan gate
// here would unpair machines: refresh must never load plan.server, even transitively.
jest.mock('@/lib/plan.server', () => {
  throw new Error('the refresh route must not load plan.server');
});

// Stub the Firebase REST token-exchange call.
global.fetch = jest.fn(async () => ({
  ok: true,
  json: async () => ({ idToken: 'new-id-token' }),
})) as unknown as typeof fetch;

import { POST as refreshPOST } from '@/app/api/agent/auth/refresh/route';

function hashOf(token: string): string {
  return crypto.createHash('sha256').update(token).digest('hex');
}

function seedToken(token: string, machineId = 'm-1') {
  tokenStore.set(hashOf(token), {
    siteId: 'site-a',
    machineId,
    version: '2.11.3',
    createdBy: 'installer',
    agentUid: 'agent-uid-1',
  });
}

beforeEach(() => {
  jest.clearAllMocks();
  tokenStore.clear();
  process.env.NEXT_PUBLIC_FIREBASE_API_KEY = 'test-firebase-key';
  mockCreateCustomToken.mockResolvedValue('fake-custom-token');
  mockSetCustomUserClaims.mockResolvedValue(undefined);
});

/**
 * Sentinel for "omit the X-Owlette-Agent-Version header" (legacy-agent path).
 * Passing `undefined` would not bypass the default parameter.
 */
const NO_AGENT_HEADER = Symbol('NO_AGENT_HEADER');

/**
 * Mock refresh request. Default agent-version '2.12.0' exercises rotation; the
 * legacy path needs NO_AGENT_HEADER or an older version string.
 */
function refreshReq(
  token: string,
  machineId = 'm-1',
  agentVersion: string | typeof NO_AGENT_HEADER = '2.12.0',
) {
  const headers: Record<string, string> = {};
  if (agentVersion !== NO_AGENT_HEADER) {
    headers['x-owlette-agent-version'] = agentVersion;
  }
  return createMockRequest('http://localhost/api/agent/auth/refresh', {
    method: 'POST',
    body: { refreshToken: token, machineId },
    headers,
  });
}

describe('POST /api/agent/auth/refresh — rotation', () => {
  it('first refresh rotates: response carries a NEW refreshToken', async () => {
    seedToken('original-refresh-token');

    const res = await refreshPOST(refreshReq('original-refresh-token'));
    expect(res.status).toBe(200);
    const body = await res.json();

    expect(body.accessToken).toBe('new-id-token');
    expect(typeof body.refreshToken).toBe('string');
    expect(body.refreshToken.length).toBeGreaterThan(40);
    expect(body.refreshToken).not.toBe('original-refresh-token');
    expect(body.expiresIn).toBe(3600);
  });

  it('original token is marked superseded after first refresh', async () => {
    seedToken('original-refresh-token');
    await refreshPOST(refreshReq('original-refresh-token'));

    const stored = tokenStore.get(hashOf('original-refresh-token'));
    expect(stored).toBeTruthy();
    expect(typeof stored!.supersededAt).toBe('number');
    expect(typeof stored!.retiresAt).toBe('number');
  });

  it('original token still works WITHIN the 5-min grace window', async () => {
    seedToken('original-refresh-token');
    // First rotation: marks original superseded with retiresAt = now + 5min.
    const r1 = await refreshPOST(refreshReq('original-refresh-token'));
    expect(r1.status).toBe(200);

    // Shrink retiresAt so we KNOW we're still in grace (what the route writes —
    // no fake timers here).
    const stored = tokenStore.get(hashOf('original-refresh-token'));
    expect(stored).toBeTruthy();
    // Already inside grace (retiresAt > now). Try again with the SAME token.
    const r2 = await refreshPOST(refreshReq('original-refresh-token'));
    // Grace path: superseded but retiresAt in the future, so another rotation.
    expect(r2.status).toBe(200);
  });

  it('original token is REJECTED past the 5-min grace window', async () => {
    seedToken('original-refresh-token');
    await refreshPOST(refreshReq('original-refresh-token'));

    // Fast-forward the superseded retiresAt into the past.
    const hash = hashOf('original-refresh-token');
    const stored = tokenStore.get(hash);
    if (!stored) throw new Error('seed missing');
    stored.retiresAt = Date.now() - 1; // grace already elapsed
    tokenStore.set(hash, stored);

    const res = await refreshPOST(refreshReq('original-refresh-token'));
    expect(res.status).toBe(401);
  });

  it('rotation garbage-collects the grandparent ONCE it is retired (past grace)', async () => {
    seedToken('t0'); // minted by exchange/authorize — no predecessorHash

    // Rotation #1: t0 -> t1. t1 records predecessorHash=hash(t0). t0 is
    // superseded (in grace) but nothing is GC'd yet (t0 has no predecessor).
    const r1 = await refreshPOST(refreshReq('t0'));
    expect(r1.status).toBe(200);
    const t1 = (await r1.json()).refreshToken as string;
    expect(typeof t1).toBe('string');
    expect(tokenStore.has(hashOf('t0'))).toBe(true);

    // Fast-forward t0 past its 5-min grace so it is provably dead.
    const t0 = tokenStore.get(hashOf('t0'))!;
    t0.retiresAt = Date.now() - 1;
    tokenStore.set(hashOf('t0'), t0);

    // Rotation #2: t1 -> t2. Reads t1.predecessorHash=hash(t0), sees t0 is
    // dead, and GCs it.
    const r2 = await refreshPOST(refreshReq(t1));
    expect(r2.status).toBe(200);
    const t2 = (await r2.json()).refreshToken as string;
    expect(typeof t2).toBe('string');

    expect(tokenStore.has(hashOf('t0'))).toBe(false); // retired grandparent GC'd
    expect(tokenStore.has(hashOf(t1))).toBe(true);     // parent still present
  });

  it('rotation does NOT delete a grandparent still within its grace window', async () => {
    seedToken('t0');

    const r1 = await refreshPOST(refreshReq('t0'));
    expect(r1.status).toBe(200);
    const t1 = (await r1.json()).refreshToken as string;

    // t0 is superseded but its retiresAt is still in the future (in grace).
    const t0 = tokenStore.get(hashOf('t0'))!;
    expect(typeof t0.retiresAt).toBe('number');
    expect(t0.retiresAt! > Date.now()).toBe(true);

    // Rotation #2 while t0 is still in grace: t0 MUST be preserved — a second
    // process could still legitimately present it.
    const r2 = await refreshPOST(refreshReq(t1));
    expect(r2.status).toBe(200);
    expect(tokenStore.has(hashOf('t0'))).toBe(true); // in-grace grandparent kept
  });

  it('machine_id_mismatch when refresh token machineId differs from claim', async () => {
    seedToken('bound-to-m1', 'm-1');
    const res = await refreshPOST(refreshReq('bound-to-m1', 'm-attacker'));
    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.error).toMatch(/Machine ID mismatch/);
  });

  it('expired refresh token rejected (when expiresAt set and in past)', async () => {
    const hash = hashOf('expired-token');
    tokenStore.set(hash, {
      siteId: 'site-a',
      machineId: 'm-1',
      version: '2.11.3',
      createdBy: 'installer',
      agentUid: 'agent-uid-1',
      expiresAt: Date.now() - 1000,
    });

    const res = await refreshPOST(refreshReq('expired-token'));
    expect(res.status).toBe(401);
    // The expired token should be deleted by the route.
    expect(tokenStore.has(hash)).toBe(false);
  });
});

// agent-version gate — staged rollout of refresh-token rotation.
// Rotation is opt-in on X-Owlette-Agent-Version >= 2.12.0; older/missing/malformed
// versions take the legacy non-rotating path so 2.11.x agents don't lose auth.

describe('POST /api/agent/auth/refresh — agent-version gate', () => {
  it('legacy agent (no header) does NOT rotate — response omits refreshToken', async () => {
    seedToken('legacy-no-header');

    const res = await refreshPOST(
      refreshReq('legacy-no-header', 'm-1', NO_AGENT_HEADER),
    );
    expect(res.status).toBe(200);
    const body = await res.json();

    expect(body.accessToken).toBe('new-id-token');
    expect(body.expiresIn).toBe(3600);
    expect(body.refreshToken).toBeUndefined();
  });

  it('legacy agent: original token is NOT marked superseded', async () => {
    seedToken('legacy-token-keepalive');
    await refreshPOST(
      refreshReq('legacy-token-keepalive', 'm-1', NO_AGENT_HEADER),
    );

    const stored = tokenStore.get(hashOf('legacy-token-keepalive'));
    expect(stored).toBeTruthy();
    expect(stored!.supersededAt).toBeUndefined();
    expect(stored!.supersededBy).toBeUndefined();
    expect(stored!.retiresAt).toBeUndefined();
  });

  it('legacy agent: the same token still works on the NEXT refresh (no grace clock)', async () => {
    seedToken('legacy-stable');

    // First refresh with no version header — no rotation.
    const r1 = await refreshPOST(refreshReq('legacy-stable', 'm-1', NO_AGENT_HEADER));
    expect(r1.status).toBe(200);

    // Second refresh with the SAME token — still works, still no rotation.
    const r2 = await refreshPOST(refreshReq('legacy-stable', 'm-1', NO_AGENT_HEADER));
    expect(r2.status).toBe(200);
    const body = await r2.json();
    expect(body.refreshToken).toBeUndefined();
  });

  it('agent-version 2.11.3 (pre-rotation) does NOT rotate', async () => {
    seedToken('agent-2113');

    const res = await refreshPOST(
      refreshReq('agent-2113', 'm-1', '2.11.3'),
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.refreshToken).toBeUndefined();

    const stored = tokenStore.get(hashOf('agent-2113'));
    expect(stored!.supersededAt).toBeUndefined();
  });

  it('agent-version 2.12.0 (minimum-rotation) DOES rotate', async () => {
    seedToken('agent-2120');

    const res = await refreshPOST(
      refreshReq('agent-2120', 'm-1', '2.12.0'),
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(typeof body.refreshToken).toBe('string');
    expect(body.refreshToken).not.toBe('agent-2120');

    const stored = tokenStore.get(hashOf('agent-2120'));
    expect(typeof stored!.supersededAt).toBe('number');
  });

  it('agent-version 3.0.0 (future major) DOES rotate', async () => {
    seedToken('agent-3000');

    const res = await refreshPOST(
      refreshReq('agent-3000', 'm-1', '3.0.0'),
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(typeof body.refreshToken).toBe('string');
  });

  it('malformed agent-version (gibberish) falls back to legacy — no rotation', async () => {
    seedToken('agent-bogus');

    const res = await refreshPOST(
      refreshReq('agent-bogus', 'm-1', 'not-a-version'),
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.refreshToken).toBeUndefined();

    const stored = tokenStore.get(hashOf('agent-bogus'));
    expect(stored!.supersededAt).toBeUndefined();
  });

  it('agent-version 2.12.0-rc.1 (pre-release suffix on 2.12.0) DOES rotate', async () => {
    seedToken('agent-rc');

    // Strip-suffix semantics: 2.12.0-rc.1 parses as [2,12,0] which meets
    // the 2.12.0+ rotation threshold.
    const res = await refreshPOST(
      refreshReq('agent-rc', 'm-1', '2.12.0-rc.1'),
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(typeof body.refreshToken).toBe('string');
  });
});

// parseAgentVersion / shouldRotateRefreshToken — pure-helper tests

describe('parseAgentVersion + shouldRotateRefreshToken', () => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const route = require('@/app/api/agent/auth/refresh/route') as {
    parseAgentVersion: (v: unknown) => [number, number, number] | null;
    shouldRotateRefreshToken: (v: unknown) => boolean;
  };

  describe('parseAgentVersion', () => {
    it.each([
      ['2.12.0', [2, 12, 0]],
      ['2.11.3', [2, 11, 3]],
      ['3.0.0', [3, 0, 0]],
      ['2.12', [2, 12, 0]],                  // patch missing → defaults to 0
      ['2.12.0-rc.1', [2, 12, 0]],           // strips pre-release suffix
      ['2.12.0+build.123', [2, 12, 0]],      // strips build metadata
    ])('parses %s → %j', (input, expected) => {
      expect(route.parseAgentVersion(input)).toEqual(expected);
    });

    it.each([
      null,
      undefined,
      '',
      '2',
      'abc',
      '2.x.0',
      '-1.0.0',
      // Number.parseInt-tolerant inputs the strict regex MUST reject — '0junk'
      // would otherwise parse as 0 and activate rotation on a malformed header.
      '2.12.0junk',
      '2.12beta',
      '2.12.0 ',         // trailing space
      ' 2.12.0',         // leading space
      '2..0',            // empty segment
      '2.12.',           // trailing empty segment
      '2.12.0.1.2',      // too many segments
      '0x12.0.0',        // hex-style prefix
    ])(
      'returns null for malformed input %j',
      (input) => {
        expect(route.parseAgentVersion(input)).toBeNull();
      },
    );
  });

  describe('shouldRotateRefreshToken', () => {
    it.each([
      ['2.12.0', true],
      ['2.12.5', true],
      ['2.13.0', true],
      ['3.0.0', true],
      ['10.0.0', true],
    ])('rotates for %s', (input, expected) => {
      expect(route.shouldRotateRefreshToken(input)).toBe(expected);
    });

    it.each([
      ['2.11.3', false],
      ['2.11.99', false],
      ['2.0.0', false],
      ['1.99.99', false],
      [null, false],
      [undefined, false],
      ['', false],
      ['nonsense', false],
    ])('does NOT rotate for %j', (input, expected) => {
      expect(route.shouldRotateRefreshToken(input)).toBe(expected);
    });
  });
});

describe('plan gates', () => {
  it('never loads plan.server, so no plan can unpair an agent', () => {
    expect(() =>
      jest.isolateModules(() => {
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        require('@/app/api/agent/auth/refresh/route');
      }),
    ).not.toThrow();
  });
});
