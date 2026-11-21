/**
 * `machine_moves/{sourceSiteId}:{machineId}`: the server-only record of a machine
 * moving to another site. the request route writes it `pending` with a
 * `site_move` command in the source machine's `commands/pending` map; the agent's
 * credential fetch turns it `switching`; its confirm from the target deletes it.
 * not a field on the machine doc, which the agent can write. firestore.rules'
 * deny-all catch-all covers the collection.
 *
 * a pending move lapses after `MOVE_PENDING_TTL_MS`. a switching move never
 * does: the agent already holds the target's credentials, and removing the
 * machine is the way out.
 */

import {
  FieldValue,
  type DocumentReference,
  type Firestore,
  type QueryDocumentSnapshot,
} from 'firebase-admin/firestore';
import { deleteRefsInBatches } from '@/lib/fleet/session.server';
import logger from '@/lib/logger';

export const MOVE_PENDING_TTL_MS = 7 * 24 * 60 * 60 * 1000;

const MACHINE_MOVES_COLLECTION = 'machine_moves';

// what the agent is in the middle of, and a move would cut short
const BUSY_COMMAND_TYPES: ReadonlySet<unknown> = new Set([
  'install_software',
  'uninstall_software',
  'update_owlette',
  'sync_pull',
]);

export type MoveStatus = 'pending' | 'switching';

/** times are epoch milliseconds: write `Date.now()` values, never a server timestamp. */
export interface MachineMove {
  /** the doc id, `{sourceSiteId}:{machineId}`. */
  moveId: string;
  sourceSiteId: string;
  targetSiteId: string;
  machineId: string;
  status: MoveStatus;
  /** uid of the person who asked for the move. */
  requestedBy: string;
  requestedAt: number;
  expiresAt: number;
  /** hash of the target refresh token the credential fetch minted, so a retry can replace it. */
  mintedTokenHash?: string;
}

export function moveRef(db: Firestore, sourceSiteId: string, machineId: string): DocumentReference {
  return db.collection(MACHINE_MOVES_COLLECTION).doc(`${sourceSiteId}:${machineId}`);
}

/** whether a move has lapsed: a pending one at or past `expiresAt`; a switching one never. */
export function moveExpired(move: Pick<MachineMove, 'status' | 'expiresAt'>, now = Date.now()): boolean {
  return move.status === 'pending' && move.expiresAt <= now;
}

function parseMove(moveId: string, data: Record<string, unknown> | undefined): MachineMove | null {
  if (!data) return null;
  const { sourceSiteId, targetSiteId, machineId, status, requestedBy, requestedAt, expiresAt, mintedTokenHash } =
    data;
  if (
    typeof sourceSiteId !== 'string' ||
    typeof targetSiteId !== 'string' ||
    typeof machineId !== 'string' ||
    (status !== 'pending' && status !== 'switching') ||
    typeof requestedBy !== 'string' ||
    typeof requestedAt !== 'number' ||
    typeof expiresAt !== 'number'
  ) {
    return null;
  }
  return {
    moveId,
    sourceSiteId,
    targetSiteId,
    machineId,
    status,
    requestedBy,
    requestedAt,
    expiresAt,
    ...(typeof mintedTokenHash === 'string' ? { mintedTokenHash } : {}),
  };
}

function pendingCommandsRef(db: Firestore, siteId: string, machineId: string): DocumentReference {
  return db.collection('sites').doc(siteId).collection('machines').doc(machineId).collection('commands').doc('pending');
}

/** one field of a map entry or list item read from firestore, which may hold anything. */
function fieldOf(value: unknown, key: string): unknown {
  return value && typeof value === 'object' ? (value as Record<string, unknown>)[key] : undefined;
}

/** the `commands/pending` map's deletes for every `site_move` entry that queues `moveId`, or null for none. */
function siteMoveDeletes(pending: Record<string, unknown> | undefined, moveId: string): Record<string, FieldValue> | null {
  const ids = Object.entries(pending ?? {})
    .filter(([, command]) => fieldOf(command, 'type') === 'site_move' && fieldOf(command, 'moveId') === moveId)
    .map(([id]) => id);
  return ids.length > 0 ? Object.fromEntries(ids.map((id) => [id, FieldValue.delete()])) : null;
}

/**
 * delete the machine's move and its `site_move` command when `drop` says so,
 * re-read in a transaction: the credential fetch may have turned it
 * `switching` since it was read, and a switching move deleted here would leave
 * the agent's confirm nothing to find. answers the move as it stood, or null
 * for none, and whether it went.
 */
async function dropMove(
  db: Firestore,
  sourceSiteId: string,
  machineId: string,
  drop: (move: MachineMove) => boolean,
): Promise<{ move: MachineMove | null; dropped: boolean }> {
  const ref = moveRef(db, sourceSiteId, machineId);
  const pendingRef = pendingCommandsRef(db, sourceSiteId, machineId);
  return db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    const move = snap.exists ? parseMove(snap.id, snap.data()) : null;
    if (!move || !drop(move)) return { move, dropped: false };
    const deletes = siteMoveDeletes((await tx.get(pendingRef)).data(), move.moveId);
    tx.delete(ref);
    if (deletes) tx.update(pendingRef, deletes);
    return { move, dropped: true };
  });
}

/** the machine's move, or null; a lapsed pending move reads as gone and is deleted here. */
export async function readMove(db: Firestore, sourceSiteId: string, machineId: string): Promise<MachineMove | null> {
  const snap = await moveRef(db, sourceSiteId, machineId).get();
  const move = snap.exists ? parseMove(snap.id, snap.data()) : null;
  if (!move || !moveExpired(move)) return move;
  try {
    const { move: current, dropped } = await dropMove(db, sourceSiteId, machineId, (stored) => moveExpired(stored));
    return dropped ? null : current;
  } catch (err) {
    logger.warn('machineMoves: lapsed move not deleted (non-fatal)', {
      context: 'machineMoves',
      data: { sourceSiteId, machineId, err: err instanceof Error ? err.message : String(err) },
    });
    return null;
  }
}

export type MoveCancel =
  | { outcome: 'cancelled' | 'switching'; move: MachineMove }
  | { outcome: 'missing' };

/**
 * cancel the machine's move while it is pending, lapsed or not, with its
 * `site_move` command. a switching move is answered and kept: the agent
 * already holds the target's credentials, and removing the machine ends it.
 */
export async function cancelMove(db: Firestore, sourceSiteId: string, machineId: string): Promise<MoveCancel> {
  const { move, dropped } = await dropMove(db, sourceSiteId, machineId, (stored) => stored.status === 'pending');
  if (!move) return { outcome: 'missing' };
  return { outcome: dropped ? 'cancelled' : 'switching', move };
}

/**
 * drop the machine's move to `targetSiteId` while it is pending, with its
 * `site_move` command: that site turned it away for good. answers the move
 * dropped, or null: a switching move stays for the agent's confirm, and a move
 * asked for since to another site is not the one refused.
 */
export async function dropRefusedMove(
  db: Firestore,
  sourceSiteId: string,
  machineId: string,
  targetSiteId: string,
): Promise<MachineMove | null> {
  const { move, dropped } = await dropMove(
    db,
    sourceSiteId,
    machineId,
    (stored) => stored.status === 'pending' && stored.targetSiteId === targetSiteId,
  );
  return dropped ? move : null;
}

/**
 * the move with this id as stored, lapsed or not: the agent's credential fetch
 * answers a lapsed move differently from a missing one (see `moveExpired`).
 */
export async function readMoveById(db: Firestore, moveId: string): Promise<MachineMove | null> {
  if (!moveId || moveId.includes('/')) return null;
  const snap = await db.collection(MACHINE_MOVES_COLLECTION).doc(moveId).get();
  return snap.exists ? parseMove(snap.id, snap.data()) : null;
}

/**
 * why the machine cannot move now, or null: busy while its `commands/pending`
 * map holds an install, uninstall, update or roost sync (the agent deletes an
 * entry only once it is done), or a deployment naming it is in flight.
 * deployments are asked for by status alone, as the deployment sweeper asks:
 * targets is a list of `{ machineId, status }`, so the machine is matched here.
 */
export async function moveRefusal(
  db: Firestore,
  { sourceSiteId, machineId }: { sourceSiteId: string; machineId: string },
): Promise<'machine_busy' | null> {
  const [pending, deployments] = await Promise.all([
    pendingCommandsRef(db, sourceSiteId, machineId).get(),
    db
      .collection('sites')
      .doc(sourceSiteId)
      .collection('deployments')
      .where('status', 'in', ['pending', 'in_progress'])
      .get(),
  ]);
  const queued = Object.values(pending.data() ?? {}).some((command) => BUSY_COMMAND_TYPES.has(fieldOf(command, 'type')));
  if (queued) return 'machine_busy';
  const deploying = deployments.docs.some((doc) => {
    const targets: unknown = doc.data().targets;
    return Array.isArray(targets) && targets.some((target) => fieldOf(target, 'machineId') === machineId);
  });
  return deploying ? 'machine_busy' : null;
}

/** every move into or out of the site, each once. */
async function movesForSite(db: Firestore, siteId: string): Promise<QueryDocumentSnapshot[]> {
  const snaps = await Promise.all([
    db.collection(MACHINE_MOVES_COLLECTION).where('sourceSiteId', '==', siteId).get(),
    db.collection(MACHINE_MOVES_COLLECTION).where('targetSiteId', '==', siteId).get(),
  ]);
  return [...new Map(snaps.flatMap((snap) => snap.docs.map((doc) => [doc.ref.path, doc] as const))).values()];
}

/**
 * a move into or out of the site that its agent is carrying out, or null. the
 * agent holds only the target's tokens by then, so deleting either site would
 * strand the machine.
 */
export async function switchingMoveForSite(db: Firestore, siteId: string): Promise<MachineMove | null> {
  for (const doc of await movesForSite(db, siteId)) {
    const move = parseMove(doc.id, doc.data());
    if (move?.status === 'switching') return move;
  }
  return null;
}

/**
 * delete every move into or out of the site, whatever its status, and the
 * `site_move` command each queued on its source machine. a move left behind
 * would point the agent at a site that is gone, so a failed delete throws; a
 * command left behind finds no move and changes nothing, so its cleanup is
 * best effort. answers how many moves went.
 */
export async function cancelMovesForSite(db: Firestore, siteId: string): Promise<number> {
  const found = await movesForSite(db, siteId);
  await deleteRefsInBatches(db, found.map((doc) => doc.ref));

  await Promise.all(
    found.map(async (doc) => {
      const { sourceSiteId, machineId } = doc.data();
      if (typeof sourceSiteId !== 'string' || typeof machineId !== 'string') return;
      try {
        const pendingRef = pendingCommandsRef(db, sourceSiteId, machineId);
        const deletes = siteMoveDeletes((await pendingRef.get()).data(), doc.id);
        if (deletes) await pendingRef.update(deletes);
      } catch (err) {
        logger.warn('machineMoves: site_move command not cleared (non-fatal)', {
          context: 'machineMoves',
          data: { siteId, sourceSiteId, machineId, err: err instanceof Error ? err.message : String(err) },
        });
      }
    }),
  );
  return found.length;
}
