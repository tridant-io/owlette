/**
 * Scheduled chunk garbage collection (roost wave 2b.4).
 *
 * Nightly, per site: skip sites with an in-flight rollout, gather the referenced-hash
 * set (live versions) and the stored-hash set (R2 listing under the per-tenant
 * prefix), load tombstones, produce a plan (pure — lib/chunkGcLogic.ts), then apply
 * it or log it.
 *
 * REFERENCE TRUTH IS THE R2 VERSION BODY. `sites/{siteId}/roosts/{roostId}/versions/
 * {versionId}` carries summary metadata only — no chunk list — so the scan fetches
 * `project-manifests/{siteId}/{roostId}/{versionId}.json` (written by the finalize
 * route BEFORE its firestore transaction, so every version doc that exists has a body)
 * and reads `files[].chunks[].hash`. The firestore `chunk_referrers` index is NOT used:
 * it is written after the transaction commits, so a crash in that window would leave a
 * live version with no referrer rows — and GC would read that as "orphaned".
 *
 * FAIL CLOSED. Any failure to list sites/roosts/versions, fetch a version body, parse
 * one, or list R2 marks the run degraded, and a degraded run deletes nothing anywhere —
 * scanning happens for every site before a single mutation, so a bad site late in the
 * list still vetoes deletions for sites scanned earlier. Tombstone create/clear still
 * run for sites that scanned cleanly (both are reversible; the resurrection guard
 * re-checks before any delete). GC that errs must err toward leaking, never deleting.
 *
 * ROLLOUT. `CHUNK_GC_MODE` is unset by default, which means dry-run: the plan is
 * logged (counts + a sample of delete candidates) and nothing is written. Deploy in
 * dry-run, read `[chunkGc:dry-run]` logs for at least 30 days — one full tombstone TTL,
 * so the first would-be deletions appear — and only then set CHUNK_GC_MODE=apply.
 *
 * CONFIG PREREQUISITE. The functions codebase needs its own R2 credentials:
 * R2_S3_ENDPOINT, R2_S3_ACCESS_KEY_ID, R2_S3_SECRET_ACCESS_KEY and ROOST_ENV
 * (dev|prod) in `functions/.env.<projectId>`. Without them every run aborts before
 * touching storage.
 *
 * TODO: denormalised chunk refcount doc, to avoid fetching every version body — without
 * it sites with thousands of versions will be slow.
 */

import { onSchedule } from 'firebase-functions/v2/scheduler';
import { getFirestore } from 'firebase-admin/firestore';
import { FieldValue } from 'firebase-admin/firestore';
import {
  extractChunkHashes,
  planGc,
  summarisePlan,
  TOMBSTONE_TTL_MS,
  type GcPlan,
  type GcSummary,
  type TombstoneRecord,
} from './lib/chunkGcLogic';
import {
  bucketFor,
  chunkKey,
  chunkPrefix,
  createR2Client,
  hashFromChunkKey,
  loadR2Config,
  versionKey,
  type R2Client,
  type RoostEnv,
} from './lib/r2Client';

const FIRESTORE_BATCH_LIMIT = 400;
/** Parallel version-body fetches per site. Bounded so a big roost can't open a socket per version. */
const VERSION_FETCH_CONCURRENCY = 16;

export interface ObjectStore {
  /** List all chunk hashes stored under the per-tenant prefix. */
  listStoredHashes(siteId: string): Promise<Set<string>>;
  /** Delete a chunk by hash. Idempotent. */
  deleteChunk(siteId: string, hash: string): Promise<void>;
}

export interface SiteScanner {
  /** Every site id known to the system (firestore `sites/` listing in production). */
  listSiteIds(): Promise<string[]>;
  /**
   * Hashes referenced by any live version: currentVersionId + previousVersionId +
   * anything still in rollout history within the retention window.
   */
  getReferencedHashes(siteId: string): Promise<Set<string>>;
  /**
   * True if a non-terminal rollout is active. GC pauses during publish so it can't
   * race an in-flight upload whose version is not yet finalised.
   */
  hasActiveRollout(siteId: string): Promise<boolean>;
}

export interface TombstoneStore {
  list(siteId: string): Promise<TombstoneRecord[]>;
  /** Atomically create new tombstones. */
  create(siteId: string, hashes: string[], now: Date): Promise<void>;
  /** Atomically remove tombstone metadata (no chunk delete). */
  clear(siteId: string, hashes: string[]): Promise<void>;
}

export type GcMode = 'dry-run' | 'apply';

export interface GcDeps {
  scanner: SiteScanner;
  store: ObjectStore;
  tombstones: TombstoneStore;
  mode: GcMode;
  /** injected for determinism in tests. */
  now?: () => Date;
}

export interface SiteGcResult {
  siteId: string;
  skipped: boolean;
  skipReason?: string;
  summary?: GcSummary;
  mode: GcMode;
  /** True when deletions were withheld because the run was degraded. */
  deletionsWithheld?: boolean;
  /** Chunks actually removed from storage. Undefined outside apply mode. */
  deleted?: number;
}

export interface GcRunResult {
  mode: GcMode;
  /** True when any site failed to scan — no deletions were performed anywhere. */
  degraded: boolean;
  /** Site ids whose scan failed (empty with `degraded` true means the site listing failed). */
  degradedSites: string[];
  results: SiteGcResult[];
}

/** apply is opt-in and exact-match: anything else, including unset, is dry-run. */
export function resolveMode(env: NodeJS.ProcessEnv = process.env): GcMode {
  return (env.CHUNK_GC_MODE ?? '').trim() === 'apply' ? 'apply' : 'dry-run';
}

interface SiteScan {
  siteId: string;
  /** The scan could not establish what is referenced or stored. */
  failed: boolean;
  skipped: boolean;
  skipReason?: string;
  plan?: GcPlan;
  summary?: GcSummary;
  now: Date;
}

/**
 * Read-only half of a site's GC: rollout check, reference scan, storage listing, plan.
 * Never throws and never mutates — a failure comes back as `failed` with no plan.
 */
async function scanSite(siteId: string, deps: GcDeps): Promise<SiteScan> {
  const now = deps.now ? deps.now() : new Date();

  try {
    if (await deps.scanner.hasActiveRollout(siteId)) {
      return { siteId, failed: false, skipped: true, skipReason: 'active_rollout', now };
    }

    const [referenced, stored, tombstones] = await Promise.all([
      deps.scanner.getReferencedHashes(siteId),
      deps.store.listStoredHashes(siteId),
      deps.tombstones.list(siteId),
    ]);

    const plan = planGc({
      referenced,
      stored,
      tombstones,
      now: now.getTime(),
    });
    return {
      siteId,
      failed: false,
      skipped: false,
      plan,
      summary: summarisePlan(plan),
      now,
    };
  } catch (err) {
    const message = (err as Error).message;
    console.error(`[chunkGc] scan failed for site ${siteId}: ${message}`);
    return {
      siteId,
      failed: true,
      skipped: true,
      skipReason: `scan_error: ${message}`,
      now,
    };
  }
}

/**
 * Mutating half. `allowDelete` is false on a degraded run: tombstones are still
 * maintained (reversible, and re-checked against references before any delete) but
 * nothing is removed from storage.
 */
async function applySitePlan(
  scan: SiteScan,
  deps: GcDeps,
  allowDelete: boolean,
): Promise<SiteGcResult> {
  const { siteId, plan, summary } = scan;
  if (!plan || !summary) {
    return {
      siteId,
      skipped: true,
      skipReason: scan.skipReason,
      mode: deps.mode,
    };
  }

  if (deps.mode === 'dry-run') {
    logDryRun(siteId, plan, summary, allowDelete);
    return { siteId, skipped: false, summary, mode: 'dry-run' };
  }

  if (!summary.hasChanges) {
    return { siteId, skipped: false, summary, mode: 'apply', deleted: 0 };
  }

  // Ordering matters: tombstone FIRST, so a mid-way failure leaves consistent state
  // (tombstones exist, deletions retry next run). Then clear stale tombstones, then
  // delete ripe chunks — a failed delete leaves the tombstone ripe for the next run.
  if (plan.toTombstone.length > 0) {
    await deps.tombstones.create(siteId, plan.toTombstone, scan.now);
  }
  if (plan.tombstonesToClear.length > 0) {
    await deps.tombstones.clear(siteId, plan.tombstonesToClear);
  }

  if (!allowDelete) {
    if (plan.toDelete.length > 0) {
      console.warn(
        `[chunkGc] degraded run — withholding ${plan.toDelete.length} deletion(s) for site ${siteId}`,
      );
    }
    return {
      siteId,
      skipped: false,
      summary,
      mode: 'apply',
      deletionsWithheld: true,
      deleted: 0,
    };
  }

  let deleted = 0;
  for (const hash of plan.toDelete) {
    try {
      await deps.store.deleteChunk(siteId, hash);
      await deps.tombstones.clear(siteId, [hash]);
      deleted += 1;
    } catch (err) {
      // individual delete failure doesn't tank the whole site — log + continue.
      console.error(
        `[chunkGc] delete failed for ${siteId}/${hash}: ${
          (err as Error).message
        }`,
      );
    }
  }

  return { siteId, skipped: false, summary, mode: 'apply', deleted };
}

/** GC one site end-to-end, returning what happened. */
export async function gcOneSite(
  siteId: string,
  deps: GcDeps,
): Promise<SiteGcResult> {
  const scan = await scanSite(siteId, deps);
  return applySitePlan(scan, deps, !scan.failed);
}

export async function gcAllSites(deps: GcDeps): Promise<GcRunResult> {
  let siteIds: string[];
  try {
    siteIds = await deps.scanner.listSiteIds();
  } catch (err) {
    console.error(
      `[chunkGc] site listing failed, aborting run: ${(err as Error).message}`,
    );
    return { mode: deps.mode, degraded: true, degradedSites: [], results: [] };
  }

  // Phase 1 — scan everything before mutating anything, so a site that fails late in
  // the list can still veto deletions for sites scanned earlier.
  const scans: SiteScan[] = [];
  for (const siteId of siteIds) {
    scans.push(await scanSite(siteId, deps));
  }
  const degradedSites = scans.filter((s) => s.failed).map((s) => s.siteId);
  const degraded = degradedSites.length > 0;
  if (degraded) {
    console.error(
      `[chunkGc] run degraded — ${degradedSites.length} site(s) failed to scan ` +
        `(${degradedSites.slice(0, 10).join(', ')}); no chunks will be deleted`,
    );
  }

  // Phase 2 — apply (or log) each plan.
  const results: SiteGcResult[] = [];
  for (const scan of scans) {
    try {
      results.push(await applySitePlan(scan, deps, !degraded));
    } catch (err) {
      console.error(
        `[chunkGc] unhandled error for site ${scan.siteId}: ${
          (err as Error).message
        }`,
      );
      results.push({
        siteId: scan.siteId,
        skipped: true,
        skipReason: `error: ${(err as Error).message}`,
        mode: deps.mode,
      });
    }
  }

  return { mode: deps.mode, degraded, degradedSites, results };
}

function logDryRun(
  siteId: string,
  plan: GcPlan,
  summary: GcSummary,
  allowDelete: boolean,
): void {
  console.log(
    `[chunkGc:dry-run] site=${siteId} ` +
      `would_tombstone=${summary.newTombstones} ` +
      `would_delete=${allowDelete ? summary.deletions : 0} ` +
      `would_clear_tombstones=${summary.tombstonesCleared} ` +
      `tombstone_backlog=${summary.tombstonesRetained}` +
      (allowDelete ? '' : ' (degraded run — deletions withheld)'),
  );
  if (allowDelete && plan.toDelete.length > 0) {
    // first 5 as a sample — don't blow the log on a huge sweep.
    const sample = plan.toDelete.slice(0, 5).join(', ');
    console.log(
      `[chunkGc:dry-run] ${siteId} sample delete candidates: ${sample}${
        plan.toDelete.length > 5 ? ` (+${plan.toDelete.length - 5} more)` : ''
      }`,
    );
  }
}

/**
 * Scheduled 02:15 UTC daily. 540s timeout (scheduler cap for low-cost functions);
 * per-site work is sequential, bounded by firestore quota on the scanner.
 */
export const chunkGcNightly = onSchedule(
  { schedule: '15 2 * * *', timeoutSeconds: 540, memory: '512MiB' },
  async () => {
    const mode = resolveMode();

    let deps: GcDeps;
    try {
      const config = loadR2Config();
      const r2 = createR2Client(config);
      const db = getFirestore();
      deps = {
        scanner: createFirestoreScanner(db, r2, config.env),
        store: createR2ObjectStore(r2, config.env),
        tombstones: createTombstoneStore(db),
        mode,
      };
    } catch (err) {
      // Misconfiguration must not look like "nothing to collect" — abort loudly.
      console.error(
        `[chunkGc] aborting run, storage not configured: ${(err as Error).message}`,
      );
      return;
    }

    const run = await gcAllSites(deps);
    const summary = {
      mode: run.mode,
      degraded: run.degraded,
      degraded_sites: run.degradedSites.length,
      sites: run.results.length,
      skipped: run.results.filter((r) => r.skipped).length,
      active_rollout_skipped: run.results.filter(
        (r) => r.skipReason === 'active_rollout',
      ).length,
      total_tombstoned: run.results.reduce(
        (n, r) => n + (r.summary?.newTombstones ?? 0),
        0,
      ),
      total_deletions_planned: run.results.reduce(
        (n, r) => n + (r.summary?.deletions ?? 0),
        0,
      ),
      // Actually removed from storage — zero in dry-run, zero on a degraded run, and
      // short of `total_deletions_planned` when individual deletes failed.
      total_deleted: run.results.reduce((n, r) => n + (r.deleted ?? 0), 0),
    };
    console.log(`[chunkGc] run complete: ${JSON.stringify(summary)}`);
  },
);

/**
 * Firestore-backed scanner. Reading every version body nightly is adequate at expected
 * fleet size (≤ low thousands per site); a denormalised refcount doc is the long-term
 * fix. `listDocuments()` rather than `get()` throughout: it also returns parents that
 * exist only as a subcollection holder, so a phantom roost's versions still count.
 */
export function createFirestoreScanner(
  db: FirebaseFirestore.Firestore,
  r2: R2Client,
  env: RoostEnv,
): SiteScanner {
  const manifestBucket = bucketFor(env, 'manifests');

  return {
    async listSiteIds() {
      const refs = await db.collection('sites').listDocuments();
      return refs.map((d) => d.id);
    },

    async getReferencedHashes(siteId: string) {
      const referenced = new Set<string>();
      const roostRefs = await db
        .collection('sites')
        .doc(siteId)
        .collection('roosts')
        .listDocuments();

      for (const roostRef of roostRefs) {
        const versionRefs = await roostRef.collection('versions').listDocuments();
        const versionIds = versionRefs.map((v) => v.id);

        let cursor = 0;
        const worker = async () => {
          while (cursor < versionIds.length) {
            const versionId = versionIds[cursor++];
            const key = versionKey(siteId, roostRef.id, versionId);
            const text = await r2.getText(manifestBucket, key);
            if (text === null) {
              // The finalize route writes the body before the transaction, so a
              // version doc without one means storage lost it. Refuse to guess.
              throw new Error(
                `version body missing in R2: ${manifestBucket}/${key}`,
              );
            }
            let parsed: unknown;
            try {
              parsed = JSON.parse(text);
            } catch (err) {
              throw new Error(
                `version body is not valid JSON (${key}): ${(err as Error).message}`,
              );
            }
            let hashes: string[];
            try {
              hashes = extractChunkHashes(parsed);
            } catch (err) {
              throw new Error(
                `version body rejected (${key}): ${(err as Error).message}`,
              );
            }
            for (const h of hashes) referenced.add(h);
          }
        };

        const workers: Promise<void>[] = [];
        for (
          let i = 0;
          i < Math.min(VERSION_FETCH_CONCURRENCY, versionIds.length);
          i++
        ) {
          workers.push(worker());
        }
        await Promise.all(workers);
      }

      return referenced;
    },

    async hasActiveRollout(siteId: string) {
      // check any roost with an in-flight rollout doc.
      const roostRefs = await db
        .collection('sites')
        .doc(siteId)
        .collection('roosts')
        .listDocuments();
      for (const roostRef of roostRefs) {
        const rolloutsSnap = await roostRef
          .collection('rollouts')
          .where('stage', 'in', ['canary', 'fleet'])
          .limit(1)
          .get();
        if (!rolloutsSnap.empty) return true;
      }
      return false;
    },
  };
}

export function createR2ObjectStore(r2: R2Client, env: RoostEnv): ObjectStore {
  const contentBucket = bucketFor(env, 'content');
  return {
    async listStoredHashes(siteId: string) {
      const keys = await r2.listKeys(contentBucket, chunkPrefix(siteId));
      const hashes = new Set<string>();
      let unrecognised = 0;
      for (const key of keys) {
        const hash = hashFromChunkKey(siteId, key);
        if (hash) hashes.add(hash);
        else unrecognised += 1;
      }
      if (unrecognised > 0) {
        // Not deletion candidates — an object we can't map to a hash is left alone.
        console.warn(
          `[chunkGc] ${siteId}: ${unrecognised} object(s) under ${chunkPrefix(siteId)} are not chunk keys — ignored`,
        );
      }
      return hashes;
    },
    async deleteChunk(siteId: string, hash: string) {
      await r2.deleteObject(contentBucket, chunkKey(siteId, hash));
    },
  };
}

export function createTombstoneStore(
  db: FirebaseFirestore.Firestore,
): TombstoneStore {
  const col = (siteId: string) =>
    db.collection('sites').doc(siteId).collection('chunk_tombstones');
  return {
    async list(siteId: string) {
      const snap = await col(siteId).get();
      return snap.docs.map((d) => ({
        hash: d.id,
        tombstonedAt: (
          d.data().tombstonedAt as FirebaseFirestore.Timestamp
        ).toMillis(),
      }));
    },
    async create(siteId: string, hashes: string[], now: Date) {
      let batch = db.batch();
      let opsInBatch = 0;
      for (const hash of hashes) {
        batch.set(col(siteId).doc(hash), {
          tombstonedAt: FieldValue.serverTimestamp(),
          plannedDeleteAfter: new Date(now.getTime() + TOMBSTONE_TTL_MS),
        });
        opsInBatch += 1;
        if (opsInBatch >= FIRESTORE_BATCH_LIMIT) {
          await batch.commit();
          batch = db.batch();
          opsInBatch = 0;
        }
      }
      if (opsInBatch > 0) {
        await batch.commit();
      }
    },
    async clear(siteId: string, hashes: string[]) {
      // Batched like `create`: a first real GC run can clear far more than one
      // firestore batch holds, and an over-limit commit throws mid-plan.
      let batch = db.batch();
      let opsInBatch = 0;
      for (const hash of hashes) {
        batch.delete(col(siteId).doc(hash));
        opsInBatch += 1;
        if (opsInBatch >= FIRESTORE_BATCH_LIMIT) {
          await batch.commit();
          batch = db.batch();
          opsInBatch = 0;
        }
      }
      if (opsInBatch > 0) {
        await batch.commit();
      }
    },
  };
}
