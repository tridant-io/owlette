/**
 * @jest-environment node
 *
 * POST /api/agent/hoot/key — a machine's agent fetches the LLM key that
 * /api/hoot/provision-key queued for it.
 *
 * The cases that matter are the refusals: only the token of the machine the key
 * was queued for gets it, once. Nothing here is a real key or a real token.
 */

import { createMockRequest } from './helpers/utils';

const mockVerifyIdToken = jest.fn();

/** Path-keyed stand-in for the documents the route reads and deletes. */
const docs = new Map<string, Record<string, unknown>>();

function makeDoc(docPath: string) {
  return {
    get: async () => ({ exists: docs.has(docPath), data: () => docs.get(docPath) }),
    delete: async () => {
      docs.delete(docPath);
    },
    collection: (name: string) => makeCollection(`${docPath}/${name}`),
  };
}

function makeCollection(collectionPath: string) {
  return { doc: (id: string) => makeDoc(`${collectionPath}/${id}`) };
}

jest.mock('@/lib/firebase-admin', () => ({
  getAdminAuth: () => ({ verifyIdToken: (...args: unknown[]) => mockVerifyIdToken(...args) }),
  getAdminDb: () => ({ collection: (name: string) => makeCollection(name) }),
}));
jest.mock('@/lib/withRateLimit', () => ({ withRateLimit: (h: unknown) => h }));
jest.mock('@sentry/nextjs', () => ({ captureException: jest.fn(), captureMessage: jest.fn() }));

import { POST } from '@/app/api/agent/hoot/key/route';
import { encryptApiKey } from '@/lib/llm-encryption.server';

const SITE = 'site-a';
const OTHER_SITE = 'site-b';
const MACHINE = 'machine-a';
const OTHER_MACHINE = 'machine-b';
const KEY_ID = 'key-1';
const RAW_KEY = 'sk-ant-not-a-real-key';

const keyPath = (siteId: string, machineId: string, keyId = KEY_ID) =>
  `sites/${siteId}/machines/${machineId}/hoot_key_handoffs/${keyId}`;

function agentToken(machineId = MACHINE, siteId = SITE) {
  mockVerifyIdToken.mockResolvedValue({
    uid: `agent-${machineId}`,
    role: 'agent',
    site_id: siteId,
    machine_id: machineId,
  });
}

function keyRequest(overrides: Record<string, unknown> = {}, headers?: Record<string, string>) {
  return createMockRequest('http://localhost/api/agent/hoot/key', {
    method: 'POST',
    headers: headers ?? { Authorization: 'Bearer agent-token' },
    body: { siteId: SITE, machineId: MACHINE, keyId: KEY_ID, ...overrides },
  });
}

beforeAll(() => {
  process.env.LLM_ENCRYPTION_KEY = 'test-llm-encryption-key-not-a-real-one';
});

afterAll(() => {
  delete process.env.LLM_ENCRYPTION_KEY;
});

beforeEach(() => {
  jest.clearAllMocks();
  docs.clear();
  docs.set(keyPath(SITE, MACHINE), { apiKeyEncrypted: encryptApiKey(RAW_KEY) });
});

describe('POST /api/agent/hoot/key', () => {
  it("hands the machine's own agent its key, uncached, once", async () => {
    agentToken();

    const response = await POST(keyRequest());
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ apiKey: RAW_KEY });
    expect(response.headers.get('cache-control')).toBe('no-store');

    expect(docs.has(keyPath(SITE, MACHINE))).toBe(false);
    expect((await POST(keyRequest())).status).toBe(404);
  });

  it("refuses another machine's token naming this machine, and keeps the key", async () => {
    agentToken(OTHER_MACHINE);

    const response = await POST(keyRequest());
    expect(response.status).toBe(404);
    expect(JSON.stringify(await response.json())).not.toContain(RAW_KEY);
    expect(docs.has(keyPath(SITE, MACHINE))).toBe(true);
  });

  it("finds nothing for another machine's token naming its own machine", async () => {
    agentToken(OTHER_MACHINE);

    const response = await POST(keyRequest({ machineId: OTHER_MACHINE }));
    expect(response.status).toBe(404);
    expect(docs.has(keyPath(SITE, MACHINE))).toBe(true);
  });

  it("refuses another site's token for the same machine id", async () => {
    agentToken(MACHINE, OTHER_SITE);

    const response = await POST(keyRequest());
    expect(response.status).toBe(404);
    expect(docs.has(keyPath(SITE, MACHINE))).toBe(true);
  });

  it('refuses a user id token', async () => {
    mockVerifyIdToken.mockResolvedValue({ uid: 'uid-1', role: 'user' });
    expect((await POST(keyRequest())).status).toBe(404);
  });

  it('refuses a session-cookie caller with no agent token', async () => {
    mockVerifyIdToken.mockRejectedValue(new Error('not an id token'));
    const response = await POST(keyRequest({}, { cookie: 'session=a-signed-session-cookie' }));
    expect(response.status).toBe(404);
  });

  it('refuses an api key without verifying it as an id token', async () => {
    const response = await POST(keyRequest({}, { Authorization: 'Bearer owk_live_notarealkey' }));
    expect(response.status).toBe(404);
    expect(mockVerifyIdToken).not.toHaveBeenCalled();
  });

  it('answers 400 for a key id that is not one segment', async () => {
    agentToken();
    expect((await POST(keyRequest({ keyId: '../other' }))).status).toBe(400);
    expect((await POST(keyRequest({ keyId: undefined }))).status).toBe(400);
  });
});
