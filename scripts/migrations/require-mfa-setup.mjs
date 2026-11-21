#!/usr/bin/env node
/**
 * Require a second factor of every active account that holds none: sets
 * `users/{uid}.requiresMfaSetup: true`. Such an account is sent to /setup-2fa, and its
 * session and id-token API calls are refused until it enrols (web/lib/apiAuth.server.ts).
 * Its API keys keep working.
 *
 * "Holds a factor" reads the way web/lib/mfaFactors.server.ts reads it: a well-formed
 * `mfaFactors` is trusted, anything else falls back to legacy `mfaEnrolled` for totp and
 * counts the passkeys subcollection, so a legacy passkey account is never sent to set up
 * what it already has. Each write re-reads the account in a transaction and skips it if it
 * enrolled, was flagged or was deleted since the scan.
 *
 * Usage:
 *   node scripts/migrations/require-mfa-setup.mjs --project owlette-dev-3838a
 *   node scripts/migrations/require-mfa-setup.mjs --project owlette-dev-3838a --apply
 *   node scripts/migrations/require-mfa-setup.mjs --project owlette-prod-90a12 --apply \
 *        --confirm-project=owlette-prod-90a12
 *
 * DRY RUN IS THE DEFAULT: it lists the accounts and writes nothing. To undo an apply run,
 * set `requiresMfaSetup: false` on the uids it printed.
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

const isValidCount = (n) => Number.isInteger(n) && n >= 0;

/** True when the stored inventory can be trusted without counting passkeys. */
export function hasTrustedInventory(data) {
  const f = data?.mfaFactors;
  return !!f && typeof f === 'object' && typeof f.totp === 'boolean' && isValidCount(f.passkeys);
}

/** Mirror of `normalizeMfaFactors` + `deriveMfaEnrolled` in web/lib/mfaFactors.server.ts. */
export function holdsFactor(data, passkeyCount) {
  const f = data?.mfaFactors && typeof data.mfaFactors === 'object' ? data.mfaFactors : {};
  const totp = typeof f.totp === 'boolean' ? f.totp : data?.mfaEnrolled === true;
  const passkeys = isValidCount(f.passkeys) ? f.passkeys : passkeyCount;
  return totp || passkeys > 0;
}

/** Why an account is left alone, or null when it has to set up a factor. */
export function skipReason(data, passkeyCount) {
  if (typeof data?.deletedAt === 'number') return 'deleted';
  if (data?.requiresMfaSetup === true) return 'already-required';
  if (holdsFactor(data, passkeyCount)) return 'has-factor';
  return null;
}

async function countPasskeys(db, uid) {
  const snap = await db.collection('users').doc(uid).collection('passkeys').count().get();
  return snap.data().count;
}

/** Every account that has to set up a factor, and how many were left alone and why. */
export async function planRequireMfaSetup(db) {
  const toRequire = [];
  const skipped = { deleted: 0, 'already-required': 0, 'has-factor': 0 };
  let scanned = 0;
  let cursor = null;
  for (;;) {
    let query = db
      .collection('users')
      .select('email', 'mfaEnrolled', 'mfaFactors', 'requiresMfaSetup', 'deletedAt')
      // the document id, as FieldPath.documentId() names it
      .orderBy('__name__')
      .limit(SCAN_PAGE_SIZE);
    if (cursor) query = query.startAfter(cursor);
    const page = await query.get();
    for (const doc of page.docs) {
      scanned += 1;
      const data = doc.data() ?? {};
      const passkeyCount = hasTrustedInventory(data) ? 0 : await countPasskeys(db, doc.id);
      const reason = skipReason(data, passkeyCount);
      if (reason) {
        skipped[reason] += 1;
      } else {
        toRequire.push({ uid: doc.id, email: typeof data.email === 'string' ? data.email : null, passkeyCount });
      }
    }
    if (page.size < SCAN_PAGE_SIZE) break;
    cursor = page.docs[page.docs.length - 1];
  }
  return { scanned, toRequire, skipped };
}

/** Lists the accounts; with `apply`, flags each one in its own transaction. */
export async function runRequireMfaSetup({ db, apply, log = console.log }) {
  const plan = await planRequireMfaSetup(db);
  log(`scanned ${plan.scanned} user document(s)`);
  log(`  left alone: ${plan.skipped['has-factor']} hold a factor, ` +
    `${plan.skipped['already-required']} already required, ${plan.skipped.deleted} deleted`);
  log(`  to require a second factor: ${plan.toRequire.length}`);
  for (const { uid, email } of plan.toRequire) log(`    users/${uid}  ${email ?? '(no email)'}`);

  const required = [];
  if (!apply) return { ...plan, required };

  for (const { uid, passkeyCount } of plan.toRequire) {
    const ref = db.collection('users').doc(uid);
    const wrote = await db.runTransaction(async (tx) => {
      const snap = await tx.get(ref);
      if (!snap.exists || skipReason(snap.data(), passkeyCount)) return false;
      tx.update(ref, { requiresMfaSetup: true });
      return true;
    });
    if (wrote) required.push(uid);
    else log(`    users/${uid}  skipped: changed since the scan`);
  }
  log(`required a second factor of ${required.length} account(s)`);
  return { ...plan, required };
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
  console.log(`\n[${apply ? 'APPLY' : 'DRY RUN'}] require a second factor — project=${projectId}\n`);
  await runRequireMfaSetup({ db: getFirestore(), apply });
  if (!apply) console.log('\n[DRY RUN] no writes performed. re-run with --apply to write.\n');
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    console.error('\n❌ failed:', err);
    process.exit(1);
  });
}
