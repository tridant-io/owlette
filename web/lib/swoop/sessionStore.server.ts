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
 * `lib/actions/requestSwoopSession.server.ts`, and only that. Its one write
 * outside the collection is the machine record's `swoopViewers`, a count
 * recomputed from these documents (`syncMachineSwoopViewers`) so the dashboard
 * can show it without a rule that reaches them.
 *
 * Documents are removed by the retention sweep (`/api/cron/swoop-retention`)
 * and nowhere else. It takes its pages as REFERENCES from here rather than
 * building its own query, so every read and every write of the collection is
 * still shaped in this file.
 */

import { FieldValue } from 'firebase-admin/firestore';
import { getAdminDb } from '@/lib/firebase-admin';
import logger from '@/lib/logger';
import { SWOOP_LEASE_GRACE_SECONDS, SWOOP_LEASE_SECONDS } from '@/lib/swoop/policy.server';

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

function machineRef(siteId: string, machineId: string) {
  return getAdminDb().collection('sites').doc(siteId).collection('machines').doc(machineId);
}

function sessionsRef(siteId: string, machineId: string) {
  return machineRef(siteId, machineId).collection('swoop_sessions');
}

function sessionRef(siteId: string, machineId: string, sid: string) {
  return sessionsRef(siteId, machineId).doc(sid);
}

/** Every session write in this module goes through here — that is the whole guard. */
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
  continuityHash?: string;
}): Promise<void> {
  await writeSession(args.siteId, args.machineId, args.sid, {
    sid: args.sid,
    siteId: args.siteId,
    machineId: args.machineId,
    state: 'pending' satisfies SwoopSessionState,
    createdBy: args.createdBy,
    startedAt: args.startedAt,
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
 * every unended session in this site, on whichever machine. collection-group
 * scoped because a site's sessions are scattered one machine at a time; the
 * alternative is a query per machine in the site. a document that names no
 * machine cannot be acted on, so it is left out.
 */
async function listUnendedSwoopSessionsInSite(siteId: string): Promise<SwoopSession[]> {
  const snap = await getAdminDb()
    .collectionGroup('swoop_sessions')
    .where('siteId', '==', siteId)
    .where('state', 'in', UNENDED_STATES)
    .get();
  return snap.docs
    .map((doc) => {
      const data = (doc.data() ?? {}) as Record<string, unknown>;
      return parseSession(data, siteId, String(data.machineId ?? ''), doc.id);
    })
    .filter((session) => session.machineId !== '');
}

/**
 * Every unended session in this site that `uid` is in — as a viewer, or as the
 * user who started it. Revocation is the only caller (PROTOCOL.md §10).
 *
 * Site-wide because a revocation cannot know which machine. `viewers` is an
 * array of objects, so the uid cannot be a filter — it is matched here, over the
 * site's unended sessions only, which is a handful of documents.
 */
export async function listUnendedSwoopSessionsForUser(args: {
  siteId: string;
  uid: string;
}): Promise<SwoopSession[]> {
  const sessions = await listUnendedSwoopSessionsInSite(args.siteId);
  return sessions.filter(
    (session) =>
      session.createdBy === args.uid || session.viewers.some((v) => v.uid === args.uid),
  );
}

/**
 * the site's sessions someone can still be in, pending and live — the admin
 * swoop page's list (`/api/sites/{siteId}/swoop/sessions`). a session whose
 * lease has lapsed is left out: nobody closed the record, but the host has
 * already dropped every viewer of it, so there is nothing to show or to kill.
 */
export async function listLiveSwoopSessionsForSite(args: {
  siteId: string;
  nowMs?: number;
}): Promise<SwoopSession[]> {
  const nowMs = args.nowMs ?? Date.now();
  const sessions = await listUnendedSwoopSessionsInSite(args.siteId);
  return sessions.filter((session) => !leaseLapsed(session, nowMs));
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
 * whether nobody can still be streaming this session: its latest viewer lease,
 * or one lease from `startedAt` when it holds no viewer row, is past the grace
 * the host gives a lapsed lease before it drops the viewer (PROTOCOL.md §10).
 */
function leaseLapsed(session: SwoopSession, nowMs: number): boolean {
  const lastLease =
    session.viewers.length > 0
      ? Math.max(...session.viewers.map((viewer) => viewer.leaseExpiresAt))
      : session.startedAt + SWOOP_LEASE_SECONDS * 1000;
  return lastLease + SWOOP_LEASE_GRACE_SECONDS * 1000 < nowMs;
}

/**
 * unended sessions on this machine whose lease has lapsed — records nobody
 * closed, because the browser went away without its teardown reaching us. the
 * host has dropped every viewer of one of these, so it cannot still be running,
 * and left alone it answers as live to `listUnendedSwoopSessionsForUser` for as
 * long as the document exists. a session whose tab keeps renewing is never one
 * of them, however long ago it started.
 *
 * One page, by `state` alone: the whole point is that unended sessions are a
 * handful, and the sweep that calls this is what keeps them that way.
 */
export async function listLapsedUnendedSwoopSessions(args: {
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
    .filter((session) => leaseLapsed(session, args.nowMs));
}

/**
 * One page of session documents on this machine that started before `beforeMs`,
 * oldest first — the retention sweep's unit of work.
 *
 * References rather than sessions: the sweep only deletes them, and `startedAt`
 * is the one field every document carries whatever state it is in, so nothing
 * escapes the sweep by never having ended. `refs` leaves out a session whose
 * lease is still live — somebody's open tab, however long ago it started — and
 * `scanned` is the page as the query served it, so the sweep can tell a drained
 * machine from a page it kept.
 */
export async function listSwoopSessionRefsStartedBefore(args: {
  siteId: string;
  machineId: string;
  beforeMs: number;
  nowMs: number;
  limit: number;
}): Promise<{ refs: FirebaseFirestore.DocumentReference[]; scanned: number }> {
  const snap = await sessionsRef(args.siteId, args.machineId)
    .where('startedAt', '<', args.beforeMs)
    .orderBy('startedAt', 'asc')
    .limit(args.limit)
    .get();
  const refs = snap.docs
    .filter((doc) =>
      leaseLapsed(
        parseSession((doc.data() ?? {}) as Record<string, unknown>, args.siteId, args.machineId, doc.id),
        args.nowMs,
      ),
    )
    .map((doc) => doc.ref);
  return { refs, scanned: snap.docs.length };
}

/**
 * mirror the machine's viewer count onto its record as `swoopViewers`: the
 * viewers of its live sessions whose lease has not lapsed. the dashboard reads
 * the machine, never a session, so this is how the count reaches it. every
 * mutator that changes who is watching calls it after its own write.
 *
 * a full recount every time, never an increment, so a write lost to a race is
 * healed by the next one. `update`, not `set`: a machine that is gone must not
 * come back as a ghost document. and it never throws — the session write it
 * follows has landed, and a badge is not worth failing that request over.
 */
export async function syncMachineSwoopViewers(
  siteId: string,
  machineId: string,
  nowMs = Date.now(),
): Promise<void> {
  try {
    const sessions = await listUnendedSwoopSessionsForMachine({ siteId, machineId });
    const swoopViewers = sessions
      .filter((session) => session.state === 'live' && !leaseLapsed(session, nowMs))
      .reduce((sum, session) => sum + session.viewers.length, 0);
    await machineRef(siteId, machineId).update({ swoopViewers });
  } catch (err) {
    logger.warn('[swoop/store] machine viewer count could not be mirrored', {
      context: 'swoop/store',
      data: { siteId, machineId, err: err instanceof Error ? err.message : String(err) },
    });
  }
}

/**
 * `pending` -> `live`, which only the streamer can witness: it is reported as a
 * `session_started` host event (`/api/agent/swoop/events`). Ending a session is
 * `endSwoopSession`, so `ended` is not a state this can set. a session's
 * viewers count on the machine from here: the mint adds its viewer while the
 * session is still pending.
 */
export async function setSwoopSessionState(
  siteId: string,
  machineId: string,
  sid: string,
  state: Exclude<SwoopSessionState, 'ended'>,
): Promise<void> {
  await writeSession(siteId, machineId, sid, { state });
  await syncMachineSwoopViewers(siteId, machineId);
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
  await syncMachineSwoopViewers(args.siteId, args.machineId);
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
  await syncMachineSwoopViewers(args.siteId, args.machineId);
}

/** Push one viewer's lease out. */
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
  await syncMachineSwoopViewers(args.siteId, args.machineId);
}
