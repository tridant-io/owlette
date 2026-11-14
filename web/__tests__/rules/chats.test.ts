/**
 * @jest-environment node
 *
 * chats/{chatId} client writes. A client writes only its own chats, and only
 * as a person's chat: `source` absent or `'user'`. The server writes the other
 * sources, and whole-site members read `autonomous` ones.
 *
 * RUN: `npm run test:rules` — needs the emulator on :8080, so the default
 * jest run skips it.
 */

import { assertFails, assertSucceeds } from '@firebase/rules-unit-testing';
import { doc, getDoc, setDoc, updateDoc } from 'firebase/firestore';
import {
  asUser,
  cleanupRulesHarness,
  clearFirestoreData,
  initRulesHarness,
  seedAsAdmin,
} from './harness';

const SITE = 'site-A';
const OWNER = 'owner-uid';
const COLLEAGUE = 'colleague-uid';

beforeAll(async () => {
  await initRulesHarness();
});

afterAll(async () => {
  await cleanupRulesHarness();
});

beforeEach(async () => {
  await clearFirestoreData();
  await seedAsAdmin(async (db) => {
    await setDoc(doc(db, 'sites', SITE), { owner: 'someone-else', name: 'Site A' });
  });
});

describe('chats: create', () => {
  it('a member creates their own chat with no source', async () => {
    const db = await asUser(OWNER, 'member', [SITE]);
    await assertSucceeds(setDoc(doc(db, 'chats', 'c1'), { userId: OWNER, siteId: SITE, title: 'hi' }));
  });

  it("a member creates their own chat as source 'user'", async () => {
    const db = await asUser(OWNER, 'member', [SITE]);
    await assertSucceeds(
      setDoc(doc(db, 'chats', 'c1'), { userId: OWNER, siteId: SITE, source: 'user', title: 'hi' }),
    );
  });

  it.each(['autonomous', 'talon', 'followup'])('a member cannot create a %s chat', async (source) => {
    const db = await asUser(OWNER, 'admin', [SITE]);
    await assertFails(
      setDoc(doc(db, 'chats', 'c1'), { userId: OWNER, siteId: SITE, source, title: 'Auto: x crashed' }),
    );
  });

  it('a whole-site colleague never reads a member-created chat', async () => {
    const owner = await asUser(OWNER, 'member', [SITE]);
    await assertFails(
      setDoc(doc(owner, 'chats', 'c1'), { userId: OWNER, siteId: SITE, source: 'autonomous' }),
    );
    const colleague = await asUser(COLLEAGUE, 'admin', [SITE]);
    await assertFails(getDoc(doc(colleague, 'chats', 'c1')));
  });
});

describe('chats: update', () => {
  it('the owner renames their own chat', async () => {
    await seedAsAdmin(async (db) => {
      await setDoc(doc(db, 'chats', 'c1'), { userId: OWNER, siteId: SITE, title: 'old' });
    });
    const db = await asUser(OWNER, 'member', [SITE]);
    await assertSucceeds(setDoc(doc(db, 'chats', 'c1'), { title: 'new' }, { merge: true }));
  });

  it('the owner renames a talon chat the server made for them', async () => {
    await seedAsAdmin(async (db) => {
      await setDoc(doc(db, 'chats', 'c1'), { userId: OWNER, siteId: SITE, source: 'talon', title: 'talon: x' });
    });
    const db = await asUser(OWNER, 'member', [SITE]);
    await assertSucceeds(setDoc(doc(db, 'chats', 'c1'), { title: 'renamed' }, { merge: true }));
  });

  it("the owner cannot turn their chat into a site's autonomous chat", async () => {
    await seedAsAdmin(async (db) => {
      await setDoc(doc(db, 'chats', 'c1'), { userId: OWNER, siteId: SITE, title: 'mine' });
    });
    const db = await asUser(OWNER, 'admin', [SITE]);
    await assertFails(updateDoc(doc(db, 'chats', 'c1'), { source: 'autonomous' }));
  });

  it("the owner cannot change a talon chat's source", async () => {
    await seedAsAdmin(async (db) => {
      await setDoc(doc(db, 'chats', 'c1'), { userId: OWNER, siteId: SITE, source: 'talon' });
    });
    const db = await asUser(OWNER, 'admin', [SITE]);
    await assertFails(updateDoc(doc(db, 'chats', 'c1'), { source: 'autonomous' }));
  });
});

describe('chats: autonomous reads still work', () => {
  it('a whole-site member reads a server-written autonomous chat', async () => {
    await seedAsAdmin(async (db) => {
      await setDoc(doc(db, 'chats', 'auto-1'), { source: 'autonomous', siteId: SITE, title: 'Auto: x' });
    });
    const colleague = await asUser(COLLEAGUE, 'member', [SITE]);
    await assertSucceeds(getDoc(doc(colleague, 'chats', 'auto-1')));
  });
});
