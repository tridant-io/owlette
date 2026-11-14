/** @jest-environment node */

/**
 * Screenshot storage: what finalize and the legacy upload record, who may
 * record a capture, and how a stored screenshot is read back.
 */

import { createMockRequest } from './helpers/utils';

const SITE = 'site-a';
const MACHINE = 'm1';
const BUCKET = 'bucket.example';
const AGENT_CLAIMS = { uid: 'agent-uid', role: 'agent', site_id: SITE, machine_id: MACHINE };

const docs = new Map<string, Record<string, unknown>>();
const madePublic: string[] = [];
const saved: string[] = [];
const deleted: string[] = [];
const signedReads: string[] = [];
let nextId = 0;

const mockVerifyIdToken = jest.fn();
const mockRequireMachineAuth = jest.fn();

function fileRef(path: string) {
  return {
    exists: async () => [true],
    setMetadata: async () => undefined,
    getMetadata: async () => [{ size: '20480' }],
    makePublic: async () => {
      madePublic.push(path);
    },
    save: async () => {
      saved.push(path);
    },
    delete: async () => {
      deleted.push(path);
    },
    getSignedUrl: async (opts: { action: string }) => {
      if (opts.action === 'read') signedReads.push(path);
      return [`https://signed.example/${opts.action}/${path}`];
    },
  };
}

function docRef(path: string) {
  return {
    path,
    collection: (name: string) => collectionRef(`${path}/${name}`),
    get: async () => ({ exists: docs.has(path), data: () => docs.get(path) }),
    set: async (data: Record<string, unknown>) => {
      docs.set(path, { ...(docs.get(path) ?? {}), ...data });
    },
    update: async (data: Record<string, unknown>) => {
      docs.set(path, { ...(docs.get(path) ?? {}), ...data });
    },
    delete: async () => {
      docs.delete(path);
    },
  };
}

function collectionRef(path: string) {
  const list = async () => {
    const children = Array.from(docs.keys()).filter(
      (key) => key.startsWith(`${path}/`) && !key.slice(path.length + 1).includes('/'),
    );
    const snaps = children.map((key) => ({
      id: key.slice(path.length + 1),
      data: () => docs.get(key),
      ref: docRef(key),
    }));
    return { size: snaps.length, empty: snaps.length === 0, docs: snaps };
  };
  return {
    doc: (id: string) => docRef(`${path}/${id}`),
    add: async (data: Record<string, unknown>) => {
      const ref = docRef(`${path}/auto-${String(nextId++).padStart(4, '0')}`);
      await ref.set(data);
      return ref;
    },
    orderBy: () => ({ get: list }),
    where: (field: string, _op: '==', value: unknown) => ({
      limit: (n: number) => ({
        get: async () => {
          const all = await list();
          const matching = all.docs.filter((d) => d.data()?.[field] === value).slice(0, n);
          return { size: matching.length, empty: matching.length === 0, docs: matching };
        },
      }),
    }),
    get: list,
  };
}

jest.mock('@/lib/firebase-admin', () => ({
  getAdminAuth: () => ({ verifyIdToken: (...args: unknown[]) => mockVerifyIdToken(...args) }),
  getAdminDb: () => ({ collection: (name: string) => collectionRef(name) }),
  getAdminStorage: () => ({
    bucket: (name: string) => ({ name, file: (path: string) => fileRef(path) }),
  }),
}));
jest.mock('@/app/api/_shared', () => ({
  ...jest.requireActual('@/app/api/_shared'),
  requireMachineAuthAndScope: (...args: unknown[]) => mockRequireMachineAuth(...args),
}));
jest.mock('@/lib/withRateLimit', () => ({
  ...jest.requireActual('@/lib/withRateLimit'),
  withRateLimit: (handler: unknown) => handler,
}));
jest.mock('@sentry/nextjs', () => ({ captureException: jest.fn(), captureMessage: jest.fn() }));

import { POST as finalizePOST } from '@/app/api/sites/[siteId]/machines/[machineId]/screenshots/finalize/route';
import { POST as legacyPOST } from '@/app/api/agent/screenshot/route';
import * as screenshotStorage from '@/lib/screenshotStorage.server';

const screenshotUrlForModel = (url: string, siteId: string, machineId = MACHINE) =>
  screenshotStorage.screenshotUrlForModel(url, siteId, machineId);

const MACHINE_DOC = `sites/${SITE}/machines/${MACHINE}`;
const HISTORY = `${MACHINE_DOC}/screenshots`;

function imageUrl(storagePath: string): string {
  return `/api/sites/${SITE}/machines/${MACHINE}/screenshots/image?path=${encodeURIComponent(storagePath)}`;
}

function historyDocs(): Record<string, unknown>[] {
  return Array.from(docs.entries())
    .filter(([key]) => key.startsWith(`${HISTORY}/`))
    .map(([, data]) => data);
}

const params = { params: Promise.resolve({ siteId: SITE, machineId: MACHINE }) };

function finalize(storagePath: string, token = 'agent-token') {
  return finalizePOST(
    createMockRequest(`http://localhost/api/sites/${SITE}/machines/${MACHINE}/screenshots/finalize`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}` },
      body: { storagePath, sizeKB: 20, monitor: 0, contentType: 'image/jpeg' },
    }),
    params,
  );
}

async function readImage(query: string) {
  const { GET: imageGET } = await import(
    '@/app/api/sites/[siteId]/machines/[machineId]/screenshots/image/route'
  );
  return imageGET(
    createMockRequest(`http://localhost/api/sites/${SITE}/machines/${MACHINE}/screenshots/image${query}`),
    params,
  );
}

beforeEach(() => {
  docs.clear();
  madePublic.length = 0;
  saved.length = 0;
  deleted.length = 0;
  signedReads.length = 0;
  nextId = 0;
  mockVerifyIdToken.mockReset();
  mockRequireMachineAuth.mockReset();
  mockRequireMachineAuth.mockResolvedValue({
    ok: true,
    userId: 'member-uid',
    auth: { userId: 'member-uid', keyContext: null },
    scopeCheck: { isLegacy: false },
    machineIds: null,
  });
  process.env.NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET = BUCKET;
});

describe('POST .../screenshots/finalize', () => {
  const PATH = `screenshots/${SITE}/${MACHINE}/1700000000000-aabbccdd.jpg`;

  it('records the capture by storage path and leaves the object private', async () => {
    mockVerifyIdToken.mockResolvedValue(AGENT_CLAIMS);

    const res = await finalize(PATH);

    expect(res.status).toBe(200);
    expect(madePublic).toEqual([]);
    const body = await res.json();
    expect(body.data.url).toBe(imageUrl(PATH));
    expect(docs.get(MACHINE_DOC)?.lastScreenshot).toMatchObject({ path: PATH, url: imageUrl(PATH) });
    expect(historyDocs()).toEqual([expect.objectContaining({ path: PATH, url: imageUrl(PATH) })]);
  });

  it("refuses a site member: only the machine's own agent records a capture", async () => {
    mockVerifyIdToken.mockRejectedValue(new Error('not an id token'));

    const res = await finalize(PATH, 'member-session');

    expect(res.status).toBe(403);
    expect(docs.size).toBe(0);
  });

  it("refuses another machine's agent", async () => {
    mockVerifyIdToken.mockResolvedValue({ ...AGENT_CLAIMS, machine_id: 'm2' });

    const res = await finalize(PATH);

    expect(res.status).toBe(403);
    expect(docs.size).toBe(0);
  });

  it('prunes history past 20 by stored path, and by the url on an older record', async () => {
    mockVerifyIdToken.mockResolvedValue(AGENT_CLAIMS);
    const legacy = `screenshots/${SITE}/${MACHINE}/history/1.jpg`;
    const recorded = `screenshots/${SITE}/${MACHINE}/2-aaaaaaaa.jpg`;
    docs.set(`${HISTORY}/a-old`, { url: `https://storage.googleapis.com/${BUCKET}/${legacy}` });
    docs.set(`${HISTORY}/b-old`, { path: recorded, url: imageUrl(recorded) });
    for (let i = 0; i < 19; i++) {
      const p = `screenshots/${SITE}/${MACHINE}/${10 + i}-aaaaaaaa.jpg`;
      docs.set(`${HISTORY}/c-${String(i).padStart(2, '0')}`, { path: p, url: imageUrl(p) });
    }

    expect((await finalize(PATH)).status).toBe(200);

    expect(deleted).toEqual([legacy, recorded]);
    expect(historyDocs()).toHaveLength(20);
  });
});

describe('GET .../screenshots/image', () => {
  it("redirects a member to a fresh signed read url for this machine's screenshot", async () => {
    const path = `screenshots/${SITE}/${MACHINE}/1700000000000-aabbccdd.jpg`;

    const res = await readImage(`?path=${encodeURIComponent(path)}`);

    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toBe(`https://signed.example/read/${path}`);
    expect(res.headers.get('cache-control')).toContain('no-store');
    expect(mockRequireMachineAuth).toHaveBeenCalledWith(expect.anything(), SITE, MACHINE, 'read');
  });

  it.each([
    ['another site', `screenshots/site-b/${MACHINE}/1.jpg`],
    ['another machine', `screenshots/${SITE}/m2/1.jpg`],
    ['another folder', `chat-images/u1/c1/1.jpg`],
    ['a climb out of the folder', `screenshots/${SITE}/${MACHINE}/../../site-b/m1/1.jpg`],
    ['the folder itself', `screenshots/${SITE}/${MACHINE}/`],
  ])('signs nothing for a path in %s', async (_label, path) => {
    const res = await readImage(`?path=${encodeURIComponent(path)}`);

    expect(res.status).toBe(400);
    expect(signedReads).toEqual([]);
  });

  it('signs nothing without a path', async () => {
    expect((await readImage('')).status).toBe(400);
    expect(signedReads).toEqual([]);
  });

  it('answers a caller without access the way machine auth does', async () => {
    const { NextResponse } = await import('next/server');
    mockRequireMachineAuth.mockResolvedValue({
      ok: false,
      response: NextResponse.json({ title: 'not found' }, { status: 404 }),
    });

    const res = await readImage(`?path=${encodeURIComponent(`screenshots/${SITE}/${MACHINE}/1.jpg`)}`);

    expect(res.status).toBe(404);
    expect(signedReads).toEqual([]);
  });
});

describe('POST /api/agent/screenshot (agents before the signed-url upload)', () => {
  it('stores the capture privately and records it by storage path', async () => {
    mockVerifyIdToken.mockResolvedValue(AGENT_CLAIMS);

    const res = await legacyPOST(
      createMockRequest('http://localhost/api/agent/screenshot', {
        method: 'POST',
        headers: { Authorization: 'Bearer agent-token' },
        body: { siteId: SITE, machineId: MACHINE, screenshot: 'aGVsbG8=' },
      }),
    );

    expect(res.status).toBe(200);
    expect(madePublic).toEqual([]);
    const latest = `screenshots/${SITE}/${MACHINE}/latest.jpg`;
    expect(saved[0]).toBe(latest);
    const lastScreenshot = docs.get(MACHINE_DOC)?.lastScreenshot as { path: string; url: string };
    expect(lastScreenshot.path).toBe(latest);
    expect(lastScreenshot.url.startsWith(`${imageUrl(latest)}&t=`)).toBe(true);
    expect((await res.json()).url).toBe(lastScreenshot.url);
    expect(historyDocs()).toEqual([
      expect.objectContaining({ path: saved[1], url: imageUrl(saved[1]) }),
    ]);
  });
});

describe('screenshotUrlForModel', () => {
  const PATH = `screenshots/${SITE}/${MACHINE}/1-aabbccdd.jpg`;

  it('signs the path stored on the machine record the url belongs to', async () => {
    docs.set(`${HISTORY}/a`, { path: PATH, url: imageUrl(PATH) });

    await expect(screenshotUrlForModel(imageUrl(PATH), SITE)).resolves.toBe(
      `https://signed.example/read/${PATH}`,
    );
  });

  it('signs nothing for a url no record of the machine carries', async () => {
    await expect(screenshotUrlForModel(imageUrl(PATH), SITE)).resolves.toBeNull();
    expect(signedReads).toEqual([]);
  });

  it.each([
    ['another site', `screenshots/site-b/${MACHINE}/1.jpg`],
    ['another machine', `screenshots/${SITE}/m2/1.jpg`],
  ])('signs nothing for a record whose path is on %s', async (_label, path) => {
    docs.set(`${HISTORY}/a`, { path, url: imageUrl(PATH) });

    await expect(screenshotUrlForModel(imageUrl(PATH), SITE)).resolves.toBeNull();
    expect(signedReads).toEqual([]);
  });

  it('signs nothing for a machine id that is not a document id', async () => {
    await expect(screenshotUrlForModel(imageUrl(PATH), SITE, `${MACHINE}/screenshots/a`)).resolves.toBeNull();
    expect(signedReads).toEqual([]);
  });

  it('passes an absolute url through', async () => {
    const url = `https://storage.googleapis.com/${BUCKET}/screenshots/${SITE}/${MACHINE}/1.jpg?t=1`;
    await expect(screenshotUrlForModel(url, SITE)).resolves.toBe(url);
  });
});
