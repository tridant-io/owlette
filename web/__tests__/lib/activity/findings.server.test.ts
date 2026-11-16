/**
 * @jest-environment node
 */

import {
  claimDigest,
  claimForEmail,
  markDigested,
  readState,
  saveNewFindings,
  writeScannedThrough,
} from '@/lib/activity/findings.server';
import { writeActivityEmailSettings } from '@/lib/activity/emailSettings.server';
import type { Finding } from '@/lib/activity/types';

// a map-backed firestore: just the calls findings.server makes
function fakeDb() {
  const store = new Map<string, Record<string, unknown>>();
  const snap = (path: string) => ({
    exists: store.has(path),
    get: (field: string) => store.get(path)?.[field],
  });
  const ref = (path: string) => ({
    path,
    get: async () => snap(path),
    create: async (data: Record<string, unknown>) => {
      if (store.has(path)) throw Object.assign(new Error('exists'), { code: 6 });
      store.set(path, data);
    },
    update: async (data: Record<string, unknown>) => store.set(path, { ...store.get(path), ...data }),
    set: async (data: Record<string, unknown>) => store.set(path, { ...store.get(path), ...data }),
  });
  const db = {
    store,
    doc: (path: string) => ref(path),
    collection: (path: string) => ({ doc: (id: string) => ref(`${path}/${id}`) }),
    runTransaction: async (fn: (tx: unknown) => Promise<boolean>) =>
      fn({
        get: async (r: { path: string }) => snap(r.path),
        update: (r: { path: string }, data: Record<string, unknown>) =>
          store.set(r.path, { ...store.get(r.path), ...data }),
        set: (r: { path: string }, data: Record<string, unknown>) =>
          store.set(r.path, { ...store.get(r.path), ...data }),
      }),
    batch: () => {
      const ops: (() => void)[] = [];
      return {
        update: (r: { path: string }, data: Record<string, unknown>) =>
          ops.push(() => store.set(r.path, { ...store.get(r.path), ...data })),
        commit: async () => ops.forEach((op) => op()),
      };
    },
  };
  return db as unknown as FirebaseFirestore.Firestore & { store: Map<string, Record<string, unknown>> };
}

const finding = (id: string): Finding => ({
  id,
  rule: 'mfa_removed',
  severity: 'high',
  title: 'mfa removed',
  summary: 's',
  subject: {},
  at: 1,
  facts: [],
  rowIds: [],
});

const path = (id: string) => `global/activity_watch/findings/${id}`;

describe('saveNewFindings', () => {
  it('stores a finding once and returns only the ones it created', async () => {
    const db = fakeDb();
    const first = await saveNewFindings(db, [finding('a'), finding('b')], 100);
    expect(first.map((f) => f.id)).toEqual(['a', 'b']);
    expect(db.store.get(path('a'))).toMatchObject({ detectedAt: 100, emailedAt: null, digestedAt: null });

    const second = await saveNewFindings(db, [finding('a'), finding('c')], 200);
    expect(second.map((f) => f.id)).toEqual(['c']);
    expect(db.store.get(path('a'))?.detectedAt).toBe(100);
  });

  it('rethrows any other error', async () => {
    const db = fakeDb();
    jest.spyOn(db, 'collection').mockReturnValue({
      doc: () => ({ create: async () => { throw new Error('boom'); } }),
    } as never);
    await expect(saveNewFindings(db, [finding('a')], 1)).rejects.toThrow('boom');
  });
});

// firestore rejects an array directly inside an array, and any undefined field
function problems(value: unknown, path = 'doc'): string[] {
  if (value === undefined) return [`${path} is undefined`];
  if (Array.isArray(value)) {
    return value.flatMap((v, i) => (Array.isArray(v) ? [`${path}[${i}] is a nested array`] : []).concat(problems(v, `${path}[${i}]`)));
  }
  if (value && typeof value === 'object') return Object.entries(value).flatMap(([k, v]) => problems(v, `${path}.${k}`));
  return [];
}

describe('saveNewFindings payload', () => {
  it('carries no nested array and no undefined field', async () => {
    const db = fakeDb();
    const full: Finding = {
      ...finding('a'),
      subject: { userId: undefined, actor: 'user:u1', siteId: undefined },
      facts: [{ label: 'by', value: 'u1' }],
    };
    await saveNewFindings(db, [full], 1);
    expect(problems(db.store.get(path('a')))).toEqual([]);
  });
});

describe('claimForEmail', () => {
  it('lets one caller claim a finding and refuses the second', async () => {
    const db = fakeDb();
    await saveNewFindings(db, [finding('a')], 1);
    expect(await claimForEmail(db, 'a', 50)).toBe(true);
    expect(db.store.get(path('a'))?.emailedAt).toBe(50);
    expect(await claimForEmail(db, 'a', 60)).toBe(false);
    expect(db.store.get(path('a'))?.emailedAt).toBe(50);
  });

  it('refuses a finding that does not exist', async () => {
    expect(await claimForEmail(fakeDb(), 'nope', 1)).toBe(false);
  });
});

describe('claimDigest', () => {
  it('claims a day once', async () => {
    const db = fakeDb();
    expect(await claimDigest(db, '2026-11-15')).toBe(true);
    expect(await claimDigest(db, '2026-11-15')).toBe(false);
    expect(await claimDigest(db, '2026-11-16')).toBe(true);
  });
});

describe('state and digest marks', () => {
  const email = { enabled: true, recipients: [] };

  it('reads an empty state, then what was written', async () => {
    const db = fakeDb();
    expect(await readState(db)).toEqual({ scannedThrough: null, lastDigestDay: null, email });
    await writeScannedThrough(db, 900);
    await claimDigest(db, '2026-11-15');
    expect(await readState(db)).toEqual({ scannedThrough: 900, lastDigestDay: '2026-11-15', email });
  });

  it('reads the email settings written beside the cron fields, without clobbering them', async () => {
    const db = fakeDb();
    await writeScannedThrough(db, 900);
    await writeActivityEmailSettings(db, { enabled: false, recipients: ['a@example.test'] });
    await writeScannedThrough(db, 1000);
    expect(await readState(db)).toEqual({
      scannedThrough: 1000,
      lastDigestDay: null,
      email: { enabled: false, recipients: ['a@example.test'] },
    });
  });

  it('marks findings digested', async () => {
    const db = fakeDb();
    await saveNewFindings(db, [finding('a'), finding('b')], 1);
    await markDigested(db, ['a'], 77);
    expect(db.store.get(path('a'))?.digestedAt).toBe(77);
    expect(db.store.get(path('b'))?.digestedAt).toBeNull();
  });
});
