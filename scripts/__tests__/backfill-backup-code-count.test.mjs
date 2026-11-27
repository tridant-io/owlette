// run with `npm run test:scripts`
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runBackfillBackupCodeCount } from '../migrations/backfill-backup-code-count.mjs';

/** The firestore surface the script uses, over a plain map of users. */
function fakeDb(users, { beforeWrite = () => {} } = {}) {
  const writes = [];
  const selected = [];
  const query = (after = null, limit = Infinity) => ({
    select: (...fields) => {
      selected.push(fields);
      return query(after, limit);
    },
    orderBy: () => query(after, limit),
    limit: (n) => query(after, n),
    startAfter: (doc) => query(doc.id, limit),
    get: async () => {
      const docs = Object.keys(users)
        .sort()
        .filter((id) => after === null || id > after)
        .slice(0, limit)
        .map((id) => ({ id, data: () => ({ ...users[id] }) }));
      return { docs, size: docs.length };
    },
  });
  const db = {
    collection: () => ({ ...query(), doc: (uid) => ({ id: uid }) }),
    runTransaction: async (cb) =>
      cb({
        get: async (ref) => {
          beforeWrite(ref.id);
          return { exists: ref.id in users, data: () => ({ ...users[ref.id] }) };
        },
        update: (ref, data) => {
          writes.push({ uid: ref.id, data });
          users[ref.id] = { ...users[ref.id], ...data };
        },
      }),
  };
  return { db, writes, selected };
}

function accounts() {
  return {
    'a-counted': { mfaFactors: { totp: true, passkeys: 0, backupCodes: 2 }, backupCodes: ['h1', 'h2'] },
    'b-no-count': { email: 'b@example.com', mfaFactors: { totp: false, passkeys: 1 }, backupCodes: ['h1', 'h2', 'h3'] },
    'c-no-sheet': { mfaFactors: { totp: false, passkeys: 1 } },
    'd-wrong-count': { mfaFactors: { totp: true, passkeys: 0, backupCodes: 9 }, backupCodes: ['h1'] },
    'e-deleted': { mfaFactors: { totp: false, passkeys: 0 }, backupCodes: [], deletedAt: 1 },
    'f-legacy': { mfaEnrolled: true, backupCodes: ['h1'] },
  };
}

test('a dry run lists, by uid, the accounts whose count is missing or wrong and what it would set, and writes nothing', async () => {
  const users = accounts();
  const { db, writes, selected } = fakeDb(users);
  const lines = [];

  const result = await runBackfillBackupCodeCount({ db, apply: false, log: (l) => lines.push(l) });

  assert.deepEqual(result.toCount, [
    { uid: 'b-no-count', count: 3 },
    { uid: 'c-no-sheet', count: 0 },
    { uid: 'd-wrong-count', count: 1 },
    { uid: 'f-legacy', count: 1 },
  ]);
  assert.deepEqual(result.skipped, { counted: 1, deleted: 1 });
  assert.equal(result.scanned, 6);
  assert.deepEqual(result.counted, []);
  assert.deepEqual(writes, []);
  assert.deepEqual(users, accounts());
  assert.ok(lines.includes('    users/b-no-count  mfaFactors.backupCodes → 3'));
  assert.ok(lines.includes('    users/c-no-sheet  mfaFactors.backupCodes → 0'));
  // a uid and a count are all it prints, and all it reads beyond the sheet
  assert.ok(lines.every((l) => !l.includes('@')));
  assert.ok(selected.every((fields) => !fields.includes('email')));
});

test('an apply run writes only the count, beside nothing else', async () => {
  const users = accounts();
  const { db, writes } = fakeDb(users);

  const result = await runBackfillBackupCodeCount({ db, apply: true, log: () => {} });

  assert.deepEqual(result.counted, ['b-no-count', 'c-no-sheet', 'd-wrong-count', 'f-legacy']);
  assert.deepEqual(writes, [
    { uid: 'b-no-count', data: { 'mfaFactors.backupCodes': 3 } },
    { uid: 'c-no-sheet', data: { 'mfaFactors.backupCodes': 0 } },
    { uid: 'd-wrong-count', data: { 'mfaFactors.backupCodes': 1 } },
    { uid: 'f-legacy', data: { 'mfaFactors.backupCodes': 1 } },
  ]);
});

test('a sheet spent between the scan and the write is counted as it is at the write', async () => {
  const users = accounts();
  const { db, writes } = fakeDb(users, {
    beforeWrite: (uid) => {
      if (uid === 'b-no-count') users[uid] = { ...users[uid], backupCodes: ['h1'] };
    },
  });

  await runBackfillBackupCodeCount({ db, apply: true, log: () => {} });

  assert.deepEqual(writes[0], { uid: 'b-no-count', data: { 'mfaFactors.backupCodes': 1 } });
});
