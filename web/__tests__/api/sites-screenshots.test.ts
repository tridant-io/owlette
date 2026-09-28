/** @jest-environment node */

import { NextRequest } from 'next/server';

const store = new Map<string, Record<string, unknown> | null>();
const deletedStoragePaths: string[] = [];

jest.mock('@/lib/authorizedHandler.server', () => ({
  authorizedSiteHandler: () => (handler: (...args: unknown[]) => unknown) =>
    async (request: NextRequest, routeContext: { params: Promise<{ siteId: string; machineId: string }> }) => {
      const params = await routeContext.params;
      return handler(
        request,
        {
          actor: { type: 'user', userId: 'test-admin', role: 'admin', siteRoles: { [params.siteId]: 'admin' } },
          siteId: params.siteId,
          correlationId: 'corr-test',
          auth: { userId: 'test-admin', keyContext: null },
          scopeCheck: { isLegacy: false },
        },
        routeContext,
      );
    },
}));

jest.mock('@/lib/firebase-admin', () => ({
  getAdminDb: () => ({
    collection: (name: string) => collectionRef([name]),
  }),
  getAdminStorage: () => ({
    bucket: (name: string) => ({
      name,
      file: (path: string) => ({
        delete: async () => deletedStoragePaths.push(path),
      }),
    }),
  }),
}));

function pathFor(parts: string[]): string {
  return parts.join('/');
}

function collectionRef(parts: string[]) {
  return {
    doc: (id: string) => docRef([...parts, id]),
    get: async () => {
      const prefix = `${pathFor(parts)}/`;
      const docs = Array.from(store.entries())
        .filter(([path, data]) => data && path.startsWith(prefix))
        .map(([path, data]) => ({
          id: path.slice(prefix.length).split('/')[0],
          data: () => data,
          ref: docRef(path.split('/')),
        }));
      return { empty: docs.length === 0, docs };
    },
  };
}

function docRef(parts: string[]) {
  const path = pathFor(parts);
  return {
    collection: (name: string) => collectionRef([...parts, name]),
    get: async () => {
      const data = store.get(path);
      return { exists: !!data, data: () => data ?? undefined };
    },
    delete: async () => {
      store.set(path, null);
    },
    update: async (patch: Record<string, unknown>) => {
      store.set(path, { ...(store.get(path) ?? {}), ...patch });
    },
  };
}

// upload-url: machine auth resolves to the route params; the limiter is a per-key
// counter that allows two calls, so the third 429s; storage minting is faked.
const limiterCalls = new Map<string, number>();
jest.mock('@/app/api/_shared', () => {
  const actual = jest.requireActual('@/app/api/_shared');
  return {
    ...actual,
    requireMachineAuthAndScope: async (
      _request: NextRequest, siteId: string, machineId: string,
    ) => ({
      ok: true,
      auth: { userId: `agent:${machineId}`, keyContext: null },
      siteId,
      machineId,
      scopeCheck: { isLegacy: false },
    }),
  };
});
jest.mock('@/lib/rateLimit', () => {
  const actual = jest.requireActual('@/lib/rateLimit');
  return {
    ...actual,
    screenshotUploadRateLimit: null,
    checkRateLimit: async (_limiter: unknown, key: string) => {
      const n = (limiterCalls.get(key) ?? 0) + 1;
      limiterCalls.set(key, n);
      const reset = Date.now() + 60_000;
      return n <= 2
        ? { success: true, limit: 2, remaining: 2 - n, reset }
        : { success: false, limit: 2, remaining: 0, reset, retryAfter: 60 };
    },
  };
});
jest.mock('@/lib/screenshotStorage.server', () => ({
  issueScreenshotUploadUrl: async (siteId: string, machineId: string) => ({
    uploadUrl: `https://storage.example/${siteId}/${machineId}`,
    storagePath: `screenshots/${siteId}/${machineId}/x.png`,
    expiresAt: '2026-01-01T00:05:00.000Z',
  }),
}));

import { DELETE } from '@/app/api/sites/[siteId]/machines/[machineId]/screenshots/route';
import { POST as uploadUrl } from '@/app/api/sites/[siteId]/machines/[machineId]/screenshots/upload-url/route';

beforeEach(() => {
  store.clear();
  deletedStoragePaths.length = 0;
  limiterCalls.clear();
  process.env.NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET = 'bucket.example';
});

describe('DELETE /api/sites/{siteId}/machines/{machineId}/screenshots', () => {
  it('deletes a single screenshot document and storage object', async () => {
    store.set('sites/site-a/machines/m1/screenshots/shot-1', {
      url: 'https://storage.googleapis.com/bucket.example/screenshots/site-a/m1/shot-1.jpg?x=1',
    });

    const res = await DELETE(
      new NextRequest('http://localhost/api/sites/site-a/machines/m1/screenshots?screenshotId=shot-1', {
        method: 'DELETE',
      }),
      { params: Promise.resolve({ siteId: 'site-a', machineId: 'm1' }) },
    );

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ success: true, deleted: 1 });
    expect(store.get('sites/site-a/machines/m1/screenshots/shot-1')).toBeNull();
    expect(deletedStoragePaths).toEqual(['screenshots/site-a/m1/shot-1.jpg']);
  });
});


describe('POST /api/sites/{siteId}/machines/{machineId}/screenshots/upload-url', () => {
  const mint = (machineId: string) =>
    uploadUrl(
      new NextRequest(`http://localhost/api/sites/site-1/machines/${machineId}/screenshots/upload-url`, {
        method: 'POST',
        headers: { 'cf-connecting-ip': '203.0.113.7' },
      }),
      { params: Promise.resolve({ siteId: 'site-1', machineId }) },
    );

  it('gives two machines behind one ip independent budgets, keyed on the machine', async () => {
    expect((await mint('machine-a')).status).toBe(200);
    expect((await mint('machine-a')).status).toBe(200);
    const third = await mint('machine-a');
    expect(third.status).toBe(429);

    // the same egress address, a different machine: its own budget, untouched.
    const other = await mint('machine-b');
    expect(other.status).toBe(200);
    expect(other.headers.get('RateLimit-Remaining')).toBe('1');

    expect(Array.from(limiterCalls.keys())).toEqual([
      'screenshot_upload:site-1:machine-a',
      'screenshot_upload:site-1:machine-b',
    ]);
  });

  it('answers a limited machine with the same 429 the wrapper produced', async () => {
    await mint('machine-a');
    await mint('machine-a');
    const limited = await mint('machine-a');

    expect(limited.status).toBe(429);
    expect(limited.headers.get('Content-Type')).toBe('application/problem+json; charset=utf-8');
    expect(limited.headers.get('Retry-After')).toBe('60');
    expect(limited.headers.get('RateLimit-Limit')).toBe('2');
    expect(limited.headers.get('RateLimit-Remaining')).toBe('0');
    expect(limited.headers.get('Roost-Rate-Limited-Reason')).toBe('endpoint-rate');
    const body = await limited.json();
    expect(body).toMatchObject({
      status: 429,
      title: 'rate limited',
      error: 'Rate limit exceeded',
      retryAfter: 60,
      detail: 'Too many requests. Please try again in 60 seconds.',
      message: 'Too many requests. Please try again in 60 seconds.',
    });
    expect(typeof body.type).toBe('string');
    expect(typeof body.requestId).toBe('string');
  });
});
