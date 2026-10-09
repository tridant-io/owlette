/** @jest-environment node */

/**
 * Http-shape coverage for the public machine-command endpoints:
 *
 *   POST /api/sites/{siteId}/machines/{machineId}/commands
 *   GET  /api/sites/{siteId}/machines/{machineId}/commands/{commandId}
 *   POST /api/sites/{siteId}/machines/{machineId}/screenshots/upload-url
 *
 * Each verb covers scope-pass, scope-fail, and its own happy/error paths: allowlist enforcement,
 * machine-offline 409, idempotency replay, completed-capture status shape, signed-url issuance.
 */

import { createMockRequest } from './helpers/utils';
import {
  mocks,
  mockDbFactory,
  docSnapshot,
  querySnapshot,
  seedMember
} from './helpers/firestore-mock';

jest.mock('@sentry/nextjs', () => ({
  captureException: jest.fn(),
  captureMessage: jest.fn(),
}));

// `getSignedUrl` returns a tuple [url] per firebase-admin. A counter lets tests assert read vs
// write urls were minted with the expected expiry.
const signedUrlCalls: Array<{ action?: string; expires?: Date; contentType?: string }> = [];
const fakeFile = {
  getSignedUrl: jest.fn(async (opts: { action?: string; expires?: Date; contentType?: string }) => {
    signedUrlCalls.push(opts);
    const stamp = signedUrlCalls.length;
    const action = opts.action ?? 'unknown';
    return [`https://signed.example/${action}-${stamp}`];
  }),
};
const fakeBucket = { file: jest.fn(() => fakeFile) };

jest.mock('@/lib/firebase-admin', () => ({
  getAdminDb: () => mockDbFactory(),
  getAdminAuth: () => ({
    verifyIdToken: jest.fn().mockRejectedValue(new Error('n/a')),
  }),
  getAdminStorage: () => ({ bucket: jest.fn(() => fakeBucket) }),
}));

jest.mock('@/lib/auditLogClient', () => ({
  emitApiKeyUsed: jest.fn(),
  emitMutation: jest.fn(),
  scopeFingerprint: jest.fn(() => 'fp'),
}));

jest.mock('@/lib/auditLog.server', () => ({
  generateCorrelationId: jest.fn(() => 'corr-test'),
  writeAuditEntry: jest.fn(),
  writeAuditEntryBlocking: jest.fn(async () => undefined),
}));

jest.mock('@/lib/rateLimit.server', () => ({
  checkRateLimit: jest.fn(async () => ({ ok: true })),
  rateLimitHeaders: jest.fn(() => ({})),
}));

jest.mock('@/lib/securityConfig.server', () => ({
  securityConfig: {
    read: jest.fn(async () => ({
      capability_enforcement: true,
      rate_limit_enforcement: true,
    })),
  },
}));

const mockGetEntitlements = jest.fn();
jest.mock('@/lib/tridantEntitlements.server', () => ({
  getEntitlements: (uid: string) => mockGetEntitlements(uid),
}));

const mockResolveAuth = jest.fn();
const mockAssertSite = jest.fn();

jest.mock('@/lib/apiAuth.server', () => {
  const actual = jest.requireActual('@/lib/apiAuth.server');
  return {
    ...actual,
    resolveAuth: (...a: unknown[]) => mockResolveAuth(...a),
    assertUserHasSiteAccess: (...a: unknown[]) => mockAssertSite(...a),
  };
});

import { emitMutation } from '@/lib/auditLogClient';
import type { ApiKeyScope } from '@/lib/apiKeyTypes';
import type { ResolvedAuth } from '@/lib/apiAuth.server';

import { POST as commandsPOST } from '@/app/api/sites/[siteId]/machines/[machineId]/commands/route';
import { GET as commandStatusGET } from '@/app/api/sites/[siteId]/machines/[machineId]/commands/[commandId]/route';
import { POST as uploadUrlPOST } from '@/app/api/sites/[siteId]/machines/[machineId]/screenshots/upload-url/route';

const SITE = 'site-alpha';
const MACHINE = 'mach_test_1';
const ORIG_BUCKET_ENV = process.env.NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET;

const mockedEmit = emitMutation as jest.MockedFunction<typeof emitMutation>;

function authedSession(): ResolvedAuth {
  return { userId: 'user-1', keyContext: null };
}

function authedKey(scopes: ApiKeyScope[] | null): ResolvedAuth {
  return {
    userId: 'user-1',
    keyContext: {
      keyId: 'key-test',
      scopes,
      environment: 'live',
      expiresAt: Date.now() + 60_000,
      isLegacy: scopes === null,
    },
  };
}

beforeAll(() => {
  process.env.NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET = 'fake-bucket.appspot.com';
});

afterAll(() => {
  if (ORIG_BUCKET_ENV === undefined) {
    delete process.env.NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET;
  } else {
    process.env.NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET = ORIG_BUCKET_ENV;
  }
});

beforeEach(() => {
  jest.clearAllMocks();
  signedUrlCalls.length = 0;
  mockResolveAuth.mockResolvedValue(authedSession());
  mockAssertSite.mockResolvedValue({ siteId: SITE, siteData: {} });
  mocks.siteDocs.clear();
  mocks.memberDocs.clear();
  mocks.userDocs.clear();
  mocks.siteDocs.set(SITE, { owner: 'user-1' });
  seedMember(SITE, 'user-1', 'owner');
  mocks.set.mockResolvedValue(undefined);
  mocks.update.mockResolvedValue(undefined);
  mocks.del.mockResolvedValue(undefined);
  mocks.get.mockImplementation(() => Promise.resolve(docSnapshot('any', null)));
  mocks.collectionGet.mockResolvedValue(querySnapshot([]));
});

/* POST .../commands — dispatch */
describe('POST /api/sites/{siteId}/machines/{machineId}/commands', () => {
  const USER_DOC = { role: 'superadmin', sites: [SITE] };

  /**
   * The caller's `users/{uid}` read is PATH-ADDRESSED (`mocks.userDocs`), not
   * queued. It used to be queued, which made every downstream
   * `mockResolvedValueOnce` positional against the authorization path — and the
   * authorization path now reads a membership row too, so any queue built that
   * way shifts the moment it changes again.
   */
  function queueUserDoc(): void {
    mocks.userDocs.set('user-1', USER_DOC);
  }

  /**
   * Queues actor load → idempotency miss → machine doc, in order. `clearAllMocks` does NOT clear
   * `mockResolvedValueOnce` queues, so hard-reset and re-prime per test to stop bleed-through.
   */
  function queueIdemAndMachine(
    machineDoc: Record<string, unknown> | null,
    extraGets: number = 0,
  ): void {
    mocks.get.mockReset();
    queueUserDoc();
    mocks.get.mockResolvedValueOnce(docSnapshot('idem', null));
    mocks.get.mockResolvedValueOnce(docSnapshot(MACHINE, machineDoc));
    for (let i = 0; i < extraGets; i++) {
      mocks.get.mockResolvedValueOnce(docSnapshot('any', null));
    }
    mocks.get.mockImplementation(() => {
      throw new Error('unexpected extra firestore read on commands POST');
    });
  }

  /** For paths short-circuiting before the machine lookup: validation failures, idem replays. */
  function queueIdemOnly(
    cached: Record<string, unknown> | null = null,
  ): void {
    mocks.get.mockReset();
    queueUserDoc();
    if (cached) {
      mocks.get.mockResolvedValueOnce({
        exists: true,
        data: () => cached,
      });
    } else {
      mocks.get.mockResolvedValueOnce(docSnapshot('idem', null));
    }
    mocks.get.mockImplementation(() => {
      throw new Error('unexpected extra firestore read on commands POST');
    });
  }

  function queueActorOnly(): void {
    mocks.get.mockReset();
    queueUserDoc();
    mocks.get.mockImplementation(() => {
      throw new Error('unexpected extra firestore read on commands POST');
    });
  }

  function lastMergedCommand(): Record<string, unknown> {
    const mergeCalls = mocks.set.mock.calls.filter(
      (c: unknown[]) => (c[1] as { merge?: boolean })?.merge === true,
    );
    const env = mergeCalls[mergeCalls.length - 1][0] as Record<string, Record<string, unknown>>;
    return env[Object.keys(env)[0]];
  }

  it('202 happy path: reboot_machine writes pending entry + emits audit', async () => {
    queueIdemAndMachine({ online: true });

    const req = createMockRequest(
      `http://localhost/api/sites/${SITE}/machines/${MACHINE}/commands`,
      {
        method: 'POST',
        headers: { 'Idempotency-Key': 'idem-reboot-1' },
        body: { type: 'reboot_machine', params: { delay_seconds: 30 } },
      },
    );
    const res = await commandsPOST(req, {
      params: Promise.resolve({ siteId: SITE, machineId: MACHINE }),
    });
    expect(res.status).toBe(202);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.data.commandId).toMatch(/^cmd_/);
    expect(body.data.status).toBe('pending');

    // The only set with merge:true on this path.
    const mergeCalls = mocks.set.mock.calls.filter(
      (c: unknown[]) => (c[1] as { merge?: boolean })?.merge === true,
    );
    expect(mergeCalls).toHaveLength(1);
    const cmdEnvelope = mergeCalls[0][0] as Record<string, Record<string, unknown>>;
    const cmdId = Object.keys(cmdEnvelope)[0];
    expect(cmdEnvelope[cmdId].type).toBe('reboot_machine');
    expect(cmdEnvelope[cmdId].delay_seconds).toBe(30);
    expect(cmdEnvelope[cmdId].timeout_seconds).toBe(60);

    expect(mockedEmit).toHaveBeenCalledTimes(1);
    expect(mockedEmit).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: 'machine_command_dispatched',
        siteId: SITE,
        attributes: expect.objectContaining({
          commandType: 'reboot_machine',
          method: 'POST',
          machineId: MACHINE,
        }),
      }),
    );
  });

  it('202 happy path: shutdown_machine accepts delay_seconds: 0', async () => {
    queueIdemAndMachine({ online: true });
    const req = createMockRequest(
      `http://localhost/api/sites/${SITE}/machines/${MACHINE}/commands`,
      {
        method: 'POST',
        headers: { 'Idempotency-Key': 'idem-shutdown-1' },
        body: { type: 'shutdown_machine', params: { delay_seconds: 0 } },
      },
    );
    const res = await commandsPOST(req, {
      params: Promise.resolve({ siteId: SITE, machineId: MACHINE }),
    });
    expect(res.status).toBe(202);
    const body = await res.json();
    expect(body.data.status).toBe('pending');
  });

  it('202 happy path: capture_screenshot accepts monitor: "all"', async () => {
    queueIdemAndMachine({ online: true });
    const req = createMockRequest(
      `http://localhost/api/sites/${SITE}/machines/${MACHINE}/commands`,
      {
        method: 'POST',
        headers: { 'Idempotency-Key': 'idem-cap-all' },
        body: { type: 'capture_screenshot', params: { monitor: 'all' } },
      },
    );
    const res = await commandsPOST(req, {
      params: Promise.resolve({ siteId: SITE, machineId: MACHINE }),
    });
    expect(res.status).toBe(202);

    const mergeCalls = mocks.set.mock.calls.filter(
      (c: unknown[]) => (c[1] as { merge?: boolean })?.merge === true,
    );
    const env = mergeCalls[0][0] as Record<string, Record<string, unknown>>;
    const cid = Object.keys(env)[0];
    expect(env[cid].monitor).toBe('all');
  });

  it('202 happy path: capture_screenshot accepts numeric monitor index', async () => {
    queueIdemAndMachine({ online: true });
    const req = createMockRequest(
      `http://localhost/api/sites/${SITE}/machines/${MACHINE}/commands`,
      {
        method: 'POST',
        headers: { 'Idempotency-Key': 'idem-cap-2' },
        body: { type: 'capture_screenshot', params: { monitor: 2 } },
      },
    );
    const res = await commandsPOST(req, {
      params: Promise.resolve({ siteId: SITE, machineId: MACHINE }),
    });
    expect(res.status).toBe(202);
  });

  it('202 happy path: cancel_mcp_tool forwards target_command_id', async () => {
    queueIdemAndMachine({ online: true });
    const req = createMockRequest(
      `http://localhost/api/sites/${SITE}/machines/${MACHINE}/commands`,
      {
        method: 'POST',
        headers: { 'Idempotency-Key': 'idem-cancel-mcp' },
        body: { type: 'cancel_mcp_tool', params: { target_command_id: 'cmd_target_1' } },
      },
    );
    const res = await commandsPOST(req, {
      params: Promise.resolve({ siteId: SITE, machineId: MACHINE }),
    });
    expect(res.status).toBe(202);

    const cmd = lastMergedCommand();
    expect(cmd.type).toBe('cancel_mcp_tool');
    expect(cmd.target_command_id).toBe('cmd_target_1');
  });

  it('400 when cancel_mcp_tool omits target_command_id', async () => {
    queueIdemOnly();
    const req = createMockRequest(
      `http://localhost/api/sites/${SITE}/machines/${MACHINE}/commands`,
      {
        method: 'POST',
        headers: { 'Idempotency-Key': 'idem-cancel-mcp-bad' },
        body: { type: 'cancel_mcp_tool', params: {} },
      },
    );
    const res = await commandsPOST(req, {
      params: Promise.resolve({ siteId: SITE, machineId: MACHINE }),
    });
    expect(res.status).toBe(400);
  });

  it('400 unsupported_command_type when type not in allowlist', async () => {
    // Validation precedes the machine lookup, so only the idem miss is consumed.
    queueIdemOnly();
    const req = createMockRequest(
      `http://localhost/api/sites/${SITE}/machines/${MACHINE}/commands`,
      {
        method: 'POST',
        headers: { 'Idempotency-Key': 'idem-bogus' },
        body: { type: 'format_c_drive', params: { force: true } },
      },
    );
    const res = await commandsPOST(req, {
      params: Promise.resolve({ siteId: SITE, machineId: MACHINE }),
    });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.code).toBe('unsupported_command_type');
  });

  it('202 happy path: start_live_view accepts interval and duration', async () => {
    queueIdemAndMachine({ online: true });
    const req = createMockRequest(
      `http://localhost/api/sites/${SITE}/machines/${MACHINE}/commands`,
      {
        method: 'POST',
        headers: { 'Idempotency-Key': 'idem-lv' },
        body: { type: 'start_live_view', params: { interval: 2, duration: 30 } },
      },
    );
    const res = await commandsPOST(req, {
      params: Promise.resolve({ siteId: SITE, machineId: MACHINE }),
    });
    expect(res.status).toBe(202);

    const mergeCalls = mocks.set.mock.calls.filter(
      (c: unknown[]) => (c[1] as { merge?: boolean })?.merge === true,
    );
    const env = mergeCalls[0][0] as Record<string, Record<string, unknown>>;
    const cid = Object.keys(env)[0];
    expect(env[cid].type).toBe('start_live_view');
    expect(env[cid].interval).toBe(2);
    expect(env[cid].duration).toBe(30);
  });

  it('400 idempotency_key_required when Idempotency-Key is missing', async () => {
    queueActorOnly();
    const req = createMockRequest(
      `http://localhost/api/sites/${SITE}/machines/${MACHINE}/commands`,
      {
        method: 'POST',
        body: { type: 'reboot_machine' },
      },
    );
    const res = await commandsPOST(req, {
      params: Promise.resolve({ siteId: SITE, machineId: MACHINE }),
    });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.code).toBe('idempotency_key_required');
    expect(mocks.set).not.toHaveBeenCalled();
  });

  it('202 happy path: restart_process forwards process identifiers', async () => {
    queueIdemAndMachine({ online: true });
    const req = createMockRequest(
      `http://localhost/api/sites/${SITE}/machines/${MACHINE}/commands`,
      {
        method: 'POST',
        headers: { 'Idempotency-Key': 'idem-restart-proc' },
        body: {
          type: 'restart_process',
          params: { process_name: 'TouchDesigner.exe', process_id: 'proc-1' },
        },
      },
    );
    const res = await commandsPOST(req, {
      params: Promise.resolve({ siteId: SITE, machineId: MACHINE }),
    });
    expect(res.status).toBe(202);
    const cmd = lastMergedCommand();
    expect(cmd.type).toBe('restart_process');
    expect(cmd.process_name).toBe('TouchDesigner.exe');
    expect(cmd.process_id).toBe('proc-1');
  });

  it('202 happy path: stop_process forwards process identifiers', async () => {
    queueIdemAndMachine({ online: true });
    const req = createMockRequest(
      `http://localhost/api/sites/${SITE}/machines/${MACHINE}/commands`,
      {
        method: 'POST',
        headers: { 'Idempotency-Key': 'idem-stop-proc' },
        body: {
          type: 'stop_process',
          params: { process_name: 'TouchDesigner.exe', process_id: 'proc-1' },
        },
      },
    );
    const res = await commandsPOST(req, {
      params: Promise.resolve({ siteId: SITE, machineId: MACHINE }),
    });
    expect(res.status).toBe(202);
    const cmd = lastMergedCommand();
    expect(cmd.type).toBe('stop_process');
    expect(cmd.process_name).toBe('TouchDesigner.exe');
    expect(cmd.process_id).toBe('proc-1');
  });

  it('202 happy path: set_launch_mode forwards mode and schedules', async () => {
    queueIdemAndMachine({ online: true });
    const schedules = [{ days: ['mon'], ranges: [{ start: '09:00', stop: '17:00' }] }];
    const req = createMockRequest(
      `http://localhost/api/sites/${SITE}/machines/${MACHINE}/commands`,
      {
        method: 'POST',
        headers: { 'Idempotency-Key': 'idem-launch-mode' },
        body: {
          type: 'set_launch_mode',
          params: {
            process_name: 'TouchDesigner.exe',
            mode: 'scheduled',
            schedules,
            schedulePresetId: 'preset-1',
          },
        },
      },
    );
    const res = await commandsPOST(req, {
      params: Promise.resolve({ siteId: SITE, machineId: MACHINE }),
    });
    expect(res.status).toBe(202);
    const cmd = lastMergedCommand();
    expect(cmd.type).toBe('set_launch_mode');
    expect(cmd.mode).toBe('scheduled');
    expect(cmd.schedules).toEqual(schedules);
    expect(cmd.schedulePresetId).toBe('preset-1');
  });

  it('202 happy path: apply_display_topology forwards layout and applyId', async () => {
    queueIdemAndMachine({ online: true });
    const layout = { monitors: [{ id: 'primary', position: { x: 0, y: 0 } }] };
    const req = createMockRequest(
      `http://localhost/api/sites/${SITE}/machines/${MACHINE}/commands`,
      {
        method: 'POST',
        headers: { 'Idempotency-Key': 'idem-apply-display' },
        body: {
          type: 'apply_display_topology',
          params: { layout, applyId: 'apply-1' },
        },
      },
    );
    const res = await commandsPOST(req, {
      params: Promise.resolve({ siteId: SITE, machineId: MACHINE }),
    });
    expect(res.status).toBe(202);
    const cmd = lastMergedCommand();
    expect(cmd.type).toBe('apply_display_topology');
    expect(cmd.layout).toEqual(layout);
    expect(cmd.applyId).toBe('apply-1');
  });

  it('400 when apply_display_topology is missing layout', async () => {
    queueIdemOnly();
    const req = createMockRequest(
      `http://localhost/api/sites/${SITE}/machines/${MACHINE}/commands`,
      {
        method: 'POST',
        headers: { 'Idempotency-Key': 'idem-apply-missing-layout' },
        body: {
          type: 'apply_display_topology',
          params: { applyId: 'apply-1' },
        },
      },
    );
    const res = await commandsPOST(req, {
      params: Promise.resolve({ siteId: SITE, machineId: MACHINE }),
    });
    expect(res.status).toBe(400);
    expect((await res.json()).code).toBe('validation_failed');
  });

  it('202 happy path: ack_display_topology forwards applyId', async () => {
    queueIdemAndMachine({ online: true });
    const req = createMockRequest(
      `http://localhost/api/sites/${SITE}/machines/${MACHINE}/commands`,
      {
        method: 'POST',
        headers: { 'Idempotency-Key': 'idem-ack-display' },
        body: {
          type: 'ack_display_topology',
          params: { applyId: 'apply-1' },
        },
      },
    );
    const res = await commandsPOST(req, {
      params: Promise.resolve({ siteId: SITE, machineId: MACHINE }),
    });
    expect(res.status).toBe(202);
    const cmd = lastMergedCommand();
    expect(cmd.type).toBe('ack_display_topology');
    expect(cmd.applyId).toBe('apply-1');
  });

  it('400 when ack_display_topology is missing applyId', async () => {
    queueIdemOnly();
    const req = createMockRequest(
      `http://localhost/api/sites/${SITE}/machines/${MACHINE}/commands`,
      {
        method: 'POST',
        headers: { 'Idempotency-Key': 'idem-ack-missing-apply' },
        body: {
          type: 'ack_display_topology',
          params: {},
        },
      },
    );
    const res = await commandsPOST(req, {
      params: Promise.resolve({ siteId: SITE, machineId: MACHINE }),
    });
    expect(res.status).toBe(400);
    expect((await res.json()).code).toBe('validation_failed');
  });

  it.each(['enumerate_display_modes', 'test_display_apply'] as const)(
    '202 happy path: %s queues without extra params',
    async (type) => {
      queueIdemAndMachine({ online: true });
      const req = createMockRequest(
        `http://localhost/api/sites/${SITE}/machines/${MACHINE}/commands`,
        {
          method: 'POST',
          headers: { 'Idempotency-Key': `idem-${type}` },
          body: { type },
        },
      );
      const res = await commandsPOST(req, {
        params: Promise.resolve({ siteId: SITE, machineId: MACHINE }),
      });
      expect(res.status).toBe(202);
      const cmd = lastMergedCommand();
      expect(cmd.type).toBe(type);
      expect(cmd.timeout_seconds).toBe(60);
    },
  );

  it('202 happy path: mcp_tool_call forwards tool envelope', async () => {
    queueIdemAndMachine({ online: true });
    const req = createMockRequest(
      `http://localhost/api/sites/${SITE}/machines/${MACHINE}/commands`,
      {
        method: 'POST',
        headers: { 'Idempotency-Key': 'idem-mcp-tool' },
        body: {
          type: 'mcp_tool_call',
          params: {
            tool_name: 'get_system_info',
            tool_params: { verbose: true },
            chat_id: 'chat-1',
          },
        },
      },
    );
    const res = await commandsPOST(req, {
      params: Promise.resolve({ siteId: SITE, machineId: MACHINE }),
    });
    expect(res.status).toBe(202);
    const cmd = lastMergedCommand();
    expect(cmd.type).toBe('mcp_tool_call');
    expect(cmd.tool_name).toBe('get_system_info');
    expect(cmd.tool_params).toEqual({ verbose: true });
    expect(cmd.chat_id).toBe('chat-1');
  });

  it('400 when type field missing', async () => {
    queueIdemOnly();
    const req = createMockRequest(
      `http://localhost/api/sites/${SITE}/machines/${MACHINE}/commands`,
      {
        method: 'POST',
        headers: { 'Idempotency-Key': 'idem-empty' },
        body: { params: {} },
      },
    );
    const res = await commandsPOST(req, {
      params: Promise.resolve({ siteId: SITE, machineId: MACHINE }),
    });
    expect(res.status).toBe(400);
  });

  it('400 when params.monitor is invalid string', async () => {
    queueIdemOnly();
    const req = createMockRequest(
      `http://localhost/api/sites/${SITE}/machines/${MACHINE}/commands`,
      {
        method: 'POST',
        headers: { 'Idempotency-Key': 'idem-badmon' },
        body: { type: 'capture_screenshot', params: { monitor: 'banana' } },
      },
    );
    const res = await commandsPOST(req, {
      params: Promise.resolve({ siteId: SITE, machineId: MACHINE }),
    });
    expect(res.status).toBe(400);
  });

  it('409 machine_offline when machine.online === false', async () => {
    queueIdemAndMachine({ online: false });
    const req = createMockRequest(
      `http://localhost/api/sites/${SITE}/machines/${MACHINE}/commands`,
      {
        method: 'POST',
        headers: { 'Idempotency-Key': 'idem-off' },
        body: { type: 'reboot_machine' },
      },
    );
    const res = await commandsPOST(req, {
      params: Promise.resolve({ siteId: SITE, machineId: MACHINE }),
    });
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.code).toBe('machine_offline');

    // The offline branch must queue no command and emit no audit.
    const mergeCalls = mocks.set.mock.calls.filter(
      (c: unknown[]) => (c[1] as { merge?: boolean })?.merge === true,
    );
    expect(mergeCalls).toHaveLength(0);
    expect(mockedEmit).not.toHaveBeenCalled();
  });

  it('404 when machine doc does not exist', async () => {
    queueIdemAndMachine(null);
    const req = createMockRequest(
      `http://localhost/api/sites/${SITE}/machines/${MACHINE}/commands`,
      {
        method: 'POST',
        headers: { 'Idempotency-Key': 'idem-nx' },
        body: { type: 'reboot_machine' },
      },
    );
    const res = await commandsPOST(req, {
      params: Promise.resolve({ siteId: SITE, machineId: MACHINE }),
    });
    expect(res.status).toBe(404);
  });

  it('202 — scope-pass: machine=<id>:write on api key', async () => {
    mockResolveAuth.mockResolvedValue(
      authedKey([{ resource: 'machine', id: MACHINE, permissions: ['write'] }]),
    );
    queueIdemAndMachine({ online: true });
    const req = createMockRequest(
      `http://localhost/api/sites/${SITE}/machines/${MACHINE}/commands`,
      {
        method: 'POST',
        headers: { 'Idempotency-Key': 'idem-scope-ok' },
        body: { type: 'reboot_machine' },
      },
    );
    const res = await commandsPOST(req, {
      params: Promise.resolve({ siteId: SITE, machineId: MACHINE }),
    });
    expect(res.status).toBe(202);
  });

  it('403 scope_insufficient when key has only machine:read', async () => {
    mockResolveAuth.mockResolvedValue(
      authedKey([{ resource: 'machine', id: MACHINE, permissions: ['read'] }]),
    );
    queueActorOnly();
    const req = createMockRequest(
      `http://localhost/api/sites/${SITE}/machines/${MACHINE}/commands`,
      {
        method: 'POST',
        headers: { 'Idempotency-Key': 'idem-scope-fail' },
        body: { type: 'reboot_machine' },
      },
    );
    const res = await commandsPOST(req, {
      params: Promise.resolve({ siteId: SITE, machineId: MACHINE }),
    });
    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.code).toBe('scope_insufficient');
  });

  it('replays cached response on Idempotency-Key hit with matching body', async () => {
    const crypto = await import('crypto');
    const reqBody = { type: 'reboot_machine' };
    const raw = JSON.stringify(reqBody);
    const bodyHash = crypto.createHash('sha256').update(raw).digest('hex');
    queueIdemOnly({
      userId: 'user-1',
      environment: 'unknown',
      key: 'idem-replay',
      bodyHash,
      status: 202,
      headers: { 'content-type': 'application/json' },
      body: '{"ok":true,"data":{"commandId":"cmd_replayed","status":"pending"}}',
      expiresAt: Date.now() + 60_000,
    });

    const req = createMockRequest(
      `http://localhost/api/sites/${SITE}/machines/${MACHINE}/commands`,
      {
        method: 'POST',
        headers: { 'Idempotency-Key': 'idem-replay' },
        body: reqBody,
      },
    );
    const res = await commandsPOST(req, {
      params: Promise.resolve({ siteId: SITE, machineId: MACHINE }),
    });
    expect(res.status).toBe(202);
    expect(res.headers.get('Idempotent-Replayed')).toBe('true');
    const body = await res.json();
    expect(body.data.commandId).toBe('cmd_replayed');
    expect(mocks.set).not.toHaveBeenCalled();
  });

  it('202 — member may capture_screenshot (routed to MACHINE_VIEW handler)', async () => {
    // A plain MEMBER of the site. The standing is the member row; the global
    // role beside it grants nothing on a site.
    mocks.userDocs.set('user-1', { role: 'member', sites: [SITE] });
    seedMember(SITE, 'user-1', 'member');
    mocks.get.mockReset();
    mocks.get.mockResolvedValueOnce(docSnapshot('idem', null));
    mocks.get.mockResolvedValueOnce(docSnapshot(MACHINE, { online: true }));
    mocks.get.mockImplementation(() => {
      throw new Error('unexpected extra firestore read on commands POST');
    });

    const req = createMockRequest(
      `http://localhost/api/sites/${SITE}/machines/${MACHINE}/commands`,
      {
        method: 'POST',
        headers: { 'Idempotency-Key': 'idem-member-cap' },
        body: { type: 'capture_screenshot', params: { monitor: 'primary' } },
      },
    );
    const res = await commandsPOST(req, {
      params: Promise.resolve({ siteId: SITE, machineId: MACHINE }),
    });
    expect(res.status).toBe(202);
    expect(lastMergedCommand().type).toBe('capture_screenshot');
  });

  it('403 — member may NOT reboot_machine (MACHINE_EXEC_COMMAND still required)', async () => {
    // The caller must be a plain MEMBER here, not the owner: the beforeEach seeds
    // an OWNER row for `user-1`, and owner carries MACHINE_EXEC_COMMAND, so
    // leaving it would assert a denial production would not produce.
    mocks.siteDocs.set(SITE, { owner: 'someone-else' });
    seedMember(SITE, 'someone-else', 'owner');
    mocks.userDocs.set('user-1', { role: 'member', sites: [SITE] });
    seedMember(SITE, 'user-1', 'member');
    // Capability denial happens in the wrapper, so no route read is consumed.
    mocks.get.mockReset();
    mocks.get.mockImplementation(() => {
      throw new Error('unexpected extra firestore read on commands POST');
    });

    const req = createMockRequest(
      `http://localhost/api/sites/${SITE}/machines/${MACHINE}/commands`,
      {
        method: 'POST',
        headers: { 'Idempotency-Key': 'idem-member-reboot' },
        body: { type: 'reboot_machine' },
      },
    );
    const res = await commandsPOST(req, {
      params: Promise.resolve({ siteId: SITE, machineId: MACHINE }),
    });
    expect(res.status).toBe(403);
    const mergeCalls = mocks.set.mock.calls.filter(
      (c: unknown[]) => (c[1] as { merge?: boolean })?.merge === true,
    );
    expect(mergeCalls).toHaveLength(0);
  });

  it('422 idempotency_key_mismatch when same key, different body', async () => {
    queueIdemOnly({
      userId: 'user-1',
      environment: 'unknown',
      key: 'idem-mismatch',
      bodyHash: 'a'.repeat(64),
      status: 202,
      headers: {},
      body: '{}',
      expiresAt: Date.now() + 60_000,
    });
    const req = createMockRequest(
      `http://localhost/api/sites/${SITE}/machines/${MACHINE}/commands`,
      {
        method: 'POST',
        headers: { 'Idempotency-Key': 'idem-mismatch' },
        body: { type: 'reboot_machine' },
      },
    );
    const res = await commandsPOST(req, {
      params: Promise.resolve({ siteId: SITE, machineId: MACHINE }),
    });
    expect(res.status).toBe(422);
    const body = await res.json();
    expect(body.code).toBe('idempotency_key_mismatch');
  });

  describe('on owlette free (plan.md decision 7)', () => {
    const ENV_KEYS = ['PLAN_ENFORCEMENT', 'TRIDANT_API_URL', 'TRIDANT_LICENSE_KEY'] as const;
    const savedEnv: Partial<Record<(typeof ENV_KEYS)[number], string>> = {};

    beforeEach(() => {
      for (const key of ENV_KEYS) savedEnv[key] = process.env[key];
      process.env.PLAN_ENFORCEMENT = 'on';
      process.env.TRIDANT_API_URL = 'https://tridant.test';
      process.env.TRIDANT_LICENSE_KEY = 'test-key';
      mockGetEntitlements.mockResolvedValue({
        ok: true,
        resolved: false,
        standing: 'expired',
        inGoodStanding: false,
        ent: { 'owlette.control': '0', 'owlette.hoot': '0' },
        epoch: 0,
      });
    });

    afterEach(() => {
      for (const key of ENV_KEYS) {
        if (savedEnv[key] === undefined) delete process.env[key];
        else process.env[key] = savedEnv[key];
      }
    });

    /** a superadmin payer is unrestricted, so the caller (and site owner) is a plain member here. */
    function asMemberOwner(): void {
      mocks.userDocs.set('user-1', { role: 'member', sites: [SITE] });
    }

    it('402 plan_required for reboot_machine, and nothing is queued', async () => {
      queueIdemOnly();
      asMemberOwner();
      const req = createMockRequest(
        `http://localhost/api/sites/${SITE}/machines/${MACHINE}/commands`,
        {
          method: 'POST',
          headers: { 'Idempotency-Key': 'idem-free-reboot' },
          body: { type: 'reboot_machine' },
        },
      );
      const res = await commandsPOST(req, {
        params: Promise.resolve({ siteId: SITE, machineId: MACHINE }),
      });
      expect(res.status).toBe(402);
      expect(res.headers.get('Content-Type')).toContain('application/problem+json');
      expect(await res.json()).toMatchObject({
        type: 'https://owlette.app/problems/plan-required',
        code: 'plan_required',
        entitlement: 'owlette.control',
        upgradeUrl: '/settings/plan',
      });
      const mergeCalls = mocks.set.mock.calls.filter(
        (c: unknown[]) => (c[1] as { merge?: boolean })?.merge === true,
      );
      expect(mergeCalls).toHaveLength(0);
    });

    it('402 plan_required naming owlette.hoot for mcp_tool_call, the hoot tool path', async () => {
      queueIdemOnly();
      asMemberOwner();
      const req = createMockRequest(
        `http://localhost/api/sites/${SITE}/machines/${MACHINE}/commands`,
        {
          method: 'POST',
          headers: { 'Idempotency-Key': 'idem-free-mcp' },
          body: { type: 'mcp_tool_call', params: { tool_name: 'get_system_info' } },
        },
      );
      const res = await commandsPOST(req, {
        params: Promise.resolve({ siteId: SITE, machineId: MACHINE }),
      });
      expect(res.status).toBe(402);
      expect(await res.json()).toMatchObject({ code: 'plan_required', entitlement: 'owlette.hoot' });
    });

    it('202 for update_owlette, which every plan keeps', async () => {
      queueIdemAndMachine({ online: true });
      asMemberOwner();
      const req = createMockRequest(
        `http://localhost/api/sites/${SITE}/machines/${MACHINE}/commands`,
        {
          method: 'POST',
          headers: { 'Idempotency-Key': 'idem-free-update' },
          body: {
            type: 'update_owlette',
            params: { installer_url: 'https://example.test/i.exe', target_version: '4.1.7', checksum_sha256: 'a'.repeat(64) },
          },
        },
      );
      const res = await commandsPOST(req, {
        params: Promise.resolve({ siteId: SITE, machineId: MACHINE }),
      });
      expect(res.status).toBe(202);
      expect(lastMergedCommand().type).toBe('update_owlette');
    });
  });
});

/* GET .../commands/{commandId} — status */
describe('GET /api/sites/{siteId}/machines/{machineId}/commands/{commandId}', () => {
  const CID = 'cmd_test_status_1';

  /**
   * Two `mocks.get` resolutions (pending, completed) plus a throwing fallback, so an unexpected
   * third read fails loudly instead of consuming a queued value leaked from the previous test —
   * `clearAllMocks` does NOT clear `mockResolvedValueOnce` queues.
   */
  function queueGetSnapshots(
    pending: Record<string, unknown> | null,
    completed: Record<string, unknown> | null,
  ): void {
    mocks.get.mockReset();
    mocks.get
      .mockResolvedValueOnce(docSnapshot('pending', pending))
      .mockResolvedValueOnce(docSnapshot('completed', completed))
      .mockImplementation(() => {
        throw new Error('unexpected extra firestore read on commandStatus GET');
      });
  }

  it('200 pending shape from pending queue', async () => {
    queueGetSnapshots(
      { [CID]: { type: 'reboot_machine', status: 'pending', timestamp: 1_700_000_000_000 } },
      null,
    );
    const req = createMockRequest(
      `http://localhost/api/sites/${SITE}/machines/${MACHINE}/commands/${CID}`,
    );
    const res = await commandStatusGET(req, {
      params: Promise.resolve({ siteId: SITE, machineId: MACHINE, commandId: CID }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.data.commandId).toBe(CID);
    expect(body.data.status).toBe('pending');
    expect(body.data.result).toBeUndefined();
  });

  it('200 running marker on completed doc surfaces as in_progress (not completed)', async () => {
    // The agent writes {status:'running', startedAt} to the completed doc at command START
    // (restart safety); that must not read as completed-with-empty-result.
    queueGetSnapshots(null, {
      [CID]: { type: 'mcp_tool_call', status: 'running', startedAt: 1_700_000_000_000 },
    });
    const req = createMockRequest(
      `http://localhost/api/sites/${SITE}/machines/${MACHINE}/commands/${CID}`,
    );
    const res = await commandStatusGET(req, {
      params: Promise.resolve({ siteId: SITE, machineId: MACHINE, commandId: CID }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data.status).toBe('in_progress');
    expect(body.data.result).toBeUndefined();
    expect(body.data.error).toBeUndefined();
  });

  it.each(['downloading', 'installing'] as const)(
    '200 %s progress marker on completed doc surfaces as in_progress',
    async (status) => {
      queueGetSnapshots(null, {
        [CID]: { type: 'install_software', status, deployment_id: 'dep-1', progress: 42 },
      });
      const req = createMockRequest(
        `http://localhost/api/sites/${SITE}/machines/${MACHINE}/commands/${CID}`,
      );
      const res = await commandStatusGET(req, {
        params: Promise.resolve({ siteId: SITE, machineId: MACHINE, commandId: CID }),
      });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.data.status).toBe('in_progress');
    },
  );

  it('200 completed capture_screenshot mints fresh signed read url', async () => {
    queueGetSnapshots(null, {
      [CID]: {
        type: 'capture_screenshot',
        status: 'completed',
        screenshot_path: `screenshots/${SITE}/${MACHINE}/1700000000000-aabbccdd.png`,
        timestamp: 1_700_000_000_000,
        updatedAt: 1_700_000_000_500,
      },
    });
    const req = createMockRequest(
      `http://localhost/api/sites/${SITE}/machines/${MACHINE}/commands/${CID}`,
    );
    const res = await commandStatusGET(req, {
      params: Promise.resolve({ siteId: SITE, machineId: MACHINE, commandId: CID }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data.status).toBe('completed');
    expect(body.data.result.screenshot_url).toMatch(/^https:\/\/signed\.example\/read-/);
    expect(body.data.result.expires_at).toBeDefined();

    // Read url expiry is ~1h, not the 5min a write url gets.
    const read = signedUrlCalls.find((c) => c.action === 'read');
    expect(read).toBeDefined();
    const ttlMs = (read!.expires as Date).getTime() - Date.now();
    expect(ttlMs).toBeGreaterThan(50 * 60 * 1000); // > 50 min
    expect(ttlMs).toBeLessThanOrEqual(60 * 60 * 1000 + 1000); // ≤ 1h + slack
  });

  it('200 completed capture_screenshot accepts agent result.storage_path', async () => {
    const storagePath = `screenshots/${SITE}/${MACHINE}/1700000000000-storage-path.jpg`;
    queueGetSnapshots(null, {
      [CID]: {
        type: 'capture_screenshot',
        status: 'completed',
        result: { storage_path: storagePath },
      },
    });
    const req = createMockRequest(
      `http://localhost/api/sites/${SITE}/machines/${MACHINE}/commands/${CID}`,
    );
    const res = await commandStatusGET(req, {
      params: Promise.resolve({ siteId: SITE, machineId: MACHINE, commandId: CID }),
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data.result.screenshot_url).toMatch(/^https:\/\/signed\.example\/read-/);
    expect(fakeBucket.file).toHaveBeenLastCalledWith(storagePath);
  });

  it('200 failed shape surfaces error string', async () => {
    queueGetSnapshots(null, {
      [CID]: { type: 'reboot_machine', status: 'failed', error: 'reboot blocked: kiosk lock' },
    });
    const req = createMockRequest(
      `http://localhost/api/sites/${SITE}/machines/${MACHINE}/commands/${CID}`,
    );
    const res = await commandStatusGET(req, {
      params: Promise.resolve({ siteId: SITE, machineId: MACHINE, commandId: CID }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data.status).toBe('failed');
    expect(body.data.error).toContain('reboot blocked');
  });

  it('200 cancelled terminal status maps to failed and surfaces the error', async () => {
    // `cancelled` has no CommandStatus variant; it is terminal and maps to `failed`.
    queueGetSnapshots(null, {
      [CID]: { type: 'mcp_tool_call', status: 'cancelled', error: 'cancelled by user' },
    });
    const req = createMockRequest(
      `http://localhost/api/sites/${SITE}/machines/${MACHINE}/commands/${CID}`,
    );
    const res = await commandStatusGET(req, {
      params: Promise.resolve({ siteId: SITE, machineId: MACHINE, commandId: CID }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data.status).toBe('failed');
    expect(body.data.error).toBe('cancelled by user');
  });

  it('404 when command id not in either queue', async () => {
    queueGetSnapshots(null, null);
    const req = createMockRequest(
      `http://localhost/api/sites/${SITE}/machines/${MACHINE}/commands/${CID}`,
    );
    const res = await commandStatusGET(req, {
      params: Promise.resolve({ siteId: SITE, machineId: MACHINE, commandId: CID }),
    });
    expect(res.status).toBe(404);
  });

  it('400 when commandId fails format validation', async () => {
    const req = createMockRequest(
      `http://localhost/api/sites/${SITE}/machines/${MACHINE}/commands/not_a_cmd`,
    );
    const res = await commandStatusGET(req, {
      params: Promise.resolve({ siteId: SITE, machineId: MACHINE, commandId: 'not_a_cmd' }),
    });
    expect(res.status).toBe(400);
  });

  it('403 scope_insufficient when key lacks machine:read', async () => {
    mockResolveAuth.mockResolvedValue(
      authedKey([{ resource: 'site', id: SITE, permissions: ['read'] }]),
    );
    mocks.get.mockReset();
    mocks.get.mockImplementation(() => {
      throw new Error('unexpected extra firestore read on commandStatus GET');
    });
    const req = createMockRequest(
      `http://localhost/api/sites/${SITE}/machines/${MACHINE}/commands/${CID}`,
    );
    const res = await commandStatusGET(req, {
      params: Promise.resolve({ siteId: SITE, machineId: MACHINE, commandId: CID }),
    });
    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.code).toBe('scope_insufficient');
  });

  it('GET does NOT emit a mutation audit event', async () => {
    queueGetSnapshots(
      { [CID]: { type: 'reboot_machine', status: 'pending' } },
      null,
    );
    const req = createMockRequest(
      `http://localhost/api/sites/${SITE}/machines/${MACHINE}/commands/${CID}`,
    );
    await commandStatusGET(req, {
      params: Promise.resolve({ siteId: SITE, machineId: MACHINE, commandId: CID }),
    });
    expect(mockedEmit).not.toHaveBeenCalled();
  });
});

/* POST .../screenshots/upload-url */
describe('POST /api/sites/{siteId}/machines/{machineId}/screenshots/upload-url', () => {
  it('200 issues signed write url with 5-min ttl + canonical path', async () => {
    const req = createMockRequest(
      `http://localhost/api/sites/${SITE}/machines/${MACHINE}/screenshots/upload-url`,
      { method: 'POST', body: {} },
    );
    const res = await uploadUrlPOST(req, {
      params: Promise.resolve({ siteId: SITE, machineId: MACHINE }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.data.uploadUrl).toMatch(/^https:\/\/signed\.example\/write-/);
    expect(body.data.storagePath).toMatch(
      new RegExp(`^screenshots/${SITE}/${MACHINE}/\\d+-[a-f0-9]{8}\\.png$`),
    );
    expect(body.data.contentType).toBe('image/png');

    const write = signedUrlCalls.find((c) => c.action === 'write');
    expect(write).toBeDefined();
    const ttlMs = (write!.expires as Date).getTime() - Date.now();
    expect(ttlMs).toBeGreaterThan(4 * 60 * 1000); // > 4 min
    expect(ttlMs).toBeLessThanOrEqual(5 * 60 * 1000 + 1000); // ≤ 5 min + slack
    expect(write!.contentType).toBe('image/png');
  });

  it('200 honors contentType: image/jpeg override', async () => {
    const req = createMockRequest(
      `http://localhost/api/sites/${SITE}/machines/${MACHINE}/screenshots/upload-url`,
      { method: 'POST', body: { contentType: 'image/jpeg' } },
    );
    const res = await uploadUrlPOST(req, {
      params: Promise.resolve({ siteId: SITE, machineId: MACHINE }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data.contentType).toBe('image/jpeg');
    const write = signedUrlCalls.find((c) => c.action === 'write');
    expect(write!.contentType).toBe('image/jpeg');
  });

  it('400 when contentType is not an allowed mime', async () => {
    const req = createMockRequest(
      `http://localhost/api/sites/${SITE}/machines/${MACHINE}/screenshots/upload-url`,
      { method: 'POST', body: { contentType: 'application/pdf' } },
    );
    const res = await uploadUrlPOST(req, {
      params: Promise.resolve({ siteId: SITE, machineId: MACHINE }),
    });
    expect(res.status).toBe(400);
  });

  it('403 scope_insufficient when key lacks machine:write', async () => {
    mockResolveAuth.mockResolvedValue(
      authedKey([{ resource: 'machine', id: MACHINE, permissions: ['read'] }]),
    );
    mocks.get.mockReset();
    mocks.get.mockImplementation(() => {
      throw new Error('unexpected extra firestore read on screenshot upload-url POST');
    });
    const req = createMockRequest(
      `http://localhost/api/sites/${SITE}/machines/${MACHINE}/screenshots/upload-url`,
      { method: 'POST', body: {} },
    );
    const res = await uploadUrlPOST(req, {
      params: Promise.resolve({ siteId: SITE, machineId: MACHINE }),
    });
    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.code).toBe('scope_insufficient');
  });
});

/* control-plane billing lockout (billing-system wave 0.6) */
