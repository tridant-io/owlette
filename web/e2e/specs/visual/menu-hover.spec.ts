/**
 * menu rows take the buttons' hover sweep (.menu-sweep in globals.css): the
 * header's page switcher, site switcher, user menu and download menu, and a
 * machine's menu for a tinted row.
 *
 * the sweep is a --btn-hover gradient whose background-size runs 0% -> 100%,
 * so it is asserted as geometry, as in button-hover.spec.ts, plus an unchanged
 * background-color: a flat focus:bg-accent left on a row would pass the size
 * check and still hide the sweep. the sweep keys on radix's highlight, so with
 * the pointer parked on one row an arrow key moves the sweep off it: a :hover
 * sweep would leave both rows lit. the report keeps pictures of every menu,
 * dark and light, with a row hovered and a row reached by the keyboard.
 */

import { test, expect, type Locator, type Page } from '@playwright/test';
import type { DocumentData } from 'firebase-admin/firestore';
import { getAdminDb } from '../../helpers/emulator';
import { roleState } from '../../helpers/roles';
import { seedMachine } from '../../helpers/seed';
import { seedInstallerLatest } from '../../helpers/coverageSeed';

test.use(roleState('admin'));

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

const sweep = (loc: Locator) =>
  loc.evaluate((el) => {
    const cs = getComputedStyle(el);
    return { image: cs.backgroundImage, size: cs.backgroundSize, color: cs.backgroundColor };
  });

// polled: the computed size runs through the 200ms transition
const expectSize = (loc: Locator, size: string, message: string) =>
  expect.poll(async () => (await sweep(loc)).size, { message }).toBe(size);

async function expectAtRest(loc: Locator, what: string) {
  const rest = await sweep(loc);
  expect(rest.image, `${what} should carry the sweep layer`).toContain('gradient');
  expect(rest.image, `${what}: the sweep colour must not be transparent`).not.toContain('rgba(0, 0, 0, 0)');
  expect(rest.size, `${what} should be collapsed at rest`).toBe('0% 100%');
  return rest;
}

// the open menu and 16 px around it, so its edges and shadow are in the picture
async function picture(page: Page, name: string) {
  const box = (await page.getByRole('menu').boundingBox())!;
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
  const rest = await expectAtRest(first, `${name}'s first row`);
  await expectAtRest(second, `${name}'s second row`);

  await first.hover();
  await expectSize(first, '100% 100%', `${name}: the hovered row should sweep in`);
  expect((await sweep(first)).color, `${name}: no flat fill under the sweep`).toBe(rest.color);
  await picture(page, `${name}, row hovered, ${scheme}`);

  await page.keyboard.press('ArrowDown');
  await expect(second).toBeFocused();
  await expectSize(second, '100% 100%', `${name}: the arrowed-to row should sweep in`);
  await expectSize(first, '0% 100%', `${name}: the row under the parked pointer should sweep out`);
  expect((await sweep(second)).color, `${name}: no flat fill under the keyboard sweep`).toBe(rest.color);
  await picture(page, `${name}, row keyboard-focused, ${scheme}`);

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

    // the download menu's platform rows are split: the label and the copy icon
    // each sweep on their own, and the row sweeps only for the keyboard
    const menu = await openMenu(page, header.getByRole('button', { name: 'choose installer platform' }));
    const windows = menu.getByRole('menuitem', { name: /^windows/ });
    const label = windows.locator('span').first();
    const copy = windows.getByRole('button', { name: 'copy windows download link' });
    const notes = menu.getByRole('menuitem', { name: 'release notes' });
    await expectAtRest(label, 'the windows label');
    await expectAtRest(copy, 'the windows copy icon');
    await expectAtRest(notes, 'release notes');

    await label.hover();
    await expectSize(label, '100% 100%', 'the hovered label should sweep in');
    expect((await sweep(windows)).image, 'the platform row stays flat for the pointer').toBe('none');
    await picture(page, `download menu, row hovered, ${scheme}`);

    await copy.hover();
    await expectSize(copy, '100% 100%', 'the hovered copy icon should sweep in');
    await expectSize(label, '0% 100%', 'the label should sweep out when the pointer moves to the copy icon');

    await notes.hover();
    await expectSize(notes, '100% 100%', 'release notes should sweep in');

    await page.keyboard.press('ArrowUp');
    const linux = menu.getByRole('menuitem', { name: /^linux/ });
    await expect(linux).toBeFocused();
    expect((await sweep(linux)).image, 'a keyboard-focused platform row carries the sweep').toContain('gradient');
    await expectSize(linux, '100% 100%', 'the keyboard-focused platform row should sweep in');
    await expectSize(notes, '0% 100%', 'release notes should sweep out under the parked pointer');
    await picture(page, `download menu, row keyboard-focused, ${scheme}`);
    await closeMenu(page);

    // a tinted row keeps only its text colour and sweeps like the rest, as ghost-destructive does on a button
    const card = page.getByTestId('machine-card').filter({ hasText: MACHINE_ID });
    await openMenu(page, card.getByTestId('machine-context-menu-trigger'));
    const remove = page.getByTestId('machine-context-menu-remove');
    const revoke = page.getByTestId('machine-context-menu-revoke-token');
    const tintedRest = await expectAtRest(remove, 'remove machine');
    await remove.hover();
    await expectSize(remove, '100% 100%', 'the tinted row should sweep in');
    expect((await sweep(remove)).color, 'no tinted fill under the sweep').toBe(tintedRest.color);
    await picture(page, `machine menu, tinted row hovered, ${scheme}`);
    await page.keyboard.press('ArrowUp');
    await expectSize(revoke, '100% 100%', 'the arrowed-to tinted row should sweep in');
    expect((await sweep(revoke)).color, 'no tinted fill under the keyboard sweep').toBe(tintedRest.color);
    await picture(page, `machine menu, tinted row keyboard-focused, ${scheme}`);
    await closeMenu(page);
  });
}
