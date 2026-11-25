/** Unit tests for the roost webhook dispatcher. */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import {
  canonicalJson,
  classifyResponse,
  deliveryId,
  isRoostEventType,
  nextRetryDelayMs,
  ROOST_EVENT_TYPES,
  selectSubscribers,
  shouldGiveUp,
  signPayload,
  verifySignature,
  type RoostEventType,
  type Subscription,
  type WebhookPayload,
} from '../src/lib/webhookLogic';
import {
  attemptDelivery,
  buildDelivery,
  emit,
  getDefaultHttpClient,
  pumpRetryQueue,
  type AttemptDeps,
  type DeliveryRecord,
  type DeliveryStore,
  type HttpClient,
  type SubscriptionStore,
} from '../src/webhookDispatch';

const NOW = new Date('2026-04-20T00:00:00Z');

function samplePayload(overrides: Partial<WebhookPayload> = {}): WebhookPayload {
  return {
    event: 'distribution.succeeded',
    siteId: 'site-a',
    occurredAt: NOW.toISOString(),
    data: { versionId: 'vrs_abc123', roostId: 'lobby' },
    ...overrides,
  };
}

function sub(overrides: Partial<Subscription> = {}): Subscription {
  return {
    id: 'sub-1',
    siteId: 'site-a',
    // a literal public address, so the send-time check makes no dns lookup
    url: 'https://203.0.113.10/hook',
    secret: 'shhh',
    ...overrides,
  };
}

describe('event taxonomy', () => {
  it('ROOST_EVENT_TYPES has all 7 required events from the task spec', () => {
    const required: RoostEventType[] = [
      'distribution.queued',
      'distribution.started',
      'distribution.succeeded',
      'distribution.failed',
      'chunk.uploaded',
      'version.published',
      'rollback.executed',
    ];
    for (const r of required) assert.ok(ROOST_EVENT_TYPES.includes(r));
    assert.equal(ROOST_EVENT_TYPES.length, required.length);
  });

  it('isRoostEventType narrows correctly', () => {
    assert.equal(isRoostEventType('distribution.succeeded'), true);
    assert.equal(isRoostEventType('unknown.event'), false);
    assert.equal(isRoostEventType(42), false);
    assert.equal(isRoostEventType(null), false);
  });
});

describe('canonicalJson', () => {
  it('recursive key-sort — insertion order does not change output', () => {
    const a = canonicalJson({ b: 1, a: { z: 9, x: 0 } });
    const b = canonicalJson({ a: { x: 0, z: 9 }, b: 1 });
    assert.equal(a, b);
  });

  it('arrays preserve order', () => {
    assert.equal(canonicalJson(['c', 'a', 'b']), '["c","a","b"]');
  });
});

describe('signPayload / verifySignature (stripe-style)', () => {
  const NOW_MS = Date.parse('2026-04-22T15:30:00Z');

  it('round-trips: a signature verifies against its own body + secret', () => {
    const body = canonicalJson(samplePayload());
    const sig = signPayload(body, 'secret', NOW_MS);
    const result = verifySignature(body, 'secret', sig, { nowMs: NOW_MS });
    assert.equal(result.ok, true);
    assert.equal(result.timestamp, Math.floor(NOW_MS / 1000));
  });

  it('wrong secret → bad_signature', () => {
    const body = canonicalJson(samplePayload());
    const sig = signPayload(body, 'secret', NOW_MS);
    const result = verifySignature(body, 'DIFFERENT', sig, { nowMs: NOW_MS });
    assert.equal(result.ok, false);
    assert.equal(result.reason, 'bad_signature');
  });

  it('tampered body → bad_signature', () => {
    const body = canonicalJson(samplePayload());
    const sig = signPayload(body, 'secret', NOW_MS);
    const tampered = body.replace('"site-a"', '"site-attacker"');
    const result = verifySignature(tampered, 'secret', sig, { nowMs: NOW_MS });
    assert.equal(result.ok, false);
    assert.equal(result.reason, 'bad_signature');
  });

  it('matches the t=<unix>,v1=<hex> header shape', () => {
    assert.match(signPayload('x', 'y', NOW_MS), /^t=\d+,v1=[0-9a-f]{64}$/);
  });

  it('missing header → missing_header', () => {
    assert.equal(verifySignature('body', 'secret', undefined).reason, 'missing_header');
    assert.equal(verifySignature('body', 'secret', '').reason, 'missing_header');
  });

  it('missing timestamp component → missing_timestamp', () => {
    assert.equal(
      verifySignature('body', 'secret', 'v1=abc').reason,
      'missing_timestamp',
    );
  });

  it('missing v1 component → missing_v1', () => {
    assert.equal(
      verifySignature('body', 'secret', 't=1700000000').reason,
      'missing_v1',
    );
  });

  it('timestamp outside 5-min tolerance → timestamp_out_of_tolerance', () => {
    const body = canonicalJson(samplePayload());
    const sig = signPayload(body, 'secret', NOW_MS);
    // 6 minutes after signing
    const later = NOW_MS + 6 * 60 * 1000;
    const result = verifySignature(body, 'secret', sig, { nowMs: later });
    assert.equal(result.ok, false);
    assert.equal(result.reason, 'timestamp_out_of_tolerance');
  });

  it('timestamp inside 5-min tolerance → ok', () => {
    const body = canonicalJson(samplePayload());
    const sig = signPayload(body, 'secret', NOW_MS);
    // 4 minutes after signing
    const later = NOW_MS + 4 * 60 * 1000;
    const result = verifySignature(body, 'secret', sig, { nowMs: later });
    assert.equal(result.ok, true);
  });
});

describe('deliveryId', () => {
  it('stable for the same payload + body', () => {
    const p = samplePayload();
    const body = canonicalJson(p);
    assert.equal(deliveryId(p, body), deliveryId(p, body));
  });

  it('differs for different events on the same site', () => {
    const a = samplePayload({ event: 'distribution.succeeded' });
    const b = samplePayload({ event: 'distribution.failed' });
    assert.notEqual(
      deliveryId(a, canonicalJson(a)),
      deliveryId(b, canonicalJson(b)),
    );
  });
});

describe('classifyResponse', () => {
  it('2xx → success', () => {
    assert.equal(classifyResponse(200).kind, 'success');
    assert.equal(classifyResponse(204).kind, 'success');
  });

  it('4xx generally → permanent_failure', () => {
    assert.equal(classifyResponse(400).kind, 'permanent_failure');
    assert.equal(classifyResponse(401).kind, 'permanent_failure');
    assert.equal(classifyResponse(404).kind, 'permanent_failure');
  });

  it('408 / 425 / 429 → retry (transient)', () => {
    assert.equal(classifyResponse(408).kind, 'retry');
    assert.equal(classifyResponse(425).kind, 'retry');
    assert.equal(classifyResponse(429).kind, 'retry');
  });

  it('5xx → retry', () => {
    assert.equal(classifyResponse(500).kind, 'retry');
    assert.equal(classifyResponse(502).kind, 'retry');
    assert.equal(classifyResponse(503).kind, 'retry');
  });

  it('network error (null status) → retry', () => {
    assert.equal(classifyResponse(null).kind, 'retry');
  });
});

describe('backoff', () => {
  const rng = () => 0.5;
  it('attempt 1 → baseMs (default 5 s)', () => {
    assert.equal(nextRetryDelayMs(1, {}, rng), 5_000);
  });
  it('exponential growth factor 3 by default', () => {
    assert.equal(nextRetryDelayMs(2, {}, rng), 15_000);
    assert.equal(nextRetryDelayMs(3, {}, rng), 45_000);
  });
  it('caps at maxMs (1 hour by default)', () => {
    assert.equal(nextRetryDelayMs(20, {}, rng), 60 * 60 * 1000);
  });
  it('shouldGiveUp defaults cap at 10', () => {
    assert.equal(shouldGiveUp(9), false);
    assert.equal(shouldGiveUp(10), true);
    assert.equal(shouldGiveUp(100), true);
  });
});

describe('selectSubscribers', () => {
  it('filters by siteId', () => {
    const subs = [sub({ siteId: 'site-a' }), sub({ id: 'sub-2', siteId: 'site-b' })];
    const sel = selectSubscribers(subs, 'distribution.succeeded', 'site-a');
    assert.equal(sel.length, 1);
    assert.equal(sel[0].siteId, 'site-a');
  });

  it('no events filter → accepts all roost events', () => {
    const subs = [sub({ events: undefined })];
    const sel = selectSubscribers(subs, 'rollback.executed', 'site-a');
    assert.equal(sel.length, 1);
  });

  it('events filter → only matching events delivered', () => {
    const subs = [sub({ events: ['distribution.succeeded'] })];
    assert.equal(
      selectSubscribers(subs, 'distribution.succeeded', 'site-a').length,
      1,
    );
    assert.equal(
      selectSubscribers(subs, 'distribution.failed', 'site-a').length,
      0,
    );
  });

  it('skips disabled subscriptions', () => {
    const subs = [sub({ disabled: true })];
    assert.equal(
      selectSubscribers(subs, 'distribution.succeeded', 'site-a').length,
      0,
    );
  });
});

describe('buildDelivery', () => {
  it('generates stable id + well-formed headers', () => {
    const rec = buildDelivery(samplePayload(), sub(), NOW);
    // Record id is `{contentHash}__{subId}` so two subs for one event can't
    // collide in the delivery store.
    assert.match(rec.id, /^[0-9a-f]{32}__sub-1$/);
    assert.equal(rec.headers['Roost-Event'], 'distribution.succeeded');
    // The public delivery-id header is the content hash alone — receivers
    // dedup on it, so it must be stable across retries and subscribers.
    assert.match(rec.headers['Roost-Delivery'], /^[0-9a-f]{32}$/);
    assert.match(rec.headers['Roost-Signature'], /^t=\d+,v1=[0-9a-f]{64}$/);
    assert.equal(rec.state, 'pending');
    assert.equal(rec.attempt, 0);
    // Secret pinned so retries can re-sign with a fresh `t=`.
    assert.equal(rec.secret, 'shhh');
  });

  it('two subscribers for the same event get distinct record ids (same public delivery id)', () => {
    const p = samplePayload();
    const recA = buildDelivery(p, sub({ id: 'sub-a' }), NOW);
    const recB = buildDelivery(p, sub({ id: 'sub-b' }), NOW);
    assert.notEqual(recA.id, recB.id);
    assert.equal(
      recA.headers['Roost-Delivery'],
      recB.headers['Roost-Delivery'],
    );
  });

  it('signature verifies against the secret used to sign it', () => {
    const s = sub({ secret: 'shared' });
    const rec = buildDelivery(samplePayload(), s, NOW);
    const result = verifySignature(
      rec.canonicalBody,
      'shared',
      rec.headers['Roost-Signature'],
      { nowMs: NOW.getTime() },
    );
    assert.equal(result.ok, true);
  });
});

function makeStore(initial: DeliveryRecord[] = []): DeliveryStore & {
  all(): DeliveryRecord[];
} {
  const records = new Map<string, DeliveryRecord>();
  for (const r of initial) records.set(r.id, r);
  return {
    async list({ dueBefore }) {
      return [...records.values()].filter(
        (r) => r.state === 'pending' && r.nextAttemptAt <= dueBefore,
      );
    },
    async put(r) { records.set(r.id, { ...r }); },
    async get(id) { return records.get(id); },
    all() { return [...records.values()]; },
  };
}

function makeSubs(subs: Subscription[]): SubscriptionStore & { disabled: string[] } {
  const disabled: string[] = [];
  return {
    disabled,
    async listAll() { return subs; },
    async markDisabled(id) { disabled.push(id); },
  };
}

function fixedHttp(statuses: Array<number | null>): HttpClient & { calls: number } {
  let i = 0;
  const out = {
    calls: 0,
    async post(): Promise<{ status: number | null }> {
      out.calls++;
      const s = statuses[Math.min(i, statuses.length - 1)];
      i++;
      return { status: s };
    },
  };
  return out;
}

describe('attemptDelivery', () => {
  it('success on 200 → state=succeeded, completedAt set', async () => {
    const rec = buildDelivery(samplePayload(), sub(), NOW);
    const store = makeStore([rec]);
    const deps: AttemptDeps = {
      http: fixedHttp([200]),
      store,
      subscriptions: makeSubs([]),
      now: () => NOW,
    };
    const result = await attemptDelivery(rec, deps);
    assert.equal(result.outcome.kind, 'success');
    assert.equal(result.record.state, 'succeeded');
    assert.ok(result.record.completedAt);
  });

  it('permanent 4xx → state=failed (no retry)', async () => {
    const rec = buildDelivery(samplePayload(), sub(), NOW);
    const store = makeStore([rec]);
    const deps: AttemptDeps = {
      http: fixedHttp([404]),
      store,
      subscriptions: makeSubs([]),
      now: () => NOW,
    };
    const result = await attemptDelivery(rec, deps);
    assert.equal(result.outcome.kind, 'permanent_failure');
    assert.equal(result.record.state, 'failed');
  });

  it('transient 5xx → state=pending with scheduled retry', async () => {
    const rec = buildDelivery(samplePayload(), sub(), NOW);
    const store = makeStore([rec]);
    const deps: AttemptDeps = {
      http: fixedHttp([503]),
      store,
      subscriptions: makeSubs([]),
      backoff: { baseMs: 1000, factor: 2, jitter: 0 },
      now: () => NOW,
    };
    const result = await attemptDelivery(rec, deps);
    assert.equal(result.outcome.kind, 'retry');
    assert.equal(result.record.state, 'pending');
    assert.equal(result.record.attempt, 1);
    // scheduled ~1 s out (base)
    assert.equal(result.record.nextAttemptAt, NOW.getTime() + 1000);
  });

  it('retry cap reached → state=failed with retry_exhausted reason', async () => {
    const rec: DeliveryRecord = {
      ...buildDelivery(samplePayload(), sub(), NOW),
      attempt: 9, // one below default cap of 10
    };
    const store = makeStore([rec]);
    const deps: AttemptDeps = {
      http: fixedHttp([500]),
      store,
      subscriptions: makeSubs([]),
      backoff: { maxAttempts: 10 },
      now: () => NOW,
    };
    const result = await attemptDelivery(rec, deps);
    assert.equal(result.outcome.kind, 'permanent_failure');
    assert.equal(result.record.state, 'failed');
    assert.match(result.record.lastError ?? '', /retry_exhausted/);
  });

  it('network error (null status) → retry', async () => {
    const rec = buildDelivery(samplePayload(), sub(), NOW);
    const store = makeStore([rec]);
    const deps: AttemptDeps = {
      http: fixedHttp([null]),
      store,
      subscriptions: makeSubs([]),
      backoff: { baseMs: 0, jitter: 0 },
      now: () => NOW,
    };
    const result = await attemptDelivery(rec, deps);
    assert.equal(result.outcome.kind, 'retry');
    assert.equal(result.record.state, 'pending');
  });

  it('a private address at send time → state=failed, nothing posted', async () => {
    // the url was public when the subscription was saved; the record is what is sent
    const rec = buildDelivery(samplePayload(), sub({ url: 'https://10.0.0.5/hook' }), NOW);
    const http = fixedHttp([200]);
    const deps: AttemptDeps = {
      http,
      store: makeStore([rec]),
      subscriptions: makeSubs([]),
      now: () => NOW,
    };
    const result = await attemptDelivery(rec, deps);
    assert.equal(http.calls, 0);
    assert.equal(result.outcome.kind, 'permanent_failure');
    assert.equal(result.record.state, 'failed');
    assert.match(result.record.lastError ?? '', /^url_refused_private_ip$/);
  });
});

describe('the default http client', () => {
  /** a host that redirects to a second, internal one; `hits` counts what reached it. */
  async function startRedirectTrap() {
    let hits = 0;
    const listen = (server: http.Server) =>
      new Promise<number>((resolve) => {
        server.listen(0, '127.0.0.1', () => resolve((server.address() as AddressInfo).port));
      });
    const internal = http.createServer((req, res) => {
      hits += 1;
      req.resume();
      res.end('internal');
    });
    const internalPort = await listen(internal);
    const redirector = http.createServer((req, res) => {
      req.resume();
      res.writeHead(302, { location: `http://127.0.0.1:${internalPort}/` });
      res.end();
    });
    const port = await listen(redirector);
    return {
      url: `http://127.0.0.1:${port}/hook`,
      hits: () => hits,
      close: () =>
        Promise.all(
          [internal, redirector].map(
            (server) =>
              new Promise<void>((resolve) => {
                server.closeAllConnections();
                server.close(() => resolve());
              }),
          ),
        ),
    };
  }

  it('does not follow a redirect', async () => {
    const trap = await startRedirectTrap();
    try {
      const resp = await getDefaultHttpClient().post(trap.url, {}, '{}');
      assert.equal(resp.status, 302);
      assert.equal(trap.hits(), 0);
    } finally {
      await trap.close();
    }
  });
});

describe('emit', () => {
  it('creates one DeliveryRecord per matching subscription', async () => {
    const subs = [
      sub({ id: 's1', siteId: 'site-a' }),
      sub({ id: 's2', siteId: 'site-a' }),
      sub({ id: 's3', siteId: 'site-b' }), // different site, filtered out
    ];
    const store = makeStore();
    const records = await emit(samplePayload(), {
      subscriptions: makeSubs(subs),
      store,
      now: () => NOW,
    });
    assert.equal(records.length, 2);
    const ids = records.map((r) => r.subscriptionId).sort();
    assert.deepEqual(ids, ['s1', 's2']);
    assert.equal(store.all().length, 2);
  });

  it('no matching subscriptions → no records', async () => {
    const store = makeStore();
    const records = await emit(samplePayload({ event: 'chunk.uploaded' }), {
      subscriptions: makeSubs([
        sub({ events: ['distribution.succeeded'] }), // no chunk.uploaded
      ]),
      store,
      now: () => NOW,
    });
    assert.equal(records.length, 0);
    assert.equal(store.all().length, 0);
  });
});

describe('pumpRetryQueue', () => {
  it('attempts due pending deliveries + leaves future ones alone', async () => {
    const due = buildDelivery(samplePayload(), sub(), NOW);
    const futureRec: DeliveryRecord = {
      ...buildDelivery(samplePayload({ event: 'chunk.uploaded' }), sub({ id: 'sub-2' }), NOW),
      nextAttemptAt: NOW.getTime() + 10 * 60 * 1000, // 10 min in the future
    };
    const store = makeStore([due, futureRec]);
    const res = await pumpRetryQueue({
      http: fixedHttp([200, 200]),
      store,
      subscriptions: makeSubs([]),
      now: () => NOW,
    });
    assert.equal(res.attempted, 1);
    assert.equal(res.succeeded, 1);
    const after = store.all();
    assert.equal(after.find((r) => r.id === due.id)?.state, 'succeeded');
    assert.equal(after.find((r) => r.id === futureRec.id)?.state, 'pending');
  });

  it('succeeded and failed records are not re-attempted', async () => {
    const success: DeliveryRecord = { ...buildDelivery(samplePayload(), sub(), NOW), state: 'succeeded' };
    const failed: DeliveryRecord = { ...buildDelivery(samplePayload({ event: 'distribution.failed' }), sub(), NOW), state: 'failed' };
    const http = fixedHttp([500]);
    const store = makeStore([success, failed]);
    const res = await pumpRetryQueue({
      http,
      store,
      subscriptions: makeSubs([]),
      now: () => NOW,
    });
    assert.equal(res.attempted, 0);
    assert.equal(http.calls, 0);
  });
});
