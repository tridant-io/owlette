/**
 * Scene — episode 16, "logs & troubleshooting": the ON-THE-MACHINE half of b07.
 * Script: dev/video-tutorials/scripts/16-logs-and-troubleshooting.md (FINAL).
 *
 * b01–b06 are the dashboard's logs page and belong to the web pipeline
 * (`../videos/16-logs-and-troubleshooting.video.ts`, which ends at b06). b07 is
 * the only beat that leaves the browser: "two last resorts. in the dashboard,
 * the help menu opens owlette's full docs … and on the machine, the owlette app
 * has submit issue." The first sentence is a web shot; this file films the
 * second.
 *
 * VO duration, ffprobe of
 * dev/video-tutorials/voiceover/out/16-logs-and-troubleshooting/ep16-b07.mp3
 * (rounded up ~0.5s):
 *
 *   beat  mp3      budget   this take   other surface
 *   b07   23.17s   23.7s    15.7        8.0  dashboard help menu → /docs (web)
 *
 * The success toast is the payoff, so the run has to complete: `runAgent` only
 * resolves when the helper emits `done` and exits 0. The scratch tree's
 * `configure_site.py` is the video stub (`./fixtures.ts`), which answers
 * `--report-issue` by reading and deleting the staged payload, pausing about as
 * long as collecting system info costs, and reporting done — so nothing is
 * posted to owlette and the toast still lands.
 *
 * Run:  cd web && npm run videos:desktop -- --grep "episode 16"
 * Out:  dev/video-tutorials/footage/desktop/16-report-issue-desktop.mp4
 */

import { expect, test } from '@playwright/test';
import { SCRATCH_ROOT } from '../desktop-screenshots/harness';
import { DEMO_PROCESS_COUNT, seedVideoScenario } from './fixtures';
import { endTake, recordDesktopScene, startTake, type DesktopTake } from './harness';
import {
  clickWithCursor,
  narrate,
  parkPointer,
  settle,
  typewrite,
} from './video-helpers';

test.describe.configure({ mode: 'serial' });

let take: DesktopTake | null = null;

test.afterEach(async () => {
  await endTake(take);
  take = null;
});

test('episode 16 — logs & troubleshooting, submit issue', async () => {
  seedVideoScenario(SCRATCH_ROOT, 'paired');
  take = await startTake();

  const app = take.page;
  await expect(app.getByTestId('process-row')).toHaveCount(DEMO_PROCESS_COUNT);
  await expect(app.getByTestId('footer-status')).toContainText('connected');
  await parkPointer(app);
  await settle(app);

  await recordDesktopScene(take, '16-report-issue-desktop', async (page) => {
    // [b07] on the machine — 15.7s of 23.7s.
    await clickWithCursor(page, page.getByTestId('app-menu-trigger'));
    await expect(page.getByTestId('menu-report-issue')).toBeVisible();
    await narrate(page, 'b07 the app menu', 3);

    await clickWithCursor(page, page.getByTestId('menu-report-issue'));
    const dialog = page.getByTestId('report-issue-dialog');
    await expect(dialog).toBeVisible();
    await narrate(page, 'b07 submit issue — logs attached automatically', 3);

    // Open the category list so the choices are on camera, then take the one
    // the dialog opens on — re-picking the default keeps the form deterministic.
    await clickWithCursor(page, page.getByTestId('report-category'));
    const category = page.getByRole('option', { name: 'something broke' });
    await expect(category).toBeVisible();
    await clickWithCursor(page, category);
    await narrate(page, 'b07 pick a category', 3);

    await typewrite(
      page,
      page.getByTestId('report-description'),
      'gallery show goes black after the 4am restart.',
    );
    await narrate(page, 'b07 type a line', 3);

    await clickWithCursor(page, dialog.getByRole('button', { name: 'submit' }));
    // The helper's own pause is ~1.2s, so the sending state is on screen before
    // the toast replaces it.
    await expect(page.getByText('thanks — your feedback was sent')).toBeVisible();
    await expect(dialog).toBeHidden();
    await parkPointer(page);
    await narrate(page, 'b07 system info and recent logs went with it', 3.7);
  });
});
