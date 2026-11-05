/**
 * Server-side cascade for `DELETE /api/users/me` (security-boundary-migration wave 3.10
 * + CRIT-A6). Replaces the old client-side writeBatch in AuthContext.deleteAccount.
 *
 * Site handling: sole-owner sites are hard-deleted with their machines/deployments/logs;
 * member-only sites are left intact; owned-but-shared sites refuse with `needs_successor`
 * — ownership must be transferred first (mirrors the admin cascade's `orphan_sites` guard).
 *
 * Also drained so a self-deleted user leaves no residue: users/{uid}/{passkeys,
 * trustedDevices,verified_networks,api_keys}, top-level api_keys lookups, mfa_pending/{uid},
 * agent_refresh_tokens by createdBy, chats by userId, and Storage users/{uid}/*.
 * The Firebase Auth user is revoked + deleted server-side afterwards; the client's own
 * post-response deleteUser() raced that and should be dropped.
 *
 * Capability USER_SELF_DELETE; the route shim enforces self-only deletion.
 * Everything chunks at BATCH_SIZE (100), under Firestore's 500-write batch ceiling.
 * Idempotent via users/{userId}/account_deletion/operation: a repeat call replays a
 * completed outcome, or resumes a partial run (already-deleted docs simply don't show up
 * in the next scan), so the cascade is eventually consistent.
 * `dryRun` runs the same scans + classification and reports counts without mutating.
 */

import { FieldValue, type Firestore } from 'firebase-admin/firestore';
import type { Auth } from 'firebase-admin/auth';
import type { Storage } from 'firebase-admin/storage';
import { getAdminAuth, getAdminDb, getAdminStorage } from '@/lib/firebase-admin';
import logger from '@/lib/logger';

/** Hard cap per Firestore batch — well under the 500-write limit. */
export const BATCH_SIZE = 100;

/** Subcollections under each owned site that the cascade drains. */
const SITE_SUBCOLLECTIONS = ['machines', 'deployments', 'logs'] as const;

type SiteSubcollection = (typeof SITE_SUBCOLLECTIONS)[number];

export interface DeleteOwnAccountInput {
  /** The user deleting themselves. The route shim asserts this matches the session uid. */
  userId: string;
  /** When true, runs the scans and reports counts but performs no deletes. */
  dryRun?: boolean;
  /** Stable join key for the progress doc + audit row. */
  operationId: string;
  /** Test seam — production omits. */
  db?: Firestore;
  /** Test seam — production omits. */
  auth?: Auth | null;
  /** Test seam — production omits. */
  storage?: Storage | null;
  /** Test seam for `Date.now()`. */
  now?: () => number;
}

/** Per-site classification used by both the dry-run preview and the live cascade. */
export type SiteClassification =
  | { siteId: string; kind: 'sole_owner' }
  | { siteId: string; kind: 'member'; ownerUid: string | null }
  | { siteId: string; kind: 'missing' };

export type DeleteOwnAccountResult =
  | {
      kind: 'needs_successor';
      userId: string;
      operationId: string;
      ownedSharedSites: string[];
    }
  | {
      kind: 'ok';
      userId: string;
      operationId: string;
      /** Whether this invocation actually performed deletes (false in dry-run + replay). */
      performed: boolean;
      /** True when an earlier completed run was replayed (no work this call). */
      alreadyCompleted: boolean;
      dryRun: boolean;
      /** Sites the cascade visited (sourced from users/{userId}.sites[]). */
      sites: string[];
      /** Per-site classification — sole_owner / member / missing. */
      siteClassification: SiteClassification[];
      /** Per-path doc-delete counts. Same shape for live runs and dry-runs. */
      deletedCounts: {
        machines: number;
        deployments: number;
        logs: number;
        sites: number;
        users: number;
        memberSitesRemoved: number;
        passkeys: number;
        trustedDevices: number;
        verifiedNetworks: number;
        apiKeys: number;
        apiKeyLookups: number;
        mfaPending: number;
        agentRefreshTokens: number;
        chats: number;
        chatMessages: number;
        storageObjects: number;
      };
      /** Whether the Firebase Auth user record was revoked + deleted (live runs only). */
      authRevoked: boolean;
      /** Firestore paths that were (or would be) deleted, ordered as deleted. */
      deletedPaths: string[];
    };

interface SiteScanCounts {
  machines: number;
  deployments: number;
  logs: number;
}

interface CascadeContext {
  db: Firestore;
  auth: Auth | null;
  storage: Storage | null;
  now: () => number;
  dryRun: boolean;
  deletedPaths: string[];
  userId: string;
}

function emptyCounts(): SiteScanCounts {
  return { machines: 0, deployments: 0, logs: 0 };
}

function emptyDeletedCounts() {
  return {
    machines: 0,
    deployments: 0,
    logs: 0,
    sites: 0,
    users: 0,
    memberSitesRemoved: 0,
    passkeys: 0,
    trustedDevices: 0,
    verifiedNetworks: 0,
    apiKeys: 0,
    apiKeyLookups: 0,
    mfaPending: 0,
    agentRefreshTokens: 0,
    chats: 0,
    chatMessages: 0,
    storageObjects: 0,
  };
}

/** Drain a subcollection in chunks of BATCH_SIZE. Returns docs visited (= deleted live). */
async function drainSiteSubcollection(
  db: Firestore,
  siteId: string,
  sub: SiteSubcollection,
  dryRun: boolean,
  deletedPaths: string[],
): Promise<number> {
  const colRef = db.collection('sites').doc(siteId).collection(sub);
  let total = 0;

  if (dryRun) {
    let lastDoc: FirebaseFirestore.QueryDocumentSnapshot | null = null;
    for (;;) {
      let query = colRef.orderBy('__name__').limit(BATCH_SIZE);
      if (lastDoc) query = query.startAfter(lastDoc);

      const snap = await query.get();
      if (snap.empty) break;

      for (const doc of snap.docs) {
        deletedPaths.push(`sites/${siteId}/${sub}/${doc.id}`);
      }
      total += snap.size;

      if (snap.size < BATCH_SIZE) break;
      lastDoc = snap.docs[snap.docs.length - 1] ?? null;
      if (!lastDoc) break;
    }
    return total;
  }

  for (;;) {
    const snap = await colRef.limit(BATCH_SIZE).get();
    if (snap.empty) break;

    const batch = db.batch();
    for (const doc of snap.docs) {
      batch.delete(doc.ref);
      deletedPaths.push(`sites/${siteId}/${sub}/${doc.id}`);
    }
    await batch.commit();

    total += snap.size;
    if (snap.size < BATCH_SIZE) break;
  }

  return total;
}

/** Drain a flat subcollection under `users/{uid}`. Returns docs deleted (counted in dry-run). */
async function drainUserSubcollection(
  ctx: CascadeContext,
  subName: string,
): Promise<number> {
  const colRef = ctx.db
    .collection('users')
    .doc(ctx.userId)
    .collection(subName);
  let total = 0;

  if (ctx.dryRun) {
    let lastDoc: FirebaseFirestore.QueryDocumentSnapshot | null = null;
    for (;;) {
      let query = colRef.orderBy('__name__').limit(BATCH_SIZE);
      if (lastDoc) query = query.startAfter(lastDoc);

      const snap = await query.get();
      if (snap.empty) break;

      for (const doc of snap.docs) {
        ctx.deletedPaths.push(`users/${ctx.userId}/${subName}/${doc.id}`);
      }
      total += snap.size;

      if (snap.size < BATCH_SIZE) break;
      lastDoc = snap.docs[snap.docs.length - 1] ?? null;
      if (!lastDoc) break;
    }
    return total;
  }

  for (;;) {
    const snap = await colRef.limit(BATCH_SIZE).get();
    if (snap.empty) break;

    const batch = ctx.db.batch();
    for (const doc of snap.docs) {
      batch.delete(doc.ref);
      ctx.deletedPaths.push(`users/${ctx.userId}/${subName}/${doc.id}`);
    }
    await batch.commit();

    total += snap.size;
    if (snap.size < BATCH_SIZE) break;
  }

  return total;
}

/**
 * Drain api_key subcollection docs and sweep the matching top-level `api_keys/{keyHash}`
 * lookups — hard-deleted rather than revoked, since the user is going away entirely.
 */
async function drainApiKeys(
  ctx: CascadeContext,
): Promise<{ apiKeys: number; apiKeyLookups: number }> {
  const colRef = ctx.db
    .collection('users')
    .doc(ctx.userId)
    .collection('api_keys');
  let apiKeys = 0;
  let apiKeyLookups = 0;

  // Collect keyHashes BEFORE deleting the subcollection docs so the top-level lookup
  // table can still be swept. Paged to bound memory.
  const keyHashes: string[] = [];

  // 1) Enumerate keyHashes (both live + dry-run).
  let lastDoc: FirebaseFirestore.QueryDocumentSnapshot | null = null;
  for (;;) {
    let query = colRef.orderBy('__name__').limit(BATCH_SIZE);
    if (lastDoc) query = query.startAfter(lastDoc);
    const snap = await query.get();
    if (snap.empty) break;
    for (const doc of snap.docs) {
      const data = doc.data() ?? {};
      if (typeof data.keyHash === 'string') keyHashes.push(data.keyHash);
    }
    if (snap.size < BATCH_SIZE) break;
    lastDoc = snap.docs[snap.docs.length - 1] ?? null;
    if (!lastDoc) break;
  }

  // 2) Drain the subcollection.
  apiKeys = await drainUserSubcollection(ctx, 'api_keys');

  // 3) Sweep the lookup table; a missing lookup (key predates the table) is tolerated.
  for (let i = 0; i < keyHashes.length; i += BATCH_SIZE) {
    const slice = keyHashes.slice(i, i + BATCH_SIZE);
    if (ctx.dryRun) {
      for (const hash of slice) {
        ctx.deletedPaths.push(`api_keys/${hash}`);
        apiKeyLookups += 1;
      }
      continue;
    }
    const batch = ctx.db.batch();
    for (const hash of slice) {
      batch.delete(ctx.db.collection('api_keys').doc(hash));
      ctx.deletedPaths.push(`api_keys/${hash}`);
      apiKeyLookups += 1;
    }
    try {
      await batch.commit();
    } catch (err) {
      logger.warn('[deleteOwnAccount] api_keys lookup batch delete partial-failed', {
        context: 'deleteOwnAccount',
        data: {
          userId: ctx.userId,
          err: err instanceof Error ? err.message : String(err),
        },
      });
    }
  }

  return { apiKeys, apiKeyLookups };
}

/**
 * Delete docs matching a query on a top-level collection (agent_refresh_tokens by
 * `createdBy`, chats by `userId`). Firestore does not cascade subcollections, so callers
 * pass `drainSubcollection='messages'` for chats. Returns docs deleted (or counted).
 */
async function drainQueryWhereEqualsUser(
  ctx: CascadeContext,
  collectionPath: string,
  fieldName: string,
  options?: { drainSubcollection?: string },
): Promise<{ deleted: number; subDeleted: number }> {
  const colRef = ctx.db.collection(collectionPath);
  let deleted = 0;
  let subDeleted = 0;

  for (;;) {
    const snap = await colRef
      .where(fieldName, '==', ctx.userId)
      .limit(BATCH_SIZE)
      .get();
    if (snap.empty) break;

    // Drain subcollection first (if requested) so child docs go before parents.
    if (options?.drainSubcollection) {
      for (const doc of snap.docs) {
        for (;;) {
          const subSnap = await doc.ref
            .collection(options.drainSubcollection)
            .limit(BATCH_SIZE)
            .get();
          if (subSnap.empty) break;

          if (ctx.dryRun) {
            for (const subDoc of subSnap.docs) {
              ctx.deletedPaths.push(
                `${collectionPath}/${doc.id}/${options.drainSubcollection}/${subDoc.id}`,
              );
            }
            subDeleted += subSnap.size;
            if (subSnap.size < BATCH_SIZE) break;
            // dry-run pagination terminator: empty docs ref so a mock can't spin forever.
            break;
          }

          const batch = ctx.db.batch();
          for (const subDoc of subSnap.docs) {
            batch.delete(subDoc.ref);
            ctx.deletedPaths.push(
              `${collectionPath}/${doc.id}/${options.drainSubcollection}/${subDoc.id}`,
            );
          }
          await batch.commit();
          subDeleted += subSnap.size;
          if (subSnap.size < BATCH_SIZE) break;
        }
      }
    }

    if (ctx.dryRun) {
      for (const doc of snap.docs) {
        ctx.deletedPaths.push(`${collectionPath}/${doc.id}`);
      }
      deleted += snap.size;
      if (snap.size < BATCH_SIZE) break;
      // Dry-run doesn't mutate, so a re-query returns the same page — exit after one page.
      break;
    }

    const batch = ctx.db.batch();
    for (const doc of snap.docs) {
      batch.delete(doc.ref);
      ctx.deletedPaths.push(`${collectionPath}/${doc.id}`);
    }
    await batch.commit();
    deleted += snap.size;
    if (snap.size < BATCH_SIZE) break;
  }

  return { deleted, subDeleted };
}

/** Delete `mfa_pending/{uid}`. Returns 1 if the doc existed, else 0. */
async function deleteMfaPending(ctx: CascadeContext): Promise<number> {
  const ref = ctx.db.collection('mfa_pending').doc(ctx.userId);
  const snap = await ref.get().catch(() => null);
  if (!snap || !snap.exists) return 0;
  ctx.deletedPaths.push(`mfa_pending/${ctx.userId}`);
  if (!ctx.dryRun) {
    try {
      await ref.delete();
    } catch (err) {
      logger.warn('[deleteOwnAccount] mfa_pending delete failed (non-fatal)', {
        context: 'deleteOwnAccount',
        data: {
          userId: ctx.userId,
          err: err instanceof Error ? err.message : String(err),
        },
      });
      return 0;
    }
  }
  return 1;
}

/** Delete every Storage object under `users/{uid}/`. Returns files deleted (0 if unconfigured). */
async function drainUserStorage(ctx: CascadeContext): Promise<number> {
  if (!ctx.storage) return 0;
  try {
    const bucket = ctx.storage.bucket();
    const prefix = `users/${ctx.userId}/`;
    const [files] = await bucket.getFiles({ prefix });
    if (files.length === 0) return 0;

    for (const f of files) {
      ctx.deletedPaths.push(`storage://${bucket.name}/${f.name}`);
    }
    if (!ctx.dryRun) {
      await bucket.deleteFiles({ prefix, force: true });
    }
    return files.length;
  } catch (err) {
    logger.warn('[deleteOwnAccount] storage drain failed (non-fatal)', {
      context: 'deleteOwnAccount',
      data: {
        userId: ctx.userId,
        err: err instanceof Error ? err.message : String(err),
      },
    });
    return 0;
  }
}

/**
 * Revoke + delete the Firebase Auth user. True on success or already-absent (idempotent);
 * false on transient failure — surface it but don't block, the Firestore cascade is done.
 */
async function revokeAndDeleteAuthUser(ctx: CascadeContext): Promise<boolean> {
  if (!ctx.auth) return false;
  try {
    await ctx.auth.revokeRefreshTokens(ctx.userId);
  } catch (err) {
    const code = (err as { code?: string } | null)?.code;
    if (code !== 'auth/user-not-found') {
      logger.warn('[deleteOwnAccount] revokeRefreshTokens failed (non-fatal)', {
        context: 'deleteOwnAccount',
        data: {
          userId: ctx.userId,
          code,
          err: err instanceof Error ? err.message : String(err),
        },
      });
    }
  }
  try {
    await ctx.auth.deleteUser(ctx.userId);
    return true;
  } catch (err) {
    const code = (err as { code?: string } | null)?.code;
    if (code === 'auth/user-not-found') {
      // Already gone — treat as success.
      return true;
    }
    logger.warn('[deleteOwnAccount] deleteUser failed', {
      context: 'deleteOwnAccount',
      data: {
        userId: ctx.userId,
        code,
        err: err instanceof Error ? err.message : String(err),
      },
    });
    return false;
  }
}

/**
 * Classify each siteId in `users/{uid}.sites[]` as sole_owner / member / missing.
 * Also returns `ownedSharedSites` (owner AND other members exist) so the caller can
 * refuse with `needs_successor`.
 */
async function classifySites(
  ctx: CascadeContext,
  siteIds: string[],
): Promise<{
  classification: SiteClassification[];
  ownedSharedSites: string[];
}> {
  const classification: SiteClassification[] = [];
  const ownedSharedSites: string[] = [];

  for (const siteId of siteIds) {
    const siteRef = ctx.db.collection('sites').doc(siteId);
    const snap = await siteRef.get();
    if (!snap.exists) {
      classification.push({ siteId, kind: 'missing' });
      continue;
    }
    const data = snap.data() ?? {};
    const owner = typeof data.owner === 'string' ? data.owner : null;
    if (owner !== ctx.userId) {
      classification.push({ siteId, kind: 'member', ownerUid: owner });
      continue;
    }
    // Owner case: one page of `users where sites array-contains siteId` suffices — we only
    // need to know whether ANY other member exists, not enumerate them.
    const otherMembers = await ctx.db
      .collection('users')
      .where('sites', 'array-contains', siteId)
      .limit(2)
      .get();
    const hasOther = otherMembers.docs.some((d) => d.id !== ctx.userId);
    if (hasOther) {
      ownedSharedSites.push(siteId);
      // Record the classification for the audit trail; this branch never reaches the cascade.
      classification.push({ siteId, kind: 'member', ownerUid: ctx.userId });
    } else {
      classification.push({ siteId, kind: 'sole_owner' });
    }
  }

  return { classification, ownedSharedSites };
}

export async function deleteOwnAccount(
  input: DeleteOwnAccountInput,
): Promise<DeleteOwnAccountResult> {
  if (!input.userId || typeof input.userId !== 'string') {
    throw new Error('userId is required');
  }
  if (!input.operationId || typeof input.operationId !== 'string') {
    throw new Error('operationId is required');
  }

  const db = input.db ?? getAdminDb();
  // Auth + Storage resolved lazily; tests inject overrides (including `null` to opt out).
  const auth =
    input.auth === undefined
      ? (() => {
          try {
            return getAdminAuth();
          } catch {
            return null;
          }
        })()
      : input.auth;
  const storage =
    input.storage === undefined
      ? (() => {
          try {
            return getAdminStorage();
          } catch {
            return null;
          }
        })()
      : input.storage;
  const now = input.now ?? (() => Date.now());
  const dryRun = Boolean(input.dryRun);

  const userRef = db.collection('users').doc(input.userId);
  const progressRef = userRef.collection('account_deletion').doc('operation');
  const deletedPaths: string[] = [];

  const ctx: CascadeContext = {
    db,
    auth,
    storage,
    now,
    dryRun,
    deletedPaths,
    userId: input.userId,
  };

  // 0. Idempotency / replay check
  if (!dryRun) {
    const progressSnap = await progressRef.get().catch(() => null);
    if (progressSnap && progressSnap.exists) {
      const data = progressSnap.data() ?? {};
      if (data.completedAt && data.operationId === input.operationId) {
        const recordedSites = Array.isArray(data.sites)
          ? (data.sites as unknown[]).filter(
              (s): s is string => typeof s === 'string',
            )
          : [];
        const counts = (data.deletedCounts as Record<string, unknown>) ?? {};
        return {
          kind: 'ok',
          userId: input.userId,
          operationId: input.operationId,
          performed: false,
          alreadyCompleted: true,
          dryRun: false,
          sites: recordedSites,
          siteClassification: Array.isArray(data.siteClassification)
            ? (data.siteClassification as SiteClassification[])
            : [],
          deletedCounts: {
            ...emptyDeletedCounts(),
            machines: numberOr0(counts.machines),
            deployments: numberOr0(counts.deployments),
            logs: numberOr0(counts.logs),
            sites: numberOr0(counts.sites),
            users: numberOr0(counts.users),
            memberSitesRemoved: numberOr0(counts.memberSitesRemoved),
            passkeys: numberOr0(counts.passkeys),
            trustedDevices: numberOr0(counts.trustedDevices),
            verifiedNetworks: numberOr0(counts.verifiedNetworks),
            apiKeys: numberOr0(counts.apiKeys),
            apiKeyLookups: numberOr0(counts.apiKeyLookups),
            mfaPending: numberOr0(counts.mfaPending),
            agentRefreshTokens: numberOr0(counts.agentRefreshTokens),
            chats: numberOr0(counts.chats),
            chatMessages: numberOr0(counts.chatMessages),
            storageObjects: numberOr0(counts.storageObjects),
          },
          authRevoked: Boolean(data.authRevoked),
          deletedPaths: Array.isArray(data.deletedPaths)
            ? (data.deletedPaths as unknown[]).filter(
                (s): s is string => typeof s === 'string',
              )
            : [],
        };
      }
    }
  }

  // 1. Read the user doc for the sites[] list
  const userSnap = await userRef.get();
  if (!userSnap.exists) {
    return {
      kind: 'ok',
      userId: input.userId,
      operationId: input.operationId,
      performed: false,
      alreadyCompleted: true,
      dryRun,
      sites: [],
      siteClassification: [],
      deletedCounts: emptyDeletedCounts(),
      authRevoked: false,
      deletedPaths: [],
    };
  }
  const userData = userSnap.data() ?? {};
  const sites = Array.isArray(userData.sites)
    ? (userData.sites as unknown[]).filter(
        (s): s is string => typeof s === 'string',
      )
    : [];

  // 2. Classify sites; refuse on owned-shared
  const { classification, ownedSharedSites } = await classifySites(ctx, sites);
  if (ownedSharedSites.length > 0) {
    return {
      kind: 'needs_successor',
      userId: input.userId,
      operationId: input.operationId,
      ownedSharedSites,
    };
  }

  // 3. Stamp the progress doc in-flight (live runs only)
  if (!dryRun) {
    try {
      await progressRef.set(
        {
          operationId: input.operationId,
          userId: input.userId,
          startedAt: FieldValue.serverTimestamp(),
          startedAtMs: now(),
          sites,
          siteClassification: classification,
          status: 'in_progress',
        },
        { merge: true },
      );
    } catch (err) {
      logger.warn(
        '[deleteOwnAccount] progress doc write failed (non-fatal — continuing)',
        {
          context: 'deleteOwnAccount',
          data: {
            userId: input.userId,
            operationId: input.operationId,
            err: err instanceof Error ? err.message : String(err),
          },
        },
      );
    }
  }

  // 4. Per-site cascade: sole-owner sites drain machines/deployments/logs + the site doc;
  // member sites stay (step 6 deletes the user doc anyway) but are counted for the audit.
  const totals: SiteScanCounts = emptyCounts();
  let sitesDeleted = 0;
  let memberSitesRemoved = 0;

  for (const entry of classification) {
    if (entry.kind === 'missing') continue;
    if (entry.kind === 'member') {
      memberSitesRemoved += 1;
      continue;
    }
    const siteRef = db.collection('sites').doc(entry.siteId);
    for (const sub of SITE_SUBCOLLECTIONS) {
      const n = await drainSiteSubcollection(
        db,
        entry.siteId,
        sub,
        dryRun,
        deletedPaths,
      );
      totals[sub] += n;
    }
    if (!dryRun) {
      // Tombstone the id BEFORE freeing it — the same guarantee `deleteSite`
      // makes (see deleteSite.server.ts), for the same reason. Site ids are
      // caller-supplied slugs, deletion does not clear OTHER users' `sites[]`
      // entries, and `POST /api/sites` is open to any authenticated user — so an
      // untombstoned slug can be re-registered by anyone, and the previous
      // site's members come with it as a cross-tenant grant nobody performed.
      // This path deleted the site document without a tombstone, which made
      // self-delete the one way to free a slug unsafely. Written first: a
      // tombstone with no delete is harmless, a delete with no tombstone is the
      // bug. Timestamp only — the document is client-readable for the
      // id-availability check and must carry nothing else.
      await db.collection('site_ids').doc(entry.siteId).set({
        deletedAt: FieldValue.serverTimestamp(),
      });
      await siteRef.delete();
    }
    deletedPaths.push(`site_ids/${entry.siteId}`);
    deletedPaths.push(`sites/${entry.siteId}`);
    sitesDeleted += 1;
  }

  // 5. User-scoped subcollections + cross-collection sweeps
  const passkeys = await drainUserSubcollection(ctx, 'passkeys');
  // Drain device-trust records too, else a stale trust cookie could skip MFA for a later
  // account re-created under the same uid.
  const trustedDevices = await drainUserSubcollection(ctx, 'trustedDevices');
  // the networks swoop control was verified from: asn and timestamps, nothing to keep
  const verifiedNetworks = await drainUserSubcollection(ctx, 'verified_networks');
  const { apiKeys, apiKeyLookups } = await drainApiKeys(ctx);
  const mfaPending = await deleteMfaPending(ctx);
  const agentTokens = await drainQueryWhereEqualsUser(
    ctx,
    'agent_refresh_tokens',
    'createdBy',
  );
  const chats = await drainQueryWhereEqualsUser(ctx, 'chats', 'userId', {
    drainSubcollection: 'messages',
  });
  const storageObjects = await drainUserStorage(ctx);

  // 6. Delete the user doc
  let usersDeleted = 0;
  if (!dryRun) {
    await userRef.delete();
  }
  deletedPaths.push(`users/${input.userId}`);
  usersDeleted = 1;

  // 7. Revoke + delete the Firebase Auth user
  let authRevoked = false;
  if (!dryRun) {
    authRevoked = await revokeAndDeleteAuthUser(ctx);
  }

  const deletedCounts = {
    machines: totals.machines,
    deployments: totals.deployments,
    logs: totals.logs,
    sites: sitesDeleted,
    users: usersDeleted,
    memberSitesRemoved,
    passkeys,
    trustedDevices,
    verifiedNetworks,
    apiKeys,
    apiKeyLookups,
    mfaPending,
    agentRefreshTokens: agentTokens.deleted,
    chats: chats.deleted,
    chatMessages: chats.subDeleted,
    storageObjects,
  };

  // 8. Stamp the progress doc completed
  if (!dryRun) {
    try {
      await progressRef.set(
        {
          operationId: input.operationId,
          userId: input.userId,
          completedAt: FieldValue.serverTimestamp(),
          completedAtMs: now(),
          status: 'completed',
          sites,
          siteClassification: classification,
          deletedCounts,
          authRevoked,
          deletedPaths: deletedPaths.slice(0, 200),
        },
        { merge: true },
      );
    } catch (err) {
      logger.warn(
        '[deleteOwnAccount] progress doc completion stamp failed (non-fatal)',
        {
          context: 'deleteOwnAccount',
          data: {
            userId: input.userId,
            operationId: input.operationId,
            err: err instanceof Error ? err.message : String(err),
          },
        },
      );
    }
  }

  return {
    kind: 'ok',
    userId: input.userId,
    operationId: input.operationId,
    performed: !dryRun,
    alreadyCompleted: false,
    dryRun,
    sites,
    siteClassification: classification,
    deletedCounts,
    authRevoked,
    deletedPaths,
  };
}

function numberOr0(v: unknown): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : 0;
}
