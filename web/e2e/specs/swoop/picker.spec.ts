/**
 * swoop — the picker at `/swoop`, owlette swoop's home and a page of its own
 * in a browser. a site with swoop on, one online machine that can stream and
 * one offline: the online card opens the viewer in a window of its own, the
 * offline one says why it can't. the online card's corner button hands the
 * machine to owlette swoop with a sign-in code. inside the app (its ua token)
 * the page has no way back to the dashboard and no such button; a card opens
 * the session in the same window, which comes back to the picker when the
 * session ends, and a right-click or shift+enter opens it in a new one. signed
 * out, it goes through the login and the second factor and comes back. the
 * cards are a grid: four columns on a wide screen, one on a phone.
 *
 * a site and users of the spec's own, so no fixture's saved site moves.
 */

import crypto from 'crypto';
import { test, expect, devices, type Page } from '@playwright/test';
import { authenticator } from 'otplib';
import { getAdminDb } from '../../helpers/emulator';
import { dedicatedUser, seedDedicatedUser } from '../../helpers/coverageSeed';
import { grantMembership, seedMachine, seedSite, type TestUser } from '../../helpers/seed';

authenticator.options = { step: 30, window: 1 };
test.use({ storageState: { cookies: [], origins: [] } });
// a totp sign-in may wait out the end of a period: up to 6 s.
test.setTimeout(90_000);

const SUFFIX = crypto.randomBytes(4).toString('hex');
const SITE_ID = `site-swoop-picker-${SUFFIX}`;
const SITE_NAME = `Swoop picker ${SUFFIX}`;
const ONLINE_ID = `mach-picker-online-${SUFFIX}`;
const OFFLINE_ID = `mach-picker-offline-${SUFFIX}`;
const APP_LINK_CODE = 'testcodetestcode_1234';

let viewer: TestUser;
let mfaViewer: TestUser;
let mfaSecret = '';

test.beforeAll(async () => {
  const db = getAdminDb();
  await seedSite({ id: SITE_ID, name: SITE_NAME, owner: 'someone-else', timezone: 'UTC' });
  // no monitors: nothing here reads the display profile.
  await seedMachine(SITE_ID, ONLINE_ID, { monitorCount: 0 });
  await seedMachine(SITE_ID, OFFLINE_ID, { monitorCount: 0, heartbeatOffsetSec: 3600 });
  // seedMachine writes without merge, so the swoop fields land after it.
  await db.doc(`sites/${SITE_ID}/machines/${ONLINE_ID}`).set({ capabilities: { swoop: 1 } }, { merge: true });
  await db
    .doc(`sites/${SITE_ID}/machines/${OFFLINE_ID}`)
    .set({ online: false, capabilities: { swoop: 1 } }, { merge: true });
  await db.doc(`sites/${SITE_ID}/settings/swoop`).set({ enabled: true }, { merge: true });

  // `sites: []`: dedicatedUser puts every user on site-A, which would sort ahead of this one.
  viewer = await seedDedicatedUser({ ...dedicatedUser('member', `swoop-picker-${SUFFIX}`), sites: [] });
  await grantMembership(SITE_ID, viewer.uid, 'admin');

  mfaViewer = await seedDedicatedUser({ ...dedicatedUser('member', `swoop-picker-mfa-${SUFFIX}`), sites: [] });
  mfaSecret = authenticator.generateSecret();
  await db.collection('users').doc(mfaViewer.uid).set(
    {
      mfaEnrolled: true,
      requiresMfaSetup: false,
      mfaSecret,
      mfaFactors: { totp: true, passkeys: 0 },
    },
    { merge: true },
  );
  await grantMembership(SITE_ID, mfaViewer.uid, 'admin');
});

async function fillLogin(page: Page, user: TestUser): Promise<void> {
  await page.getByLabel(/email/i).fill(user.email);
  await page.getByLabel(/password/i).first().fill(user.password);
  await page.getByRole('button', { name: /sign in with email/i }).click();
}

/** a code with time left on it, so it is not refused on the period's last tick. */
async function freshTotp(page: Page): Promise<string> {
  if (authenticator.timeRemaining() <= 5) {
    await page.waitForTimeout((authenticator.timeRemaining() + 1) * 1000);
  }
  return authenticator.generate(mfaSecret);
}

test('cards say which machine can be watched, and the online one opens the viewer', async ({ page, context }) => {
  await page.goto('/login?redirect=%2Fswoop');
  await fillLogin(page, viewer);
  await expect(page).toHaveURL(/\/swoop$/, { timeout: 20_000 });

  await expect(page.getByTestId('swoop-picker-site')).toContainText(SITE_NAME);
  const online = page.getByTestId(`swoop-picker-machine-${ONLINE_ID}`);
  const offline = page.getByTestId(`swoop-picker-machine-${OFFLINE_ID}`);
  await expect(online).toBeEnabled();
  await expect(page.getByTestId(`swoop-picker-reason-${ONLINE_ID}`)).toHaveCount(0);
  await expect(offline).toBeDisabled();
  await expect(page.getByTestId(`swoop-picker-reason-${OFFLINE_ID}`)).toHaveText('offline');
  await expect(page.getByTestId('swoop-picker-dashboard-link')).toBeVisible();

  // `noopener` leaves the popup no opener, so it is caught as the context's new page.
  const popupPromise = context.waitForEvent('page');
  await online.click();
  const popup = await popupPromise;
  await expect(popup).toHaveURL(new RegExp(`/swoop/${SITE_ID}/${ONLINE_ID}$`));
  await popup.close();
});

test("the online card's corner button hands the machine to owlette swoop, signed in", async ({ page }) => {
  // the link goes to the os, which tells the page nothing back. the navigation
  // api's navigate event is where the page's attempt shows; cancelling it keeps
  // chromium off a scheme it has no handler for.
  await page.addInitScript(() => {
    const w = window as unknown as { __appLinks: string[]; navigation: EventTarget };
    w.__appLinks = [];
    w.navigation.addEventListener('navigate', (event) => {
      const { url } = (event as Event & { destination: { url: string } }).destination;
      if (!url.startsWith('owlette-swoop:')) return;
      w.__appLinks.push(url);
      event.preventDefault();
    });
  });
  const mints: string[] = [];
  await page.route('**/api/auth/app-link', async (route) => {
    mints.push(route.request().method());
    await route.fulfill({
      status: 201,
      contentType: 'application/json',
      body: JSON.stringify({ code: APP_LINK_CODE, expiresAt: new Date(Date.now() + 60_000).toISOString() }),
    });
  });

  await page.goto('/login?redirect=%2Fswoop');
  await fillLogin(page, viewer);
  await expect(page).toHaveURL(/\/swoop$/, { timeout: 20_000 });

  await expect(page.getByTestId(`swoop-picker-machine-${OFFLINE_ID}`)).toBeDisabled();
  await expect(page.getByTestId(`swoop-picker-app-${OFFLINE_ID}`)).toHaveCount(0);
  const app = page.getByTestId(`swoop-picker-app-${ONLINE_ID}`);
  await expect(app).toBeVisible();
  await app.click();

  const host = new URL(page.url()).host;
  const next = encodeURIComponent(`/swoop/${SITE_ID}/${ONLINE_ID}`);
  await expect
    .poll(() => page.evaluate(() => (window as unknown as { __appLinks: string[] }).__appLinks))
    .toEqual([`owlette-swoop://${host}/app-link?code=${APP_LINK_CODE}&next=${next}`]);
  expect(mints).toEqual(['POST']);

  // nothing took the link and the page kept its focus: the app is offered instead.
  await expect(page.getByText("the owlette swoop desktop app isn't installed on this computer")).toBeVisible();
  await expect(page.getByRole('button', { name: 'get it' })).toBeVisible();
});

test.describe('inside owlette swoop', () => {
  test.use({ userAgent: `${devices['Desktop Chrome'].userAgent} owlette-swoop-viewer/0.0.0` });

  test('the picker is home: no way back to the dashboard, no corner button', async ({ page }) => {
    await page.goto('/login?redirect=%2Fswoop');
    await fillLogin(page, viewer);
    await expect(page).toHaveURL(/\/swoop$/, { timeout: 20_000 });

    await expect(page.getByTestId(`swoop-picker-machine-${ONLINE_ID}`)).toBeEnabled();
    await expect(page.getByTestId('swoop-picker-dashboard-link')).toHaveCount(0);
    await expect(page.getByTestId(`swoop-picker-app-${ONLINE_ID}`)).toHaveCount(0);
  });

  test('a card opens the session in this window; a refusal stays put, and the bar leads back to the picker', async ({
    page,
    context,
  }) => {
    await page.goto('/login?redirect=%2Fswoop');
    await fillLogin(page, viewer);
    await expect(page).toHaveURL(/\/swoop$/, { timeout: 20_000 });

    const popups: Page[] = [];
    context.on('page', (p) => popups.push(p));
    await page.getByTestId(`swoop-picker-machine-${ONLINE_ID}`).click();
    await expect(page).toHaveURL(new RegExp(`/swoop/${SITE_ID}/${ONLINE_ID}$`));
    await expect(page.getByTestId('session-bar')).toBeVisible();

    // the viewer has no second factor, so control stops at the step-up; its
    // cancel ends a session that never showed a picture, and that notice stays
    // up (only a session that ran returns to the picker by itself). the bar's
    // arrow is the way back, and it leads to the picker in the app.
    const dialog = page.getByRole('dialog');
    await expect(dialog).toContainText(/confirm it.s you/i, { timeout: 20_000 });
    await dialog.getByRole('button', { name: /^cancel$/i }).click();
    await expect(page.getByRole('alert').filter({ hasText: 'session ended' })).toBeVisible();
    await page.waitForTimeout(1_500);
    await expect(page).toHaveURL(new RegExp(`/swoop/${SITE_ID}/${ONLINE_ID}$`));
    // two ways back are on screen, the bar's arrow and the notice's button; take the bar's
    await page.getByTestId('session-bar').getByRole('link', { name: 'back to machines' }).click();
    await expect(page).toHaveURL(/\/swoop$/, { timeout: 10_000 });
    await expect(page.getByTestId(`swoop-picker-machine-${ONLINE_ID}`)).toBeEnabled();
    expect(popups).toHaveLength(0);
  });

  test('a right-click or shift+enter opens the session in a new window', async ({ page, context }) => {
    await page.goto('/login?redirect=%2Fswoop');
    await fillLogin(page, viewer);
    await expect(page).toHaveURL(/\/swoop$/, { timeout: 20_000 });

    const online = page.getByTestId(`swoop-picker-machine-${ONLINE_ID}`);
    await expect(online).toHaveAttribute('title', 'right-click or shift+enter for a new window');
    const session = new RegExp(`/swoop/${SITE_ID}/${ONLINE_ID}$`);

    // `noopener` leaves the popup no opener, so it is caught as the context's new page.
    await online.click({ button: 'right' });
    const fromMenu = context.waitForEvent('page');
    await page.getByRole('menuitem', { name: 'open in new window' }).click();
    const menuPopup = await fromMenu;
    await expect(menuPopup).toHaveURL(session);
    await menuPopup.close();

    await online.focus();
    const fromKeys = context.waitForEvent('page');
    await page.keyboard.press('Shift+Enter');
    const keysPopup = await fromKeys;
    await expect(keysPopup).toHaveURL(session);
    await keysPopup.close();

    // the picker stays where it was
    await expect(page).toHaveURL(/\/swoop$/);
  });
});

test('the grid is four columns on a wide screen and one on a phone', async ({ page }) => {
  await page.goto('/login?redirect=%2Fswoop');
  await fillLogin(page, viewer);
  await expect(page).toHaveURL(/\/swoop$/, { timeout: 20_000 });

  const grid = page.getByTestId('swoop-picker-grid');
  const columns = () => grid.evaluate((el) => getComputedStyle(el).gridTemplateColumns.split(' ').length);
  await page.setViewportSize({ width: 1440, height: 900 });
  await expect(grid).toBeVisible();
  await expect.poll(columns).toBe(4);

  await page.setViewportSize({ width: 390, height: 844 });
  await expect.poll(columns).toBe(1);
  // nothing runs off the side of a phone
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
});

test('signed out, /swoop goes through the login and the second factor and comes back', async ({ page }) => {
  await page.goto('/swoop');
  await expect(page).toHaveURL(/\/login\?redirect=%2Fswoop$/);

  await fillLogin(page, mfaViewer);
  await expect(page).toHaveURL(/\/verify-2fa/, { timeout: 20_000 });
  await page.getByPlaceholder('000000').fill(await freshTotp(page));
  await page.getByRole('button', { name: /^verify$/i }).click();

  await expect(page).toHaveURL(/\/swoop$/, { timeout: 20_000 });
  await expect(page.getByTestId(`swoop-picker-machine-${ONLINE_ID}`)).toBeEnabled();
});
