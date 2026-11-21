/**
 * deleteUser action core — thin wrapper around `performUserDeleteCascade`
 * (`web/lib/userDeleteCascade.server.ts`: orphan-sites guard, successor
 * validation, ownership transfer, api-key revocation, command sweep,
 * `users/{uid}.deletedAt`), exposed through the shared action-core shape so the
 * route shim, hoot tools and jobs share one entry point.
 *
 * Capability USER_DELETE (superadmin), wrapper-enforced. Idempotent: an
 * already-deleted user returns `already_deleted` with the original `deletedAt`.
 *
 * The cascade refuses to orphan owned SITES but says nothing about authored
 * talons — every talon re-checks its author before any output fires, so after
 * the author is soft-deleted each one switches off at its next run with nothing
 * fired. Every delete reports `authoredTalonCount`, and `reassignTalons: true`
 * hands them to the successor already being named for site ownership.
 */

import {
  performUserDeleteCascade,
  type UserDeleteOutcome,
} from '@/lib/userDeleteCascade.server';
import { emitMutation } from '@/lib/auditLogClient';
import { getAdminDb } from '@/lib/firebase-admin';
import logger from '@/lib/logger';
import {
  listTalonsAuthoredByAcrossSites,
  reassignTalons,
  TalonStoreError,
  type AuthoredTalonRef,
} from '@/lib/talons/store.server';
import type { Actor } from '@/lib/capabilities';
import type { Firestore } from 'firebase-admin/firestore';

export interface DeleteUserInput {
  uid: string;
  /** Required when the user owns sites; rejected otherwise. */
  successorUid?: string | null;
  /**
   * Hand this user's authored talons to `successorUid`. Opt-in, never implied by
   * `successorUid` alone: a client that has always passed a successor for site
   * ownership must not silently start rewriting authorship too.
   */
  reassignTalons?: boolean;
  /** Inject a Firestore instance — tests pass a mock; production omits. */
  db?: Firestore;
}

export interface DeleteUserContext {
  /** Audit actor string ("user:<uid>" or "apiKey:<keyId>"). */
  auditActor: string;
  /** The authorized caller — carried into the talon store's audit context. */
  actor: Actor;
  endpoint?: string;
  method?: string;
}

/** One site whose talons could not be moved, and why. */
export interface TalonReassignFailure {
  siteId: string;
  detail: string;
}

export type DeleteUserResult =
  | Exclude<UserDeleteOutcome, { kind: 'deleted' }>
  | (Extract<UserDeleteOutcome, { kind: 'deleted' }> & {
      /** Talons this user authored, fleet-wide, at the moment of deletion. */
      authoredTalonCount: number;
      reassignedTalonIds: string[];
      talonReassignFailures: TalonReassignFailure[];
    });

/**
 * Move the deleted user's talons to the successor, one site at a time —
 * eligibility is per-site, and the store is right to refuse a site the successor
 * isn't a member of. A refusal is recorded and the sweep continues: the account
 * is already deleted, so aborting would only rescue fewer talons.
 */
async function reassignAuthoredTalons(
  db: Firestore,
  ctx: DeleteUserContext,
  authored: AuthoredTalonRef[],
  successorUid: string,
): Promise<{ reassignedTalonIds: string[]; failures: TalonReassignFailure[] }> {
  const bySite = new Map<string, string[]>();
  for (const talon of authored) {
    const ids = bySite.get(talon.siteId);
    if (ids) ids.push(talon.talonId);
    else bySite.set(talon.siteId, [talon.talonId]);
  }

  const reassignedTalonIds: string[] = [];
  const failures: TalonReassignFailure[] = [];

  for (const [siteId, talonIds] of bySite) {
    try {
      const result = await reassignTalons(
        db,
        {
          siteId,
          actor: ctx.actor,
          auditActor: ctx.auditActor,
          via: 'ui',
          endpoint: ctx.endpoint ?? '',
          method: ctx.method ?? 'DELETE',
        },
        successorUid,
        { talonIds },
      );
      reassignedTalonIds.push(...result.reassignedTalonIds);
    } catch (err) {
      const detail =
        err instanceof TalonStoreError || err instanceof Error
          ? err.message
          : String(err);
      failures.push({ siteId, detail });
      logger.warn(`deleteUser: talon reassign failed on ${siteId}: ${detail}`, {
        context: 'actions/deleteUser',
        data: { uid: successorUid, siteId },
      });
    }
  }

  return { reassignedTalonIds, failures };
}

export async function deleteUser(
  ctx: DeleteUserContext,
  input: DeleteUserInput,
): Promise<DeleteUserResult> {
  if (!input.uid) throw new Error('uid is required');

  const result = await performUserDeleteCascade(input.uid, {
    successorUid: input.successorUid ?? null,
  });

  if (result.kind !== 'deleted') return result;

  // After the cascade, not before: the refusal paths (`orphan_sites`,
  // `successor_invalid`, `already_deleted`) shouldn't pay for a query they'd
  // discard, and the soft delete doesn't touch `createdBy`.
  const db = input.db ?? getAdminDb();
  const authored = await listTalonsAuthoredByAcrossSites(db, input.uid);

  let reassignedTalonIds: string[] = [];
  let talonReassignFailures: TalonReassignFailure[] = [];
  if (input.reassignTalons && input.successorUid && authored.length > 0) {
    const outcome = await reassignAuthoredTalons(db, ctx, authored, input.successorUid);
    reassignedTalonIds = outcome.reassignedTalonIds;
    talonReassignFailures = outcome.failures;
  }

  emitMutation({
    kind: 'user_mutated',
    siteId: '',
    actor: ctx.auditActor,
    targetId: input.uid,
    attributes: {
      endpoint: ctx.endpoint ?? '',
      method: ctx.method ?? 'DELETE',
      verb: 'soft_deleted',
      successorUid: input.successorUid ?? null,
      transferredSites: result.transferredSites,
      revokedKeyCount: result.revokedKeyIds.length,
      authDisabled: result.authDisabled,
      authoredTalonCount: authored.length,
      reassignedTalonCount: reassignedTalonIds.length,
    },
  });

  return {
    ...result,
    authoredTalonCount: authored.length,
    reassignedTalonIds,
    talonReassignFailures,
  };
}
