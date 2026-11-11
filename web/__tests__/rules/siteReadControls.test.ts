/**
 * @jest-environment node
 *
 * whole-site read controls on rules 2.11.0. a whole-site member, a whole-site
 * admin and a superadmin read every path below today, and machine scope must not
 * take any of it away. the rest of the suite pins reads on five paths, so a rules
 * rewrite could drop one of these and stay green. scoped principals belong in a
 * file of their own.
 *
 * needs the emulator on :8080 (`npm run test:rules`); the default jest run skips it.
 */

import { assertSucceeds } from '@firebase/rules-unit-testing';
import {
  collection,
  doc,
  getDoc,
  getDocs,
  orderBy,
  query,
  where,
  writeBatch,
} from 'firebase/firestore';
import type { DocumentData, Firestore, Query } from 'firebase/firestore';
import {
  asUser,
  cleanupRulesHarness,
  clearFirestoreData,
  initRulesHarness,
  seedAsAdmin,
} from './harness';

const SITE = 'site-a';
const MACHINES = ['m1', 'm2'];
const AT = new Date('2026-11-04T12:00:00Z');

type Principal = readonly [who: string, context: () => Promise<Firestore>];
type Fixture = [path: string, data: DocumentData];

const member: Principal = ['a whole-site member', () => asUser('member-1', 'member', [SITE])];
const admin: Principal = ['a whole-site admin', () => asUser('admin-1', 'admin', [SITE])];
const superadmin: Principal = ['a superadmin', () => asUser('super-1', 'superadmin', [])];

const machineDocs = (m: string): Fixture[] => [
  [`sites/${SITE}/machines/${m}`, { online: true, lastHeartbeat: AT }],
  [`config/${SITE}/machines/${m}`, { processes: [] }],
  [`sites/${SITE}/machines/${m}/commands/pending`, { 'cmd-1': { type: 'restart_process', status: 'pending' } }],
  [`sites/${SITE}/machines/${m}/screenshots/s1`, { url: 'https://example.test/s1.jpg', timestamp: AT }],
  [`sites/${SITE}/machines/${m}/installed_software/x`, { name: 'TouchDesigner', version: '2023.12120' }],
  [`sites/${SITE}/machines/${m}/hardware/profile`, { cpu: 'test cpu', ramGb: 32 }],
  [`sites/${SITE}/machines/${m}/cortex/state`, { status: 'idle' }],
  [`sites/${SITE}/machines/${m}/logs/l1`, { message: 'service started', level: 'info', timestamp: AT }],
  [`sites/${SITE}/machines/${m}/metrics_history/b1`, { samples: [] }],
];

const siteDocs: Fixture[] = [
  [`sites/${SITE}`, { owner: 'owner-1', name: 'Site A' }],
  ...MACHINES.flatMap(machineDocs),
  [`sites/${SITE}/logs/la`, { machineId: 'm1', action: 'process_started', level: 'info', timestamp: AT }],
  // no machine on this one: once site logs are gated by their machine, the whole site must still read it
  [`sites/${SITE}/logs/lb`, { machineId: null, action: 'process_started', level: 'info', timestamp: AT }],
  [`sites/${SITE}/deployments/d1`, { name: 'td update', status: 'completed', createdAt: AT }],
  [`sites/${SITE}/installer_templates/t1`, { name: 'touchdesigner' }],
  [`sites/${SITE}/project_templates/p1`, { name: 'show files' }],
  [`sites/${SITE}/roosts/r1`, { name: 'show', schemaVersion: 2, currentVersionId: 'v1', targets: MACHINES }],
  [`sites/${SITE}/roosts/r1/target_state/m1`, { versionId: 'v1', status: 'synced' }],
  [`sites/${SITE}/roosts/r1/versions/v1`, { createdAt: AT, createdBy: 'admin-1' }],
  [`sites/${SITE}/talons/k1`, { name: 'restart on crash', enabled: true }],
  [`sites/${SITE}/talon_runs/k2`, { talonId: 'k1', status: 'succeeded', startedAt: AT }],
  [`sites/${SITE}/cortex-events/e1`, { machineId: 'm1', status: 'resolved', createdAt: AT }],
  [`sites/${SITE}/settings/swoop`, { excludedMachineIds: [], membersMayWatch: true }],
  [`sites/${SITE}/settings/display`, { keepAwake: true }],
  [`sites/${SITE}/settings/cortex`, { requireTier3Approval: true }],
  [`sites/${SITE}/settings/alerts`, { rules: [] }],
  [`config/${SITE}/schedule_presets/x`, { name: 'weekdays' }],
  [`config/${SITE}/reboot_presets/x`, { name: 'nightly' }],
  [`config/${SITE}/project_distribution_presets/x`, { name: 'show files' }],
  [`config/${SITE}/talon_presets/x`, { name: 'restart on crash' }],
  // no userId, so every chat read below rides the autonomous branch, not ownership
  ['chats/c1', { source: 'autonomous', siteId: SITE, targetMachineId: 'm1', updatedAt: AT }],
  ['chats/c1/messages/x', { role: 'assistant', content: 'investigating', createdAt: AT }],
  ['chats/c1/stream/current', { status: 'done' }],
];

// isSiteAdmin reads; a plain member is refused these (membership.test.ts)
const adminDocs: Fixture[] = [
  [`sites/${SITE}/audit_log/a1`, { action: 'site.update', timestamp: AT }],
  [`sites/${SITE}/webhooks/w1`, { url: 'https://hooks.example.test/w1', events: ['process.crashed'] }],
];

// lists the browser runs today, each with the number of seeded documents it returns
const lists: Array<[what: string, list: (db: Firestore) => Query, size: number]> = [
  [`sites/${SITE}/machines`, (db) => collection(db, 'sites', SITE, 'machines'), 2],
  [`config/${SITE}/machines`, (db) => collection(db, 'config', SITE, 'machines'), 2],
  [
    `sites/${SITE}/logs ordered by timestamp desc`,
    (db) => query(collection(db, 'sites', SITE, 'logs'), orderBy('timestamp', 'desc')),
    2,
  ],
  [
    `chats where source == autonomous and siteId == ${SITE}, ordered by updatedAt desc`,
    (db) =>
      query(
        collection(db, 'chats'),
        where('source', '==', 'autonomous'),
        where('siteId', '==', SITE),
        orderBy('updatedAt', 'desc'),
      ),
    1,
  ],
];

const gets = [
  ...[member, admin, superadmin].flatMap(([who, context]) =>
    siteDocs.map(([path]) => [who, path, context] as const),
  ),
  ...[admin, superadmin].flatMap(([who, context]) =>
    adminDocs.map(([path]) => [who, path, context] as const),
  ),
];

const listCases = [member, admin, superadmin].flatMap(([who, context]) =>
  lists.map(([what, list, size]) => [who, what, context, list, size] as const),
);

beforeAll(async () => {
  await initRulesHarness();
});

afterAll(async () => {
  await cleanupRulesHarness();
});

beforeEach(async () => {
  await clearFirestoreData();

  await seedAsAdmin(async (db) => {
    const batch = writeBatch(db);
    for (const [path, data] of [...siteDocs, ...adminDocs]) batch.set(doc(db, path), data);
    await batch.commit();
  });
});

describe('whole-site principals keep every read they hold on rules 2.11.0', () => {
  it.each(gets)('%s reads %s', async (_who, path, context) => {
    const db = await context();
    const snap = await assertSucceeds(getDoc(doc(db, path)));
    expect(snap.exists()).toBe(true);
  });

  it.each(listCases)('%s lists %s', async (_who, _what, context, list, size) => {
    const db = await context();
    const snap = await assertSucceeds(getDocs(list(db)));
    expect(snap.size).toBe(size);
  });
});
