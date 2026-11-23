#!/usr/bin/env node
/**
 * Low disk rule for sites that saved their alert rules before the default existed.
 *
 * A site that never saved `sites/{siteId}/settings/alerts.rules` gets the
 * default low disk rule from code (web/lib/defaultAlertRules.ts). A site that
 * saved a list earlier holds its own array, which the code reads as stored, so
 * it would never get one. Two repairs, both to saved lists only:
 *
 *   1. the old "Low Disk" preset was inverted (`disk_percent < 10` fires on an
 *      empty disk). An exact match of that preset becomes `disk_percent > 90`
 *      with the default's daily cooldown: at the preset's 60 minutes a full
 *      disk, which does not clear by itself, would email every hour.
 *      Any other disk rule with `<` or `<=` is reported and left alone.
 *   2. a list with no `disk_percent >` or `>=` rule, on or off, gets the
 *      default rule appended. A site with a disk rule of its own keeps it.
 *
 * Run it ONCE per environment, BEFORE the web app that shows the default rule
 * deploys there. Until then nobody can have deleted the default, so an empty
 * saved list only means the site removed its older rules. Run after the
 * deploy, or a second time, it would put the rule back for a site that
 * deleted it on purpose.
 *
 * Usage:
 *   node scripts/migrations/seed-default-low-disk-rule.mjs --env=dev --dry-run
 *   node scripts/migrations/seed-default-low-disk-rule.mjs --env=dev --confirm-project=<project id>
 *   node scripts/migrations/seed-default-low-disk-rule.mjs --env=dev --rollback --log-file=<path>
 *
 * Every live run writes a change log holding each site's list as it was, and
 * prints the `--rollback` command. A rollback restores a list only where it is
 * still exactly what this run wrote.
 *
 * Credentials: FIREBASE_{PROJECT_ID,CLIENT_EMAIL,PRIVATE_KEY}_{DEV|PROD}, falling
 * back to the unsuffixed vars. dev and prod are SEPARATE Firebase projects:
 * check the printed project id before a live run. web/.env.local,
 * .claude/.env.local and scripts/.env.local auto-load.
 */

import { createRequire } from 'module';
import { fileURLToPath } from 'url';
import { readFileSync, writeFileSync, existsSync } from 'fs';
import { dirname, join } from 'path';
import { isDeepStrictEqual } from 'util';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..', '..');

// firebase-admin lives in web/node_modules.
const require = createRequire(join(ROOT, 'web', 'package.json'));
const { initializeApp, cert } = require('firebase-admin/app');
const { getFirestore } = require('firebase-admin/firestore');

// web/lib/defaultAlertRules.ts as it is when this ships. a migration is a
// point in time, so it holds its own copy.
const DEFAULT_LOW_DISK_RULE = {
  id: 'default-low-disk',
  name: 'Low Disk',
  metric: 'disk_percent',
  operator: '>',
  value: 90,
  severity: 'warning',
  channels: ['email', 'webhook'],
  enabled: true,
  cooldownMinutes: 1440,
};

const args = process.argv.slice(2);

function getFlag(name) {
  const match = args.find((a) => a === `--${name}` || a.startsWith(`--${name}=`));
  if (!match) return undefined;
  const eq = match.indexOf('=');
  return eq === -1 ? true : match.slice(eq + 1);
}

function getBooleanFlag(name) {
  const raw = getFlag(name);
  if (raw === undefined) return false;
  if (raw === true || raw === 'true' || raw === '1') return true;
  if (raw === 'false' || raw === '0') return false;
  console.error(`❌ --${name} expects no value or true/false, got: ${raw}`);
  process.exit(2);
}

// a typo like `--dryrun` must not read as "no dry run asked for".
const KNOWN_FLAGS = new Set(['env', 'dry-run', 'rollback', 'log-file', 'confirm-project']);
for (const arg of args) {
  const name = arg.replace(/^--/, '').split('=')[0];
  if (!arg.startsWith('--') || !KNOWN_FLAGS.has(name)) {
    console.error(`❌ unknown argument: ${arg}`);
    process.exit(2);
  }
}

const dryRun = getBooleanFlag('dry-run');
const rollback = getBooleanFlag('rollback');
const env = getFlag('env');
const logFileArg = getFlag('log-file');
const confirmProject = getFlag('confirm-project');

if (env !== 'dev' && env !== 'prod') {
  console.error('Usage: node scripts/migrations/seed-default-low-disk-rule.mjs --env=dev|prod [--dry-run]');
  process.exit(1);
}
if (rollback && (dryRun || !logFileArg)) {
  console.error('❌ --rollback needs --log-file=<path> and no --dry-run.');
  process.exit(2);
}

function loadEnvFile(path) {
  if (!existsSync(path)) return;
  for (const rawLine of readFileSync(path, 'utf8').split('\n')) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    if (!process.env[key]) process.env[key] = value;
  }
}

loadEnvFile(join(ROOT, 'web', '.env.local'));
loadEnvFile(join(ROOT, '.claude', '.env.local'));
loadEnvFile(join(ROOT, 'scripts', '.env.local'));

const suffix = env === 'prod' ? '_PROD' : '_DEV';
const projectId = process.env[`FIREBASE_PROJECT_ID${suffix}`] || process.env.FIREBASE_PROJECT_ID;
const clientEmail = process.env[`FIREBASE_CLIENT_EMAIL${suffix}`] || process.env.FIREBASE_CLIENT_EMAIL;
const rawPrivateKey = process.env[`FIREBASE_PRIVATE_KEY${suffix}`] || process.env.FIREBASE_PRIVATE_KEY;

if (!projectId || !clientEmail || !rawPrivateKey) {
  console.error(`❌ Missing Firebase credentials for env=${env} (FIREBASE_*${suffix} or the unsuffixed vars).`);
  process.exit(1);
}
if (!process.env[`FIREBASE_PROJECT_ID${suffix}`]) {
  console.warn(`⚠️  No FIREBASE_PROJECT_ID${suffix} set: using FIREBASE_PROJECT_ID (${projectId}). Check it is the ${env} project.\n`);
}

/** every live write names the project it lands in: nothing here is confirmed from a prompt. */
function requireConfirmedProject() {
  if (confirmProject === projectId) return;
  console.error(`❌ a live run needs --confirm-project=${projectId}`);
  process.exit(3);
}

const isDiskRule = (rule) => rule && typeof rule === 'object' && rule.metric === 'disk_percent';
const firesWhenFull = (rule) => rule.operator === '>' || rule.operator === '>=';
const isInvertedPreset = (rule) =>
  isDiskRule(rule) && rule.name === 'Low Disk' && rule.operator === '<' && rule.value === 10;

/** what this migration would make of one saved list, and why. */
function plan(rules) {
  let repaired = 0;
  const next = rules.map((rule) => {
    if (!isInvertedPreset(rule)) return rule;
    repaired += 1;
    return {
      ...rule,
      operator: DEFAULT_LOW_DISK_RULE.operator,
      value: DEFAULT_LOW_DISK_RULE.value,
      cooldownMinutes: DEFAULT_LOW_DISK_RULE.cooldownMinutes,
    };
  });
  const leftInverted = next.filter((rule) => isDiskRule(rule) && !firesWhenFull(rule));
  const seeded = !next.some((rule) => isDiskRule(rule) && firesWhenFull(rule))
    && !next.some((rule) => rule && rule.id === DEFAULT_LOW_DISK_RULE.id);
  if (seeded) next.push({ ...DEFAULT_LOW_DISK_RULE, channels: [...DEFAULT_LOW_DISK_RULE.channels] });
  return { next, repaired, seeded, leftInverted };
}

async function runRollback(db) {
  const log = JSON.parse(readFileSync(logFileArg, 'utf8'));
  if (log.projectId !== projectId) {
    console.error(`❌ log was written against ${log.projectId}, this run targets ${projectId}.`);
    process.exit(2);
  }
  requireConfirmedProject();
  let restored = 0;
  for (const { siteId, before, after } of log.applied) {
    const ref = db.doc(`sites/${siteId}/settings/alerts`);
    const put = await db.runTransaction(async (tx) => {
      const current = (await tx.get(ref)).data()?.rules;
      if (!isDeepStrictEqual(current, after)) return false;
      tx.set(ref, { rules: before }, { merge: true });
      return true;
    });
    if (!put) {
      console.log(`  skip ${siteId}: its list has changed since the run`);
      continue;
    }
    restored += 1;
    console.log(`  restored ${siteId}`);
  }
  console.log(`\n✅ restored ${restored}/${log.applied.length} list(s).\n`);
}

async function main() {
  console.log(`\n${dryRun ? '[DRY RUN] ' : ''}default low disk rule seed: env=${env}, project=${projectId}\n`);
  initializeApp({ credential: cert({ projectId, clientEmail, privateKey: rawPrivateKey.replace(/\\n/g, '\n') }), projectId });
  const db = getFirestore();

  if (rollback) {
    await runRollback(db);
    return;
  }

  const sites = await db.collection('sites').get();
  const changes = [];
  let unsaved = 0;
  let untouched = 0;
  for (const site of sites.docs) {
    const rules = (await db.doc(`sites/${site.id}/settings/alerts`).get()).data()?.rules;
    if (!Array.isArray(rules)) {
      unsaved += 1;
      continue;
    }
    const { next, repaired, seeded, leftInverted } = plan(rules);
    for (const rule of leftInverted) {
      console.log(`  note ${site.id}: "${rule.name}" is disk_percent ${rule.operator} ${rule.value}, left as saved`);
    }
    if (!repaired && !seeded) {
      untouched += 1;
      continue;
    }
    changes.push({ siteId: site.id, before: rules, after: next });
    console.log(`  ${site.id}: ${[repaired && `repair ${repaired} inverted preset(s)`, seeded && 'add the default rule'].filter(Boolean).join(', ')}`);
  }

  console.log('\n--- blast radius ---');
  console.log(`  sites scanned                    : ${sites.size}`);
  console.log(`  never saved a list (code default): ${unsaved}`);
  console.log(`  saved list, nothing to do        : ${untouched}`);
  console.log(`  saved list, to change            : ${changes.length}\n`);

  if (dryRun || changes.length === 0) {
    console.log(dryRun ? 'dry run: no writes performed.\n' : 'nothing to change.\n');
    return;
  }
  requireConfirmedProject();

  const logPath = join(__dirname, `seed-default-low-disk-rule.${projectId}.${Date.now()}.log.json`);
  const log = { projectId, startedAt: new Date().toISOString(), planned: changes.map((change) => change.siteId), applied: [] };
  // written before the first write and again after each one, so a run cut
  // short can still be put back.
  const saveLog = () => writeFileSync(logPath, JSON.stringify(log, null, 2));
  saveLog();
  for (const { siteId } of changes) {
    const ref = db.doc(`sites/${siteId}/settings/alerts`);
    // planned again on a fresh read inside a transaction: an admin's save
    // since the scan is not overwritten.
    const change = await db.runTransaction(async (tx) => {
      const rules = (await tx.get(ref)).data()?.rules;
      if (!Array.isArray(rules)) return null;
      const { next, repaired, seeded } = plan(rules);
      if (!repaired && !seeded) return null;
      // merge keeps the sibling fields the evaluator writes beside `rules`.
      tx.set(ref, { rules: next }, { merge: true });
      return { siteId, before: rules, after: next };
    });
    if (change) {
      log.applied.push(change);
      saveLog();
    }
  }
  log.completedAt = new Date().toISOString();
  saveLog();
  const applied = log.applied;
  console.log(`✅ changed ${applied.length} list(s). log: ${logPath}`);
  console.log(`   undo: node scripts/migrations/seed-default-low-disk-rule.mjs --env=${env} --rollback --log-file=${logPath} --confirm-project=${projectId}\n`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
