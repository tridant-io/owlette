/**
 * `sites/{siteId}/machines/{machineId}/swoop_sessions/{sid}` — the session
 * record, read and written only here, only through the admin SDK.
 *
 * No `firestore.rules` change accompanies this collection, deliberately
 * (plan.md D12): there is no explicit rule for it and no recursive wildcard
 * reaches it, so the catch-all denies every client, agent and site admin.
 * `__tests__/rules/swoopSessions.test.ts` pins that.
 *
 * The document holds NO key material, NO tokens and NO TURN credentials —
 * `assertNoKeyMaterial` refuses the write rather than trusting the caller, so a
 * later field addition that smuggles a secret in fails a test instead of
 * shipping. Session keys are derived on demand (`keys.server.ts`) and the
 * bundle reaches the agent over its own authenticated channel.
 *
 * This module never writes a command document. That is
 * `lib/actions/requestSwoopSession.server.ts`, and only that.
 *
 * Documents are removed by the retention sweep (`/api/cron/swoop-retention`)
 * and nowhere else. It takes its pages as REFERENCES from here rather than
 * building its own query, so every read and every write of the collection is
 * still shaped in this file.
 */

import { FieldValue } from 'firebase-admin/firestore';
import { getAdminDb } from '@/lib/firebase-admin';

export type SwoopSessionState = 'pending' | 'live' | 'ended';

/**
 * Why a session stopped. `closed`, `killed` and `revoked` are ours; the rest
 * are the streamer's own `exiting.reason` vocabulary (PROTOCOL.md §6) as the
 * host reports it, plus `host_exit` for a stop it named no reason for.
 */
export type SwoopSessionEndReason =
  | 'closed'
  | 'idle'
  | 'killed'
  | 'lease_expired'
  | 'session_cap'
  | 'signal_lost'
  | 'host_exit'
  | 'revoked'
  | 'error';

export interface SwoopSessionViewer {
  viewerId: string;
  uid: string;
  ctl: boolean;
  /** Unix ms. */
  joinedAt: number;
  leaseExpiresAt: number;
}

export interface SwoopSession {
  sid: string;
  siteId: string;
  machineId: string;
  state: SwoopSessionState;
  createdBy: string;
  /** Unix ms. */
  startedAt: number;
  absoluteExpiresAt: number;
  viewers: SwoopSessionViewer[];
  endReason?: SwoopSessionEndReason;
  /**
   * why the viewer's page ended it, in the page's own words (`lib/swoop/backoff.ts`
   * `SwoopEndReason`): a caller may only record `closed`, so this is where
   * "the peer failed" or "the host went away" survives for the audit trail.
   */
  viewerReason?: string;
  endedAt?: number;
  /**
   * sha-256 of the continuity secret a control grant carried
   * (`lib/swoop/continuity.server.ts`); never the secret. Absent on a watch
   * session and on one minted without a satisfied step-up.
   */
  continuityHash?: string;
  /** when a later mint inherited this session's step-up; one-shot. */
  continuityUsedAt?: number;
}

/** Write refusal. Its message names the offending FIELD, never its value. */
export class SwoopSessionStoreError extends Error {
  constructor(public readonly code: string) {
    super(`swoop session store: ${code}`);
    this.name = 'SwoopSessionStoreError';
  }
}

// A field whose NAME suggests a secret. Deliberately broad: the cost of a false
// positive is renaming a field, the cost of a false negative is a credential in
// a collection the whole product can grow a reader for.
const KEY_SHAPED_FIELD = /key|token|secret|credential|password|passphrase|jwt|bearer|auth|cert|seed|nonce/i;

// Three base64url segments — a JWT, whatever the field is called.
const JWT_SHAPED_VALUE = /^[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}$/;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Throws on anything key-shaped, by field name or by value. */
export function assertNoKeyMaterial(data: unknown, path = ''): void {
  if (typeof data === 'string') {
    if (JWT_SHAPED_VALUE.test(data)) {
      throw new SwoopSessionStoreError(`token_shaped_value:${path || '<root>'}`);
    }
    return;
  }
  if (Array.isArray(data)) {
    data.forEach((item, i) => assertNoKeyMaterial(item, `${path}[${i}]`));
    return;
  }
  if (!isPlainObject(data)) return; // numbers, booleans, FieldValue sentinels

  for (const [field, value] of Object.entries(data)) {
    const here = path ? `${path}.${field}` : field;
    if (KEY_SHAPED_FIELD.test(field)) {
      throw new SwoopSessionStoreError(`key_shaped_field:${here}`);
    }
    assertNoKeyMaterial(value, here);
  }
}

function sessionsRef(siteId: string, machineId: string) {
  return getAdminDb()
    .collection('sites')
    .doc(siteId)
    .collection('machines')
    .doc(machineId)
    .collection('swoop_sessions');
}

function sessionRef(siteId: string, machineId: string, sid: string) {
  return sessionsRef(siteId, machineId).doc(sid);
}

/** Every write in this module goes through here — that is the whole guard. */
async function writeSession(
  siteId: string,
  machineId: string,
  sid: string,
  data: Record<string, unknown>,
): Promise<void> {
  assertNoKeyMaterial(data);
  await sessionRef(siteId, machineId, sid).set(
    { ...data, updatedAt: FieldValue.serverTimestamp() },
    { merge: true },
  );
}

function parseViewers(value: unknown): SwoopSessionViewer[] {
  if (!Array.isArray(value)) return [];
  return value.filter(isPlainObject).map((v) => ({
    viewerId: String(v.viewerId ?? ''),
    uid: String(v.uid ?? ''),
    ctl: v.ctl === true,
    joinedAt: typeof v.joinedAt === 'number' ? v.joinedAt : 0,
    leaseExpiresAt: typeof v.leaseExpiresAt === 'number' ? v.leaseExpiresAt : 0,
  }));
}

export async function createSwoopSession(args: {
  siteId: string;
  machineId: string;
  sid: string;
  createdBy: string;
  startedAt: number;
  absoluteExpiresAt: number;
  continuityHash?: string;
}): Promise<void> {
  await writeSession(args.siteId, args.machineId, args.sid, {
    sid: args.sid,
    siteId: args.siteId,
    machineId: args.machineId,
    state: 'pending' satisfies SwoopSessionState,
    createdBy: args.createdBy,
    startedAt: args.startedAt,
    absoluteExpiresAt: args.absoluteExpiresAt,
    viewers: [],
    createdAt: FieldValue.serverTimestamp(),
    ...(args.continuityHash ? { continuityHash: args.continuityHash } : {}),
  });
}

/** The one-shot mark: a session's step-up has been carried to a new one. */
export async function markSwoopContinuityUsed(
  siteId: string,
  machineId: string,
  sid: string,
  nowMs: number,
): Promise<void> {
  await writeSession(siteId, machineId, sid, { continuityUsedAt: nowMs });
}

function parseSession(
  data: Record<string, unknown>,
  siteId: string,
  machineId: string,
  sid: string,
): SwoopSession {
  return {
    sid,
    siteId,
    machineId,
    state: (data.state as SwoopSessionState) ?? 'pending',
    createdBy: String(data.createdBy ?? ''),
    startedAt: typeof data.startedAt === 'number' ? data.startedAt : 0,
    absoluteExpiresAt:
      typeof data.absoluteExpiresAt === 'number' ? data.absoluteExpiresAt : 0,
    viewers: parseViewers(data.viewers),
    ...(data.endReason ? { endReason: data.endReason as SwoopSessionEndReason } : {}),
    ...(typeof data.viewerReason === 'string' ? { viewerReason: data.viewerReason } : {}),
    ...(typeof data.endedAt === 'number' ? { endedAt: data.endedAt } : {}),
    ...(typeof data.continuityHash === 'string' ? { continuityHash: data.continuityHash } : {}),
    ...(typeof data.continuityUsedAt === 'number' ? { continuityUsedAt: data.continuityUsedAt } : {}),
  };
}

export async function getSwoopSession(
  siteId: string,
  machineId: string,
  sid: string,
): Promise<SwoopSession | null> {
  const snap = await sessionRef(siteId, machineId, sid).get();
  if (!snap.exists) return null;
  return parseSession(snap.data() ?? {}, siteId, machineId, sid);
}

/** A session that has not ended yet, whichever of the two live states it is in. */
const UNENDED_STATES: SwoopSessionState[] = ['pending', 'live'];

/**
 * Every unended session in this site that `uid` is in — as a viewer, or as the
 * user who started it. Revocation is the only caller (PROTOCOL.md §10).
 *
 * Collection-group scoped because a site's sessions are scattered one machine
 * at a time and a revocation cannot know which machine; the alternative is a
 * query per machine in the site. `viewers` is an array of objects, so the uid
 * cannot be a filter — it is matched here, over the site's unended sessions
 * only, which is a handful of documents.
 */
export async function listUnendedSwoopSessionsForUser(args: {
  siteId: string;
  uid: string;
}): Promise<SwoopSession[]> {
  const snap = await getAdminDb()
    .collectionGroup('swoop_sessions')
    .where('siteId', '==', args.siteId)
    .where('state', 'in', UNENDED_STATES)
    .get();
  return snap.docs
    .map((doc) => {
      const data = (doc.data() ?? {}) as Record<string, unknown>;
      return parseSession(data, args.siteId, String(data.machineId ?? ''), doc.id);
    })
    .filter(
      (session) =>
        session.machineId !== '' &&
        (session.createdBy === args.uid || session.viewers.some((v) => v.uid === args.uid)),
    );
}

/**
 * Every unended session on ONE machine — what a kill with no sid stops, and so
 * what it has to close. Filtered on `state` alone, which is one field and needs
 * no composite index, and scoped to the machine's own subcollection.
 */
export async function listUnendedSwoopSessionsForMachine(args: {
  siteId: string;
  machineId: string;
}): Promise<SwoopSession[]> {
  const snap = await sessionsRef(args.siteId, args.machineId)
    .where('state', 'in', UNENDED_STATES)
    .get();
  return snap.docs.map((doc) =>
    parseSession(
      (doc.data() ?? {}) as Record<string, unknown>,
      args.siteId,
      args.machineId,
      doc.id,
    ),
  );
}

/**
 * Unended sessions on this machine whose absolute 12-hour cap has already
 * passed — records nobody closed, because the browser went away without its
 * teardown reaching us. The cap is absolute, so one of these cannot still be
 * running, and left alone it answers as live to
 * `listUnendedSwoopSessionsForUser` for as long as the document exists.
 *
 * One page, by `state` alone: the whole point is that unended sessions are a
 * handful, and the sweep that calls this is what keeps them that way.
 */
export async function listExpiredUnendedSwoopSessions(args: {
  siteId: string;
  machineId: string;
  nowMs: number;
  limit: number;
}): Promise<SwoopSession[]> {
  const snap = await sessionsRef(args.siteId, args.machineId)
    .where('state', 'in', UNENDED_STATES)
    .limit(args.limit)
    .get();
  return snap.docs
    .map((doc) =>
      parseSession(
        (doc.data() ?? {}) as Record<string, unknown>,
        args.siteId,
        args.machineId,
        doc.id,
      ),
    )
    .filter((session) => session.absoluteExpiresAt < args.nowMs);
}

/**
 * One page of session documents on this machine that started before `beforeMs`,
 * oldest first — the retention sweep's unit of work.
 *
 * References rather than sessions: the sweep only deletes them, and `startedAt`
 * is the one field every document carries whatever state it is in, so nothing
 * escapes the sweep by never having ended.
 */
export async function listSwoopSessionRefsStartedBefore(args: {
  siteId: string;
  machineId: string;
  beforeMs: number;
  limit: number;
}): Promise<FirebaseFirestore.DocumentReference[]> {
  const snap = await sessionsRef(args.siteId, args.machineId)
    .where('startedAt', '<', args.beforeMs)
    .orderBy('startedAt', 'asc')
    .limit(args.limit)
    .get();
  return snap.docs.map((doc) => doc.ref);
}

/**
 * `pending` -> `live`, which only the streamer can witness: it is reported as a
 * `session_started` host event (`/api/agent/swoop/events`). Ending a session is
 * `endSwoopSession`, so `ended` is not a state this can set.
 */
export async function setSwoopSessionState(
  siteId: string,
  machineId: string,
  sid: string,
  state: Exclude<SwoopSessionState, 'ended'>,
): Promise<void> {
  await writeSession(siteId, machineId, sid, { state });
}

/** Idempotent per viewer: a rejoin replaces the row rather than duplicating it. */
export async function upsertSwoopViewer(args: {
  siteId: string;
  machineId: string;
  sid: string;
  viewer: SwoopSessionViewer;
}): Promise<void> {
  const current = await getSwoopSession(args.siteId, args.machineId, args.sid);
  const others = (current?.viewers ?? []).filter((v) => v.viewerId !== args.viewer.viewerId);
  await writeSession(args.siteId, args.machineId, args.sid, {
    viewers: [...others, args.viewer],
  });
}

/**
 * Drop one viewer, on the host's `viewer_left`. Only the streamer sees a viewer
 * go, so without that event the row outlives the person it names.
 */
export async function removeSwoopViewer(args: {
  siteId: string;
  machineId: string;
  sid: string;
  viewerId: string;
}): Promise<void> {
  const current = await getSwoopSession(args.siteId, args.machineId, args.sid);
  await writeSession(args.siteId, args.machineId, args.sid, {
    viewers: (current?.viewers ?? []).filter((v) => v.viewerId !== args.viewerId),
  });
}

/** Push one viewer's lease out. The 12 h cap is not moved by a renewal. */
export async function renewSwoopViewerLease(args: {
  siteId: string;
  machineId: string;
  sid: string;
  viewerId: string;
  leaseExpiresAt: number;
}): Promise<boolean> {
  const current = await getSwoopSession(args.siteId, args.machineId, args.sid);
  const viewer = current?.viewers.find((v) => v.viewerId === args.viewerId);
  if (!current || !viewer) return false;
  await writeSession(args.siteId, args.machineId, args.sid, {
    viewers: current.viewers.map((v) =>
      v.viewerId === args.viewerId ? { ...v, leaseExpiresAt: args.leaseExpiresAt } : v,
    ),
  });
  return true;
}

/** `endReason` is recorded so the audit trail says WHY a session stopped. */
export async function endSwoopSession(args: {
  siteId: string;
  machineId: string;
  sid: string;
  endReason: SwoopSessionEndReason;
  viewerReason?: string;
  endedAt?: number;
}): Promise<void> {
  await writeSession(args.siteId, args.machineId, args.sid, {
    state: 'ended' satisfies SwoopSessionState,
    endReason: args.endReason,
    ...(args.viewerReason !== undefined ? { viewerReason: args.viewerReason } : {}),
    endedAt: args.endedAt ?? Date.now(),
    viewers: [],
  });
}
