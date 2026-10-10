/**
 * swoop — owlette swoop's title bar. the app's windows have no native frame,
 * so under its ua token the page draws the window's controls and drives the
 * window through the app's bridge, `window.__TAURI__`. playwright has no
 * bridge, so a stand-in records what the page asks of its window.
 *
 * the session bar is the title bar on top; on a side the controls move to a
 * slim strip across the top that lets presses through everywhere else. the
 * picker's header and the login page carry the same controls. in a browser
 * none of it exists. fullscreen in the app says how to leave it from inside
 * the stage; a browser leaves that to chrome.
 *
 * no streamer and no swoop on site-A here: the page refuses the session and
 * stays put with its bar, which is all the title bar needs.
 *
 * the step-up in the app goes through the browser: the app's dialog opens the
 * verify page, a signed-in browser passes a code there, and the app's poll
 * retries the session, which the server now grants without a proof. the app
 * is a fresh context with the app's ua, signed in through app-link as the real
 * one is; its popup only gives up the url the real app hands the system browser.
 */

import crypto from 'crypto';
import { test, expect, devices, type Page } from '@playwright/test';
import { authenticator } from 'otplib';
import { E2E_BASE_URL, getAdminDb } from '../../helpers/emulator';
import { dedicatedUser, seedDedicatedUser } from '../../helpers/coverageSeed';
import { roleState } from '../../helpers/roles';
import { grantMembership, seedMachine, seedSite } from '../../helpers/seed';

const SITE_ID = 'site-A';
const MACHINE_ID = 'e2e-swoop-viewer-app';
const SESSION = `/swoop/${SITE_ID}/${MACHINE_ID}`;
// the desktop chrome ua is a windows one, so the page draws windows' buttons
const APP_UA = `${devices['Desktop Chrome'].userAgent} owlette-swoop-viewer/0.0.0`;

// the bar's own controls; the strip, fixed to the window, sits inside the bar too
const BAR_CONTROLS = ':scope > [data-testid="window-controls"]';

const machineDoc = () => getAdminDb().doc(`sites/${SITE_ID}/machines/${MACHINE_ID}`);

test.beforeAll(async () => {
  // no monitors: the hardware subdoc would outlive the machine doc's delete.
  await seedMachine(SITE_ID, MACHINE_ID, { monitorCount: 0 });
  await machineDoc().set({ capabilities: { swoop: 1 } }, { merge: true });
});

test.afterAll(async () => {
  await machineDoc().delete();
});

/** the app's `window.__TAURI__`, as far as the title bar uses it, recording each call. */
async function fakeBridge(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const calls: string[] = [];
    const appWindow = {
      minimize: async () => void calls.push('minimize'),
      toggleMaximize: async () => void calls.push('toggleMaximize'),
      close: async () => void calls.push('close'),
      isMaximized: async () => false,
      onResized: async () => () => {},
    };
    Object.assign(window, {
      __tauriCalls: calls,
      __TAURI__: { window: { getCurrentWindow: () => appWindow } },
    });
  });
}

const bridgeCalls = (page: Page) =>
  page.evaluate(() => (window as unknown as { __tauriCalls: string[] }).__tauriCalls);

const barAt = (page: Page, position: 'top' | 'left') =>
  page.addInitScript((p) => localStorage.setItem('owlette.swoop.barPosition', p), position);

/**
 * the stage in fullscreen. the bar's fullscreen button needs a live session,
 * which the refused one here never is, so the page asks directly: playwright's
 * evaluate carries a user gesture in chromium, as the button's click would.
 */
const stageFullscreen = (page: Page) =>
  page.locator('video[aria-label="remote screen"]').evaluate(async (video) => {
    const stage = video.parentElement!;
    await stage.requestFullscreen();
    return document.fullscreenElement === stage;
  });

test.describe('inside owlette swoop — admin on site-A', () => {
  test.use({ ...roleState('admin'), userAgent: APP_UA });

  test.beforeEach(async ({ page }) => {
    await page.setViewportSize({ width: 1600, height: 900 });
    await fakeBridge(page);
  });

  test('the session bar on top is the title bar, ending in the window controls', async ({ page }) => {
    await barAt(page, 'top');
    await page.goto(SESSION);
    const bar = page.getByTestId('session-bar');
    const controls = bar.locator(BAR_CONTROLS);
    await expect(controls).toBeVisible();
    await expect(bar).toHaveAttribute('data-tauri-drag-region', 'deep');
    await expect(page.getByTestId('swoop-window-strip')).toBeHidden();

    // flush with the window's top right corner, as windows draws them
    const box = (await controls.boundingBox())!;
    expect(box.y).toBe(0);
    expect(box.x + box.width).toBeGreaterThan(1599);

    await controls.getByRole('button', { name: 'minimize' }).click();
    await controls.getByRole('button', { name: 'maximize' }).click();
    await controls.getByRole('button', { name: 'close' }).click();
    expect(await bridgeCalls(page)).toEqual(['minimize', 'toggleMaximize', 'close']);
    await test.info().attach('top', { body: await page.screenshot(), contentType: 'image/png' });
  });

  test('with the bar on a side, only the controls sit in a strip across the top', async ({ page }) => {
    await barAt(page, 'left');
    await page.goto(SESSION);
    const strip = page.getByTestId('swoop-window-strip');
    const controls = strip.getByTestId('window-controls');
    await expect(controls).toBeVisible();
    await expect(page.getByTestId('session-bar').locator(BAR_CONTROLS)).toBeHidden();

    const box = (await controls.boundingBox())!;
    expect(box.y).toBe(0);
    expect(box.height).toBeLessThanOrEqual(32);
    expect(box.x + box.width).toBeGreaterThan(1599);

    // the strip takes no press outside the controls and their drag handle: the
    // picture under the rest of it stays the machine's
    const outsideStrip = await page.evaluate(() =>
      [
        [800, 16],
        [100, 4],
        [1600 - 138 - 160 - 8, 16],
      ].map(([x, y]) => !document.elementFromPoint(x, y)?.closest('[data-testid="swoop-window-strip"]')),
    );
    expect(outsideStrip).toEqual([true, true, true]);

    await controls.getByRole('button', { name: 'close' }).click();
    expect(await bridgeCalls(page)).toEqual(['close']);
    await test.info().attach('left', { body: await page.screenshot(), contentType: 'image/png' });
  });

  test('fullscreen says how to leave it, inside the stage, then lets the notice go', async ({ page }) => {
    await page.goto(SESSION);
    // the refused session's badge is drawn by the hydrated page, so the stage is listening
    await expect(page.getByTestId('session-badge')).toBeVisible();
    expect(await stageFullscreen(page)).toBe(true);

    const hint = page.getByTestId('fullscreen-hint');
    await expect(hint).toHaveText('press and hold esc to exit fullscreen');
    await expect(hint).toHaveAttribute('role', 'status');
    await test.info().attach('fullscreen hint', { body: await page.screenshot(), contentType: 'image/png' });
    // four seconds and a fade
    await expect(hint).toHaveCount(0, { timeout: 8000 });
  });

  test("the picker's header is the title bar", async ({ page }) => {
    await page.goto('/swoop');
    const header = page.getByTestId('swoop-picker').getByRole('banner');
    await expect(header).toHaveAttribute('data-tauri-drag-region', 'deep');
    await header.getByRole('button', { name: 'maximize' }).click();
    expect(await bridgeCalls(page)).toEqual(['toggleMaximize']);
  });
});

test.describe('inside owlette swoop — signed out', () => {
  test.use({ storageState: { cookies: [], origins: [] }, userAgent: APP_UA });

  test('the login page carries the window controls in a strip of their own', async ({ page }) => {
    await fakeBridge(page);
    await page.goto('/login');
    const strip = page.getByTestId('swoop-window-strip');
    await expect(strip.getByRole('button', { name: 'close' })).toBeVisible();
    await strip.getByRole('button', { name: 'close' }).click();
    expect(await bridgeCalls(page)).toEqual(['close']);
  });
});

test.describe('in a browser — admin on site-A', () => {
  test.use(roleState('admin'));

  test('no window controls, no strip, no drag surface anywhere', async ({ page }) => {
    await page.setViewportSize({ width: 1600, height: 900 });
    await fakeBridge(page);
    await page.goto(SESSION);
    // the refused session's badge is drawn by the hydrated page, so absence below means something
    await expect(page.getByTestId('session-badge')).toBeVisible();
    await expect(page.getByTestId('window-controls')).toHaveCount(0);
    await expect(page.getByTestId('swoop-window-strip')).toHaveCount(0);
    await expect(page.locator('[data-tauri-drag-region]')).toHaveCount(0);
    // chrome says how to leave fullscreen itself, so the page does not. the bar's
    // button turning to "exit" shows the page heard the change
    expect(await stageFullscreen(page)).toBe(true);
    await expect(page.getByRole('button', { name: 'exit fullscreen' })).toBeAttached();
    await expect(page.getByTestId('fullscreen-hint')).toHaveCount(0);

    await page.goto('/swoop');
    await expect(page.getByTestId('swoop-picker-site')).toBeVisible();
    await expect(page.getByTestId('window-controls')).toHaveCount(0);
    await expect(page.locator('[data-tauri-drag-region]')).toHaveCount(0);
  });
});

test.describe('inside owlette swoop — the step-up passed in the browser', () => {
  test.use({ storageState: { cookies: [], origins: [] } });
  // a totp sign-in, then a step-up code that has to differ from it (up to 31 s), then a 3 s poll
  test.setTimeout(120_000);
  authenticator.options = { step: 30, window: 1 };

  const SUFFIX = crypto.randomBytes(4).toString('hex');
  const STEP_SITE = `site-stepup-${SUFFIX}`;
  const STEP_MACHINE = `mach-stepup-${SUFFIX}`;
  const STEP_SESSION = `/swoop/${STEP_SITE}/${STEP_MACHINE}`;

  test.beforeAll(async () => {
    await seedSite({ id: STEP_SITE, name: `step-up ${SUFFIX}`, owner: 'someone-else', timezone: 'UTC' });
    await seedMachine(STEP_SITE, STEP_MACHINE, { monitorCount: 0 });
    await getAdminDb().doc(`sites/${STEP_SITE}/settings/swoop`).set({ enabled: true }, { merge: true });
  });

  /** a code that is not the one the sign-in spent: the api refuses a replayed totp. */
  async function freshTotp(page: Page, secret: string, spent: string): Promise<string> {
    let code = authenticator.generate(secret);
    if (code === spent || authenticator.timeRemaining() <= 5) {
      await page.waitForTimeout((authenticator.timeRemaining() + 1) * 1000);
      code = authenticator.generate(secret);
    }
    return code;
  }

  test('verify in your browser opens the verify page, and a code passed there lets the app take control', async ({
    page,
    browser,
  }) => {
    const user = await seedDedicatedUser(dedicatedUser('member', `stepup-${SUFFIX}`));
    const secret = authenticator.generateSecret();
    await getAdminDb().collection('users').doc(user.uid).set(
      { mfaEnrolled: true, requiresMfaSetup: false, mfaSecret: secret, mfaFactors: { totp: true, passkeys: 0 } },
      { merge: true },
    );
    await grantMembership(STEP_SITE, user.uid, 'admin');

    // the browser: a totp sign-in, so its session passed a second factor
    await page.goto('/login');
    await page.getByLabel(/email/i).fill(user.email);
    await page.getByLabel(/password/i).first().fill(user.password);
    await page.getByRole('button', { name: /sign in with email/i }).click();
    await expect(page).toHaveURL(/\/verify-2fa/, { timeout: 20_000 });
    if (authenticator.timeRemaining() <= 5) await page.waitForTimeout((authenticator.timeRemaining() + 1) * 1000);
    const spent = authenticator.generate(secret);
    await page.getByPlaceholder('000000').fill(spent);
    await page.getByRole('button', { name: /^verify$/i }).click();
    await expect(page).toHaveURL(/\/dashboard/, { timeout: 20_000 });

    // the app, signed in from that browser, carrying its second factor
    const minted = await page.evaluate(async () => {
      const res = await fetch('/api/auth/app-link', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
      return { status: res.status, body: (await res.json()) as { code?: string } };
    });
    expect(minted.status, JSON.stringify(minted.body)).toBe(201);

    const app = await browser.newContext({ baseURL: E2E_BASE_URL, storageState: { cookies: [], origins: [] }, userAgent: APP_UA });
    try {
      const appPage = await app.newPage();
      await fakeBridge(appPage);
      await appPage.goto(`/app-link?code=${minted.body.code}&next=${encodeURIComponent(STEP_SESSION)}`);
      await expect(appPage).toHaveURL(new RegExp(`${STEP_SESSION}$`), { timeout: 20_000 });

      const dialog = appPage.getByRole('dialog');
      await expect(dialog).toContainText(/confirm it.s you/i, { timeout: 20_000 });
      await expect(dialog.getByRole('button', { name: 'use a passkey' })).toHaveCount(0);

      const verifyRequest = app.waitForEvent('request', (r) => r.url().endsWith(`${STEP_SESSION}/verify`));
      const popupOpened = app.waitForEvent('page');
      await dialog.getByRole('button', { name: 'verify in your browser' }).click();
      const verifyUrl = (await verifyRequest).url();
      await (await popupOpened).close();
      await expect(dialog.getByRole('status')).toHaveText('waiting for your browser…');

      // armed before the browser half of the ceremony, which it also has to outlast under load
      const granted = appPage.waitForResponse(
        (r) => r.url().endsWith('/swoop/sessions') && r.request().method() === 'POST' && r.status() === 201,
        { timeout: 90_000 },
      );

      // the browser passes the step-up on the page the app opened
      await page.goto(verifyUrl);
      await expect(
        page.getByRole('heading', { name: `allow control of ${STEP_MACHINE} from owlette swoop on this computer?` }),
      ).toBeVisible();
      await expect(page.getByText('or enter a code')).toBeVisible();
      await expect(page.getByTestId('sign-in-as-someone-else')).toBeVisible();
      await page.getByLabel('authenticator code').fill(await freshTotp(page, secret, spent));
      await page.getByRole('button', { name: 'confirm' }).click();
      await expect(page.getByText('done, go back to owlette swoop')).toBeVisible();

      // the app's poll sees the window and retries the session with no proof in it
      const grant = await granted;
      expect(grant.request().postDataJSON()).not.toHaveProperty('mfaProof');
      expect(((await grant.json()) as { data: { ctl: boolean } }).data.ctl).toBe(true);
      await expect(dialog).toBeHidden();
    } finally {
      await app.close();
    }
  });
});
