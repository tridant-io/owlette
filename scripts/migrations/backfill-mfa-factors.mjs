#!/usr/bin/env node
/**
 * mfaFactors Inventory Backfill — installs the denormalized second-factor inventory:
 *
 *   users/{uid}.mfaFactors  = { totp: boolean, passkeys: number }
 *   users/{uid}.mfaEnrolled = mfaFactors.totp || mfaFactors.passkeys > 0
 *
 * Legacy `mfaEnrolled` only ever meant "has TOTP", so it IS the `totp` leg; the `passkeys` leg is
 * recovered by counting `users/{uid}/passkeys`. Without this, pre-existing passkey users never get
 * their passkey counted as a second factor.
 *
 *   --mode=inventory-only  DEFAULT. Writes `mfaFactors` only — cannot change who is challenged.
 *   --mode=full            Also derives `mfaEnrolled`. ONLY after the /verify-2fa passkey challenge
 *                          ships to the target env; earlier = "MFA required" with nothing to
 *                          present, i.e. lockout.
 *
 * `--mode=full` is promote-only and recovery-gated:
 *   - Never demotes. stored true + derived false is an anomaly to report, not a downgrade.
 *   - Skips any promotion where `backupCodes` is empty (no recovery path = one lost device from a
 *     dead account). Skipped uids land in the log with a reason.
 *   - Clears `requiresMfaSetup` on promote — leaving the nag set bounces the user to /setup-2fa
 *     forever (web/app/dashboard/page.tsx:836-841). Never SETS it; that belongs to
 *     web/lib/mfaFactors.server.ts, not a bulk migration.
 *
 * Usage:
 *   node scripts/migrations/backfill-mfa-factors.mjs --project owlette-dev-3838a
 *   node scripts/migrations/backfill-mfa-factors.mjs --project owlette-dev-3838a --commit
 *   node scripts/migrations/backfill-mfa-factors.mjs --project owlette-prod-90a12 --mode=full --commit \
 *        --confirm-project=owlette-prod-90a12
 *
 * DRY RUN IS THE DEFAULT — nothing is written without `--commit`.
 *
 * Every run logs to `scripts/migrations/backfill-mfa-factors.<projectId>.log.json`: per-outcome counts,
 * skipped uids with reasons, and the pre-image of every field changed. These are scalar
 * overwrites, so that pre-image is the only route to a manual reversal.
 *
 * Credentials: FIREBASE_{PROJECT_ID,CLIENT_EMAIL,PRIVATE_KEY}_{DEV|PROD}, falling back to the
 * unsuffixed web/.env.local vars. dev and prod are SEPARATE Firebase projects and this script is
 * handed the exact project id, so a resolved project ≠ --project is a hard error.
 * web/.env.local, .claude/.env.local and scripts/.env.local are auto-loaded if present.
 *
 * No Firestore rule change required — see the `rulesReview` block below, embedded in every log.
 */

import { createRequire } from 'module';
import { fileURLToPath } from 'url';
import { readFileSync, writeFileSync, existsSync, renameSync } from 'fs';
import { dirname, join } from 'path';
import readline from 'readline';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..', '..');

// firebase-admin lives in web/node_modules — no root-level dependency on it.
const require = createRequire(join(ROOT, 'web', 'package.json'));
// See the note in backfill-site-owner-membership.mjs: the root `firebase-admin`
// namespace no longer carries .credential/.firestore in the installed version.
const { initializeApp, cert } = require('firebase-admin/app');
const { getFirestore, FieldPath } = require('firebase-admin/firestore');

const args = process.argv.slice(2);

/** Flags that take a value, as `--flag=value` or `--flag value`. */
const VALUE_FLAGS = new Set(['project', 'mode', 'log-file', 'confirm-project']);
/** Flags that take no value (a bare `--flag`, or an explicit true/false). */
const BOOLEAN_FLAGS = new Set(['commit', 'dry-run']);

/**
 * Parse argv, rejecting anything unrecognised: a typo like `--comit` must not parse as "flag not
 * requested" and fall through to the other branch — for `--commit` that branch writes.
 */
function parseArgs() {
  const parsed = new Map();
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (!arg.startsWith('--')) {
      console.error(`❌ unexpected argument: ${arg}`);
      usage();
      process.exit(2);
    }
    const eq = arg.indexOf('=');
    const name = (eq === -1 ? arg.slice(2) : arg.slice(2, eq)).trim();
    const inlineValue = eq === -1 ? undefined : arg.slice(eq + 1);

    if (VALUE_FLAGS.has(name)) {
      let value = inlineValue;
      if (value === undefined) {
        // Space-separated form: `--mode --commit` must not swallow `--commit`.
        const next = args[i + 1];
        if (next !== undefined && !next.startsWith('--')) {
          value = next;
          i++;
        }
      }
      if (value === undefined || value === '') {
        console.error(`❌ --${name} requires a value (--${name}=<value> or --${name} <value>).`);
        usage();
        process.exit(2);
      }
      parsed.set(name, value);
      continue;
    }

    if (BOOLEAN_FLAGS.has(name)) {
      // A bare `=== true` check would treat the natural `--commit=true` as OFF.
      if (inlineValue === undefined || inlineValue === 'true' || inlineValue === '1') {
        parsed.set(name, true);
      } else if (inlineValue === 'false' || inlineValue === '0') {
        parsed.set(name, false);
      } else {
        console.error(`❌ --${name} expects no value or true/false, got: ${inlineValue}`);
        process.exit(2);
      }
      continue;
    }

    console.error(`❌ unknown argument: ${arg}`);
    usage();
    process.exit(2);
  }
  return parsed;
}

function usage() {
  console.error(
    '\nUsage: node scripts/migrations/backfill-mfa-factors.mjs --project <projectId> [--mode=inventory-only|full] [--commit]\n' +
      `       projects: ${[...PROJECT_ENVS.keys()].join(', ')}\n` +
      '       --mode      inventory-only (default) writes mfaFactors only;\n' +
      '                   full also derives mfaEnrolled (lockout risk — read the header).\n' +
      '       --commit    perform the writes. Without it this is a DRY RUN.\n' +
      '       --dry-run   explicit no-op affirmation of the default; refuses to combine with --commit.\n' +
      '       --log-file  override the log path (default scripts/migrations/backfill-mfa-factors.<projectId>.log.json)\n' +
      '       --confirm-project=<projectId>  non-interactive confirmation for protected projects\n'
  );
}

/**
 * Targetable project ids → credential suffix. An allowlist, not a free-form string: a mistyped id
 * must fail loudly, not authenticate somewhere unexpected via the unsuffixed fallback creds.
 */
const PROJECT_ENVS = new Map([
  ['owlette-dev-3838a', 'dev'],
  ['owlette-prod-90a12', 'prod'],
]);

/** Modes, and whether the mode is permitted to touch `mfaEnrolled`. */
const MODES = new Set(['inventory-only', 'full']);

const flags = parseArgs();

const requestedProject = flags.get('project');
if (!requestedProject) {
  console.error('❌ --project is required.');
  usage();
  process.exit(1);
}
if (!PROJECT_ENVS.has(requestedProject)) {
  console.error(`❌ unknown project: ${requestedProject}`);
  console.error(`   known projects: ${[...PROJECT_ENVS.keys()].join(', ')}`);
  process.exit(1);
}
const env = PROJECT_ENVS.get(requestedProject);

// Absent --mode = safe default; present-but-unrecognised is rejected rather than silently
// defaulted, so `--mode=Full` can't produce a run the operator did not ask for.
const mode = flags.has('mode') ? flags.get('mode') : 'inventory-only';
if (!MODES.has(mode)) {
  console.error(`❌ unknown --mode: ${mode}`);
  console.error(`   valid modes: ${[...MODES].join(', ')}`);
  process.exit(2);
}

const commit = flags.get('commit') === true;
const explicitDryRun = flags.get('dry-run') === true;
if (commit && explicitDryRun) {
  console.error('❌ --commit and --dry-run are mutually exclusive.');
  process.exit(2);
}
const dryRun = !commit;

const logFileArg = flags.get('log-file');
const confirmProject = flags.get('confirm-project');

function loadEnvFile(path) {
  if (!existsSync(path)) return;
  const content = readFileSync(path, 'utf8');
  for (const rawLine of content.split('\n')) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (!process.env[key]) process.env[key] = value;
  }
}

loadEnvFile(join(ROOT, 'web', '.env.local'));
loadEnvFile(join(ROOT, '.claude', '.env.local'));
loadEnvFile(join(ROOT, 'scripts', '.env.local'));

const suffix = env === 'prod' ? '_PROD' : '_DEV';
const projectId =
  process.env[`FIREBASE_PROJECT_ID${suffix}`] || process.env.FIREBASE_PROJECT_ID;
const clientEmail =
  process.env[`FIREBASE_CLIENT_EMAIL${suffix}`] || process.env.FIREBASE_CLIENT_EMAIL;
const rawPrivateKey =
  process.env[`FIREBASE_PRIVATE_KEY${suffix}`] || process.env.FIREBASE_PRIVATE_KEY;

if (!projectId || !clientEmail || !rawPrivateKey) {
  console.error(`❌ missing Firebase credentials for ${requestedProject} (env=${env}).`);
  console.error(`   set FIREBASE_PROJECT_ID${suffix}, FIREBASE_CLIENT_EMAIL${suffix},`);
  console.error(`   and FIREBASE_PRIVATE_KEY${suffix} (or the unsuffixed equivalents).`);
  process.exit(1);
}

// The caller named the project explicitly, so resolved-creds ≠ --project is a hard error (the
// env-flag scripts can only warn).
if (projectId !== requestedProject) {
  console.error(
    `❌ credential mismatch: --project ${requestedProject} but the resolved credentials ` +
      `point at ${projectId}.`
  );
  console.error(
    `   set FIREBASE_PROJECT_ID${suffix}/FIREBASE_CLIENT_EMAIL${suffix}/FIREBASE_PRIVATE_KEY${suffix}` +
      ' for the intended project, or run against the project those credentials belong to.'
  );
  process.exit(1);
}

const privateKey = rawPrivateKey.replace(/\\n/g, '\n');

/** Firestore caps a write batch at 500 operations. */
const BATCH_LIMIT = 400;

/** Page size for the users scan, so a large collection is never held twice. */
const SCAN_PAGE_SIZE = 500;

/** How many passkey subcollection counts to run at once. */
const COUNT_CONCURRENCY = 25;

/** Projects needing typed confirmation — gated on the RESOLVED project, not the --project flag. */
const PROTECTED_PROJECT_IDS = new Set(['owlette-prod-90a12']);

/** Rules review embedded in every log so it travels with the run. Checked against 07243fe. */
const rulesReview = {
  ruleChangeRequired: false,
  checked: [
    'firestore.rules:612-666 — match /users/{userId}: client read is self-or-superadmin; ' +
      'self-update is an allowlist (preferences, displayName, photoURL, timezone, lastSiteId, ' +
      'lastMachineIds) that excludes every MFA field; `allow write: if isServiceAccount()` is ' +
      'what permits this script (Admin SDK) to write mfaFactors/mfaEnrolled.',
    'firestore.rules:629-641 — allow create pins mfaEnrolled==false, requiresMfaSetup==true and ' +
      'passkeyEnrolled==false on self-bootstrap, using the absent-OR-equals pattern.',
    'firestore.rules — no match block exists for users/{userId}/passkeys/{credentialId}; the ' +
      'catch-all `match /{document=**} { allow read, write: if false; }` therefore denies all ' +
      'client access to it. Passkeys are Admin-SDK-only, which is why this script counts them ' +
      'server-side and no rule is needed to read them.',
  ],
  notes: [
    'mfaFactors is server-written only: the self-update allowlist does not include it, so no ' +
      'client can create or modify it after the user doc exists. The Admin SDK bypasses rules ' +
      'entirely, so this backfill needs no rule change to run.',
    'HARDENING (low, not required for this backfill, reported rather than applied because ' +
      'firestore.rules is a guarded file): the `allow create` clause at :629-641 pins ' +
      'mfaEnrolled/requiresMfaSetup/passkeyEnrolled but says nothing about mfaFactors. A ' +
      'signed-in user whose doc does not yet exist could self-create it with ' +
      "mfaFactors: { totp: true, passkeys: 0 } while mfaEnrolled stays pinned false. That is " +
      'not an MFA bypass — the session gate reads mfaEnrolled, and the enrollment gate reading ' +
      'a planted factor fails closed (it demands a challenge) rather than open. The reachable ' +
      'consequence is that the next mfaFactors.server.ts write inherits the planted totp leg ' +
      'and derives mfaEnrolled: true / requiresMfaSetup: false for an account with no real ' +
      'factor, i.e. an escape from mandatory-2FA nagging plus a self-inflicted lockout. ' +
      'Reachability is further narrowed by /api/users/bootstrap, which made user-doc creation ' +
      'server-mediated. Fix if desired: add ' +
      "`(!('mfaFactors' in request.resource.data) || request.resource.data.mfaFactors == " +
      "{'totp': false, 'passkeys': 0})` to the create clause.",
  ],
};

function promptYesNo(question) {
  return new Promise((resolve) => {
    // Non-interactive confirmation: the operator must name the exact project being written to.
    if (confirmProject !== undefined) {
      if (confirmProject === projectId) {
        console.log(`${question}y  (--confirm-project=${confirmProject})`);
        resolve(true);
      } else {
        console.error(
          `\n❌ --confirm-project=${confirmProject} does not match the resolved project ${projectId}.`
        );
        resolve(false);
      }
      return;
    }
    if (!process.stdin.isTTY) {
      // readline's callback never fires on non-TTY stdin — it would hang, or exit 0 having done
      // nothing. Refuse explicitly.
      console.error(
        '\n❌ confirmation required but stdin is not a TTY.' +
          `\n   re-run interactively, or pass --confirm-project=${projectId}`
      );
      resolve(false);
      return;
    }
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    rl.question(question, (answer) => {
      rl.close();
      const normalized = answer.trim().toLowerCase();
      resolve(normalized === 'y' || normalized === 'yes');
    });
  });
}

/**
 * Hand-kept mirror of `normalizeMfaFactors` in web/lib/mfaFactors.server.ts (a .mjs script cannot
 * import the TS module): each leg falls back independently rather than discarding the whole map.
 *
 * - `totp` falls back to legacy `mfaEnrolled === true` — the only factor that ever set it.
 *   `mfaSecret` is NOT enrollment; an in-flight setup keeps its secret in mfa_pending/{uid}.
 * - `passkeys` is always the real subcollection count — a stored count is a cache, and this
 *   backfill exists to install the truth.
 */
function desiredInventory(userData, passkeyCount) {
  const stored = userData?.mfaFactors;
  const storedTotp =
    stored && typeof stored === 'object' && typeof stored.totp === 'boolean'
      ? stored.totp
      : undefined;
  return {
    totp: storedTotp !== undefined ? storedTotp : userData?.mfaEnrolled === true,
    passkeys: Math.max(0, Math.trunc(passkeyCount)),
  };
}

function deriveMfaEnrolled(inv) {
  return inv.totp || inv.passkeys > 0;
}

function factorsEqual(stored, desired) {
  return (
    !!stored &&
    typeof stored === 'object' &&
    stored.totp === desired.totp &&
    stored.passkeys === desired.passkeys
  );
}

/** Count a user's passkeys with an aggregation query — no document reads. */
async function countPasskeys(db, uid) {
  const snap = await db
    .collection('users')
    .doc(uid)
    .collection('passkeys')
    .count()
    .get();
  return snap.data().count;
}

/**
 * Pending change as logged. Email goes to the console but NOT the log file — these logs get
 * committed, and a committed migration log is no place for a list of user addresses.
 */
function forLog({ uid, update, before }) {
  return { uid, update, before };
}

/** Run `worker` over `items` with bounded concurrency, preserving order. */
async function mapWithConcurrency(items, limit, worker) {
  const results = new Array(items.length);
  let cursor = 0;
  const runners = new Array(Math.min(limit, items.length)).fill(null).map(async () => {
    while (cursor < items.length) {
      const index = cursor++;
      results[index] = await worker(items[index], index);
    }
  });
  await Promise.all(runners);
  return results;
}

/**
 * Page through `users/*`, projecting only the fields read — keeps the scan cheap and guarantees
 * the script never pulls a secret it has no business holding (notably mfaSecret).
 */
async function scanUsers(db) {
  const users = [];
  let cursor = null;
  for (;;) {
    let query = db
      .collection('users')
      .select('email', 'mfaEnrolled', 'mfaFactors', 'backupCodes', 'deletedAt')
      .orderBy(FieldPath.documentId())
      .limit(SCAN_PAGE_SIZE);
    if (cursor) query = query.startAfter(cursor);
    const snap = await query.get();
    if (snap.empty) break;
    for (const doc of snap.docs) users.push({ uid: doc.id, data: doc.data() ?? {} });
    if (snap.size < SCAN_PAGE_SIZE) break;
    cursor = snap.docs[snap.docs.length - 1];
  }
  return users;
}

async function main() {
  console.log(
    `\n${dryRun ? '[DRY RUN] ' : ''}mfaFactors backfill — project=${projectId}, mode=${mode}\n`
  );
  if (mode === 'full') {
    console.log(
      '⚠️  --mode=full derives mfaEnrolled. Only run this once the /verify-2fa passkey\n' +
        '    challenge is live in this environment, or passkey-only users are locked out.\n'
    );
  }

  initializeApp({
    credential: cert({ projectId, clientEmail, privateKey }),
    projectId,
  });
  const db = getFirestore();

  const users = await scanUsers(db);
  console.log(`scanned ${users.length} user document(s)`);

  const counts = await mapWithConcurrency(users, COUNT_CONCURRENCY, async ({ uid }) => {
    try {
      return { count: await countPasskeys(db, uid) };
    } catch (err) {
      return { error: err instanceof Error ? err.message : String(err) };
    }
  });

  const toUpdate = [];
  const alreadyCorrect = [];
  const skipped = [];
  const errored = [];
  /** Users --mode=full WOULD promote, surfaced during inventory-only as a preview. */
  const promotionPreview = [];

  for (let i = 0; i < users.length; i++) {
    const { uid, data } = users[i];
    const counted = counts[i];
    if (counted.error !== undefined) {
      errored.push({ uid, stage: 'count-passkeys', error: counted.error });
      continue;
    }

    // The delete cascade tore these down deliberately; re-stamping MFA state partially undoes it.
    if (typeof data.deletedAt === 'number') {
      skipped.push({ uid, reason: 'soft-deleted' });
      continue;
    }

    const desired = desiredInventory(data, counted.count);
    const derived = deriveMfaEnrolled(desired);
    const storedEnrolled = data.mfaEnrolled === true;
    const hasBackupCodes = Array.isArray(data.backupCodes) && data.backupCodes.length > 0;

    const update = {};
    const before = {};
    if (!factorsEqual(data.mfaFactors, desired)) {
      update.mfaFactors = desired;
      before.mfaFactors = data.mfaFactors ?? null;
    }

    if (mode === 'full') {
      if (derived && !storedEnrolled) {
        if (!hasBackupCodes) {
          // Mandatory gate: promoting before any recovery path exists turns one lost device into
          // a lost account.
          skipped.push({
            uid,
            reason: 'no-backup-codes',
            detail: 'would flip mfaEnrolled to true but backupCodes is empty',
            factors: desired,
          });
          continue;
        }
        update.mfaEnrolled = true;
        // Clear the nag in the same write — see the header. Never set it.
        update.requiresMfaSetup = false;
        before.mfaEnrolled = data.mfaEnrolled ?? null;
        promotionPreview.push({ uid, factors: desired });
      } else if (!derived && storedEnrolled) {
        // Promote-only: claimed enrollment with an empty inventory is an anomaly for a human, not
        // something a bulk migration should quietly downgrade.
        skipped.push({
          uid,
          reason: 'would-demote',
          detail: 'mfaEnrolled is true but the inventory derives false — not demoting',
          factors: desired,
        });
        continue;
      }
    } else if (derived && !storedEnrolled) {
      // inventory-only never writes mfaEnrolled, but the operator needs the size of the full step.
      promotionPreview.push({ uid, factors: desired, hasBackupCodes });
    }

    if (Object.keys(update).length === 0) {
      alreadyCorrect.push({ uid });
      continue;
    }

    toUpdate.push({
      uid,
      email: typeof data.email === 'string' ? data.email : null,
      update,
      before,
    });
  }

  // ---- Blast radius, before any write ----
  console.log('\n--- blast radius ---');
  console.log(`  users scanned              : ${users.length}`);
  console.log(`  already correct            : ${alreadyCorrect.length}`);
  console.log(`  TO UPDATE                  : ${toUpdate.length}`);
  console.log(`  skipped                    : ${skipped.length}`);
  console.log(`  errored                    : ${errored.length}`);
  if (mode === 'inventory-only') {
    const withoutCodes = promotionPreview.filter((p) => !p.hasBackupCodes).length;
    console.log(`  --mode=full would promote  : ${promotionPreview.length}`);
    console.log(`    of those, no backup codes: ${withoutCodes}  (--mode=full would skip them)`);
  } else {
    console.log(`  mfaEnrolled promotions     : ${promotionPreview.length}`);
  }
  console.log('');

  if (toUpdate.length > 0) {
    console.log('users to update:');
    for (const { uid, email, update } of toUpdate) {
      const parts = [];
      if (update.mfaFactors) {
        parts.push(
          `mfaFactors={totp:${update.mfaFactors.totp},passkeys:${update.mfaFactors.passkeys}}`
        );
      }
      if (update.mfaEnrolled !== undefined) {
        parts.push(`mfaEnrolled=${update.mfaEnrolled}`, 'requiresMfaSetup=false');
      }
      console.log(`  users/${uid}  ${parts.join(' ')}   ${email ?? 'unknown'}`);
    }
    console.log('');
  }

  if (skipped.length > 0) {
    console.log('⚠️  skipped:');
    for (const { uid, reason, detail } of skipped) {
      console.log(`  users/${uid}  [${reason}]${detail ? ` ${detail}` : ''}`);
    }
    console.log('');
  }

  if (errored.length > 0) {
    console.log('❌ errored:');
    for (const { uid, stage, error } of errored) {
      console.log(`  users/${uid}  [${stage}] ${error}`);
    }
    console.log('');
  }

  console.log(`firestore rules review: ${rulesReview.ruleChangeRequired ? 'CHANGE REQUIRED' : 'no rule change required'} (details in the log)\n`);

  const logPath =
    logFileArg || join(ROOT, 'scripts', 'migrations', `backfill-mfa-factors.${projectId}.log.json`);
  const logDoc = {
    script: 'backfill-mfa-factors',
    projectId,
    env,
    mode,
    dryRun,
    startedAt: new Date().toISOString(),
    completedAt: null,
    counts: {
      scanned: users.length,
      toUpdate: toUpdate.length,
      updated: 0,
      alreadyCorrect: alreadyCorrect.length,
      skipped: skipped.length,
      errored: errored.length,
      promotions: promotionPreview.length,
    },
    planned: toUpdate.map(forLog),
    applied: [],
    skipped,
    errored,
    promotionPreview,
    rulesReview,
  };

  /**
   * Never clobber a live run's log: these are scalar overwrites, so the committed log holds the
   * only pre-image, and a later dry run on the same path would destroy it.
   */
  function writeLog() {
    // Read straight away rather than check first: an exists-check leaves a gap before the use.
    try {
      const existing = JSON.parse(readFileSync(logPath, 'utf8'));
      if (existing?.dryRun === false && Array.isArray(existing.applied) && existing.applied.length > 0) {
        // A custom --log-file need not end in `.log.json`; then the substitution is a no-op and
        // the rename would silently self-cancel.
        const substituted = logPath.replace(/\.log\.json$/, '.prev.log.json');
        const backup = substituted === logPath ? `${logPath}.prev` : substituted;
        renameSync(logPath, backup);
        console.log(`preserved previous committed log as ${backup}`);
      }
    } catch {
      // No log yet, or an unparseable one: the fresh log replaces it either way.
    }
    writeFileSync(logPath, JSON.stringify(logDoc, null, 2));
  }

  if (dryRun) {
    logDoc.completedAt = new Date().toISOString();
    writeLog();
    console.log(`log: ${logPath}`);
    console.log('[DRY RUN] no writes performed. re-run with --commit to apply.\n');
    return;
  }

  if (toUpdate.length === 0) {
    logDoc.completedAt = new Date().toISOString();
    writeLog();
    console.log(`log: ${logPath}`);
    console.log('✅ nothing to update.\n');
    return;
  }

  // Gate on the project we actually resolved, not on the flag.
  if (PROTECTED_PROJECT_IDS.has(projectId)) {
    const confirmed = await promptYesNo(
      `Write ${toUpdate.length} user document(s) in PRODUCTION (${projectId}), mode=${mode}` +
        `${mode === 'full' ? `, promoting ${promotionPreview.length} to mfaEnrolled: true` : ''}? [y/N] `
    );
    if (!confirmed) {
      console.log('aborted — no writes performed.\n');
      process.exit(3);
    }
  }

  // Write the log BEFORE committing — if the process dies mid-run it is the only record of intent
  // and pre-images. Entries move into `applied` as batches land.
  writeLog();
  console.log(`log: ${logPath}\n`);

  let written = 0;
  for (let i = 0; i < toUpdate.length; i += BATCH_LIMIT) {
    const chunk = toUpdate.slice(i, i + BATCH_LIMIT);
    const batch = db.batch();
    for (const { uid, update } of chunk) {
      // set-merge, matching how mfaFactors.server.ts writes the same fields.
      batch.set(db.collection('users').doc(uid), update, { merge: true });
    }
    await batch.commit();
    logDoc.applied.push(...chunk.map(forLog));
    logDoc.counts.updated = logDoc.applied.length;
    writeFileSync(logPath, JSON.stringify(logDoc, null, 2));
    written += chunk.length;
    console.log(`  committed ${written}/${toUpdate.length}`);
  }

  logDoc.completedAt = new Date().toISOString();
  writeFileSync(logPath, JSON.stringify(logDoc, null, 2));

  console.log(`\n✅ updated ${written} user document(s) in mode=${mode}.`);
  if (mode === 'inventory-only' && promotionPreview.length > 0) {
    console.log(
      `   ${promotionPreview.length} user(s) would gain mfaEnrolled under --mode=full — ` +
        'do not run it until the passkey challenge is live here.'
    );
  }
  console.log('');
}

main().catch((err) => {
  console.error('\n❌ backfill failed:', err);
  process.exit(1);
});
