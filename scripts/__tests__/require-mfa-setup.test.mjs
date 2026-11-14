// run with `npm run test:scripts`
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runRequireMfaSetup } from '../migrations/require-mfa-setup.mjs';

/** The firestore surface the script uses, over a plain map of users. */
function fakeDb(users, passkeys = {}, { beforeWrite = () => {} } = {}) {
  const writes = [];
  const query = (after = null, limit = Infinity) => ({
    select: () => query(after, limit),
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
    collection: () => ({
      ...query(),
      doc: (uid) => ({
        id: uid,
        collection: () => ({
          count: () => ({ get: async () => ({ data: () => ({ count: passkeys[uid] ?? 0 }) }) }),
        }),
      }),
    }),
    runTransaction: async (cb) => {
      return cb({
        get: async (ref) => {
          beforeWrite(ref.id);
          return { exists: ref.id in users, data: () => ({ ...users[ref.id] }) };
        },
        update: (ref, data) => {
          writes.push({ uid: ref.id, data });
          users[ref.id] = { ...users[ref.id], ...data };
        },
      });
    },
  };
  return { db, writes };
}

const NONE = { totp: false, passkeys: 0 };

function accounts() {
  return {
    'a-no-factor': { email: 'a@example.com', mfaEnrolled: false, mfaFactors: NONE },
    'b-totp': { mfaEnrolled: true, mfaFactors: { totp: true, passkeys: 0 } },
    'c-passkey': { mfaEnrolled: true, mfaFactors: { totp: false, passkeys: 2 } },
    'd-legacy-passkey': { mfaEnrolled: false },
    'e-legacy-none': { email: 'e@example.com' },
    'f-deleted': { mfaFactors: NONE, deletedAt: 1 },
    'g-already': { mfaFactors: NONE, requiresMfaSetup: true },
    'h-legacy-totp': { mfaEnrolled: true },
  };
}

test('a dry run lists the active accounts with no factor and writes nothing', async () => {
  const users = accounts();
  const { db, writes } = fakeDb(users, { 'd-legacy-passkey': 1 });
  const lines = [];

  const result = await runRequireMfaSetup({ db, apply: false, log: (l) => lines.push(l) });

  assert.deepEqual(result.toRequire.map((u) => u.uid), ['a-no-factor', 'e-legacy-none']);
  assert.deepEqual(result.skipped, { deleted: 1, 'already-required': 1, 'has-factor': 4 });
  assert.equal(result.scanned, 8);
  assert.deepEqual(result.required, []);
  assert.deepEqual(writes, []);
  assert.deepEqual(users, accounts());
  assert.ok(lines.some((l) => l.includes('users/a-no-factor') && l.includes('a@example.com')));
  assert.ok(lines.some((l) => l.includes('users/e-legacy-none')));
});

test('an apply run flags exactly those accounts, and nothing else', async () => {
  const users = accounts();
  const { db, writes } = fakeDb(users, { 'd-legacy-passkey': 1 });

  const result = await runRequireMfaSetup({ db, apply: true, log: () => {} });

  assert.deepEqual(result.required, ['a-no-factor', 'e-legacy-none']);
  assert.deepEqual(writes, [
    { uid: 'a-no-factor', data: { requiresMfaSetup: true } },
    { uid: 'e-legacy-none', data: { requiresMfaSetup: true } },
  ]);
});

test('an account that enrols between the scan and its write is left alone', async () => {
  const users = accounts();
  const { db, writes } = fakeDb(users, { 'd-legacy-passkey': 1 }, {
    beforeWrite: (uid) => {
      if (uid === 'e-legacy-none') users[uid] = { mfaEnrolled: true, mfaFactors: { totp: true, passkeys: 0 } };
    },
  });

  const result = await runRequireMfaSetup({ db, apply: true, log: () => {} });

  assert.deepEqual(result.required, ['a-no-factor']);
  assert.deepEqual(writes.map((w) => w.uid), ['a-no-factor']);
  assert.equal(users['e-legacy-none'].requiresMfaSetup, undefined);
});
