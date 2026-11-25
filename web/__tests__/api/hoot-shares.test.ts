/** @jest-environment node */

/**
 * Http-shape coverage for the hoot share routes.
 *
 *   POST   /api/hoot/chats/{chatId}/shares
 *   GET    /api/hoot/chats/{chatId}/shares
 *   DELETE /api/hoot/chats/{chatId}/shares/{token}
 *
 * Authz matrix: unauthenticated → 401; no site access → 403; chat missing or in
 * another site → 404; chat owned by someone else, and an autonomous chat with no
 * owner at all → 403; a body without a valid `expiresInDays` → 400 (never a
 * server-side default); a conversation with nothing shareable → 409.
 *
 * The privacy contract is asserted as a negative control on the SERIALIZED
 * stored document — a route that passed the raw messages to the store instead of
 * the snapshot would still return a plausible 201. The audit contract is
 * asserted the same way: exactly one `emitMutation` per mutating call, and the
 * share token in neither its arguments nor any log line, since the token is a
 * bearer credential for the published conversation.
 *
 * The real store and the real snapshot builder run here; only the Firestore
 * handle, the session, and the site-access check are faked.
 */

import { NextRequest } from 'next/server';
import { Timestamp } from 'firebase-admin/firestore';
import type { UIMessage } from 'ai';

jest.mock('@sentry/nextjs', () => ({
  captureException: jest.fn(),
  captureMessage: jest.fn(),
}));

jest.mock('@/lib/withRateLimit', () => {
  // `capturedOptions` is a plain property (not mock state), so the import-time
  // wrapper calls survive jest.clearAllMocks() in beforeEach.
  const withRateLimit = Object.assign(
    jest.fn((handler: unknown) => handler),
    { capturedOptions: [] as unknown[] },
  );
  withRateLimit.mockImplementation((handler: unknown, options?: unknown) => {
    withRateLimit.capturedOptions.push(options);
    return handler;
  });
  return {
    __esModule: true,
    withRateLimit,
    getUserIdFromSession: jest.fn(async () => null),
  };
});

const mockRequireSession = jest.fn();
const mockAssertSiteAccess = jest.fn();
jest.mock('@/lib/apiAuth.server', () => {
  const actual = jest.requireActual('@/lib/apiAuth.server');
  return {
    ...actual,
    requireSession: (...a: unknown[]) => mockRequireSession(...a),
    assertUserHasSiteAccess: (...a: unknown[]) => mockAssertSiteAccess(...a),
  };
});

jest.mock('@/lib/auditLogClient', () => ({
  emitMutation: jest.fn(),
}));

// fake firestore — `chats` reads plus the whole chat_shares collection

const SITE = 'site-a';
const OTHER_SITE = 'site-b';
const CHAT = 'chat-1';
const OTHER_CHAT = 'chat-2';
const UID = 'user-1';

/** Chat docs by id, and share docs by token. */
let chats: Map<string, Record<string, unknown>>;
let shares: Map<string, Record<string, unknown>>;

function shareDocRef(id: string) {
  return {
    id,
    get: async () => ({ exists: shares.has(id), data: () => shares.get(id) }),
    create: async (data: Record<string, unknown>) => {
      if (shares.has(id)) throw new Error(`ALREADY_EXISTS: ${id}`);
      shares.set(id, data);
    },
    update: async (patch: Record<string, unknown>) => {
      shares.set(id, { ...(shares.get(id) ?? {}), ...patch });
    },
  };
}

function shareCollectionRef() {
  const filters: Array<[string, unknown]> = [];
  let cap: number | null = null;
  const query = {
    where(field: string, op: string, value: unknown) {
      if (op !== '==') throw new Error(`unsupported operator: ${op}`);
      filters.push([field, value]);
      return query;
    },
    limit(n: number) {
      cap = n;
      return query;
    },
    get: async () => {
      let matched = [...shares.values()];
      for (const [field, value] of filters) matched = matched.filter((d) => d[field] === value);
      if (cap !== null) matched = matched.slice(0, cap);
      return { docs: matched.map((d) => ({ data: () => d })) };
    },
  };
  return { ...query, doc: shareDocRef };
}

jest.mock('@/lib/firebase-admin', () => ({
  getAdminDb: () => ({
    collection: (name: string) => {
      if (name === 'chats') {
        return {
          doc: (id: string) => ({
            get: async () => ({ exists: chats.has(id), data: () => chats.get(id) }),
          }),
        };
      }
      if (name === 'chat_shares') return shareCollectionRef();
      throw new Error(`unexpected collection: ${name}`);
    },
  }),
  getAdminAuth: () => ({
    verifyIdToken: jest.fn().mockRejectedValue(new Error('n/a')),
  }),
}));

import { GET, POST } from '@/app/api/hoot/chats/[chatId]/shares/route';
import { DELETE } from '@/app/api/hoot/chats/[chatId]/shares/[token]/route';
import { ApiAuthError } from '@/lib/apiAuth.server';
import { emitMutation } from '@/lib/auditLogClient';
import { generateShareToken } from '@/lib/hoot/shareStore.server';
import { SHARE_TOKEN_PATTERN } from '@/lib/hoot/shareTypes';
import { withRateLimit } from '@/lib/withRateLimit';

// fixtures

const TOOL_INPUT_SECRET = 'C:\\shows\\secret-client-project.toe';
const TOOL_OUTPUT_SECRET = 'STUDIO-01 10.0.4.17 Access violation at 0x7ffd';
const NOW_MS = Date.parse('2026-09-09T12:00:00.000Z');
const DAY_MS = 86_400_000;

type Part = UIMessage['parts'][number];

function msg(id: string, role: UIMessage['role'], parts: unknown[]): UIMessage {
  return { id, role, parts: parts as Part[] } as UIMessage;
}

/** Two shareable turns, one of which carries details a share must never publish. */
function conversation(): UIMessage[] {
  return [
    msg('u1', 'user', [{ type: 'text', text: 'why did the deploy fail?' }]),
    msg('a1', 'assistant', [
      {
        type: 'tool-checkLogs',
        toolCallId: 'tool-1',
        state: 'output-available',
        input: { path: TOOL_INPUT_SECRET },
        output: { status: 'warning', detail: TOOL_OUTPUT_SECRET },
      },
      { type: 'text', text: 'the installer exited with a retryable warning.' },
    ]),
  ];
}

function chatDoc(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    siteId: SITE,
    userId: UID,
    title: 'deployment triage',
    machineName: 'STUDIO-01',
    messages: conversation(),
    ...overrides,
  };
}

/** A stored share, seeded straight into the fake for the list/revoke paths. */
function shareDoc(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  const doc = {
    token: generateShareToken(),
    chatId: CHAT,
    siteId: SITE,
    createdBy: UID,
    createdAt: Timestamp.fromMillis(NOW_MS - DAY_MS),
    expiresAt: null,
    revokedAt: null,
    title: 'deployment triage',
    targetLabel: 'STUDIO-01',
    messageCount: 2,
    snapshot: { version: 1, title: 'deployment triage', targetLabel: 'STUDIO-01', messages: [] },
    ...overrides,
  };
  shares.set(doc.token as string, doc);
  return doc;
}

interface ShareBody {
  siteId?: unknown;
  expiresInDays?: unknown;
}

function postRequest(body: ShareBody = { siteId: SITE, expiresInDays: 30 }, chatId = CHAT) {
  return new NextRequest(`http://localhost/api/hoot/chats/${chatId}/shares`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

function getRequest(siteId: string | null = SITE, chatId = CHAT) {
  const query = siteId === null ? '' : `?siteId=${siteId}`;
  return new NextRequest(`http://localhost/api/hoot/chats/${chatId}/shares${query}`);
}

function deleteRequest(token: string, siteId: string | null = SITE, chatId = CHAT) {
  const query = siteId === null ? '' : `?siteId=${siteId}`;
  return new NextRequest(
    `http://localhost/api/hoot/chats/${chatId}/shares/${token}${query}`,
    { method: 'DELETE' },
  );
}

function chatCtx(chatId = CHAT) {
  return { params: Promise.resolve({ chatId }) };
}

function tokenCtx(token: string, chatId = CHAT) {
  return { params: Promise.resolve({ chatId, token }) };
}

/** The single stored share, as the store wrote it. */
function storedShare(): Record<string, unknown> {
  const [only] = [...shares.values()];
  return only;
}

const emitted = () => (emitMutation as jest.Mock).mock.calls;

beforeEach(() => {
  jest.clearAllMocks();
  chats = new Map([[CHAT, chatDoc()]]);
  shares = new Map();
  mockRequireSession.mockResolvedValue(UID);
  mockAssertSiteAccess.mockResolvedValue({ siteId: SITE, siteData: {}, machineIds: null });
});

// authorization

describe('hoot shares — authorization', () => {
  it('401 when unauthenticated, before any read', async () => {
    mockRequireSession.mockRejectedValue(
      new ApiAuthError(401, 'Unauthorized: No valid session'),
    );

    const res = await POST(postRequest(), chatCtx());

    expect(res.status).toBe(401);
    expect(shares.size).toBe(0);
    expect(emitMutation).not.toHaveBeenCalled();
  });

  it('403 when the caller has no access to the site', async () => {
    mockAssertSiteAccess.mockRejectedValue(
      new ApiAuthError(403, 'Forbidden: You do not have access to this site'),
    );

    const res = await POST(postRequest(), chatCtx());

    expect(res.status).toBe(403);
    expect((await res.json()).error).toBe('Forbidden: You do not have access to this site');
    expect(shares.size).toBe(0);
  });

  it('404 when the chat does not exist', async () => {
    chats.delete(CHAT);

    const res = await POST(postRequest(), chatCtx());

    expect(res.status).toBe(404);
    expect((await res.json()).error).toBe('chat not found');
    expect(shares.size).toBe(0);
  });

  it('404 — not 403 — when the chat lives in another site', async () => {
    // Never confirm that a chat id exists outside the caller's site.
    chats.set(CHAT, chatDoc({ siteId: OTHER_SITE }));

    const res = await POST(postRequest(), chatCtx());

    expect(res.status).toBe(404);
    expect(shares.size).toBe(0);
  });

  it('403 when the chat belongs to another user', async () => {
    chats.set(CHAT, chatDoc({ userId: 'someone-else' }));

    const res = await POST(postRequest(), chatCtx());

    expect(res.status).toBe(403);
    expect((await res.json()).error).toBe('you do not own this chat');
    expect(shares.size).toBe(0);
  });

  it('403 for an autonomous chat, which has no owner at all', async () => {
    const autonomous = chatDoc();
    delete autonomous.userId;
    chats.set(CHAT, autonomous);

    const res = await POST(postRequest(), chatCtx());

    expect(res.status).toBe(403);
    expect((await res.json()).error).toBe('you do not own this chat');
    expect(shares.size).toBe(0);
  });

  it('applies the same gate to GET and DELETE', async () => {
    chats.set(CHAT, chatDoc({ userId: 'someone-else' }));
    const seeded = shareDoc();

    expect((await GET(getRequest(), chatCtx())).status).toBe(403);
    expect(
      (await DELETE(deleteRequest(seeded.token as string), tokenCtx(seeded.token as string)))
        .status,
    ).toBe(403);
    expect(shares.get(seeded.token as string)?.revokedAt).toBeNull();
    expect(emitMutation).not.toHaveBeenCalled();
  });
});

// request validation

describe('POST /api/hoot/chats/{chatId}/shares — validation', () => {
  it('400 when siteId is missing', async () => {
    const res = await POST(postRequest({ expiresInDays: 30 }), chatCtx());

    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe('siteId is required');
  });

  it.each([
    ['missing', undefined],
    ['an unoffered number of days', 1],
    ['a numeric string', '30'],
    ['zero', 0],
    ['false', false],
  ])('400 when expiresInDays is %s — never defaulted server-side', async (_label, value) => {
    const res = await POST(postRequest({ siteId: SITE, expiresInDays: value }), chatCtx());

    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe('expiresInDays must be 7, 30, 90, or null');
    expect(shares.size).toBe(0);
    expect(emitMutation).not.toHaveBeenCalled();
  });

  it('400 when the body is not json at all', async () => {
    const res = await POST(
      new NextRequest(`http://localhost/api/hoot/chats/${CHAT}/shares`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: 'not json',
      }),
      chatCtx(),
    );

    expect(res.status).toBe(400);
    expect(shares.size).toBe(0);
  });

  it('409 when the conversation has nothing that can be shared', async () => {
    // Attachments and system messages are dropped by the snapshot, leaving
    // nothing a reader could see.
    chats.set(
      CHAT,
      chatDoc({
        messages: [
          msg('sys', 'system', [{ type: 'text', text: 'you are hoot.' }]),
          msg('u1', 'user', [{ type: 'file', mediaType: 'image/png', url: 'https://x/y.png' }]),
        ],
      }),
    );

    const res = await POST(postRequest(), chatCtx());

    expect(res.status).toBe(409);
    expect((await res.json()).error).toBe('this conversation has nothing that can be shared');
    expect(shares.size).toBe(0);
    expect(emitMutation).not.toHaveBeenCalled();
  });
});

// create

describe('POST /api/hoot/chats/{chatId}/shares — create', () => {
  it('201 with a shr_ token, and never stores tool inputs or outputs', async () => {
    const res = await POST(postRequest({ siteId: SITE, expiresInDays: 7 }), chatCtx());

    expect(res.status).toBe(201);
    const { share } = await res.json();
    expect(share.token).toMatch(SHARE_TOKEN_PATTERN);
    expect(share.messageCount).toBe(2);
    expect(share.expiresAt).toBeGreaterThan(Date.now());
    expect(share.expiresAt).toBeLessThanOrEqual(Date.now() + 7 * DAY_MS);

    // Negative control on what was persisted: a route that handed the store the
    // raw chat messages instead of the snapshot would still 201 above.
    const serialized = JSON.stringify(storedShare());
    expect(serialized).not.toContain('secret-client-project');
    expect(serialized).not.toContain('10.0.4.17');
    expect(serialized).not.toContain('Access violation');
    expect(serialized).not.toContain('"input"');
    expect(serialized).not.toContain('"output"');
    expect(serialized).not.toContain('toolCallId');
    // The collapsed call survives, so the reader still sees a tool ran.
    expect(serialized).toContain('checkLogs');
  });

  it('honours a null expiry as a link that never expires', async () => {
    const res = await POST(postRequest({ siteId: SITE, expiresInDays: null }), chatCtx());

    expect(res.status).toBe(201);
    expect((await res.json()).share.expiresAt).toBeNull();
    expect(storedShare().expiresAt).toBeNull();
  });

  it('audits exactly once, with the token in neither the audit nor the logs', async () => {
    const logs = [
      jest.spyOn(console, 'log').mockImplementation(() => undefined),
      jest.spyOn(console, 'warn').mockImplementation(() => undefined),
      jest.spyOn(console, 'error').mockImplementation(() => undefined),
    ];
    try {
      const res = await POST(postRequest({ siteId: SITE, expiresInDays: 30 }), chatCtx());
      const { share } = await res.json();

      expect(emitMutation).toHaveBeenCalledTimes(1);
      expect(emitMutation).toHaveBeenCalledWith({
        kind: 'chat_mutated',
        siteId: SITE,
        actor: `user:${UID}`,
        targetId: CHAT,
        attributes: {
          endpoint: `/api/hoot/chats/${CHAT}/shares`,
          method: 'POST',
          verb: 'share',
          expiresAt: expect.any(Number),
          messageCount: 2,
        },
      });

      // The token is a bearer credential for the published conversation.
      expect(JSON.stringify(emitted())).not.toContain(share.token);
      for (const spy of logs) {
        expect(JSON.stringify(spy.mock.calls)).not.toContain(share.token);
      }
    } finally {
      for (const spy of logs) spy.mockRestore();
    }
  });
});

// list

describe('GET /api/hoot/chats/{chatId}/shares', () => {
  it('400 when siteId is missing from the query string', async () => {
    const res = await GET(getRequest(null), chatCtx());

    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe('siteId is required');
  });

  it('returns only this chat\'s active links, newest first', async () => {
    const newest = shareDoc({ createdAt: Timestamp.fromMillis(Date.now() - 60_000) });
    const oldest = shareDoc({ createdAt: Timestamp.fromMillis(Date.now() - 5 * DAY_MS) });
    shareDoc({ revokedAt: Timestamp.fromMillis(Date.now() - 1_000) });
    shareDoc({ expiresAt: Timestamp.fromMillis(Date.now() - 1_000) });
    shareDoc({ chatId: OTHER_CHAT });

    const res = await GET(getRequest(), chatCtx());

    expect(res.status).toBe(200);
    const { shares: listed } = await res.json();
    expect(listed.map((s: { token: string }) => s.token)).toEqual([newest.token, oldest.token]);
    expect(emitMutation).not.toHaveBeenCalled();
  });

  it('returns an empty list for a chat that was never shared', async () => {
    const res = await GET(getRequest(), chatCtx());

    expect(res.status).toBe(200);
    expect((await res.json()).shares).toEqual([]);
  });
});

// revoke

describe('DELETE /api/hoot/chats/{chatId}/shares/{token}', () => {
  it('revokes the link, audits once, and keeps the token out of the audit', async () => {
    const seeded = shareDoc();
    const token = seeded.token as string;

    const res = await DELETE(deleteRequest(token), tokenCtx(token));

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ revoked: true });
    expect(shares.get(token)?.revokedAt).not.toBeNull();

    expect(emitMutation).toHaveBeenCalledTimes(1);
    expect(emitMutation).toHaveBeenCalledWith({
      kind: 'chat_mutated',
      siteId: SITE,
      actor: `user:${UID}`,
      targetId: CHAT,
      attributes: {
        endpoint: `/api/hoot/chats/${CHAT}/shares/{token}`,
        method: 'DELETE',
        verb: 'unshare',
      },
    });
    expect(JSON.stringify(emitted())).not.toContain(token);
  });

  it('is idempotent: a second revoke is another 200', async () => {
    const token = shareDoc().token as string;

    expect((await DELETE(deleteRequest(token), tokenCtx(token))).status).toBe(200);
    const revokedAt = shares.get(token)?.revokedAt;

    const second = await DELETE(deleteRequest(token), tokenCtx(token));

    expect(second.status).toBe(200);
    expect(await second.json()).toEqual({ revoked: true });
    // The instant does not move on a re-revoke.
    expect(shares.get(token)?.revokedAt).toBe(revokedAt);
  });

  it('404 for a token that belongs to another chat, leaving it live', async () => {
    const foreign = shareDoc({ chatId: OTHER_CHAT });
    const token = foreign.token as string;

    const res = await DELETE(deleteRequest(token), tokenCtx(token));

    expect(res.status).toBe(404);
    expect((await res.json()).error).toBe('share not found');
    expect(shares.get(token)?.revokedAt).toBeNull();
    expect(emitMutation).not.toHaveBeenCalled();
  });

  it('404 for an unknown or malformed token', async () => {
    const unknown = generateShareToken();
    expect((await DELETE(deleteRequest(unknown), tokenCtx(unknown))).status).toBe(404);
    expect((await DELETE(deleteRequest('nope'), tokenCtx('nope'))).status).toBe(404);
    expect(emitMutation).not.toHaveBeenCalled();
  });

  it('400 when siteId is missing from the query string', async () => {
    const token = shareDoc().token as string;

    const res = await DELETE(deleteRequest(token, null), tokenCtx(token));

    expect(res.status).toBe(400);
    expect(shares.get(token)?.revokedAt).toBeNull();
  });
});

// rate-limit wrapper

describe('hoot shares — rate limiting', () => {
  it('wraps every verb in withRateLimit with the user strategy', () => {
    // Wrapper options were captured at module import (before clearAllMocks).
    const { capturedOptions } = withRateLimit as unknown as { capturedOptions: unknown[] };

    expect(capturedOptions).toHaveLength(3);
    for (const options of capturedOptions) {
      expect(options).toMatchObject({
        strategy: 'user',
        identifier: 'user',
        getUserId: expect.any(Function),
      });
    }
  });
});
