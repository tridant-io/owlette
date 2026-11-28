/**
 * nav and menu rows beyond the header's menus take the buttons' hover sweep
 * (.btn-sweep in globals.css, and its copy in app/docs/docs.css for the docs
 * sidebar) instead of an instant fill: account settings' section navs, the hoot
 * conversation list and its phone sheet, the header's phone drawer and its site
 * list, the site picker, the metrics panel's machine switcher, the timezone
 * picker, the screenshot history, the logs filter's checkbox rows and the docs
 * sidebar.
 *
 * each checks a representative row: it sweeps on hover over an unchanged
 * background-color (a flat hover:bg left on a row would pass the size check and
 * still hide the sweep), sweeps on keyboard focus where the row takes the focus,
 * and its dimmest text reads at aa on the sweep. a current item keeps its tint
 * and takes no sweep. the report keeps a dark picture of each.
 */

import { test, expect, type Locator, type Page } from '@playwright/test';
import { Timestamp } from 'firebase-admin/firestore';
import { getAdminDb } from '../../helpers/emulator';
import { roleState } from '../../helpers/roles';
import { TEST_USERS, seedMachine } from '../../helpers/seed';
import { seedHootFixture } from '../../helpers/coverageSeed';
import { openScreenshotDialog, removeScreenshotMachine, seedScreenshotMachine } from '../../helpers/screenshotDialog';
import { sitePickerList, sitePickerTrigger } from '../../helpers/sitePicker';
import { attachPicture } from '../../helpers/picture';
import { expectSweepAtRest, expectSweepSize, sweepState, sweptContrast } from '../../helpers/sweep';

// each test walks a surface by pointer and by keys, in two schemes, with pictures
test.setTimeout(90_000);

const SITE_ID = 'site-A';
const PHONE = { width: 390, height: 844 };
const SCHEMES = ['dark', 'light'] as const;
type Scheme = (typeof SCHEMES)[number];

async function useScheme(page: Page, scheme: Scheme) {
  await page.emulateMedia({ colorScheme: scheme });
}

/**
 * hover the row: it sweeps in over its resting fill, and out again once the
 * pointer leaves. then, unless the row can't take the focus, keyboard focus
 * sweeps it too. `away` is a point off the surface that hovers nothing of it.
 * `picture` is off for a nav's other rows: the report keeps one picture per nav.
 */
async function expectRowSweeps(
  page: Page,
  row: Locator,
  name: string,
  { surface, scheme, keyboard = true, picture = true, away = { x: 0, y: 0 } }: {
    surface: Locator;
    scheme: Scheme;
    keyboard?: boolean;
    picture?: boolean;
    away?: { x: number; y: number };
  },
) {
  // a pointer left over the surface by the step that opened it would start a sweep
  await page.mouse.move(away.x, away.y);
  await expectSweepSize(row, '0% 100%', `${name} should be at rest`);
  const rest = await expectSweepAtRest(row, name);
  await row.hover();
  await expectSweepSize(row, '100% 100%', `${name} should sweep in on hover`);
  expect((await sweepState(row)).color, `${name}: no flat fill under the sweep`).toBe(rest.color);
  if (picture && scheme === 'dark') await attachPicture(page, surface, `${name}, hovered, dark`);
  await page.mouse.move(away.x, away.y);
  await expectSweepSize(row, '0% 100%', `${name} should sweep out`);

  if (!keyboard) return;
  // keyboard modality first, so the focus that follows is :focus-visible
  await page.keyboard.press('Tab');
  await row.focus();
  await expectSweepSize(row, '100% 100%', `${name} should sweep in on keyboard focus`);
  expect((await sweepState(row)).color, `${name}: no flat fill under the keyboard sweep`).toBe(rest.color);
}

/** text on the settled sweep, the row's own or an element inside it that sets its own colour */
const expectReadsOnSweep = (row: Locator, what: string, ink?: Locator) =>
  expect.poll(() => sweptContrast(row, ink), { message: `${what} reads at aa on the sweep` }).toBeGreaterThanOrEqual(4.5);

/** a current item keeps its tint: no sweep layer at all, so hover can't lift it */
async function expectUnswept(row: Locator, what: string) {
  await row.hover();
  expect((await sweepState(row)).image, `${what} should take no sweep`).toBe('none');
}

async function openAccountSettings(page: Page) {
  await page.goto('/dashboard');
  await page.getByTestId('user-menu-trigger').click();
  await page.getByRole('menuitem', { name: /account settings/i }).click();
  const dialog = page.getByRole('dialog', { name: 'account settings' });
  await expect(dialog).toBeVisible();
  return dialog;
}

test.describe('at desktop width', () => {
  test.use(roleState('admin'));

  for (const scheme of SCHEMES) {
    test(`account settings' section rows sweep, ${scheme}`, async ({ page }) => {
      await useScheme(page, scheme);
      const dialog = await openAccountSettings(page);
      const nav = dialog.getByRole('navigation', { name: 'settings sections' });

      await expectUnswept(nav.getByRole('button', { name: 'profile' }), 'the open section');
      const preferences = nav.getByRole('button', { name: 'preferences' });
      await expectRowSweeps(page, preferences, 'account settings, a section', { surface: nav, scheme });
      await expectReadsOnSweep(preferences, 'a focused section');
      // the danger zone keeps its red, at its bright step on the sweep
      const danger = nav.getByRole('button', { name: 'danger zone' });
      await expectRowSweeps(page, danger, 'account settings, the danger zone', { surface: nav, scheme, picture: false });
      await expectReadsOnSweep(danger, 'the focused danger zone');
      await danger.hover();
      await expectReadsOnSweep(danger, 'the hovered danger zone');
    });

    test(`the timezone picker's zones sweep, ${scheme}`, async ({ page }) => {
      await useScheme(page, scheme);
      const dialog = await openAccountSettings(page);
      await dialog.getByRole('button', { name: /^preferences$/ }).click();
      await dialog.locator('#timezone').click();
      const list = page.getByRole('dialog').filter({ has: page.getByRole('textbox', { name: 'search timezones' }) });
      await expect(list).toBeVisible();

      const zone = list.locator('button:not([aria-current]):not([aria-label])').first();
      await expectRowSweeps(page, zone, 'timezone picker, a zone', { surface: list, scheme, away: { x: 1, y: 1 } });
      await expectReadsOnSweep(zone, "a zone's offset", zone.locator('span').last());
    });

    test(`the hoot conversation list sweeps its rows and chips, ${scheme}`, async ({ page }) => {
      await seedHootFixture({ userId: TEST_USERS.admin.uid });
      await useScheme(page, scheme);
      await page.goto('/hoot');
      const panel = page.getByTestId('hoot-conversation-panel');
      const row = panel.getByRole('button', { name: /^Deployment triage/ });
      await expect(row).toBeVisible();
      // the row's wrapper, which used to take the flat fill, keeps its resting fill under the sweep
      const wrapper = row.locator('xpath=..');
      const wrapperFill = () => wrapper.evaluate((el) => getComputedStyle(el).backgroundColor);
      const wrapperRest = await wrapperFill();

      await expectRowSweeps(page, row, 'hoot, a conversation', { surface: panel, scheme });
      await expectReadsOnSweep(row, "a conversation's target and age", row.locator('p').last());

      // over the blur beside the chips the pointer still hovers the row's button
      await row.blur();
      await page.mouse.move(0, 0);
      await expectSweepSize(row, '0% 100%', 'the row sweeps out once it loses the focus');
      const box = (await row.boundingBox())!;
      const rename = panel.getByRole('button', { name: 'rename Deployment triage' });
      const chips = (await rename.boundingBox())!;
      await page.mouse.move(chips.x - 16, box.y + box.height / 2);
      await expectSweepSize(row, '100% 100%', 'the row stays swept under the blur');
      expect(await wrapperFill(), 'no flat fill on the row behind its button').toBe(wrapperRest);

      // each chip sweeps on its own, as a split menu item does
      await expectSweepAtRest(rename, 'the rename chip');
      await rename.hover();
      await expectSweepSize(rename, '100% 100%', 'the rename chip should sweep in');
      await expectSweepSize(row, '0% 100%', 'the row hands its sweep to the chip');
    });

    test(`the screenshot history's rows sweep, ${scheme}`, async ({ page }) => {
      const machineId = 'e2e-nav-hover-screens';
      await seedScreenshotMachine(SITE_ID, machineId, 'e2e-nav-hover-new');
      const shots = getAdminDb().collection('sites').doc(SITE_ID).collection('machines').doc(machineId).collection('screenshots');
      await shots.doc('e2e-nav-hover-old').set({ url: 'data:image/png;base64,iVBORw0KGgo=', timestamp: Timestamp.fromMillis(Date.now() - 3_600_000), sizeKB: 77 });
      try {
        await useScheme(page, scheme);
        const dialog = await openScreenshotDialog(page, machineId);
        const shown = dialog.locator('button[aria-current="true"]');
        await expect(shown).toBeVisible();
        await expectUnswept(shown, 'the shown capture');

        const older = dialog.getByRole('button', { name: /77KB/ });
        const history = older.locator('xpath=../..');
        await expectRowSweeps(page, older, 'screenshot history, a capture', { surface: history, scheme, away: { x: 1, y: 1 } });
        await expectReadsOnSweep(older, 'an older capture');
      } finally {
        await shots.doc('e2e-nav-hover-old').delete();
        await removeScreenshotMachine(SITE_ID, machineId, 'e2e-nav-hover-new');
      }
    });

    test(`the metrics panel's machine switcher and its rows sweep, ${scheme}`, async ({ page }) => {
      const machines = Array.from({ length: 6 }, (_, i) => `e2e-nav-hover-m${i}`);
      const machinesRef = getAdminDb().collection('sites').doc(SITE_ID).collection('machines');
      for (const id of machines) await seedMachine(SITE_ID, id);
      await machinesRef.doc(machines[0]).set(
        {
          metrics: {
            schemaVersion: 2,
            timestamp: Timestamp.now(),
            cpus: { CPU0: { percent: 41 } },
            memory: { percent: 48, usedGb: 16 },
            primary: { cpu: 'CPU0' },
          },
        },
        { merge: true },
      );
      try {
        await useScheme(page, scheme);
        await page.goto('/dashboard');
        const card = page.getByTestId('machine-card').filter({ hasText: machines[0] });
        await card.getByText('41%', { exact: true }).click();
        const trigger = page.getByRole('button', { name: 'switch machine' });
        await expect(trigger).toBeVisible({ timeout: 15_000 });

        // a menu's trigger, like the header's: it sweeps, and holds the sweep while open
        await expectSweepAtRest(trigger, 'the machine switcher');
        await trigger.hover();
        await expectSweepSize(trigger, '100% 100%', 'the machine switcher should sweep in');
        await trigger.click();
        const list = page.getByRole('dialog').filter({ has: page.getByRole('button', { name: machines[1] }) });
        await expect(list).toBeVisible();
        await page.mouse.move(0, 0);
        await expectSweepSize(trigger, '100% 100%', 'the machine switcher stays lit while open');

        await expectUnswept(list.locator('button[aria-current="true"]'), 'the current machine');
        const other = list.getByRole('button', { name: machines[1] });
        await expectRowSweeps(page, other, 'metrics machine switcher, a machine', { surface: list, scheme, away: { x: 1, y: 1 } });
        await expectReadsOnSweep(other, 'a focused machine');
      } finally {
        await getAdminDb().collection('users').doc(TEST_USERS.admin.uid).set({ preferences: { activeGraphPanel: null } }, { merge: true });
        for (const id of machines) await machinesRef.doc(id).delete();
      }
    });

    test(`the logs filter's checkbox rows sweep, ${scheme}`, async ({ page }) => {
      await useScheme(page, scheme);
      await page.goto('/logs');
      await page.getByRole('button', { name: /show filters/i }).click();
      await page.getByTestId('logs-filter-action').click();
      const list = page.getByRole('dialog').filter({ has: page.getByTestId('logs-filter-action-search') });
      await expect(list).toBeVisible();

      // a label row: its checkbox takes the focus, so only the pointer sweeps it
      const row = list.locator('label').first();
      await expectRowSweeps(page, row, 'logs action filter, an action', { surface: list, scheme, keyboard: false, away: { x: 1, y: 1 } });
      await row.hover();
      await expectReadsOnSweep(row, 'a hovered action');
    });

    test(`the docs sidebar's links and folders sweep, ${scheme}`, async ({ page }) => {
      await useScheme(page, scheme);
      await page.goto('/docs');
      const sidebar = page.locator('#nd-sidebar');
      const viewport = sidebar.locator('[data-radix-scroll-area-viewport]');
      await expect(viewport).toBeVisible();

      await expectUnswept(viewport.locator('a[data-active="true"]').first(), 'the open page');
      const link = viewport.locator('a[data-active="false"]').first();
      await expectRowSweeps(page, link, 'docs sidebar, a page', { surface: sidebar, scheme, away: { x: 900, y: 400 } });
      await link.hover();
      await expectReadsOnSweep(link, 'a hovered page');

      const folder = viewport.locator('button[aria-expanded]').first();
      await expectRowSweeps(page, folder, 'docs sidebar, a folder', { surface: sidebar, scheme, away: { x: 900, y: 400 }, picture: false });
    });

    test(`the site picker's rows sweep, ${scheme}`, async ({ browser }) => {
      // the admin pages' site picker is a superadmin's
      const context = await browser.newContext(roleState('superadmin'));
      const page = await context.newPage();
      try {
        await useScheme(page, scheme);
        await page.goto('/admin/tokens');
        await sitePickerTrigger(page).click();
        const list = sitePickerList(page);
        await expect(list).toBeVisible();

        const row = list.locator('[data-site-item]').first();
        await expectRowSweeps(page, row, 'site picker, a site', { surface: list, scheme, away: { x: 1, y: 1 } });
        await expectReadsOnSweep(row, 'a focused site');
      } finally {
        await context.close();
      }
    });
  }
});

// below md the header's crumbs fold into a drawer, hoot's list into a sheet and the docs
// sidebar into a drawer of its own
test.describe('at phone width', () => {
  test.use({ ...roleState('admin'), viewport: PHONE });

  for (const scheme of SCHEMES) {
    test(`the header drawer's rows sweep, ${scheme}`, async ({ page }) => {
      await useScheme(page, scheme);
      await page.goto('/dashboard');
      await page.locator('header').getByRole('button', { name: 'menu', exact: true }).click();
      const drawer = page.getByRole('dialog', { name: 'menu' });
      const nav = drawer.getByRole('navigation', { name: 'site and page navigation' });
      await expect(nav).toBeVisible();
      const away = { x: PHONE.width - 10, y: PHONE.height - 10 };

      await expectUnswept(nav.locator('button[aria-current="page"]'), 'the current page');
      const pageRow = nav.locator('button:not([aria-current])').filter({ hasText: /^logs/ });
      await expectRowSweeps(page, pageRow, 'header drawer, a page', { surface: nav, scheme, away });
      await expectReadsOnSweep(pageRow, "a focused page's description", pageRow.locator('span.text-xs'));

      await expectRowSweeps(page, nav.getByRole('button', { name: 'close menu' }), 'header drawer, close', { surface: nav, scheme, away, picture: false });
      const toggle = nav.getByTestId('drawer-site-toggle');
      await expectRowSweeps(page, toggle, 'header drawer, the site toggle', { surface: nav, scheme, away, picture: false });
      await toggle.click();
      const site = nav.locator('[data-site-item]').first();
      await expect(site).toBeVisible();
      await expectRowSweeps(page, site, 'header drawer, a site', { surface: nav, scheme, away, picture: false });
      await expectReadsOnSweep(site, 'a focused site');
    });

    test(`hoot's conversation sheet sweeps its rows and close button, ${scheme}`, async ({ page }) => {
      await seedHootFixture({ userId: TEST_USERS.admin.uid });
      await useScheme(page, scheme);
      await page.goto('/hoot');
      await page.getByRole('button', { name: 'conversations', exact: true }).click();
      const sheet = page.getByRole('dialog', { name: 'conversations' });
      await expect(sheet).toBeVisible();
      const away = { x: PHONE.width - 10, y: PHONE.height - 10 };

      await expectRowSweeps(page, sheet.getByRole('button', { name: 'close conversations' }), 'hoot sheet, close', { surface: sheet, scheme, away, picture: false });
      const row = sheet.getByRole('button', { name: /^Deployment triage/ });
      await expectRowSweeps(page, row, 'hoot sheet, a conversation', { surface: sheet, scheme, away });
      await expectReadsOnSweep(row, "a focused conversation's target and age", row.locator('p').last());
    });

    test(`account settings' section tabs sweep, ${scheme}`, async ({ page }) => {
      await useScheme(page, scheme);
      const dialog = await openAccountSettings(page);
      const tabs = dialog.getByRole('navigation', { name: 'settings sections' });

      await expectUnswept(tabs.getByRole('button', { name: 'profile' }), 'the open section');
      const alerts = tabs.getByRole('button', { name: 'alerts' });
      await expectRowSweeps(page, alerts, 'account settings tabs, a section', { surface: tabs, scheme, away: { x: 10, y: PHONE.height - 10 } });
      await expectReadsOnSweep(alerts, 'a focused section');
    });

    test(`the docs drawer's links sweep, ${scheme}`, async ({ page }) => {
      await useScheme(page, scheme);
      await page.goto('/docs');
      await page.locator('button[aria-controls="nd-sidebar-mobile"]').first().click();
      const drawer = page.locator('#nd-sidebar-mobile');
      const viewport = drawer.locator('[data-radix-scroll-area-viewport]');
      await expect(viewport).toBeVisible();

      const link = viewport.locator('a[data-active="false"]').first();
      await expectRowSweeps(page, link, 'docs drawer, a page', { surface: drawer, scheme, away: { x: 10, y: 10 } });
      await link.hover();
      await expectReadsOnSweep(link, 'a hovered page');
    });
  }
});
