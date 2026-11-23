/**
 * The audit queue drainer (auditLog.ts) against an in-memory firestore whose
 * transactions retry when a doc they read was written before they commit, as
 * firestore's do. Reads yield, so concurrent drainers interleave.
 */

import { describe, it, mock } from 'node:test';
import assert from 'node:assert/strict';
import type { Firestore } from 'firebase-admin/firestore';
import { drainBatch, drainQueuedSites, drainSite } from '../src/auditLog';
import { verifyChain, type AuditRecord } from '../src/lib/auditLogLogic';

type Doc = Record<string, unknown>;

const tick = () => new Promise((r) => setImmediate(r));

function fakeDb(hooks: {
  onRead?: (path: string) => void;
  /** runs after a doc read took its snapshot, before the reader sees it */
  afterRead?: (path: string) => Promise<void>;
  afterQuery?: (path: string, size: number) => Promise<void>;
  /** true fails that transaction's commit for good */
  failCommit?: () => boolean;
  /** a grpc code, or the error itself, to fail the commit with, for a write firestore would refuse */
  refuseWrite?: (path: string, doc: Doc | null) => number | Error | undefined;
} = {}) {
  const data = new Map<string, Doc>();
  const versions = new Map<string, number>();
  let clock = 0;
  let seq = 0;
  const write = (path: string, doc: Doc | null) => {
    if (doc) data.set(path, doc);
    else data.delete(path);
    versions.set(path, ++clock);
  };
  const fail = (code: number) => Object.assign(new Error(`fake firestore code ${code}`), { code });

  const snap = (path: string) => {
    const doc = data.get(path);
    return {
      id: path.split('/').pop(),
      ref: ref(path),
      exists: doc !== undefined,
      updateTime: versions.get(path),
      data: () => doc,
      get: (field: string) => field.split('.').reduce<unknown>((v, k) => (v as Doc | undefined)?.[k], doc),
    };
  };
  const read = async (path: string) => {
    await tick();
    hooks.onRead?.(path);
    const s = snap(path);
    await hooks.afterRead?.(path);
    return s;
  };
  const ref = (path: string) => ({
    path,
    id: path.split('/').pop(),
    parent: collection(path.slice(0, path.lastIndexOf('/'))),
    collection: (name: string) => collection(`${path}/${name}`),
    get: () => read(path),
    set: async (doc: Doc) => write(path, doc),
    delete: async () => write(path, null),
    create: async (doc: Doc) => {
      if (data.has(path)) throw fail(6);
      write(path, doc);
    },
    update: async (doc: Doc, pre?: { lastUpdateTime?: number }) => {
      if (!data.has(path)) throw fail(5);
      if (pre?.lastUpdateTime !== undefined && pre.lastUpdateTime !== versions.get(path)) throw fail(9);
      write(path, { ...data.get(path), ...doc });
    },
  });
  // docs directly under `prefix`, in `field` order then id, as a firestore query returns them
  const query = (path: string, field: string, n = Infinity) => ({
    limit: (m: number) => query(path, field, m),
    get: async () => {
      await tick();
      hooks.onRead?.(path);
      const docs = [...data.keys()]
        .filter((p) => p.startsWith(`${path}/`) && !p.slice(path.length + 1).includes('/'))
        .filter((p) => data.get(p)?.[field] !== undefined)
        .sort((a, b) => Number(data.get(a)?.[field]) - Number(data.get(b)?.[field]) || (a < b ? -1 : 1))
        .slice(0, n)
        .map(snap);
      await hooks.afterQuery?.(path, docs.length);
      return { docs, empty: docs.length === 0, size: docs.length };
    },
  });
  const collection = (path: string): unknown => ({
    path,
    id: path.split('/').pop(),
    parent: path.includes('/') ? ref(path.slice(0, path.lastIndexOf('/'))) : null,
    doc: (id: string) => ref(`${path}/${id}`),
    orderBy: (field: string) => query(path, field),
  });
  // every doc in a collection named `name`, in path order
  const collectionGroup = (name: string, after = '', n = Infinity) => ({
    orderBy: () => collectionGroup(name, after, n),
    startAfter: (a: string) => collectionGroup(name, a, n),
    limit: (m: number) => collectionGroup(name, after, m),
    get: async () => {
      await tick();
      const docs = [...data.keys()]
        .filter((p) => p.split('/').slice(-2)[0] === name && p > after)
        .sort()
        .slice(0, n)
        .map(snap);
      return { docs, empty: docs.length === 0 };
    },
  });

  async function runTransaction<T>(fn: (tx: unknown) => Promise<T>): Promise<T> {
    // more attempts than firestore's 5: this fake has no backoff to spread contenders out
    for (let attempt = 0; attempt < 50; attempt++) {
      const seen = new Map<string, number | undefined>();
      const writes: Array<[string, Doc | null]> = [];
      type Snap = { ref: { path: string }; updateTime?: number };
      const result = await fn({
        get: async (target: { get: () => Promise<Snap | { docs: Snap[] }> }) => {
          if (writes.length > 0) throw new Error('firestore transactions require all reads before all writes');
          const got = await target.get();
          // the version each doc had when it was read, not when the read returned
          for (const d of 'docs' in got ? got.docs : [got]) seen.set(d.ref.path, d.updateTime);
          return got;
        },
        set: (r: { path: string }, doc: Doc) => { writes.push([r.path, doc]); },
        delete: (r: { path: string }) => { writes.push([r.path, null]); },
      });
      await tick();
      if (hooks.failCommit?.()) throw new Error('commit failed');
      for (const [path, doc] of writes) {
        const refused = hooks.refuseWrite?.(path, doc);
        if (refused) throw typeof refused === 'number' ? fail(refused) : refused;
      }
      if ([...seen].every(([path, version]) => versions.get(path) === version)) {
        writes.forEach(([path, doc]) => write(path, doc));
        return result;
      }
    }
    throw fail(10);
  }

  const docsUnder = (path: string) =>
    [...data.keys()].filter((p) => p.startsWith(`${path}/`) && !p.slice(path.length + 1).includes('/'));

  return {
    db: { collection, collectionGroup, runTransaction } as unknown as Firestore,
    enqueue: (siteId: string, event: Doc) => {
      const id = `q${String(++seq).padStart(6, '0')}`;
      write(`sites/${siteId}/audit_queue/${id}`, { event, enqueuedAt: seq });
      return id;
    },
    queued: (siteId: string) => docsUnder(`sites/${siteId}/audit_queue`).length,
    rejected: (siteId: string) => docsUnder(`sites/${siteId}/audit_queue_rejected`).map((p) => data.get(p)),
    chain: (siteId: string) =>
      docsUnder(`sites/${siteId}/audit_log`)
        .map((p) => data.get(p) as unknown as AuditRecord)
        .sort((a, b) => a.recordedAt - b.recordedAt),
    doc: (path: string) => data.get(path),
    findings: (siteId: string) =>
      docsUnder('global/activity_watch/findings')
        .filter((p) => p.startsWith(`global/activity_watch/findings/audit_rejected:${siteId}:`))
        .map((p) => data.get(p) as Doc),
    setDoc: (path: string, doc: Doc | null) => write(path, doc),
  };
}

const event = (siteId: string, target: string): Doc => ({
  kind: 'process_mutated',
  siteId,
  actor: 'user:u1',
  occurredAt: 1,
  target,
  attributes: { endpoint: '/api/test', method: 'POST' },
});

/** one chain that verifies, holds each of `targets` exactly once, and leaves nothing queued. */
function assertChain(f: ReturnType<typeof fakeDb>, siteId: string, targets: string[]) {
  const chain = f.chain(siteId);
  const v = verifyChain(chain, { assertGenesis: true });
  assert.equal(v.ok, true, v.ok ? '' : `chain broke at ${v.brokenAt}: ${v.reason}`);
  assert.deepEqual(chain.map((r) => r.event.target).sort(), [...targets].sort());
  for (let i = 1; i < chain.length; i++) assert.ok(chain[i].recordedAt > chain[i - 1].recordedAt);
  assert.equal((f.doc(`sites/${siteId}/audit_log_meta/head`) as { hash?: string })?.hash, chain[chain.length - 1]?.hash);
  assert.equal(f.queued(siteId), 0);
}

const targets = (n: number) => Array.from({ length: n }, (_, i) => `t${i}`);
const HOUR = 60 * 60 * 1000;

describe('audit queue drain', () => {
  it('two drainers at once, while events arrive, build one chain holding every event once', async () => {
    const f = fakeDb();
    let arrived = false;
    const arriving = (async () => {
      for (const t of targets(300)) {
        f.enqueue('s1', event('s1', t));
        if (t.endsWith('7')) await tick();
      }
      arrived = true;
    })();
    const drainer = async () => {
      while (!arrived || f.queued('s1') > 0) await drainBatch(f.db, 's1');
    };
    await Promise.all([arriving, drainer(), drainer()]);
    assertChain(f, 's1', targets(300));
  });

  it('a drain that commits between another\'s head read and queue read does not fork the chain', async () => {
    let interleaved = false;
    const f = fakeDb({
      afterRead: async (path) => {
        // the first drainer has read the head; a second commits a whole batch before it reads the queue
        if (interleaved || path !== 'sites/s1/audit_log_meta/head') return;
        interleaved = true;
        await drainBatch(f.db, 's1');
      },
    });
    for (const t of targets(150)) f.enqueue('s1', event('s1', t));
    await drainBatch(f.db, 's1');
    assert.ok(interleaved);
    assertChain(f, 's1', targets(150));
  });

  it('a failure with no grpc code writes nothing and sets nothing aside: both events stay queued', async () => {
    let fail = true;
    const f = fakeDb({ failCommit: () => fail });
    f.enqueue('s1', event('s1', 'good'));
    f.enqueue('s1', { ...event('s1', 'bad'), kind: 'not_a_kind' });
    await assert.rejects(drainSite(f.db, 's1'), /commit failed/);
    assert.equal(f.queued('s1'), 2);
    assert.deepEqual(f.rejected('s1'), []);
    assert.deepEqual(f.findings('s1'), []);
    assert.deepEqual(f.chain('s1'), []);
    fail = false;
    assert.equal(await drainBatch(f.db, 's1'), 2);
    assertChain(f, 's1', ['good']);
    assert.equal(f.rejected('s1').length, 1);
  });

  describe('an event firestore refuses to store', () => {
    // firestore's INVALID_ARGUMENT for a document over its size limit, for any doc that carries the poison attribute
    const tooLarge = (_path: string, doc: Doc | null) =>
      (doc?.event as { attributes?: { poison?: boolean } } | undefined)?.attributes?.poison ? 3 : undefined;

    it('is set aside as a truncated copy while the events around it land in order', async () => {
      const f = fakeDb({ refuseWrite: tooLarge });
      for (const t of targets(5)) {
        f.enqueue('s1', t === 't2' ? { ...event('s1', t), attributes: { poison: true } } : event('s1', t));
      }
      await drainSite(f.db, 's1');
      assertChain(f, 's1', ['t0', 't1', 't3', 't4']);
      assert.deepEqual(f.chain('s1').map((r) => r.event.target), ['t0', 't1', 't3', 't4']);
      const [rejected] = f.rejected('s1') as Array<{ reason: string; event: { kind: string; truncated: string } }>;
      assert.match(rejected.reason, /^write_failed: fake firestore code 3/);
      assert.equal(rejected.event.kind, 'process_mutated');
      assert.match(rejected.event.truncated, /"target":"t2"/);
      const [finding] = f.findings('s1');
      assert.deepEqual(finding, {
        id: `audit_rejected:s1:${Math.floor(Number(finding.detectedAt) / HOUR)}`,
        rule: 'audit_rejected',
        severity: 'high',
        title: 'audit events not recorded',
        summary: '1 audit event for s1 was set aside so far this hour instead of joining its audit log.',
        subject: { siteId: 's1' },
        at: finding.detectedAt,
        facts: [
          { label: 'site', value: 's1' },
          { label: 'set aside', value: '1' },
          { label: 'latest reasons', value: rejected.reason },
        ],
        rowIds: [],
        count: 1,
        reasons: [rejected.reason],
        detectedAt: finding.detectedAt,
        emailedAt: null,
        digestedAt: null,
      });
      assert.equal(typeof finding.detectedAt, 'number');
    });

    it('is not set aside when, drained alone, it fails for a transient reason', async () => {
      let recordWrites = 0;
      const f = fakeDb({
        // the batch is refused outright, then the event drained alone meets a transient failure
        refuseWrite: (path) => (path.includes('/audit_log/') ? (recordWrites++ === 0 ? 3 : 14) : undefined),
      });
      for (const t of targets(3)) f.enqueue('s1', event('s1', t));
      await assert.rejects(drainSite(f.db, 's1'), /code 14/);
      assert.equal(f.queued('s1'), 3);
      assert.deepEqual(f.rejected('s1'), []);
    });

    it('is not set aside when its transaction expired, which firestore retries rather than refuses', async () => {
      const expired = Object.assign(new Error('3 INVALID_ARGUMENT: The transaction has expired.'), { code: 3 });
      const f = fakeDb({ refuseWrite: (path) => (path.includes('/audit_log/') ? expired : undefined) });
      for (const t of targets(2)) f.enqueue('s1', event('s1', t));
      await assert.rejects(drainSite(f.db, 's1'), /transaction has expired/);
      assert.equal(f.queued('s1'), 2);
      assert.deepEqual(f.rejected('s1'), []);
    });

    it('is not set aside for a transient failure: the drain stops and every event stays queued', async () => {
      const f = fakeDb({ refuseWrite: () => 14 });
      for (const t of targets(3)) f.enqueue('s1', event('s1', t));
      await assert.rejects(drainSite(f.db, 's1'), /code 14/);
      assert.equal(f.queued('s1'), 3);
      assert.deepEqual(f.rejected('s1'), []);
      assert.equal(f.doc('sites/s1/audit_log_meta/drain_lock'), undefined);
    });
  });

  for (const [name, before, between] of [
    ['absent, and another trigger creates it', null, { expiresAt: Date.now() + 60_000 }],
    ['lapsed, and another trigger takes it over', { expiresAt: 1 }, { expiresAt: Date.now() + 60_000 }],
    ['lapsed, and another trigger takes and releases it', { expiresAt: 1 }, null],
  ] as const) {
    it(`a trigger returns without draining when the lock it read was ${name} before its write`, async () => {
      const lock = 'sites/s1/audit_log_meta/drain_lock';
      let raced = false;
      const f = fakeDb({
        afterRead: async (path) => {
          if (raced || path !== lock) return;
          raced = true;
          f.setDoc(lock, between);
        },
      });
      if (before) f.setDoc(lock, before);
      f.enqueue('s1', event('s1', 't0'));
      await drainSite(f.db, 's1');
      assert.ok(raced);
      assert.equal(f.queued('s1'), 1);
    });
  }

  it('takes at most 100 events per transaction', async () => {
    const f = fakeDb();
    for (const t of targets(150)) f.enqueue('s1', event('s1', t));
    assert.deepEqual(
      [await drainBatch(f.db, 's1'), await drainBatch(f.db, 's1'), await drainBatch(f.db, 's1')],
      [100, 50, 0],
    );
    assertChain(f, 's1', targets(150));
  });

  it('sets aside an invalid event with its finding in the same commit, and leaves the head alone', async () => {
    const f = fakeDb();
    f.enqueue('s1', { ...event('s1', 'bad'), kind: 'not_a_kind' });
    assert.equal(await drainBatch(f.db, 's1'), 1);
    assert.equal(f.queued('s1'), 0);
    const [rejected] = f.rejected('s1') as Array<{ reason: string; event: Doc }>;
    assert.equal(rejected.reason, 'invalid_kind');
    assert.equal(rejected.event.target, 'bad');
    assert.deepEqual(f.findings('s1').map((x) => [x.rule, x.count, x.reasons]), [['audit_rejected', 1, ['invalid_kind']]]);
    assert.equal(f.doc('sites/s1/audit_log_meta/head'), undefined);
  });

  describe('the set-aside finding', () => {
    const bad = (kind: string) => ({ ...event('s1', kind), kind });

    it('counts every set-aside of one hour into one finding, through single and batch drains', async () => {
      const f = fakeDb();
      for (const kind of ['kind_a', 'kind_b', 'kind_a', 'kind_c', 'kind_d']) f.enqueue('s1', bad(kind));
      // one by one, then a batch: both paths add to the same finding
      await drainBatch(f.db, 's1', 1);
      await drainBatch(f.db, 's1', 1);
      await drainBatch(f.db, 's1');
      const all = f.findings('s1');
      assert.equal(all.length, 1);
      assert.equal(all[0].count, 5);
      assert.equal(all[0].summary, '5 audit events for s1 were set aside so far this hour instead of joining its audit log.');
      assert.deepEqual(all[0].reasons, ['invalid_kind']);
      assert.equal(f.rejected('s1').length, 5);
    });

    it('keeps the newest distinct reasons first, at most three', async () => {
      const f = fakeDb();
      f.enqueue('s1', bad('kind_x'));
      f.enqueue('s1', event('other-site', 'x'));
      f.enqueue('s1', bad('kind_y'));
      f.enqueue('s1', { ...event('s1', 'x'), actor: '' });
      f.enqueue('s1', { ...event('s1', 'x'), occurredAt: 0 });
      while ((await drainBatch(f.db, 's1', 1)) > 0);
      assert.deepEqual(f.findings('s1')[0].reasons, ['occurredAt_required', 'actor_required', 'invalid_kind']);
      assert.equal(f.findings('s1')[0].count, 5);
    });

    it('counts an event set aside after a refused commit into the same finding, its reason cut to 200 characters', async () => {
      const long = Object.assign(new Error(`3 INVALID_ARGUMENT: ${'x'.repeat(500)}`), { code: 3 });
      const f = fakeDb({
        refuseWrite: (_path, doc) =>
          (doc?.event as { attributes?: { poison?: boolean } } | undefined)?.attributes?.poison ? long : undefined,
      });
      f.enqueue('s1', bad('kind_a'));
      f.enqueue('s1', { ...event('s1', 'p'), attributes: { poison: true } });
      await drainSite(f.db, 's1');
      const all = f.findings('s1');
      assert.equal(all.length, 1);
      assert.equal(all[0].count, 2);
      const reasons = all[0].reasons as string[];
      assert.equal(reasons[0].length, 200);
      assert.match(reasons[0], /^write_failed: 3 INVALID_ARGUMENT: x+$/);
      assert.equal(reasons[1], 'invalid_kind');
    });

    it('adds to a finding already mailed without making it mail again', async () => {
      const f = fakeDb();
      f.enqueue('s1', bad('kind_a'));
      await drainBatch(f.db, 's1');
      const [first] = f.findings('s1');
      const path = `global/activity_watch/findings/${first.id}`;
      f.setDoc(path, { ...first, emailedAt: 1234 });
      f.enqueue('s1', bad('kind_b'));
      await drainBatch(f.db, 's1');
      const [after] = f.findings('s1');
      assert.equal(after.count, 2);
      assert.equal(after.emailedAt, 1234);
      assert.equal(after.detectedAt, first.detectedAt);
    });

    it('starts a new finding in the next hour', async () => {
      const f = fakeDb();
      const now = mock.method(Date, 'now', () => 1000 * HOUR + 59 * 60 * 1000);
      try {
        f.enqueue('s1', bad('kind_a'));
        await drainBatch(f.db, 's1');
        now.mock.mockImplementation(() => 1001 * HOUR);
        f.enqueue('s1', bad('kind_b'));
        await drainBatch(f.db, 's1');
      } finally {
        now.mock.restore();
      }
      assert.deepEqual(f.findings('s1').map((x) => [x.id, x.count]), [
        ['audit_rejected:s1:1000', 1],
        ['audit_rejected:s1:1001', 1],
      ]);
    });
  });

  it('five triggers for one burst drain it all and release the drain lock', async () => {
    const f = fakeDb();
    for (const t of targets(250)) f.enqueue('s1', event('s1', t));
    await Promise.all(Array.from({ length: 5 }, () => drainSite(f.db, 's1')));
    assertChain(f, 's1', targets(250));
    assert.equal(f.doc('sites/s1/audit_log_meta/drain_lock'), undefined);
  });

  it('drains an event whose trigger returned at the lock while the holder was finishing', async () => {
    let late = false;
    let queuedWhenTriggerReturned = -1;
    const f = fakeDb({
      afterQuery: async (path, size) => {
        // the holder's batch has found the queue empty; an event arrives and its trigger runs
        if (late || path !== 'sites/s1/audit_queue' || size > 0) return;
        late = true;
        f.enqueue('s1', event('s1', 'late'));
        await drainSite(f.db, 's1');
        queuedWhenTriggerReturned = f.queued('s1');
      },
    });
    f.enqueue('s1', event('s1', 'first'));
    await drainSite(f.db, 's1');
    assert.equal(queuedWhenTriggerReturned, 1, 'the late trigger should have returned at the held lock');
    assertChain(f, 's1', ['first', 'late']);
  });

  it('waits out a dead holder\'s lock, then takes it over once it lapses', async () => {
    const f = fakeDb();
    for (const t of targets(20)) f.enqueue('s1', event('s1', t));
    f.setDoc('sites/s1/audit_log_meta/drain_lock', { expiresAt: Date.now() + 60_000 });
    await drainSite(f.db, 's1');
    assert.equal(f.queued('s1'), 20);
    f.setDoc('sites/s1/audit_log_meta/drain_lock', { expiresAt: Date.now() - 1 });
    await drainSite(f.db, 's1');
    assertChain(f, 's1', targets(20));
  });

  it('the sweeper drains every queued site, past one that cannot drain', async () => {
    const f = fakeDb({
      onRead: (path) => {
        if (path.startsWith('sites/b/')) throw new Error('unavailable');
      },
    });
    for (const site of ['a', 'b', 'c']) {
      for (const t of targets(30)) f.enqueue(site, event(site, t));
    }
    const deadline = Date.now() + 10_000;
    await drainQueuedSites(f.db, deadline);
    assert.ok(Date.now() < deadline, 'the sweep should end once every site was tried, not at its deadline');
    assertChain(f, 'a', targets(30));
    assertChain(f, 'c', targets(30));
    assert.equal(f.queued('b'), 30);
  });
});
