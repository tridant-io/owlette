/**
 * /demo — the dashboard on sample data. it renders the dashboard's own
 * components, so this checks what the demo feeds them: the site switcher counts
 * the machines the page lists, signed out and as the superadmin who first saw
 * it read 0; the fleet is windows, macOS and linux, each with its os line, a mac
 * reads asleep and a held restart shows its time; the cards' displays open and
 * the list's headers pick a device, as on the dashboard; the add machine dialog
 * shows a sample code and sends nothing; on a phone no button is cut off.
 * signed out, the page reaches neither firestore nor the api; signed in as a
 * superadmin, it offers no admin control and no request names its site. the
 * report keeps pictures of the open switcher, the dialog, the held restart, the
 * phone and the superadmin's view, in dark.
 */

import { test, expect, type Page } from '@playwright/test';
import { DEMO_PAIR_PHRASE, DEMO_SITE } from '@/lib/demo-data';
import { expectFullyWithinViewport, stabilize } from '../../helpers/mobile';
import { FIRESTORE_EMULATOR_URL } from '../../helpers/emulator';
import { attachPicture } from '../../helpers/picture';
import { roleState } from '../../helpers/roles';

test.use({ colorScheme: 'dark' });

// the auth provider drops a stale session cookie on every signed-out page, the demo's too
const SIGNED_OUT_SESSION_DROP = 'DELETE /api/auth/session';

/** every firestore or api request the page makes, as "METHOD path" */
function watchBackend(page: Page): string[] {
  const hits: string[] = [];
  page.on('request', (request) => {
    const url = new URL(request.url());
    if (request.url().startsWith(FIRESTORE_EMULATOR_URL) || url.pathname.startsWith('/api/')) {
      hits.push(`${request.method()} ${url.pathname}`);
    }
  });
  return hits;
}

/** every request that names the demo's site, in its url or body, as "METHOD url" */
function watchDemoSite(page: Page): string[] {
  const hits: string[] = [];
  page.on('request', (request) => {
    if (`${request.url()} ${request.postData() ?? ''}`.includes(DEMO_SITE.id)) {
      hits.push(`${request.method()} ${request.url()}`);
    }
  });
  return hits;
}

/** opens the demo in list view and returns how many machines it lists */
async function openDemo(page: Page): Promise<number> {
  await page.goto('/demo');
  await page.getByRole('button', { name: 'list view' }).click();
  const rows = page.getByTestId('machine-row');
  await expect(rows.first()).toBeVisible();
  return rows.count();
}

async function expectSwitcherCount(page: Page, count: number, picture: string): Promise<void> {
  await page.getByTestId('site-switcher-trigger').click();
  const menu = page.getByRole('menu');
  await expect(menu.getByRole('menuitem', { name: `${DEMO_SITE.name} ${count} machines`, exact: true })).toBeVisible();
  await test.info().attach(picture, { body: await page.screenshot(), contentType: 'image/png' });
}

test.describe('signed out', () => {
  test.use({ storageState: { cookies: [], origins: [] } });

  test('the switcher counts the machines the demo lists, and nothing reaches firestore or the api', async ({ page }) => {
    const hits = watchBackend(page);
    const count = await openDemo(page);
    expect(count).toBeGreaterThan(1);

    await page.getByRole('button', { name: 'expand all' }).click();
    await page.getByRole('button', { name: 'card view' }).click();
    await expect(page.getByTestId('machine-card')).toHaveCount(count);
    await page.getByTestId('open-display-panel').first().click();
    await expect(page.getByTestId('display-layout-panel')).toBeVisible();

    await expectSwitcherCount(page, count, 'demo, switcher open, signed out, dark');
    expect(hits.filter((hit) => hit !== SIGNED_OUT_SESSION_DROP)).toEqual([]);
  });

  test('the fleet runs windows, macOS and linux, each with its os line, a mac reads asleep and a held restart shows its time', async ({ page }) => {
    const count = await openDemo(page);
    const os = page.getByTestId('machine-os-version');

    await expect(os).toHaveCount(count);
    await expect(os.and(page.locator('[title^="Windows"]')).first()).toBeVisible();
    await expect(os.and(page.locator('[title^="macOS"]')).first()).toBeVisible();
    await expect(os.and(page.locator('[title^="Ubuntu"]')).first()).toBeVisible();
    await expect(page.getByTestId('machine-status-asleep')).toHaveText('asleep');

    await page.getByRole('button', { name: 'card view' }).click();
    const held = page.getByTestId('machine-status-deferred-pill');
    await expect(held).toHaveAttribute('aria-label', /^restart at .+ \(machine time\)$/);
    // the cards fade in as they mount, and a picture mid-fade is blank
    await stabilize(page);
    await held.scrollIntoViewIfNeeded();
    await attachPicture(page, page.getByTestId('machine-card').filter({ has: held }), 'demo, held restart, dark');
  });

  test("a card's displays open, and the list's headers pick a device", async ({ page }) => {
    await openDemo(page);
    const header = page.getByRole('row').first();
    for (const column of ['disk', 'gpu', 'network']) {
      await expect(header.getByRole('button', { name: column, exact: true })).toBeVisible();
    }
    await header.getByRole('button', { name: 'disk', exact: true }).click();
    await page.getByRole('menuitemradio', { name: 'D:', exact: true }).click();
    await expect(header.getByRole('button', { name: 'disk: D:', exact: true })).toBeVisible();

    await page.getByRole('button', { name: 'card view' }).click();
    const card = page.getByTestId('machine-card').first();
    await card.getByRole('button', { name: /\d+ displays?\b/ }).click();
    await expect(card.getByRole('button', { name: 'collapse displays' })).toBeVisible();
  });

  test('the add machine dialog shows a sample code, looks no phrase up and sends nothing', async ({ page }) => {
    const hits = watchBackend(page);
    await openDemo(page);
    await page.getByRole('button', { name: /add machine/ }).click();
    const dialog = page.getByRole('dialog', { name: 'add machine' });
    await expect(dialog.getByRole('link', { name: 'sign up' })).toHaveAttribute('href', '/register');
    await expect(dialog.getByRole('button', { name: 'download owlette agent' })).toBeVisible();

    // enter code: a typed phrase goes nowhere, by the button or by enter
    const phrase = dialog.getByPlaceholder('e.g., silver-compass-drift');
    await phrase.fill('amber-river-stone');
    await expect(dialog.getByRole('button', { name: 'continue' })).toBeDisabled();
    await phrase.press('Enter');
    await expect(dialog.getByTestId('add-machine-name')).toHaveCount(0);

    // generate code: its tab, then its button
    await dialog.getByRole('button', { name: 'generate code' }).first().click();
    await dialog.getByRole('button', { name: 'generate code' }).last().click();
    await expect(dialog.getByText('code ready')).toBeVisible();
    await expect(dialog.getByText(new RegExp(`^Owlette-Installer-v\\d+\\.\\d+\\.\\d+\\.exe /ADD=${DEMO_PAIR_PHRASE}`))).toBeVisible();
    await attachPicture(page, dialog, 'demo, add machine, generated code, dark');

    expect(hits.filter((hit) => hit !== SIGNED_OUT_SESSION_DROP)).toEqual([]);
  });
});

test.describe('on a phone', () => {
  test.use({ storageState: { cookies: [], origins: [] }, viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });

  test("the machines heading's buttons fit the screen", async ({ page }) => {
    await page.goto('/demo');
    await expect(page.getByTestId('machine-row').first()).toBeVisible();
    for (const name of [/add machine/, /expand all/, /card view/, /list view/]) {
      await expectFullyWithinViewport(page, page.getByRole('button', { name }), String(name));
    }
    await test.info().attach('demo, phone, dark', { body: await page.screenshot(), contentType: 'image/png' });
  });
});

test.describe('as a superadmin', () => {
  test.use(roleState('superadmin'));

  test("the switcher counts the demo's machines, not the empty site of that id", async ({ page }) => {
    const hits = watchDemoSite(page);
    const count = await openDemo(page);

    await expectSwitcherCount(page, count, 'demo, switcher open, superadmin, dark');
    expect(hits).toEqual([]);
  });

  test("offers a visitor's view, with no control that would write to the sample site", async ({ page }) => {
    const hits = watchDemoSite(page);
    await page.goto('/demo');
    await page.getByRole('button', { name: 'card view' }).click();
    await page.getByRole('button', { name: 'expand all' }).click();
    await page.getByTestId('open-display-panel').first().click();
    const panel = page.getByTestId('display-layout-panel');
    await expect(panel).toBeVisible();

    await expect(panel.getByTestId('display-auto-restore-toggle')).toHaveCount(0);
    await expect(panel.getByTestId('display-store-current-button')).toHaveCount(0);
    await expect(page.getByTestId('machine-card').first().getByRole('button', { name: /edit|add process/i })).toHaveCount(0);
    await expect(page.getByTestId('reboot-pending-approve')).toHaveCount(0);
    await test.info().attach('demo, cards and display panel, superadmin, dark', { body: await page.screenshot(), contentType: 'image/png' });
    expect(hits).toEqual([]);
  });
});
