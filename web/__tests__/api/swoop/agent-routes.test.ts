/**
 * @jest-environment node
 *
 * The three agent-facing swoop routes.
 *
 * The cases that matter are the refusals: machine A must not reach machine B's
 * bundle, a sid minted elsewhere must not resolve here, and a caller that is
 * not this machine's agent must not reach a bundle at all. Keys are generated
 * per run — nothing here is a real key, a real token or a real credential.
 */

import fs from 'fs';
import path from 'path';
import { generateKeyPairSync } from 'crypto';

import { createMockRequest } from '../helpers/utils';

const mockVerifyIdToken = jest.fn();

/** Path-keyed stand-in for the documents these routes read and write. */
const docs = new Map<string, Record<string, unknown>>();
const written: { path: string; data: Record<string, unknown> }[] = [];
/** Document paths whose writes throw, for the best-effort/fail-closed split. */
const failingWrites = new Set<string>();

function makeDoc(docPath: string) {
  return {
    get: async () => ({
      exists: docs.has(docPath),
      data: () => docs.get(docPath),
    }),
    set: async (data: Record<string, unknown>) => {
      if (failingWrites.has(docPath)) throw new Error('firestore down');
      written.push({ path: docPath, data });
      docs.set(docPath, data);
    },
    collection: (name: string) => makeCollection(`${docPath}/${name}`),
  };
}

let autoId = 0;
function makeCollection(collectionPath: string) {
  return {
    doc: (id?: string) => makeDoc(`${collectionPath}/${id ?? `auto-${++autoId}`}`),
  };
}

jest.mock('@/lib/firebase-admin', () => ({
  getAdminAuth: () => ({ verifyIdToken: (...args: unknown[]) => mockVerifyIdToken(...args) }),
  getAdminDb: () => ({ collection: (name: string) => makeCollection(name) }),
}));
jest.mock('@/lib/withRateLimit', () => ({ withRateLimit: (h: unknown) => h }));
jest.mock('@sentry/nextjs', () => ({ captureException: jest.fn(), captureMessage: jest.fn() }));
jest.mock('@/lib/securityBoundaryMetrics.server', () => ({
  emitSecurityBoundaryMetric: jest.fn(),
}));
jest.mock('@/lib/swoop/turn.server', () => ({
  mintTurnCredentials: jest.fn(async () => ({ ok: false, reason: 'not_configured' })),
}));

import { POST as bundlePOST } from '@/app/api/agent/swoop/bundle/route';
import { POST as doorbellPOST } from '@/app/api/agent/swoop/doorbell-token/route';
import { POST as eventsPOST } from '@/app/api/agent/swoop/events/route';
import { validateBundle, SWOOP_PROTOCOL_VERSION } from '@/lib/swoop/protocol';
import { SWOOP_MIN_AGENT_VERSION } from '@/lib/versionUtils';

const SITE = 'site-a';
const MACHINE = 'machine-a';
const OTHER_MACHINE = 'machine-b';
const SID = 'sid-1';

const settingsPath = (siteId: string) => `sites/${siteId}/settings/swoop`;
const sessionPath = (siteId: string, machineId: string, sid: string) =>
  `sites/${siteId}/machines/${machineId}/swoop_sessions/${sid}`;

function agentToken(machineId = MACHINE, siteId = SITE) {
  mockVerifyIdToken.mockResolvedValue({
    uid: `agent-${machineId}`,
    role: 'agent',
    site_id: siteId,
    machine_id: machineId,
  });
}

function enableSwoop(excluded: string[] = []) {
  docs.set(settingsPath(SITE), {
    enabled: true,
    membersMayWatch: true,
    indicator: 'banner',
    excludedMachineIds: excluded,
  });
}

function seedSession(machineId = MACHINE, sid = SID) {
  docs.set(sessionPath(SITE, machineId, sid), {
    sid,
    siteId: SITE,
    machineId,
    state: 'pending',
    createdBy: 'uid-1',
    startedAt: Date.now(),
    absoluteExpiresAt: Date.now() + 43200_000,
    viewers: [],
  });
}

function bundleRequest(overrides: Record<string, unknown> = {}) {
  return createMockRequest('http://localhost/api/agent/swoop/bundle', {
    method: 'POST',
    headers: { Authorization: 'Bearer agent-token' },
    body: {
      siteId: SITE,
      machineId: MACHINE,
      sid: SID,
      agentVersion: SWOOP_MIN_AGENT_VERSION,
      ...overrides,
    },
  });
}

beforeAll(() => {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  process.env.SWOOP_JWT_PRIVATE_KEY = privateKey
    .export({ format: 'der', type: 'pkcs8' })
    .subarray(16)
    .toString('base64url');
  process.env.SWOOP_JWT_PUBLIC_KEY = publicKey
    .export({ format: 'der', type: 'spki' })
    .subarray(12)
    .toString('base64url');
  process.env.SWOOP_JWT_KID = 'kid-current';
  process.env.SWOOP_SESSION_MASTER_KEY = 'test-master-key-not-a-real-one';
  process.env.SWOOP_SIGNAL_URL = 'https://swoop-signal.example.invalid';
  delete process.env.SWOOP_JWT_PUBLIC_KEY_PREVIOUS;
  delete process.env.SWOOP_JWT_KID_PREVIOUS;
});

beforeEach(() => {
  jest.clearAllMocks();
  docs.clear();
  written.length = 0;
  failingWrites.clear();
  enableSwoop();
  seedSession();
});

describe('POST /api/agent/swoop/doorbell-token', () => {
  it('returns the token, its kid, expiresIn and the room signalUrl', async () => {
    agentToken();
    const response = await doorbellPOST(
      createMockRequest('http://localhost/api/agent/swoop/doorbell-token', {
        method: 'POST',
        headers: { Authorization: 'Bearer agent-token' },
        body: {},
      }),
    );
    expect(response.status).toBe(200);

    const body = await response.json();
    expect(typeof body.token).toBe('string');
    expect(body.kid).toBe('kid-current');
    // Spike 0.6: the agent must not have to parse a jwt against the kiosk clock.
    expect(body.expiresIn).toBe(300);
    // Task 2.3's doorbell has no signalling origin of its own.
    expect(body.signalUrl).toBe(`wss://swoop-signal.example.invalid/v1/room/${SITE}/${MACHINE}`);
    expect(response.headers.get('cache-control')).toBe('no-store');
  });

  it('refuses a site with swoop disabled with 403 swoop_disabled', async () => {
    agentToken();
    docs.set(settingsPath(SITE), { enabled: false });

    const response = await doorbellPOST(
      createMockRequest('http://localhost/api/agent/swoop/doorbell-token', {
        method: 'POST',
        headers: { Authorization: 'Bearer agent-token' },
        body: {},
      }),
    );
    expect(response.status).toBe(403);
    expect((await response.json()).code).toBe('swoop_disabled');
  });

  it('refuses an excluded machine with 403 machine_excluded', async () => {
    agentToken();
    enableSwoop([MACHINE]);

    const response = await doorbellPOST(
      createMockRequest('http://localhost/api/agent/swoop/doorbell-token', {
        method: 'POST',
        headers: { Authorization: 'Bearer agent-token' },
        body: {},
      }),
    );
    expect(response.status).toBe(403);
    expect((await response.json()).code).toBe('machine_excluded');
  });
});

describe('POST /api/agent/swoop/bundle', () => {
  it('returns the bundle document itself, not a {bundle} envelope', async () => {
    agentToken();
    const response = await bundlePOST(bundleRequest());
    expect(response.status).toBe(200);

    const body = await response.json();
    expect(body.bundle).toBeUndefined();
    expect(body.protocolVersion).toBe(SWOOP_PROTOCOL_VERSION);

    const parsed = validateBundle(body, {
      protocolVersion: SWOOP_PROTOCOL_VERSION,
      agentVersion: SWOOP_MIN_AGENT_VERSION,
    });
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.value.site).toBe(SITE);
    expect(parsed.value.machine).toBe(MACHINE);
    expect(parsed.value.now).toBeGreaterThan(0);
    expect(parsed.value.enablement.sessionCapSeconds).toBe(43200);
    expect(parsed.value.jwtKeys).toHaveLength(1);
  });

  it('carries the previous public key during a rotation overlap', async () => {
    const previous = generateKeyPairSync('ed25519').publicKey;
    process.env.SWOOP_JWT_PUBLIC_KEY_PREVIOUS = previous
      .export({ format: 'der', type: 'spki' })
      .subarray(12)
      .toString('base64url');
    process.env.SWOOP_JWT_KID_PREVIOUS = 'kid-previous';
    try {
      agentToken();
      const body = await (await bundlePOST(bundleRequest())).json();
      expect(body.jwtKeys.map((k: { kid: string }) => k.kid)).toEqual([
        'kid-current',
        'kid-previous',
      ]);
    } finally {
      delete process.env.SWOOP_JWT_PUBLIC_KEY_PREVIOUS;
      delete process.env.SWOOP_JWT_KID_PREVIOUS;
    }
  });

  it("returns 404 when machine A's token requests machine B's bundle", async () => {
    agentToken(MACHINE);
    seedSession(OTHER_MACHINE);

    const response = await bundlePOST(bundleRequest({ machineId: OTHER_MACHINE }));
    expect(response.status).toBe(404);
  });

  it('returns 404 for a sid minted for another machine', async () => {
    agentToken(MACHINE);
    docs.delete(sessionPath(SITE, MACHINE, SID));
    seedSession(OTHER_MACHINE, SID);

    const response = await bundlePOST(bundleRequest());
    expect(response.status).toBe(404);
    expect((await response.json()).code).toBe('session_not_found');
  });

  it('returns 404 for a session-cookie caller with no agent token', async () => {
    mockVerifyIdToken.mockRejectedValue(new Error('not an id token'));

    const response = await bundlePOST(
      createMockRequest('http://localhost/api/agent/swoop/bundle', {
        method: 'POST',
        headers: { cookie: 'session=a-signed-session-cookie' },
        body: {
          siteId: SITE,
          machineId: MACHINE,
          sid: SID,
          agentVersion: SWOOP_MIN_AGENT_VERSION,
        },
      }),
    );
    expect(response.status).toBe(404);
  });

  it('returns 404 for a user id token that is not an agent', async () => {
    mockVerifyIdToken.mockResolvedValue({ uid: 'uid-1', role: 'user' });
    expect((await bundlePOST(bundleRequest())).status).toBe(404);
  });

  it('returns 404 for an api key', async () => {
    const response = await bundlePOST(
      createMockRequest('http://localhost/api/agent/swoop/bundle', {
        method: 'POST',
        headers: { Authorization: 'Bearer owk_live_notarealkey' },
        body: {
          siteId: SITE,
          machineId: MACHINE,
          sid: SID,
          agentVersion: SWOOP_MIN_AGENT_VERSION,
        },
      }),
    );
    expect(response.status).toBe(404);
    expect(mockVerifyIdToken).not.toHaveBeenCalled();
  });

  it('refuses a site with swoop disabled', async () => {
    agentToken();
    docs.set(settingsPath(SITE), { enabled: false });
    const response = await bundlePOST(bundleRequest());
    expect(response.status).toBe(403);
    expect((await response.json()).code).toBe('swoop_disabled');
  });

  it('refuses an agent older than the minimum swoop version', async () => {
    agentToken();
    const response = await bundlePOST(bundleRequest({ agentVersion: '3.3.5' }));
    expect(response.status).toBe(403);
    expect((await response.json()).code).toBe('agent_too_old');
  });

  it('serves a 3.3.7 agent, the first installer that ships the streamer', async () => {
    // the literal, not the constant: the other bundle tests send the constant
    // itself, which is how a floor above the fielded agents passed unnoticed.
    agentToken();
    const response = await bundlePOST(bundleRequest({ agentVersion: '3.3.7' }));
    expect(response.status).toBe(200);
  });
});

describe('POST /api/agent/swoop/events', () => {
  function eventsRequest(body: Record<string, unknown>) {
    return createMockRequest('http://localhost/api/agent/swoop/events', {
      method: 'POST',
      headers: { Authorization: 'Bearer agent-token' },
      body,
    });
  }

  it("writes an audit_log row with outcome 'deny' for a host denial event", async () => {
    agentToken();
    const response = await eventsPOST(
      eventsRequest({
        siteId: SITE,
        machineId: MACHINE,
        events: [
          {
            type: 'input_not_permitted',
            sid: SID,
            viewerId: 'viewer-1',
            uid: 'uid-1',
            reason: 'ctl_missing',
          },
        ],
      }),
    );
    expect(response.status).toBe(202);
    expect(await response.json()).toEqual({ recorded: 1 });

    const rows = written.filter((w) => w.path.startsWith(`sites/${SITE}/audit_log/`));
    expect(rows).toHaveLength(1);
    expect(rows[0].data.outcome).toBe('deny');
    expect(rows[0].data.denyReason).toBe('ctl_missing');
    expect(rows[0].data.actor).toEqual({ type: 'system', name: 'swoop_host' });
    expect(rows[0].data.metadata).toMatchObject({
      event: 'input_not_permitted',
      sid: SID,
      viewerId: 'viewer-1',
    });
  });

  it('records an admission refusal, which only the streamer can witness', async () => {
    agentToken();
    const response = await eventsPOST(
      eventsRequest({
        siteId: SITE,
        machineId: MACHINE,
        events: [{ type: 'join_refused', sid: SID, viewerId: 'viewer-1', reason: 'join_too_soon' }],
      }),
    );
    expect(response.status).toBe(202);
    const rows = written.filter((w) => w.path.startsWith(`sites/${SITE}/audit_log/`));
    expect(rows).toHaveLength(1);
    expect(rows[0].data.outcome).toBe('deny');
    expect(rows[0].data.denyReason).toBe('join_too_soon');
    expect(rows[0].data.metadata).toMatchObject({ event: 'join_refused', sid: SID });
  });

  it('records a lifecycle event as an allow', async () => {
    agentToken();
    const response = await eventsPOST(
      eventsRequest({
        siteId: SITE,
        machineId: MACHINE,
        events: [{ type: 'session_ended', sid: SID, reason: 'idle' }],
      }),
    );
    expect(response.status).toBe(202);
    const rows = written.filter((w) => w.path.startsWith(`sites/${SITE}/audit_log/`));
    expect(rows[0].data.outcome).toBe('allow');
    expect(rows[0].data.denyReason).toBeUndefined();
  });

  /**
   * The streamer is the only thing that sees a session stop, so without this
   * mirror the record never leaves `pending`: it answers as live to the
   * revocation sweep for as long as the document exists.
   */
  describe('the session record it mirrors', () => {
    const SESSION = sessionPath(SITE, MACHINE, SID);

    /** The mirrored write, if the route made one. */
    function recordWrite(): Record<string, unknown> | undefined {
      return written.find((w) => w.path === SESSION)?.data;
    }

    it("closes the record on session_ended, keeping the streamer's own reason", async () => {
      agentToken();
      const response = await eventsPOST(
        eventsRequest({
          siteId: SITE,
          machineId: MACHINE,
          events: [{ type: 'session_ended', sid: SID, reason: 'idle' }],
        }),
      );

      expect(response.status).toBe(202);
      expect(recordWrite()).toMatchObject({ state: 'ended', endReason: 'idle', viewers: [] });
    });

    it('records host_exit when the streamer names no reason we know', async () => {
      agentToken();
      await eventsPOST(
        eventsRequest({
          siteId: SITE,
          machineId: MACHINE,
          events: [{ type: 'session_ended', sid: SID, reason: 'something_new' }],
        }),
      );

      expect(recordWrite()).toMatchObject({ state: 'ended', endReason: 'host_exit' });
    });

    it('moves a pending record to live on session_started', async () => {
      agentToken();
      await eventsPOST(
        eventsRequest({
          siteId: SITE,
          machineId: MACHINE,
          events: [{ type: 'session_started', sid: SID }],
        }),
      );

      expect(recordWrite()).toMatchObject({ state: 'live' });
    });

    it('drops a viewer who left, so the row does not outlive them', async () => {
      agentToken();
      docs.set(SESSION, {
        ...(docs.get(SESSION) as Record<string, unknown>),
        viewers: [
          { viewerId: 'viewer-1', uid: 'uid-1', ctl: false, joinedAt: 1, leaseExpiresAt: 2 },
          { viewerId: 'viewer-2', uid: 'uid-2', ctl: false, joinedAt: 1, leaseExpiresAt: 2 },
        ],
      });

      await eventsPOST(
        eventsRequest({
          siteId: SITE,
          machineId: MACHINE,
          events: [{ type: 'viewer_left', sid: SID, viewerId: 'viewer-1', reason: 'bye' }],
        }),
      );

      expect(recordWrite()?.viewers).toEqual([
        { viewerId: 'viewer-2', uid: 'uid-2', ctl: false, joinedAt: 1, leaseExpiresAt: 2 },
      ]);
    });

    /**
     * The store merges, so a write for a sid with no document CREATES one — the
     * host would be able to grow the collection the retention sweep just
     * drained, one event at a time.
     */
    it('never re-creates a session the sweep has already removed', async () => {
      agentToken();
      docs.delete(SESSION);

      const response = await eventsPOST(
        eventsRequest({
          siteId: SITE,
          machineId: MACHINE,
          events: [{ type: 'session_ended', sid: SID, reason: 'idle' }],
        }),
      );

      expect(response.status).toBe(202);
      expect(recordWrite()).toBeUndefined();
    });

    it('leaves an already-ended record alone rather than restating why it ended', async () => {
      agentToken();
      docs.set(SESSION, {
        ...(docs.get(SESSION) as Record<string, unknown>),
        state: 'ended',
        endReason: 'killed',
      });

      await eventsPOST(
        eventsRequest({
          siteId: SITE,
          machineId: MACHINE,
          events: [{ type: 'session_ended', sid: SID, reason: 'idle' }],
        }),
      );

      expect(recordWrite()).toBeUndefined();
    });

    /**
     * The audit row is what this endpoint promises and is fail-closed; the
     * mirror is not. A 503 here would have the agent re-post the batch and
     * duplicate the rows, to fix a record the 12-hour cap and the retention
     * sweep both close anyway.
     */
    it('still records the audit row when the mirror cannot be written', async () => {
      agentToken();
      failingWrites.add(SESSION);

      const response = await eventsPOST(
        eventsRequest({
          siteId: SITE,
          machineId: MACHINE,
          events: [{ type: 'session_ended', sid: SID, reason: 'idle' }],
        }),
      );

      expect(response.status).toBe(202);
      expect(written.filter((w) => w.path.startsWith(`sites/${SITE}/audit_log/`))).toHaveLength(1);
    });

    it('leaves the record untouched for an event that is not a lifecycle one', async () => {
      agentToken();
      await eventsPOST(
        eventsRequest({
          siteId: SITE,
          machineId: MACHINE,
          events: [{ type: 'jwt_rejected', sid: SID, reason: 'unknown_kid' }],
        }),
      );

      expect(recordWrite()).toBeUndefined();
    });
  });

  it('refuses an unrecognised event type and writes nothing', async () => {
    agentToken();
    const response = await eventsPOST(
      eventsRequest({
        siteId: SITE,
        machineId: MACHINE,
        events: [{ type: 'arbitrary_row', sid: SID }],
      }),
    );
    expect(response.status).toBe(400);
    expect(written).toHaveLength(0);
  });

  // `constructor` satisfies both the type vocabulary and the reason pattern on
  // the prototype chain, so a lookup that is not own-property-checked answers
  // with Object itself rather than refusing.
  it.each(['constructor', 'valueOf', '__proto__'])(
    'refuses %s as an event type',
    async (type) => {
      agentToken();
      const response = await eventsPOST(
        eventsRequest({ siteId: SITE, machineId: MACHINE, events: [{ type, sid: SID }] }),
      );
      expect(response.status).toBe(400);
      expect(written).toHaveLength(0);
    },
  );

  it('records host_exit rather than Object for a reason named constructor', async () => {
    agentToken();
    await eventsPOST(
      eventsRequest({
        siteId: SITE,
        machineId: MACHINE,
        events: [{ type: 'session_ended', sid: SID, reason: 'constructor' }],
      }),
    );

    const record = written.find((w) => w.path === sessionPath(SITE, MACHINE, SID));
    expect(record?.data).toMatchObject({ state: 'ended', endReason: 'host_exit' });
  });

  it("returns 404 when machine A reports events against machine B", async () => {
    agentToken(MACHINE);
    const response = await eventsPOST(
      eventsRequest({
        siteId: SITE,
        machineId: OTHER_MACHINE,
        events: [{ type: 'jwt_rejected', sid: SID }],
      }),
    );
    expect(response.status).toBe(404);
    expect(written).toHaveLength(0);
  });
});

describe('route sources', () => {
  const ROOT = path.resolve(__dirname, '..', '..', '..', 'app', 'api', 'agent', 'swoop');
  const SOURCES = [
    '_shared.ts',
    'bundle/route.ts',
    'doorbell-token/route.ts',
    'events/route.ts',
  ];

  it.each(SOURCES)('%s binds machine_id, never site_id alone', (relative) => {
    const source = fs.readFileSync(path.join(ROOT, ...relative.split('/')), 'utf8');
    // Both helpers check `site_id` only, so either one would let machine A's
    // token reach machine B.
    expect(source).not.toContain('requireAgentOrSiteScope');
    expect(source).not.toContain('requireAgentOrSiteAuthAndScope');
  });

  it('authenticates through requireMachineAuthAndScope', () => {
    const shared = fs.readFileSync(path.join(ROOT, '_shared.ts'), 'utf8');
    expect(shared).toContain('requireMachineAuthAndScope');
    for (const relative of SOURCES.filter((s) => s !== '_shared.ts')) {
      const source = fs.readFileSync(path.join(ROOT, ...relative.split('/')), 'utf8');
      expect(source).toContain('requireSwoopAgent');
    }
  });
});
