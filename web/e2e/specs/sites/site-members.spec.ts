/**
 * sites — the members section of a site's settings, and the member-candidates
 * route behind its add-member search.
 *
 * the search offers the people on the other sites you administer, minus anyone
 * already on this one, and never a superadmin; a full email still adds anyone
 * with an account. site-members-e2e is this spec's own site, run by the admin
 * fixture beside site-A, so site-A's roster is what the admin may be offered:
 * member@e2e.test, and never owner@e2e.test, whose only site is site-C.
 *
 * the tests build on one another, so the file runs serially: the route is read
 * before anyone is added, then member@e2e.test is added, has their site role and
 * swoop mode changed, and is removed. afterAll takes everyone the spec added
 * back off and releases the site.
 */

import { test, expect, type Locator, type Page } from '@playwright/test';
import type { MemberCandidate } from '@/lib/memberCandidates';
import { authHeaders, mintApiKey, revokeApiKey } from '../../helpers/apiKey';
import { getAdminDb } from '../../helpers/emulator';
import { roleState } from '../../helpers/roles';
import {
  grantMembership,
  releaseFixtureSite,
  revokeMembership,
  seedSite,
  TEST_USERS,
} from '../../helpers/seed';

const SITE_ID = 'site-members-e2e';
const { member, owner, admin, superadmin } = TEST_USERS;

// the members table's columns, in order
const COLUMNS = ['member', 'role', 'swoop', 'actions'] as const;

test.describe.configure({ mode: 'serial' });

test.beforeAll(async () => {
  await seedSite({ id: SITE_ID, name: 'Site M (members e2e)', owner: 'someone-else', timezone: 'UTC' });
  await grantMembership(SITE_ID, admin.uid, 'admin');
});

test.afterAll(async () => {
  await revokeMembership(SITE_ID, member.uid);
  await revokeMembership(SITE_ID, owner.uid);
  await releaseFixtureSite(SITE_ID, admin.uid);
});

const candidatesPath = (siteId: string) => `/api/sites/${siteId}/member-candidates`;

async function readMemberRow(uid: string) {
  return (await getAdminDb().doc(`sites/${SITE_ID}/members/${uid}`).get()).data() ?? null;
}

async function activeMemberUids(): Promise<string[]> {
  const snap = await getAdminDb()
    .collection(`sites/${SITE_ID}/members`)
    .where('status', '==', 'active')
    .get();
  return snap.docs.map((doc) => doc.id);
}

// in the page, so the browser's cookie jar sends the session cookie (see access-control/admin-api-403)
async function fetchCandidates(
  page: Page,
  siteId: string,
): Promise<{ status: number; candidates: MemberCandidate[] }> {
  await page.goto('/login');
  return page.evaluate(async (path) => {
    const res = await fetch(path, { credentials: 'same-origin' });
    const body = res.ok ? ((await res.json()) as { candidates: MemberCandidate[] }) : null;
    return { status: res.status, candidates: body?.candidates ?? [] };
  }, candidatesPath(siteId));
}

const tableRow = (page: Page, email: string) =>
  page.getByRole('row').filter({ has: page.getByText(email, { exact: true }) });

const tableCell = (page: Page, email: string, column: (typeof COLUMNS)[number]) =>
  tableRow(page, email).getByRole('cell').nth(COLUMNS.indexOf(column));

const peopleYouCanAdd = (page: Page) =>
  page.getByRole('listbox', { name: 'people you can add', exact: true });

async function openMembers(page: Page) {
  await page.goto(`/admin/sites/${SITE_ID}?section=members`);
  // the table has loaded once the admin's own row is in it
  await expect(tableRow(page, admin.email)).toBeVisible();
}

async function openAddMember(page: Page) {
  await page
    .getByRole('region', { name: 'members', exact: true })
    .getByRole('button', { name: 'add member', exact: true })
    .click();
  const dialog = page.getByRole('dialog', { name: 'add member', exact: true });
  await expect(dialog).toBeVisible();
  return { dialog, search: dialog.getByRole('textbox', { name: 'name or email', exact: true }) };
}

async function choose(page: Page, dialog: Locator, field: 'role' | 'swoop', option: string) {
  await dialog.getByRole('combobox', { name: field, exact: true }).click();
  await page.getByRole('option', { name: option, exact: true }).click();
}

async function openRowMenu(page: Page, email: string) {
  await page.getByRole('button', { name: `options for ${email}`, exact: true }).click();
}

async function changeAccess(page: Page, email: string, field: 'role' | 'swoop', option: string) {
  await openRowMenu(page, email);
  await page.getByRole('menuitem', { name: 'change access...', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'change access', exact: true });
  await choose(page, dialog, field, option);
  await dialog.getByRole('button', { name: 'save', exact: true }).click();
  // it closes once the change is saved and the table has refetched
  await expect(dialog).toBeHidden();
}

test.describe('GET member-candidates', () => {
  test.describe('as a site admin', () => {
    test.use(roleState('admin'));

    test('offers the people on the other sites they run, as uid, email and name only', async ({ page }) => {
      const { status, candidates } = await fetchCandidates(page, SITE_ID);
      expect(status).toBe(200);

      const uids = candidates.map((c) => c.uid);
      expect(uids).toContain(member.uid);
      // site-C is the owner's alone, a superadmin is never offered, and the admin is on this site
      for (const uid of [owner.uid, superadmin.uid, admin.uid]) {
        expect(uids).not.toContain(uid);
      }
      for (const candidate of candidates) {
        expect(Object.keys(candidate).sort()).toEqual(['displayName', 'email', 'uid']);
      }
    });
  });

  test.describe('as a member', () => {
    test.use(roleState('member'));

    test('is refused on a site they only belong to', async ({ page }) => {
      expect((await fetchCandidates(page, 'site-A')).status).toBe(403);
    });
  });

  test('refuses an api key, even one with read and admin on the site', async ({ request }) => {
    const key = await mintApiKey({
      ownerUid: admin.uid,
      name: 'e2e-member-candidates',
      scopes: [{ resource: 'site', id: SITE_ID, permissions: ['read', 'admin'] }],
    });
    try {
      const res = await request.get(candidatesPath(SITE_ID), { headers: authHeaders(key, false) });
      const body = (await res.json()) as { code?: string };
      expect([res.status(), body.code], JSON.stringify(body)).toEqual([403, 'api_key_not_permitted']);
    } finally {
      await revokeApiKey(key);
    }
  });

  test.describe('as a superadmin', () => {
    test.use(roleState('superadmin'));

    test('offers everyone but superadmins and the people already on the site', async ({ page }) => {
      const { status, candidates } = await fetchCandidates(page, SITE_ID);
      expect(status).toBe(200);

      const emails = candidates.map((c) => c.email);
      expect(emails).toContain(member.email);
      expect(emails).toContain(owner.email);
      expect(emails).not.toContain(superadmin.email);
      const onSite = await activeMemberUids();
      expect(candidates.filter((c) => onSite.includes(c.uid))).toEqual([]);
    });
  });
});

test.describe('the members section, as a site admin', () => {
  test.use(roleState('admin'));

  // each query names one person: earlier specs leave dedicated users on site-A,
  // and under a bare `e2e` they can push member@e2e.test past the list's six rows
  test('the search offers member@e2e.test, and never the owner or a superadmin', async ({ page }) => {
    await openMembers(page);
    const { search } = await openAddMember(page);
    await search.focus();

    await search.fill('member@e2e');
    const options = peopleYouCanAdd(page).getByRole('option');
    await expect(options).toHaveCount(1);
    await expect(options).toHaveAccessibleName(/member@e2e\.test/);

    // site-C is not the admin's, and a superadmin is never offered
    for (const query of ['owner@e2e', 'super@e2e']) {
      await search.fill(query);
      await expect(page.getByText(`no one from your other sites matches “${query}”.`)).toBeVisible();
      await expect(page.getByRole('option')).toHaveCount(0);
    }
  });

  test('a picked person joins as a member with no swoop mode', async ({ page }) => {
    await openMembers(page);
    const { dialog, search } = await openAddMember(page);
    await search.fill('member@e2e');
    // a click on the person, never arrow and enter: which row leads depends on
    // the users earlier specs left on site-A
    await peopleYouCanAdd(page).getByRole('option', { name: /member@e2e\.test/ }).click();
    await dialog.getByRole('button', { name: 'add member', exact: true }).click();

    await expect(page.getByText(/member added/i)).toBeVisible();
    await expect(tableRow(page, member.email)).toBeVisible();
    const row = await readMemberRow(member.uid);
    expect(row).toMatchObject({ role: 'member', status: 'active', addedBy: admin.uid });
    expect(row).not.toHaveProperty('swoop');
  });

  test('a full email adds someone the search does not offer, with the swoop mode chosen', async ({ page }) => {
    await openMembers(page);
    const { dialog, search } = await openAddMember(page);
    await search.fill(owner.email);
    await choose(page, dialog, 'swoop', 'watch');
    await dialog.getByRole('button', { name: 'add member', exact: true }).click();

    await expect(tableRow(page, owner.email)).toBeVisible();
    expect(await readMemberRow(owner.uid)).toMatchObject({ role: 'member', status: 'active', swoop: 'view' });
  });

  test('adding someone already on the site changes nothing', async ({ page }) => {
    const before = await readMemberRow(member.uid);
    await openMembers(page);
    const { dialog, search } = await openAddMember(page);
    await search.fill(member.email);
    await dialog.getByRole('button', { name: 'add member', exact: true }).click();

    await expect(page.getByText(/already on this site/i)).toBeVisible();
    expect(await readMemberRow(member.uid)).toEqual(before);
  });

  test('change access makes a member an admin', async ({ page }) => {
    await openMembers(page);
    await changeAccess(page, member.email, 'role', 'admin');

    await expect(page.getByText(/access updated/i)).toBeVisible();
    await expect(tableCell(page, member.email, 'role')).toHaveText('admin');
    expect(await readMemberRow(member.uid)).toMatchObject({ role: 'admin' });
  });

  test('change access sets a swoop mode of control', async ({ page }) => {
    await openMembers(page);
    await changeAccess(page, member.email, 'swoop', 'control');

    await expect(tableCell(page, member.email, 'swoop')).toHaveText('control');
    expect(await readMemberRow(member.uid)).toMatchObject({ swoop: 'control' });
  });

  test('by role removes the swoop mode, and an admin controls by role', async ({ page }) => {
    await openMembers(page);
    await changeAccess(page, member.email, 'swoop', 'by role');

    await expect(tableCell(page, member.email, 'swoop')).toHaveText('control · by role');
    expect(await readMemberRow(member.uid)).not.toHaveProperty('swoop');
  });

  test('back to member, by role watches', async ({ page }) => {
    await openMembers(page);
    await changeAccess(page, member.email, 'role', 'member');

    await expect(tableCell(page, member.email, 'swoop')).toHaveText('watch · by role');
  });

  test('your own row offers remove, not change access', async ({ page }) => {
    await openMembers(page);
    await openRowMenu(page, admin.email);

    await expect(page.getByRole('menu').getByRole('menuitem')).toHaveText(['remove...']);
  });

  test('remove takes a member off the site', async ({ page }) => {
    await openMembers(page);
    await openRowMenu(page, member.email);
    await page.getByRole('menuitem', { name: 'remove...', exact: true }).click();
    const dialog = page.getByRole('dialog', { name: 'remove member', exact: true });
    await dialog.getByRole('button', { name: 'remove member', exact: true }).click();

    // by text, not by row: the table is out of the accessibility tree while the
    // dialog closes, so a missing row would prove nothing
    await expect(page.getByText(member.email, { exact: true })).toHaveCount(0);
    expect(await readMemberRow(member.uid)).toBeNull();
  });
});

test.describe('the members section, as the site owner', () => {
  test.use(roleState('owner'));

  test("the owner's own row offers nothing to change, and controls", async ({ page }) => {
    await page.goto('/admin/sites/site-C?section=members');

    await expect(tableCell(page, owner.email, 'actions')).toHaveText('—');
    await expect(tableCell(page, owner.email, 'swoop')).toHaveText('control');
  });
});
