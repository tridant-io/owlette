/**
 * Scene — episode 8, "remote actions: restart, screenshot, live view".
 *
 * Rendered VO (voiceover/out/08-remote-actions/, ffprobe):
 *   b01 12.0s the actions menu · b02 15.5s take a screenshot
 *   b03 16.2s live view · b04 20.0s restart
 *   b05 20.5s shutdown + restarts on a timer · b06 12.9s mute alerts
 *   b07 26.4s who can do what · b08 15.2s when an action doesn't go through
 * b04, b05 and b07 were revoiced for the v2 series.
 *
 * TWO CLIPS. The main pass runs as the site ADMIN, whose menu carries every
 * item. b08 needs the same menu as a MEMBER sees it — the admin-only block
 * simply absent — which is a different session, so it is a second `recordScene`
 * with the member storageState, landing as `08-remote-actions-b08-member.mp4`.
 * The beat's closing dissolve to the owlette desktop app is a native insert.
 *
 * TWO RULES THROUGHOUT:
 * 1. Every press of the ⋮ trigger is `moveCursorTo` + `click({ force: true })`,
 *    never `clickWithCursor`. The trigger sits inside a Radix Tooltip
 *    (MachineContextMenu.tsx:187-207); hovering mounts the tooltip portal over
 *    it and an unforced click times out after 15s. There is no exception to this
 *    in the file — a single unforced press is what used to contradict the
 *    scene's own comment.
 * 2. The screenshot and live-view overlays are closed by their own X, never by
 *    Escape (they ignore it — see `closeOverlayDialog`). Escape is still the way
 *    out of the restart/shutdown/revoke dialogs and of the menu itself.
 *
 * Fixture `dashboard-mixed-states`. Target card `media-server-stage` is online,
 * which is what gates screenshot / live view / restart / shutdown.
 *
 * Run:  cd web && npm run videos -- --grep "episode 8"
 * Out:  dev/video-tutorials/footage/web/08-remote-actions.mp4
 *       dev/video-tutorials/footage/web/08-remote-actions-b08-member.mp4
 */

import { test, expect, type Locator, type Page } from '@playwright/test';
import { roleState } from '../helpers/roles';
import { getAdminDb, E2E_BASE_URL } from '../helpers/emulator';
import { TEST_USERS } from '../helpers/seed';
import { seedScreenshotFixtures } from '../screenshots/fixtures';
import {
  recordScene,
  openForCapture,
  narrate,
  slowPush,
  highlight,
  centerInView,
  clickWithCursor,
  moveCursorTo,
} from './video-helpers';

/** The one safe way to press the ⋮ trigger — see the file header. */
async function openMachineMenu(page: Page, trigger: Locator): Promise<void> {
  await moveCursorTo(page, trigger);
  await page.waitForTimeout(250);
  await trigger.click({ force: true });
  // Assert the menu actually opened: a leftover overlay or an already-open
  // dropdown eats the first pointer-down (Radix dismisses on outside press and
  // consumes the click), which is how b05's offline-machine menu silently never
  // opened in the validation batch. One more press is the documented cure.
  try {
    await expect(page.getByRole('menu')).toBeVisible({ timeout: 1_500 });
  } catch {
    await page.waitForTimeout(400);
    await trigger.click({ force: true });
    await expect(page.getByRole('menu')).toBeVisible({ timeout: 3_000 });
  }
  await page.waitForTimeout(600);
}

/**
 * Close whatever dialog is open and reopen the menu. 900ms: the dialog's exit
 * animation plus focus restore ends around 700ms, and reopening earlier leaves
 * the menu DOM transitional and the next lookup times out.
 *
 * NOT usable after the screenshot or live-view overlay — see
 * `closeOverlayDialog`.
 */
async function reopenMachineMenu(page: Page, trigger: Locator): Promise<void> {
  await page.keyboard.press('Escape');
  await page.waitForTimeout(900);
  await openMachineMenu(page, trigger);
}

/**
 * The two full-bleed overlays this scene opens, `ScreenshotDialog` and
 * `LiveViewModal`, suppress the shared close button (`showCloseButton={false}`)
 * and render their own named "close" button in the title. Escape closes them now
 * too, but the click is what the episode shows. Assert the overlay is gone before
 * touching the card underneath, or the next failure surfaces on an unrelated
 * locator.
 */
async function closeOverlayDialog(page: Page, name: RegExp): Promise<void> {
  const dialog = page.getByRole('dialog', { name });
  await clickWithCursor(
    page,
    dialog.getByRole('button', { name: 'close', exact: true }),
  );
  await expect(dialog).toBeHidden();
  await page.waitForTimeout(900);
}

test('episode 8 — remote actions: restart, screenshot, live view', async ({ browser }) => {
  const ctx = await seedScreenshotFixtures('dashboard-mixed-states');
  try {
    const db = getAdminDb();
    for (const uid of [TEST_USERS.admin.uid, TEST_USERS.member.uid]) {
      await db.collection('users').doc(uid).set({ lastSiteId: ctx.siteId }, { merge: true });
    }

    await recordScene(
      browser,
      '08-remote-actions',
      { baseURL: E2E_BASE_URL, storageState: roleState('admin').storageState },
      async (page) => {
        await openForCapture(page, '/dashboard');
        await expect(page.getByTestId('machine-card')).toHaveCount(10);

        const focusCard = page
          .getByTestId('machine-card')
          .filter({ hasText: 'media-server-stage' });
        await centerInView(page, focusCard);
        const menuTrigger = focusCard.getByTestId('machine-context-menu-trigger');

        // [b01] the actions menu (~12.0s).
        await openMachineMenu(page, menuTrigger);
        await narrate(page, 'b01 menu opens', 13);

        // [b02] take a screenshot (~15.5s). The history sidebar renders before a
        // real capture returns, so the dialog reads immediately.
        const screenshotItem = page.getByRole('menuitem', { name: 'screenshot' });
        await clickWithCursor(page, screenshotItem);
        await page.waitForTimeout(900);
        await narrate(page, 'b02 screenshot dialog', 2.5);
        await slowPush(page, { scale: 1.05, originXPct: 50, originYPct: 50, seconds: 4.0 });
        await narrate(page, 'b02 screenshot dialog — close', 4.0);
        await slowPush(page, { scale: 1.0, seconds: 3.0 });
        await narrate(page, 'b02 screenshot dialog — settle', 2.5);

        // [b03] live view (~16.2s). No `exact: true`: the item renders
        // `<Eye/>\n live view`, so its accessible name carries leading space.
        await closeOverlayDialog(page, /screenshot — media-server-stage/i);
        await openMachineMenu(page, menuTrigger);
        const liveViewItem = page.getByRole('menuitem', { name: 'live view' });
        await clickWithCursor(page, liveViewItem);
        await page.waitForTimeout(900);
        await narrate(page, 'b03 live view modal', 2.5);
        await slowPush(page, { scale: 1.05, originXPct: 50, originYPct: 50, seconds: 4.5 });
        await narrate(page, 'b03 live view modal — close', 4.5);
        await slowPush(page, { scale: 1.0, seconds: 3.0 });
        await narrate(page, 'b03 live view modal — settle', 2.5);

        // [b04] restart (~20.0s). RestartDialog with the 30s countdown copy. Not
        // confirmed on camera: the countdown only starts after confirm, and the
        // pill's cancel affordance hides in the final 5 seconds (Windows
        // `shutdown /a` is unreliable that late), so a real cancel take needs
        // time on the clock and belongs to a separate pass.
        await closeOverlayDialog(page, /live view — media-server-stage/i);
        await openMachineMenu(page, menuTrigger);
        const rebootItem = page.getByTestId('machine-context-menu-reboot');
        await clickWithCursor(page, rebootItem);
        await page.waitForTimeout(700);
        await narrate(page, 'b04 restart confirm + 30s copy', 3.0);
        await slowPush(page, { scale: 1.05, originXPct: 50, originYPct: 50, seconds: 5.0 });
        await narrate(page, 'b04 restart confirm + 30s copy — close', 6.0);
        await slowPush(page, { scale: 1.0, seconds: 3.5 });
        await narrate(page, 'b04 restart confirm + 30s copy — settle', 3.5);

        // [b05] shutdown, and restarts on a timer (~20.5s).
        await reopenMachineMenu(page, menuTrigger);
        const shutdownItem = page.getByTestId('machine-context-menu-shutdown');
        await clickWithCursor(page, shutdownItem);
        await page.waitForTimeout(700);
        await narrate(page, 'b05 shutdown dialog', 10);
        await reopenMachineMenu(page, menuTrigger);
        // the schedule-restarts control is a menu item now; the testid predates that
        const scheduleGear = page.getByTestId('machine-context-menu-schedule-restarts-gear');
        await centerInView(page, scheduleGear);
        await highlight(page, scheduleGear, 2400);
        await narrate(page, 'b05 schedule-restarts gear', 6);
        // The offline machine's menu carries it as a full item — schedules are
        // written to the config doc and applied when the agent reconnects.
        await page.keyboard.press('Escape');
        await page.waitForTimeout(600);
        const offlineCard = page
          .getByTestId('machine-card')
          .filter({ hasText: 'touring-rig-04' });
        await centerInView(page, offlineCard);
        const offlineTrigger = offlineCard.getByTestId('machine-context-menu-trigger');
        await openMachineMenu(page, offlineTrigger);
        await highlight(
          page,
          page.getByTestId('machine-context-menu-schedule-restarts'),
          2400,
        );
        await narrate(page, 'b05 schedulable while offline', 5);
        await page.keyboard.press('Escape');
        await page.waitForTimeout(600);

        // [b06] mute alerts (~12.9s) — never gated by online state or role.
        await centerInView(page, focusCard);
        await openMachineMenu(page, menuTrigger);
        const muteItem = page.getByRole('menuitem', { name: 'mute alerts' });
        await centerInView(page, muteItem);
        await highlight(page, muteItem, 2600);
        await narrate(page, 'b06 mute alerts', 14);

        // [b07] who can do what (~26.4s), grouped as the narration groups them.
        //
        // revoke token is a SITE ADMIN action as of e0c8341a — the site-scoped
        // AGENT_TOKEN_REVOKE capability. It used to 403 for admins because the
        // route still demanded a superadmin capability; do NOT reinstate the old
        // "superadmin only" framing.
        await highlight(page, screenshotItem, 2200);
        await highlight(page, liveViewItem, 2200);
        await highlight(page, page.getByTestId('machine-context-menu-view-displays'), 2200);
        await narrate(page, 'b07 perms — any member on the site', 9);
        await highlight(page, rebootItem, 2000);
        await highlight(page, page.getByTestId('machine-context-menu-schedule-restarts-gear'), 2000);
        await highlight(page, shutdownItem, 2000);
        await highlight(page, page.getByTestId('machine-context-menu-revoke-token'), 2000);
        await highlight(page, page.getByTestId('machine-context-menu-remove'), 2000);
        await narrate(page, 'b07 perms — site admin', 12);
        await highlight(page, muteItem, 2400);
        await narrate(page, 'b07 perms — everyone', 6);

        // The revoke dialog offers BOTH choices and the beat names them, so put
        // them on camera before the menu closes.
        await clickWithCursor(page, page.getByTestId('machine-context-menu-revoke-token'));
        const revokeDialog = page.getByRole('dialog');
        await expect(revokeDialog).toBeVisible();
        await narrate(page, 'b07 revoke current vs revoke all for hostname', 4);
        await page.keyboard.press('Escape');
        await page.waitForTimeout(500);
      },
    );

    // ── b08, second clip: the same menu as a MEMBER sees it (~15.2s) ──────────
    // Members get screenshot / live view / view displays / mute alerts and
    // nothing else; the admin block is absent rather than disabled. The beat's
    // closing dissolve to the owlette desktop app is a NATIVE insert, filmed by
    // the desktop-screenshots video sibling.
    await recordScene(
      browser,
      '08-remote-actions-b08-member',
      { baseURL: E2E_BASE_URL, storageState: roleState('member').storageState },
      async (page) => {
        await openForCapture(page, '/dashboard');
        const focusCard = page
          .getByTestId('machine-card')
          .filter({ hasText: 'media-server-stage' });
        await centerInView(page, focusCard);
        const menuTrigger = focusCard.getByTestId('machine-context-menu-trigger');
        await openMachineMenu(page, menuTrigger);
        // Proof the frame is worth cutting: the admin verbs are not in the DOM.
        await expect(page.getByTestId('machine-context-menu-reboot')).toHaveCount(0);
        await expect(page.getByTestId('machine-context-menu-shutdown')).toHaveCount(0);
        await expect(page.getByTestId('machine-context-menu-revoke-token')).toHaveCount(0);
        await expect(page.getByTestId('machine-context-menu-remove')).toHaveCount(0);
        await narrate(page, 'b08 the member menu — admin block absent', 2.5);
        await slowPush(page, { scale: 1.05, originXPct: 50, originYPct: 50, seconds: 4.0 });
        await narrate(page, 'b08 the member menu — admin block absent — close', 4.0);
        await slowPush(page, { scale: 1.0, seconds: 3.0 });
        await narrate(page, 'b08 the member menu — admin block absent — settle', 2.5);
      },
    );
  } finally {
    await ctx.cleanup();
  }
});
