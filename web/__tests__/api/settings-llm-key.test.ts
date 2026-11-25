/** @jest-environment node */

/**
 * Audit coverage for /api/settings/llm-key (talons wave 5.4).
 *
 * POST stores the caller's encrypted user-level LLM key, DELETE removes it —
 * both platform-tenant `user_mutated` rows (`llm_key_stored` / `llm_key_removed`),
 * the same pairing as `passkey_added` / `passkey_removed`. Neither the plaintext
 * key nor its ciphertext may reach the row; GET mutates nothing and audits
 * nothing.
 */

import { NextRequest } from 'next/server';

jest.mock('@sentry/nextjs', () => ({
  captureException: jest.fn(),
  captureMessage: jest.fn(),
}));

jest.mock('@/lib/withRateLimit', () => ({
  __esModule: true,
  withRateLimit: (handler: unknown) => handler,
}));

jest.mock('firebase-admin/firestore', () => ({
  __esModule: true,
  FieldValue: { serverTimestamp: () => '__SERVER_TS__' },
}));

const mockRequireSession = jest.fn();
const mockAssertActiveUser = jest.fn();
jest.mock('@/lib/apiAuth.server', () => {
  const actual = jest.requireActual('@/lib/apiAuth.server');
  return {
    ...actual,
    requireSession: (...a: unknown[]) => mockRequireSession(...a),
    assertActiveUser: (...a: unknown[]) => mockAssertActiveUser(...a),
  };
});

const mockIsConfigured = jest.fn();
jest.mock('@/lib/llm-encryption.server', () => ({
  encryptApiKey: (v: string) => `enc(${v})`,
  isLlmEncryptionConfigured: () => mockIsConfigured(),
}));

jest.mock('@/lib/auditLogClient', () => ({
  emitMutation: jest.fn(),
}));

const USER = 'user-1';
const RAW_KEY = 'sk-ant-super-secret-value';

const mockSettingsSet = jest.fn();
const mockSettingsDelete = jest.fn();
const mockSettingsGet = jest.fn();

const fakeDb = {
  collection: (name: string) => {
    if (name !== 'users') throw new Error(`unexpected collection: ${name}`);
    return {
      doc: () => ({
        collection: () => ({
          doc: () => ({
            set: mockSettingsSet,
            delete: mockSettingsDelete,
            get: mockSettingsGet,
          }),
        }),
      }),
    };
  },
};

jest.mock('@/lib/firebase-admin', () => ({
  getAdminDb: () => fakeDb,
}));

import { POST, GET, DELETE, PATCH } from '@/app/api/settings/llm-key/route';
import { emitMutation } from '@/lib/auditLogClient';

function request(method: string, body?: Record<string, unknown>): NextRequest {
  return new NextRequest('http://localhost/api/settings/llm-key', {
    method,
    ...(body
      ? { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }
      : {}),
  });
}

function soleAudit() {
  expect(emitMutation).toHaveBeenCalledTimes(1);
  return (emitMutation as jest.Mock).mock.calls[0][0] as {
    kind: string;
    siteId: string;
    actor: string;
    targetId: string;
    attributes: Record<string, unknown>;
  };
}

beforeEach(() => {
  jest.clearAllMocks();
  mockRequireSession.mockResolvedValue(USER);
  mockAssertActiveUser.mockResolvedValue({});
  mockIsConfigured.mockReturnValue(true);
  mockSettingsSet.mockResolvedValue(undefined);
  mockSettingsDelete.mockResolvedValue(undefined);
  mockSettingsGet.mockResolvedValue({ exists: false });
});

describe('POST /api/settings/llm-key — audit', () => {
  it('emits user_mutated/llm_key_stored naming the provider, never the key', async () => {
    const res = await POST(
      request('POST', { provider: 'anthropic', apiKey: RAW_KEY, model: 'claude-x' }),
    );
    expect(res.status).toBe(200);
    expect(mockSettingsSet).toHaveBeenCalledTimes(1);

    const audit = soleAudit();
    expect(audit.kind).toBe('user_mutated');
    // Platform tenant — this key belongs to the account, not a site.
    expect(audit.siteId).toBe('');
    expect(audit.actor).toBe(`user:${USER}`);
    expect(audit.targetId).toBe(USER);
    expect(audit.attributes).toEqual({
      verb: 'llm_key_stored',
      endpoint: '/api/settings/llm-key',
      method: 'POST',
      provider: 'anthropic',
      model: 'claude-x',
    });

    // Negative control: the plaintext key AND the ciphertext actually written.
    const serialized = JSON.stringify(audit);
    expect(serialized).not.toContain(RAW_KEY);
    expect(serialized).not.toContain(
      (mockSettingsSet.mock.calls[0][0] as { apiKeyEncrypted: string }).apiKeyEncrypted,
    );
  });

  it('records a null model when none was supplied', async () => {
    await POST(request('POST', { provider: 'openai', apiKey: RAW_KEY }));
    expect(soleAudit().attributes).toMatchObject({ provider: 'openai', model: null });
  });

  it('emits nothing when the provider is rejected', async () => {
    const res = await POST(request('POST', { provider: 'nope', apiKey: RAW_KEY }));
    expect(res.status).toBe(400);
    expect(mockSettingsSet).not.toHaveBeenCalled();
    expect(emitMutation).not.toHaveBeenCalled();
  });

  it('emits nothing when server-side encryption is unconfigured', async () => {
    mockIsConfigured.mockReturnValue(false);

    const res = await POST(request('POST', { provider: 'anthropic', apiKey: RAW_KEY }));
    expect(res.status).toBe(500);
    expect(emitMutation).not.toHaveBeenCalled();
  });
});

describe('DELETE /api/settings/llm-key — audit', () => {
  it('emits user_mutated/llm_key_removed', async () => {
    const res = await DELETE(request('DELETE'));
    expect(res.status).toBe(200);
    expect(mockSettingsDelete).toHaveBeenCalledTimes(1);

    expect(emitMutation).toHaveBeenCalledWith({
      kind: 'user_mutated',
      siteId: '',
      actor: `user:${USER}`,
      targetId: USER,
      attributes: {
        verb: 'llm_key_removed',
        endpoint: '/api/settings/llm-key',
        method: 'DELETE',
      },
    });
  });

  it('emits nothing when the session is rejected', async () => {
    const { ApiAuthError } = jest.requireActual('@/lib/apiAuth.server');
    mockRequireSession.mockRejectedValue(new ApiAuthError(401, 'Unauthorized'));

    const res = await DELETE(request('DELETE'));
    expect(res.status).toBe(401);
    expect(mockSettingsDelete).not.toHaveBeenCalled();
    expect(emitMutation).not.toHaveBeenCalled();
  });
});

describe('GET /api/settings/llm-key', () => {
  it('audits nothing — it reads and never returns the key', async () => {
    mockSettingsGet.mockResolvedValue({
      exists: true,
      data: () => ({ provider: 'anthropic', model: 'claude-x', apiKeyEncrypted: 'enc(x)' }),
    });

    const res = await GET(request('GET'));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({
      configured: true,
      provider: 'anthropic',
      model: 'claude-x',
      updatedAt: null,
    });
    expect(emitMutation).not.toHaveBeenCalled();
  });
});

// changing the model must not ask for the key again: it is stored, encrypted,
// and the model is a separate field on the same doc.
describe('PATCH /api/settings/llm-key — model only', () => {
  const stored = { provider: 'anthropic', apiKeyEncrypted: 'enc(sk-ant-stored)', model: 'claude-old' };

  it('changes the model and leaves the stored key and provider alone', async () => {
    mockSettingsGet.mockResolvedValue({ exists: true, data: () => stored });
    const res = await PATCH(request('PATCH', { model: 'claude-new' }));
    expect(res.status).toBe(200);

    expect(mockSettingsSet).toHaveBeenCalledTimes(1);
    const [written, options] = mockSettingsSet.mock.calls[0] as [Record<string, unknown>, unknown];
    expect(written).toEqual({ model: 'claude-new', updatedAt: '__SERVER_TS__' });
    expect(options).toEqual({ merge: true });

    expect(soleAudit().attributes).toEqual({
      verb: 'llm_model_changed',
      endpoint: '/api/settings/llm-key',
      method: 'PATCH',
      provider: 'anthropic',
      model: 'claude-new',
    });
  });

  it('refuses when no key is stored: a model alone has nothing to run on', async () => {
    const res = await PATCH(request('PATCH', { model: 'claude-new' }));
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ code: 'no_key' });
    expect(mockSettingsSet).not.toHaveBeenCalled();
    expect(emitMutation).not.toHaveBeenCalled();
  });

  it('refuses a missing or empty model', async () => {
    mockSettingsGet.mockResolvedValue({ exists: true, data: () => stored });
    for (const body of [{}, { model: '' }, { model: 42 }]) {
      const res = await PATCH(request('PATCH', body));
      expect(res.status).toBe(400);
    }
    expect(mockSettingsSet).not.toHaveBeenCalled();
  });
});
