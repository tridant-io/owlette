/**
 * Unit tests for the append-only audit log sink (roost wave 2b.7).
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  AUDIT_EVENT_KINDS,
  AUDIT_RETENTION_DAYS,
  buildAuditRecord,
  canonicaliseEvent,
  canonicalJson,
  computeChainHash,
  GENESIS_HASH,
  PLATFORM_AUDIT_SITE_ID,
  verifyChain,
  type AuditEvent,
  type AuditRecord,
} from '../src/lib/auditLogLogic';
import type { ScheduledEvent } from 'firebase-functions/v2/scheduler';
import {
  appendAudit,
  exportAllSites,
  exportAuditDaily,
  verifySiteChain,
  type AppendDeps,
  type AuditExporter,
  type AuditStore,
  type ExportDeps,
} from '../src/auditLog';

const NOW = new Date('2026-04-20T12:00:00Z');

function sampleEvent(overrides: Partial<AuditEvent> = {}): AuditEvent {
  return {
    kind: 'signed_url_issued',
    siteId: 'site-a',
    actor: 'apiKey:owk_abc123',
    occurredAt: NOW.getTime() - 1000,
    attributes: { hash: 'a'.repeat(64), expiresIn: 3600 },
    ...overrides,
  };
}

// canonicaliseEvent

describe('canonicaliseEvent', () => {
  it('accepts a well-formed event', () => {
    const r = canonicaliseEvent(sampleEvent());
    assert.equal(r.ok, true);
  });

  it('rejects unknown kind', () => {
    const r = canonicaliseEvent({ ...sampleEvent(), kind: 'other' as never });
    assert.equal(r.ok, false);
    assert.equal(r.ok ? null : r.reason, 'invalid_kind');
  });

  it('rejects missing siteId', () => {
    const r = canonicaliseEvent({ ...sampleEvent(), siteId: undefined });
    assert.equal(r.ok, false);
  });

  it('rejects missing actor', () => {
    const r = canonicaliseEvent({ ...sampleEvent(), actor: '' });
    assert.equal(r.ok, false);
  });

  it('rejects non-positive occurredAt', () => {
    const r = canonicaliseEvent({ ...sampleEvent(), occurredAt: 0 });
    assert.equal(r.ok, false);
  });

  it('rejects array attributes', () => {
    const r = canonicaliseEvent({
      ...sampleEvent(),
      attributes: [] as unknown as Record<string, unknown>,
    });
    assert.equal(r.ok, false);
  });

  it('defaults missing attributes to empty object', () => {
    const r = canonicaliseEvent({ ...sampleEvent(), attributes: undefined });
    assert.equal(r.ok, true);
    if (r.ok) assert.deepEqual(r.event.attributes, {});
  });

  it('accepts every public mutation audit kind', () => {
    for (const kind of AUDIT_EVENT_KINDS) {
      const r = canonicaliseEvent(sampleEvent({ kind }));
      assert.equal(r.ok, true, `expected ${kind} to be accepted`);
    }
  });

  it('normalizes empty platform siteId to the platform audit tenant', () => {
    const r = canonicaliseEvent(sampleEvent({
      kind: 'api_key_mutated',
      siteId: '',
      target: 'key-1',
    }));
    assert.equal(r.ok, true);
    if (r.ok) assert.equal(r.event.siteId, PLATFORM_AUDIT_SITE_ID);
  });

  it('preserves mutation target outside attributes', () => {
    const r = canonicaliseEvent(sampleEvent({
      kind: 'webhook_mutated',
      target: 'wh_12345678',
    }));
    assert.equal(r.ok, true);
    if (r.ok) assert.equal(r.event.target, 'wh_12345678');
  });

  it('preserves empty string target when explicitly supplied', () => {
    const r = canonicaliseEvent(sampleEvent({
      kind: 'api_key_mutated',
      target: '',
    }));
    assert.equal(r.ok, true);
    if (r.ok) assert.equal(r.event.target, '');
  });

  it('rejects non-string target', () => {
    const r = canonicaliseEvent({
      ...sampleEvent(),
      target: 123 as unknown as string,
    });
    assert.equal(r.ok, false);
    assert.equal(r.ok ? null : r.reason, 'target_must_be_string');
  });
});

// canonicalJson

describe('canonicalJson', () => {
  it('sorts keys recursively so insertion order does not matter', () => {
    const a = canonicalJson({ b: 1, a: { z: 9, x: 0 } });
    const b = canonicalJson({ a: { x: 0, z: 9 }, b: 1 });
    assert.equal(a, b);
  });

  it('preserves arrays in order', () => {
    // arrays are ordered data — don't sort them.
    const s = canonicalJson(['c', 'a', 'b']);
    assert.equal(s, '["c","a","b"]');
  });

  it('handles nulls and primitives', () => {
    assert.equal(canonicalJson(null), 'null');
    assert.equal(canonicalJson(42), '42');
    assert.equal(canonicalJson('x'), '"x"');
  });
});

// computeChainHash / buildAuditRecord / verifyChain

describe('chain', () => {
  it('GENESIS_HASH is 64 zero chars', () => {
    assert.equal(GENESIS_HASH, '0'.repeat(64));
    assert.equal(GENESIS_HASH.length, 64);
  });

  it('computeChainHash is deterministic + 64-hex', () => {
    const a = computeChainHash(GENESIS_HASH, 1, '{"x":1}');
    const b = computeChainHash(GENESIS_HASH, 1, '{"x":1}');
    assert.equal(a, b);
    assert.match(a, /^[0-9a-f]{64}$/);
  });

  it('different recordedAt → different hash', () => {
    const a = computeChainHash(GENESIS_HASH, 1, '{"x":1}');
    const b = computeChainHash(GENESIS_HASH, 2, '{"x":1}');
    assert.notEqual(a, b);
  });

  it('different previousHash → different hash', () => {
    const a = computeChainHash(GENESIS_HASH, 1, '{"x":1}');
    const b = computeChainHash('f'.repeat(64), 1, '{"x":1}');
    assert.notEqual(a, b);
  });

  it('buildAuditRecord chains to genesis when previousHash is GENESIS_HASH', () => {
    const r = buildAuditRecord(sampleEvent(), GENESIS_HASH, NOW.getTime());
    assert.equal(r.previousHash, GENESIS_HASH);
    assert.match(r.hash, /^[0-9a-f]{64}$/);
  });

  it('verifyChain accepts a well-formed chain', () => {
    const r0 = buildAuditRecord(sampleEvent(), GENESIS_HASH, 1);
    const r1 = buildAuditRecord(
      sampleEvent({ occurredAt: 2 }),
      r0.hash,
      2,
    );
    const r2 = buildAuditRecord(
      sampleEvent({ occurredAt: 3 }),
      r1.hash,
      3,
    );
    const v = verifyChain([r0, r1, r2], { assertGenesis: true });
    assert.equal(v.ok, true);
  });

  it('verifyChain catches a tampered event payload', () => {
    const r0 = buildAuditRecord(sampleEvent(), GENESIS_HASH, 1);
    const r1 = buildAuditRecord(
      sampleEvent({ occurredAt: 2 }),
      r0.hash,
      2,
    );
    // tamper: rewrite the event attributes without re-hashing.
    const tampered: AuditRecord = {
      ...r1,
      event: { ...r1.event, attributes: { hash: 'DIFFERENT' } },
    };
    const v = verifyChain([r0, tampered], { assertGenesis: true });
    assert.equal(v.ok, false);
    assert.equal(v.ok ? null : v.brokenAt, 1);
    assert.equal(v.ok ? null : v.reason, 'hash_mismatch');
  });

  it('verifyChain catches a broken link (previousHash mismatch)', () => {
    const r0 = buildAuditRecord(sampleEvent(), GENESIS_HASH, 1);
    // build r1 with a FAKE previousHash (not r0.hash)
    const r1 = buildAuditRecord(
      sampleEvent({ occurredAt: 2 }),
      'f'.repeat(64),
      2,
    );
    const v = verifyChain([r0, r1], { assertGenesis: true });
    assert.equal(v.ok, false);
    assert.equal(v.ok ? null : v.brokenAt, 1);
    assert.equal(v.ok ? null : v.reason, 'previousHash_mismatch');
  });

  it('verifyChain catches a deletion (r1 removed)', () => {
    // A deleted middle record leaves r2's previousHash not matching r0's hash.
    const r0 = buildAuditRecord(sampleEvent(), GENESIS_HASH, 1);
    const r1 = buildAuditRecord(
      sampleEvent({ occurredAt: 2 }),
      r0.hash,
      2,
    );
    const r2 = buildAuditRecord(
      sampleEvent({ occurredAt: 3 }),
      r1.hash,
      3,
    );
    // simulate r1 being secretly deleted
    const withoutR1 = [r0, r2];
    const v = verifyChain(withoutR1, { assertGenesis: true });
    assert.equal(v.ok, false);
    assert.equal(v.ok ? null : v.brokenAt, 1);
  });

  it('verifyChain enforces genesis when asked', () => {
    // chain starts with a non-genesis previousHash → rejected
    const r0 = buildAuditRecord(
      sampleEvent(),
      'e'.repeat(64),
      1,
    );
    const v = verifyChain([r0], { assertGenesis: true });
    assert.equal(v.ok, false);
    assert.equal(v.ok ? null : v.reason, 'previousHash_mismatch');
  });

  it('AUDIT_RETENTION_DAYS is at least 7 years', () => {
    assert.ok(AUDIT_RETENTION_DAYS >= 7 * 365);
  });
});

// appendAudit (orchestrator)

function makeStore(initial: AuditRecord[] = []): AuditStore & {
  all: AuditRecord[];
} {
  const all = [...initial];
  return {
    all,
    async getLatestHash() {
      return all.length === 0 ? GENESIS_HASH : all[all.length - 1].hash;
    },
    async append(record) {
      if (
        record.previousHash !==
        (all.length === 0 ? GENESIS_HASH : all[all.length - 1].hash)
      ) {
        throw new Error('head_changed_during_append');
      }
      all.push(record);
    },
    async readChain() { return all; },
  };
}

function depsWith(store: AuditStore, now = NOW): AppendDeps {
  return { store, now: () => now };
}

describe('appendAudit', () => {
  it('appends a valid event + returns the persisted record', async () => {
    const store = makeStore();
    const r = await appendAudit(sampleEvent(), depsWith(store));
    assert.equal(r.ok, true);
    assert.equal(store.all.length, 1);
    assert.equal(store.all[0].previousHash, GENESIS_HASH);
  });

  it('chains the second append to the first', async () => {
    const store = makeStore();
    const a = await appendAudit(sampleEvent(), depsWith(store));
    const b = await appendAudit(
      sampleEvent({ occurredAt: NOW.getTime() - 500 }),
      depsWith(store),
    );
    assert.ok(a.ok && b.ok);
    if (a.ok && b.ok) {
      assert.equal(b.record.previousHash, a.record.hash);
    }
  });

  it('rejects malformed events without calling the store', async () => {
    const store = makeStore();
    const r = await appendAudit(
      { kind: 'bogus' } as unknown as AuditEvent,
      depsWith(store),
    );
    assert.equal(r.ok, false);
    assert.equal(store.all.length, 0);
  });

  it('surfaces store append failure as 409-style reason', async () => {
    const store = makeStore();
    // monkey-patch append to throw the head-changed error
    store.append = async () => {
      throw new Error('head_changed_during_append');
    };
    const r = await appendAudit(sampleEvent(), depsWith(store));
    assert.equal(r.ok, false);
    assert.match(r.ok ? '' : r.reason, /append_failed/);
  });

  it('chain of 5 verifies end-to-end', async () => {
    const store = makeStore();
    for (let i = 0; i < 5; i++) {
      await appendAudit(
        sampleEvent({ occurredAt: NOW.getTime() + i }),
        depsWith(store),
      );
    }
    const v = await verifySiteChain('site-a', store);
    assert.equal(v.ok, true);
    assert.equal(v.records, 5);
  });

  it('tampering with a middle record is caught by verifySiteChain', async () => {
    const store = makeStore();
    for (let i = 0; i < 3; i++) {
      await appendAudit(
        sampleEvent({ occurredAt: NOW.getTime() + i }),
        depsWith(store),
      );
    }
    // rewrite the middle record's attributes post-facto
    store.all[1] = {
      ...store.all[1],
      event: { ...store.all[1].event, attributes: { leaked: true } },
    };
    const v = await verifySiteChain('site-a', store);
    assert.equal(v.ok, false);
    assert.equal(v.brokenAt, 1);
  });
});

// exportAllSites

describe('exportAllSites', () => {
  it('exports every record via batched calls', async () => {
    const store = makeStore();
    for (let i = 0; i < 7; i++) {
      await appendAudit(
        sampleEvent({ occurredAt: NOW.getTime() + i }),
        depsWith(store),
      );
    }
    const batches: number[] = [];
    const exporter: AuditExporter = {
      async exportBatch(batch) { batches.push(batch.length); },
    };
    const deps: ExportDeps = {
      store,
      exporter,
      directory: { async listSiteIds() { return ['site-a']; } },
      batchSize: 3,
    };
    const res = await exportAllSites(deps);
    assert.deepEqual(res, [{ siteId: 'site-a', exported: 7 }]);
    assert.deepEqual(batches, [3, 3, 1]);
  });

  it('logs + continues when one site fails', async () => {
    const store: AuditStore = {
      async getLatestHash() { return GENESIS_HASH; },
      async append() {},
      async readChain(siteId) {
        if (siteId === 'bad') throw new Error('boom');
        return [];
      },
    };
    const exporter: AuditExporter = { async exportBatch() {} };
    const res = await exportAllSites({
      store,
      exporter,
      directory: {
        async listSiteIds() { return ['bad', 'ok']; },
      },
    });
    // only 'ok' makes it into the results; 'bad' logs + is skipped
    assert.equal(res.length, 1);
    assert.equal(res[0].siteId, 'ok');
  });
});

describe('exportAuditDaily', () => {
  it('reads no audit record while no sink is wired', async () => {
    // no firebase app is initialised in this process, so any firestore read throws
    await assert.doesNotReject(
      async () => exportAuditDaily.run({ scheduleTime: NOW.toISOString() } as ScheduledEvent),
      'the nightly export read firestore with nowhere to export to',
    );
  });
});

describe('PLATFORM_AUDIT_SITE_ID is a usable Firestore document id', () => {
  // Firestore rejects any resource id matching __*__. The sentinel becomes a
  // document id (`sites/{siteId}/audit_log`), so a reserved value means every
  // platform-scoped audit write throws INVALID_ARGUMENT and the event is lost —
  // silently, because recordAuditEvent is fire-and-forget. That is exactly what
  // shipped as `__platform__`.
  const FIRESTORE_RESERVED_ID = /^__.*__$/;

  it('is not a reserved Firestore id', () => {
    assert.equal(FIRESTORE_RESERVED_ID.test(PLATFORM_AUDIT_SITE_ID), false);
  });

  it('rejects the value that caused the outage (negative control)', () => {
    // Proves the assertion above can actually fail: without this, a regression
    // back to `__platform__` would have to be caught by the check itself.
    assert.equal(FIRESTORE_RESERVED_ID.test('__platform__'), true);
  });

  it('cannot collide with a real site id', () => {
    // web/lib/validators.ts validateSiteId — a real site must start with a
    // lowercase letter, so a leading underscore is unreachable by any user.
    const SITE_ID_FORMAT = /^[a-z][a-z0-9_-]*$/;
    assert.equal(SITE_ID_FORMAT.test(PLATFORM_AUDIT_SITE_ID), false);
  });

  it('contains no path separator', () => {
    assert.equal(PLATFORM_AUDIT_SITE_ID.includes('/'), false);
  });
});
