import { Timestamp } from 'firebase-admin/firestore';
import { fromChangeDoc, fromDecisionDoc, fromFindingDoc } from './rows';
import {
  ACTIVITY_FINDINGS_COLLECTION,
  AUTH_CAPABILITIES,
  MUTATION_KINDS,
  type ActivityRow,
  type ActivityView,
} from './types';

type Db = FirebaseFirestore.Firestore;
type Query = FirebaseFirestore.Query;
type Snap = FirebaseFirestore.QueryDocumentSnapshot;
type Data = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

const SCAN_BATCH = 100;
const SCAN_CAP = 300;
const MAX_ACTORS = 30; // firestore's `in` limit
const REFUSED = ['deny', 'error'];

export class InvalidPageTokenError extends Error {
  constructor() {
    super('invalid page token');
  }
}

export interface ActivityPageOptions {
  view: ActivityView;
  userId?: string;
  siteId?: string;
  pageSize: number;
  pageToken?: string | null;
}

interface Source {
  build: (upper: number | null) => Query;
  map: (doc: Snap) => ActivityRow;
  // present = the query cannot filter this, so docs are read in batches and filtered here
  keep?: (row: ActivityRow, data: Data) => boolean;
}

interface Cursor {
  t: number;
  ids: string[];
}

function encodeToken(cursor: Cursor): string {
  return Buffer.from(JSON.stringify(cursor)).toString('base64url');
}

function decodeToken(token: string | null | undefined): Cursor | null {
  if (!token) return null;
  try {
    const parsed = JSON.parse(Buffer.from(token, 'base64url').toString('utf8'));
    if (
      typeof parsed?.t === 'number' &&
      Number.isFinite(parsed.t) &&
      Array.isArray(parsed.ids) &&
      parsed.ids.every((id: unknown) => typeof id === 'string')
    ) {
      return { t: parsed.t, ids: parsed.ids };
    }
  } catch {
    // falls through
  }
  throw new InvalidPageTokenError();
}

// ms-numeric time field (change rows, findings) or Timestamp field (decision rows), newest first
const byMs = (q: Query, field: string, upper: number | null): Query =>
  (upper === null ? q : q.where(field, '<', upper)).orderBy(field, 'desc');
const byTs = (q: Query, field: string, upper: number | null): Query =>
  (upper === null ? q : q.where(field, '<', Timestamp.fromMillis(upper))).orderBy(field, 'desc');

// decision 5: a user's changes are named `user:<uid>`, `cortex:user_<uid>` when hoot made them, or `apiKey:<id>` when a key did
async function loadActors(db: Db, userId: string): Promise<string[]> {
  const keys = await db
    .collection('users')
    .doc(userId)
    .collection('api_keys')
    .limit(MAX_ACTORS - 2)
    .get();
  return [`user:${userId}`, `cortex:user_${userId}`, ...keys.docs.map((d) => `apiKey:${d.id}`)];
}

const isMutation = (data: Data) => (MUTATION_KINDS as readonly string[]).includes(data.event?.kind);
const isRefused = (data: Data) => REFUSED.includes(data.outcome);
const isAuth = (data: Data) => (AUTH_CAPABILITIES as readonly string[]).includes(data.capability);

function buildSources(db: Db, opts: ActivityPageOptions, actors: string[] | null): Source[] {
  const { view, userId, siteId } = opts;
  const all = view === 'all';
  const group = db.collectionGroup('audit_log');
  const entries = db.collection('global').doc('audit_log').collection('entries');
  const sources: Source[] = [];

  if (all || view === 'changes') {
    if (siteId) {
      sources.push({
        build: (u) => byMs(db.collection('sites').doc(siteId).collection('audit_log'), 'recordedAt', u),
        map: fromChangeDoc,
        keep: (_r, d) => isMutation(d) && (!actors || actors.includes(d.event?.actor)),
      });
    } else if (actors) {
      sources.push({
        build: (u) => byMs(group.where('event.actor', 'in', actors), 'recordedAt', u),
        map: fromChangeDoc,
        keep: (_r, d) => isMutation(d),
      });
    } else {
      sources.push({
        build: (u) => byMs(group.where('event.kind', 'in', MUTATION_KINDS), 'recordedAt', u),
        map: fromChangeDoc,
      });
    }
  }

  if (all || view === 'refused') {
    const mine = (d: Data) => !userId || d.actor?.userId === userId;
    if (siteId) {
      sources.push({
        build: (u) => byTs(db.collection('sites').doc(siteId).collection('audit_log'), 'timestamp', u),
        map: (d) => fromDecisionDoc(d, 'decision', siteId),
        keep: (_r, d) => isRefused(d) && mine(d),
      });
    } else {
      const scoped = (q: Query) => (userId ? q.where('actor.userId', '==', userId) : q.where('outcome', 'in', REFUSED));
      const keep = userId ? (_r: ActivityRow, d: Data) => isRefused(d) : undefined;
      sources.push(
        {
          build: (u) => byTs(scoped(group), 'timestamp', u),
          map: (d) => fromDecisionDoc(d, 'decision', d.ref.parent.parent?.id ?? null),
          keep,
        },
        {
          build: (u) => byTs(scoped(entries), 'timestamp', u),
          map: (d) => fromDecisionDoc(d, 'platform', null),
          keep,
        },
      );
    }
  }

  if ((all || view === 'sign-ins') && !siteId) {
    sources.push({
      build: (u) =>
        byTs(
          userId ? entries.where('actor.userId', '==', userId) : entries.where('capability', 'in', AUTH_CAPABILITIES),
          'timestamp',
          u,
        ),
      map: (d) => fromDecisionDoc(d, 'platform', null),
      keep: userId ? (_r, d) => isAuth(d) : undefined,
    });
  }

  if (all || view === 'flagged') {
    const [a, b, c] = ACTIVITY_FINDINGS_COLLECTION.split('/');
    sources.push({
      build: (u) => byMs(db.collection(a).doc(b).collection(c), 'detectedAt', u),
      map: fromFindingDoc,
      keep:
        userId || siteId
          ? (_r, d) =>
              (!userId || d.subject?.userId === userId) && (!siteId || d.subject?.siteId === siteId)
          : undefined,
    });
  }

  return sources;
}

interface SourceRead {
  rows: ActivityRow[];
  // the source has more than it returned
  truncated: boolean;
  // set when the scan cap stopped it: rows older than this may be missing
  horizon: number | null;
}

async function readSource(source: Source, upper: number | null, need: number, skip: Set<string>): Promise<SourceRead> {
  if (!source.keep) {
    const snap = await source.build(upper).limit(need).get();
    return {
      rows: snap.docs.map(source.map).filter((r) => !skip.has(r.id)),
      truncated: snap.docs.length >= need,
      horizon: null,
    };
  }

  const rows: ActivityRow[] = [];
  let scanned = 0;
  let last: Snap | null = null;
  let lastAt = 0;
  while (scanned < SCAN_CAP) {
    let query = source.build(upper).limit(SCAN_BATCH);
    if (last) query = query.startAfter(last);
    const { docs } = await query.get();
    for (const doc of docs) {
      const row = source.map(doc);
      if (source.keep(row, doc.data()) && !skip.has(row.id)) rows.push(row);
      lastAt = row.at;
      if (rows.length >= need) return { rows, truncated: true, horizon: null };
    }
    scanned += docs.length;
    if (docs.length < SCAN_BATCH) return { rows, truncated: false, horizon: null };
    last = docs[docs.length - 1];
  }
  return { rows, truncated: true, horizon: lastAt };
}

const newestFirst = (a: ActivityRow, b: ActivityRow) => b.at - a.at || (a.id < b.id ? 1 : -1);

export async function loadActivityPage(
  db: Db,
  opts: ActivityPageOptions,
): Promise<{ rows: ActivityRow[]; nextPageToken: string }> {
  const cursor = decodeToken(opts.pageToken);
  const skip = new Set(cursor?.ids);
  const upper = cursor ? cursor.t + 1 : null;
  const need = opts.pageSize + 1 + skip.size;
  const actors =
    opts.userId && (opts.view === 'all' || opts.view === 'changes') ? await loadActors(db, opts.userId) : null;

  const reads = await Promise.all(
    buildSources(db, opts, actors).map((s) => readSource(s, upper, need, skip)),
  );

  // a deny row with an auth capability comes from two sources
  const byId = new Map<string, ActivityRow>();
  let truncated = false;
  let horizon: number | null = null;
  for (const read of reads) {
    for (const row of read.rows) byId.set(row.id, row);
    truncated ||= read.truncated;
    if (read.horizon !== null) horizon = Math.max(horizon ?? read.horizon, read.horizon);
  }

  const merged = [...byId.values()]
    .filter((r) => horizon === null || r.at > horizon)
    .sort(newestFirst);
  const rows = merged.slice(0, opts.pageSize);

  const overflow = merged.length > opts.pageSize;
  if (!overflow && !truncated) return { rows, nextPageToken: '' };
  // the page ends at the horizon: nothing at or below it was sent, so nothing is skipped
  if (!overflow && horizon !== null) return { rows, nextPageToken: encodeToken({ t: horizon, ids: [] }) };
  const t = rows[rows.length - 1]?.at;
  if (t === undefined) return { rows, nextPageToken: '' };
  const ids = rows.filter((r) => r.at === t).map((r) => r.id);
  if (cursor?.t === t) ids.push(...cursor.ids);
  return { rows, nextPageToken: encodeToken({ t, ids }) };
}

// every row the detection rules read, newest first. all queries are descending with a `>` bound
// so the existing (field asc, time desc) composite indexes serve them (decision 12)
export async function loadActivitySince(db: Db, startMs: number): Promise<ActivityRow[]> {
  const group = db.collectionGroup('audit_log');
  const entries = db.collection('global').doc('audit_log').collection('entries');
  const after = Timestamp.fromMillis(startMs);
  const decisions = (q: Query) => q.where('timestamp', '>', after).orderBy('timestamp', 'desc');
  const platform = (d: Snap) => fromDecisionDoc(d, 'platform', null);

  const [changes, siteRefused, platformRefused, signIns, siteDeletes] = await Promise.all([
    group
      .where('event.kind', 'in', MUTATION_KINDS)
      .where('recordedAt', '>', startMs)
      .orderBy('recordedAt', 'desc')
      .get()
      .then((s) => s.docs.map(fromChangeDoc)),
    decisions(group.where('outcome', 'in', REFUSED))
      .get()
      .then((s) => s.docs.map((d) => fromDecisionDoc(d, 'decision', d.ref.parent.parent?.id ?? null))),
    decisions(entries.where('outcome', 'in', REFUSED)).get().then((s) => s.docs.map(platform)),
    decisions(entries.where('capability', 'in', AUTH_CAPABILITIES)).get().then((s) => s.docs.map(platform)),
    decisions(entries.where('capability', '==', 'SITE_DELETE')).get().then((s) => s.docs.map(platform)),
  ]);

  const byId = new Map<string, ActivityRow>();
  for (const row of [...changes, ...siteRefused, ...platformRefused, ...signIns, ...siteDeletes]) {
    byId.set(row.id, row);
  }
  return [...byId.values()].sort(newestFirst);
}
