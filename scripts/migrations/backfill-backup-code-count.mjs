#!/usr/bin/env node
/**
 * Count every account's unused backup codes into `users/{uid}.mfaFactors.backupCodes`,
 * so a second-factor screen offers a backup code only when the account has one left.
 *
 * The app writes the count with every sheet it issues, spends or wipes, and heals a record
 * on its next code try or factor change (web/lib/mfaFactors.server.ts). Until then a record
 * with no count reads as unknown and is offered a code: this backfill settles the rest at
 * once. It writes only `mfaFactors.backupCodes`, the length of `backupCodes` (none is zero),
 * for active accounts whose count is missing or wrong, each in its own transaction that
 * re-reads the sheet, so a code spent since the scan is counted as it is at the write.
 *
 * Usage:
 *   node scripts/migrations/backfill-backup-code-count.mjs --project owlette-dev-3838a
 *   node scripts/migrations/backfill-backup-code-count.mjs --project owlette-dev-3838a --apply
 *   node scripts/migrations/backfill-backup-code-count.mjs --project owlette-prod-90a12 --apply \
 *        --confirm-project=owlette-prod-90a12
 *
 * DRY RUN IS THE DEFAULT: it lists, by uid, each account it would count and the count it
 * would set, and writes nothing. Undoing an apply run is
 * not needed: the count it writes is what the app writes itself.
 *
 * Credentials: FIREBASE_{PROJECT_ID,CLIENT_EMAIL,PRIVATE_KEY}_{DEV|PROD}, falling back to the
 * unsuffixed vars, loaded from web/.env.local, .claude/.env.local or scripts/.env.local. The
 * resolved project must be the one --project names.
 */

import { createRequire } from 'module';
import { fileURLToPath, pathToFileURL } from 'url';
import { existsSync, readFileSync } from 'fs';
import { dirname, join } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..', '..');

// firebase-admin lives in web/node_modules; modular entry points only. loaded in
// main, so the tests, which run without web's install, can import the rest.
const require = createRequire(join(ROOT, 'web', 'package.json'));

/** --project allowlist → credential suffix; prod also needs --confirm-project to write. */
const PROJECTS = new Map([
  ['owlette-dev-3838a', '_DEV'],
  ['owlette-prod-90a12', '_PROD'],
]);
const PROTECTED = new Set(['owlette-prod-90a12']);

const SCAN_PAGE_SIZE = 500;

/** How many unused codes the record holds: the length of its sheet, none being zero. */
export function sheetCount(data) {
  return Array.isArray(data?.backupCodes) ? data.backupCodes.length : 0;
}

/** Why an account is left alone, or null when its count is missing or wrong. */
export function skipReason(data) {
  if (typeof data?.deletedAt === 'number') return 'deleted';
  return data?.mfaFactors?.backupCodes === sheetCount(data) ? 'counted' : null;
}

/** Every account whose count needs writing, and how many were left alone and why. */
export async function planBackfillBackupCodeCount(db) {
  const toCount = [];
  const skipped = { counted: 0, deleted: 0 };
  let scanned = 0;
  let cursor = null;
  for (;;) {
    let query = db
      .collection('users')
      .select('mfaFactors', 'backupCodes', 'deletedAt')
      // the document id, as FieldPath.documentId() names it
      .orderBy('__name__')
      .limit(SCAN_PAGE_SIZE);
    if (cursor) query = query.startAfter(cursor);
    const page = await query.get();
    for (const doc of page.docs) {
      scanned += 1;
      const data = doc.data() ?? {};
      const reason = skipReason(data);
      if (reason) skipped[reason] += 1;
      else toCount.push({ uid: doc.id, count: sheetCount(data) });
    }
    if (page.size < SCAN_PAGE_SIZE) break;
    cursor = page.docs[page.docs.length - 1];
  }
  return { scanned, toCount, skipped };
}

/** Lists the accounts; with `apply`, counts each one in its own transaction. */
export async function runBackfillBackupCodeCount({ db, apply, log = console.log }) {
  const plan = await planBackfillBackupCodeCount(db);
  log(`scanned ${plan.scanned} user document(s)`);
  log(`  left alone: ${plan.skipped.counted} already counted, ${plan.skipped.deleted} deleted`);
  log(`  ${apply ? 'setting' : 'would set'} mfaFactors.backupCodes on ${plan.toCount.length} account(s):`);
  for (const { uid, count } of plan.toCount) log(`    users/${uid}  mfaFactors.backupCodes → ${count}`);

  const counted = [];
  if (!apply) return { ...plan, counted };

  for (const { uid } of plan.toCount) {
    const ref = db.collection('users').doc(uid);
    const wrote = await db.runTransaction(async (tx) => {
      const snap = await tx.get(ref);
      if (!snap.exists || skipReason(snap.data())) return false;
      tx.update(ref, { 'mfaFactors.backupCodes': sheetCount(snap.data()) });
      return true;
    });
    if (wrote) counted.push(uid);
    else log(`    users/${uid}  skipped: changed since the scan`);
  }
  log(`counted the backup codes of ${counted.length} account(s)`);
  return { ...plan, counted };
}

function flag(args, name) {
  const i = args.findIndex((a) => a === `--${name}` || a.startsWith(`--${name}=`));
  if (i === -1) return undefined;
  const a = args[i];
  if (a.includes('=')) return a.slice(a.indexOf('=') + 1);
  const next = args[i + 1];
  return next !== undefined && !next.startsWith('--') ? next : true;
}

function loadEnvFiles() {
  for (const f of [
    join(ROOT, 'web', '.env.local'),
    join(ROOT, '.claude', '.env.local'),
    join(ROOT, 'scripts', '.env.local'),
  ]) {
    if (!existsSync(f)) continue;
    for (const line of readFileSync(f, 'utf8').split(/\r?\n/)) {
      const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)$/);
      if (!m) continue;
      let v = m[2].trim();
      if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
      if (process.env[m[1]] === undefined) process.env[m[1]] = v;
    }
  }
}

async function main() {
  const args = process.argv.slice(2);
  const known = new Set(['project', 'apply', 'confirm-project']);
  const unknown = args.find((a) => a.startsWith('--') && !known.has(a.slice(2).split('=')[0]));
  if (unknown) {
    console.error(`❌ unknown argument: ${unknown}`);
    process.exit(2);
  }

  const project = flag(args, 'project');
  if (typeof project !== 'string' || !PROJECTS.has(project)) {
    console.error(`❌ --project must be one of: ${[...PROJECTS.keys()].join(', ')}`);
    process.exit(2);
  }
  const apply = flag(args, 'apply') === true;
  if (apply && PROTECTED.has(project) && flag(args, 'confirm-project') !== project) {
    console.error(`❌ --apply on ${project} needs --confirm-project=${project}.`);
    process.exit(2);
  }

  loadEnvFiles();
  const suffix = PROJECTS.get(project);
  const projectId = process.env[`FIREBASE_PROJECT_ID${suffix}`] || process.env.FIREBASE_PROJECT_ID;
  const clientEmail = process.env[`FIREBASE_CLIENT_EMAIL${suffix}`] || process.env.FIREBASE_CLIENT_EMAIL;
  const privateKey = (
    process.env[`FIREBASE_PRIVATE_KEY${suffix}`] || process.env.FIREBASE_PRIVATE_KEY || ''
  ).replace(/\\n/g, '\n');
  if (!projectId || !clientEmail || !privateKey) {
    console.error(`❌ missing Firebase credentials for ${project} (FIREBASE_*${suffix}).`);
    process.exit(1);
  }
  if (projectId !== project) {
    console.error(`❌ --project ${project}, but the credentials resolve to ${projectId}.`);
    process.exit(1);
  }

  const { initializeApp, cert } = require('firebase-admin/app');
  const { getFirestore } = require('firebase-admin/firestore');
  initializeApp({ credential: cert({ projectId, clientEmail, privateKey }), projectId });
  console.log(`\n[${apply ? 'APPLY' : 'DRY RUN'}] count backup codes — project=${projectId}\n`);
  await runBackfillBackupCodeCount({ db: getFirestore(), apply });
  if (!apply) console.log('\n[DRY RUN] no writes performed. re-run with --apply to write.\n');
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    console.error('\n❌ failed:', err);
    process.exit(1);
  });
}
