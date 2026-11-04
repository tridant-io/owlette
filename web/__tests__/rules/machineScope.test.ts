/**
 * @jest-environment node
 *
 * machine scope on rules 2.12.0. a member row that carries machineIds reaches only
 * those machines (canAccessMachine) and nothing that spans machines
 * (canAccessWholeSite). a row without the field is the whole site, which
 * siteReadControls.test.ts pins. rules are not filters, so a scoped member's list is
 * legal only when the query pins the machine id to values all in the scope.
 *
 * needs the emulator on :8080 (`npm run test:rules`); the default jest run skips it.
 */

import { assertFails, assertSucceeds } from '@firebase/rules-unit-testing';
import {
  collection,
  collectionGroup,
  deleteDoc,
  deleteField,
  doc,
  documentId,
  getDoc,
  getDocs,
  orderBy,
  query,
  setDoc,
  updateDoc,
  where,
  writeBatch,
} from 'firebase/firestore';
import type { CollectionReference, DocumentData, Firestore, Query } from 'firebase/firestore';
import {
  asAgent,
  asUser,
  cleanupRulesHarness,
  clearFirestoreData,
  initRulesHarness,
  seedAsAdmin,
} from './harness';

const SITE = 'site-a';
const IN = 'IN';
const OUT = 'OUT';
const SCOPED = 'scoped-1';
const AT = new Date('2026-11-04T12:00:00Z');

type Fixture = [path: string, data: DocumentData];

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

const siteLog = (machineId: string | null): DocumentData => ({
  machineId,
  action: 'process_started',
  level: 'info',
  timestamp: AT,
});

const siteDocs: Fixture[] = [
  [`sites/${SITE}`, { owner: 'owner-1', name: 'Site A' }],
  ...machineDocs(IN),
  ...machineDocs(OUT),
  [`sites/${SITE}/logs/la`, siteLog(IN)],
  [`sites/${SITE}/logs/lb`, siteLog(null)],
  [`sites/${SITE}/logs/lc`, siteLog(OUT)],
  // no machineId key at all: the whole-site read of this row rests on `||` absorbing the missing field
  [`sites/${SITE}/logs/ld`, { action: 'process_started', level: 'info', timestamp: AT }],
  [`sites/${SITE}/deployments/d1`, { name: 'td update', status: 'completed', createdAt: AT }],
  [`sites/${SITE}/installer_templates/t1`, { name: 'touchdesigner' }],
  [`sites/${SITE}/project_templates/p1`, { name: 'show files' }],
  [`sites/${SITE}/roosts/r1`, { name: 'show', schemaVersion: 2, currentVersionId: 'v1', targets: [IN, OUT] }],
  [`sites/${SITE}/roosts/r1/target_state/${IN}`, { versionId: 'v1', status: 'synced' }],
  [`sites/${SITE}/roosts/r1/versions/v1`, { createdAt: AT, createdBy: 'admin-1' }],
  [`sites/${SITE}/talons/k1`, { name: 'restart on crash', enabled: true }],
  [`sites/${SITE}/talon_runs/k2`, { talonId: 'k1', status: 'succeeded', startedAt: AT }],
  [`sites/${SITE}/cortex-events/e1`, { machineId: IN, status: 'resolved', createdAt: AT }],
  [`sites/${SITE}/settings/swoop`, { excludedMachineIds: [], membersMayWatch: true }],
  [`sites/${SITE}/settings/display`, { keepAwake: true }],
  [`sites/${SITE}/settings/cortex`, { requireTier3Approval: true }],
  [`sites/${SITE}/settings/alerts`, { rules: [] }],
  [`config/${SITE}/schedule_presets/x`, { name: 'weekdays' }],
  [`config/${SITE}/reboot_presets/x`, { name: 'nightly' }],
  [`config/${SITE}/project_distribution_presets/x`, { name: 'show files' }],
  [`config/${SITE}/talon_presets/x`, { name: 'restart on crash' }],
  // no userId, so every chat read rides the autonomous branch, not ownership
  ['chats/c1', { source: 'autonomous', siteId: SITE, targetMachineId: IN, updatedAt: AT }],
  ['chats/c1/messages/x', { role: 'assistant', content: 'investigating', createdAt: AT }],
  ['chats/c1/stream/current', { status: 'done' }],
];

// isSiteAdmin reads
const adminDocs: Fixture[] = [
  [`sites/${SITE}/audit_log/a1`, { action: 'site.update', timestamp: AT }],
  [`sites/${SITE}/webhooks/w1`, { url: 'https://hooks.example.test/w1', events: ['process.crashed'] }],
];

// target_state, cortex-events and the chat name IN, and still belong to the whole site
const siteWide = [
  `sites/${SITE}/deployments/d1`,
  `sites/${SITE}/installer_templates/t1`,
  `sites/${SITE}/project_templates/p1`,
  `sites/${SITE}/roosts/r1`,
  `sites/${SITE}/roosts/r1/target_state/${IN}`,
  `sites/${SITE}/roosts/r1/versions/v1`,
  `sites/${SITE}/cortex-events/e1`,
  `sites/${SITE}/talons/k1`,
  `sites/${SITE}/talon_runs/k2`,
  `config/${SITE}/project_distribution_presets/x`,
  `config/${SITE}/talon_presets/x`,
  `sites/${SITE}/settings/alerts`,
  'chats/c1',
  'chats/c1/messages/x',
  'chats/c1/stream/current',
];

// still canAccessSite: a denial would hide swoop, and a scoped admin's machine-config dialogs read the presets
const carveOuts = [
  `sites/${SITE}`,
  `sites/${SITE}/settings/swoop`,
  `sites/${SITE}/settings/display`,
  `sites/${SITE}/settings/cortex`,
  `config/${SITE}/schedule_presets/x`,
  `config/${SITE}/reboot_presets/x`,
];

const paths = (fixtures: Fixture[]) => fixtures.map(([path]) => path);
const siteLogs = (db: Firestore) => collection(db, 'sites', SITE, 'logs');

const machineLists: Array<[what: string, list: (db: Firestore) => CollectionReference]> = [
  [`sites/${SITE}/machines`, (db) => collection(db, 'sites', SITE, 'machines')],
  [`config/${SITE}/machines`, (db) => collection(db, 'config', SITE, 'machines')],
];

// unfiltered, with the number of seeded documents each returns
const wholeSiteLists: Array<[what: string, list: (db: Firestore) => Query, size: number]> = [
  [`sites/${SITE}/machines`, (db) => collection(db, 'sites', SITE, 'machines'), 2],
  [`config/${SITE}/machines`, (db) => collection(db, 'config', SITE, 'machines'), 2],
  [`sites/${SITE}/logs ordered by timestamp desc`, (db) => query(siteLogs(db), orderBy('timestamp', 'desc')), 4],
];

async function seedMember(
  siteId: string,
  uid: string,
  role: 'admin' | 'member',
  machineIds?: string[] | null,
): Promise<void> {
  await seedAsAdmin(async (db) => {
    await setDoc(doc(db, 'sites', siteId, 'members', uid), {
      uid,
      role,
      status: 'active',
      addedAt: new Date(),
      addedBy: 'system:rules-harness',
      ...(machineIds !== undefined ? { machineIds } : {}),
    });
  });
}

// asUser with no sites writes only the users doc. with the site it would rewrite the row
// without machineIds, so the row is seeded after it.
async function asMember(
  uid: string,
  role: 'admin' | 'member',
  machineIds?: string[] | null,
): Promise<Firestore> {
  const db = await asUser(uid, role, []);
  await seedMember(SITE, uid, role, machineIds);
  return db;
}

const asScoped = (machineIds: string[] | null = [IN]) => asMember(SCOPED, 'member', machineIds);
const asScopedAdmin = () => asMember('scoped-admin-1', 'admin', [IN]);
const asWholeSite = () => asMember('member-1', 'member');
const asSuperadmin = () => asUser('super-1', 'superadmin', []);

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

describe('documents under one machine', () => {
  it.each(paths(machineDocs(IN)))('a scoped member reads %s', async (path) => {
    const db = await asScoped();
    const snap = await assertSucceeds(getDoc(doc(db, path)));
    expect(snap.exists()).toBe(true);
  });

  it.each(paths(machineDocs(OUT)))('a scoped member is refused %s', async (path) => {
    const db = await asScoped();
    await assertFails(getDoc(doc(db, path)));
  });

  it('a scoped member deletes installed software on IN', async () => {
    const db = await asScoped();
    await assertSucceeds(deleteDoc(doc(db, 'sites', SITE, 'machines', IN, 'installed_software', 'x')));
  });

  it('a scoped member is refused the installed software delete on OUT', async () => {
    const db = await asScoped();
    await assertFails(deleteDoc(doc(db, 'sites', SITE, 'machines', OUT, 'installed_software', 'x')));
  });
});

describe('machine lists', () => {
  it.each(machineLists)('a scoped member is refused the unfiltered %s list', async (_what, list) => {
    const db = await asScoped();
    await assertFails(getDocs(list(db)));
  });

  it.each(machineLists)('a scoped member lists %s where documentId() in [IN], and gets exactly IN', async (_what, list) => {
    const db = await asScoped();
    const snap = await assertSucceeds(getDocs(query(list(db), where(documentId(), 'in', [IN]))));
    expect(snap.docs.map((d) => d.id)).toEqual([IN]);
  });

  it.each(machineLists)('a scoped member is refused %s where documentId() in [IN, OUT]', async (_what, list) => {
    const db = await asScoped();
    await assertFails(getDocs(query(list(db), where(documentId(), 'in', [IN, OUT]))));
  });

  it.each(machineLists)('a scoped member lists %s where documentId() == IN', async (_what, list) => {
    const db = await asScoped();
    const snap = await assertSucceeds(getDocs(query(list(db), where(documentId(), '==', IN))));
    expect(snap.docs.map((d) => d.id)).toEqual([IN]);
  });

  it('a scoped member lists metrics_history under IN', async () => {
    const db = await asScoped();
    const snap = await assertSucceeds(getDocs(collection(db, 'sites', SITE, 'machines', IN, 'metrics_history')));
    expect(snap.docs.map((d) => d.id)).toEqual(['b1']);
  });

  it('a scoped member is refused metrics_history under OUT', async () => {
    const db = await asScoped();
    await assertFails(getDocs(collection(db, 'sites', SITE, 'machines', OUT, 'metrics_history')));
  });
});

describe('the 30-machine cap', () => {
  const thirty = [IN, ...Array.from({ length: 29 }, (_, i) => `m${i + 1}`)];
  const byIds = (db: Firestore, ids: string[]) =>
    query(collection(db, 'sites', SITE, 'machines'), where(documentId(), 'in', ids));

  it('a 30-machine scope lists with one documentId() in query', async () => {
    const db = await asScoped(thirty);
    const snap = await assertSucceeds(getDocs(byIds(db, thirty)));
    expect(snap.docs.map((d) => d.id)).toEqual([IN]);
  });

  // the 31st id is off the row, so permission-denied here would mean the rules ran first
  it('31 values are refused as invalid-argument before the rules run', async () => {
    const db = await asScoped(thirty);
    await expect(getDocs(byIds(db, [...thirty, 'm30']))).rejects.toMatchObject({ code: 'invalid-argument' });
  });
});

describe('site logs', () => {
  const scopedLists: Array<[what: string, list: (db: Firestore) => Query]> = [
    ['machineId == IN', (db) => query(siteLogs(db), where('machineId', '==', IN), orderBy('timestamp', 'desc'))],
    ['machineId in [IN]', (db) => query(siteLogs(db), where('machineId', 'in', [IN]), orderBy('timestamp', 'desc'))],
  ];

  const refusedRows: Array<[what: string, logId: string]> = [
    ['lc, a row of OUT', 'lc'],
    ['lb, whose machineId is null', 'lb'],
    ['ld, which has no machineId', 'ld'],
  ];

  it.each(scopedLists)('a scoped member lists logs where %s, newest first', async (_what, list) => {
    const db = await asScoped();
    const snap = await assertSucceeds(getDocs(list(db)));
    expect(snap.docs.map((d) => d.id)).toEqual(['la']);
  });

  it('a scoped member is refused the unfiltered list', async () => {
    const db = await asScoped();
    await assertFails(getDocs(query(siteLogs(db), orderBy('timestamp', 'desc'))));
  });

  it('a scoped member is refused logs where machineId in [IN, OUT]', async () => {
    const db = await asScoped();
    await assertFails(
      getDocs(query(siteLogs(db), where('machineId', 'in', [IN, OUT]), orderBy('timestamp', 'desc'))),
    );
  });

  it('a scoped member reads la, a row of IN', async () => {
    const db = await asScoped();
    await assertSucceeds(getDoc(doc(db, 'sites', SITE, 'logs', 'la')));
  });

  it.each(refusedRows)('a scoped member is refused %s', async (_what, logId) => {
    const db = await asScoped();
    await assertFails(getDoc(doc(db, 'sites', SITE, 'logs', logId)));
  });

  it.each(['lb', 'ld'])('a whole-site member reads %s, a row with no machine', async (logId) => {
    const db = await asWholeSite();
    const snap = await assertSucceeds(getDoc(doc(db, 'sites', SITE, 'logs', logId)));
    expect(snap.exists()).toBe(true);
  });
});

describe('documents that span machines', () => {
  it.each(siteWide)('a scoped member is refused %s', async (path) => {
    const db = await asScoped();
    await assertFails(getDoc(doc(db, path)));
  });

  it.each(siteWide)('a whole-site member reads %s', async (path) => {
    const db = await asWholeSite();
    const snap = await assertSucceeds(getDoc(doc(db, path)));
    expect(snap.exists()).toBe(true);
  });

  it('a scoped member is refused the target_state delete, even on IN', async () => {
    const db = await asScoped();
    await assertFails(deleteDoc(doc(db, 'sites', SITE, 'roosts', 'r1', 'target_state', IN)));
  });

  it('a scoped member is refused the autonomous chats list', async () => {
    const db = await asScoped();
    await assertFails(
      getDocs(
        query(
          collection(db, 'chats'),
          where('source', '==', 'autonomous'),
          where('siteId', '==', SITE),
          orderBy('updatedAt', 'desc'),
        ),
      ),
    );
  });
});

describe('what canAccessSite still gates', () => {
  it.each(carveOuts)('a scoped member reads %s', async (path) => {
    const db = await asScoped();
    const snap = await assertSucceeds(getDoc(doc(db, path)));
    expect(snap.exists()).toBe(true);
  });
});

describe('a scoped admin', () => {
  it.each(paths(adminDocs))('is refused %s', async (path) => {
    const db = await asScopedAdmin();
    await assertFails(getDoc(doc(db, path)));
  });

  it('reads machines/IN', async () => {
    const db = await asScopedAdmin();
    await assertSucceeds(getDoc(doc(db, 'sites', SITE, 'machines', IN)));
  });

  it('is refused machines/OUT', async () => {
    const db = await asScopedAdmin();
    await assertFails(getDoc(doc(db, 'sites', SITE, 'machines', OUT)));
  });
});

const failClosed: Array<[label: string, machineIds: string[] | null]> = [
  ['[]', []],
  ['null', null],
];

describe.each(failClosed)('a row with machineIds: %s', (_label, machineIds) => {
  it('is refused machines/IN', async () => {
    const db = await asScoped(machineIds);
    await assertFails(getDoc(doc(db, 'sites', SITE, 'machines', IN)));
  });

  it('is refused deployments', async () => {
    const db = await asScoped(machineIds);
    await assertFails(getDoc(doc(db, 'sites', SITE, 'deployments', 'd1')));
  });

  it('still reads the site document', async () => {
    const db = await asScoped(machineIds);
    await assertSucceeds(getDoc(doc(db, 'sites', SITE)));
  });
});

describe('controls', () => {
  it.each(wholeSiteLists)('a whole-site member lists %s unfiltered', async (_what, list, size) => {
    const db = await asWholeSite();
    const snap = await assertSucceeds(getDocs(list(db)));
    expect(snap.size).toBe(size);
  });

  it.each(paths([...siteDocs, ...adminDocs]))('a superadmin with no rows reads %s', async (path) => {
    const db = await asSuperadmin();
    const snap = await assertSucceeds(getDoc(doc(db, path)));
    expect(snap.exists()).toBe(true);
  });

  it.each(wholeSiteLists)('a superadmin with no rows lists %s unfiltered', async (_what, list, size) => {
    const db = await asSuperadmin();
    const snap = await assertSucceeds(getDocs(list(db)));
    expect(snap.size).toBe(size);
  });

  it('the agent of OUT still reads and writes its own machine and config', async () => {
    const db = asAgent(SITE, OUT);
    const machine = doc(db, 'sites', SITE, 'machines', OUT);
    const config = doc(db, 'config', SITE, 'machines', OUT);
    await assertSucceeds(getDoc(machine));
    await assertSucceeds(setDoc(machine, { online: true, lastHeartbeat: AT }, { merge: true }));
    await assertSucceeds(getDoc(config));
    await assertSucceeds(setDoc(config, { processes: [] }, { merge: true }));
  });

  it('a soft-deleted scoped member is refused machines/IN', async () => {
    const db = await asScoped();
    const machine = doc(db, 'sites', SITE, 'machines', IN);
    await assertSucceeds(getDoc(machine));
    await seedAsAdmin(async (adminDb) => {
      await updateDoc(doc(adminDb, 'users', SCOPED), { deletedAt: AT });
    });
    await assertFails(getDoc(machine));
  });
});

describe('the scoped row itself', () => {
  const ownRow = (db: Firestore) => doc(db, 'sites', SITE, 'members', SCOPED);

  it('cannot be rewritten with setDoc to drop machineIds', async () => {
    const db = await asScoped();
    await assertFails(
      setDoc(ownRow(db), { uid: SCOPED, role: 'member', status: 'active', addedAt: AT, addedBy: SCOPED }),
    );
  });

  it('cannot be updated to add a machine', async () => {
    const db = await asScoped();
    await assertFails(updateDoc(ownRow(db), { machineIds: [IN, OUT] }));
  });

  it('cannot have machineIds deleted', async () => {
    const db = await asScoped();
    await assertFails(updateDoc(ownRow(db), { machineIds: deleteField() }));
  });

  it('reads back through collectionGroup(members), machineIds included', async () => {
    const db = await asScoped();
    const snap = await assertSucceeds(
      getDocs(query(collectionGroup(db, 'members'), where('uid', '==', SCOPED))),
    );
    expect(snap.docs.map((d) => d.data().machineIds)).toEqual([[IN]]);
  });
});
