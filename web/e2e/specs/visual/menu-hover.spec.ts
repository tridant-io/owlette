/**
 * menu rows take the buttons' hover sweep (.menu-sweep in globals.css): the
 * header's page switcher, site switcher, user menu and download menu, a
 * machine's menu for a tinted row, and a select's options.
 *
 * the sweep is asserted as geometry (helpers/sweep.ts), plus an unchanged
 * background-color: a flat focus:bg-accent left on a row would pass the size
 * check and still hide the sweep. the sweep keys on radix's highlight, so with
 * the pointer parked on one row an arrow key moves the sweep off it and exactly
 * one row stays lit: a :hover sweep would leave two. the report keeps pictures
 * of every menu, dark and light, with a row hovered and a row reached by the
 * keyboard.
 */

import { test, expect, type Locator, type Page } from '@playwright/test';
import type { DocumentData } from 'firebase-admin/firestore';
import { getAdminDb } from '../../helpers/emulator';
import { roleState } from '../../helpers/roles';
import { seedMachine } from '../../helpers/seed';
import { seedInstallerLatest } from '../../helpers/coverageSeed';
import { attachPicture } from '../../helpers/picture';
import { expectSweepAtRest, expectSweepSize, sweepState, sweptContrast } from '../../helpers/sweep';

test.use(roleState('admin'));
// each test walks five menus by pointer and by keys, with pictures: past the 30s default on a busy box
test.setTimeout(90_000);

const SITE_ID = 'site-A';
const MACHINE_ID = 'e2e-menu-sweep';
// not semver: a semver latest would put the update button on later specs' pages
const VERSION = 'e2e-menu-sweep';
const fileFor = (os: string) => ({ download_url: `https://example.test/downloads/owlette-${os}` });

const latestRef = () => getAdminDb().collection('installer_metadata').doc('latest');
let savedLatest: DocumentData | undefined;

test.beforeAll(async () => {
  savedLatest = (await latestRef().get()).data();
  // every platform, so the download menu shows the rows the owner sees
  await seedInstallerLatest(
    undefined,
    { windows_x64: fileFor('windows'), macos_arm64: fileFor('macos'), linux_x64: fileFor('linux') },
    VERSION,
  );
  await seedMachine(SITE_ID, MACHINE_ID);
});

test.afterAll(async () => {
  const db = getAdminDb();
  await db.collection('installer_metadata').doc('data').collection('versions').doc(VERSION).delete();
  await (savedLatest ? latestRef().set(savedLatest) : latestRef().delete());
  await db.collection('sites').doc(SITE_ID).collection('machines').doc(MACHINE_ID).delete();
});

/** how many of a surface's rows are swept in, once the transitions settle */
const lit = (surface: Locator, role: 'menuitem' | 'option') =>
  surface
    .getByRole(role)
    .evaluateAll((rows) => rows.filter((row) => getComputedStyle(row).backgroundSize === '100% 100%').length);

async function openMenu(page: Page, trigger: Locator) {
  await trigger.click();
  const menu = page.getByRole('menu');
  await expect(menu).toBeVisible();
  return menu;
}

async function closeMenu(page: Page) {
  await page.keyboard.press('Escape');
  await expect(page.getByRole('menu')).toHaveCount(0);
  await page.mouse.move(0, 0);
}

/**
 * hover the first row: it sweeps over an unchanged fill. then, with the pointer
 * still on it, an arrow key takes the sweep to the second row and off the first.
 */
async function expectRowsSweep(page: Page, trigger: Locator, name: string, scheme: string) {
  const menu = await openMenu(page, trigger);
  const [first, second] = [menu.getByRole('menuitem').nth(0), menu.getByRole('menuitem').nth(1)];
  const rest = await expectSweepAtRest(first, `${name}'s first row`);
  await expectSweepAtRest(second, `${name}'s second row`);

  await first.hover();
  await expectSweepSize(first, '100% 100%', `${name}: the hovered row should sweep in`);
  expect((await sweepState(first)).color, `${name}: no flat fill under the sweep`).toBe(rest.color);
  await attachPicture(page, menu, `${name}, row hovered, ${scheme}`);

  await page.keyboard.press('ArrowDown');
  await expect(second).toBeFocused();
  await expectSweepSize(second, '100% 100%', `${name}: the arrowed-to row should sweep in`);
  await expectSweepSize(first, '0% 100%', `${name}: the row under the parked pointer should sweep out`);
  await expect.poll(() => lit(menu, 'menuitem'), { message: `${name}: one row lit` }).toBe(1);
  expect((await sweepState(second)).color, `${name}: no flat fill under the keyboard sweep`).toBe(rest.color);
  await attachPicture(page, menu, `${name}, row keyboard-focused, ${scheme}`);

  await closeMenu(page);
}

for (const scheme of ['dark', 'light'] as const) {
  test(`header and machine menus sweep their rows like buttons, ${scheme}`, async ({ page }) => {
    await page.emulateMedia({ colorScheme: scheme });
    await page.goto('/dashboard');
    if (scheme === 'light') await expect(page.locator('html')).not.toHaveClass(/\bdark\b/);
    else await expect(page.locator('html')).toHaveClass(/\bdark\b/);
    const header = page.locator('header');

    await expectRowsSweep(page, header.getByRole('button', { name: 'dashboard', exact: true }), 'page switcher', scheme);
    await expectRowsSweep(page, page.getByTestId('site-switcher-trigger'), 'site switcher', scheme);
    await expectRowsSweep(page, page.getByTestId('user-menu-trigger'), 'user menu', scheme);

    // the download menu's split rows: download and copy are each a menu item, as the
    // machine menu's restart and its schedule are, so each lights on its own
    const menu = await openMenu(page, header.getByRole('button', { name: 'choose installer platform' }));
    const windows = menu.getByRole('menuitem', { name: 'windows', exact: true });
    const copy = menu.getByRole('menuitem', { name: 'copy windows download link' });
    const notes = menu.getByRole('menuitem', { name: 'release notes' });
    const rest = await expectSweepAtRest(windows, 'the windows row');
    await expectSweepAtRest(copy, 'the windows copy item');

    await windows.hover();
    await expectSweepSize(windows, '100% 100%', 'the hovered platform label should sweep in');
    expect((await sweepState(windows)).color, 'no flat fill under the sweep').toBe(rest.color);
    await attachPicture(page, menu, `download menu, row hovered, ${scheme}`);

    // the pointer parked on the platform label: the arrow key moves the one lit item on
    await page.keyboard.press('ArrowDown');
    await expect(copy).toBeFocused();
    await expectSweepSize(copy, '100% 100%', 'the arrowed-to copy item should sweep in');
    await expectSweepSize(windows, '0% 100%', 'the label under the parked pointer should sweep out');
    await expect.poll(() => lit(menu, 'menuitem'), { message: 'download menu: one item lit' }).toBe(1);
    await attachPicture(page, menu, `download menu, row keyboard-focused, ${scheme}`);

    await notes.hover();
    await expectSweepSize(notes, '100% 100%', 'release notes should sweep in');
    await expect.poll(() => lit(menu, 'menuitem'), { message: 'download menu: one item lit under the pointer' }).toBe(1);
    await closeMenu(page);

    // a tinted row keeps only its text colour and sweeps like the rest, as ghost-destructive
    // does on a button. its text takes the bright step, which clears aa on the sweep
    const card = page.getByTestId('machine-card').filter({ hasText: MACHINE_ID });
    const machineMenu = await openMenu(page, card.getByTestId('machine-context-menu-trigger'));
    const remove = page.getByTestId('machine-context-menu-remove');
    const revoke = page.getByTestId('machine-context-menu-revoke-token');
    const tintedRest = await expectSweepAtRest(remove, 'remove machine');
    await remove.hover();
    await expectSweepSize(remove, '100% 100%', 'the tinted row should sweep in');
    expect((await sweepState(remove)).color, 'no tinted fill under the sweep').toBe(tintedRest.color);
    await expect.poll(() => sweptContrast(remove), { message: 'swept danger text clears aa' }).toBeGreaterThanOrEqual(4.5);
    await attachPicture(page, machineMenu, `machine menu, tinted row hovered, ${scheme}`);
    await page.keyboard.press('ArrowUp');
    await expectSweepSize(revoke, '100% 100%', 'the arrowed-to tinted row should sweep in');
    expect((await sweepState(revoke)).color, 'no tinted fill under the keyboard sweep').toBe(tintedRest.color);
    await expect.poll(() => sweptContrast(revoke), { message: 'keyboard-swept danger text clears aa' }).toBeGreaterThanOrEqual(4.5);
    await attachPicture(page, machineMenu, `machine menu, tinted row keyboard-focused, ${scheme}`);
    await closeMenu(page);
  });

  test(`a select's options sweep like menu rows, ${scheme}`, async ({ page }) => {
    await page.emulateMedia({ colorScheme: scheme });
    await page.goto('/dashboard');
    await page.getByTestId('user-menu-trigger').click();
    await page.getByRole('menuitem', { name: /account settings/i }).click();
    await page.getByRole('button', { name: /^preferences$/i }).first().click();
    await page.locator('#temperatureUnit').click();

    // the select opens on its chosen option, lit; hover the other one, then arrow back
    const list = page.getByRole('listbox');
    const [first, second] = [list.getByRole('option').nth(0), list.getByRole('option').nth(1)];
    const firstChosen = (await first.getAttribute('aria-selected')) === 'true';
    const [chosen, other] = firstChosen ? [first, second] : [second, first];
    const rest = await expectSweepAtRest(other, 'the unchosen option');

    await other.hover();
    await expectSweepSize(other, '100% 100%', 'the hovered option should sweep in');
    expect((await sweepState(other)).color, 'no flat fill under the sweep').toBe(rest.color);
    await attachPicture(page, list, `select, option hovered, ${scheme}`);

    await page.keyboard.press(firstChosen ? 'ArrowUp' : 'ArrowDown');
    await expect(chosen).toBeFocused();
    await expectSweepSize(chosen, '100% 100%', 'the arrowed-to option should sweep in');
    await expectSweepSize(other, '0% 100%', 'the option under the parked pointer should sweep out');
    await expect.poll(() => lit(list, 'option'), { message: 'select: one option lit' }).toBe(1);
    await attachPicture(page, list, `select, option keyboard-focused, ${scheme}`);

    // nothing is chosen or saved: escape closes the list, then the dialog
    await page.keyboard.press('Escape');
    await expect(list).toHaveCount(0);
  });

  test(`the header's triggers sweep like buttons and stay lit while open, ${scheme}`, async ({ page }) => {
    await page.emulateMedia({ colorScheme: scheme });
    await page.goto('/dashboard');
    const header = page.locator('header');
    // an open menu aria-hides the page behind it, trigger included, so roles must look through that
    const headerButton = (name: string) => header.getByRole('button', { name, exact: true, includeHidden: true });
    // [name, trigger, whether it carries text: an icon-only trigger's glyph is measured by the theme test]
    const triggers: Array<[string, Locator, boolean]> = [
      ['site switcher', page.getByTestId('site-switcher-trigger'), true],
      ['page switcher', headerButton('dashboard'), true],
      // ghost already; its tooltip writes data-state over the menu's, so it proves the aria-expanded hold
      ['download menu', headerButton('choose installer platform'), false],
      ['help', headerButton('help'), false],
      ['user menu', page.getByTestId('user-menu-trigger'), true],
    ];

    for (const [name, trigger, text] of triggers) {
      await expectSweepAtRest(trigger, `the ${name} trigger`);
      await trigger.hover();
      await expectSweepSize(trigger, '100% 100%', `the ${name} trigger should sweep in on hover`);
      if (name === 'site switcher' || name === 'help') await attachPicture(page, header, `header, ${name} trigger hovered, ${scheme}`);
      await page.mouse.move(0, 0);
      await expectSweepSize(trigger, '0% 100%', `the ${name} trigger should sweep out`);

      // keyboard modality first, so the focus that follows is :focus-visible
      await page.keyboard.press('Tab');
      await trigger.focus();
      await expectSweepSize(trigger, '100% 100%', `the ${name} trigger should sweep in on keyboard focus`);
      if (name === 'page switcher') await attachPicture(page, header, `header, page trigger keyboard-focused, ${scheme}`);

      // open from the keyboard: focus goes into the menu, and the trigger holds the sweep
      await page.keyboard.press('Enter');
      await expect(page.getByRole('menu')).toBeVisible();
      await expect(trigger).toHaveAttribute('aria-expanded', 'true');
      await expect(trigger).not.toBeFocused();
      await expectSweepSize(trigger, '100% 100%', `the ${name} trigger should stay lit while its menu is open`);
      if (text) {
        await expect
          .poll(() => sweptContrast(trigger), { message: `the open ${name} trigger reads on the sweep` })
          .toBeGreaterThanOrEqual(4.5);
      }
      if (name === 'user menu' || name === 'download menu') await attachPicture(page, header, `header, ${name} open, ${scheme}`);
      await page.keyboard.press('Escape');
      await expect(page.getByRole('menu')).toHaveCount(0);
    }
  });
}

// below md the breadcrumb triggers fold into a drawer, opened by the header's menu button. the
// drawer covers the button while open, so it has no held state to check, only the sweep
test.describe('at phone width', () => {
  test.use({ viewport: { width: 390, height: 844 } });

  for (const scheme of ['dark', 'light'] as const) {
    test(`the header's menu button sweeps like a button, ${scheme}`, async ({ page }) => {
      await page.emulateMedia({ colorScheme: scheme });
      await page.goto('/dashboard');
      const header = page.locator('header');
      const menuButton = header.getByRole('button', { name: 'menu', exact: true });

      await expectSweepAtRest(menuButton, 'the menu button');
      await menuButton.hover();
      await expectSweepSize(menuButton, '100% 100%', 'the menu button should sweep in on hover');
      await attachPicture(page, header, `header at phone width, menu button hovered, ${scheme}`);
      await page.mouse.move(200, 600);
      await expectSweepSize(menuButton, '0% 100%', 'the menu button should sweep out');

      await page.keyboard.press('Tab');
      await menuButton.focus();
      await expectSweepSize(menuButton, '100% 100%', 'the menu button should sweep in on keyboard focus');
    });
  }
});
