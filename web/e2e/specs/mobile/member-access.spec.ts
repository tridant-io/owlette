/**
 * a person's access in the members section on a phone: 390x844 with touch, from
 * the `mobile-chromium` project in playwright.config.ts, which runs only
 * `mobile/` specs. `sites/member-access.spec.ts` covers what the editor saves;
 * this one measures it, by the owner's phone rules: no control clipped, and
 * headers on one row.
 *
 * below md the access column is not rendered, and the access rides the role line
 * after the swoop label. both dialogs scroll inside themselves on a short screen,
 * so their buttons stay reachable.
 *
 * every control is measured with `expectFullyWithinViewport` before it is tapped.
 * nothing here saves: each dialog is left by cancel, and the rows stay as seeded.
 *
 * isolation: a site, a machine and two users of the spec's own, all removed in
 * afterAll. no fixture signs in, so no saved site moves.
 */

import crypto from 'crypto';
import { test, expect, type Locator, type Page } from '@playwright/test';
import { dedicatedUser, seedDedicatedUser } from '../../helpers/coverageSeed';
import { getAdminAuth, getAdminDb } from '../../helpers/emulator';
import { assertNoHorizontalOverflow, expectFullyWithinViewport } from '../../helpers/mobile';
import { grantMembership, seedMachine, seedSite, type TestUser } from '../../helpers/seed';

test.use({ storageState: { cookies: [], origins: [] } });

const SUFFIX = crypto.randomBytes(4).toString('hex');
const SITE = `site-access-phone-${SUFFIX}`;
// seeded with no name, so the picker lists it by its id
const MACHINE = `mach-access-phone-${SUFFIX}`;
// someone-else has no account, so the members list skips the owner's row
const SITE_OWNER = 'someone-else';

let siteAdmin: TestUser;
let target: TestUser;

test.beforeAll(async () => {
  // `sites: []`: dedicatedUser puts every user on site-A
  const seedPerson = (name: string) =>
    seedDedicatedUser({ ...dedicatedUser('member', `access-phone-${name}-${SUFFIX}`), sites: [] });
  siteAdmin = await seedPerson('admin');
  target = await seedPerson('target');

  await seedSite({ id: SITE, name: `access phone ${SUFFIX}`, owner: SITE_OWNER, timezone: 'UTC' });
  // no monitors, so no display subdocument outlives afterAll
  await seedMachine(SITE, MACHINE, { monitorCount: 0 });
  await grantMembership(SITE, siteAdmin.uid, 'admin');
  await grantMembership(SITE, target.uid, 'member');
});

test.afterAll(async () => {
  const db = getAdminDb();
  await db.doc(`sites/${SITE}/machines/${MACHINE}`).delete();
  await Promise.all(
    [SITE_OWNER, siteAdmin.uid, target.uid].map((uid) => db.doc(`sites/${SITE}/members/${uid}`).delete()),
  );
  await db.doc(`sites/${SITE}`).delete();
  await Promise.all([siteAdmin, target].map((user) => db.doc(`users/${user.uid}`).delete()));
  await Promise.all([siteAdmin, target].map((user) => getAdminAuth().deleteUser(user.uid)));
});

/** signs in through /login, as `swoop/picker.spec.ts`' fillLogin does, then opens the members section. */
async function openMembers(page: Page): Promise<void> {
  await page.goto('/login');
  await page.getByLabel(/email/i).fill(siteAdmin.email);
  await page.getByLabel(/password/i).first().fill(siteAdmin.password);
  await page.getByRole('button', { name: /sign in with email/i }).click();
  await expect(page).toHaveURL(/\/dashboard/, { timeout: 20_000 });
  await page.goto(`/admin/sites/${SITE}?section=members`);
  await expect(targetRow(page)).toBeVisible();
}

const targetRow = (page: Page) => page.getByRole('row').filter({ hasText: target.email });

const accessChoice = (dialog: Locator, name: 'whole site' | 'some machines') =>
  dialog.getByRole('group', { name: 'access', exact: true }).getByRole('button', { name, exact: true });

async function openChangeAccess(page: Page): Promise<Locator> {
  const options = targetRow(page).getByRole('button', { name: `options for ${target.email}`, exact: true });
  await expectFullyWithinViewport(page, options, 'the row options button');
  await options.tap();
  const item = page.getByRole('menuitem', { name: 'change access...', exact: true });
  await expectFullyWithinViewport(page, item, 'change access...');
  await item.tap();
  const dialog = page.getByRole('dialog', { name: 'change access', exact: true });
  await expect(dialog).toBeVisible();
  return dialog;
}

async function openAddMember(page: Page): Promise<Locator> {
  const add = page
    .getByRole('region', { name: 'members', exact: true })
    .getByRole('button', { name: 'add member', exact: true });
  await expectFullyWithinViewport(page, add, 'add member');
  await add.tap();
  const dialog = page.getByRole('dialog', { name: 'add member', exact: true });
  await expect(dialog).toBeVisible();
  return dialog;
}

/** taps "some machines", and measures both choices, the picker and the dialog's two buttons. */
async function expectAccessFits(page: Page, dialog: Locator, idPrefix: string, submit: string): Promise<void> {
  for (const name of ['whole site', 'some machines'] as const) {
    await expectFullyWithinViewport(page, accessChoice(dialog, name), `the ${name} button`);
  }
  await accessChoice(dialog, 'some machines').tap();
  await expect(dialog.getByText('pick at least one machine', { exact: true })).toBeVisible();
  await expectFullyWithinViewport(page, dialog.getByTestId(`${idPrefix}-machines-machines`), 'the machine picker');
  await expectFullyWithinViewport(page, dialog.getByRole('button', { name: submit, exact: true }), submit);
  await expectFullyWithinViewport(page, dialog.getByRole('button', { name: 'cancel', exact: true }), 'cancel');
}

async function cancel(page: Page, dialog: Locator): Promise<void> {
  await dialog.getByRole('button', { name: 'cancel', exact: true }).tap();
  await expect(dialog).toBeHidden();
}

test('the editor fits a phone', async ({ page }) => {
  await openMembers(page);

  // the section's header is one row: add member sits beside the title, not under it
  const section = page.getByRole('region', { name: 'members', exact: true });
  const heading = section.getByRole('heading', { name: 'members', exact: true });
  const add = section.getByRole('button', { name: 'add member', exact: true });
  const [headingBox, addBox] = await Promise.all([heading.boundingBox(), add.boundingBox()]);
  expect(addBox!.y, 'add member dropped below the members title').toBeLessThan(headingBox!.y + headingBox!.height);

  // the access column is not rendered here: the access follows the swoop label on the role line
  const row = targetRow(page);
  await expectFullyWithinViewport(page, row.getByText('· whole site', { exact: true }), 'the row access label');
  await expect(row.locator('td').nth(3)).toBeHidden();
  await assertNoHorizontalOverflow(page);

  const dialog = await openChangeAccess(page);
  const title = dialog.getByRole('heading', { name: 'change access', exact: true });
  const titleFits = await title.evaluate(
    (el) => el.getBoundingClientRect().height < 2 * parseFloat(getComputedStyle(el).fontSize),
  );
  expect(titleFits, 'the dialog title wrapped').toBe(true);

  await expectAccessFits(page, dialog, 'change-access', 'save');
  await expect(dialog.getByRole('button', { name: 'save', exact: true })).toBeDisabled();

  await dialog.getByTestId('change-access-machines-machines').tap();
  const checkbox = page.getByRole('checkbox', { name: MACHINE, exact: true });
  await expectFullyWithinViewport(page, checkbox, 'the machine checkbox');
  await checkbox.tap();
  await expect(checkbox).toBeChecked();
  await page.keyboard.press('Escape');
  await expect(checkbox).toBeHidden();
  const save = dialog.getByRole('button', { name: 'save', exact: true });
  await expect(save).toBeEnabled();
  await expectFullyWithinViewport(page, save, 'save, with a machine picked');
  await assertNoHorizontalOverflow(page);
  await cancel(page, dialog);

  const addDialog = await openAddMember(page);
  await expectAccessFits(page, addDialog, 'add-member', 'add member');
  await assertNoHorizontalOverflow(page);
  await cancel(page, addDialog);

  expect((await getAdminDb().doc(`sites/${SITE}/members/${target.uid}`).get()).data()).not.toHaveProperty(
    'machineIds',
  );
});

test('both dialogs scroll on a short screen, and reach their buttons', async ({ page }) => {
  // the phone turned on its side
  await page.setViewportSize({ width: 844, height: 390 });
  await openMembers(page);

  const expectScrollsInside = async (dialog: Locator, label: string) => {
    await expectFullyWithinViewport(page, dialog, label);
    expect(await dialog.evaluate((el) => el.scrollHeight > el.clientHeight), `${label} does not scroll`).toBe(true);
  };

  const dialog = await openChangeAccess(page);
  await expectAccessFits(page, dialog, 'change-access', 'save');
  await expectScrollsInside(dialog, 'the change access dialog');
  await cancel(page, dialog);

  const addDialog = await openAddMember(page);
  await expectAccessFits(page, addDialog, 'add-member', 'add member');
  await expectScrollsInside(addDialog, 'the add member dialog');
  await cancel(page, addDialog);
});
