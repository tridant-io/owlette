/**
 * @jest-environment node
 *
 * `sites/{siteId}/machines/{machineId}/commands/pending` holds what the service
 * executes, so an agent token may only take entries out of it. every fielded agent
 * adds to `commands/completed` and field-deletes from `commands/pending`; nothing it
 * does adds or changes a key there. server routes use the admin SDK and bypass rules.
 */

import { assertFails, assertSucceeds } from '@firebase/rules-unit-testing';
import { deleteDoc, deleteField, doc, getDoc, setDoc, updateDoc } from 'firebase/firestore';
import type { Firestore } from 'firebase/firestore';
import {
  asAgent,
  asUser,
  cleanupRulesHarness,
  clearFirestoreData,
  initRulesHarness,
  seedAsAdmin,
} from './harness';

const SITE = 'site-A';
const MACHINE = 'machine-X';
const OTHER_MACHINE = 'machine-Y';
const MEMBER_UID = 'member-uid';

const command = (type = 'restart_process') => ({
  type,
  status: 'pending',
  timestamp: 1,
});

function commands(db: Firestore, name: string, machine = MACHINE) {
  return doc(db, 'sites', SITE, 'machines', machine, 'commands', name);
}

async function seedPending(data: Record<string, unknown> = { 'cmd-1': command(), 'cmd-2': command() }) {
  await seedAsAdmin(async (db) => {
    await setDoc(commands(db, 'pending'), data);
  });
}

async function pendingKeys(): Promise<string[]> {
  let keys: string[] = [];
  await seedAsAdmin(async (db) => {
    keys = Object.keys((await getDoc(commands(db, 'pending'))).data() ?? {}).sort();
  });
  return keys;
}

beforeAll(async () => {
  await initRulesHarness();
});

afterAll(async () => {
  await cleanupRulesHarness();
});

beforeEach(async () => {
  await clearFirestoreData();
});

describe('an agent on its own commands/pending', () => {
  const agent = () => asAgent(SITE, MACHINE);

  test('removes one entry, leaving the rest', async () => {
    await seedPending();

    await assertSucceeds(updateDoc(commands(agent(), 'pending'), { 'cmd-1': deleteField() }));

    expect(await pendingKeys()).toEqual(['cmd-2']);
  });

  test('removes a chunk of entries, as the stale sweep does', async () => {
    await seedPending();

    await assertSucceeds(
      updateDoc(commands(agent(), 'pending'), {
        'cmd-1': deleteField(),
        'cmd-2': deleteField(),
      }),
    );

    expect(await pendingKeys()).toEqual([]);
  });

  test('removing an entry that is already gone changes nothing and is allowed', async () => {
    await seedPending();

    await assertSucceeds(updateDoc(commands(agent(), 'pending'), { gone: deleteField() }));

    expect(await pendingKeys()).toEqual(['cmd-1', 'cmd-2']);
  });

  test('may not add an entry', async () => {
    await seedPending();

    await assertFails(
      setDoc(commands(agent(), 'pending'), { forged: command('update_owlette') }, { merge: true }),
    );
    await assertFails(updateDoc(commands(agent(), 'pending'), { forged: command('update_owlette') }));

    expect(await pendingKeys()).toEqual(['cmd-1', 'cmd-2']);
  });

  test('may not change an entry the server queued', async () => {
    await seedPending();

    await assertFails(
      setDoc(commands(agent(), 'pending'), { 'cmd-1': command('update_owlette') }, { merge: true }),
    );
    await assertFails(updateDoc(commands(agent(), 'pending'), { 'cmd-1.type': 'update_owlette' }));
  });

  test('may not remove one entry and add another in the same write', async () => {
    await seedPending();

    await assertFails(
      updateDoc(commands(agent(), 'pending'), {
        'cmd-1': deleteField(),
        forged: command('update_owlette'),
      }),
    );

    expect(await pendingKeys()).toEqual(['cmd-1', 'cmd-2']);
  });

  test('may not replace the whole document with a different command', async () => {
    await seedPending();

    await assertFails(setDoc(commands(agent(), 'pending'), { forged: command('update_owlette') }));
  });

  test('may not create the document when there is none', async () => {
    await assertFails(
      setDoc(commands(agent(), 'pending'), { forged: command('update_owlette') }, { merge: true }),
    );
    await assertFails(setDoc(commands(agent(), 'pending'), {}));
  });

  test('may still delete the document', async () => {
    await seedPending();

    await assertSucceeds(deleteDoc(commands(agent(), 'pending')));
  });

  test('may still read it', async () => {
    await seedPending();

    await assertSucceeds(getDoc(commands(agent(), 'pending')));
  });
});

describe('everyone else on commands/pending', () => {
  test("an agent cannot touch another machine's pending, even to remove", async () => {
    await seedAsAdmin(async (db) => {
      await setDoc(commands(db, 'pending', OTHER_MACHINE), { 'cmd-1': command() });
    });

    await assertFails(
      updateDoc(commands(asAgent(SITE, MACHINE), 'pending', OTHER_MACHINE), {
        'cmd-1': deleteField(),
      }),
    );
  });

  test('a site member cannot remove an entry directly', async () => {
    await seedPending();
    const member = await asUser(MEMBER_UID, 'member', [SITE]);

    await assertFails(updateDoc(commands(member, 'pending'), { 'cmd-1': deleteField() }));
  });
});

describe('an agent on commands/completed, unchanged', () => {
  const agent = () => asAgent(SITE, MACHINE);

  test('records a finished command, creating the document on the first one', async () => {
    await assertSucceeds(
      setDoc(
        commands(agent(), 'completed'),
        { 'cmd-1': { status: 'completed', result: 'ok' } },
        { merge: true },
      ),
    );
  });

  test('overwrites a running marker and sweeps old entries', async () => {
    await seedAsAdmin(async (db) => {
      await setDoc(commands(db, 'completed'), { 'cmd-1': { status: 'running' } });
    });

    await assertSucceeds(
      setDoc(commands(agent(), 'completed'), { 'cmd-1': { status: 'completed' } }, { merge: true }),
    );
    await assertSucceeds(updateDoc(commands(agent(), 'completed'), { 'cmd-1': deleteField() }));
  });
});
