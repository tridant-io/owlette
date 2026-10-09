/**
 * Scheduled-rollout sweep: the pure decision, the claim's write shape, and the
 * sweep loop.
 *
 * The claim is exercised through the REAL `applyScheduledRolloutClaim` with a
 * fake writer, so "an already-claimed rollout writes nothing" is proved against
 * the shipping code rather than against a fake that reimplements it.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  decideScheduledRollout,
  isRoostEnabled,
  DEFAULT_EXTRACT_ROOT,
  MISSED_FIRE_GRACE_MS,
  ROOST_ENABLED_FIELD,
  type ScheduledRolloutDecision,
} from '../src/lib/rolloutScheduleLogic';
import {
  applyScheduledRolloutClaim,
  sweepDueScheduledRollouts,
  type RolloutDocData,
  type RolloutScheduleStore,
  type ScheduledRolloutRef,
} from '../src/rolloutScheduler';
import type { PlanSnapshot } from '../src/lib/planSnapshot';

const NOW = Date.parse('2026-05-01T03:00:00.000Z');
const MINUTE = 60_000;

const REF: ScheduledRolloutRef = {
  siteId: 'site-alpha',
  roostId: 'rst_lobby',
  versionId: 'vrs_v7',
};

function scheduledDoc(overrides: Partial<RolloutDocData> = {}): RolloutDocData {
  return {
    stage: 'scheduled',
    scheduledAt: NOW - MINUTE,
    versionUrl: 'https://r2.example/v7.json',
    extractRoot: '~/Documents/Owlette/lobby',
    canary: ['machine-a', 'machine-b'],
    ...overrides,
  };
}

// -- pure decision ----------------------------------------------------------

describe('decideScheduledRollout', () => {
  const base = {
    stage: 'scheduled',
    scheduledAtMs: NOW - MINUTE,
    canaryCount: 2,
    hasVersionUrl: true,
  };

  it('fires a rollout whose instant has passed', () => {
    assert.deepEqual(decideScheduledRollout(base, NOW), { action: 'fire' });
  });

  it('fires one due to the millisecond', () => {
    assert.deepEqual(
      decideScheduledRollout({ ...base, scheduledAtMs: NOW }, NOW),
      { action: 'fire' },
    );
  });

  it('leaves a future rollout alone', () => {
    const d = decideScheduledRollout({ ...base, scheduledAtMs: NOW + MINUTE }, NOW);
    assert.deepEqual(d, { action: 'skip', reason: 'not_due' });
  });

  it('skips a rollout another sweep already flipped to canary', () => {
    const d = decideScheduledRollout({ ...base, stage: 'canary' }, NOW);
    assert.deepEqual(d, { action: 'skip', reason: 'claimed' });
  });

  it('skips a terminal rollout', () => {
    for (const stage of ['complete', 'aborted', 'fleet', undefined]) {
      const d = decideScheduledRollout({ ...base, stage }, NOW);
      assert.deepEqual(d, { action: 'skip', reason: 'claimed' });
    }
  });

  it('fires at exactly the grace boundary, writes off one ms past it', () => {
    const atBoundary = decideScheduledRollout(
      { ...base, scheduledAtMs: NOW - MISSED_FIRE_GRACE_MS },
      NOW,
    );
    assert.equal(atBoundary.action, 'fire');

    const pastBoundary = decideScheduledRollout(
      { ...base, scheduledAtMs: NOW - MISSED_FIRE_GRACE_MS - 1 },
      NOW,
    );
    assert.equal(pastBoundary.action, 'write_off');
  });

  it('write-off reason names how late the rollout was', () => {
    const d = decideScheduledRollout(
      { ...base, scheduledAtMs: NOW - 90 * MINUTE },
      NOW,
    );
    assert.equal(d.action, 'write_off');
    assert.match((d as { reason: string }).reason, /missed its scheduled fire window by 90m/);
  });

  it('lateness beats every other write-off reason', () => {
    // A grossly late rollout is written off for lateness, not for its contents.
    const d = decideScheduledRollout(
      {
        ...base,
        scheduledAtMs: NOW - 90 * MINUTE,
        canaryCount: 0,
        hasVersionUrl: false,
      },
      NOW,
    );
    assert.match((d as { reason: string }).reason, /missed its scheduled fire window/);
  });

  it('writes off a rollout with no versionUrl instead of parking it forever', () => {
    const d = decideScheduledRollout({ ...base, hasVersionUrl: false }, NOW);
    assert.equal(d.action, 'write_off');
    assert.match((d as { reason: string }).reason, /versionUrl/);
  });

  it('writes off a rollout with no canary targets', () => {
    const d = decideScheduledRollout({ ...base, canaryCount: 0 }, NOW);
    assert.equal(d.action, 'write_off');
    assert.match((d as { reason: string }).reason, /canary targets/);
  });

  it('writes off a rollout with an unusable scheduledAt', () => {
    const d = decideScheduledRollout({ ...base, scheduledAtMs: null }, NOW);
    assert.equal(d.action, 'write_off');
    assert.match((d as { reason: string }).reason, /scheduledAt/);
  });

  it('honours an injected grace window', () => {
    const state = { ...base, scheduledAtMs: NOW - 20 * MINUTE };
    assert.equal(decideScheduledRollout(state, NOW, 30 * MINUTE).action, 'fire');
    assert.equal(decideScheduledRollout(state, NOW, 10 * MINUTE).action, 'write_off');
  });
});

describe('isRoostEnabled', () => {
  it('is the field name the web + agent mirrors use', () => {
    assert.equal(ROOST_ENABLED_FIELD, 'roostEnabled');
  });

  it('only an explicit false disables', () => {
    assert.equal(isRoostEnabled(false), false);
    assert.equal(isRoostEnabled(true), true);
  });

  it('fails open on absent or non-boolean values', () => {
    for (const value of [undefined, null, 'false', 0, {}]) {
      assert.equal(isRoostEnabled(value), true);
    }
  });
});

// -- claim writes -----------------------------------------------------------

interface RecordedWrite {
  op: 'set' | 'update';
  path: string;
  data: Record<string, unknown>;
  options?: unknown;
}

/** Fake refs are plain path strings; the claim only ever passes them through. */
function fakeClaim(
  data: RolloutDocData | null,
  nowMs = NOW,
  graceMs = MISSED_FIRE_GRACE_MS,
  planSnapshot: PlanSnapshot | null = null,
): { decision: ScheduledRolloutDecision; writes: RecordedWrite[] } {
  const writes: RecordedWrite[] = [];
  const decision = applyScheduledRolloutClaim({
    writer: {
      set: (ref, payload, options) => {
        writes.push({
          op: 'set',
          path: String(ref),
          data: payload as Record<string, unknown>,
          options,
        });
      },
      update: (ref, payload) => {
        writes.push({
          op: 'update',
          path: String(ref),
          data: payload as Record<string, unknown>,
        });
      },
    },
    targets: {
      rolloutRef: 'rollout' as unknown as FirebaseFirestore.DocumentReference,
      pendingCommandRef: (machineId: string) =>
        `pending:${machineId}` as unknown as FirebaseFirestore.DocumentReference,
    },
    ref: REF,
    data,
    nowMs,
    graceMs,
    planSnapshot,
  });
  return { decision, writes };
}

const HOUR = 60 * MINUTE;

/** a free plan, resolved an hour ago, as the plan-daily cron writes it. */
const FREE_SNAPSHOT: PlanSnapshot = {
  enforced: true,
  control: false,
  roost: false,
  resolvedAt: { toMillis: () => NOW - HOUR },
};
const ROOST_BLOCK = "the site owner's plan doesn't include roost";

/** a due rollout the deploy route parked before (or after) the snapshot. */
const scheduledBefore = (overrides: Partial<RolloutDocData> = {}) =>
  scheduledDoc({ startedAt: { toMillis: () => NOW - 2 * HOUR }, ...overrides });
const scheduledAfter = () => scheduledDoc({ startedAt: { toMillis: () => NOW - 30 * MINUTE } });

describe('applyScheduledRolloutClaim', () => {
  it('flips the stage to canary and queues the canary wave in one claim', () => {
    const { decision, writes } = fakeClaim(scheduledDoc());

    assert.deepEqual(decision, { action: 'fire' });
    assert.equal(writes.length, 3); // 1 stage flip + 2 canary machines

    const flip = writes[0]!;
    assert.equal(flip.op, 'update');
    assert.equal(flip.path, 'rollout');
    assert.equal(flip.data.stage, 'canary');
    assert.ok(flip.data.startedAt, 'startedAt is stamped at fire time');
    assert.ok(flip.data.scheduledFiredAt);
  });

  it('queues the same sync_pull payload + deterministic id the fan-out uses', () => {
    const { writes } = fakeClaim(scheduledDoc());
    const queued = writes.filter((w) => w.op === 'set');

    assert.deepEqual(
      queued.map((w) => w.path),
      ['pending:machine-a', 'pending:machine-b'],
    );

    for (const write of queued) {
      assert.deepEqual(write.options, { merge: true });
      const keys = Object.keys(write.data);
      assert.deepEqual(keys, ['roost_sync_rst_lobby_vrs_v7']);
      const cmd = write.data[keys[0]!] as Record<string, unknown>;
      assert.equal(cmd.type, 'sync_pull');
      assert.equal(cmd.site_id, 'site-alpha');
      assert.equal(cmd.roost_id, 'rst_lobby');
      assert.equal(cmd.version_id, 'vrs_v7');
      assert.equal(cmd.version_url, 'https://r2.example/v7.json');
      assert.equal(cmd.extract_root, '~/Documents/Owlette/lobby');
      assert.ok(cmd.queued_at);
    }
  });

  it('falls back to the default extract root when the rollout carries none', () => {
    const { writes } = fakeClaim(scheduledDoc({ extractRoot: '   ' }));
    const cmd = Object.values(writes[1]!.data)[0] as Record<string, unknown>;
    assert.equal(cmd.extract_root, DEFAULT_EXTRACT_ROOT);
  });

  it('reads a firestore Timestamp scheduledAt, not just a number', () => {
    const { decision } = fakeClaim(
      scheduledDoc({ scheduledAt: { toMillis: () => NOW - MINUTE } }),
    );
    assert.deepEqual(decision, { action: 'fire' });
  });

  it('is idempotent: a second claim of a fired rollout writes nothing', () => {
    const first = fakeClaim(scheduledDoc());
    assert.equal(first.decision.action, 'fire');

    // Second sweep re-reads the doc the first claim committed.
    const second = fakeClaim(scheduledDoc({ stage: 'canary' }));
    assert.deepEqual(second.decision, { action: 'skip', reason: 'claimed' });
    assert.deepEqual(second.writes, []);
  });

  it('writes nothing for a rollout that is not due yet', () => {
    const { decision, writes } = fakeClaim(scheduledDoc({ scheduledAt: NOW + MINUTE }));
    assert.deepEqual(decision, { action: 'skip', reason: 'not_due' });
    assert.deepEqual(writes, []);
  });

  it('writes nothing when the rollout doc is gone', () => {
    const { decision, writes } = fakeClaim(null);
    assert.deepEqual(decision, { action: 'skip', reason: 'claimed' });
    assert.deepEqual(writes, []);
  });

  it('a missed window aborts the rollout and queues no commands', () => {
    const { decision, writes } = fakeClaim(
      scheduledDoc({ scheduledAt: NOW - 90 * MINUTE }),
    );

    assert.equal(decision.action, 'write_off');
    assert.equal(writes.length, 1);
    const abort = writes[0]!;
    assert.equal(abort.op, 'update');
    assert.equal(abort.path, 'rollout');
    assert.equal(abort.data.stage, 'aborted');
    assert.ok(abort.data.abortedAt);
    assert.match(String(abort.data.abortReason), /missed its scheduled fire window/);
  });

  it('a rollout scheduled before a withholding snapshot is aborted with the reason, queuing nothing', () => {
    const { decision, writes } = fakeClaim(scheduledBefore(), NOW, MISSED_FIRE_GRACE_MS, FREE_SNAPSHOT);

    assert.deepEqual(decision, { action: 'write_off', reason: ROOST_BLOCK });
    assert.equal(writes.length, 1);
    const abort = writes[0]!;
    assert.equal(abort.op, 'update');
    assert.equal(abort.path, 'rollout');
    assert.equal(abort.data.stage, 'aborted');
    assert.ok(abort.data.abortedAt);
    assert.equal(abort.data.abortReason, ROOST_BLOCK);
  });

  it('a rollout scheduled after the snapshot fires: the web checked it live, later', () => {
    const { decision, writes } = fakeClaim(scheduledAfter(), NOW, MISSED_FIRE_GRACE_MS, FREE_SNAPSHOT);
    assert.deepEqual(decision, { action: 'fire' });
    assert.equal(writes.length, 3);
  });

  it('a rollout with no scheduling time counts as older than the snapshot', () => {
    const { decision } = fakeClaim(scheduledDoc(), NOW, MISSED_FIRE_GRACE_MS, FREE_SNAPSHOT);
    assert.deepEqual(decision, { action: 'write_off', reason: ROOST_BLOCK });
  });

  it('fires without a snapshot', () => {
    const { decision } = fakeClaim(scheduledBefore(), NOW, MISSED_FIRE_GRACE_MS, null);
    assert.deepEqual(decision, { action: 'fire' });
  });

  it('fires when the snapshot has no readable resolvedAt to be newer with', () => {
    const { decision } = fakeClaim(scheduledBefore(), NOW, MISSED_FIRE_GRACE_MS, {
      ...FREE_SNAPSHOT,
      resolvedAt: undefined,
    });
    assert.deepEqual(decision, { action: 'fire' });
  });

  it('withholds on control as well as roost', () => {
    const { decision } = fakeClaim(scheduledBefore(), NOW, MISSED_FIRE_GRACE_MS, {
      ...FREE_SNAPSHOT,
      roost: true,
    });
    assert.deepEqual(decision, {
      action: 'write_off',
      reason: "the site owner's plan doesn't include remote control",
    });
  });

  it('a plan block leaves a rollout that is not due, or already claimed, alone', () => {
    for (const doc of [scheduledBefore({ scheduledAt: NOW + MINUTE }), scheduledBefore({ stage: 'canary' })]) {
      const { decision, writes } = fakeClaim(doc, NOW, MISSED_FIRE_GRACE_MS, FREE_SNAPSHOT);
      assert.equal(decision.action, 'skip');
      assert.deepEqual(writes, []);
    }
  });

  it('a late rollout is written off for lateness even under a plan block', () => {
    const { decision } = fakeClaim(
      scheduledBefore({ scheduledAt: NOW - 90 * MINUTE }),
      NOW,
      MISSED_FIRE_GRACE_MS,
      FREE_SNAPSHOT,
    );
    assert.equal(decision.action, 'write_off');
    assert.match((decision as { reason: string }).reason, /missed its scheduled fire window/);
  });

  it('ignores non-string entries in canary[]', () => {
    const { writes } = fakeClaim(
      scheduledDoc({ canary: ['machine-a', '', 42, null] }),
    );
    assert.deepEqual(
      writes.filter((w) => w.op === 'set').map((w) => w.path),
      ['pending:machine-a'],
    );
  });
});

// -- sweep loop -------------------------------------------------------------

interface FakeStoreOptions {
  due?: ScheduledRolloutRef[];
  enabled?: Record<string, unknown>;
  enabledThrows?: boolean;
  /** each site payer's plan snapshot; absent means none. */
  snapshots?: Record<string, PlanSnapshot>;
  claimThrowsFor?: string[];
}

function fakeStore(options: FakeStoreOptions = {}): {
  store: RolloutScheduleStore;
  claimed: string[];
  enabledReads: string[];
  planReads: string[];
  claimSnapshots: (PlanSnapshot | null)[];
} {
  const claimed: string[] = [];
  const enabledReads: string[] = [];
  const planReads: string[] = [];
  const claimSnapshots: (PlanSnapshot | null)[] = [];
  const store: RolloutScheduleStore = {
    async listDue() {
      return options.due ?? [];
    },
    async readRoostEnabled(siteId) {
      enabledReads.push(siteId);
      if (options.enabledThrows) throw new Error('firestore unavailable');
      return options.enabled?.[siteId];
    },
    async readPlanSnapshot(siteId) {
      planReads.push(siteId);
      return options.snapshots?.[siteId] ?? null;
    },
    async claim(ref, _nowMs, _graceMs, planSnapshot) {
      if (options.claimThrowsFor?.includes(ref.versionId)) {
        throw new Error('transaction aborted');
      }
      claimed.push(ref.versionId);
      claimSnapshots.push(planSnapshot);
      return { action: 'fire' };
    },
  };
  return { store, claimed, enabledReads, planReads, claimSnapshots };
}

describe('sweepDueScheduledRollouts', () => {
  it('claims every due rollout the query returned', async () => {
    const { store, claimed } = fakeStore({
      due: [REF, { ...REF, versionId: 'vrs_v8' }],
    });

    const counts = await sweepDueScheduledRollouts({ store, now: () => NOW });

    assert.deepEqual(claimed, ['vrs_v7', 'vrs_v8']);
    assert.equal(counts.due, 2);
    assert.equal(counts.fired, 2);
    assert.equal(counts.failed, 0);
  });

  it('does nothing at all when nothing is due', async () => {
    const { store, claimed, enabledReads, planReads } = fakeStore();
    const counts = await sweepDueScheduledRollouts({ store, now: () => NOW });
    assert.deepEqual(counts, {
      due: 0,
      fired: 0,
      missed: 0,
      skipped: 0,
      disabled: 0,
      planBlocked: 0,
      failed: 0,
    });
    assert.deepEqual(claimed, []);
    assert.deepEqual(enabledReads, []);
    assert.deepEqual(planReads, []);
  });

  it('leaves a kill-switched site untouched — no claim, no write-off', async () => {
    const { store, claimed, planReads } = fakeStore({
      due: [REF],
      enabled: { 'site-alpha': false },
    });

    const counts = await sweepDueScheduledRollouts({ store, now: () => NOW });

    assert.deepEqual(claimed, []);
    assert.deepEqual(planReads, []);
    assert.equal(counts.disabled, 1);
    assert.equal(counts.fired, 0);
    assert.equal(counts.missed, 0);
  });

  it("hands each site's plan snapshot to the claim, read once per site", async () => {
    const { store, planReads, claimSnapshots } = fakeStore({
      due: [REF, { ...REF, versionId: 'vrs_v8' }, { ...REF, siteId: 'site-beta' }],
      snapshots: { 'site-alpha': FREE_SNAPSHOT },
    });

    await sweepDueScheduledRollouts({ store, now: () => NOW });

    assert.deepEqual(planReads, ['site-alpha', 'site-beta']);
    assert.deepEqual(claimSnapshots, [FREE_SNAPSHOT, FREE_SNAPSHOT, null]);
  });

  it('counts plan write-offs apart from missed windows and fires', async () => {
    const docs: Record<string, RolloutDocData> = {
      vrs_v7: scheduledBefore(),
      vrs_v8: scheduledBefore({ scheduledAt: NOW - 90 * MINUTE }),
      vrs_v9: scheduledAfter(),
    };
    const { store } = fakeStore({
      due: Object.keys(docs).map((versionId) => ({ ...REF, versionId })),
      snapshots: { 'site-alpha': FREE_SNAPSHOT },
    });
    // the real claim, so the sweep counts what it actually decides.
    store.claim = async (ref, nowMs, graceMs, planSnapshot) =>
      fakeClaim(docs[ref.versionId]!, nowMs, graceMs, planSnapshot).decision;

    const counts = await sweepDueScheduledRollouts({ store, now: () => NOW });

    assert.equal(counts.planBlocked, 1);
    assert.equal(counts.missed, 1);
    assert.equal(counts.fired, 1);
  });

  it('reads the kill switch once per site, not once per rollout', async () => {
    const { store, enabledReads } = fakeStore({
      due: [REF, { ...REF, versionId: 'vrs_v8' }, { ...REF, siteId: 'site-beta' }],
    });

    await sweepDueScheduledRollouts({ store, now: () => NOW });

    assert.deepEqual(enabledReads, ['site-alpha', 'site-beta']);
  });

  it('fails open when the kill switch cannot be read', async () => {
    const { store, claimed } = fakeStore({ due: [REF], enabledThrows: true });

    const counts = await sweepDueScheduledRollouts({ store, now: () => NOW });

    assert.deepEqual(claimed, ['vrs_v7']);
    assert.equal(counts.fired, 1);
    assert.equal(counts.disabled, 0);
  });

  it('one failed claim does not abort the sweep', async () => {
    const { store, claimed } = fakeStore({
      due: [REF, { ...REF, versionId: 'vrs_v8' }, { ...REF, versionId: 'vrs_v9' }],
      claimThrowsFor: ['vrs_v8'],
    });

    const counts = await sweepDueScheduledRollouts({ store, now: () => NOW });

    assert.deepEqual(claimed, ['vrs_v7', 'vrs_v9']);
    assert.equal(counts.fired, 2);
    assert.equal(counts.failed, 1);
  });

  it('counts write-offs and skips separately from fires', async () => {
    const outcomes: Record<string, ScheduledRolloutDecision> = {
      vrs_v7: { action: 'fire' },
      vrs_v8: { action: 'write_off', reason: 'missed its scheduled fire window by 90m' },
      vrs_v9: { action: 'skip', reason: 'claimed' },
    };
    const store: RolloutScheduleStore = {
      async listDue() {
        return Object.keys(outcomes).map((versionId) => ({ ...REF, versionId }));
      },
      async readRoostEnabled() {
        return undefined;
      },
      async readPlanSnapshot() {
        return null;
      },
      async claim(ref) {
        return outcomes[ref.versionId]!;
      },
    };

    const counts = await sweepDueScheduledRollouts({ store, now: () => NOW });

    assert.equal(counts.fired, 1);
    assert.equal(counts.missed, 1);
    assert.equal(counts.skipped, 1);
  });

  it('passes the sweep limit and clock through to the query', async () => {
    let seen: { nowMs: number; limit: number } | null = null;
    const store: RolloutScheduleStore = {
      async listDue(nowMs, limit) {
        seen = { nowMs, limit };
        return [];
      },
      async readRoostEnabled() {
        return undefined;
      },
      async readPlanSnapshot() {
        return null;
      },
      async claim() {
        return { action: 'fire' };
      },
    };

    await sweepDueScheduledRollouts({ store, now: () => NOW, limit: 5 });

    assert.deepEqual(seen, { nowMs: NOW, limit: 5 });
  });
});
