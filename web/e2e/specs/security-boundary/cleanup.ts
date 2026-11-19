import type { Auth, UserRecord } from 'firebase-admin/auth';
import type { Firestore } from 'firebase-admin/firestore';
import { createHash, randomUUID } from 'node:crypto';

export const DEV_PROJECT_ID = 'owlette-dev-3838a';

export type RunIds = {
  runId: string;
  siteId: string;
  machineId: string;
  uid: string;
  email: string;
};

// the sweep lists ids from `user-w8-` and `site-w8-`: a prefix outside w8 would need those ranges widened
const RUN_PREFIXES = ['w8', 'w8-account', 'w8-api', 'w8-cortex', 'w8-rollback'] as const;
const EMAIL_DOMAIN = '@security-boundary.e2e';
const STALE_AFTER_MS = 24 * 60 * 60 * 1000;
const SWEEP_LIMIT = 25;

const RUN_ID = `(?:${RUN_PREFIXES.join('|')})-(\\d{13})-[0-9a-f]{8}`;
// a run's user id: [1] the base uid, [2] the run id, [3] the run's start in ms. every delete of a
// user goes through this one pattern, so a row it does not match cannot be reached.
const RUN_USER = new RegExp(`^(user-(${RUN_ID}))(?:-[a-z]+)?$`);
// a run's site id: [1] the run id, [2] the run's start in ms. the same holds for a site.
const RUN_SITE = new RegExp(`^site-(${RUN_ID})$`);

type Delete = [what: string, run: () => Promise<unknown>];

export function makeRunIds(prefix: (typeof RUN_PREFIXES)[number] = 'w8'): RunIds {
  const runId = `${prefix}-${Date.now()}-${randomUUID().slice(0, 8)}`;
  const siteId = `site-${runId}`;
  const machineId = `machine-${runId}`;
  const uid = `user-${runId}`;
  return {
    runId,
    siteId,
    machineId,
    uid,
    email: `${uid}${EMAIL_DOMAIN}`,
  };
}

/** the mark a run puts on its site document; the sweep deletes no site without it. */
export function runSiteMark(siteId: string): { e2eRun: string } {
  const run = RUN_SITE.exec(siteId);
  if (!run) throw new Error(`${siteId} is not a run's site id`);
  return { e2eRun: run[1] };
}

/**
 * where the server counts a user's calls to platform routes: under a fixed id, so no site delete
 * reaches it. the id is the limiter's own (`rateLimitSubjectDocId` of `user:<uid>`).
 */
function platformRateLimitPath(uid: string): string {
  const subject = createHash('sha256').update(`user:${uid}`).digest('hex').slice(0, 32);
  return `sites/platform_global/rate_limits/user/subjects/${subject}`;
}

function userDeletes(db: Firestore, auth: Auth, uid: string): Delete[] {
  if (!RUN_USER.test(uid)) throw new Error(`refusing to delete ${uid}: not a run's user id`);
  // api key lookups, and the replies the server caches for a day under the caller's Idempotency-Key
  const ownedIn = (name: string): Delete => [
    `${name} of ${uid}`,
    async () => {
      const owned = await db.collection(name).where('userId', '==', uid).get();
      await Promise.all(owned.docs.map((doc) => doc.ref.delete()));
    },
  ];
  return [
    ownedIn('api_keys'),
    ownedIn('idempotency_cache'),
    [`platform rate limit of ${uid}`, () => db.recursiveDelete(db.doc(platformRateLimitPath(uid)))],
    [`users/${uid}`, () => db.recursiveDelete(db.collection('users').doc(uid))],
    [
      `auth user ${uid}`,
      () =>
        auth.deleteUser(uid).catch((err: unknown) => {
          if ((err as { code?: string })?.code !== 'auth/user-not-found') throw err;
        }),
    ],
  ];
}

function siteDeletes(db: Firestore, siteId: string): Delete[] {
  if (!RUN_SITE.test(siteId)) throw new Error(`refusing to delete ${siteId}: not a run's site id`);
  return [
    [`sites/${siteId}`, () => db.recursiveDelete(db.collection('sites').doc(siteId))],
    [`config/${siteId}`, () => db.recursiveDelete(db.collection('config').doc(siteId))],
    // the tombstone DELETE /api/users/me writes when it removes the run's site
    [`site_ids/${siteId}`, () => db.collection('site_ids').doc(siteId).delete()],
    [
      `chat_conversations of ${siteId}`,
      async () => {
        const chats = await db.collection('chat_conversations').where('siteId', '==', siteId).get();
        await Promise.all(chats.docs.map((chat) => db.recursiveDelete(chat.ref)));
      },
    ],
  ];
}

async function settle(deletes: Delete[]): Promise<string[]> {
  const results = await Promise.allSettled(deletes.map(async ([, run]) => run()));
  return results.flatMap((result, i) =>
    result.status === 'rejected'
      ? [`${deletes[i][0]}: ${result.reason instanceof Error ? result.reason.message : String(result.reason)}`]
      : [],
  );
}

/**
 * deletes what a run seeded: each user's row, api key lookups and auth account, and the run's
 * site, config and chats. throws before any delete on an id that is not this run's; returns one
 * line per delete that failed, for the caller to report.
 */
export async function cleanupRun(
  db: Firestore,
  auth: Auth,
  ids: Pick<RunIds, 'uid' | 'siteId'>,
  uids: string[],
): Promise<string[]> {
  const run = RUN_USER.exec(ids.uid);
  if (!run || run[1] !== ids.uid || ids.siteId !== `site-${run[2]}`) {
    throw new Error(`refusing to clean up: ${ids.uid} and ${ids.siteId} are not one run's ids`);
  }
  for (const uid of uids) {
    if (RUN_USER.exec(uid)?.[1] !== ids.uid) {
      throw new Error(`refusing to clean up: ${uid} is not a user of run ${ids.uid}`);
    }
  }

  return settle([...uids.flatMap((uid) => userDeletes(db, auth, uid)), ...siteDeletes(db, ids.siteId)]);
}

/**
 * true for a user a run of this suite seeded more than a day ago, so no live run owns it. `data`
 * is the users row, or the auth account when the row is gone.
 */
export function isStaleRunUser(id: string, data: { email?: unknown }, now: number): boolean {
  const run = RUN_USER.exec(id);
  return run !== null && data.email === `${id}${EMAIL_DOMAIN}` && now - Number(run[3]) > STALE_AFTER_MS;
}

/** the same for a site: the id's shape, the run's own mark on the document, and more than a day old. */
export function isStaleRunSite(id: string, data: { e2eRun?: unknown }, now: number): boolean {
  const run = RUN_SITE.exec(id);
  return run !== null && data.e2eRun === run[1] && now - Number(run[2]) > STALE_AFTER_MS;
}

async function listAccounts(auth: Auth): Promise<UserRecord[]> {
  const accounts: UserRecord[] = [];
  let pageToken: string | undefined;
  do {
    const page = await auth.listUsers(1000, pageToken);
    accounts.push(...page.users);
    pageToken = page.pageToken;
  } while (pageToken);
  return accounts;
}

/**
 * removes what runs left when they died before their own cleanup (timeout, ctrl-c): users found
 * by their row or by their auth account, and sites with their config and chats.
 */
export async function sweepStaleRuns(
  db: Firestore,
  auth: Auth,
  projectId: string,
  now = Date.now(),
): Promise<string[]> {
  // SECURITY_BOUNDARY_ALLOW_NON_DEV opens the specs to another project; it never opens this
  if (projectId !== DEV_PROJECT_ID) {
    console.log(`[security-boundary] stale-run sweep skipped: ${projectId} is not ${DEV_PROJECT_ID}`);
    return [];
  }

  // '.' is the character after '-', so this is every id that starts `<prefix>-`
  const idsFrom = (name: string, prefix: string) =>
    db.collection(name).where('__name__', '>=', `${prefix}-`).where('__name__', '<', `${prefix}.`).get();
  const [rows, sites, accounts] = await Promise.all([
    idsFrom('users', 'user-w8'),
    idsFrom('sites', 'site-w8'),
    listAccounts(auth),
  ]);
  const staleUsers = [
    ...new Set([
      ...rows.docs.filter((row) => isStaleRunUser(row.id, row.data(), now)).map((row) => row.id),
      ...accounts.filter((account) => isStaleRunUser(account.uid, account, now)).map((account) => account.uid),
    ]),
  ];
  const staleSites = sites.docs.filter((site) => isStaleRunSite(site.id, site.data(), now)).map((site) => site.id);
  for (const [what, stale] of [['users', staleUsers], ['sites', staleSites]] as const) {
    if (stale.length > SWEEP_LIMIT) {
      throw new Error(`refusing to sweep ${stale.length} stale run ${what}: over ${SWEEP_LIMIT} is not a few dead runs`);
    }
  }

  const leftovers: string[] = [];
  const sweeps: Array<[what: string, deletes: Delete[]]> = [
    ...staleUsers.map((uid): [string, Delete[]] => [`user ${uid}`, userDeletes(db, auth, uid)]),
    ...staleSites.map((siteId): [string, Delete[]] => [`site ${siteId}`, siteDeletes(db, siteId)]),
  ];
  for (const [what, deletes] of sweeps) {
    const failed = await settle(deletes);
    if (failed.length === 0) console.log(`[security-boundary] swept stale run ${what}`);
    leftovers.push(...failed);
  }
  return leftovers;
}

/**
 * global/security_config holds the enforcement switches of the whole project, and two specs
 * write to it. returns a function that puts the document back as it was when this was called;
 * that also undoes a flip someone else made while the run was going.
 */
export async function holdSecurityConfig(db: Firestore): Promise<() => Promise<unknown>> {
  const ref = db.collection('global').doc('security_config');
  const before = (await ref.get()).data();
  return () => (before ? ref.set(before) : ref.delete());
}
