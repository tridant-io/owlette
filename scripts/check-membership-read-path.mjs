#!/usr/bin/env node
/**
 * check-membership-read-path.mjs — wave 4.2 of dev/active/per-site-roles.
 *
 * Verifies the client membership read path against a project's DEPLOYED rules
 * and DEPLOYED index, driven by the real web SDK with a real signed-in session.
 *
 * WHY THIS EXISTS SEPARATELY FROM THE RULES TESTS. `npm run test:rules` proves
 * the rules FILE is correct. It cannot prove the deployed ruleset matches it, and
 * it cannot prove the index exists at all — the emulator does not enforce
 * indexes. The Admin SDK is no help either: it bypasses both. So this signs in as
 * an ordinary user and issues exactly the queries `useSiteMemberships` issues.
 *
 * That gap is not hypothetical. The plan asserted no index was needed, and 115/115
 * rules tests agreed by staying silent; the deployed query failed with
 * `failed-precondition` until `firestore.indexes.json` gained an explicit
 * `members.uid` COLLECTION_GROUP field override. Automatic single-field indexing
 * does NOT extend to collection-group scope.
 *
 * READ-ONLY. It mints a custom token and reads. It writes nothing.
 *
 * Run it after any `firebase deploy --only firestore:rules,firestore:indexes`,
 * and before promoting the membership cutover to a new environment.
 *
 * machine scope (rules 2.12.0): when the subject holds a scoped row (a member row
 * with machineIds), a machine scope section checks that row against the deployed
 * rules. --scoped picks only such a subject. --list-scoped prints every member row
 * that carries machineIds, each with the DELETE a rollback sends before the web
 * reverts (code without machine scope reads such a row as the whole site), then
 * exits without signing in.
 *
 * Usage:
 *   node scripts/check-membership-read-path.mjs --env=dev
 *   node scripts/check-membership-read-path.mjs --env=prod --uid=<subject>
 *   node scripts/check-membership-read-path.mjs --env=dev --env-file=../Owlette/web/.env.local
 *   node scripts/check-membership-read-path.mjs --env=dev --scoped [--uid=<subject>]
 *   node scripts/check-membership-read-path.mjs --env=prod --list-scoped
 *
 * Exit codes: 0 all checks passed, or --list-scoped listed · 1 usage/credentials ·
 * 2 bad flags · 3 no suitable subject in the data (with --scoped: no active scoped
 * row) · 5 a check failed.
 */

import { createRequire } from 'module';
import { fileURLToPath } from 'url';
import { readFileSync, existsSync } from 'fs';
import { dirname, join, resolve } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const require = createRequire(join(ROOT, 'web', 'package.json'));

const args = process.argv.slice(2);
const KNOWN = new Set(['env', 'uid', 'env-file', 'scoped', 'list-scoped', 'help']);
for (const arg of args) {
  const name = arg.replace(/^--/, '').split('=')[0];
  if (!arg.startsWith('--') || !KNOWN.has(name)) {
    console.error(`❌ unknown argument: ${arg}`);
    console.error(`   known flags: ${[...KNOWN].map((f) => `--${f}`).join(', ')}`);
    process.exit(2);
  }
}
function flag(name) {
  const match = args.find((a) => a === `--${name}` || a.startsWith(`--${name}=`));
  if (!match) return undefined;
  const eq = match.indexOf('=');
  return eq === -1 ? true : match.slice(eq + 1);
}

if (flag('help')) {
  console.log('usage: check-membership-read-path.mjs --env=dev|prod [--uid=<uid>] [--scoped] [--list-scoped] [--env-file=<path>]');
  console.log('  --scoped       pick a scoped member as the subject (with --uid, that uid\'s first scoped row)');
  console.log('  --list-scoped  print every member row that carries machineIds and the DELETE a rollback sends, then exit');
  process.exit(0);
}

const env = flag('env');
if (env !== 'dev' && env !== 'prod') {
  console.error('❌ --env must be exactly "dev" or "prod"');
  process.exit(1);
}
const scopedOnly = Boolean(flag('scoped'));
const listScoped = Boolean(flag('list-scoped'));

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

const envFile = flag('env-file');
if (typeof envFile === 'string') {
  if (!existsSync(resolve(envFile))) {
    console.error(`❌ --env-file ${resolve(envFile)} does not exist`);
    process.exit(2);
  }
  loadEnvFile(resolve(envFile));
}
loadEnvFile(join(ROOT, 'web', '.env.local'));
loadEnvFile(join(ROOT, '.claude', '.env.local'));

const suffix = env === 'prod' ? '_PROD' : '_DEV';
const projectId = process.env[`FIREBASE_PROJECT_ID${suffix}`] || process.env.FIREBASE_PROJECT_ID;
const clientEmail = process.env[`FIREBASE_CLIENT_EMAIL${suffix}`] || process.env.FIREBASE_CLIENT_EMAIL;
const rawKey = process.env[`FIREBASE_PRIVATE_KEY${suffix}`] || process.env.FIREBASE_PRIVATE_KEY;
// The web SDK needs the public config of the SAME project. Only the unsuffixed
// NEXT_PUBLIC_* vars exist, so refuse rather than sign in to the wrong project.
const apiKey = process.env.NEXT_PUBLIC_FIREBASE_API_KEY;
const authDomain = process.env.NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN;
const publicProjectId = process.env.NEXT_PUBLIC_FIREBASE_PROJECT_ID;

// --list-scoped reads through the admin sdk alone and never signs in, so a rollback
// on prod needs no matching web config
if (!projectId || !clientEmail || !rawKey || (!listScoped && (!apiKey || !publicProjectId))) {
  console.error(`❌ Missing credentials for env=${env}.`);
  console.error(`   Needs the admin trio${listScoped ? '' : ' plus NEXT_PUBLIC_FIREBASE_{API_KEY,AUTH_DOMAIN,PROJECT_ID}'}.`);
  process.exit(1);
}
if (!listScoped && publicProjectId !== projectId) {
  console.error(`❌ admin credentials target ${projectId} but the web config targets ${publicProjectId}.`);
  console.error('   The client half would authenticate against a different project than the one under test.');
  process.exit(1);
}

const { initializeApp: adminInit, cert } = require('firebase-admin/app');
const { getAuth: adminAuth } = require('firebase-admin/auth');
const { getFirestore: adminFirestore } = require('firebase-admin/firestore');

const adminApp = adminInit({
  credential: cert({ projectId, clientEmail, privateKey: rawKey.replace(/\\n/g, '\n') }),
  projectId,
});
const adminDb = adminFirestore(adminApp);

// mirrors parseMachineIds in web/lib/machineAccess.ts, which a plain node script cannot
// import: absent is the whole site (null), a non-array reaches nothing ([])
function parseMachineIds(data) {
  if (!Object.prototype.hasOwnProperty.call(data, 'machineIds')) return null;
  if (!Array.isArray(data.machineIds)) return [];
  return [...new Set(data.machineIds.filter((id) => typeof id === 'string'))].sort();
}
// a row with any machineIds is scoped, even [], which reaches no machine
const isScoped = (row) => Array.isArray(row.machineIds);

if (listScoped) {
  const lines = [];
  for (const m of (await adminDb.collectionGroup('members').get()).docs) {
    const data = m.data() ?? {};
    const siteId = m.ref.parent.parent?.id;
    const machineIds = parseMachineIds(data);
    if (!siteId || machineIds === null) continue;
    lines.push(`${siteId}  ${m.id}  ${data.role}  ${JSON.stringify(machineIds)}  →  DELETE /api/sites/${siteId}/members/${m.id}`);
  }
  console.log(`\nproject ${projectId} (env=${env}): ${lines.length} member row(s) carry machineIds\n`);
  for (const line of lines) console.log(line);
  process.exit(0);
}

/**
 * Pick the subject from the DATA, never from a hardcoded uid — dev and prod give
 * the same person different uids. A superadmin is unusable: `canAccessSite`
 * short-circuits before the membership term, so every check would pass without
 * exercising membership at all.
 */
async function resolveSubjects(explicitUid, scopedOnly) {
  const [sitesSnap, usersSnap] = await Promise.all([
    adminDb.collection('sites').get(),
    adminDb.collection('users').get(),
  ]);
  const users = new Map(usersSnap.docs.map((d) => [d.id, d.data() ?? {}]));

  /** uid -> [{siteId, role, machineIds}] */
  const byUid = new Map();
  const siteIds = [];
  for (const site of sitesSnap.docs) {
    siteIds.push(site.id);
    for (const m of (await site.ref.collection('members').get()).docs) {
      const data = m.data() ?? {};
      if (data.status !== 'active') continue;
      if (!byUid.has(m.id)) byUid.set(m.id, []);
      byUid.get(m.id).push({ siteId: site.id, role: data.role, machineIds: parseMachineIds(data) });
    }
  }

  const eligible = [...byUid.entries()].filter(
    ([uid, rows]) =>
      rows.length > 0 &&
      (!scopedOnly || rows.some(isScoped)) &&
      users.get(uid) !== undefined &&
      users.get(uid).role !== 'superadmin' &&
      typeof users.get(uid).deletedAt !== 'number',
  );

  if (explicitUid) {
    const found = eligible.find(([uid]) => uid === explicitUid);
    if (!found) {
      console.error(`❌ --uid=${explicitUid} holds no active ${scopedOnly ? 'scoped ' : ''}membership, or is a superadmin/soft-deleted.`);
      process.exit(3);
    }
    return { subject: found, byUid, siteIds, users };
  }
  if (eligible.length === 0 && scopedOnly) {
    console.error('❌ --scoped: no non-superadmin user holds an active scoped row — nothing to verify.');
    console.error('   scope a member through the members API first; this script only reads.');
    process.exit(3);
  }
  if (eligible.length === 0) {
    console.error('❌ no non-superadmin user holds an active membership — nothing to verify.');
    console.error('   Run the wave 3 backfill against this project first.');
    process.exit(3);
  }
  // Prefer the subject with the most memberships: more surface, better signal.
  eligible.sort((a, b) => b[1].length - a[1].length);
  return { subject: eligible[0], byUid, siteIds, users };
}

const { subject, byUid, siteIds } = await resolveSubjects(
  typeof flag('uid') === 'string' ? flag('uid') : undefined,
  scopedOnly,
);
const [ME, myRows] = subject;
const myExpected = myRows.map((r) => `${r.siteId}:${r.role}`).sort();
const mySites = new Set(myRows.map((r) => r.siteId));

// A second principal whose rows this caller must not reach, and a site it has no
// membership on. Both come from the data; either may legitimately be absent.
const otherEntry = [...byUid.entries()].find(([uid]) => uid !== ME);
const foreignSite = siteIds.find((id) => !mySites.has(id));

const customToken = await adminAuth().createCustomToken(ME);

// --- client half: the real web SDK, deployed rules, deployed index -----------

const { initializeApp } = require('firebase/app');
const { getAuth, signInWithCustomToken, signOut } = require('firebase/auth');
const {
  getFirestore, collectionGroup, query, where, getDocs, doc, getDoc, collection,
  documentId, orderBy, limit,
} = require('firebase/firestore');

const app = initializeApp({ apiKey, authDomain, projectId: publicProjectId });
await signInWithCustomToken(getAuth(app), customToken);
const db = getFirestore(app);

console.log(`\nproject ${projectId} (env=${env}) — DEPLOYED rules and index`);
console.log(`subject ${ME}, ${myRows.length} membership(s)\n`);

let failures = 0;

async function expectAllowed(label, fn) {
  try {
    const out = await fn();
    console.log(`  PASS  allowed: ${label}`);
    return out;
  } catch (err) {
    failures += 1;
    console.log(`  FAIL  expected allowed, got ${err.code ?? 'error'}: ${label}`);
    console.log(`        ${err.message}`);
    return null;
  }
}

async function expectDenied(label, fn) {
  try {
    await fn();
    failures += 1;
    console.log(`  FAIL  expected DENIED but it succeeded: ${label}`);
  } catch (err) {
    const code = String(err.code ?? '');
    if (code.includes('permission-denied')) {
      console.log(`  PASS  denied: ${label}`);
    } else {
      // A missing index also throws here. Reporting it as a pass would turn an
      // infrastructure fault into apparent proof of a security property.
      failures += 1;
      console.log(`  FAIL  denied for the WRONG reason (${code || err.message}): ${label}`);
    }
  }
}

console.log('--- the read path useSiteMemberships depends on ---');
const mine = await expectAllowed(
  "collectionGroup('members').where('uid','==',me)",
  () => getDocs(query(collectionGroup(db, 'members'), where('uid', '==', ME))),
);
if (mine) {
  const got = mine.docs.map((d) => `${d.ref.parent.parent?.id}:${d.data().role}`).sort();
  console.log(`        -> ${got.join(', ')}`);
  if (JSON.stringify(got) === JSON.stringify(myExpected)) {
    console.log('  PASS  returns exactly this user\'s memberships, with roles');
  } else {
    failures += 1;
    console.log(`  FAIL  expected ${myExpected.join(', ')}`);
  }
}

console.log('\n--- the caller cannot widen it ---');
if (otherEntry) {
  await expectDenied(
    "collectionGroup('members').where('uid','==',someone-else)",
    () => getDocs(query(collectionGroup(db, 'members'), where('uid', '==', otherEntry[0]))),
  );
  await expectDenied(
    'read another user\'s member document directly',
    () => getDoc(doc(db, 'sites', otherEntry[1][0].siteId, 'members', otherEntry[0])),
  );
} else {
  console.log('  SKIP  only one principal holds memberships in this project');
}
await expectDenied(
  "collectionGroup('members') unfiltered",
  () => getDocs(collectionGroup(db, 'members')),
);
if (myRows.length > 0) {
  await expectDenied(
    'list the member roster of a site this user belongs to',
    () => getDocs(collection(db, 'sites', myRows[0].siteId, 'members')),
  );
}

console.log('\n--- site access resolves from membership ---');
await expectAllowed(
  `read ${myRows[0].siteId}, held as ${myRows[0].role}`,
  () => getDoc(doc(db, 'sites', myRows[0].siteId)),
);
await expectAllowed(
  'read own member document',
  () => getDoc(doc(db, 'sites', myRows[0].siteId, 'members', ME)),
);
if (foreignSite) {
  await expectDenied(
    `read ${foreignSite}, held by no membership`,
    () => getDoc(doc(db, 'sites', foreignSite)),
  );
} else {
  console.log('  SKIP  this user is a member of every site in the project');
}

function expectIds(label, snap, expected) {
  const got = snap.docs.map((d) => d.id).sort();
  if (JSON.stringify(got) === JSON.stringify(expected)) {
    console.log(`  PASS  ${label} returns exactly the scope's ids that exist (${got.length})`);
  } else {
    failures += 1;
    console.log(`  FAIL  ${label} returned ${got.join(', ') || 'nothing'}, expected ${expected.join(', ') || 'nothing'}`);
  }
}

console.log('\n--- machine scope ---');
const scopedRow = myRows.find(isScoped);
if (!scopedRow) {
  console.log('  SKIP  this subject holds no scoped row (--scoped picks one that does)');
} else {
  const S = scopedRow.siteId;
  const scope = scopedRow.machineIds;
  // firestore's `in` takes at most 30 values
  const ids = scope.slice(0, 30);
  const existing = async (ref) => new Set((await ref.select().get()).docs.map((d) => d.id));
  const machinesOnSite = await existing(adminDb.collection('sites').doc(S).collection('machines'));
  const configsOnSite = await existing(adminDb.collection('config').doc(S).collection('machines'));
  const IN = scope.find((id) => machinesOnSite.has(id));
  const OUT = [...machinesOnSite].find((id) => !scope.includes(id));
  console.log(`  scoped row on ${S}, held as ${scopedRow.role}: ${scope.length} machine(s), in ${IN ?? 'none'}, out ${OUT ?? 'none'}`);

  if (IN) {
    await expectAllowed(`get machines/${IN}, in the scope`, () => getDoc(doc(db, 'sites', S, 'machines', IN)));
    await expectAllowed(`get config/${S}/machines/${IN}`, () => getDoc(doc(db, 'config', S, 'machines', IN)));
  } else {
    console.log(`  SKIP  no machine in this scope exists on ${S}`);
  }
  if (OUT) {
    await expectDenied(`get machines/${OUT}, outside the scope`, () => getDoc(doc(db, 'sites', S, 'machines', OUT)));
  } else {
    console.log(`  SKIP  no machine on ${S} lies outside this scope`);
  }
  await expectDenied(`sites/${S}/machines unfiltered`, () => getDocs(collection(db, 'sites', S, 'machines')));
  await expectDenied(`config/${S}/machines unfiltered`, () => getDocs(collection(db, 'config', S, 'machines')));

  if (ids.length > 0) {
    const machines = await expectAllowed(
      `sites/${S}/machines where documentId() in the scope`,
      () => getDocs(query(collection(db, 'sites', S, 'machines'), where(documentId(), 'in', ids))),
    );
    if (machines) expectIds('machines', machines, ids.filter((id) => machinesOnSite.has(id)));
    const configs = await expectAllowed(
      `config/${S}/machines where documentId() in the scope`,
      () => getDocs(query(collection(db, 'config', S, 'machines'), where(documentId(), 'in', ids))),
    );
    if (configs) expectIds('config', configs, ids.filter((id) => configsOnSite.has(id)));
    await expectAllowed(
      `sites/${S}/logs where machineId in the scope, newest 5`,
      () => getDocs(query(
        collection(db, 'sites', S, 'logs'),
        where('machineId', 'in', ids), orderBy('timestamp', 'desc'), limit(5),
      )),
    );
    await expectAllowed(
      `sites/${S}/logs where action == exe_missing and machineId in the scope (the alert toasts' query)`,
      () => getDocs(query(
        collection(db, 'sites', S, 'logs'),
        where('action', '==', 'exe_missing'), where('machineId', 'in', ids), limit(20),
      )),
    );
  } else {
    console.log('  SKIP  the scope lists no machine, so no in-query can be made');
  }
  await expectDenied(
    `sites/${S}/logs newest 1, no machine filter`,
    () => getDocs(query(collection(db, 'sites', S, 'logs'), orderBy('timestamp', 'desc'), limit(1))),
  );
  await expectDenied(`sites/${S}/deployments`, () => getDocs(collection(db, 'sites', S, 'deployments')));
  await expectAllowed(`get sites/${S}/settings/swoop`, () => getDoc(doc(db, 'sites', S, 'settings', 'swoop')));
  await expectDenied(`get sites/${S}/settings/alerts`, () => getDoc(doc(db, 'sites', S, 'settings', 'alerts')));
  // isSiteAdmin needs the whole site, so a scoped admin is refused the audit log too
  await expectDenied(
    `sites/${S}/audit_log, held as ${scopedRow.role}`,
    () => getDocs(collection(db, 'sites', S, 'audit_log')),
  );
}

await signOut(getAuth(app));
console.log(`\n${failures === 0 ? '✅ all checks passed' : `❌ ${failures} check(s) failed`}\n`);
process.exit(failures === 0 ? 0 : 5);
