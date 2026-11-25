/** @jest-environment node */

import crypto from 'crypto';
import { NextRequest } from 'next/server';

jest.mock('@sentry/nextjs', () => ({
  captureException: jest.fn(),
  captureMessage: jest.fn(),
}));

const mockRequireSession = jest.fn();
jest.mock('@/lib/apiAuth.server', () => ({
  requireSession: (...args: unknown[]) => mockRequireSession(...args),
}));

const mockVerifyUserSiteAccess = jest.fn();
const mockResolveLlmConfig = jest.fn();
jest.mock('@/lib/hoot-utils.server', () => ({
  verifyUserSiteAccess: (...args: unknown[]) => mockVerifyUserSiteAccess(...args),
  resolveLlmConfig: (...args: unknown[]) => mockResolveLlmConfig(...args),
}));

jest.mock('@/lib/llm', () => ({
  createCheapModel: jest.fn(() => ({ model: 'cheap' })),
}));

const mockGenerateText = jest.fn();
jest.mock('ai', () => ({
  generateText: (...args: unknown[]) => mockGenerateText(...args),
}));

const mockEmitMutation = jest.fn();
jest.mock('@/lib/auditLogClient', () => ({
  emitMutation: (...args: unknown[]) => mockEmitMutation(...args),
}));

// Both mocks receive the chat id, so batch assertions don't depend on the
// order `Promise.all` happens to resolve the chunk in.
const mockChatGet = jest.fn();
const mockChatUpdate = jest.fn();
const mockDb = {
  collection: jest.fn((name: string) => {
    if (name !== 'chats') throw new Error(`unexpected collection ${name}`);
    return {
      doc: jest.fn((chatId: string) => ({
        get: () => mockChatGet(chatId),
        update: (patch: unknown) => mockChatUpdate(chatId, patch),
        // the batch's first-message fallback for an untitled chat
        collection: () => {
          const query = {
            where: () => query,
            orderBy: () => query,
            limit: () => query,
            get: async () => ({ docs: [{ data: () => ({ content: `first message of ${chatId}` }) }] }),
          };
          return query;
        },
      })),
    };
  }),
};

jest.mock('@/lib/firebase-admin', () => ({
  getAdminDb: () => mockDb,
}));

import { GET as escalationGET, POST as escalationPOST } from '@/app/api/hoot/escalation/route';
import { POST as categorizePOST } from '@/app/api/hoot/categorize/route';

function req(url: string, init: RequestInit = {}) {
  return new NextRequest(url, init);
}

beforeEach(() => {
  jest.clearAllMocks();
  delete process.env.CRON_SECRET;
  mockChatUpdate.mockResolvedValue(undefined);
  mockGenerateText.mockResolvedValue({ text: 'Generated title\nGeneral' });
  mockRequireSession.mockResolvedValue('user-1');
  mockVerifyUserSiteAccess.mockResolvedValue({
    role: 'admin',
    isSuperadmin: false,
    isSiteAdmin: true,
    isSiteOwner: true,
  });
  mockResolveLlmConfig.mockResolvedValue({ provider: 'test' });
});

describe('/api/hoot/escalation internal gate', () => {
  it('fails closed when CRON_SECRET is not configured', async () => {
    const res = await escalationGET(req('http://localhost/api/hoot/escalation'));
    expect(res.status).toBe(503);
  });

  it('rejects an incorrect cron bearer token', async () => {
    process.env.CRON_SECRET = 'expected';
    const res = await escalationGET(
      req('http://localhost/api/hoot/escalation', {
        headers: { authorization: 'Bearer wrong' },
      }),
    );
    expect(res.status).toBe(401);
  });

  it.each([
    ['GET', 'CRON_SECRET', () => escalationGET(req('http://localhost/api/hoot/escalation', { headers: { authorization: 'Bearer expecteD' } }))],
    [
      'POST',
      'CORTEX_INTERNAL_SECRET',
      () => escalationPOST(req('http://localhost/api/hoot/escalation', { method: 'POST', headers: { 'x-cortex-secret': 'expecteD' } })),
    ],
  ])('%s compares %s in constant time', async (_method, env, call) => {
    process.env[env] = 'expected';
    const compare = jest.spyOn(crypto, 'timingSafeEqual');
    try {
      expect((await call()).status).toBe(401);
      expect(compare).toHaveBeenCalledTimes(1);
    } finally {
      compare.mockRestore();
      delete process.env[env];
    }
  });

  it('POST fails closed when the internal secret is not configured', async () => {
    const res = await escalationPOST(
      req('http://localhost/api/hoot/escalation', { method: 'POST', headers: { 'x-cortex-secret': '' } }),
    );
    expect(res.status).toBe(503);
  });
});

describe('/api/hoot/categorize internal access checks', () => {
  it('rejects single-chat categorization when the chat is not on the requested site', async () => {
    mockChatGet.mockResolvedValueOnce({
      exists: true,
      data: () => ({ siteId: 'other-site' }),
    });
    const res = await categorizePOST(
      req('http://localhost/api/hoot/categorize', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ siteId: 'site-1', chatId: 'chat-1', message: 'hello' }),
      }),
    );
    expect(res.status).toBe(404);
    // Refused before any write, so nothing to record.
    expect(mockEmitMutation).not.toHaveBeenCalled();
  });
});

describe('/api/hoot/categorize and whose chat it is', () => {
  const categorize = (body: Record<string, unknown>) =>
    categorizePOST(
      req('http://localhost/api/hoot/categorize', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ siteId: 'site-1', ...body }),
      }),
    );

  it("refuses to retitle another member's chat on the same site", async () => {
    mockChatGet.mockResolvedValueOnce({
      exists: true,
      data: () => ({ siteId: 'site-1', userId: 'user-2', title: 'their chat' }),
    });

    const res = await categorize({ chatId: 'chat-2', message: 'rename me' });

    expect(res.status).toBe(403);
    expect(mockGenerateText).not.toHaveBeenCalled();
    expect(mockChatUpdate).not.toHaveBeenCalled();
    expect(mockEmitMutation).not.toHaveBeenCalled();
  });

  it("skips other members' chats in a batch, and never sends their first message to a model", async () => {
    // chat-1 is the caller's; chat-2 (untitled) and chat-3 (titled) belong to
    // another member, and the autonomous chat-4 to nobody.
    const owners: Record<string, string | undefined> = {
      'chat-1': 'user-1',
      'chat-2': 'user-2',
      'chat-3': 'user-2',
      'chat-4': undefined,
    };
    mockChatGet.mockImplementation(async (id: string) => ({
      exists: true,
      data: () => ({
        siteId: 'site-1',
        userId: owners[id],
        title: id === 'chat-2' ? 'new hoot' : `title for ${id}`,
      }),
    }));

    const res = await categorize({ chatIds: ['chat-1', 'chat-2', 'chat-3', 'chat-4'] });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ results: { 'chat-1': 'General' } });
    expect(mockChatUpdate).toHaveBeenCalledTimes(1);
    expect(mockChatUpdate).toHaveBeenCalledWith('chat-1', { category: 'General' });
    expect(mockGenerateText).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(mockGenerateText.mock.calls)).not.toMatch(/chat-[234]/);
    expect(mockEmitMutation).toHaveBeenCalledTimes(1);
    expect(mockEmitMutation.mock.calls[0][0].targetId).toBe('chat-1');
  });
});

describe('/api/hoot/categorize audit', () => {
  it('emits chat_mutated/rename for the single-chat title+category write', async () => {
    mockChatGet.mockResolvedValueOnce({
      exists: true,
      data: () => ({ siteId: 'site-1', userId: 'user-1' }),
    });

    const res = await categorizePOST(
      req('http://localhost/api/hoot/categorize', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ siteId: 'site-1', chatId: 'chat-1', message: 'hello' }),
      }),
    );
    expect(res.status).toBe(200);
    expect(mockChatUpdate).toHaveBeenCalledTimes(1);

    expect(mockEmitMutation).toHaveBeenCalledTimes(1);
    const audit = mockEmitMutation.mock.calls[0][0];
    expect(audit.kind).toBe('chat_mutated');
    expect(audit.siteId).toBe('site-1');
    expect(audit.actor).toBe('user:user-1');
    expect(audit.targetId).toBe('chat-1');
    expect(audit.attributes).toMatchObject({
      verb: 'rename',
      endpoint: '/api/hoot/categorize',
      method: 'POST',
      siteId: 'site-1',
      category: 'General',
      retitled: true,
    });
  });

  it('emits one row per chat the batch actually rewrites, and none for skips', async () => {
    // chat-1 and chat-2 are on the site and already titled (category-only
    // rewrite); chat-3 belongs to another site and is skipped entirely.
    const bySite: Record<string, string> = {
      'chat-1': 'site-1',
      'chat-2': 'site-1',
      'chat-3': 'other-site',
    };
    const order = ['chat-1', 'chat-2', 'chat-3'];
    mockChatGet.mockImplementation(async (id: string) => ({
      exists: true,
      data: () => ({ siteId: bySite[id], userId: 'user-1', title: `title for ${id}` }),
    }));

    const res = await categorizePOST(
      req('http://localhost/api/hoot/categorize', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ siteId: 'site-1', chatIds: order }),
      }),
    );
    expect(res.status).toBe(200);
    expect(mockChatUpdate).toHaveBeenCalledTimes(2);

    expect(mockEmitMutation).toHaveBeenCalledTimes(2);
    const targets = mockEmitMutation.mock.calls.map((c) => c[0].targetId).sort();
    expect(targets).toEqual(['chat-1', 'chat-2']);
    for (const [audit] of mockEmitMutation.mock.calls) {
      expect(audit.kind).toBe('chat_mutated');
      expect(audit.attributes).toMatchObject({
        verb: 'rename',
        siteId: 'site-1',
        category: 'General',
        // Category-only rewrite: the title was already the user's.
        retitled: false,
      });
    }
  });
});
