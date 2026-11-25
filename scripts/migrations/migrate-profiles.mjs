#!/usr/bin/env node
/**
 * Status: done with. Step 2.5 of the 2.12.x promotion (docs/runbooks/upgrade-2.12.0.md),
 * which reached prod in 073e031f; agents 2.9.0+ overwrite what it writes, and the
 * fleet floor is 3.x.
 *
 * Hardware profile bootstrap. One-shot: writes a best-effort
 * `hardware/profile` subdoc for machines that lack one, from the legacy
 * singular metrics fields, so the dashboard can render offline/stale machines
 * still on pre-2.9.0 agents.
 *
 * Mapping (mighty-roaming-kettle.md §Backward Compatibility):
 *   metrics.cpu.name       → cpus[0]  { id: 'CPU0', model, … }
 *   metrics.disk.total_gb  → disks[0] { id: 'C:', totalGb, label, fs }
 *   metrics.gpu.name       → gpus[0]  { id: 'GPU-<hash>', name, vramTotalGb }
 *   metrics.network.interfaces keys → nics [{ id, linkSpeedMbps, mac: null }]
 *
 * Agent 2.9.0+ overwrites this with canonical data on next startup, so it is
 * write-once per machine — existing profile docs are skipped.
 *
 * Usage:
 *   node scripts/migrations/migrate-profiles.mjs --env=dev|prod [--site=<id|all>]
 *                                     [--dry-run] [--force]
 *
 *   --env      required, target Firebase project
 *   --site     default 'all'
 *   --dry-run  log intended writes without committing
 *   --force    overwrite existing profile docs
 *
 * Credentials: FIREBASE_{PROJECT_ID,CLIENT_EMAIL,PRIVATE_KEY}_{DEV|PROD} with
 * unsuffixed fallback; auto-loads web/.env.local, .claude/.env.local,
 * scripts/.env.local.
 */

import { createRequire } from 'module';
import { fileURLToPath } from 'url';
import { readFileSync, existsSync } from 'fs';
import { dirname, join } from 'path';
import { createHash } from 'crypto';
import readline from 'readline';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..', '..');

// firebase-admin lives in web/node_modules; resolve from there so this runs
// without a root-level package.json.
const require = createRequire(join(ROOT, 'web', 'package.json'));
// Modular entry points, not the firebase-admin root namespace: since v14 the
// root exports only initializeApp/getApp/getApps/deleteApp/applicationDefault/
// cert/refreshToken, so the credential and firestore accessors on it are both
// undefined. Ported 2026-09-07 — the v14 sweep in a454e4cd touched only web/ and
// functions/, so every script here threw on startup while a checked-in runbook
// (docs/runbooks/upgrade-2.12.0.md) still told operators to run them.
const { initializeApp, cert } = require('firebase-admin/app');
const { getFirestore, FieldValue } = require('firebase-admin/firestore');

const args = process.argv.slice(2);

function getFlag(name) {
  const match = args.find((a) => a === `--${name}` || a.startsWith(`--${name}=`));
  if (!match) return undefined;
  const eq = match.indexOf('=');
  return eq === -1 ? true : match.slice(eq + 1);
}

const dryRun = getFlag('dry-run') === true;
const force = getFlag('force') === true;
const env = getFlag('env');
const siteFilter = getFlag('site') === true ? 'all' : (getFlag('site') || 'all');

if (env !== 'dev' && env !== 'prod') {
  console.error(
    'Usage: node scripts/migrations/migrate-profiles.mjs --env=dev|prod [--site=<id|all>] [--dry-run] [--force]'
  );
  process.exit(1);
}

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
  console.error(`❌ Missing Firebase credentials for env=${env}.`);
  console.error(`   Set FIREBASE_PROJECT_ID${suffix}, FIREBASE_CLIENT_EMAIL${suffix},`);
  console.error(`   and FIREBASE_PRIVATE_KEY${suffix} (or the unsuffixed equivalents).`);
  process.exit(1);
}

const privateKey = rawPrivateKey.replace(/\\n/g, '\n');

const usingFallback = !process.env[`FIREBASE_PROJECT_ID${suffix}`];
if (usingFallback) {
  console.warn(
    `⚠️  No FIREBASE_PROJECT_ID${suffix} set — falling back to plain FIREBASE_PROJECT_ID (${projectId}).`
  );
  console.warn(`   Verify this matches the intended ${env} project before continuing.\n`);
}

function shortHash(input) {
  return createHash('sha256').update(input).digest('hex').slice(0, 16);
}

/**
 * Best-effort profile from a legacy metrics blob, or null when there is
 * nothing to bootstrap — those machines stay unprofiled until the agent
 * upgrades.
 */
function buildBootstrapProfile(machineData) {
  const metrics = machineData?.metrics;
  if (!metrics || typeof metrics !== 'object') return null;

  // v2 docs already carry an agent-written canonical profile.
  if (metrics.schemaVersion === 2) return null;

  const cpus = [];
  if (metrics.cpu && typeof metrics.cpu === 'object') {
    cpus.push({
      id: 'CPU0',
      model: typeof metrics.cpu.name === 'string' ? metrics.cpu.name : 'Unknown CPU',
      physicalCores: Number.isFinite(metrics.cpu.physical_cores)
        ? metrics.cpu.physical_cores
        : null,
      logicalCores: Number.isFinite(metrics.cpu.logical_cores)
        ? metrics.cpu.logical_cores
        : null,
      socketIndex: 0,
    });
  }

  const disks = [];
  if (metrics.disk && typeof metrics.disk === 'object') {
    disks.push({
      id: 'C:',
      label: 'System',
      fs: 'NTFS',
      totalGb: Number.isFinite(metrics.disk.total_gb) ? metrics.disk.total_gb : null,
    });
  }

  const gpus = [];
  if (metrics.gpu && typeof metrics.gpu === 'object') {
    const name = typeof metrics.gpu.name === 'string' ? metrics.gpu.name : null;
    if (name) {
      gpus.push({
        id: `GPU-${shortHash(name)}`,
        name,
        vramTotalGb: Number.isFinite(metrics.gpu.vram_total_gb)
          ? metrics.gpu.vram_total_gb
          : null,
        pciBus: null,
      });
    }
  }

  const nics = [];
  const ifaces = metrics.network?.interfaces;
  if (ifaces && typeof ifaces === 'object') {
    for (const [ifName, data] of Object.entries(ifaces)) {
      const linkSpeed = data && typeof data === 'object' && Number.isFinite(data.link_speed_mbps)
        ? data.link_speed_mbps
        : null;
      nics.push({
        id: ifName,
        linkSpeedMbps: linkSpeed,
        mac: null,
      });
    }
  }

  // Need at least one device of any kind to be useful.
  if (cpus.length === 0 && disks.length === 0 && gpus.length === 0 && nics.length === 0) {
    return null;
  }

  const signatureInput = JSON.stringify({ cpus, disks, gpus, nics });

  return {
    schemaVersion: 1,
    signatureHash: `sha256:${createHash('sha256').update(signatureInput).digest('hex')}`,
    capturedAt: FieldValue.serverTimestamp(),
    agentVersion: 'bootstrap',
    cpus,
    disks,
    gpus,
    nics,
    bootstrap: true,
  };
}

function promptYesNo(question) {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    rl.question(question, (answer) => {
      rl.close();
      const t = answer.trim().toLowerCase();
      resolve(t === 'y' || t === 'yes');
    });
  });
}

async function main() {
  console.log(
    `\n${dryRun ? '[DRY RUN] ' : ''}Profile bootstrap — env=${env}, project=${projectId}, site=${siteFilter}${force ? ', --force' : ''}\n`
  );

  if (env === 'prod' && !dryRun) {
    const confirmed = await promptYesNo(
      `⚠️  About to write to PRODUCTION (${projectId}). Continue? [y/N] `
    );
    if (!confirmed) {
      console.log('Aborted.');
      process.exit(0);
    }
  }

  const app = initializeApp({
    credential: cert({ projectId, clientEmail, privateKey }),
  });
  const db = getFirestore(app);

  let siteIds;
  if (siteFilter === 'all') {
    const sitesSnap = await db.collection('sites').get();
    siteIds = sitesSnap.docs.map((d) => d.id);
  } else {
    siteIds = [siteFilter];
  }

  const totals = {
    sitesScanned: 0,
    machinesScanned: 0,
    written: 0,
    skippedAlreadyProfiled: 0,
    skippedNoLegacyData: 0,
    skippedAlreadyV2: 0,
  };

  const BATCH_SIZE = 400;
  let batch = db.batch();
  let pending = 0;

  for (const siteId of siteIds) {
    totals.sitesScanned++;
    const machinesSnap = await db.collection('sites').doc(siteId).collection('machines').get();

    for (const machineDoc of machinesSnap.docs) {
      totals.machinesScanned++;
      const machineId = machineDoc.id;
      const machineData = machineDoc.data();

      const profileRef = machineDoc.ref.collection('hardware').doc('profile');

      if (!force) {
        const existing = await profileRef.get();
        if (existing.exists) {
          totals.skippedAlreadyProfiled++;
          continue;
        }
      }

      const metrics = machineData?.metrics;
      if (metrics && metrics.schemaVersion === 2) {
        totals.skippedAlreadyV2++;
        continue;
      }

      const profile = buildBootstrapProfile(machineData);
      if (!profile) {
        console.log(`  [skip] ${siteId}/${machineId}: no legacy metrics to bootstrap from`);
        totals.skippedNoLegacyData++;
        continue;
      }

      const summary = [
        profile.cpus.length && `${profile.cpus.length} cpu(s)`,
        profile.disks.length && `${profile.disks.length} disk(s)`,
        profile.gpus.length && `${profile.gpus.length} gpu(s)`,
        profile.nics.length && `${profile.nics.length} nic(s)`,
      ]
        .filter(Boolean)
        .join(', ');
      console.log(`  [${dryRun ? 'would write' : 'write'}] ${siteId}/${machineId}: ${summary}`);

      if (!dryRun) {
        batch.set(profileRef, profile);
        pending++;
        totals.written++;
        if (pending >= BATCH_SIZE) {
          await batch.commit();
          batch = db.batch();
          pending = 0;
        }
      } else {
        totals.written++;
      }
    }
  }

  if (!dryRun && pending > 0) {
    await batch.commit();
  }

  console.log(`\nTotals:`);
  console.log(`  Sites scanned             : ${totals.sitesScanned}`);
  console.log(`  Machines scanned          : ${totals.machinesScanned}`);
  console.log(`  ${dryRun ? 'Would write ' : 'Wrote       '}: ${totals.written}`);
  console.log(`  Skipped (already profiled): ${totals.skippedAlreadyProfiled}`);
  console.log(`  Skipped (already v2)      : ${totals.skippedAlreadyV2}`);
  console.log(`  Skipped (no legacy data)  : ${totals.skippedNoLegacyData}`);

  if (dryRun && totals.written > 0) {
    console.log(`\nDry run complete — no writes made. Re-run without --dry-run to apply.`);
  } else if (!dryRun && totals.written > 0) {
    console.log(`\n✅ Bootstrap complete.`);
  } else {
    console.log(`\nNothing to bootstrap — every machine is already profiled or on v2.`);
  }
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error('\n❌ Migration failed:', err);
    process.exit(1);
  });
