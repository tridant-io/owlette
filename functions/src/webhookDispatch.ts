/**
 * Roost webhook dispatcher cloud function.
 *
 *   emitWebhook        — HTTPS POST `{event, siteId, data}` from roost
 *                        producers; fans out to matching enabled subscriptions.
 *   processRetryQueue  — scheduled every minute; re-attempts due `webhook_deliveries`.
 *
 * Pure decision logic (canonicalisation, signing, backoff, response
 * classification, subscription filtering) lives in lib/webhookLogic.ts.
 */

import { onRequest } from 'firebase-functions/v2/https';
import { onSchedule } from 'firebase-functions/v2/scheduler';
import { getFirestore } from 'firebase-admin/firestore';
import { FieldValue, Timestamp } from 'firebase-admin/firestore';
import { requireInternalSecret } from './lib/requireInternalSecret';
import {
  canonicalJson,
  classifyResponse,
  deliveryId,
  isRoostEventType,
  nextRetryDelayMs,
  selectSubscribers,
  shouldGiveUp,
  signPayload,
  type BackoffOptions,
  type DeliveryOutcome,
  type RoostEventType,
  type Subscription,
  type WebhookPayload,
} from './lib/webhookLogic';
import { validateWebhookUrl } from './lib/webhookUrl';

export interface DeliveryRecord {
  /** Stable id — also the firestore doc id. */
  id: string;
  subscriptionId: string;
  siteId: string;
  url: string;
  /** JSON string to POST. Canonical + signed. */
  canonicalBody: string;
  headers: Record<string, string>;
  event: RoostEventType;
  attempt: number;
  state: 'pending' | 'succeeded' | 'failed';
  lastError?: string;
  lastStatus?: number;
  nextAttemptAt: number; // unix ms
  createdAt: number;
  completedAt?: number;
  /**
   * Signing secret pinned at build time so `attemptDelivery` can re-sign with a
   * fresh `t=` per retry — receivers enforcing the 5-min replay tolerance would
   * otherwise reject any retry past the backoff window. Never leaves the server.
   */
  secret: string;
}

export interface HttpClient {
  post(
    url: string,
    headers: Record<string, string>,
    body: string,
  ): Promise<{ status: number | null }>;
}

export interface DeliveryStore {
  list(filter: { state: 'pending'; dueBefore: number }): Promise<DeliveryRecord[]>;
  put(record: DeliveryRecord): Promise<void>;
  get(id: string): Promise<DeliveryRecord | undefined>;
}

export interface SubscriptionStore {
  /** Return every subscription. Caller filters by site/event. */
  listAll(): Promise<Subscription[]>;
  markDisabled(id: string, reason: string): Promise<void>;
}

/** Build a DeliveryRecord from a payload + subscription. No IO; caller persists. */
export function buildDelivery(
  payload: WebhookPayload,
  subscriber: Subscription,
  now: Date = new Date(),
): DeliveryRecord {
  const canonicalBody = canonicalJson(payload);
  // Roost-Delivery stays the pure content hash so receivers dedup retries; the
  // firestore id appends `__{subId}` because two subscribers on one event would
  // otherwise collide and only one delivery would be tracked. Signature is
  // stripe-style `t=<unix>,v1=<hex>` signed over `now`, not `occurredAt`, so a
  // month-old replay is still rejectable on timestamp grounds.
  const publicDeliveryId = deliveryId(payload, canonicalBody);
  const recordId = `${publicDeliveryId}__${subscriber.id}`;
  const signature = signPayload(canonicalBody, subscriber.secret, now.getTime());

  return {
    id: recordId,
    subscriptionId: subscriber.id,
    siteId: subscriber.siteId,
    url: subscriber.url,
    canonicalBody,
    headers: {
      'Content-Type': 'application/json',
      'Roost-Event': payload.event,
      'Roost-Delivery': publicDeliveryId,
      'Roost-Signature': signature,
    },
    event: payload.event,
    attempt: 0,
    state: 'pending',
    nextAttemptAt: now.getTime(),
    createdAt: now.getTime(),
    secret: subscriber.secret,
  };
}

export interface AttemptDeps {
  http: HttpClient;
  store: DeliveryStore;
  subscriptions: SubscriptionStore;
  backoff?: BackoffOptions;
  /** Auto-disable after this many consecutive permanent failures. */
  autoDisableAfter?: number;
  now?: () => Date;
}

export interface AttemptResult {
  outcome: DeliveryOutcome;
  record: DeliveryRecord;
}

/**
 * Deliver `record` once, updating state + store:
 * success → succeeded; transient → pending with backoff; permanent/give-up →
 * failed (may disable the subscription).
 */
export async function attemptDelivery(
  record: DeliveryRecord,
  deps: AttemptDeps,
): Promise<AttemptResult> {
  const now = deps.now ? deps.now() : new Date();
  const attempt = record.attempt + 1;

  // Re-sign against the current wall-clock so receivers enforcing the 5-min
  // tolerance accept retries past the backoff window. Persisted back onto the
  // record so the UI shows the signature actually transmitted.
  const freshSignature = signPayload(record.canonicalBody, record.secret, now.getTime());
  const headers = { ...record.headers, 'Roost-Signature': freshSignature };

  // checked at send, not only at save: the address behind a saved url can change
  const urlCheck = await validateWebhookUrl(record.url);
  let status: number | null = null;
  if (urlCheck.ok) {
    try {
      const resp = await deps.http.post(urlCheck.url, headers, record.canonicalBody);
      status = resp.status;
    } catch {
      status = null; // network error
    }
  }

  // a lookup that failed is retried like any network error; any other refusal is final
  const outcome: DeliveryOutcome =
    urlCheck.ok || urlCheck.reason === 'dns_resolve_failed'
      ? classifyResponse(status)
      : { kind: 'permanent_failure', reason: `url_refused_${urlCheck.reason}` };

  if (outcome.kind === 'success') {
    const updated: DeliveryRecord = {
      ...record,
      headers,
      attempt,
      state: 'succeeded',
      lastStatus: outcome.status,
      completedAt: now.getTime(),
    };
    await deps.store.put(updated);
    return { outcome, record: updated };
  }

  if (outcome.kind === 'permanent_failure') {
    const updated: DeliveryRecord = {
      ...record,
      headers,
      attempt,
      state: 'failed',
      lastStatus: status ?? undefined,
      lastError: outcome.reason,
      completedAt: now.getTime(),
    };
    await deps.store.put(updated);
    return { outcome, record: updated };
  }

  if (shouldGiveUp(attempt, deps.backoff)) {
    const updated: DeliveryRecord = {
      ...record,
      headers,
      attempt,
      state: 'failed',
      lastStatus: status ?? undefined,
      lastError: `retry_exhausted: ${outcome.reason}`,
      completedAt: now.getTime(),
    };
    await deps.store.put(updated);
    return {
      outcome: { kind: 'permanent_failure', reason: `retry_exhausted_${outcome.reason}` },
      record: updated,
    };
  }

  const delay = nextRetryDelayMs(attempt, deps.backoff);
  const updated: DeliveryRecord = {
    ...record,
    headers,
    attempt,
    state: 'pending',
    lastStatus: status ?? undefined,
    lastError: outcome.reason,
    nextAttemptAt: now.getTime() + delay,
  };
  await deps.store.put(updated);
  return { outcome, record: updated };
}

export interface EmitDeps {
  subscriptions: SubscriptionStore;
  store: DeliveryStore;
  now?: () => Date;
}

/**
 * Filter subscriptions by siteId + event and persist one `pending` record each.
 * The retry pump delivers on its next tick — the caller never blocks on HTTP.
 */
export async function emit(
  payload: WebhookPayload,
  deps: EmitDeps,
): Promise<DeliveryRecord[]> {
  const now = deps.now ? deps.now() : new Date();
  const all = await deps.subscriptions.listAll();
  const selected = selectSubscribers(all, payload.event, payload.siteId);

  const records: DeliveryRecord[] = [];
  for (const sub of selected) {
    const record = buildDelivery(payload, sub, now);
    await deps.store.put(record);
    records.push(record);
  }
  return records;
}

export async function pumpRetryQueue(deps: AttemptDeps): Promise<{
  attempted: number;
  succeeded: number;
  failed: number;
  retried: number;
}> {
  const now = deps.now ? deps.now() : new Date();
  const due = await deps.store.list({ state: 'pending', dueBefore: now.getTime() });

  let succeeded = 0;
  let failed = 0;
  let retried = 0;
  let attempted = 0;

  for (const record of due) {
    attempted++;
    const result = await attemptDelivery(record, deps);
    if (result.outcome.kind === 'success') succeeded++;
    else if (result.outcome.kind === 'permanent_failure') failed++;
    else retried++;
  }

  return { attempted, succeeded, failed, retried };
}

export const emitWebhook = onRequest(
  { timeoutSeconds: 30, memory: '256MiB' },
  async (req, res) => {
    if (req.method !== 'POST') {
      res.status(405).json({ error: 'method_not_allowed' });
      return;
    }
    if (!requireInternalSecret(req, res)) return;
    const body = (req.body ?? {}) as Partial<WebhookPayload> & {
      data?: Record<string, unknown>;
    };
    if (!isRoostEventType(body.event) || !body.siteId || typeof body.siteId !== 'string') {
      res.status(400).json({ error: 'invalid_event_or_siteId' });
      return;
    }
    const data = body.data && typeof body.data === 'object' ? body.data : {};
    const payload: WebhookPayload = {
      event: body.event,
      siteId: body.siteId,
      occurredAt: body.occurredAt ?? new Date().toISOString(),
      data: data as Record<string, unknown>,
    };
    try {
      const records = await emit(payload, {
        subscriptions: getDefaultSubscriptionStore(),
        store: getDefaultDeliveryStore(),
      });
      res.status(202).json({ queued: records.length });
    } catch (err) {
      console.error('[webhookDispatch] emit failed', err);
      res.status(500).json({ error: 'internal' });
    }
  },
);

export const processRetryQueue = onSchedule(
  { schedule: 'every 1 minutes', timeoutSeconds: 180, memory: '256MiB' },
  async () => {
    const res = await pumpRetryQueue({
      http: getDefaultHttpClient(),
      store: getDefaultDeliveryStore(),
      subscriptions: getDefaultSubscriptionStore(),
    });
    console.log(
      `[webhookDispatch] retry pump: attempted=${res.attempted} ` +
        `succeeded=${res.succeeded} failed=${res.failed} retried=${res.retried}`,
    );
  },
);

export function getDefaultHttpClient(): HttpClient {
  return {
    async post(url, headers, body) {
      try {
        const resp = await fetch(url, {
          method: 'POST',
          headers,
          body,
          redirect: 'manual',
          // receivers must respond within 10s
          signal: AbortSignal.timeout(10_000),
        });
        return { status: resp.status };
      } catch {
        return { status: null };
      }
    },
  };
}

function getDefaultDeliveryStore(): DeliveryStore {
  const db = getFirestore();
  const col = db.collection('webhook_deliveries');
  return {
    async list({ dueBefore }) {
      const snap = await col
        .where('state', '==', 'pending')
        .where('nextAttemptAt', '<=', dueBefore)
        .limit(200)
        .get();
      return snap.docs.map((d) => d.data() as DeliveryRecord);
    },
    async put(record) {
      await col.doc(record.id).set({ ...record, updatedAt: FieldValue.serverTimestamp() });
    },
    async get(id) {
      const snap = await col.doc(id).get();
      return snap.exists ? (snap.data() as DeliveryRecord) : undefined;
    },
  };
}

function getDefaultSubscriptionStore(): SubscriptionStore {
  const db = getFirestore();
  // Subscriptions are site-scoped at sites/{siteId}/webhooks/{id} for isolation;
  // listAll uses a collectionGroup query so emit() can filter by siteId without
  // enumerating sites.
  const group = db.collectionGroup('webhooks');
  return {
    async listAll() {
      const snap = await group.get();
      return snap.docs.map((d) => {
        const data = d.data() as Omit<Subscription, 'id'>;
        return { id: d.id, ...data };
      });
    },
    async markDisabled(id, reason) {
      const snap = await group.where('__name__', '==', id).limit(1).get();
      if (snap.empty) return;
      await snap.docs[0].ref.update({
        disabled: true,
        disabledReason: reason,
        disabledAt: Timestamp.now(),
      });
    },
  };
}
