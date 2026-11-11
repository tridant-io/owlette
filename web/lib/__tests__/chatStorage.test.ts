/** @jest-environment node */

/**
 * Unit tests for `chatStorage.server`. The Firestore admin sdk is replaced with an
 * in-memory store keyed by `<collection>/<docId>`, so transactions still exercise
 * real read-modify-write semantics.
 */

import { Timestamp } from 'firebase-admin/firestore';

// in-memory firestore admin mock

type DocPath = string;
type StoreShape = Record<DocPath, Record<string, unknown>>;

const store: StoreShape = {};

function freshSnap(path: string) {
  const data = store[path];
  return {
    exists: data !== undefined,
    id: path.split('/').pop() ?? '',
    data: () => (data ? { ...data } : undefined),
  };
}

function buildCollection(prefix: string): Record<string, unknown> {
  const docFn = (id: string) => {
    const fullPath = prefix === '' ? id : `${prefix}/${id}`;
    return {
      get: jest.fn(async () => freshSnap(fullPath)),
      set: jest.fn(async (data: Record<string, unknown>) => {
        store[fullPath] = { ...data };
      }),
      update: jest.fn(async (patch: Record<string, unknown>) => {
        if (!store[fullPath]) throw new Error(`update on missing doc: ${fullPath}`);
        store[fullPath] = { ...store[fullPath], ...patch };
      }),
      delete: jest.fn(async () => {
        delete store[fullPath];
      }),
      collection: (sub: string) => buildCollection(`${fullPath}/${sub}`),
      _path: fullPath,
    };
  };

  // fresh per chained query so two concurrent where().get() chains can't share filters
  const queryBuilder = (state: {
    whereClauses: Array<{ field: string; op: string; value: unknown }>;
    orderByField: string | null;
    orderDir: 'asc' | 'desc';
    limitN: number | null;
    startAfterId: string | null;
  }) => ({
    where(field: string, op: string, value: unknown) {
      return queryBuilder({
        ...state,
        whereClauses: [...state.whereClauses, { field, op, value }],
      });
    },
    orderBy(field: string, dir: 'asc' | 'desc' = 'asc') {
      return queryBuilder({ ...state, orderByField: field, orderDir: dir });
    },
    limit(n: number) {
      return queryBuilder({ ...state, limitN: n });
    },
    startAfter(snap: { id: string }) {
      return queryBuilder({ ...state, startAfterId: snap.id });
    },
    async get() {
      // docs directly under `<prefix>/`, excluding subcollection paths
      const allDocs = Object.entries(store)
        .filter(([p]) => {
          if (!p.startsWith(prefix + '/')) return false;
          const rest = p.slice(prefix.length + 1);
          return !rest.includes('/');
        })
        .map(([p, data]) => ({ id: p.split('/').pop() ?? '', data }));

      let filtered = allDocs.filter((d) =>
        state.whereClauses.every((w) => {
          const fieldVal = (d.data as Record<string, unknown>)[w.field];
          if (w.op === '==') return fieldVal === w.value;
          if (w.op === 'in') return Array.isArray(w.value) && (w.value as unknown[]).includes(fieldVal);
          return true;
        }),
      );

      if (state.orderByField) {
        const f = state.orderByField;
        filtered = [...filtered].sort((a, b) => {
          const av = (a.data as Record<string, unknown>)[f];
          const bv = (b.data as Record<string, unknown>)[f];
          const ams = av instanceof Timestamp ? av.toMillis() : Number(av) || 0;
          const bms = bv instanceof Timestamp ? bv.toMillis() : Number(bv) || 0;
          return state.orderDir === 'desc' ? bms - ams : ams - bms;
        });
      }

      if (state.startAfterId) {
        const idx = filtered.findIndex((d) => d.id === state.startAfterId);
        if (idx >= 0) filtered = filtered.slice(idx + 1);
      }

      if (state.limitN !== null) filtered = filtered.slice(0, state.limitN);

      return {
        docs: filtered.map((d) => ({
          id: d.id,
          data: () => ({ ...(d.data as Record<string, unknown>) }),
        })),
      };
    },
  });

  return {
    doc: docFn,
    ...queryBuilder({
      whereClauses: [],
      orderByField: null,
      orderDir: 'asc',
      limitN: null,
      startAfterId: null,
    }),
  };
}

const fakeDb = {
  collection: (name: string) => buildCollection(name),
  runTransaction: jest.fn(async (fn: (txn: unknown) => Promise<unknown>) => {
    // txn.get / set / update, all bound to the same store
    const txn = {
      get: async (ref: { _path: string }) => freshSnap(ref._path),
      set: (ref: { _path: string }, data: Record<string, unknown>) => {
        store[ref._path] = { ...data };
      },
      update: (ref: { _path: string }, patch: Record<string, unknown>) => {
        if (!store[ref._path]) throw new Error(`txn update on missing: ${ref._path}`);
        store[ref._path] = { ...store[ref._path], ...patch };
      },
    };
    return fn(txn);
  }),
};

jest.mock('@/lib/firebase-admin', () => ({
  getAdminDb: () => fakeDb,
}));

import {
  createConversation,
  getConversation,
  listConversations,
  appendMessage,
  softDeleteConversation,
  renameConversation,
  normalizeTitle,
  generateConversationId,
  generateMessageId,
  MAX_EMBEDDED_MESSAGES,
  MAX_TITLE_LENGTH,
  ChatStorageError,
  serializeConversationSummary,
  serializeConversation,
} from '@/lib/chatStorage.server';

beforeEach(() => {
  for (const k of Object.keys(store)) delete store[k];
  jest.clearAllMocks();
});

// helpers

function tsBefore(c: { createdAt: Timestamp }, d: { createdAt: Timestamp }) {
  return c.createdAt.toMillis() - d.createdAt.toMillis();
}

// id generators + normalizers

describe('id generators + normalizers', () => {
  it('generateConversationId produces unique conv_<base64url> ids', () => {
    const a = generateConversationId();
    const b = generateConversationId();
    expect(a).toMatch(/^conv_[A-Za-z0-9_-]+$/);
    expect(a).not.toBe(b);
  });

  it('generateMessageId produces unique msg_<base64url> ids', () => {
    const a = generateMessageId();
    const b = generateMessageId();
    expect(a).toMatch(/^msg_[A-Za-z0-9_-]+$/);
    expect(a).not.toBe(b);
  });

  it('normalizeTitle trims whitespace and falls back when empty', () => {
    expect(normalizeTitle('   hello   ')).toBe('hello');
    expect(normalizeTitle('')).toBe('untitled chat');
    expect(normalizeTitle('   ')).toBe('untitled chat');
    expect(normalizeTitle(undefined)).toBe('untitled chat');
    expect(normalizeTitle(123 as unknown)).toBe('untitled chat');
  });

  it('normalizeTitle truncates to MAX_TITLE_LENGTH', () => {
    const long = 'x'.repeat(MAX_TITLE_LENGTH * 2);
    expect(normalizeTitle(long).length).toBe(MAX_TITLE_LENGTH);
  });
});

// create + read

describe('createConversation + getConversation', () => {
  it('round-trips a minimal conversation', async () => {
    const created = await createConversation({
      siteId: 'site_a',
      ownerUid: 'user_a',
    });
    expect(created.conversationId).toMatch(/^conv_/);
    expect(created.siteId).toBe('site_a');
    expect(created.ownerUid).toBe('user_a');
    expect(created.machineId).toBeUndefined();
    expect(created.title).toBe('untitled chat');
    expect(created.messages).toEqual([]);
    expect(created.messageCount).toBe(0);

    const fetched = await getConversation(created.conversationId);
    expect(fetched).not.toBeNull();
    expect(fetched!.conversationId).toBe(created.conversationId);
    expect(fetched!.siteId).toBe('site_a');
  });

  it('seeds initialMessages and persists machineId + title', async () => {
    const c = await createConversation({
      siteId: 'site_b',
      ownerUid: 'user_a',
      machineId: 'mach_x',
      title: '   weekly status   ',
      initialMessages: [{ role: 'user', content: 'hi' }],
    });
    expect(c.title).toBe('weekly status');
    expect(c.machineId).toBe('mach_x');
    expect(c.messages).toHaveLength(1);
    expect(c.messages[0]).toMatchObject({ role: 'user', content: 'hi' });
    expect(c.messageCount).toBe(1);

    const fetched = await getConversation(c.conversationId);
    expect(fetched!.machineId).toBe('mach_x');
    expect(fetched!.messages).toHaveLength(1);
  });

  it('getConversation returns null for missing ids', async () => {
    expect(await getConversation('conv_nonexistent')).toBeNull();
  });
});

// list

describe('listConversations', () => {
  it('returns empty when siteIds is empty', async () => {
    const r = await listConversations({ siteIds: [] });
    expect(r.conversations).toEqual([]);
    expect(r.nextPageToken).toBe('');
  });

  it('filters to the supplied siteIds', async () => {
    await createConversation({ siteId: 'site_a', ownerUid: 'u1' });
    await createConversation({ siteId: 'site_b', ownerUid: 'u1' });
    const r = await listConversations({ siteIds: ['site_a'] });
    expect(r.conversations).toHaveLength(1);
    expect(r.conversations[0].siteId).toBe('site_a');
  });

  it('orders newest first', async () => {
    const a = await createConversation({ siteId: 's', ownerUid: 'u' });
    // ms gap keeps the sort deterministic
    await new Promise((res) => setTimeout(res, 5));
    const b = await createConversation({ siteId: 's', ownerUid: 'u' });
    const r = await listConversations({ siteIds: ['s'] });
    const ids = r.conversations.map((c) => c.conversationId);
    expect(ids[0]).toBe(b.conversationId);
    expect(ids[1]).toBe(a.conversationId);
    expect(tsBefore(a, b)).toBeLessThanOrEqual(0);
  });

  it('excludes soft-deleted by default; includes when flag set', async () => {
    const c = await createConversation({ siteId: 's', ownerUid: 'u' });
    await softDeleteConversation(c.conversationId);

    const visible = await listConversations({ siteIds: ['s'] });
    expect(visible.conversations).toHaveLength(0);

    const all = await listConversations({ siteIds: ['s'], includeDeleted: true });
    expect(all.conversations).toHaveLength(1);
    expect(all.conversations[0].deletedAt).toBeDefined();
  });

  it('fills a page past soft-deleted chats and keeps paging', async () => {
    const created = [];
    for (let i = 0; i < 4; i++) {
      created.push(await createConversation({ siteId: 's', ownerUid: 'u' }));
      // ms gap keeps the sort deterministic
      await new Promise((res) => setTimeout(res, 5));
    }
    const [oldest, older, newer, newest] = created;
    await softDeleteConversation(newest.conversationId);
    await softDeleteConversation(newer.conversationId);

    const first = await listConversations({ siteIds: ['s'], pageSize: 1 });
    expect(first.conversations.map((c) => c.conversationId)).toEqual([older.conversationId]);
    expect(first.nextPageToken).toBe(older.conversationId);

    const second = await listConversations({
      siteIds: ['s'],
      pageSize: 1,
      pageToken: first.nextPageToken,
    });
    expect(second.conversations.map((c) => c.conversationId)).toEqual([oldest.conversationId]);
    expect(second.nextPageToken).toBe('');
  });

  it('honors ownerUid filter', async () => {
    await createConversation({ siteId: 's', ownerUid: 'me' });
    await createConversation({ siteId: 's', ownerUid: 'someone-else' });
    const mine = await listConversations({ siteIds: ['s'], ownerUid: 'me' });
    expect(mine.conversations).toHaveLength(1);
    expect(mine.conversations[0].ownerUid).toBe('me');
  });

  it('chunks siteIds across the 30-id firestore in() cap', async () => {
    const sites = Array.from({ length: 35 }, (_, i) => `s_${i}`);
    for (const s of sites) {
      await createConversation({ siteId: s, ownerUid: 'u' });
    }
    const r = await listConversations({ siteIds: sites, pageSize: 100 });
    expect(r.conversations).toHaveLength(35);
  });
});

// append message + spill

describe('appendMessage', () => {
  it('appends under the cap without spilling', async () => {
    const c = await createConversation({ siteId: 's', ownerUid: 'u' });
    const r = await appendMessage({
      conversationId: c.conversationId,
      role: 'user',
      content: 'hi',
    });
    expect(r.spilled).toBe(false);
    expect(r.messageCount).toBe(1);

    const fetched = await getConversation(c.conversationId);
    expect(fetched!.messages).toHaveLength(1);
    expect(fetched!.messages[0].content).toBe('hi');
    expect(fetched!.messageCount).toBe(1);
  });

  it('throws ChatStorageError(404) on missing conversation', async () => {
    await expect(
      appendMessage({ conversationId: 'conv_nope', role: 'user', content: 'x' }),
    ).rejects.toBeInstanceOf(ChatStorageError);
  });

  it('spills oldest into subcollection once the embedded array is full', async () => {
    const c = await createConversation({ siteId: 's', ownerUid: 'u' });

    // Fill to capacity through the store for speed; appendMessage itself is
    // covered by the first case. Each message carries a unique content marker.
    const seeded = Array.from({ length: MAX_EMBEDDED_MESSAGES }, (_, i) => ({
      role: 'user' as const,
      content: `seed-${i}`,
      timestamp: Timestamp.now(),
    }));
    store[`chat_conversations/${c.conversationId}`] = {
      ...store[`chat_conversations/${c.conversationId}`],
      messages: seeded,
      messageCount: MAX_EMBEDDED_MESSAGES,
    };

    const r = await appendMessage({
      conversationId: c.conversationId,
      role: 'assistant',
      content: 'overflow',
    });
    expect(r.spilled).toBe(true);
    expect(r.messageCount).toBe(MAX_EMBEDDED_MESSAGES + 1);

    const refreshed = await getConversation(c.conversationId);
    expect(refreshed!.messages).toHaveLength(MAX_EMBEDDED_MESSAGES);
    expect(refreshed!.messages[0].content).toBe('seed-1');
    expect(refreshed!.messages[refreshed!.messages.length - 1].content).toBe('overflow');

    const spillKeys = Object.keys(store).filter((k) =>
      k.startsWith(`chat_conversations/${c.conversationId}/chat_messages/`),
    );
    expect(spillKeys).toHaveLength(1);
    expect((store[spillKeys[0]] as { content: string }).content).toBe('seed-0');
  });
});

// soft delete

describe('softDeleteConversation', () => {
  it('marks deletedAt and is true-idempotent on re-call', async () => {
    const c = await createConversation({ siteId: 's', ownerUid: 'u' });
    const first = await softDeleteConversation(c.conversationId);
    expect(first.alreadyDeleted).toBe(false);
    expect(first.deletedAt).toBeInstanceOf(Timestamp);

    const second = await softDeleteConversation(c.conversationId);
    expect(second.alreadyDeleted).toBe(true);
    // re-deleting must not advance deletedAt
    expect(second.deletedAt.toMillis()).toBe(first.deletedAt.toMillis());
  });

  it('throws 404 for missing conversation', async () => {
    await expect(softDeleteConversation('conv_nope')).rejects.toBeInstanceOf(
      ChatStorageError,
    );
  });
});

// rename

describe('renameConversation', () => {
  it('updates the title and normalizes', async () => {
    const c = await createConversation({ siteId: 's', ownerUid: 'u', title: 'old' });
    const r = await renameConversation(c.conversationId, '   new title   ');
    expect(r.title).toBe('new title');

    const refreshed = await getConversation(c.conversationId);
    expect(refreshed!.title).toBe('new title');
  });

  it('truncates to MAX_TITLE_LENGTH', async () => {
    const c = await createConversation({ siteId: 's', ownerUid: 'u' });
    const r = await renameConversation(c.conversationId, 'y'.repeat(500));
    expect(r.title.length).toBe(MAX_TITLE_LENGTH);
  });

  it('throws 404 for missing conversation', async () => {
    await expect(renameConversation('conv_nope', 'x')).rejects.toBeInstanceOf(
      ChatStorageError,
    );
  });
});

// serializers

describe('serializers', () => {
  it('serializeConversationSummary drops messages and ISO-formats timestamps', async () => {
    const c = await createConversation({
      siteId: 's',
      ownerUid: 'u',
      initialMessages: [{ role: 'user', content: 'hi' }],
    });
    const summary = serializeConversationSummary(c) as Record<string, unknown>;
    expect(summary.messages).toBeUndefined();
    expect(summary.messageCount).toBe(1);
    expect(typeof summary.createdAt).toBe('string');
    expect(String(summary.createdAt)).toMatch(/T.*Z$/);
  });

  it('serializeConversation includes messages with iso timestamps', async () => {
    const c = await createConversation({
      siteId: 's',
      ownerUid: 'u',
      initialMessages: [{ role: 'user', content: 'hi' }],
    });
    const full = serializeConversation(c) as Record<string, unknown>;
    expect(Array.isArray(full.messages)).toBe(true);
    expect((full.messages as Array<Record<string, unknown>>)[0].content).toBe('hi');
  });
});
