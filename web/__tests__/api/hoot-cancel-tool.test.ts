/** @jest-environment node */

/**
 * Http-shape coverage for POST /api/hoot/cancel-tool (hoot-async-turns wave 2.4).
 *
 * Authz matrix: unauthenticated → 401; api-key without chat=<siteId>:write → 403
 * scope_insufficient; no site access → 403; a machine outside the caller's machine scope →
 * 404, before any chat read; chat missing or wrong site → 404; non-owner
 * chat → 403; commandId absent from stream/current.toolCommands, or recorded for another
 * machine → 400.
 *
 * Dispatch contract: happy path writes the pending `cancel_mcp_tool` command with
 * `target_command_id` on the USER-actor path and returns the agent ack; slow ack → 202
 * { accepted: true }; the export is wrapped in withRateLimit (user strategy).
 */

import { NextRequest } from 'next/server';

jest.mock('@sentry/nextjs', () => ({
  captureException: jest.fn(),
  captureMessage: jest.fn(),
}));

jest.mock('@/lib/withRateLimit', () => {
  // `capturedOptions` is a plain property (not mock state), so the
  // import-time wrapper call survives jest.clearAllMocks() in beforeEach.
  const withRateLimit = Object.assign(
    jest.fn((handler: unknown) => handler as (req: NextRequest) => Promise<Response>),
    { capturedOptions: undefined as unknown },
  );
  withRateLimit.mockImplementation((handler: unknown, options?: unknown) => {
    withRateLimit.capturedOptions = options;
    return handler as (req: NextRequest) => Promise<Response>;
  });
  return {
    __esModule: true,
    withRateLimit,
    getUserIdFromSession: jest.fn(async () => null),
  };
});

const mockResolveAuth = jest.fn();
jest.mock('@/lib/apiAuth.server', () => {
  const actual = jest.requireActual('@/lib/apiAuth.server');
  return {
    ...actual,
    resolveAuth: (...a: unknown[]) => mockResolveAuth(...a),
  };
});

// Full replacement — never load the real hoot-utils.server (owned by a
// sibling task mid-rewrite; only the verifyUserSiteAccess contract is used).
const mockVerifyAccess = jest.fn();
jest.mock('@/lib/hoot-utils.server', () => ({
  verifyUserSiteAccess: (...a: unknown[]) => mockVerifyAccess(...a),
}));

jest.mock('@/lib/auditLogClient', () => ({
  emitMutation: jest.fn(),
}));

// fake firestore (path-keyed docs)

interface SetCall {
  path: string;
  payload: Record<string, unknown>;
  options?: { merge?: boolean };
}

interface FakeDb {
  setCalls: SetCall[];
  updateCalls: Array<{ path: string; payload: Record<string, unknown> }>;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  db: any;
}

const SITE = 'site-a';
const MACHINE = 'mach-1';
const CHAT = 'chat-1';
const TARGET_CMD = 'cmd_target_1';
const COMPLETED_PATH = `sites/${SITE}/machines/${MACHINE}/commands/completed`;
const PENDING_PATH = `sites/${SITE}/machines/${MACHINE}/commands/pending`;

/**
 * `docs` maps doc path → data (null/absent = missing doc). `completedAck`, when set, is
 * served from the completed doc keyed by the cancel command's own generated id.
 */
function buildFakeDb(
  docs: Record<string, Record<string, unknown> | null>,
  completedAck: Record<string, unknown> | null = null,
): FakeDb {
  const setCalls: SetCall[] = [];
  const updateCalls: Array<{ path: string; payload: Record<string, unknown> }> = [];

  function pendingCommandId(pendingPath: string): string | null {
    const pendingSet = setCalls.find((c) => c.path === pendingPath);
    return pendingSet ? Object.keys(pendingSet.payload)[0] : null;
  }

  function makeDocRef(docPath: string): unknown {
    return {
      path: docPath,
      collection: (sub: string) => makeCollectionRef(`${docPath}/${sub}`),
      get: async () => {
        // any machine's completed doc acks the cancel queued on that machine
        if (docPath.endsWith('/commands/completed') && completedAck) {
          const cancelId = pendingCommandId(docPath.replace(/completed$/, 'pending'));
          if (cancelId) {
            return { exists: true, data: () => ({ [cancelId]: completedAck }) };
          }
        }
        const data = docs[docPath];
        return { exists: data != null, data: () => data ?? undefined };
      },
      set: async (payload: Record<string, unknown>, options?: { merge?: boolean }) => {
        setCalls.push({ path: docPath, payload, options });
      },
      update: async (payload: Record<string, unknown>) => {
        updateCalls.push({ path: docPath, payload });
      },
    };
  }

  function makeCollectionRef(colPath: string): unknown {
    return { doc: (id: string) => makeDocRef(`${colPath}/${id}`) };
  }

  return {
    setCalls,
    updateCalls,
    db: { collection: (name: string) => makeCollectionRef(name) },
  };
}

let fake: FakeDb;

jest.mock('@/lib/firebase-admin', () => ({
  getAdminDb: () => fake.db,
  getAdminAuth: () => ({
    verifyIdToken: jest.fn().mockRejectedValue(new Error('n/a')),
  }),
}));

import { POST } from '@/app/api/hoot/cancel-tool/route';
import { ApiAuthError, type ResolvedAuth } from '@/lib/apiAuth.server';
import { withRateLimit } from '@/lib/withRateLimit';
import { emitMutation } from '@/lib/auditLogClient';

// fixtures

function authedSession(): ResolvedAuth {
  return { userId: 'user-1', keyContext: null };
}

function authedKey(scopes: Array<Record<string, unknown>> | null): ResolvedAuth {
  return {
    userId: 'user-1',
    keyContext: {
      keyId: 'key-test',
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      scopes: scopes as any,
      environment: 'live',
      expiresAt: Date.now() + 60_000,
      isLegacy: false,
    },
  };
}

function baseDocs(): Record<string, Record<string, unknown> | null> {
  return {
    [`chats/${CHAT}`]: { siteId: SITE, userId: 'user-1', title: 'test chat' },
    [`chats/${CHAT}/stream/current`]: {
      status: 'running',
      // Nested shape: toolCallId → machineId → { commandId }.
      toolCommands: {
        toolcall_abc: { [MACHINE]: { commandId: TARGET_CMD } },
      },
    },
    [`sites/${SITE}/machines/${MACHINE}`]: { online: true },
  };
}

function cancelRequest(body: Record<string, unknown> = {}): NextRequest {
  return new NextRequest('http://localhost/api/hoot/cancel-tool', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      siteId: SITE,
      machineId: MACHINE,
      chatId: CHAT,
      commandId: TARGET_CMD,
      ...body,
    }),
  });
}

beforeEach(() => {
  jest.clearAllMocks();
  fake = buildFakeDb(baseDocs());
  mockResolveAuth.mockResolvedValue(authedSession());
  mockVerifyAccess.mockResolvedValue(siteAccess(null));
});

/** verifyUserSiteAccess's answer for a site admin; `machineIds` null is the whole site. */
function siteAccess(machineIds: readonly string[] | null) {
  return {
    role: 'admin',
    siteRole: 'admin',
    swoopMode: null,
    standing: { role: 'admin', swoopMode: null, machineIds },
    isSuperadmin: false,
    isSiteAdmin: true,
    isSiteOwner: false,
  };
}

// authz matrix

describe('POST /api/hoot/cancel-tool — authz', () => {
  it('401 when unauthenticated', async () => {
    mockResolveAuth.mockRejectedValue(new ApiAuthError(401, 'Unauthorized: No valid session'));
    const res = await POST(cancelRequest());
    expect(res.status).toBe(401);
    expect(fake.setCalls).toHaveLength(0);
  });

  it('400 when a required field is missing', async () => {
    const res = await POST(cancelRequest({ commandId: undefined }));
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe('siteId, machineId, chatId, and commandId are required');
  });

  it('403 scope_insufficient for an api-key caller without chat write scope', async () => {
    mockResolveAuth.mockResolvedValue(
      authedKey([{ resource: 'machine', id: '*', permissions: ['write'] }]),
    );
    const res = await POST(cancelRequest());
    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.code).toBe('scope_insufficient');
    expect(fake.setCalls).toHaveLength(0);
  });

  it('403 when the caller has no site access', async () => {
    mockVerifyAccess.mockRejectedValue(new Error('You do not have access to this site'));
    const res = await POST(cancelRequest());
    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.error).toBe('you do not have access to this site');
    expect(fake.setCalls).toHaveLength(0);
  });

  it('404 when the chat does not exist', async () => {
    const docs = baseDocs();
    delete docs[`chats/${CHAT}`];
    fake = buildFakeDb(docs);
    const res = await POST(cancelRequest());
    expect(res.status).toBe(404);
    expect((await res.json()).error).toBe('chat not found');
  });

  it('404 when the chat belongs to a different site', async () => {
    const docs = baseDocs();
    docs[`chats/${CHAT}`] = { siteId: 'site-other', userId: 'user-1' };
    fake = buildFakeDb(docs);
    const res = await POST(cancelRequest());
    expect(res.status).toBe(404);
  });

  it('403 when the chat belongs to another user (owner-only)', async () => {
    const docs = baseDocs();
    docs[`chats/${CHAT}`] = { siteId: SITE, userId: 'someone-else' };
    fake = buildFakeDb(docs);
    const res = await POST(cancelRequest());
    expect(res.status).toBe(403);
    expect((await res.json()).error).toBe('you do not own this chat');
    expect(fake.setCalls).toHaveLength(0);
  });

  it('400 when commandId is not in stream/current.toolCommands', async () => {
    const res = await POST(cancelRequest({ commandId: 'cmd_not_mine' }));
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe('unknown commandId for this chat');
    expect(fake.setCalls).toHaveLength(0);
  });

  it('400 when the stream doc is missing entirely', async () => {
    const docs = baseDocs();
    delete docs[`chats/${CHAT}/stream/current`];
    fake = buildFakeDb(docs);
    const res = await POST(cancelRequest());
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe('unknown commandId for this chat');
  });

  it('400 when the commandId was recorded for a different machine', async () => {
    const docs = baseDocs();
    docs[`chats/${CHAT}/stream/current`] = {
      status: 'running',
      // Recorded under mach-other; the request targets MACHINE (mach-1).
      toolCommands: {
        toolcall_abc: { 'mach-other': { commandId: TARGET_CMD } },
      },
    };
    fake = buildFakeDb(docs);
    const res = await POST(cancelRequest());
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe('commandId does not belong to this machine');
    expect(fake.setCalls).toHaveLength(0);
  });

  it('validates a commandId under its (toolCallId, machineId) in a site-wide fan-out; a foreign commandId 400s', async () => {
    // One toolCallId fanned out to two machines, each with its own commandId under its own
    // machine key (the reshape that fixed the flat last-write-wins bug).
    const ack = { status: 'completed', type: 'cancel_mcp_tool' };
    const docs = baseDocs();
    docs[`chats/${CHAT}/stream/current`] = {
      status: 'running',
      toolCommands: {
        toolcall_fanout: {
          [MACHINE]: { commandId: TARGET_CMD },
          'mach-2': { commandId: 'cmd_other_machine' },
        },
      },
    };

    // This machine's recorded command validates and dispatches (200).
    fake = buildFakeDb(docs, ack);
    const ok = await POST(cancelRequest());
    expect(ok.status).toBe(200);
    expect((await ok.json()).accepted).toBe(true);
    expect(fake.setCalls.some((c) => c.path === PENDING_PATH)).toBe(true);

    // A commandId never recorded in the nested index is rejected before dispatch.
    fake = buildFakeDb(docs, ack);
    const bad = await POST(cancelRequest({ commandId: 'cmd_ghost' }));
    expect(bad.status).toBe(400);
    expect((await bad.json()).error).toBe('unknown commandId for this chat');
    expect(fake.setCalls).toHaveLength(0);
  });
});

// dispatch + ack

describe('POST /api/hoot/cancel-tool — dispatch', () => {
  it('200 happy path: writes the pending cancel command and returns the agent ack', async () => {
    const ack = {
      status: 'completed',
      type: 'cancel_mcp_tool',
      result: JSON.stringify({ status: 'cancelled', target_command_id: TARGET_CMD }),
    };
    fake = buildFakeDb(baseDocs(), ack);

    const res = await POST(cancelRequest());
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.accepted).toBe(true);
    expect(body.commandId).toMatch(/^cmd_/);
    expect(body.ack).toMatchObject({ status: 'completed', type: 'cancel_mcp_tool' });

    // Pending write shape: user-actor path, cancel payload.
    const pendingSet = fake.setCalls.find((c) => c.path === PENDING_PATH);
    expect(pendingSet).toBeDefined();
    expect(pendingSet?.options).toEqual({ merge: true });
    const env = pendingSet?.payload as Record<string, Record<string, unknown>>;
    const cmdId = Object.keys(env)[0];
    expect(cmdId).toBe(body.commandId);
    expect(env[cmdId].type).toBe('cancel_mcp_tool');
    expect(env[cmdId].target_command_id).toBe(TARGET_CMD);
    expect(env[cmdId].status).toBe('pending');
    expect(env[cmdId].queuedBy).toBe('user:user-1');

    // Consumed ack is cleaned up best-effort.
    expect(fake.updateCalls.some((c) => c.path === COMPLETED_PATH)).toBe(true);

    // Audit row on the user-actor path.
    expect(emitMutation).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: 'machine_command_dispatched',
        siteId: SITE,
        actor: 'user:user-1',
        attributes: expect.objectContaining({
          commandType: 'cancel_mcp_tool',
          machineId: MACHINE,
        }),
      }),
    );
  });

  it('202 when the ack does not arrive within the poll window', async () => {
    jest.useFakeTimers();
    try {
      fake = buildFakeDb(baseDocs(), null);

      const pending = POST(cancelRequest());
      await jest.advanceTimersByTimeAsync(11_000);
      const res = await pending;

      expect(res.status).toBe(202);
      const body = await res.json();
      expect(body).toMatchObject({ accepted: true });
      expect(body.commandId).toMatch(/^cmd_/);
      // Command was still dispatched.
      expect(fake.setCalls.some((c) => c.path === PENDING_PATH)).toBe(true);
    } finally {
      jest.useRealTimers();
    }
  });

  it('409 when the machine is offline (executeMachineCommand error surface)', async () => {
    const docs = baseDocs();
    docs[`sites/${SITE}/machines/${MACHINE}`] = { online: false };
    fake = buildFakeDb(docs);
    const res = await POST(cancelRequest());
    expect(res.status).toBe(409);
    expect((await res.json()).code).toBe('machine_offline');
  });
});

// machine scope

describe('POST /api/hoot/cancel-tool — machine scope', () => {
  const OTHER = 'mach-2';

  /** a chat whose turn did record a command on OTHER, so only the scope stands in the way */
  function docsWithOtherMachine(): Record<string, Record<string, unknown> | null> {
    const docs = baseDocs();
    docs[`chats/${CHAT}/stream/current`] = {
      status: 'running',
      toolCommands: {
        toolcall_fanout: {
          [MACHINE]: { commandId: TARGET_CMD },
          [OTHER]: { commandId: 'cmd_on_other' },
        },
      },
    };
    docs[`sites/${SITE}/machines/${OTHER}`] = { online: true };
    return docs;
  }

  it('404 for a machine outside the scope, with nothing queued or written', async () => {
    mockVerifyAccess.mockResolvedValue(siteAccess([MACHINE]));
    fake = buildFakeDb(docsWithOtherMachine(), { status: 'completed' });

    const res = await POST(cancelRequest({ machineId: OTHER, commandId: 'cmd_on_other' }));
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: 'machine not found or no access' });
    expect(fake.setCalls).toHaveLength(0);
    expect(fake.updateCalls).toHaveLength(0);
    expect(emitMutation).not.toHaveBeenCalled();
  });

  it('dispatches as before on a machine inside the scope', async () => {
    mockVerifyAccess.mockResolvedValue(siteAccess([MACHINE]));
    fake = buildFakeDb(docsWithOtherMachine(), { status: 'completed' });

    const res = await POST(cancelRequest());
    expect(res.status).toBe(200);
    expect((await res.json()).accepted).toBe(true);
    expect(fake.setCalls.some((c) => c.path === PENDING_PATH)).toBe(true);
  });

  it('leaves a whole-site caller free to cancel on any machine of the site', async () => {
    fake = buildFakeDb(docsWithOtherMachine(), { status: 'completed' });

    const res = await POST(cancelRequest({ machineId: OTHER, commandId: 'cmd_on_other' }));
    expect(res.status).toBe(200);
    expect((await res.json()).accepted).toBe(true);
    expect(
      fake.setCalls.some((c) => c.path === `sites/${SITE}/machines/${OTHER}/commands/pending`),
    ).toBe(true);
  });
});

// rate-limit wrapper

describe('POST /api/hoot/cancel-tool — rate limiting', () => {
  it('exports POST wrapped in withRateLimit with the user strategy', () => {
    // Wrapper options were captured at module import (before clearAllMocks).
    const { capturedOptions } = withRateLimit as unknown as {
      capturedOptions: Record<string, unknown> | undefined;
    };
    expect(capturedOptions).toMatchObject({
      strategy: 'user',
      identifier: 'user',
      getUserId: expect.any(Function),
    });
  });
});
