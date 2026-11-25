/** @jest-environment node */

/**
 * Unit tests for `web/lib/auditLog.server.ts`, driven through a hand-rolled
 * `getAdminDb` mock covering the set/doc/collection surface the writer touches.
 * The assertions are emulator-portable, so this can move onto
 * `__tests__/rules/harness.ts` unchanged.
 */

import {
  generateCorrelationId,
  writeAuditEntry,
  writeAuditEntryBlocking,
  cleanupExpiredAuditEntries,
  type AuditEntryInput,
  type Capability,
  type AuditActor,
} from '@/lib/auditLog.server';

// mocks

// Capture every .set() with its path so tests can assert site, collection and
// payload shape.
type SetCall = { path: string; payload: Record<string, unknown> };
const setCalls: SetCall[] = [];
let setShouldReject: Error | null = null;

const auditDocId = 'test-entry-id';

jest.mock('@/lib/firebase-admin', () => ({
  getAdminDb: () => ({
    collection: (top: string) => makeCollection(top),
  }),
}));

function makeCollection(path: string): unknown {
  return {
    doc: (id?: string) => makeDoc(`${path}/${id ?? auditDocId}`),
  };
}

function makeDoc(path: string): unknown {
  return {
    collection: (sub: string) => makeCollection(`${path}/${sub}`),
    set: (payload: Record<string, unknown>) => {
      if (setShouldReject) return Promise.reject(setShouldReject);
      setCalls.push({ path, payload });
      return Promise.resolve();
    },
  };
}

// Sentinel so a serverTimestamp() field-value is recognisable without depending
// on firebase-admin internals.
const SERVER_TIMESTAMP_SENTINEL = '__serverTimestamp__';

jest.mock('firebase-admin/firestore', () => ({
  FieldValue: {
    serverTimestamp: () => SERVER_TIMESTAMP_SENTINEL,
  },
  Timestamp: { now: () => ({ toMillis: () => 0 }) },
}));

const warnSpy = jest.fn();
const errorSpy = jest.fn();
const infoSpy = jest.fn();

jest.mock('@/lib/logger', () => ({
  __esModule: true,
  default: {
    debug: (..._args: unknown[]) => {},
    info: (...args: unknown[]) => infoSpy(...args),
    warn: (...args: unknown[]) => warnSpy(...args),
    error: (...args: unknown[]) => errorSpy(...args),
  },
}));

const metricSpy = jest.fn();

jest.mock('@/lib/securityBoundaryMetrics.server', () => ({
  emitSecurityBoundaryMetric: (...args: unknown[]) => metricSpy(...args),
}));

beforeEach(() => {
  setCalls.length = 0;
  setShouldReject = null;
  warnSpy.mockClear();
  errorSpy.mockClear();
  infoSpy.mockClear();
  metricSpy.mockClear();
});

// helpers

const SITE = 'site-a';

function userEntry(overrides: Partial<AuditEntryInput> = {}): AuditEntryInput {
  return {
    correlationId: 'corr_user_1',
    actor: { type: 'user', userId: 'uid_alice', role: 'admin' } as AuditActor,
    capability: 'MACHINE_EXEC_COMMAND' as Capability,
    target: { kind: 'machine', id: 'mach-1' },
    outcome: 'allow',
    ...overrides,
  };
}

function systemEntry(overrides: Partial<AuditEntryInput> = {}): AuditEntryInput {
  return {
    correlationId: 'corr_sys_1',
    actor: { type: 'system', name: 'cortex_autonomous' } as AuditActor,
    capability: 'MACHINE_EXEC_COMMAND' as Capability,
    target: { kind: 'machine', id: 'mach-1' },
    outcome: 'allow',
    ...overrides,
  };
}

function machineEntry(overrides: Partial<AuditEntryInput> = {}): AuditEntryInput {
  return {
    correlationId: 'corr_machine_1',
    actor: { type: 'machine', siteId: SITE, machineId: 'studio-pc-01' },
    capability: 'MACHINE_EXEC_COMMAND' as Capability,
    target: { kind: 'machine', id: 'mach-1' },
    outcome: 'allow',
    ...overrides,
  };
}

function flushMicrotasks(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

// generateCorrelationId

describe('generateCorrelationId', () => {
  it('returns a 22-char hex string', () => {
    const id = generateCorrelationId();
    expect(id).toMatch(/^[0-9a-f]{22}$/);
  });

  it('returns a fresh value each call', () => {
    const a = generateCorrelationId();
    const b = generateCorrelationId();
    expect(a).not.toBe(b);
  });
});

// writeAuditEntryBlocking

describe('writeAuditEntryBlocking', () => {
  it('writes to sites/{siteId}/audit_log/{entryId}', async () => {
    await writeAuditEntryBlocking(SITE, userEntry());
    expect(setCalls).toHaveLength(1);
    expect(setCalls[0].path).toBe(
      `sites/${SITE}/audit_log/${auditDocId}`,
    );
  });

  it('persists user-actor allow outcomes with serverTimestamp', async () => {
    await writeAuditEntryBlocking(SITE, userEntry());
    const payload = setCalls[0].payload;
    expect(payload).toMatchObject({
      correlationId: 'corr_user_1',
      actor: { type: 'user', userId: 'uid_alice', role: 'admin' },
      capability: 'MACHINE_EXEC_COMMAND',
      target: { kind: 'machine', id: 'mach-1' },
      outcome: 'allow',
      timestamp: SERVER_TIMESTAMP_SENTINEL,
    });
  });

  it('persists system-actor allow outcomes', async () => {
    await writeAuditEntryBlocking(SITE, systemEntry());
    const payload = setCalls[0].payload;
    expect(payload.actor).toEqual({ type: 'system', name: 'cortex_autonomous' });
    expect(payload.outcome).toBe('allow');
  });

  it('persists deny outcomes with denyReason + metadata', async () => {
    await writeAuditEntryBlocking(
      SITE,
      userEntry({
        outcome: 'deny',
        denyReason: 'capability_missing',
        metadata: { route: '/api/sites/site-a/machines/mach-1/commands' },
      }),
    );
    const payload = setCalls[0].payload;
    expect(payload.outcome).toBe('deny');
    expect(payload.denyReason).toBe('capability_missing');
    expect(payload.metadata).toEqual({
      route: '/api/sites/site-a/machines/mach-1/commands',
    });
  });

  it('persists error outcomes with errorCode', async () => {
    await writeAuditEntryBlocking(
      SITE,
      userEntry({ outcome: 'error', errorCode: 'firestore_unavailable' }),
    );
    const payload = setCalls[0].payload;
    expect(payload.outcome).toBe('error');
    expect(payload.errorCode).toBe('firestore_unavailable');
  });

  it('omits optional fields when not provided', async () => {
    await writeAuditEntryBlocking(SITE, userEntry());
    const payload = setCalls[0].payload;
    expect(payload).not.toHaveProperty('metadata');
    expect(payload).not.toHaveProperty('denyReason');
    expect(payload).not.toHaveProperty('errorCode');
    expect(payload).not.toHaveProperty('enforcementBypassed');
  });

  it('preserves machineId on target when provided', async () => {
    await writeAuditEntryBlocking(
      SITE,
      userEntry({
        target: { kind: 'process', id: 'proc-1', machineId: 'mach-9' },
      }),
    );
    expect(setCalls[0].payload.target).toEqual({
      kind: 'process',
      id: 'proc-1',
      machineId: 'mach-9',
    });
  });

  it('strips undefined target.machineId before write', async () => {
    await writeAuditEntryBlocking(
      SITE,
      userEntry({
        // explicitly undefined to mimic destructured optional fields
        target: { kind: 'machine', id: 'mach-1', machineId: undefined },
      }),
    );
    const target = setCalls[0].payload.target as Record<string, unknown>;
    expect(target).not.toHaveProperty('machineId');
  });

  it('rejects with empty siteId', async () => {
    await expect(
      writeAuditEntryBlocking('', userEntry()),
    ).rejects.toThrow(/siteId is required/);
    expect(setCalls).toHaveLength(0);
  });

  it('propagates firestore errors so callers can fail-closed', async () => {
    setShouldReject = new Error('firestore down');
    await expect(
      writeAuditEntryBlocking(SITE, userEntry()),
    ).rejects.toThrow('firestore down');
  });

  it('logs warn when enforcementBypassed=true', async () => {
    await writeAuditEntryBlocking(
      SITE,
      userEntry({ enforcementBypassed: true, metadata: { kill_switch: 'capability' } }),
    );
    expect(warnSpy).toHaveBeenCalledTimes(1);
    const [msg] = warnSpy.mock.calls[0];
    expect(msg).toMatch(/enforcement bypassed/i);
    // bypass flag still ends up on the audit row
    expect(setCalls[0].payload.enforcementBypassed).toBe(true);
  });

  it('redacts user id in bypass log line', async () => {
    await writeAuditEntryBlocking(
      SITE,
      userEntry({
        actor: { type: 'user', userId: 'uid_supersecret_long_id', role: 'admin' },
        enforcementBypassed: true,
      }),
    );
    const [, payload] = warnSpy.mock.calls[0];
    const data = (payload as { data: { actor: { userIdPrefix: string } } })
      .data.actor;
    expect(data.userIdPrefix).toBe('uid_su');
    expect(JSON.stringify(payload)).not.toContain('uid_supersecret_long_id');
  });

  it('persists a machine actor and labels its decision metric `machine`', async () => {
    await writeAuditEntryBlocking(SITE, machineEntry());
    expect(setCalls[0].payload.actor).toEqual({ type: 'machine', siteId: SITE, machineId: 'studio-pc-01' });
    expect(metricSpy).toHaveBeenCalledWith(
      'capability_decision_total',
      1,
      expect.objectContaining({ labels: expect.objectContaining({ role: 'machine' }) }),
    );
  });

  it('logs a machine actor in the bypass line by type and machine id only', async () => {
    await writeAuditEntryBlocking(SITE, machineEntry({ enforcementBypassed: true }));
    const [, payload] = warnSpy.mock.calls[0];
    expect((payload as { data: { actor: unknown } }).data.actor).toEqual({
      type: 'machine',
      machineId: 'studio-pc-01',
    });
    expect(metricSpy).toHaveBeenCalledWith(
      'authorization_enforcement_bypass_total',
      1,
      expect.objectContaining({ labels: expect.objectContaining({ role: 'machine' }) }),
    );
  });

  it('does not log warn when enforcementBypassed=false', async () => {
    await writeAuditEntryBlocking(
      SITE,
      userEntry({ enforcementBypassed: false }),
    );
    expect(warnSpy).not.toHaveBeenCalled();
  });
});

// writeAuditEntry (fire-and-forget)

describe('writeAuditEntry (fire-and-forget)', () => {
  it('returns void synchronously', () => {
    const ret = writeAuditEntry(SITE, userEntry({ outcome: 'deny', denyReason: 'x' }));
    expect(ret).toBeUndefined();
  });

  it('writes the entry asynchronously', async () => {
    writeAuditEntry(SITE, userEntry({ outcome: 'deny', denyReason: 'x' }));
    await flushMicrotasks();
    expect(setCalls).toHaveLength(1);
    expect(setCalls[0].path).toBe(`sites/${SITE}/audit_log/${auditDocId}`);
  });

  it('does not throw when the underlying write fails', async () => {
    setShouldReject = new Error('boom');
    expect(() =>
      writeAuditEntry(SITE, userEntry({ outcome: 'error', errorCode: 'x' })),
    ).not.toThrow();
    await flushMicrotasks();
    expect(errorSpy).toHaveBeenCalledTimes(1);
    const [msg] = errorSpy.mock.calls[0];
    expect(msg).toMatch(/audit log write failed/i);
  });

  it('does not throw when siteId is empty (logs error instead)', async () => {
    expect(() =>
      writeAuditEntry('', userEntry({ outcome: 'deny', denyReason: 'x' })),
    ).not.toThrow();
    await flushMicrotasks();
    expect(errorSpy).toHaveBeenCalled();
    expect(setCalls).toHaveLength(0);
  });
});

// correlationId stability across related writes

describe('correlationId stability', () => {
  it('the same correlationId can be reused across multiple audit writes', async () => {
    const correlationId = generateCorrelationId();
    await writeAuditEntryBlocking(SITE, userEntry({ correlationId }));
    await writeAuditEntryBlocking(
      SITE,
      userEntry({ correlationId, outcome: 'error', errorCode: 'handler_threw' }),
    );
    expect(setCalls).toHaveLength(2);
    expect(setCalls[0].payload.correlationId).toBe(correlationId);
    expect(setCalls[1].payload.correlationId).toBe(correlationId);
  });
});

// ttl cleanup placeholder

describe('cleanupExpiredAuditEntries (placeholder)', () => {
  it('logs the deferred-implementation marker and resolves', async () => {
    await expect(cleanupExpiredAuditEntries()).resolves.toBeUndefined();
    expect(infoSpy).toHaveBeenCalledTimes(1);
    const [msg] = infoSpy.mock.calls[0];
    expect(msg).toMatch(/wave 5\.3 or later/);
  });
});
