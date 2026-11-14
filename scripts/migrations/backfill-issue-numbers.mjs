#!/usr/bin/env node
/**
 * Give every unnumbered issue (`bug_reports` doc) a sequential `number`.
 *
 * `POST /api/bug-report` mints `number` from `counters/bug_reports.next` inside a
 * transaction. Issues filed before that shipped have no number. This script numbers
 * them oldest first (`createdAt` asc) from the same counter, one transaction per
 * issue, so it never collides with an issue the route numbers mid-run.
 *
 * Each transaction re-reads the issue and skips it if it already holds a number, so
 * re-running is safe: a second run finds nothing to do. Each environment keeps its
 * own sequence.
 *
 * Running without --write performs a dry run and prints the numbers it would assign.
 *
 * Usage:
 *   node scripts/migrations/backfill-issue-numbers.mjs --env=dev
 *   node scripts/migrations/backfill-issue-numbers.mjs --env=dev --write --confirm-project=<dev project id>
 *   node scripts/migrations/backfill-issue-numbers.mjs --env=prod --write --confirm-project=owlette-prod-90a12
 *
 * Credentials: FIREBASE_{PROJECT_ID,CLIENT_EMAIL,PRIVATE_KEY}_{DEV|PROD}, falling
 * back to the unsuffixed vars, loaded from web/.env.local, .claude/.env.local or
 * scripts/.env.local. Verify the printed project id before a live run.
 *
 * Prints only doc ids and numbers, never descriptions or emails.
 */

import { createRequire } from 'module';
import { fileURLToPath } from 'url';
import { existsSync, readFileSync } from 'fs';
import { dirname, join } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..', '..');

// firebase-admin lives in web/node_modules. Modular entry points — the root
// namespace no longer exports .credential/.firestore.
const require = createRequire(join(ROOT, 'web', 'package.json'));
const { initializeApp, cert } = require('firebase-admin/app');
const { getFirestore } = require('firebase-admin/firestore');

const args = process.argv.slice(2);
function getFlag(name) {
  const hit = args.find((a) => a === `--${name}` || a.startsWith(`--${name}=`));
  if (!hit) return undefined;
  return hit.includes('=') ? hit.slice(hit.indexOf('=') + 1) : true;
}

const env = getFlag('env') === 'prod' ? 'prod' : 'dev';
const live = getFlag('write') === true;
const confirmProject = getFlag('confirm-project');

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
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
      v = v.slice(1, -1);
    }
    if (process.env[m[1]] === undefined) process.env[m[1]] = v;
  }
}

const SUF = env === 'prod' ? '_PROD' : '_DEV';
const projectId = process.env[`FIREBASE_PROJECT_ID${SUF}`] || process.env.FIREBASE_PROJECT_ID;
const clientEmail = process.env[`FIREBASE_CLIENT_EMAIL${SUF}`] || process.env.FIREBASE_CLIENT_EMAIL;
const privateKey = (
  process.env[`FIREBASE_PRIVATE_KEY${SUF}`] || process.env.FIREBASE_PRIVATE_KEY || ''
).replace(/\\n/g, '\n');

if (!projectId || !clientEmail || !privateKey) {
  console.error(`❌ Missing Firebase credentials for env=${env} (need FIREBASE_*${SUF}).`);
  process.exit(1);
}

// a write needs both flags: --write alone never touches a project.
if (live && confirmProject !== projectId) {
  console.error(
    confirmProject
      ? `❌ --confirm-project=${confirmProject} does not match ${projectId}.`
      : `❌ --write needs --confirm-project=${projectId}.`,
  );
  process.exit(1);
}

initializeApp({ credential: cert({ projectId, clientEmail, privateKey }) });
const db = getFirestore();

const hasNumber = (data) => Number.isInteger(data?.number) && data.number > 0;

function counterValue(snap) {
  const next = snap.exists ? snap.get('next') : 0;
  if (next === undefined) return 0;
  if (!Number.isInteger(next) || next < 0) {
    throw new Error(`counters/bug_reports.next is ${JSON.stringify(next)}, not a non-negative integer`);
  }
  return next;
}

async function main() {
  console.log(`\n[${live ? 'WRITE' : 'DRY RUN'}] Issue number backfill — env=${env}, project=${projectId}\n`);

  const counterRef = db.collection('counters').doc('bug_reports');
  // firestore cannot query a missing field, so read everything and filter here.
  const all = await db.collection('bug_reports').orderBy('createdAt', 'asc').get();
  const pending = all.docs.filter((d) => !hasNumber(d.data()));
  const startAt = counterValue(await counterRef.get());

  console.log(`issues scanned     : ${all.size}`);
  console.log(`already numbered   : ${all.size - pending.length}`);
  console.log(`to number          : ${pending.length}`);
  console.log(`counter next       : ${startAt}\n`);

  if (!live) {
    pending.forEach((d, i) => console.log(`  ${d.id} → #${startAt + i + 1}`));
    console.log('\n[DRY RUN] no writes performed. Re-run with --write --confirm-project=<id>.\n');
    return;
  }

  let assigned = 0;
  for (const d of pending) {
    const number = await db.runTransaction(async (tx) => {
      const [issue, counter] = await Promise.all([tx.get(d.ref), tx.get(counterRef)]);
      if (!issue.exists || hasNumber(issue.data())) return null;
      const next = counterValue(counter) + 1;
      tx.set(counterRef, { next }, { merge: true });
      tx.update(d.ref, { number: next });
      return next;
    });
    if (number === null) {
      console.log(`  ${d.id} — skipped, numbered or deleted meanwhile`);
      continue;
    }
    assigned += 1;
    console.log(`  ${d.id} → #${number}`);
  }
  console.log(`\n✅ numbered ${assigned} issue(s).\n`);
}

main().then(
  () => process.exit(0),
  (err) => {
    console.error('❌ backfill failed:', err);
    process.exit(1);
  },
);
