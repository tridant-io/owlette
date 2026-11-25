/** @jest-environment node */

const mockCreate = jest.fn();
const mockAfter = jest.fn();
let mockPath: string[] = [];
// a chainable stand-in for getAdminDb() that records the collection/doc path it is walked down
const mockGetAdminDb = jest.fn(() => {
  mockPath = [];
  const ref = {
    collection: (name: string) => (mockPath.push(name), ref),
    doc: (id?: string) => (mockPath.push(id ?? '<auto id>'), ref),
    create: mockCreate,
  };
  return ref;
});

jest.mock('@/lib/firebase-admin', () => ({ getAdminDb: () => mockGetAdminDb() }));
jest.mock('firebase-admin/firestore', () => ({ FieldValue: { serverTimestamp: () => 'SERVER_TS' } }));
jest.mock('next/server', () => ({ after: (task: unknown) => mockAfter(task) }));

import {
  scopeFingerprint,
  emitApiKeyUsed,
  emitMutation,
  type MutationKind,
} from '@/lib/auditLogClient';

describe('scopeFingerprint', () => {
  it('returns "legacy" for null scopes', () => {
    expect(scopeFingerprint(null)).toBe('legacy');
  });

  it('returns "legacy" for empty scopes', () => {
    expect(scopeFingerprint([])).toBe('legacy');
  });

  it('produces a 12-char hex string for scoped keys', () => {
    const fp = scopeFingerprint([
      { resource: 'site', id: 's1', permissions: ['write'] },
    ]);
    expect(fp).toMatch(/^[0-9a-f]{12}$/);
  });

  it('is stable across scope reordering', () => {
    const a = scopeFingerprint([
      { resource: 'site', id: 's1', permissions: ['write', 'read'] },
      { resource: 'roost', id: 'r1', permissions: ['deploy'] },
    ]);
    const b = scopeFingerprint([
      { resource: 'roost', id: 'r1', permissions: ['deploy'] },
      { resource: 'site', id: 's1', permissions: ['read', 'write'] },
    ]);
    expect(a).toBe(b);
  });

  it('differs for different scope sets', () => {
    const a = scopeFingerprint([
      { resource: 'site', id: 's1', permissions: ['read'] },
    ]);
    const b = scopeFingerprint([
      { resource: 'site', id: 's1', permissions: ['write'] },
    ]);
    expect(a).not.toBe(b);
  });
});

describe('audit emitters', () => {
  const originalWarn = console.warn;
  const realAfter = jest.requireActual<typeof import('next/server')>('next/server').after;

  const apiKeyEvent = {
    siteId: 'site-a',
    keyId: 'key-1',
    scopeFingerprint: 'abc123',
    environment: 'live' as const,
    endpoint: '/api/chunks/check',
    method: 'POST',
    isLegacy: false,
  };

  /** the one queue write the emit made: its path and data. */
  async function queued() {
    await new Promise((r) => setImmediate(r));
    expect(mockCreate).toHaveBeenCalledTimes(1);
    return { path: mockPath, data: mockCreate.mock.calls[0][0] };
  }

  beforeEach(() => {
    mockCreate.mockResolvedValue({});
    mockAfter.mockImplementation(realAfter);
    console.warn = jest.fn();
  });

  afterEach(() => {
    console.warn = originalWarn;
  });

  it('queues api_key_used under the site with a server timestamp', async () => {
    emitApiKeyUsed(apiKeyEvent);
    const { path, data } = await queued();
    expect(path).toEqual(['sites', 'site-a', 'audit_queue', '<auto id>']);
    expect(data.enqueuedAt).toBe('SERVER_TS');
    expect(data.event).toEqual({
      kind: 'api_key_used',
      siteId: 'site-a',
      actor: 'apiKey:key-1',
      occurredAt: expect.any(Number),
      attributes: {
        keyId: 'key-1',
        scopeFingerprint: 'abc123',
        environment: 'live',
        endpoint: '/api/chunks/check',
        method: 'POST',
        isLegacy: false,
      },
    });
  });

  it.each<MutationKind>([
    'api_key_mutated',
    'chunk_mutated',
    'deployment_mutated',
    'distribution_mutated',
    'process_mutated',
    'roost_mutated',
    'machine_command_dispatched',
    'user_mutated',
    'site_mutated',
    'site_member_mutated',
    'installer_mutated',
    'webhook_mutated',
    'chat_mutated',
    'billing_mutated',
    'talon_mutated',
  ])('queues a %s event with kind, actor, target, and attributes', async (kind) => {
    emitMutation({
      kind,
      siteId: 'site-a',
      actor: 'apiKey:key-1',
      targetId: 'tgt_abc',
      attributes: { endpoint: '/api/test', method: 'POST', sample: true },
    });
    const { data } = await queued();
    expect(data.event).toEqual({
      kind,
      siteId: 'site-a',
      actor: 'apiKey:key-1',
      occurredAt: expect.any(Number),
      target: 'tgt_abc',
      attributes: { endpoint: '/api/test', method: 'POST', sample: true },
    });
  });

  it('queues an empty siteId under the platform audit site id, keeping the event as sent', async () => {
    emitMutation({
      kind: 'installer_mutated',
      siteId: '',
      actor: 'user:uid_super',
      targetId: '2.10.0',
      attributes: { verb: 'set-latest' },
    });
    const { path, data } = await queued();
    expect(path).toEqual(['sites', '_platform', 'audit_queue', '<auto id>']);
    expect(data.event.siteId).toBe('');
  });

  it('drops undefined attributes, as the json body used to', async () => {
    emitMutation({
      kind: 'process_mutated',
      siteId: 'site-a',
      actor: 'user:u1',
      targetId: 'p_1',
      attributes: { reason: undefined, verb: 'stop' },
    });
    const { data } = await queued();
    expect(data.event.attributes).toEqual({ verb: 'stop' });
  });

  it('returns before the write settles', () => {
    mockCreate.mockReturnValue(new Promise(() => {}));
    expect(emitApiKeyUsed(apiKeyEvent)).toBeUndefined();
  });

  it('hands the write to after() inside a request scope', async () => {
    let settled = false;
    mockCreate.mockReturnValue(new Promise((r) => setImmediate(() => { settled = true; r({}); })));
    mockAfter.mockImplementation(() => undefined);
    emitApiKeyUsed(apiKeyEvent);
    expect(mockAfter).toHaveBeenCalledTimes(1);
    await mockAfter.mock.calls[0][0];
    expect(settled).toBe(true);
  });

  it('still writes outside a request scope, where after() throws', async () => {
    expect(() => realAfter(Promise.resolve())).toThrow(/outside a request scope/);
    expect(() => emitApiKeyUsed(apiKeyEvent)).not.toThrow();
    await queued();
  });

  describe('retrying the queue write', () => {
    const failure = (code: number) => Object.assign(new Error(`firestore code ${code}`), { code });

    /** the write handed to after(), awaited until its last attempt settles */
    async function written() {
      expect(mockAfter).toHaveBeenCalledTimes(1);
      await mockAfter.mock.calls[0][0];
    }

    beforeEach(() => {
      mockAfter.mockImplementation(() => undefined);
    });

    it('retries a transient failure with the same doc and payload, then lands', async () => {
      mockCreate.mockRejectedValueOnce(failure(14)).mockResolvedValueOnce({});
      emitApiKeyUsed(apiKeyEvent);
      await written();
      expect(mockCreate).toHaveBeenCalledTimes(2);
      expect(mockCreate.mock.calls[1][0]).toBe(mockCreate.mock.calls[0][0]);
      expect(mockGetAdminDb).toHaveBeenCalledTimes(1);
      expect(console.warn).not.toHaveBeenCalled();
    });

    it('takes ALREADY_EXISTS on a retry as the earlier attempt having landed', async () => {
      mockCreate.mockRejectedValueOnce(failure(4)).mockRejectedValueOnce(failure(6));
      emitApiKeyUsed(apiKeyEvent);
      await written();
      expect(mockCreate).toHaveBeenCalledTimes(2);
      expect(console.warn).not.toHaveBeenCalled();
    });

    it('logs the event as dropped after the third transient failure', async () => {
      mockCreate.mockRejectedValue(failure(14));
      emitApiKeyUsed(apiKeyEvent);
      await written();
      expect(mockCreate).toHaveBeenCalledTimes(3);
      expect(console.warn).toHaveBeenCalledWith(expect.stringContaining('DROPPED'));
    });

    it('does not retry a failure that is not transient', async () => {
      mockCreate.mockRejectedValue(failure(3));
      emitApiKeyUsed(apiKeyEvent);
      await written();
      expect(mockCreate).toHaveBeenCalledTimes(1);
      expect(console.warn).toHaveBeenCalledWith(expect.stringContaining('DROPPED'));
    });
  });

  it('never throws and logs when the write fails', async () => {
    mockCreate.mockRejectedValue(new Error('unavailable'));
    expect(() => emitApiKeyUsed(apiKeyEvent)).not.toThrow();
    await new Promise((r) => setImmediate(r));
    expect(console.warn).toHaveBeenCalledWith(expect.stringContaining('unavailable'));
  });

  it('never throws and logs when the admin sdk is not initialised', async () => {
    mockGetAdminDb.mockImplementationOnce(() => {
      throw new Error('Firebase Admin SDK not initialized');
    });
    expect(() => emitMutation({
      kind: 'deployment_mutated',
      siteId: 'site-a',
      actor: 'apiKey:key-1',
      targetId: 'dep_abc',
      attributes: {},
    })).not.toThrow();
    await new Promise((r) => setImmediate(r));
    expect(console.warn).toHaveBeenCalledWith(expect.stringContaining('not initialized'));
  });
});
