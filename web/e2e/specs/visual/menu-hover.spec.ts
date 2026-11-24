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

// the open surface and 16 px around it, so its edges and shadow are in the picture
async function picture(page: Page, surface: Locator, name: string) {
  const box = (await surface.boundingBox())!;
  const clip = { x: box.x - 16, y: box.y - 16, width: box.width + 32, height: box.height + 32 };
  const path = test.info().outputPath(`${name.replace(/[^a-z0-9]+/gi, '-')}.png`);
  await page.screenshot({ clip, path });
  await test.info().attach(name, { path, contentType: 'image/png' });
}

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
  await picture(page, menu, `${name}, row hovered, ${scheme}`);

  await page.keyboard.press('ArrowDown');
  await expect(second).toBeFocused();
  await expectSweepSize(second, '100% 100%', `${name}: the arrowed-to row should sweep in`);
  await expectSweepSize(first, '0% 100%', `${name}: the row under the parked pointer should sweep out`);
  await expect.poll(() => lit(menu, 'menuitem'), { message: `${name}: one row lit` }).toBe(1);
  expect((await sweepState(second)).color, `${name}: no flat fill under the keyboard sweep`).toBe(rest.color);
  await picture(page, menu, `${name}, row keyboard-focused, ${scheme}`);

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
    await picture(page, menu, `download menu, row hovered, ${scheme}`);

    // the pointer parked on the platform label: the arrow key moves the one lit item on
    await page.keyboard.press('ArrowDown');
    await expect(copy).toBeFocused();
    await expectSweepSize(copy, '100% 100%', 'the arrowed-to copy item should sweep in');
    await expectSweepSize(windows, '0% 100%', 'the label under the parked pointer should sweep out');
    await expect.poll(() => lit(menu, 'menuitem'), { message: 'download menu: one item lit' }).toBe(1);
    await picture(page, menu, `download menu, row keyboard-focused, ${scheme}`);

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
    await picture(page, machineMenu, `machine menu, tinted row hovered, ${scheme}`);
    await page.keyboard.press('ArrowUp');
    await expectSweepSize(revoke, '100% 100%', 'the arrowed-to tinted row should sweep in');
    expect((await sweepState(revoke)).color, 'no tinted fill under the keyboard sweep').toBe(tintedRest.color);
    await expect.poll(() => sweptContrast(revoke), { message: 'keyboard-swept danger text clears aa' }).toBeGreaterThanOrEqual(4.5);
    await picture(page, machineMenu, `machine menu, tinted row keyboard-focused, ${scheme}`);
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
    await picture(page, list, `select, option hovered, ${scheme}`);

    await page.keyboard.press(firstChosen ? 'ArrowUp' : 'ArrowDown');
    await expect(chosen).toBeFocused();
    await expectSweepSize(chosen, '100% 100%', 'the arrowed-to option should sweep in');
    await expectSweepSize(other, '0% 100%', 'the option under the parked pointer should sweep out');
    await expect.poll(() => lit(list, 'option'), { message: 'select: one option lit' }).toBe(1);
    await picture(page, list, `select, option keyboard-focused, ${scheme}`);

    // nothing is chosen or saved: escape closes the list, then the dialog
    await page.keyboard.press('Escape');
    await expect(list).toHaveCount(0);
  });
}
