/** @jest-environment node */

/**
 * the security-boundary specs (web/e2e/specs/security-boundary) seed accounts on the real dev
 * project, and neither jest nor ci ever runs them. their cleanup and stale-run sweep are the only
 * code in that folder that deletes, so both are held here against fakes.
 */

import { readdirSync, readFileSync } from 'fs';
import path from 'path';
import type { Auth } from 'firebase-admin/auth';
import type { Firestore } from 'firebase-admin/firestore';
import type { Actor } from '@/lib/capabilities';
import { rateLimitSubjectDocId, rateLimitSubjectKey } from '@/lib/rateLimit.server';
import {
  cleanupRun,
  DEV_PROJECT_ID,
  holdSecurityConfig,
  isStaleRunSite,
  isStaleRunUser,
  makeRunIds,
  runSiteMark,
  sweepStaleRuns,
} from '../e2e/specs/security-boundary/cleanup';

type Docs = Record<string, Record<string, unknown>>;

const DAY_MS = 24 * 60 * 60 * 1000;
const EMAIL = '@security-boundary.e2e';
const PREFIXES = ['w8', 'w8-account', 'w8-api', 'w8-cortex', 'w8-rollback'] as const;
/** shaped like a firebase auth uid, which is what a real account's row is keyed by. */
const REAL_UID = 'kQ3xV9mBt2ZrLp7WnYc4Hd8sJf01';

const compare: Record<string, (a: string, b: string) => boolean> = {
  '==': (a, b) => a === b,
  '>=': (a, b) => a >= b,
  '<': (a, b) => a < b,
};

/**
 * in-memory admin firestore and auth; a path or `auth/<uid>` listed in `failing` rejects. an
 * account's email is the one its run would have seeded unless `emails` names another.
 */
function fakeProject(
  docs: Docs,
  accountUids: string[] = [],
  failing: string[] = [],
  emails: Record<string, string> = {},
) {
  const store = new Map(Object.entries(docs));
  const accounts = new Set(accountUids);
  const failIf = (target: string) => {
    if (failing.includes(target)) throw new Error(`denied ${target}`);
  };
  const ref = (docPath: string) => ({
    path: docPath,
    get: async () => ({ data: () => store.get(docPath) }),
    set: async (data: Record<string, unknown>) => {
      failIf(docPath);
      store.set(docPath, data);
    },
    delete: async () => {
      failIf(docPath);
      store.delete(docPath);
    },
  });
  const query = (name: string, filters: Array<[string, string, string]>) => ({
    where: (field: string, op: string, value: string) => query(name, [...filters, [field, op, value]]),
    get: async () => ({
      docs: [...store.entries()]
        .filter(([docPath]) => docPath.startsWith(`${name}/`) && docPath.split('/').length === 2)
        .map(([docPath, data]) => ({ id: docPath.split('/')[1], ref: ref(docPath), data: () => data }))
        .filter((doc) =>
          filters.every(([field, op, value]) =>
            compare[op](field === '__name__' ? doc.id : String(doc.data()[field]), value),
          ),
        ),
    }),
  });
  const db = {
    doc: (docPath: string) => ref(docPath),
    collection: (name: string) => ({ ...query(name, []), doc: (id: string) => ref(`${name}/${id}`) }),
    recursiveDelete: async (target: { path: string }) => {
      failIf(target.path);
      for (const docPath of [...store.keys()]) {
        if (docPath === target.path || docPath.startsWith(`${target.path}/`)) store.delete(docPath);
      }
    },
  };
  const auth = {
    deleteUser: async (uid: string) => {
      failIf(`auth/${uid}`);
      if (!accounts.delete(uid)) throw Object.assign(new Error('no such user'), { code: 'auth/user-not-found' });
    },
    // two to a page, so every sweep walks more than one
    listUsers: async (_max: number, pageToken?: string) => {
      const from = Number(pageToken ?? 0);
      const all = [...accounts].sort();
      return {
        users: all.slice(from, from + 2).map((uid) => ({ uid, email: emails[uid] ?? `${uid}${EMAIL}` })),
        pageToken: from + 2 < all.length ? String(from + 2) : undefined,
      };
    },
  };
  return {
    db: db as unknown as Firestore,
    auth: auth as unknown as Auth,
    paths: () => [...store.keys()].sort(),
    accounts: () => [...accounts].sort(),
  };
}

const row = (uid: string): Docs => ({ [`users/${uid}`]: { email: `${uid}${EMAIL}` } });
/** a count the server keeps for a user's calls to platform routes, keyed the limiter's own way. */
const platformShard = (uid: string) =>
  `sites/platform_global/rate_limits/user/subjects/${rateLimitSubjectDocId(
    rateLimitSubjectKey({ type: 'user', userId: uid } as Actor),
  )}/capabilities/global_settings_write/shards/3`;

afterEach(() => {
  jest.restoreAllMocks();
});

describe('cleanupRun', () => {
  const ids = makeRunIds('w8-rollback');
  const member = `${ids.uid}-member`;
  const superUid = `${ids.uid}-super`;
  const all = [ids.uid, member, superUid];
  const bystanders: Docs = {
    [`users/${REAL_UID}`]: { email: 'owner@example.com', role: 'superadmin' },
    [`users/${REAL_UID}/api_keys/k0`]: { keyHash: 'hash-real' },
    'api_keys/hash-real': { userId: REAL_UID },
    'sites/real-site': { name: 'real' },
    'config/real-site/machines/m1': { processes: [] },
    'site_ids/real-site': {},
    'chat_conversations/chat-real': { siteId: 'real-site' },
    'idempotency_cache/reply-real': { userId: REAL_UID },
    [platformShard(REAL_UID)]: { count: 4, windowStart: 1 },
  };
  const seeded = (): Docs => ({
    ...bystanders,
    [`users/${ids.uid}`]: { email: ids.email, role: 'admin' },
    [`users/${member}`]: { email: `${member}${EMAIL}`, role: 'member' },
    [`users/${superUid}`]: { email: `${superUid}${EMAIL}`, role: 'superadmin' },
    [`users/${superUid}/api_keys/k1`]: { keyHash: 'hash-run' },
    'api_keys/hash-run': { userId: superUid },
    [`sites/${ids.siteId}`]: { name: 'W8.1 Rollback Rehearsal' },
    [`sites/${ids.siteId}/machines/${ids.machineId}`]: { online: true },
    [`config/${ids.siteId}/machines/${ids.machineId}`]: { processes: [] },
    [`site_ids/${ids.siteId}`]: {},
    'chat_conversations/chat-run': { siteId: ids.siteId },
    'idempotency_cache/reply-run': { userId: member },
    [platformShard(superUid)]: { count: 2, windowStart: 1 },
  });
  const untouched = (project: ReturnType<typeof fakeProject>) => {
    expect(project.paths()).toEqual(Object.keys(seeded()).sort());
    expect(project.accounts()).toEqual([...all, REAL_UID].sort());
  };

  it('removes the -member and -super rows, not only the base row', async () => {
    const project = fakeProject(seeded(), all);
    await cleanupRun(project.db, project.auth, ids, all);
    expect(project.paths().filter((docPath) => docPath.startsWith(`users/${ids.uid}`))).toEqual([]);
  });

  it('removes each user row, key lookup, platform rate count and auth account, and the run site, config and chats', async () => {
    const project = fakeProject(seeded(), [...all, REAL_UID]);
    await expect(cleanupRun(project.db, project.auth, ids, all)).resolves.toEqual([]);
    expect(project.paths()).toEqual(Object.keys(bystanders).sort());
    expect(project.accounts()).toEqual([REAL_UID]);
  });

  it('takes a missing auth account as already clean', async () => {
    const project = fakeProject(seeded(), [REAL_UID]);
    await expect(cleanupRun(project.db, project.auth, ids, all)).resolves.toEqual([]);
    expect(project.accounts()).toEqual([REAL_UID]);
  });

  it('reports a failed delete and still runs the rest', async () => {
    const project = fakeProject(seeded(), all, [`users/${member}`, `auth/${superUid}`]);
    const leftovers = await cleanupRun(project.db, project.auth, ids, all);
    expect(leftovers).toHaveLength(2);
    expect(leftovers).toEqual(
      expect.arrayContaining([
        expect.stringContaining(`users/${member}: denied`),
        expect.stringContaining(`auth user ${superUid}: denied`),
      ]),
    );
    expect(project.paths()).toEqual([...Object.keys(bystanders), `users/${member}`].sort());
    expect(project.accounts()).toEqual([superUid]);
  });

  it.each([
    ['a real account', REAL_UID],
    ["another run's user", makeRunIds('w8-rollback').uid],
    ['a uid that only starts like the run', `${ids.uid}x`],
    ['a suffix that reaches into another path', `${ids.uid}-member/api_keys`],
    ['an empty uid', ''],
  ])('refuses %s before deleting anything', async (_name, uid) => {
    const project = fakeProject(seeded(), [...all, REAL_UID]);
    await expect(cleanupRun(project.db, project.auth, ids, [ids.uid, uid])).rejects.toThrow(/refusing/);
    untouched(project);
  });

  it.each([
    ['a site that is not the run site', { uid: ids.uid, siteId: 'real-site' }],
    ['a base uid that is not run-shaped', { uid: REAL_UID, siteId: `site-${REAL_UID}` }],
    ['an empty base uid', { uid: '', siteId: 'site-' }],
  ])('refuses %s before deleting anything', async (_name, scope) => {
    const project = fakeProject(seeded(), [...all, REAL_UID]);
    await expect(cleanupRun(project.db, project.auth, scope, [`${scope.uid}-super`])).rejects.toThrow(/refusing/);
    untouched(project);
  });
});

describe('isStaleRunUser', () => {
  /** a superadmin row whose run started months before `NOW`. */
  const OLD_ROW = 'user-w8-rollback-1777300000000-0a1b2c3d-super';
  const NOW = Date.UTC(2026, 10, 18);
  const own = (id: string) => ({ email: `${id}${EMAIL}` });

  it.each(PREFIXES)('accepts a %s row more than a day old, with or without a role suffix', (prefix) => {
    const ids = makeRunIds(prefix);
    const later = Date.now() + DAY_MS + 60_000;
    expect(isStaleRunUser(ids.uid, { email: ids.email }, later)).toBe(true);
    expect(isStaleRunUser(`${ids.uid}-super`, own(`${ids.uid}-super`), later)).toBe(true);
  });

  it('accepts a superadmin row an old run left behind', () => {
    const superRow = { ...own(OLD_ROW), role: 'superadmin' };
    expect(isStaleRunUser(OLD_ROW, superRow, NOW)).toBe(true);
  });

  it('rejects a row whose run started within the last day, or in the future', () => {
    const ids = makeRunIds('w8-rollback');
    expect(isStaleRunUser(ids.uid, own(ids.uid), Date.now())).toBe(false);
    expect(isStaleRunUser(ids.uid, own(ids.uid), Date.now() + DAY_MS - 60_000)).toBe(false);
    expect(isStaleRunUser(ids.uid, own(ids.uid), Date.now() - 7 * DAY_MS)).toBe(false);
  });

  it.each([
    ['a real-looking uid', REAL_UID, own(REAL_UID)],
    ['the wrong email domain', OLD_ROW, { email: `${OLD_ROW}@example.com` }],
    ["another row's email", OLD_ROW, { email: `someone${EMAIL}` }],
    ['no email', OLD_ROW, {}],
    ['a 12-digit timestamp', 'user-w8-rollback-177730000000-0a1b2c3d', undefined],
    ['an unknown prefix', 'user-w9-1777300000000-0a1b2c3d', undefined],
    ['a short random part', 'user-w8-1777300000000-0a1b2c3', undefined],
    ['uppercase hex', 'user-w8-1777300000000-0A1B2C3D', undefined],
    ['a second suffix', `${OLD_ROW}-admin`, undefined],
    ['a leading extra', `x${OLD_ROW}`, undefined],
    ['a trailing newline', `${OLD_ROW}\n`, undefined],
    ['a site id', 'site-w8-rollback-1777300000000-0a1b2c3d', undefined],
  ])('rejects %s', (_name, id, data) => {
    expect(isStaleRunUser(id, data ?? own(id), NOW)).toBe(false);
  });
});

describe('runSiteMark', () => {
  it('is the run id of a run site, and refuses any other id', () => {
    const ids = makeRunIds('w8-api');
    expect(runSiteMark(ids.siteId)).toEqual({ e2eRun: ids.runId });
    expect(() => runSiteMark('real-site')).toThrow(/not a run's site id/);
    expect(() => runSiteMark(ids.uid)).toThrow(/not a run's site id/);
  });
});

describe('isStaleRunSite', () => {
  const OLD_RUN = 'w8-cortex-1777300000000-0a1b2c3d';
  const OLD_SITE = `site-${OLD_RUN}`;
  const NOW = Date.UTC(2026, 10, 18);

  it.each(PREFIXES)('accepts a %s site more than a day old that carries its run mark', (prefix) => {
    const ids = makeRunIds(prefix);
    expect(isStaleRunSite(ids.siteId, runSiteMark(ids.siteId), Date.now() + DAY_MS + 60_000)).toBe(true);
  });

  it('rejects a site whose run started within the last day', () => {
    const ids = makeRunIds('w8');
    expect(isStaleRunSite(ids.siteId, runSiteMark(ids.siteId), Date.now())).toBe(false);
    expect(isStaleRunSite(ids.siteId, runSiteMark(ids.siteId), Date.now() + DAY_MS - 60_000)).toBe(false);
  });

  it.each<[string, string, Record<string, unknown>]>([
    ['no mark', OLD_SITE, {}],
    ["another run's mark", OLD_SITE, { e2eRun: 'w8-cortex-1777300000001-0a1b2c3d' }],
    ['the site id as the mark', OLD_SITE, { e2eRun: OLD_SITE }],
    ['an owner a run used to write, and no mark', OLD_SITE, { owner: 'security-boundary-owner' }],
    ['a site a person named', 'real-site', { e2eRun: 'real-site' }],
    ['an unknown prefix', 'site-w9-1777300000000-0a1b2c3d', { e2eRun: 'w9-1777300000000-0a1b2c3d' }],
    ['a trailing suffix', `${OLD_SITE}-2`, { e2eRun: OLD_RUN }],
    ['a user id', `user-${OLD_RUN}`, { e2eRun: OLD_RUN }],
  ])('rejects %s', (_name, id, data) => {
    expect(isStaleRunSite(id, data, NOW)).toBe(false);
  });
});

describe('sweepStaleRuns', () => {
  const later = Date.now() + 2 * DAY_MS;

  it('removes a stale run site with its config, tombstone and chats, and keeps every other site', async () => {
    const dead = makeRunIds('w8-cortex');
    const unmarked = makeRunIds('w8-api');
    const fresh = `site-w8-api-${later - 60_000}-0a1b2c3d`;
    const kept: Docs = {
      [`sites/${unmarked.siteId}`]: { owner: REAL_UID },
      [`config/${unmarked.siteId}/machines/m1`]: { processes: [] },
      [`sites/${fresh}`]: runSiteMark(fresh),
      'sites/site-w8-showroom': { e2eRun: 'w8-showroom' },
      'sites/real-site': { owner: REAL_UID },
      'chat_conversations/chat-real': { siteId: 'real-site' },
    };
    const project = fakeProject({
      ...kept,
      [`sites/${dead.siteId}`]: runSiteMark(dead.siteId),
      [`sites/${dead.siteId}/machines/${dead.machineId}`]: { online: true },
      [`sites/${dead.siteId}/members/${dead.uid}`]: { role: 'admin' },
      [`config/${dead.siteId}/machines/${dead.machineId}`]: { processes: [] },
      [`site_ids/${dead.siteId}`]: {},
      'chat_conversations/chat-dead': { siteId: dead.siteId },
    });
    const log = jest.spyOn(console, 'log').mockImplementation(() => {});

    await expect(sweepStaleRuns(project.db, project.auth, DEV_PROJECT_ID, later)).resolves.toEqual([]);

    expect(project.paths()).toEqual(Object.keys(kept).sort());
    expect(log).toHaveBeenCalledWith(expect.stringContaining(dead.siteId));
  });

  it('removes a stale run account that has no users row, and keeps one under another email', async () => {
    const dead = makeRunIds('w8-rollback').uid;
    const borrowed = makeRunIds('w8-account').uid;
    const project = fakeProject({}, [dead, `${dead}-super`, borrowed, REAL_UID], [], {
      [borrowed]: 'someone@example.com',
      [REAL_UID]: 'owner@example.com',
    });
    jest.spyOn(console, 'log').mockImplementation(() => {});

    await expect(sweepStaleRuns(project.db, project.auth, DEV_PROJECT_ID, later)).resolves.toEqual([]);

    expect(project.accounts()).toEqual([borrowed, REAL_UID].sort());
  });

  it('refuses to sweep more than 25 sites, and deletes none of them', async () => {
    const stale = Array.from({ length: 26 }, (_, i) => `sites/site-w8-${1777300000000 + i}-0a1b2c3d`);
    const project = fakeProject(Object.fromEntries(stale.map((site) => [site, runSiteMark(site.slice('sites/'.length))])));
    await expect(sweepStaleRuns(project.db, project.auth, DEV_PROJECT_ID, later)).rejects.toThrow(/26/);
    expect(project.paths()).toHaveLength(26);
  });

  it('removes stale run users of every prefix, logs each, and touches nothing else', async () => {
    const stale = PREFIXES.flatMap((prefix) => {
      const { uid } = makeRunIds(prefix);
      return [uid, `${uid}-super`];
    });
    const wrongEmail = makeRunIds('w8').uid;
    const kept: Docs = {
      ...row(`user-w8-api-${later - 60_000}-0a1b2c3d`),
      [`users/${wrongEmail}`]: { email: 'someone@example.com' },
      [`users/${REAL_UID}`]: { email: `owner${EMAIL}`, role: 'superadmin' },
      ...row('user-w8-team-lead'),
      [`sites/site-${stale[0].slice('user-'.length)}`]: { name: 'a site with no owner a run writes' },
      'api_keys/hash-real': { userId: REAL_UID },
    };
    const project = fakeProject(
      {
        ...kept,
        ...Object.assign({}, ...stale.map(row)),
        [`users/${stale[1]}/api_keys/k1`]: { keyHash: 'hash-stale' },
        'api_keys/hash-stale': { userId: stale[1] },
      },
      [stale[1], REAL_UID],
    );
    const log = jest.spyOn(console, 'log').mockImplementation(() => {});

    await expect(sweepStaleRuns(project.db, project.auth, DEV_PROJECT_ID, later)).resolves.toEqual([]);

    expect(project.paths()).toEqual(Object.keys(kept).sort());
    expect(project.accounts()).toEqual([REAL_UID]);
    for (const id of stale) expect(log).toHaveBeenCalledWith(expect.stringContaining(id));
  });

  it.each(['not-the-dev-project', `${DEV_PROJECT_ID}-2`])(
    'never touches %s, even with SECURITY_BOUNDARY_ALLOW_NON_DEV=1',
    async (projectId) => {
      const before = process.env.SECURITY_BOUNDARY_ALLOW_NON_DEV;
      process.env.SECURITY_BOUNDARY_ALLOW_NON_DEV = '1';
      const untouchable = new Proxy({}, {
        get: () => {
          throw new Error('the sweep reached a project that is not dev');
        },
      });
      jest.spyOn(console, 'log').mockImplementation(() => {});
      try {
        await expect(
          sweepStaleRuns(untouchable as Firestore, untouchable as Auth, projectId, later),
        ).resolves.toEqual([]);
      } finally {
        if (before === undefined) delete process.env.SECURITY_BOUNDARY_ALLOW_NON_DEV;
        else process.env.SECURITY_BOUNDARY_ALLOW_NON_DEV = before;
      }
    },
  );

  it('refuses to sweep more than 25 rows, and deletes none of them', async () => {
    const stale = Array.from({ length: 26 }, (_, i) => `user-w8-${1777300000000 + i}-0a1b2c3d`);
    const project = fakeProject(Object.assign({}, ...stale.map(row)), stale);
    await expect(sweepStaleRuns(project.db, project.auth, DEV_PROJECT_ID, later)).rejects.toThrow(/26/);
    expect(project.paths()).toHaveLength(26);
    expect(project.accounts()).toHaveLength(26);
  });

  it('reports a stale row it could not delete', async () => {
    const { uid } = makeRunIds('w8');
    const project = fakeProject(row(uid), [], [`users/${uid}`]);
    jest.spyOn(console, 'log').mockImplementation(() => {});
    await expect(sweepStaleRuns(project.db, project.auth, DEV_PROJECT_ID, later)).resolves.toEqual([
      expect.stringContaining(`users/${uid}: denied`),
    ]);
    expect(project.paths()).toEqual([`users/${uid}`]);
  });
});

describe('holdSecurityConfig', () => {
  const PATH = 'global/security_config';
  const before = { capability_enforcement: true, capability_enforcement_reason: 'drill', rate_limit_enforcement: false };

  it('puts the document back as it was, dropping what the run added', async () => {
    const project = fakeProject({ [PATH]: before });
    const restore = await holdSecurityConfig(project.db);
    await project.db.collection('global').doc('security_config').set({ ...before, rate_limit_enforcement: true, updatedBy: 'a run' });

    await restore();

    expect(await project.db.collection('global').doc('security_config').get().then((snap) => snap.data())).toEqual(before);
  });

  it('removes a document the run created', async () => {
    const project = fakeProject({});
    const restore = await holdSecurityConfig(project.db);
    await project.db.collection('global').doc('security_config').set({ capability_enforcement: true });

    await restore();

    expect(project.paths()).toEqual([]);
  });

  it('rejects when the document cannot be written back', async () => {
    const project = fakeProject({ [PATH]: before }, [], [PATH]);
    const restore = await holdSecurityConfig(project.db);
    await expect(restore()).rejects.toThrow(/denied/);
  });
});

describe('the live specs', () => {
  const dir = path.join(__dirname, '..', 'e2e', 'specs', 'security-boundary');
  const seeding = readdirSync(dir)
    .filter((name) => name.endsWith('.spec.ts'))
    .map((name) => [name, readFileSync(path.join(dir, name), 'utf8')] as const)
    .filter(([, source]) => source.includes('makeRunIds('));

  // these files are outside tsc and their admin handles are error-typed, so the wiring is read here
  it.each(seeding)('%s sweeps, then cleans up through the guarded path only', (_name, source) => {
    const prefixes = [...source.matchAll(/makeRunIds\(([^)]*)\)/g)].map((match) => match[1] || "'w8'");
    expect(PREFIXES.map((prefix) => `'${prefix}'`)).toEqual(expect.arrayContaining(prefixes));
    expect(source).toMatch(/sweepStaleRuns\(\s*adminDb,\s*adminAuth,\s*projectId\s*\)/);
    expect(source).toMatch(/cleanupRun\(\s*adminDb,\s*adminAuth,\s*ids,\s*\[/);
    // the sweep finds a dead run's site by this mark, so a seed without it would be stranded
    expect(source).toMatch(/\.\.\.runSiteMark\(/);
    expect(source).not.toMatch(
      /\.deleteUser\(|recursiveDelete\(\s*adminDb\s*\.collection\('(?:users|sites|config)'\)|\.collection\('users'\)\.doc\([^)]*\)\.delete\(\)/,
    );
  });
});
