/**
 * swoop — how sharp the picture is: where it sits on the screen's device
 * pixels, and what draws it.
 *
 * the fake host (`e2e/helpers/swoopHost.ts`) streams a 1280x720 picture, and
 * the window is sized around it so `layoutPicture` (`lib/swoop/view.ts`) has
 * one answer: a picture a little over 1:1 or 1:2 snaps to exactly that on whole
 * device pixels, sharp shows the largest whole fraction, and anything else
 * below 1:1 is drawn by smooth scaling's canvas over a video at opacity 0
 * (`lib/swoop/video/smooth.ts`). the bar is pinned on top, so the stage is the
 * window less its 48 px.
 *
 * every swoop picture before this spec was above 1:1, so the canvas never drew
 * in e2e; here it draws, and its colour is read off the screen with the video
 * hidden. what this cannot show is how the canvas looks and what it costs on a
 * real screen: the smooth-probe and the owner's photos measure that.
 *
 * a dpr other than 1 runs in a browser started at that scale. playwright's
 * `deviceScaleFactor` is chromium's emulation, which reports
 * `device-pixel-content-box` in css pixels and fires neither the resolution
 * query nor a resize observation when the dpr changes, so it cannot stand in
 * for a screen; `useSwoopView.test.tsx` covers a dpr change.
 */

import crypto from 'crypto';
import { test, expect, type Browser, type BrowserType, type Locator, type Page } from '@playwright/test';
import { authenticator } from 'otplib';
import { getAdminDb } from '../../helpers/emulator';
import { dedicatedUser, seedDedicatedUser } from '../../helpers/coverageSeed';
import { grantMembership, seedMachine, seedSite, type TestUser } from '../../helpers/seed';
import { FakeSwoopHost, HOST_COLOUR, waitForFrameSize } from '../../helpers/swoopHost';

authenticator.options = { step: 30, window: 1 };
test.use({ storageState: { cookies: [], origins: [] } });
test.setTimeout(120_000);

const SUFFIX = crypto.randomBytes(4).toString('hex');
const SITE_ID = `site-clarity-${SUFFIX}`;
const FRAME = { width: 1280, height: 720 };
const BAR_PX = 48;

/** one machine and one operator per test: a sign-in spends its totp period's code. */
const RIGS = ['snap', 'smooth', 'dpr2', 'dpr15'] as const;
type Rig = (typeof RIGS)[number];
const machineOf = (rig: Rig) => `mach-clarity-${rig}-${SUFFIX}`;
const operators = new Map<Rig, { user: TestUser; secret: string }>();

test.beforeAll(async () => {
  await seedSite({ id: SITE_ID, name: `Clarity ${SUFFIX}`, owner: 'someone-else', timezone: 'UTC' });
  await getAdminDb().doc(`sites/${SITE_ID}/settings/swoop`).set({ enabled: true }, { merge: true });
  for (const rig of RIGS) {
    await seedMachine(SITE_ID, machineOf(rig), { displayName: `clarity ${rig}` });
    const user = await seedDedicatedUser(dedicatedUser('member', `clarity-${rig}-${SUFFIX}`));
    const secret = authenticator.generateSecret();
    await getAdminDb().collection('users').doc(user.uid).set(
      { mfaEnrolled: true, requiresMfaSetup: false, mfaSecret: secret, mfaFactors: { totp: true, passkeys: 0 } },
      { merge: true },
    );
    await grantMembership(SITE_ID, user.uid, 'admin');
    operators.set(rig, { user, secret });
  }
});

test.beforeEach(async ({ page }) => {
  const webgl2 = await page.evaluate(() => document.createElement('canvas').getContext('webgl2') !== null);
  expect(webgl2, 'no WebGL2 in this browser: the chromium project needs --enable-unsafe-swiftshader (playwright.config.ts)').toBe(true);
});

/**
 * signs in with a second factor moments ago, which is itself the step-up, so
 * the session opens with control and no dialog; then opens the machine and
 * waits for the host's picture at its full size, under a bar on top.
 */
async function openSession(page: Page, rig: Rig): Promise<void> {
  const { user, secret } = operators.get(rig)!;
  await page.addInitScript(() => localStorage.setItem('owlette.swoop.barPosition', 'top'));
  await page.goto('/login');
  await page.getByLabel(/email/i).fill(user.email);
  await page.getByLabel(/password/i).first().fill(user.password);
  await page.getByRole('button', { name: /sign in with email/i }).click();
  await expect(page).toHaveURL(/\/verify-2fa/, { timeout: 20_000 });
  // a code about to roll over may land in the next period, where it is not the one checked
  if (authenticator.timeRemaining() <= 5) await page.waitForTimeout((authenticator.timeRemaining() + 1) * 1000);
  await page.getByPlaceholder('000000').fill(authenticator.generate(secret));
  await page.getByRole('button', { name: /^verify$/i }).click();
  await expect(page).toHaveURL(/\/dashboard/, { timeout: 20_000 });

  await page.goto(`/swoop/${SITE_ID}/${machineOf(rig)}`);
  await waitForFrameSize(page, FRAME.width, FRAME.height);
  await expect.poll(async () => (await page.getByTestId('session-bar').boundingBox())?.height).toBe(BAR_PX);
}

const video = (page: Page) => page.locator('video[aria-label="remote screen"]');
const canvas = (page: Page) => page.getByTestId('swoop-area').locator('canvas');

/** a device-pixel value within 0.01 of a whole one, as that whole one. */
const snap = (value: number): number => (Math.abs(value - Math.round(value)) <= 0.01 ? Math.round(value) : value);

/** the element's box in device pixels: its client rect times the dpr. */
async function deviceBox(target: Locator): Promise<{ x: number; y: number; width: number; height: number }> {
  const box = await target.evaluate((node) => {
    const rect = node.getBoundingClientRect();
    const dpr = window.devicePixelRatio;
    return { x: rect.left * dpr, y: rect.top * dpr, width: rect.width * dpr, height: rect.height * dpr };
  });
  return { x: snap(box.x), y: snap(box.y), width: snap(box.width), height: snap(box.height) };
}

/** a stats row's value: the rows are `<dt>`/`<dd>` with no whitespace between them. */
const statsRow = (page: Page, label: string) =>
  page.locator(`aside[aria-label="latency breakdown"] dt:text-is("${label}") + dd`);

async function openStats(page: Page): Promise<void> {
  await page.getByTestId('session-bar').getByRole('button', { name: 'latency stats' }).click();
  await expect(page.getByRole('complementary', { name: 'latency breakdown' })).toBeVisible();
}

async function chooseSize(page: Page, size: 'fit' | 'sharp'): Promise<void> {
  await page.getByRole('button', { name: 'quality and display' }).click();
  await page.getByRole('menuitem', { name: /^size/ }).click();
  await page.getByRole('menuitemradio', { name: size }).click();
}

async function setSmooth(page: Page, on: boolean): Promise<void> {
  await page.getByRole('button', { name: 'quality and display' }).click();
  const item = page.getByRole('menuitemcheckbox', { name: 'smooth scaling' });
  await expect(item).toHaveAttribute('aria-checked', String(!on));
  await item.click();
}

/** the lower-left detail band (`detail` in swoopHost.ts) as it is on screen, saved beside the test's results. */
async function bandShot(page: Page, name: string): Promise<void> {
  const clip = await video(page).evaluate((node) => {
    const rect = node.getBoundingClientRect();
    return { x: rect.left + rect.width / 16, y: rect.top + rect.height * 0.55, width: rect.width * 0.34, height: rect.height * 0.4 };
  });
  const path = test.info().outputPath(`${name}.png`);
  await page.screenshot({ path, clip });
  await test.info().attach(name, { path, contentType: 'image/png' });
}

test.describe('through a host, at dpr 1', () => {
  test.use({ viewport: { width: 1300, height: 808 } });

  test('a picture a little over 1:1 or 1:2 snaps to it, and sharp shows a whole half that takes clicks', async ({
    page,
    browser,
  }) => {
    const host = await FakeSwoopHost.start({ browser, viewer: page, siteId: SITE_ID, machineId: machineOf('snap'), size: FRAME });
    try {
      await openSession(page, 'snap');
      await openStats(page);

      // a stage of 1300x760 holds the frame at 1.016: it snaps to 1:1, centred on whole pixels
      await expect.poll(() => deviceBox(video(page))).toEqual({ x: 10, y: 68, width: 1280, height: 720 });
      await expect(statsRow(page, 'shown at')).toHaveText('100%');
      await expect(statsRow(page, 'scaling')).toHaveText('exact');

      // 660x380 holds it at 0.516: it snaps to 1:2
      await page.setViewportSize({ width: 660, height: 428 });
      await expect.poll(() => deviceBox(video(page))).toEqual({ x: 10, y: 58, width: 640, height: 360 });
      await expect(statsRow(page, 'shown at')).toHaveText('50%');
      await expect(statsRow(page, 'scaling')).toHaveText('exact');

      // at 0.78 fit is smooth, and sharp shows the whole half that fits instead
      await page.setViewportSize({ width: 1000, height: 648 });
      await expect(statsRow(page, 'scaling')).toHaveText('smooth');
      await chooseSize(page, 'sharp');
      await expect.poll(() => deviceBox(video(page))).toEqual({ x: 180, y: 168, width: 640, height: 360 });
      await expect(statsRow(page, 'shown at')).toHaveText('50%');
      await expect(statsRow(page, 'scaling')).toHaveText('exact');

      const lastSeq = () => Math.max(0, ...host.inputs.map((m) => m.seq));
      const after = (seq: number) => host.inputs.filter((m) => m.seq > seq);
      const presses = (seq: number) => after(seq).filter((m) => m.t === 'b').map((m) => `${m.button}:${m.down ? 'down' : 'up'}`);

      // a click at the picture's centre lands at the machine's centre
      let mark = lastSeq();
      await page.mouse.click(180 + 320, 168 + 180);
      await expect.poll(() => presses(mark)).toEqual(['0:down', '0:up']);
      const sent = after(mark);
      const moved = sent.slice(0, sent.findIndex((m) => m.t === 'b')).filter((m) => m.t === 'm').at(-1);
      expect(Math.abs(Number(moved?.x) - 0.5)).toBeLessThanOrEqual(0.01);
      expect(Math.abs(Number(moved?.y) - 0.5)).toBeLessThanOrEqual(0.01);

      // a click on the letterbox beside it presses nothing
      mark = lastSeq();
      await page.mouse.click(90, 168 + 180);
      await page.waitForTimeout(500);
      expect(presses(mark)).toEqual([]);
      expect(host.problems).toEqual([]);
    } finally {
      await host.stop();
    }
  });

  test('below 1:1 smooth scaling draws the picture on a canvas, its off switch hands it back to the video, and the freeze watchdog counts its draws', async ({
    page,
    browser,
  }) => {
    // the viewer's own swoop-meta channel, so the host's frame records can be played into it
    await page.addInitScript(() => {
      const create = RTCPeerConnection.prototype.createDataChannel;
      RTCPeerConnection.prototype.createDataChannel = function (this: RTCPeerConnection, label: string, init?: RTCDataChannelInit) {
        const channel = create.call(this, label, init);
        if (label === 'swoop-meta') (window as unknown as { swoopMeta: RTCDataChannel }).swoopMeta = channel;
        return channel;
      };
    });
    const host = await FakeSwoopHost.start({
      browser,
      viewer: page,
      siteId: SITE_ID,
      machineId: machineOf('smooth'),
      size: FRAME,
      detail: true,
    });
    try {
      await page.setViewportSize({ width: 1000, height: 648 });
      await openSession(page, 'smooth');
      await openStats(page);

      // 1000x600 holds the frame at 0.78: no snap, so the canvas draws it over the video
      await expect.poll(() => deviceBox(video(page))).toEqual({ x: 0, y: 67, width: 1000, height: 563 });
      await expect(statsRow(page, 'scaling')).toHaveText('smooth');
      await expect(statsRow(page, 'smooth scaling')).toHaveText(/^\+\d+\.\d ms \(estimate\)$/);
      await expect(canvas(page)).toBeVisible();
      await expect(video(page)).toHaveCSS('opacity', '0');
      // the canvas's backing store is its box in device pixels, so it lands 1:1 on the screen
      await expect
        .poll(() =>
          canvas(page).evaluate((node) => {
            const element = node as HTMLCanvasElement;
            const rect = element.getBoundingClientRect();
            const gaps = [element.width - rect.width * window.devicePixelRatio, element.height - rect.height * window.devicePixelRatio];
            return gaps.every((gap) => Math.abs(gap) <= 0.01);
          }),
        )
        .toBe(true);

      // with the video hidden as well, only the canvas can put the host's colour on the screen
      const centre = await video(page).evaluate((node) => {
        const rect = node.getBoundingClientRect();
        return { x: Math.round(rect.left + rect.width / 2), y: Math.round(rect.top + rect.height / 2) };
      });
      await video(page).evaluate((node) => {
        (node as HTMLVideoElement).style.visibility = 'hidden';
      });
      const shot = await page.screenshot({ clip: { x: centre.x - 2, y: centre.y - 2, width: 4, height: 4 } });
      const pixels = await page.evaluate(async (png) => {
        const image = new Image();
        image.src = `data:image/png;base64,${png}`;
        await image.decode();
        const decoded = document.createElement('canvas');
        decoded.width = image.width;
        decoded.height = image.height;
        const paint = decoded.getContext('2d')!;
        paint.drawImage(image, 0, 0);
        const { data } = paint.getImageData(0, 0, image.width, image.height);
        return Array.from({ length: data.length / 4 }, (_, i) => [data[i * 4], data[i * 4 + 1], data[i * 4 + 2]]);
      }, shot.toString('base64'));
      await video(page).evaluate((node) => {
        (node as HTMLVideoElement).style.visibility = '';
      });
      expect(pixels.length).toBeGreaterThan(0);
      for (const pixel of pixels) {
        expect(pixel.every((channel, i) => Math.abs(channel - HOST_COLOUR[i]) <= 12), `[${pixel}] against [${HOST_COLOUR}]`).toBe(true);
      }
      await bandShot(page, 'detail band, smooth scaling on');

      // the off switch: the canvas goes, and the video draws the picture again
      await setSmooth(page, false);
      await expect(canvas(page)).toBeHidden();
      await expect(video(page)).toHaveCSS('opacity', '1');
      await expect(statsRow(page, 'scaling')).toHaveText('standard');
      await expect(statsRow(page, 'smooth scaling')).toHaveCount(0);
      await bandShot(page, 'detail band, smooth scaling off');
      await setSmooth(page, true);
      await expect(canvas(page)).toBeVisible();
      await expect(statsRow(page, 'scaling')).toHaveText('smooth');

      // the watchdog judges a picture by the host's frame records against what was shown
      // (stall.ts). the fake host sends no records, and swiftshader still counts a video at
      // opacity 0 as shown where a gpu counts every frame dropped, so both are played in as a
      // real machine and a gpu give them: only the canvas's draws are left to show it is alive
      await expect.poll(() => page.evaluate(() => (window as unknown as { swoopMeta?: RTCDataChannel }).swoopMeta?.readyState)).toBe('open');
      await page.evaluate(() => {
        const channel = (window as unknown as { swoopMeta: RTCDataChannel }).swoopMeta;
        let frameId = 0;
        const timer = setInterval(() => {
          // PROTOCOL.md section 4: a frame record, header version 1, h.264, a recovery point, one fragment
          const record = new DataView(new ArrayBuffer(48));
          record.setUint8(0, 1);
          record.setUint8(1, 1);
          record.setUint8(3, 1);
          record.setUint16(6, 1, true);
          record.setUint32(8, frameId++, true);
          channel.dispatchEvent(new MessageEvent('message', { data: record.buffer }));
        }, 33);
        (window as unknown as { stopMeta: () => void }).stopMeta = () => clearInterval(timer);
        const element = document.querySelector<HTMLVideoElement>('video[aria-label="remote screen"]')!;
        const quality = element.getVideoPlaybackQuality.bind(element);
        element.getVideoPlaybackQuality = () => {
          const { creationTime, totalVideoFrames, corruptedVideoFrames } = quality();
          return { creationTime, totalVideoFrames, droppedVideoFrames: totalVideoFrames, corruptedVideoFrames } as VideoPlaybackQuality;
        };
      });
      const stalled = page.getByText(/picture stalled|the picture froze/);
      for (let second = 0; second < 12; second += 1) {
        await page.waitForTimeout(1_000);
        await expect(stalled).toHaveCount(0);
      }
      await expect(statsRow(page, 'frozen pictures')).toHaveText('0');
      expect(host.problems).toEqual([]);

      // and it was watching: with the canvas off, nothing is counted as shown, and it declares a stall
      await setSmooth(page, false);
      await expect(statsRow(page, 'frozen pictures')).toHaveText(/^1 \(last: \w+\)$/, { timeout: 15_000 });
      await page.evaluate(() => (window as unknown as { stopMeta: () => void }).stopMeta());
    } finally {
      await host.stop();
    }
  });
});

/**
 * a viewer at a real device scale factor, `viewport` css px: a browser started
 * at that scale, not playwright's emulation (the file's header says why).
 * headless whatever the run, so its window is all page.
 */
async function scaledViewer(
  chromium: BrowserType,
  baseURL: string | undefined,
  dpr: number,
  viewport: { width: number; height: number },
): Promise<{ viewerBrowser: Browser; viewer: Page }> {
  const viewerBrowser = await chromium.launch({
    headless: true,
    // the chromium project's own flags (playwright.config.ts), and the scale
    args: ['--enable-unsafe-swiftshader', `--force-device-scale-factor=${dpr}`, `--window-size=${viewport.width},${viewport.height}`],
  });
  // the project's `deviceScaleFactor` reaches this context too, unless it is cleared
  const context = await viewerBrowser.newContext({ baseURL, viewport: null, deviceScaleFactor: undefined, colorScheme: 'dark' });
  return { viewerBrowser, viewer: await context.newPage() };
}

test.describe('through a host, at a fractional or double dpr', () => {
  for (const { rig, dpr, viewport } of [
    // 680x380 css is 1360x760 device pixels, 1.06 of the frame
    { rig: 'dpr2', dpr: 2, viewport: { width: 680, height: 428 } },
    // 880x500 css is 1320x750 device pixels, 1.03 of the frame: a css box of 853.33x480
    { rig: 'dpr15', dpr: 1.5, viewport: { width: 880, height: 548 } },
  ] as const) {
    test(`at dpr ${dpr} a picture a little over 1:1 in device pixels is exactly 1:1 on a whole device origin`, async ({
      browser,
      playwright,
      baseURL,
    }) => {
      const { viewerBrowser, viewer } = await scaledViewer(playwright.chromium, baseURL, dpr, viewport);
      let host: FakeSwoopHost | null = null;
      try {
        host = await FakeSwoopHost.start({ browser, viewer, siteId: SITE_ID, machineId: machineOf(rig), size: FRAME });
        expect(await viewer.evaluate(() => [window.devicePixelRatio, window.innerWidth, window.innerHeight])).toEqual([
          dpr,
          viewport.width,
          viewport.height,
        ]);
        await openSession(viewer, rig);
        await expect
          .poll(async () => {
            const box = await deviceBox(video(viewer));
            return { width: box.width, height: box.height, onGrid: Number.isInteger(box.x) && Number.isInteger(box.y) };
          })
          .toEqual({ width: 1280, height: 720, onGrid: true });
      } finally {
        await host?.stop();
        await viewerBrowser.close();
      }
    });
  }
});
