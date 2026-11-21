#!/usr/bin/env node
/**
 * Status: done with. Step 2.3 of the 2.12.x promotion (docs/runbooks/upgrade-2.12.0.md),
 * which reached prod in 073e031f; nothing reads `synced_folders` any more.
 *
 * Firestore migration: `sites/{siteId}/synced_folders/{id}` →
 * `sites/{siteId}/roosts/{id}`. Internal rename only — doc ids are preserved and
 * no user-visible id changes.
 *
 * Per site: copy each doc's top-level fields, recursively copy the `manifests`,
 * `target_state` and `rollouts` subcollections, verify, then delete the source.
 *
 * Dry-run by default; `--apply` writes and deletes. Idempotent — an existing
 * `roosts/{id}` is overwritten from the latest source, deleted sources are skipped.
 *
 * Flags:
 *   --env=dev|prod   required — target Firebase project
 *   --apply          commit writes + deletes
 *   --site=<id>      limit to one site
 *   --keep-source    copy but do NOT delete, for a soak before hard cutover
 *
 * Exits 0 on success, 1 on any failure.
 */

import { createRequire } from 'module';
import { fileURLToPath } from 'url';
import { readFileSync, existsSync } from 'fs';
import { dirname, join } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..', '..');

// firebase-admin lives in web/node_modules; the repo root has no package.json.
const require = createRequire(join(ROOT, 'web', 'package.json'));
// Modular entry points, not the firebase-admin root namespace: since v14 the
// root exports only initializeApp/getApp/getApps/deleteApp/applicationDefault/
// cert/refreshToken, so the credential and firestore accessors on it are both
// undefined. Ported 2026-09-07 — the v14 sweep in a454e4cd touched only web/ and
// functions/, so every script here threw on startup while a checked-in runbook
// (docs/runbooks/upgrade-2.12.0.md) still told operators to run them.
const { initializeApp, cert } = require('firebase-admin/app');
const { getFirestore } = require('firebase-admin/firestore');

// CLI parsing

const args = process.argv.slice(2);

function getFlag(name) {
  const match = args.find((a) => a === `--${name}` || a.startsWith(`--${name}=`));
  if (!match) return undefined;
  const eq = match.indexOf('=');
  return eq === -1 ? true : match.slice(eq + 1);
}

const env = getFlag('env');
const apply = getFlag('apply') === true;
const keepSource = getFlag('keep-source') === true;
const siteFilter = getFlag('site') === true ? undefined : getFlag('site');

if (env !== 'dev' && env !== 'prod') {
  console.error(
    'Usage: node scripts/migrations/migrate-synced-folders-to-roosts.mjs --env=dev|prod [--apply] [--site=<id>] [--keep-source]',
  );
  process.exit(1);
}

const dryRun = !apply;

// .env loading

function loadEnvFile(path) {
  if (!existsSync(path)) return;
  for (const raw of readFileSync(path, 'utf8').split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    let val = line.slice(eq + 1).trim();
    if (
      (val.startsWith('"') && val.endsWith('"')) ||
      (val.startsWith("'") && val.endsWith("'"))
    ) {
      val = val.slice(1, -1);
    }
    if (!process.env[key]) process.env[key] = val;
  }
}

loadEnvFile(join(ROOT, 'web', '.env.local'));
loadEnvFile(join(ROOT, '.claude', '.env.local'));
loadEnvFile(join(ROOT, 'scripts', '.env.local'));

// Credentials

const suffix = env === 'prod' ? '_PROD' : '_DEV';
const projectId =
  process.env[`FIREBASE_PROJECT_ID${suffix}`] || process.env.FIREBASE_PROJECT_ID;
const clientEmail =
  process.env[`FIREBASE_CLIENT_EMAIL${suffix}`] || process.env.FIREBASE_CLIENT_EMAIL;
const rawPrivateKey =
  process.env[`FIREBASE_PRIVATE_KEY${suffix}`] || process.env.FIREBASE_PRIVATE_KEY;

if (!projectId || !clientEmail || !rawPrivateKey) {
  console.error(`ERROR: missing Firebase credentials for env=${env}.`);
  console.error(`  Set FIREBASE_PROJECT_ID${suffix}, FIREBASE_CLIENT_EMAIL${suffix},`);
  console.error(`  and FIREBASE_PRIVATE_KEY${suffix} (or the unsuffixed fallbacks).`);
  process.exit(1);
}

const privateKey = rawPrivateKey.replace(/\\n/g, '\n');

const app = initializeApp({
  credential: cert({ projectId, clientEmail, privateKey }),
});
const db = getFirestore(app);

// Core migration

/** Subcollections we know live under a synced_folder/roost doc. */
const KNOWN_SUBCOLLECTIONS = ['manifests', 'target_state', 'rollouts'];

async function copyDoc(srcRef, dstRef) {
  const snap = await srcRef.get();
  if (!snap.exists) return false;
  const data = snap.data();
  if (dryRun) return true;
  // No merge: the destination must be an exact snapshot of the source, which is
  // also what a re-run wants.
  await dstRef.set(data);
  return true;
}

async function copySubcollection(srcParent, dstParent, subName) {
  const snap = await srcParent.collection(subName).get();
  if (snap.empty) return 0;
  let copied = 0;
  // BulkWriter batches + retries, dodging the 500-per-commit cap on roosts with
  // thousands of manifests.
  const bulk = dryRun ? null : db.bulkWriter();
  for (const doc of snap.docs) {
    if (dryRun) {
      copied++;
      continue;
    }
    bulk.set(dstParent.collection(subName).doc(doc.id), doc.data());
    copied++;
  }
  if (bulk) await bulk.close();
  return copied;
}

async function deleteDocAndSubcollections(ref) {
  if (dryRun) return;
  const bulk = db.bulkWriter();
  for (const subName of KNOWN_SUBCOLLECTIONS) {
    const sub = await ref.collection(subName).get();
    for (const d of sub.docs) bulk.delete(d.ref);
  }
  bulk.delete(ref);
  await bulk.close();
}

async function verifyCopy(srcRef, dstRef) {
  if (dryRun) return true;
  const [srcSnap, dstSnap] = await Promise.all([srcRef.get(), dstRef.get()]);
  if (!dstSnap.exists) return false;
  // Keys, not values — admin SDK Timestamp equality is brittle, and a missing
  // destination key is the failure mode that matters before a delete.
  if (!srcSnap.exists) return true; // already migrated + deleted; treat as ok
  const srcKeys = Object.keys(srcSnap.data() || {}).sort();
  const dstKeys = Object.keys(dstSnap.data() || {}).sort();
  if (srcKeys.length !== dstKeys.length) return false;
  for (let i = 0; i < srcKeys.length; i++) {
    if (srcKeys[i] !== dstKeys[i]) return false;
  }
  return true;
}

async function migrateSite(siteId) {
  const srcCol = db.collection('sites').doc(siteId).collection('synced_folders');
  const dstCol = db.collection('sites').doc(siteId).collection('roosts');

  const srcSnap = await srcCol.get();
  if (srcSnap.empty) {
    console.log(`  [${siteId}] no synced_folders to migrate — skipping`);
    return { docsProcessed: 0, subDocsCopied: 0, deleted: 0, failed: 0 };
  }

  let docsProcessed = 0;
  let subDocsCopied = 0;
  let deleted = 0;
  let failed = 0;

  for (const folderDoc of srcSnap.docs) {
    const id = folderDoc.id;
    const srcRef = srcCol.doc(id);
    const dstRef = dstCol.doc(id);

    try {
      const copied = await copyDoc(srcRef, dstRef);
      if (!copied) {
        // vanished mid-iteration
        continue;
      }
      let localSubs = 0;
      for (const sub of KNOWN_SUBCOLLECTIONS) {
        localSubs += await copySubcollection(srcRef, dstRef, sub);
      }

      const ok = await verifyCopy(srcRef, dstRef);
      if (!ok) {
        console.error(
          `  [${siteId}/${id}] verify FAILED — destination missing or shape mismatch; skipping delete`,
        );
        failed++;
        continue;
      }

      if (!keepSource) {
        await deleteDocAndSubcollections(srcRef);
        deleted++;
      }

      docsProcessed++;
      subDocsCopied += localSubs;
      console.log(
        `  [${siteId}/${id}] ${dryRun ? '[DRY] would ' : ''}copied doc + ${localSubs} sub-doc(s)` +
          (keepSource ? ' (keep-source)' : dryRun ? ' + would delete source' : ' + deleted source'),
      );
    } catch (err) {
      console.error(`  [${siteId}/${id}] ERROR: ${err.message}`);
      failed++;
    }
  }

  return { docsProcessed, subDocsCopied, deleted, failed };
}

async function listSiteIds() {
  if (siteFilter) return [siteFilter];
  const snap = await db.collection('sites').listDocuments();
  return snap.map((d) => d.id);
}

// Entrypoint

async function main() {
  console.log(
    `\n${dryRun ? '[DRY RUN] ' : ''}synced_folders → roosts migration — env=${env}, project=${projectId}` +
      (siteFilter ? `, site=${siteFilter}` : ', site=all') +
      (keepSource ? ', keep-source' : '') +
      '\n',
  );

  const siteIds = await listSiteIds();
  if (siteIds.length === 0) {
    console.log('no sites found — nothing to do');
    return 0;
  }

  const totals = { sites: 0, docs: 0, subDocs: 0, deleted: 0, failed: 0 };

  for (const siteId of siteIds) {
    totals.sites++;
    const r = await migrateSite(siteId);
    totals.docs += r.docsProcessed;
    totals.subDocs += r.subDocsCopied;
    totals.deleted += r.deleted;
    totals.failed += r.failed;
  }

  console.log('\nTotals:');
  console.log(`  Sites scanned    : ${totals.sites}`);
  console.log(`  Docs ${dryRun ? 'would copy' : 'copied     '}: ${totals.docs}`);
  console.log(`  Sub-docs         : ${totals.subDocs}`);
  console.log(`  Sources ${dryRun ? 'would del' : 'deleted  '}: ${totals.deleted}`);
  console.log(`  Failed           : ${totals.failed}`);

  if (dryRun) {
    console.log('\nDry run complete — no writes made. Re-run with --apply to commit.');
  } else if (totals.failed > 0) {
    console.log('\nMigration completed WITH FAILURES — see log above.');
    return 1;
  } else {
    console.log('\nMigration complete.');
  }
  return 0;
}

main()
  .then((code) => process.exit(code))
  .catch((err) => {
    console.error('\nFATAL:', err);
    process.exit(1);
  });
