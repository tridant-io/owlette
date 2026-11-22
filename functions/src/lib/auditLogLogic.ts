/**
 * Pure logic for the roost audit log sink (wave 2b.7).
 *
 * Append-only, hash-chained, tamper-evident: every record embeds
 * `hash(previousHash || canonicalPayload)` so a verifier can walk a site's chain
 * and prove nothing was modified or deleted. The first record uses GENESIS_HASH.
 *
 * No firestore here — this builds records the drainer persists, and keeps the
 * verifier importable by any consumer with no firebase deps.
 */

import { createHash } from 'crypto';

/**
 * Event types the audit log records. A new kind must extend this union AND the
 * shape validator — they live together on purpose.
 */
export const AUDIT_EVENT_KINDS = [
  'signed_url_issued',
  'distribution_started',
  'version_pointer_changed',
  'api_key_used',
  'gc_run',
  'api_key_mutated',
  'chunk_mutated',
  'deployment_mutated',
  'distribution_mutated',
  'process_mutated',
  'roost_mutated',
  'machine_command_dispatched',
  'user_mutated',
  'site_mutated',
  'site_member_mutated',
  'installer_mutated',
  'webhook_mutated',
  'chat_mutated',
  'billing_mutated',
  'talon_mutated',
] as const;

export type AuditEventKind = (typeof AUDIT_EVENT_KINDS)[number];

/**
 * Pseudo-site holding audit events that are not scoped to a real site.
 *
 * This value becomes a Firestore DOCUMENT ID (`sites/{siteId}/audit_log`), so
 * it must be a legal one. It used to be `__platform__`, and Firestore reserves
 * every id matching `__*__` — so every platform-scoped audit write failed with
 *
 *   INVALID_ARGUMENT: Resource id "__platform__" is invalid because it is reserved
 *
 * and the event was lost. The handler is fire-and-forget, so nothing surfaced;
 * platform-level admin actions simply had no audit trail.
 *
 * A single leading underscore is legal for Firestore AND rejected by the site-id
 * validator (`/^[a-z][a-z0-9_-]*$/` requires a leading letter), so no real site
 * can ever collide with it.
 *
 * NOT the same as web's `PLATFORM_TARGET_ID`, which is still `__platform__`:
 * that one is a stored FIELD value (`target.id`), and fields carry no id
 * restrictions. Do not "align" them.
 */
export const PLATFORM_AUDIT_SITE_ID = '_platform';

export interface AuditEvent {
  kind: AuditEventKind;
  siteId: string;
  /** Initiator: uid, `apiKey:<hash>`, or `service:<name>` for automated actors. */
  actor: string;
  /** unix ms when the audited operation happened, NOT when recorded. */
  occurredAt: number;
  /** Optional mutated resource id, sent by the web mutation audit client. */
  target?: string;
  /** Kind-specific; anything JSON-serialisable, nesting included. */
  attributes: Record<string, unknown>;
}

/**
 * Shape-check a raw incoming event. Strict — missing or invalid fields are
 * rejected so the chain never ingests garbage.
 */
export function canonicaliseEvent(
  raw: Partial<AuditEvent> | undefined,
): { ok: true; event: AuditEvent } | { ok: false; reason: string } {
  if (!raw || typeof raw !== 'object') {
    return { ok: false, reason: 'event_not_object' };
  }
  if (!isAuditEventKind(raw.kind)) {
    return { ok: false, reason: 'invalid_kind' };
  }
  if (typeof raw.siteId !== 'string') {
    return { ok: false, reason: 'siteId_required' };
  }
  if (!raw.actor || typeof raw.actor !== 'string') {
    return { ok: false, reason: 'actor_required' };
  }
  if (
    typeof raw.occurredAt !== 'number' ||
    !isFinite(raw.occurredAt) ||
    raw.occurredAt <= 0
  ) {
    return { ok: false, reason: 'occurredAt_required' };
  }
  const attributes = raw.attributes ?? {};
  if (typeof attributes !== 'object' || attributes === null || Array.isArray(attributes)) {
    return { ok: false, reason: 'attributes_must_be_object' };
  }
  if (raw.target !== undefined && typeof raw.target !== 'string') {
    return { ok: false, reason: 'target_must_be_string' };
  }

  return {
    ok: true,
    event: {
      kind: raw.kind,
      siteId: raw.siteId || PLATFORM_AUDIT_SITE_ID,
      actor: raw.actor,
      occurredAt: raw.occurredAt,
      ...(raw.target !== undefined ? { target: raw.target } : {}),
      attributes,
    },
  };
}

function isAuditEventKind(x: unknown): x is AuditEventKind {
  return AUDIT_EVENT_KINDS.includes(x as AuditEventKind);
}

/**
 * Canonical JSON, keys sorted recursively. The chain hashes this string and
 * JSON.stringify alone is not stable across property-insertion order.
 */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortForCanonical(value));
}

function sortForCanonical(v: unknown): unknown {
  if (v === null || typeof v !== 'object') return v;
  if (Array.isArray(v)) return v.map(sortForCanonical);
  const sorted: Record<string, unknown> = {};
  const keys = Object.keys(v as Record<string, unknown>).sort();
  for (const k of keys) {
    sorted[k] = sortForCanonical((v as Record<string, unknown>)[k]);
  }
  return sorted;
}

/**
 * First-record sentinel. 64 zeros matches SHA-256-hex width so chain verifiers
 * don't special-case the first record.
 */
export const GENESIS_HASH = '0'.repeat(64);

/**
 * Hashes `previousHash | recordedAt | canonicalPayload`; the separator is a
 * character canonical JSON never emits, so the input is unambiguous.
 */
export function computeChainHash(
  previousHash: string,
  recordedAt: number,
  canonicalPayload: string,
): string {
  const input = `${previousHash}|${recordedAt}|${canonicalPayload}`;
  return createHash('sha256').update(input).digest('hex');
}

export interface AuditRecord {
  event: AuditEvent;
  /** unix ms when the sink wrote the record (NOT event.occurredAt). */
  recordedAt: number;
  previousHash: string;
  /** SHA-256 hex of `previousHash | recordedAt | canonicalJson(event)`. */
  hash: string;
}

/** Produce the next record in the chain. */
export function buildAuditRecord(
  event: AuditEvent,
  previousHash: string,
  recordedAt: number,
): AuditRecord {
  const payload = canonicalJson(event);
  const hash = computeChainHash(previousHash, recordedAt, payload);
  return { event, recordedAt, previousHash, hash };
}

export interface AuditHead {
  /** the next record's `previousHash`: the latest record hash, or GENESIS_HASH. */
  hash: string;
  /** the latest record's recordedAt, or 0 at genesis. */
  recordedAt: number;
}

export interface QueuedEvent {
  id: string;
  event: unknown;
}

export interface ChainedBatch {
  /** how many queued events, from the front, became a record or a rejection. */
  taken: number;
  records: AuditRecord[];
  rejected: { id: string; reason: string }[];
  head: AuditHead;
}

/** keeps a batch's writes well under firestore's 10 MiB transaction limit. */
export const BATCH_EVENT_BYTES = 4 * 1024 * 1024;

/**
 * chain queued events onto `head` in queue order. recordedAt is the drain time,
 * kept strictly after the record it links to: readChain orders by it, and the
 * activity scan reads change rows forward from a cursor on it.
 */
export function chainQueued(
  siteId: string,
  head: AuditHead,
  queued: readonly QueuedEvent[],
  nowMs: number,
): ChainedBatch {
  const batch: ChainedBatch = { taken: 0, records: [], rejected: [], head };
  let bytes = 0;
  for (const q of queued) {
    bytes += Buffer.byteLength(JSON.stringify(q.event) ?? '');
    if (batch.taken > 0 && bytes > BATCH_EVENT_BYTES) break;
    batch.taken++;
    const validated = canonicaliseEvent(q.event as Partial<AuditEvent>);
    if (!validated.ok || validated.event.siteId !== siteId) {
      batch.rejected.push({ id: q.id, reason: validated.ok ? 'siteId_mismatch' : validated.reason });
      continue;
    }
    const record = buildAuditRecord(
      validated.event,
      batch.head.hash,
      Math.max(nowMs, batch.head.recordedAt + 1),
    );
    batch.records.push(record);
    batch.head = { hash: record.hash, recordedAt: record.recordedAt };
  }
  return batch;
}

/**
 * Walk the chain: every record's hash matches its derivation and its
 * previousHash matches the prior record's hash (records[0] against GENESIS_HASH
 * when `assertGenesis`). Returns `{ ok: true }` or the first failing index.
 */
export function verifyChain(
  records: readonly AuditRecord[],
  opts: { assertGenesis?: boolean } = {},
): { ok: true } | { ok: false; brokenAt: number; reason: string } {
  for (let i = 0; i < records.length; i++) {
    const r = records[i];
    const expectedPrev = i === 0
      ? (opts.assertGenesis ? GENESIS_HASH : r.previousHash)
      : records[i - 1].hash;
    if (r.previousHash !== expectedPrev) {
      return { ok: false, brokenAt: i, reason: 'previousHash_mismatch' };
    }
    const expectedHash = computeChainHash(
      r.previousHash,
      r.recordedAt,
      canonicalJson(r.event),
    );
    if (r.hash !== expectedHash) {
      return { ok: false, brokenAt: i, reason: 'hash_mismatch' };
    }
  }
  return { ok: true };
}

/** SOX + HIPAA both want ≥7 years; leap years don't matter at this coarseness. */
export const AUDIT_RETENTION_DAYS = 7 * 365;
