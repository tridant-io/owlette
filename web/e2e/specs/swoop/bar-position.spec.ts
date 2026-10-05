/**
 * swoop — where the session bar sits. on a wide window it can run down the
 * left or right edge, where a 16:9 picture is letterboxed anyway, instead of
 * taking height off the top; the choice is kept in the browser. a phone keeps
 * the bar on top whatever was chosen.
 *
 * no streamer and no swoop on site-A here: the page refuses the session and
 * stays put with its bar, which is all the layout needs.
 */

import { test, expect, type Page } from '@playwright/test';
import { getAdminDb } from '../../helpers/emulator';
import { roleState } from '../../helpers/roles';
import { seedMachine } from '../../helpers/seed';

const SITE_ID = 'site-A';
const MACHINE_ID = 'e2e-swoop-bar-position';

const machineDoc = () => getAdminDb().doc(`sites/${SITE_ID}/machines/${MACHINE_ID}`);

test.beforeAll(async () => {
  // no monitors: the hardware subdoc would outlive the machine doc's delete.
  await seedMachine(SITE_ID, MACHINE_ID, { monitorCount: 0 });
  await machineDoc().set({ capabilities: { swoop: 1 } }, { merge: true });
});

test.afterAll(async () => {
  await machineDoc().delete();
});

async function choose(page: Page, position: 'top' | 'left' | 'right') {
  await page.getByRole('button', { name: 'bar position' }).click();
  await page.getByRole('menuitemradio', { name: position }).click();
}

async function shot(page: Page, name: string) {
  await test.info().attach(name, { body: await page.screenshot(), contentType: 'image/png' });
}

test.describe('swoop bar position — admin on site-A', () => {
  test.use(roleState('admin'));

  test('moves to either side of a wide window and stays there', async ({ page }) => {
    await page.setViewportSize({ width: 1600, height: 900 });
    await page.goto(`/swoop/${SITE_ID}/${MACHINE_ID}`);
    const bar = page.getByTestId('session-bar');
    const name = bar.getByTitle(MACHINE_ID);
    await expect(bar).toBeVisible();

    let box = await bar.boundingBox();
    expect(box!.width).toBeGreaterThan(1500);
    expect(box!.height).toBeLessThan(80);
    await shot(page, 'top');

    await choose(page, 'left');
    await expect(name).toHaveCSS('writing-mode', 'vertical-rl');
    box = await bar.boundingBox();
    expect(box!.x).toBeLessThan(1);
    expect(box!.width).toBeLessThan(60);
    expect(box!.height).toBeGreaterThan(850);
    // a menu opens toward the picture, never over the column it came from
    await page.getByRole('button', { name: 'bar position' }).click();
    const menu = page.getByRole('menu');
    await expect(menu).toBeVisible();
    // polled: the menu slides in from the bar, so it is over it until it lands
    const barEdge = box!.x + box!.width;
    await expect.poll(async () => (await menu.boundingBox())!.x).toBeGreaterThanOrEqual(barEdge);
    await shot(page, 'left');
    await page.keyboard.press('Escape');

    // the choice is the browser's: a new page opens with the bar where it was
    await page.reload();
    await expect(name).toHaveCSS('writing-mode', 'vertical-rl');
    expect((await bar.boundingBox())!.x).toBeLessThan(1);

    await choose(page, 'right');
    box = await bar.boundingBox();
    expect(box!.x + box!.width).toBeGreaterThan(1599);
    expect(box!.width).toBeLessThan(60);
    await shot(page, 'right');

    await choose(page, 'top');
    await expect(name).toHaveCSS('writing-mode', 'horizontal-tb');
    expect((await bar.boundingBox())!.width).toBeGreaterThan(1500);
  });

  test('a side bar is drawn on its side from first paint, before any app script runs', async ({ page }) => {
    await page.addInitScript(() => localStorage.setItem('owlette.swoop.barPosition', 'left'));
    // no app javascript at all: what is on screen is the server's markup, the
    // css, and the layout's inline script, which is what the first frame is
    await page.route(
      (url) => url.pathname.startsWith('/_next/static/') && url.pathname.endsWith('.js'),
      (route) => route.abort(),
    );
    await page.setViewportSize({ width: 1600, height: 900 });
    await page.goto(`/swoop/${SITE_ID}/${MACHINE_ID}`);
    const bar = page.getByTestId('session-bar');
    await expect(bar).toBeVisible();

    const box = await bar.boundingBox();
    expect(box!.x).toBeLessThan(1);
    expect(box!.width).toBeLessThan(60);
    await expect(bar.getByTitle(MACHINE_ID)).toHaveCSS('writing-mode', 'vertical-rl');
  });

  test('the latency stats open at the bottom beside a side bar, next to their button', async ({ page }) => {
    await page.addInitScript(() => localStorage.setItem('owlette.swoop.barPosition', 'left'));
    await page.setViewportSize({ width: 1600, height: 900 });
    await page.goto(`/swoop/${SITE_ID}/${MACHINE_ID}`);
    const bar = (await page.getByTestId('session-bar').boundingBox())!;

    const toggle = page.getByRole('button', { name: 'show latency stats' });
    const button = (await toggle.boundingBox())!;
    await toggle.click();
    const stats = (await page.getByRole('complementary', { name: 'latency breakdown' }).boundingBox())!;
    // beside the bar, and level with the button that opened it
    expect(stats.x).toBeGreaterThanOrEqual(bar.x + bar.width);
    expect(stats.x).toBeLessThan(bar.x + bar.width + 24);
    expect(stats.y).toBeLessThanOrEqual(button.y);
    expect(stats.y + stats.height).toBeGreaterThanOrEqual(button.y + button.height);
    await shot(page, 'left-stats');
  });

  test('a phone keeps the bar on top whatever was chosen', async ({ page }) => {
    await page.addInitScript(() => localStorage.setItem('owlette.swoop.barPosition', 'left'));
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(`/swoop/${SITE_ID}/${MACHINE_ID}`);
    const bar = page.getByTestId('session-bar');
    await expect(bar).toBeVisible();

    expect((await bar.boundingBox())!.width).toBeGreaterThan(380);
    await expect(bar.getByTitle(MACHINE_ID)).toHaveCSS('writing-mode', 'horizontal-tb');
    await expect(page.getByRole('button', { name: 'bar position' })).toBeHidden();
    await shot(page, 'phone');
  });
});
