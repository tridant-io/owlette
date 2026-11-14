/**
 * the functions-side plan gate: reading `plan_snapshot/{siteId}`, and the
 * skip-or-proceed decision on it. every failure proceeds.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { planBlockReason, readSitePlanSnapshot, type PlanSnapshot } from '../src/lib/planSnapshot';

type Docs = Record<string, Record<string, unknown> | undefined>;

/** a firestore stand-in keyed by doc path; `failOn` paths throw on read. */
function fakeDb(docs: Docs, failOn: string[] = []) {
  const reads: string[] = [];
  const db = {
    collection: (name: string) => ({
      doc: (id: string) => ({
        get: async () => {
          const path = `${name}/${id}`;
          reads.push(path);
          if (failOn.includes(path)) throw new Error('firestore unavailable');
          return { data: () => docs[path] };
        },
      }),
    }),
  } as unknown as FirebaseFirestore.Firestore;
  return { db, reads };
}

const FREE: PlanSnapshot = { enforced: true, control: false, roost: false, resolvedAt: 1 };

describe('readSitePlanSnapshot', () => {
  it('reads plan_snapshot/{siteId} in the shape the plan-daily cron writes, and nothing else', async () => {
    const { db, reads } = fakeDb({
      'sites/site-1': { owner: 'uid-1' },
      'plan_snapshot/site-1': { enforced: true, control: true, roost: false, resolvedAt: 1 },
      // a leftover of the owner-keyed snapshots, which no longer decides anything.
      'plan_snapshot/uid-1': { ...FREE },
    });
    assert.deepEqual(await readSitePlanSnapshot(db, 'site-1'), {
      enforced: true,
      control: true,
      roost: false,
      resolvedAt: 1,
    });
    assert.deepEqual(reads, ['plan_snapshot/site-1']);
  });

  it('is null when the site has no snapshot yet', async () => {
    const { db } = fakeDb({});
    assert.equal(await readSitePlanSnapshot(db, 'site-1'), null);
  });

  it('is null when the read fails', async () => {
    const { db } = fakeDb({}, ['plan_snapshot/site-1']);
    assert.equal(await readSitePlanSnapshot(db, 'site-1'), null);
  });

  it('withholds only on an explicit false, and enforces only on an explicit true', async () => {
    const { db } = fakeDb({
      'plan_snapshot/site-1': { enforced: 'true', control: 0, roost: null },
    });
    assert.deepEqual(await readSitePlanSnapshot(db, 'site-1'), {
      enforced: false,
      control: true,
      roost: true,
      resolvedAt: undefined,
    });
  });
});

describe('planBlockReason', () => {
  it('proceeds without a snapshot', () => {
    assert.equal(planBlockReason(null, ['roost', 'control']), null);
  });

  it('proceeds when plans were not enforced, whatever the flags say', () => {
    assert.equal(planBlockReason({ ...FREE, enforced: false }, ['roost', 'control']), null);
  });

  it('proceeds when every flag asked for is entitled', () => {
    const core: PlanSnapshot = { ...FREE, control: true };
    assert.equal(planBlockReason(core, ['control']), null);
    assert.equal(planBlockReason({ ...core, roost: true }, ['roost', 'control']), null);
  });

  it('names the first withheld flag, in the order asked', () => {
    assert.equal(
      planBlockReason(FREE, ['roost', 'control']),
      "this site's plan doesn't include roost",
    );
    assert.equal(
      planBlockReason({ ...FREE, roost: true }, ['roost', 'control']),
      "this site's plan doesn't include remote control",
    );
  });
});
