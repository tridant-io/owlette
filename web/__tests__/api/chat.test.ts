/** @jest-environment node */

/**
 * Http-shape coverage for the public Hoot conversation endpoints (list,
 * create, send+stream, rename, soft-delete): scope-pass, scope-fail, and the
 * per-verb happy/error paths (validation, 404, idempotency replay, sse smoke).
 *
 * Storage is mocked at the `chatStorage.server` boundary so this exercises
 * routing + auth + audit only; the helpers have their own unit tests in
 * `lib/__tests__/chatStorage.test.ts`.
 */

import { NextRequest } from 'next/server';

// Mocks

jest.mock('@sentry/nextjs', () => ({
  captureException: jest.fn(),
  captureMessage: jest.fn(),
}));

const mockRequireChatAuth = jest.fn();
const mockRequireChatAuthDefault = () => ({
  ok: true as const,
  userId: 'user-1',
  auth: { userId: 'user-1', keyContext: null },
  scopeCheck: { isLegacy: false },
  machineIds: null as readonly string[] | null,
});

jest.mock('@/app/api/_shared', () => {
  const actual = jest.requireActual('@/app/api/_shared');
  return {
    ...actual,
    requireChatAuthAndScope: (...a: unknown[]) => mockRequireChatAuth(...a),
  };
});

const mockWithIdempotency = jest.fn(
  async (_req: unknown, _ctx: unknown, _body: unknown, fn: () => Promise<unknown>) => fn(),
);
jest.mock('@/lib/idempotency', () => ({
  withIdempotency: (...args: unknown[]) =>
    mockWithIdempotency(
      ...(args as [unknown, unknown, unknown, () => Promise<unknown>]),
    ),
}));

const mockEmitMutation = jest.fn();
jest.mock('@/lib/auditLogClient', () => ({
  emitMutation: (...args: unknown[]) => mockEmitMutation(...args),
  emitApiKeyUsed: jest.fn(),
  scopeFingerprint: jest.fn(() => 'fp'),
}));

// `getConversation` is the chokepoint — routes call it to discover the
// conversation's siteId before the auth+scope check.
const mockGetConversation = jest.fn();
const mockCreateConversation = jest.fn();
const mockListConversations = jest.fn();
const mockAppendMessage = jest.fn();
const mockSoftDelete = jest.fn();
const mockRename = jest.fn();
jest.mock('@/lib/chatStorage.server', () => {
  const actual = jest.requireActual('@/lib/chatStorage.server');
  return {
    ...actual,
    getConversation: (...a: unknown[]) => mockGetConversation(...a),
    createConversation: (...a: unknown[]) => mockCreateConversation(...a),
    listConversations: (...a: unknown[]) => mockListConversations(...a),
    appendMessage: (...a: unknown[]) => mockAppendMessage(...a),
    softDeleteConversation: (...a: unknown[]) => mockSoftDelete(...a),
    renameConversation: (...a: unknown[]) => mockRename(...a),
  };
});

// Mocked at the module boundary so no real LLM is needed.
const mockRunHootStream = jest.fn();
jest.mock('@/lib/hootStream.server', () => {
  const actual = jest.requireActual('@/lib/hootStream.server');
  return {
    ...actual,
    runHootStream: (...a: unknown[]) => mockRunHootStream(...a),
  };
});

// The send chain test runs the real runHootStream over these: a site admin, one
// online machine, a scripted model. Nothing else here reaches them.
jest.mock('@/lib/hoot-utils.server', () => ({
  __esModule: true,
  verifyUserSiteAccess: async () => ({ role: 'admin', isSiteAdmin: true, standing: { machineIds: null } }),
  resolveHootMaxTier: () => 1,
  listSiteMachines: async () => [{ id: 'm1', online: true, hootEnabled: true, activeHoursGuard: false }],
  getHootRequireTier3Approval: async () => true,
  buildExecutableTools: () => ({}),
  resolveLlmConfig: async () => ({ provider: 'anthropic', apiKey: 'k', model: 'm' }),
}));
const mockCreateModel = jest.fn();
jest.mock('@/lib/llm', () => ({
  __esModule: true,
  createModel: (...a: unknown[]) => mockCreateModel(...a),
  buildSystemPrompt: () => 'system prompt',
}));
jest.mock('@/lib/hoot/advisor', () => ({
  __esModule: true,
  withAdvisor: (_config: unknown, tools: unknown) => ({ tools }),
}));

// Site scoping resolves from MEMBER ROWS, not the legacy `users/{uid}.sites[]`.
// This mock used to target `getUserSiteIds` in apiHelpers; when the routes moved
// to `listUserSiteIds` the old mock silently stopped intercepting, and these
// tests failed loudly rather than passing against unmocked Firestore — which is
// the outcome you want from a mock that has drifted.
const mockListUserSiteIds = jest.fn();
jest.mock('@/lib/membership.server', () => {
  const actual = jest.requireActual('@/lib/membership.server');
  return {
    ...actual,
    listUserSiteIds: (...a: unknown[]) => mockListUserSiteIds(...a),
  };
});

// the real gate by default, which with PLAN_ENFORCEMENT unset answers before any read.
const mockRequireEntitlement = jest.fn();
jest.mock('@/lib/plan.server', () => ({
  ...jest.requireActual('@/lib/plan.server'),
  requireEntitlement: (...a: unknown[]) => mockRequireEntitlement(...a),
}));

const mockResolveAuth = jest.fn();
jest.mock('@/lib/apiAuth.server', () => {
  const actual = jest.requireActual('@/lib/apiAuth.server');
  return {
    ...actual,
    resolveAuth: (...a: unknown[]) => mockResolveAuth(...a),
  };
});

// GET list uses this for owned-sites; the per-conversation routes use it for
// the superadmin override. Defaults to "no role" so that escape hatch is shut.
const mockOwnedSitesGet = jest.fn().mockResolvedValue({ docs: [] });
const mockUserDocGet = jest.fn().mockResolvedValue({
  exists: false,
  data: () => null,
});
// The real idempotency wrapper's cache, for the send chain test.
const mockIdempotencyCache = new Map<string, unknown>();
jest.mock('@/lib/firebase-admin', () => ({
  getAdminDb: () => ({
    collection: (name: string) => {
      if (name === 'users') {
        return { doc: () => ({ get: mockUserDocGet }) };
      }
      if (name === 'idempotency_cache') {
        return {
          doc: (id: string) => ({
            get: async () => ({ exists: mockIdempotencyCache.has(id), data: () => mockIdempotencyCache.get(id) }),
            set: async (data: unknown) => {
              mockIdempotencyCache.set(id, data);
            },
          }),
        };
      }
      return { where: () => ({ get: mockOwnedSitesGet }) };
    },
  }),
  getAdminAuth: () => ({
    verifyIdToken: jest.fn().mockRejectedValue(new Error('n/a')),
  }),
}));

import { Timestamp } from 'firebase-admin/firestore';
import { MockLanguageModelV3, simulateReadableStream } from 'ai/test';

import {
  GET as listGET,
  POST as newPOST,
} from '@/app/api/hoot/conversations/route';
import {
  POST as sendPOST,
  PATCH as renamePATCH,
  DELETE as deleteDELETE,
} from '@/app/api/hoot/conversations/[conversationId]/route';
import { POST as chatAliasSendPOST } from '@/app/api/chat/[conversationId]/route';
import { POST as chatNewPOST } from '@/app/api/chat/new/route';
import { problemPlanRequired } from '@/lib/apiErrors';
import { PLAN_REQUIRED_DETAIL } from '@/lib/plan.server';

const { requireEntitlement: realRequireEntitlement } = jest.requireActual('@/lib/plan.server');

// Helpers

const SITE = 'site-alpha';
const CONV = 'conv_abc123';

function jsonReq(
  url: string,
  method: string,
  body?: unknown,
  headers: Record<string, string> = {},
) {
  return new NextRequest(url, {
    method,
    headers: { 'content-type': 'application/json', ...headers } as HeadersInit,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
}

function ctx(conversationId = CONV) {
  return { params: Promise.resolve({ conversationId }) };
}

function mockConversation(overrides: Record<string, unknown> = {}) {
  const now = Timestamp.now();
  return {
    conversationId: CONV,
    title: 'fixture chat',
    siteId: SITE,
    ownerUid: 'user-1',
    createdAt: now,
    updatedAt: now,
    messages: [],
    messageCount: 0,
    ...overrides,
  };
}

function makeProblemResponse(status: number, code: string, title: string) {
  return new Response(
    JSON.stringify({ type: 'about:blank', title, status, code, detail: title }),
    { status, headers: { 'Content-Type': 'application/problem+json' } },
  ) as unknown as import('next/server').NextResponse;
}

function authForbidden() {
  mockRequireChatAuth.mockResolvedValueOnce({
    ok: false,
    response: makeProblemResponse(403, 'scope_insufficient', 'forbidden'),
  });
}

function authUnauthorized() {
  mockRequireChatAuth.mockResolvedValueOnce({
    ok: false,
    response: makeProblemResponse(401, 'unauthorized', 'unauthorized'),
  });
}

beforeEach(() => {
  jest.clearAllMocks();
  mockRequireChatAuth.mockResolvedValue(mockRequireChatAuthDefault());
  mockResolveAuth.mockResolvedValue({ userId: 'user-1', keyContext: null });
  mockListUserSiteIds.mockResolvedValue([SITE]);
  mockOwnedSitesGet.mockResolvedValue({ docs: [] });
  mockWithIdempotency.mockImplementation(async (_req, _ctx, _body, fn) => fn());
  mockGetConversation.mockResolvedValue(mockConversation());
  mockCreateConversation.mockImplementation(async (input: { siteId: string; ownerUid: string; machineId?: string; title?: string; initialMessages?: unknown[] }) => {
    const now = Timestamp.now();
    return {
      conversationId: CONV,
      title: input.title?.trim() || 'untitled chat',
      siteId: input.siteId,
      ownerUid: input.ownerUid,
      machineId: input.machineId,
      createdAt: now,
      updatedAt: now,
      messages: (input.initialMessages ?? []).map((m: unknown) => ({
        ...(m as Record<string, unknown>),
        timestamp: now,
      })),
      messageCount: (input.initialMessages ?? []).length,
    };
  });
  mockListConversations.mockResolvedValue({
    conversations: [mockConversation()],
    nextPageToken: '',
  });
  mockAppendMessage.mockResolvedValue({ messageCount: 1, spilled: false });
  mockRequireEntitlement.mockImplementation(realRequireEntitlement);
  mockSoftDelete.mockResolvedValue({ alreadyDeleted: false, deletedAt: Timestamp.now() });
  mockRename.mockImplementation(async (_id: string, title: unknown) => ({
    title: typeof title === 'string' ? title.trim() : 'untitled chat',
  }));

  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    start(controller) {
      controller.enqueue(encoder.encode('0:"hello"\n'));
      controller.enqueue(encoder.encode('d:{"finishReason":"stop"}\n'));
      controller.close();
    },
  });
  mockRunHootStream.mockResolvedValue({
    ok: true,
    response: new Response(stream, {
      headers: {
        'Content-Type': 'text/plain; charset=utf-8',
        'X-Vercel-AI-Data-Stream': 'v1',
      },
    }),
  });
});

// GET /api/hoot/conversations - list

describe('GET /api/hoot/conversations', () => {
  it('200 with conversations + pagination shape', async () => {
    const res = await listGET(jsonReq('http://localhost/api/hoot/conversations', 'GET'));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(Array.isArray(body.data.conversations)).toBe(true);
    expect(body.data.conversations[0].conversationId).toBe(CONV);
    expect(body.data).toHaveProperty('nextPageToken');
    expect(body.data).toHaveProperty('next_page_token');
  });

  it('returns empty list when caller has zero accessible sites', async () => {
    mockListUserSiteIds.mockResolvedValueOnce([]);
    mockOwnedSitesGet.mockResolvedValueOnce({ docs: [] });
    const res = await listGET(jsonReq('http://localhost/api/hoot/conversations', 'GET'));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data.conversations).toEqual([]);
    expect(mockListConversations).not.toHaveBeenCalled();
  });

  it('respects api-key chat scope intersection', async () => {
    mockResolveAuth.mockResolvedValueOnce({
      userId: 'user-1',
      keyContext: {
        keyId: 'k1',
        scopes: [{ resource: 'chat', id: SITE, permissions: ['read'] }],
        environment: 'live',
        expiresAt: Date.now() + 60_000,
        isLegacy: false,
      },
    });
    mockListUserSiteIds.mockResolvedValueOnce([SITE, 'other-site']);
    await listGET(jsonReq('http://localhost/api/hoot/conversations', 'GET'));
    const passed = mockListConversations.mock.calls[0][0];
    expect(passed.siteIds.sort()).toEqual([SITE]);
  });

  it('filters by explicit siteId when provided', async () => {
    mockListUserSiteIds.mockResolvedValueOnce([SITE, 'other-site']);
    await listGET(jsonReq(`http://localhost/api/hoot/conversations?siteId=${SITE}`, 'GET'));
    const passed = mockListConversations.mock.calls[0][0];
    expect(passed.siteIds).toEqual([SITE]);
  });

  it('returns an empty page for a siteId outside readable scope', async () => {
    mockListUserSiteIds.mockResolvedValueOnce([SITE]);
    const res = await listGET(
      jsonReq('http://localhost/api/hoot/conversations?siteId=other-site', 'GET'),
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data.conversations).toEqual([]);
    expect(mockListConversations).not.toHaveBeenCalled();
  });

  it('honors owner=me filter', async () => {
    await listGET(jsonReq('http://localhost/api/hoot/conversations?owner=me', 'GET'));
    const passed = mockListConversations.mock.calls[0][0];
    expect(passed.ownerUid).toBe('user-1');
  });

  it('emits no audit on read', async () => {
    await listGET(jsonReq('http://localhost/api/hoot/conversations', 'GET'));
    expect(mockEmitMutation).not.toHaveBeenCalled();
  });
});

// POST /api/hoot/conversations - create

describe('POST /api/hoot/conversations', () => {
  it('201 with full conversation payload', async () => {
    const res = await newPOST(
      jsonReq(
        'http://localhost/api/hoot/conversations',
        'POST',
        { siteId: SITE, title: 'first one' },
        { 'idempotency-key': 'k1' },
      ),
    );
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.data.conversationId).toBe(CONV);
    expect(body.data.title).toBe('first one');
  });

  it('400 when siteId is missing', async () => {
    const res = await newPOST(
      jsonReq('http://localhost/api/hoot/conversations', 'POST', {}, { 'idempotency-key': 'k' }),
    );
    expect(res.status).toBe(400);
  });

  it('400 when initial_message has invalid role', async () => {
    const res = await newPOST(
      jsonReq(
        'http://localhost/api/hoot/conversations',
        'POST',
        { siteId: SITE, initial_message: { role: 'invalid', content: 'x' } },
        { 'idempotency-key': 'k' },
      ),
    );
    expect(res.status).toBe(400);
  });

  it('400 when initial_message uses assistant or system role', async () => {
    const res = await newPOST(
      jsonReq(
        'http://localhost/api/hoot/conversations',
        'POST',
        { siteId: SITE, initial_message: { role: 'system', content: 'x' } },
        { 'idempotency-key': 'k' },
      ),
    );
    expect(res.status).toBe(400);
  });

  it('403 when scope insufficient', async () => {
    authForbidden();
    const res = await newPOST(
      jsonReq(
        'http://localhost/api/hoot/conversations',
        'POST',
        { siteId: SITE },
        { 'idempotency-key': 'k' },
      ),
    );
    expect(res.status).toBe(403);
  });

  it('emits chat_mutated audit on create', async () => {
    await newPOST(
      jsonReq(
        'http://localhost/api/hoot/conversations',
        'POST',
        { siteId: SITE },
        { 'idempotency-key': 'k' },
      ),
    );
    expect(mockEmitMutation).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: 'chat_mutated',
        targetId: CONV,
        attributes: expect.objectContaining({
          verb: 'create',
          endpoint: '/api/hoot/conversations',
          method: 'POST',
          siteId: SITE,
        }),
      }),
    );
  });

  it('replays cached idempotency response', async () => {
    mockWithIdempotency.mockImplementationOnce(async () => {
      const { NextResponse } = await import('next/server');
      const r = NextResponse.json({ ok: true, data: { conversationId: 'cached' } }, { status: 201 });
      r.headers.set('Idempotent-Replayed', 'true');
      return r;
    });
    const res = await newPOST(
      jsonReq(
        'http://localhost/api/hoot/conversations',
        'POST',
        { siteId: SITE },
        { 'idempotency-key': 'k' },
      ),
    );
    expect(res.headers.get('Idempotent-Replayed')).toBe('true');
  });
});

// POST /api/hoot/conversations and its /api/chat/new copy - machine scope

describe.each([
  ['/api/hoot/conversations', newPOST],
  ['/api/chat/new', chatNewPOST],
])('POST %s — machine scope', (path, create) => {
  function createRequest(body: Record<string, unknown>) {
    return jsonReq(`http://localhost${path}`, 'POST', { siteId: SITE, ...body }, {
      'idempotency-key': 'scope',
    });
  }

  function scopedTo(machineIds: readonly string[] | null) {
    mockRequireChatAuth.mockResolvedValueOnce({ ...mockRequireChatAuthDefault(), machineIds });
  }

  it('404 for a machine outside the scope, with nothing written', async () => {
    scopedTo(['m1']);
    const res = await create(createRequest({ machineId: 'm2' }));
    expect(res.status).toBe(404);
    expect(await res.json()).toMatchObject({
      status: 404,
      detail: 'machine not found or no access',
    });
    expect(mockWithIdempotency).not.toHaveBeenCalled();
    expect(mockCreateConversation).not.toHaveBeenCalled();
    expect(mockEmitMutation).not.toHaveBeenCalled();
  });

  it('201 pinned to a machine inside the scope', async () => {
    scopedTo(['m1']);
    const res = await create(createRequest({ machineId: 'm1' }));
    expect(res.status).toBe(201);
    expect(mockCreateConversation).toHaveBeenCalledWith(
      expect.objectContaining({ siteId: SITE, machineId: 'm1' }),
    );
  });

  it('201 for a site-wide conversation, which hoot narrows to the scope', async () => {
    scopedTo(['m1']);
    const res = await create(createRequest({}));
    expect(res.status).toBe(201);
    expect(mockCreateConversation).toHaveBeenCalledWith(
      expect.objectContaining({ siteId: SITE, machineId: undefined }),
    );
  });

  it('leaves a whole-site caller unchanged on any machine', async () => {
    scopedTo(null);
    const res = await create(createRequest({ machineId: 'm2' }));
    expect(res.status).toBe(201);
    expect(mockCreateConversation).toHaveBeenCalledWith(
      expect.objectContaining({ machineId: 'm2' }),
    );
  });
});

// POST /api/hoot/conversations/{conversationId} and its /api/chat twin - the payer plan

describe.each([
  ['/api/hoot/conversations', sendPOST],
  ['/api/chat', chatAliasSendPOST],
])('POST %s/{conversationId} — the payer plan', (base, send) => {
  function sendRequest(key: string) {
    return jsonReq(
      `http://localhost${base}/${CONV}`,
      'POST',
      { role: 'user', content: 'restart the kiosk' },
      { 'idempotency-key': key },
    );
  }

  it('402 plan_required before the prompt is stored or the stream starts', async () => {
    mockRequireEntitlement.mockResolvedValue(
      problemPlanRequired(PLAN_REQUIRED_DETAIL['owlette.hoot'], 'owlette.hoot'),
    );

    const res = await send(sendRequest('plan1'), ctx());
    expect(res.status).toBe(402);
    expect(await res.json()).toMatchObject({ code: 'plan_required', entitlement: 'owlette.hoot' });
    expect(mockRequireEntitlement).toHaveBeenCalledWith(SITE, 'owlette.hoot');
    expect(mockAppendMessage).not.toHaveBeenCalled();
    expect(mockRunHootStream).not.toHaveBeenCalled();
    expect(mockEmitMutation).not.toHaveBeenCalled();
  });

  it('streams as before with enforcement off', async () => {
    const res = await send(sendRequest('plan2'), ctx());
    expect(res.status).toBe(200);
    expect(mockRequireEntitlement).toHaveBeenCalledWith(SITE, 'owlette.hoot');
    expect(mockRunHootStream).toHaveBeenCalledTimes(1);
  });
});

// POST /api/hoot/conversations/{conversationId} and its /api/chat twin - machine scope

describe.each([
  ['/api/hoot/conversations', sendPOST],
  ['/api/chat', chatAliasSendPOST],
])('POST %s/{conversationId} — machine scope', (base, send) => {
  function resume(key: string) {
    return send(
      jsonReq(
        `http://localhost${base}/${CONV}`,
        'POST',
        { role: 'user', content: 'restart the kiosk' },
        { 'idempotency-key': key },
      ),
      ctx(),
    );
  }

  beforeEach(() => {
    mockGetConversation.mockResolvedValue(mockConversation({ machineId: 'm2' }));
  });

  it('404 not_found when the pinned machine has left the caller\'s scope', async () => {
    mockRunHootStream.mockResolvedValueOnce({
      ok: false,
      status: 404,
      error: 'machine not found or no access',
    });
    const res = await resume('scope1');
    expect(mockRunHootStream).toHaveBeenCalledWith(expect.objectContaining({ machineId: 'm2' }));
    expect(res.status).toBe(404);
    expect(await res.json()).toMatchObject({
      title: 'not found',
      status: 404,
      detail: 'machine not found or no access',
      code: 'not_found',
    });
  });

  it('keeps hoot stream unavailable for any other refusal', async () => {
    mockRunHootStream.mockResolvedValueOnce({
      ok: false,
      status: 503,
      error: 'machine "m2" appears to be offline.',
    });
    const res = await resume('scope2');
    expect(res.status).toBe(503);
    expect(await res.json()).toMatchObject({
      title: 'hoot stream unavailable',
      status: 503,
      code: 'cortex_unavailable',
    });
  });
});

// POST /api/hoot/conversations/{conversationId} - send + stream

describe('POST /api/hoot/conversations/{conversationId}', () => {
  it('streams an SSE-style text/plain response on happy path', async () => {
    const res = await sendPOST(
      jsonReq(
        `http://localhost/api/hoot/conversations/${CONV}`,
        'POST',
        { role: 'user', content: 'hello' },
        { 'idempotency-key': 'sk1' },
      ),
      ctx(),
    );
    expect(res.status).toBe(200);
    expect(res.headers.get('Content-Type')).toMatch(/text\/plain/);
    expect(res.headers.get('X-Vercel-AI-Data-Stream')).toBe('v1');

    const reader = res.body!.getReader();
    const { value } = await reader.read();
    const decoded = new TextDecoder().decode(value);
    expect(decoded).toContain('0:');
  });

  it('400 when role is invalid', async () => {
    const res = await sendPOST(
      jsonReq(
        `http://localhost/api/hoot/conversations/${CONV}`,
        'POST',
        { role: 'bogus', content: 'x' },
        { 'idempotency-key': 'sk2' },
      ),
      ctx(),
    );
    expect(res.status).toBe(400);
  });

  it('400 when role is assistant or system', async () => {
    const res = await sendPOST(
      jsonReq(
        `http://localhost/api/hoot/conversations/${CONV}`,
        'POST',
        { role: 'assistant', content: 'x' },
        { 'idempotency-key': 'sk2b' },
      ),
      ctx(),
    );
    expect(res.status).toBe(400);
  });

  it('400 when content is missing', async () => {
    const res = await sendPOST(
      jsonReq(
        `http://localhost/api/hoot/conversations/${CONV}`,
        'POST',
        { role: 'user' },
        { 'idempotency-key': 'sk3' },
      ),
      ctx(),
    );
    expect(res.status).toBe(400);
  });

  it('400 when machine override is supplied', async () => {
    const res = await sendPOST(
      jsonReq(
        `http://localhost/api/hoot/conversations/${CONV}`,
        'POST',
        { role: 'user', content: 'x', machineId: 'other-machine' },
        { 'idempotency-key': 'sk3b' },
      ),
      ctx(),
    );
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.code).toBe('forbidden_field');
  });

  it('404 when conversation does not exist', async () => {
    mockGetConversation.mockResolvedValueOnce(null);
    const res = await sendPOST(
      jsonReq(
        `http://localhost/api/hoot/conversations/${CONV}`,
        'POST',
        { role: 'user', content: 'x' },
        { 'idempotency-key': 'sk4' },
      ),
      ctx(),
    );
    expect(res.status).toBe(404);
  });

  it('404 when conversation is soft-deleted', async () => {
    mockGetConversation.mockResolvedValueOnce(
      mockConversation({ deletedAt: Timestamp.now() }),
    );
    const res = await sendPOST(
      jsonReq(
        `http://localhost/api/hoot/conversations/${CONV}`,
        'POST',
        { role: 'user', content: 'x' },
        { 'idempotency-key': 'sk5' },
      ),
      ctx(),
    );
    expect(res.status).toBe(404);
  });

  it('403 when scope insufficient', async () => {
    authForbidden();
    const res = await sendPOST(
      jsonReq(
        `http://localhost/api/hoot/conversations/${CONV}`,
        'POST',
        { role: 'user', content: 'x' },
        { 'idempotency-key': 'sk6' },
      ),
      ctx(),
    );
    expect(res.status).toBe(403);
  });

  it('404 when caller is not the conversation owner (cross-user hijack)', async () => {
    // Valid site scope, but another user's conversation.
    mockGetConversation.mockResolvedValueOnce(
      mockConversation({ ownerUid: 'other-user' }),
    );
    const res = await sendPOST(
      jsonReq(
        `http://localhost/api/hoot/conversations/${CONV}`,
        'POST',
        { role: 'user', content: 'x' },
        { 'idempotency-key': 'sk-hijack' },
      ),
      ctx(),
    );
    // 404, not 403 — don't leak that another user's chat exists.
    expect(res.status).toBe(404);
    expect(mockAppendMessage).not.toHaveBeenCalled();
    expect(mockRunHootStream).not.toHaveBeenCalled();
  });

  it('200 when caller is superadmin overriding owner check', async () => {
    mockUserDocGet.mockResolvedValueOnce({
      exists: true,
      data: () => ({ role: 'superadmin' }),
    });
    mockGetConversation.mockResolvedValueOnce(
      mockConversation({ ownerUid: 'other-user' }),
    );
    const res = await sendPOST(
      jsonReq(
        `http://localhost/api/hoot/conversations/${CONV}`,
        'POST',
        { role: 'user', content: 'x' },
        { 'idempotency-key': 'sk-super' },
      ),
      ctx(),
    );
    expect(res.status).toBe(200);
  });

  it('503 when hoot stream reports machine offline', async () => {
    mockRunHootStream.mockResolvedValueOnce({
      ok: false,
      status: 503,
      error: 'machine offline',
    });
    const res = await sendPOST(
      jsonReq(
        `http://localhost/api/hoot/conversations/${CONV}`,
        'POST',
        { role: 'user', content: 'x' },
        { 'idempotency-key': 'sk7' },
      ),
      ctx(),
    );
    expect(res.status).toBe(503);
  });

  it('persists the user message and emits audit on send', async () => {
    await sendPOST(
      jsonReq(
        `http://localhost/api/hoot/conversations/${CONV}`,
        'POST',
        { role: 'user', content: 'persistent' },
        { 'idempotency-key': 'sk8' },
      ),
      ctx(),
    );
    expect(mockAppendMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        conversationId: CONV,
        role: 'user',
        content: 'persistent',
      }),
    );
    expect(mockEmitMutation).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: 'chat_mutated',
        targetId: CONV,
        attributes: expect.objectContaining({
          verb: 'send',
          endpoint: `/api/hoot/conversations/${CONV}`,
        }),
      }),
    );
  });

  it('caps API-key callers to tier-1 Hoot tools', async () => {
    mockRequireChatAuth.mockResolvedValueOnce({
      ok: true,
      userId: 'user-1',
      auth: {
        userId: 'user-1',
        // a key's own tool tier is about the commands route; chat stays read only
        keyContext: { keyId: 'k1', environment: 'live', maxToolTier: 3 },
      },
      scopeCheck: { isLegacy: false },
    });
    await sendPOST(
      jsonReq(
        `http://localhost/api/hoot/conversations/${CONV}`,
        'POST',
        { role: 'user', content: 'x' },
        { 'idempotency-key': 'sk9' },
      ),
      ctx(),
    );
    expect(mockRunHootStream).toHaveBeenCalledWith(
      expect.objectContaining({ maxToolTier: 1 }),
    );
  });
});

/**
 * The whole send chain, as `owlette chat send` runs it: the real idempotency
 * wrapper and the real runHootStream over a scripted model. The tests above stub
 * runHootStream, which is how hoot's replies went unsaved with nothing red.
 */
describe('POST /api/hoot/conversations/{conversationId} saves hoot reply', () => {
  const PROMPT = 'how is the lobby?';

  function send() {
    return sendPOST(
      jsonReq(
        `http://localhost/api/hoot/conversations/${CONV}`,
        'POST',
        { role: 'user', content: PROMPT },
        { 'idempotency-key': 'reply-1' },
      ),
      ctx(),
    );
  }

  it('saves the reply once, and a replay with the same key saves nothing more', async () => {
    mockIdempotencyCache.clear();
    mockWithIdempotency.mockImplementation(jest.requireActual('@/lib/idempotency').withIdempotency);
    mockRunHootStream.mockImplementation(jest.requireActual('@/lib/hootStream.server').runHootStream);
    mockRequireChatAuth.mockResolvedValue({
      ok: true,
      userId: 'user-1',
      auth: { userId: 'user-1', keyContext: { keyId: 'k1', environment: 'live' } },
      scopeCheck: { isLegacy: false },
    });
    mockGetConversation.mockResolvedValue(
      mockConversation({ messages: [{ role: 'user', content: PROMPT, timestamp: Timestamp.now() }] }),
    );
    mockCreateModel.mockReturnValue(
      new MockLanguageModelV3({
        doStream: async () => ({
          stream: simulateReadableStream({
            chunks: [
              { type: 'text-start' as const, id: 't1' },
              { type: 'text-delta' as const, id: 't1', delta: 'lobby-01 is online' },
              { type: 'text-end' as const, id: 't1' },
              {
                type: 'finish' as const,
                finishReason: { unified: 'stop' as const, raw: undefined },
                usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
              },
            ],
          }),
        }),
      }),
    );

    const first = await send();

    expect(first.status).toBe(200);
    expect(await first.text()).toContain('"delta":"lobby-01 is online"');
    expect(mockAppendMessage.mock.calls.map(([message]) => [message.role, message.content])).toEqual([
      ['user', PROMPT],
      ['assistant', 'lobby-01 is online'],
    ]);

    const replay = await send();

    expect(replay.headers.get('Idempotent-Replayed')).toBe('true');
    expect(await replay.text()).toContain('"delta":"lobby-01 is online"');
    expect(mockAppendMessage).toHaveBeenCalledTimes(2);
  });
});

// PATCH /api/hoot/conversations/{conversationId} - rename

describe('PATCH /api/hoot/conversations/{conversationId}', () => {
  it('200 on title-only update', async () => {
    const res = await renamePATCH(
      jsonReq(
        `http://localhost/api/hoot/conversations/${CONV}`,
        'PATCH',
        { title: 'renamed' },
        { 'idempotency-key': 'pk1' },
      ),
      ctx(),
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data.title).toBe('renamed');
  });

  it('400 forbidden_field when other fields supplied', async () => {
    const res = await renamePATCH(
      jsonReq(
        `http://localhost/api/hoot/conversations/${CONV}`,
        'PATCH',
        { title: 'ok', siteId: 'evil' },
        { 'idempotency-key': 'pk2' },
      ),
      ctx(),
    );
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.code).toBe('forbidden_field');
  });

  it('400 when title missing', async () => {
    const res = await renamePATCH(
      jsonReq(
        `http://localhost/api/hoot/conversations/${CONV}`,
        'PATCH',
        {},
        { 'idempotency-key': 'pk3' },
      ),
      ctx(),
    );
    expect(res.status).toBe(400);
  });

  it('404 when conversation missing', async () => {
    mockGetConversation.mockResolvedValueOnce(null);
    const res = await renamePATCH(
      jsonReq(
        `http://localhost/api/hoot/conversations/${CONV}`,
        'PATCH',
        { title: 'x' },
        { 'idempotency-key': 'pk4' },
      ),
      ctx(),
    );
    expect(res.status).toBe(404);
  });

  it('emits chat_mutated audit on rename', async () => {
    await renamePATCH(
      jsonReq(
        `http://localhost/api/hoot/conversations/${CONV}`,
        'PATCH',
        { title: 'newer' },
        { 'idempotency-key': 'pk5' },
      ),
      ctx(),
    );
    expect(mockEmitMutation).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: 'chat_mutated',
        attributes: expect.objectContaining({
          verb: 'rename',
          endpoint: `/api/hoot/conversations/${CONV}`,
          newTitle: 'newer',
        }),
      }),
    );
  });
});

// DELETE /api/hoot/conversations/{conversationId} - soft delete

describe('DELETE /api/hoot/conversations/{conversationId}', () => {
  it('200 with alreadyDeleted=false on first delete', async () => {
    const res = await deleteDELETE(
      jsonReq(`http://localhost/api/hoot/conversations/${CONV}`, 'DELETE'),
      ctx(),
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data.alreadyDeleted).toBe(false);
  });

  it('200 with alreadyDeleted=true on second delete (true-idempotent)', async () => {
    mockSoftDelete.mockResolvedValueOnce({
      alreadyDeleted: true,
      deletedAt: Timestamp.now(),
    });
    const res = await deleteDELETE(
      jsonReq(`http://localhost/api/hoot/conversations/${CONV}`, 'DELETE'),
      ctx(),
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data.alreadyDeleted).toBe(true);
  });

  it('404 when conversation never existed', async () => {
    mockGetConversation.mockResolvedValueOnce(null);
    const res = await deleteDELETE(
      jsonReq(`http://localhost/api/hoot/conversations/${CONV}`, 'DELETE'),
      ctx(),
    );
    expect(res.status).toBe(404);
  });

  it('403 when scope insufficient', async () => {
    authForbidden();
    const res = await deleteDELETE(
      jsonReq(`http://localhost/api/hoot/conversations/${CONV}`, 'DELETE'),
      ctx(),
    );
    expect(res.status).toBe(403);
  });

  it('401 when caller is unauthorized', async () => {
    authUnauthorized();
    const res = await deleteDELETE(
      jsonReq(`http://localhost/api/hoot/conversations/${CONV}`, 'DELETE'),
      ctx(),
    );
    expect(res.status).toBe(401);
  });

  it('emits chat_mutated audit on delete', async () => {
    await deleteDELETE(
      jsonReq(`http://localhost/api/hoot/conversations/${CONV}`, 'DELETE'),
      ctx(),
    );
    expect(mockEmitMutation).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: 'chat_mutated',
        targetId: CONV,
        attributes: expect.objectContaining({
          verb: 'delete',
          endpoint: `/api/hoot/conversations/${CONV}`,
          method: 'DELETE',
          alreadyDeleted: false,
        }),
      }),
    );
  });
});
