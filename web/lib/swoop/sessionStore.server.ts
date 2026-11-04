/**
 * `sites/{siteId}/machines/{machineId}/swoop_sessions/{sid}` — the session
 * record, read and written only here, only through the admin SDK.
 *
 * No `firestore.rules` change accompanies this collection, deliberately
 * (plan.md D12): there is no explicit rule for it and no recursive wildcard
 * reaches it, so the catch-all denies every client, agent and site admin.
 * `__tests__/rules/swoopSessions.test.ts` pins that.
 *
 * One record is one streamer's time on one machine, and every viewer of the
 * machine shares it (PROTOCOL.md §6, §11): a viewer is a row in `viewers` with
 * a lease of its own. A join, a renewal and a departure can land on the same
 * document at once, so every read-then-write of the rows is a transaction.
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
import type { SwoopMachineFailureReason } from '@/lib/swoop/machineFailure';
import {
  SWOOP_LEASE_GRACE_SECONDS,
  SWOOP_LEASE_SECONDS,
  SWOOP_MAX_VIEWERS,
} from '@/lib/swoop/policy.server';

export type SwoopSessionState = 'pending' | 'live' | 'ended';

/**
 * Why a session stopped. `closed`, `killed`, `revoked` and `machine_removed`
 * (the machine was removed from the site, `removeMachine.server.ts`) are ours;
 * the rest are the streamer's own `exiting.reason` vocabulary (PROTOCOL.md §6)
 * as the host reports it, plus `host_exit` for a stop it named no reason for,
 * and the agent's own refusals and exit reasons the page can act on
 * (`machineFailure.ts`).
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
  | 'machine_removed'
  | 'error'
  | SwoopMachineFailureReason;

export interface SwoopSessionViewer {
  viewerId: string;
  uid: string;
  ctl: boolean;
  /** Unix ms. */
  joinedAt: number;
  leaseExpiresAt: number;
  /**
   * when this viewer last renewed its lease; absent until its first renewal,
   * which the page makes once it has reached the streamer.
   */
  renewedAt?: number;
}

/**
 * a control viewer's continuity grant (`lib/swoop/continuity.server.ts`): the
 * sha-256 of its secret, never the secret, and whose it is.
 */
export interface SwoopContinuityGrant {
  uid: string;
  hash: string;
  /** when a later mint inherited it, or its viewer left on purpose; one-shot. */
  usedAt?: number;
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
   * the uid a `revoked` end was for (`revokeViewerSessions.server.ts`): it ends
   * the session for everyone in it, and everyone else comes back on their own.
   */
  endedFor?: string;
  /**
   * each control viewer's continuity grant, by viewer id. A grant outlives its
   * viewer's row, which is what lets the tab's next session inherit it after a
   * drop; a watch viewer has none.
   */
  continuity?: Record<string, SwoopContinuityGrant>;
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

/**
 * Every session write in this module goes through here — that is the whole
 * guard. It shapes the payload; the write is a merge, by `writeSession` or
 * inside a transaction.
 */
function guardedWrite(data: Record<string, unknown>): Record<string, unknown> {
  assertNoKeyMaterial(data);
  return { ...data, updatedAt: FieldValue.serverTimestamp() };
}

async function writeSession(
  siteId: string,
  machineId: string,
  sid: string,
  data: Record<string, unknown>,
): Promise<void> {
  await sessionRef(siteId, machineId, sid).set(guardedWrite(data), { merge: true });
}

/**
 * Read one session and write it back in a single transaction. `decide` sees the
 * session as it stands, or null when there is none, and returns what to write,
 * if anything, and the answer. It may run more than once, so it only computes.
 * A missing record is never written here: the store merges, so a write would
 * create one.
 */
async function inTransaction<T>(
  siteId: string,
  machineId: string,
  sid: string,
  decide: (session: SwoopSession | null) => { data?: Record<string, unknown>; result: T },
): Promise<T> {
  const ref = sessionRef(siteId, machineId, sid);
  return getAdminDb().runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    const session = snap.exists ? parseSession(snap.data() ?? {}, siteId, machineId, sid) : null;
    const { data, result } = decide(session);
    if (session && data) tx.set(ref, guardedWrite(data), { merge: true });
    return result;
  });
}

function parseViewers(value: unknown): SwoopSessionViewer[] {
  if (!Array.isArray(value)) return [];
  return value.filter(isPlainObject).map((v) => ({
    viewerId: String(v.viewerId ?? ''),
    uid: String(v.uid ?? ''),
    ctl: v.ctl === true,
    joinedAt: typeof v.joinedAt === 'number' ? v.joinedAt : 0,
    leaseExpiresAt: typeof v.leaseExpiresAt === 'number' ? v.leaseExpiresAt : 0,
    ...(typeof v.renewedAt === 'number' ? { renewedAt: v.renewedAt } : {}),
  }));
}

function parseGrants(value: unknown): Record<string, SwoopContinuityGrant> {
  const grants: Record<string, SwoopContinuityGrant> = {};
  if (!isPlainObject(value)) return grants;
  for (const [viewerId, grant] of Object.entries(value)) {
    if (!isPlainObject(grant) || typeof grant.uid !== 'string' || typeof grant.hash !== 'string') continue;
    grants[viewerId] = {
      uid: grant.uid,
      hash: grant.hash,
      ...(typeof grant.usedAt === 'number' ? { usedAt: grant.usedAt } : {}),
    };
  }
  return grants;
}

/** a new viewer's grant, as the continuity map takes it. */
function grantFor(viewer: SwoopSessionViewer, continuityHash: string | undefined): Record<string, unknown> {
  return continuityHash ? { continuity: { [viewer.viewerId]: { uid: viewer.uid, hash: continuityHash } } } : {};
}

/** The one-shot mark: a viewer's step-up has been carried to a new one. */
export async function markSwoopContinuityUsed(
  siteId: string,
  machineId: string,
  sid: string,
  viewerId: string,
  nowMs: number,
): Promise<void> {
  // a merge into the map: the other viewers' grants are left as they are.
  await writeSession(siteId, machineId, sid, { continuity: { [viewerId]: { usedAt: nowMs } } });
}

function parseSession(
  data: Record<string, unknown>,
  siteId: string,
  machineId: string,
  sid: string,
): SwoopSession {
  const continuity = parseGrants(data.continuity);
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
    ...(typeof data.endedFor === 'string' ? { endedFor: data.endedFor } : {}),
    ...(Object.keys(continuity).length > 0 ? { continuity } : {}),
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
 * one machine's unended sessions: filtered on `state` alone, which is one field
 * and needs no composite index, and scoped to the machine's own subcollection.
 */
function unendedSessionsOf(siteId: string, machineId: string) {
  return sessionsRef(siteId, machineId).where('state', 'in', UNENDED_STATES);
}

/** a query's documents, as sessions of the one machine it read. */
function machineSessions(
  docs: ReadonlyArray<{ id: string; data: () => unknown }>,
  siteId: string,
  machineId: string,
): SwoopSession[] {
  return docs.map((doc) => parseSession((doc.data() ?? {}) as Record<string, unknown>, siteId, machineId, doc.id));
}

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

/** Every unended session on ONE machine — what a kill with no sid stops, and so what it has to close. */
export async function listUnendedSwoopSessionsForMachine(args: {
  siteId: string;
  machineId: string;
}): Promise<SwoopSession[]> {
  const snap = await unendedSessionsOf(args.siteId, args.machineId).get();
  return machineSessions(snap.docs, args.siteId, args.machineId);
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

/** whether the host can still be serving this viewer: its lease, with the grace, has not run out. */
function viewerPresent(viewer: SwoopSessionViewer, nowMs: number): boolean {
  return viewer.leaseExpiresAt + SWOOP_LEASE_GRACE_SECONDS * 1000 >= nowMs;
}

/** how many people other than `uid` hold a seat among `viewers`; a second tab is not a second person. */
function othersSeated(viewers: readonly SwoopSessionViewer[], uid: string): number {
  return new Set(viewers.map((viewer) => viewer.uid).filter((other) => other !== uid)).size;
}

/**
 * How long a new session counts as starting. The machine spawns its streamer
 * and the first viewer reaches it and renews in seconds; the page itself gives
 * a silent machine 20 s before it asks again.
 */
const SWOOP_STARTING_MS = 60_000;

/**
 * The session on a machine that a new viewer joins, or null to start one.
 *
 * One streamer per machine serves every viewer, and later viewers attach to the
 * live sid (PROTOCOL.md §6, §11): the agent replaces the session it serves with
 * any new sid, so a second sid ends it for everyone already in it.
 * Joining a sid whose streamer is gone is worse, though: the agent ignores a
 * request for a sid it already ran, and the viewer waits on "connecting". The
 * record cannot see the streamer, so it goes by what only a working one leaves:
 * a viewer renewing its lease. The page renews first once it has reached the
 * streamer, and goes on only while its session is up.
 *
 * So a session is joined when it has not ended and someone in it still holds a
 * lease they have renewed — or it is under a minute old, its first viewer still
 * on the way. A row that never renewed proves nothing, so a page left waiting
 * on a dead sid cannot keep it joinable for the next one: the worst a stale
 * record costs is one lease. The newest, when more than one qualifies: the
 * agent runs the session it was asked for last.
 */
export function liveSessionToJoin(
  sessions: readonly SwoopSession[],
  nowMs: number,
): SwoopSession | null {
  let newest: SwoopSession | null = null;
  for (const session of sessions) {
    if (session.state === 'ended') continue;
    const starting = nowMs - session.startedAt < SWOOP_STARTING_MS;
    const held = session.viewers.some(
      (viewer) => viewerPresent(viewer, nowMs) && (starting || viewer.renewedAt !== undefined),
    );
    if (held && (newest === null || session.startedAt > newest.startedAt)) newest = session;
  }
  return newest;
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
  const snap = await unendedSessionsOf(args.siteId, args.machineId).limit(args.limit).get();
  return machineSessions(snap.docs, args.siteId, args.machineId)
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

/**
 * where a viewer came into the machine's session: a seat in the one running,
 * a new one, or none, `SWOOP_MAX_VIEWERS` other people being in it already.
 */
export interface SwoopEntry {
  outcome: 'joined' | 'created' | 'full';
  sid: string;
}

/**
 * Join the session running on the machine, or start one, in one transaction
 * over the machine's unended sessions (`liveSessionToJoin` picks the one to
 * join). Two first viewers at once used to start two, and the agent ended the
 * earlier one's for the later sid; in one transaction the second runs after
 * the first and joins its session.
 *
 * A join seats the viewer beside the viewers still in it, and a seat whose
 * lease ran out past the grace goes with the write: the host has already
 * dropped that viewer. The cap counts people, not seats. A browser tab that
 * closes or reloads sends no DELETE, and no agent forwards the host's
 * `viewer_left`, so its row stays until its lease runs out: counting rows would
 * turn people away from a machine with room, the person who reloaded a few
 * times included. What that costs: one person's several tabs count once here,
 * and the host's own four viewers can still turn the next tab away.
 *
 * `continuityHash` gives a control viewer's grant for whichever session it
 * lands in. The decision may run more than once, so it only computes.
 */
export async function enterSwoopSession(args: {
  siteId: string;
  machineId: string;
  viewer: SwoopSessionViewer;
  /** `user:<uid>`, for a new session. */
  createdBy: string;
  /** the id a new session takes, when there is none to join. */
  newSid: string;
  continuityHash?: (sid: string) => string;
  nowMs: number;
}): Promise<SwoopEntry> {
  const { siteId, machineId, viewer, nowMs } = args;
  const entry = await getAdminDb().runTransaction(async (tx): Promise<SwoopEntry> => {
    const snap = await tx.get(unendedSessionsOf(siteId, machineId));
    const live = liveSessionToJoin(machineSessions(snap.docs, siteId, machineId), nowMs);
    if (live) {
      const seated = live.viewers.filter(
        (other) => other.viewerId !== viewer.viewerId && viewerPresent(other, nowMs),
      );
      if (othersSeated(seated, viewer.uid) >= SWOOP_MAX_VIEWERS) return { outcome: 'full', sid: live.sid };
      tx.set(
        sessionRef(siteId, machineId, live.sid),
        guardedWrite({ viewers: [...seated, viewer], ...grantFor(viewer, args.continuityHash?.(live.sid)) }),
        { merge: true },
      );
      return { outcome: 'joined', sid: live.sid };
    }
    tx.set(
      sessionRef(siteId, machineId, args.newSid),
      guardedWrite({
        sid: args.newSid,
        siteId,
        machineId,
        state: 'pending' satisfies SwoopSessionState,
        createdBy: args.createdBy,
        startedAt: nowMs,
        viewers: [viewer],
        createdAt: FieldValue.serverTimestamp(),
        ...grantFor(viewer, args.continuityHash?.(args.newSid)),
      }),
      { merge: true },
    );
    return { outcome: 'created', sid: args.newSid };
  });
  if (entry.outcome !== 'full') await syncMachineSwoopViewers(siteId, machineId);
  return entry;
}

/**
 * Take viewers out of a session and answer who is still in it: the rows whose
 * lease, with the grace, has not run out. The host's `viewer_left` and a viewer
 * leaving its own seat both come through here; a revocation ends the whole
 * session instead (`revokeViewerSessions.server.ts`). `spendContinuity` is for
 * a departure that was a decision, a leave: as a deliberate close always did,
 * it voids the departing viewers' continuity. `endWhenEmpty` ends the record
 * in the same write when nobody is left, so no join can land between the last
 * one out and the end; a record already ended keeps the reason it ended for.
 * Null when there is no such session.
 */
export async function removeSwoopViewers(args: {
  siteId: string;
  machineId: string;
  sid: string;
  viewerIds: readonly string[];
  spendContinuity?: boolean;
  endWhenEmpty?: { endReason: SwoopSessionEndReason; viewerReason?: string };
  nowMs?: number;
}): Promise<SwoopSessionViewer[] | null> {
  const nowMs = args.nowMs ?? Date.now();
  const leaving = new Set(args.viewerIds);
  const stillIn = await inTransaction(args.siteId, args.machineId, args.sid, (session) => {
    if (!session) return { result: null };
    const viewers = session.viewers.filter(
      (viewer) => !leaving.has(viewer.viewerId) && viewerPresent(viewer, nowMs),
    );
    const spent = args.spendContinuity
      ? [...leaving].filter((viewerId) => session.continuity?.[viewerId] !== undefined)
      : [];
    const end = viewers.length === 0 && session.state !== 'ended' ? args.endWhenEmpty : undefined;
    if (!end && viewers.length === session.viewers.length && spent.length === 0) return { result: viewers };
    return {
      data: {
        viewers,
        ...(spent.length > 0
          ? { continuity: Object.fromEntries(spent.map((viewerId) => [viewerId, { usedAt: nowMs }])) }
          : {}),
        ...(end
          ? {
              state: 'ended' satisfies SwoopSessionState,
              endReason: end.endReason,
              ...(end.viewerReason !== undefined ? { viewerReason: end.viewerReason } : {}),
              endedAt: nowMs,
            }
          : {}),
      },
      result: viewers,
    };
  });
  if (stillIn !== null) await syncMachineSwoopViewers(args.siteId, args.machineId);
  return stillIn;
}

/** Push one viewer's lease out, and drop the seats that lapsed past the grace on the way. */
export async function renewSwoopViewerLease(args: {
  siteId: string;
  machineId: string;
  sid: string;
  viewerId: string;
  leaseExpiresAt: number;
  nowMs?: number;
}): Promise<boolean> {
  const nowMs = args.nowMs ?? Date.now();
  return inTransaction(args.siteId, args.machineId, args.sid, (session) => {
    if (!session?.viewers.some((viewer) => viewer.viewerId === args.viewerId)) return { result: false };
    return {
      data: {
        viewers: session.viewers
          .map((viewer) =>
            viewer.viewerId === args.viewerId
              ? { ...viewer, leaseExpiresAt: args.leaseExpiresAt, renewedAt: nowMs }
              : viewer,
          )
          .filter((viewer) => viewer.viewerId === args.viewerId || viewerPresent(viewer, nowMs)),
      },
      result: true,
    };
  });
}

/** `endReason` is recorded so the audit trail says WHY a session stopped. */
export async function endSwoopSession(args: {
  siteId: string;
  machineId: string;
  sid: string;
  endReason: SwoopSessionEndReason;
  viewerReason?: string;
  endedAt?: number;
  endedFor?: string;
}): Promise<void> {
  await writeSession(args.siteId, args.machineId, args.sid, {
    state: 'ended' satisfies SwoopSessionState,
    endReason: args.endReason,
    ...(args.viewerReason !== undefined ? { viewerReason: args.viewerReason } : {}),
    ...(args.endedFor !== undefined ? { endedFor: args.endedFor } : {}),
    endedAt: args.endedAt ?? Date.now(),
    viewers: [],
  });
  await syncMachineSwoopViewers(args.siteId, args.machineId);
}
