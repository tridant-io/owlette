/**
 * Scene — episode 16, "logs & troubleshooting". Every beat is SCREEN capture.
 *
 * Rendered VO (voiceover/out/16-logs-and-troubleshooting/, ffprobe):
 *   b01 20.1s the activity timeline · b02 20.3s reading an entry
 *   b03 24.1s filtering the noise · b04 19.5s the crash screenshot
 *   b05 13.3s expand for the full record · b06 19.8s clearing up, safely
 *   b07 23.2s when you're still stuck
 * b01 and b06 were revoiced for the v2 series.
 *
 * b07 IS HALF NATIVE. The dashboard half — help menu → docs, opening /docs
 * in-app — is web capture and is shot here. The machine half — the owlette
 * app's ⋯ menu → "submit bug report" — is the Tauri app, filmed by the
 * desktop-screenshots video sibling over WebView2 CDP.
 *
 * `control-process-restarting` seeds processes but not logs, so this scene
 * seeds its own entries inline; the shape matches the LogEvent interface in
 * app/logs/page.tsx and every `action` value below is one the filter actually
 * offers (ACTION_TYPE_GROUPS, page.tsx:137-227).
 *
 * Run:  cd web && npm run videos -- --grep "episode 16"
 * Out:  dev/video-tutorials/footage/web/16-logs-and-troubleshooting.mp4
 */

import { test, expect } from '@playwright/test';
import { roleState } from '../helpers/roles';
import { getAdminDb, E2E_BASE_URL } from '../helpers/emulator';
import { TEST_USERS } from '../helpers/seed';
import { seedScreenshotFixtures, FIXED_NOW_MS } from '../screenshots/fixtures';
import {
  recordScene,
  openForCapture,
  narrate,
  slowPush,
  highlight,
  clickWithCursor,
  centerInView,
  moveCursorTo,
  typewrite,
} from './video-helpers';

// 1x1 transparent PNG: renders the Camera indicator + click-to-enlarge without a
// network fetch, so no broken-image icon can appear on camera.
const TRANSPARENT_PNG =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=';

test('episode 16 — logs & troubleshooting', async ({ browser }) => {
  const ctx = await seedScreenshotFixtures('control-process-restarting');
  try {
    // Auto-select the seeded site on load.
    await getAdminDb()
      .collection('users')
      .doc(TEST_USERS.admin.uid)
      .set({ lastSiteId: ctx.siteId }, { merge: true });

    // Seed log entries. The Admin SDK converts Date → Timestamp on write and
    // Timestamp.toDate() round-trips cleanly on read.
    //
    // Anchor on FIXED_NOW_MS, never wall-clock: `recordScene` freezes the page's
    // Date to it, so entries stamped "now" land months in the page's FUTURE and
    // `relativeTime` (app/logs/page.tsx:281-284) renders every row as "just now"
    // — with b05's expanded absolute stamp reading a different month from every
    // other episode, and b06's typed 2026-04-10 → 2026-04-15 window covering
    // none of them.
    const ago = (sec: number): Date => new Date(FIXED_NOW_MS - sec * 1000);
    const logsRef = getAdminDb().collection('sites').doc(ctx.siteId).collection('logs');
    const entries = [
      {
        id: 'log-crash-touchdesigner',
        timestamp: ago(60 * 7),
        action: 'process_crash',
        level: 'error',
        machineId: 'td-control-room',
        machineName: 'td-control-room',
        processName: 'touchdesigner.exe',
        details:
          'process exited with code -1073741819 (access violation). cuda driver hiccup on GPU0. auto-restart in 8s.',
        screenshotUrl: TRANSPARENT_PNG,
      },
      {
        id: 'log-restart-touchdesigner',
        timestamp: ago(60 * 6),
        action: 'process_started',
        level: 'info',
        machineId: 'td-control-room',
        machineName: 'td-control-room',
        processName: 'touchdesigner.exe',
        details: 'auto-restart after crash (attempt 1/3). pid 4218.',
      },
      {
        id: 'log-deploy-failed',
        timestamp: ago(60 * 60 * 4),
        action: 'deployment_failed',
        level: 'error',
        machineId: 'media-server-stage',
        machineName: 'media-server-stage',
        processName: '',
        details: 'msi exit code 1603 (fatal install error) — TouchDesigner-2024.40000.exe',
      },
      {
        id: 'log-disk-warning',
        timestamp: ago(60 * 60 * 2),
        action: 'command_executed',
        level: 'warning',
        machineId: 'media-server-stage',
        machineName: 'media-server-stage',
        processName: '',
        details: 'disk C: at 88% capacity — consider clearing render cache.',
      },
      {
        id: 'log-talon-triggered',
        timestamp: ago(60 * 45),
        action: 'talon_triggered',
        level: 'info',
        machineId: 'lobby-display',
        machineName: 'lobby-display',
        processName: '',
        details: 'talon "doors open — lobby wall is live" fired on schedule 09:45.',
      },
      {
        id: 'log-display-drift',
        timestamp: ago(60 * 60 * 9),
        action: 'display_drift',
        level: 'warning',
        machineId: 'mainstage-led',
        machineName: 'mainstage-led',
        processName: '',
        details: 'live layout no longer matches stored — 1 monitor moved (Mainstage 2).',
      },
      {
        id: 'log-scheduled-reboot',
        timestamp: ago(60 * 60 * 18),
        action: 'scheduled_reboot_success',
        level: 'info',
        machineId: 'lobby-display',
        machineName: 'lobby-display',
        processName: '',
        details: 'scheduled restart completed (preset: weekday 4am).',
      },
      {
        id: 'log-agent-started-1',
        timestamp: ago(60 * 60 * 20),
        action: 'agent_started',
        level: 'info',
        machineId: 'td-control-room',
        machineName: 'td-control-room',
        processName: '',
        details: 'agent online — version 3.2.0.',
      },
      {
        id: 'log-agent-started-2',
        timestamp: ago(60 * 60 * 26),
        action: 'agent_started',
        level: 'info',
        machineId: 'mainstage-led',
        machineName: 'mainstage-led',
        processName: '',
        details: 'agent online — version 3.2.0.',
      },
      {
        id: 'log-obs-killed',
        timestamp: ago(60 * 60 * 30),
        action: 'process_killed',
        level: 'warning',
        machineId: 'td-control-room',
        machineName: 'td-control-room',
        processName: 'obs64.exe',
        details: 'killed by deploy hook (close-processes flag set on stage-show v3).',
      },
    ];
    for (const e of entries) {
      const { id, ...data } = e;
      await logsRef.doc(id).set(data);
    }

    await recordScene(
      browser,
      '16-logs-and-troubleshooting',
      { baseURL: E2E_BASE_URL, storageState: roleState('admin').storageState },
      async (page) => {
        // [b01] the activity timeline — settle on /logs (~20.1s).
        await openForCapture(page, '/logs');
        await expect(
          page.getByRole('heading', { name: 'logs', exact: true }),
        ).toBeVisible();
        // Newest-first crash row should be at the top.
        await expect(
          page.getByText('access violation', { exact: false }).first(),
        ).toBeVisible();
        await narrate(page, 'b01 logs timeline — settle', 6.3);
        await slowPush(page, { scale: 1.04, originXPct: 50, originYPct: 48, seconds: 4.0 });
        await narrate(page, 'b01 logs timeline — settle - close', 6.7);
        await slowPush(page, { scale: 1.0, seconds: 3.0 });
        await narrate(page, 'b01 logs timeline — settle - settle', 1.0);

        // [b02] reading an entry — the crash row's six columns, then a second
        // error row so "your eye goes straight to the red" has two on screen
        // (~20.3s).
        const crashRow = page.getByTestId('log-row-log-crash-touchdesigner');
        await centerInView(page, crashRow);
        await highlight(page, crashRow, 2200);
        await narrate(page, 'b02 row anatomy', 3.6);
        await slowPush(page, { scale: 1.05, originXPct: 50, originYPct: 42, seconds: 3.5 });
        await narrate(page, 'b02 row anatomy - close', 1.4);
        await slowPush(page, { scale: 1.0, seconds: 2.5 });
        await narrate(page, 'b02 row anatomy - settle', 1.0);
        const deployFailedRow = page.getByTestId('log-row-log-deploy-failed');
        await centerInView(page, deployFailedRow);
        await highlight(page, deployFailedRow, 1800);
        await narrate(page, 'b02 second error row', 9);

        // [b03] filtering the noise (~24.1s) — open filters, then step through
        // action / machine / level / date, and the search box.
        const filtersBtn = page.getByRole('button', { name: /show filters/i });
        await clickWithCursor(page, filtersBtn);
        await page.waitForTimeout(400);

        const actionFilter = page.getByTestId('logs-filter-action');
        await highlight(page, actionFilter, 1400);
        // The action list is grouped now — agent, processes, commands,
        // deployments, restarts, displays, talons. Open it and scroll so the
        // talon group is on camera.
        await clickWithCursor(page, actionFilter);
        await page.waitForTimeout(400);
        const talonOption = page.getByRole('option', { name: 'talon triggered' });
        await talonOption.scrollIntoViewIfNeeded();
        await highlight(page, talonOption, 1800);
        await narrate(page, 'b03 grouped action filter', 8);
        await page.keyboard.press('Escape');
        await page.waitForTimeout(300);

        await highlight(page, page.getByTestId('logs-filter-machine'), 1400);
        await narrate(page, 'b03 machine filter', 4);
        await highlight(page, page.getByTestId('logs-filter-level'), 1400);
        await narrate(page, 'b03 level filter', 4);
        await highlight(page, page.getByTestId('logs-filter-date'), 1400);
        await narrate(page, 'b03 date range', 4);

        // The collapsed search button's accessible name is "search logs"
        // (aria-label, page.tsx:866) even though the glyph reads "search".
        await clickWithCursor(page, page.getByRole('button', { name: /search logs/i }));
        const searchInput = page.getByTestId('logs-search');
        await expect(searchInput).toBeVisible();
        await highlight(page, searchInput, 1800);
        await narrate(page, 'b03 full-text search', 5);

        // [b04] the crash screenshot (~19.5s). Row cells are wrapped in Radix
        // Tooltips that mount on hover and overlay the CollapsibleTrigger (same
        // as episode 8's context menu), so `clickWithCursor` is off-limits — use
        // moveCursorTo + a forced click past the tooltip portal.
        await centerInView(page, crashRow);
        await moveCursorTo(page, crashRow);
        await page.waitForTimeout(250);
        await crashRow.click({ force: true });
        await page.waitForTimeout(400);
        const crashThumb = crashRow.locator('img[alt="Crash screenshot"]');
        await expect(crashThumb).toBeVisible();
        await highlight(page, crashThumb, 2200);
        await narrate(page, 'b04 crash thumbnail', 10);
        await clickWithCursor(page, crashThumb);
        const fullModal = page.locator('img[alt="Crash screenshot"]').last();
        await expect(fullModal).toBeVisible();
        await narrate(page, 'b04 full size', 10);
        await page.keyboard.press('Escape');
        await page.waitForTimeout(400);

        // [b05] expand for the full record (~13.3s). Collapse the open crash row
        // first — same tooltip-overlay workaround — then hit expand-all.
        await moveCursorTo(page, crashRow);
        await page.waitForTimeout(250);
        await crashRow.click({ force: true });
        await page.waitForTimeout(300);
        const expandAllBtn = page.getByTestId('logs-expand-all');
        await clickWithCursor(page, expandAllBtn);
        await page.waitForTimeout(500);
        const expandedDetails = page.getByText('machine id', { exact: true }).first();
        await centerInView(page, expandedDetails);
        await highlight(page, expandedDetails, 1800);
        await narrate(page, 'b05 machine id, exact timestamp, raw details', 4.2);
        await slowPush(page, { scale: 1.04, originXPct: 50, originYPct: 50, seconds: 4.0 });
        await narrate(page, 'b05 machine id, exact timestamp, raw details - close', 1.8);
        await slowPush(page, { scale: 1.0, seconds: 3.0 });
        await narrate(page, 'b05 machine id, exact timestamp, raw details - settle', 1.0);

        // [b06] clearing up, safely (~19.8s). The dialog carries its OWN from/to
        // pickers and builds a live scope list above them; the page's date
        // filter and the search box do NOT scope the delete.
        await clickWithCursor(page, expandAllBtn);
        await page.waitForTimeout(300);
        const clearLogsBtn = page.getByRole('button', { name: /^clear logs$/i });
        await centerInView(page, clearLogsBtn);
        await clickWithCursor(page, clearLogsBtn);
        const clearDialog = page.getByRole('dialog', { name: /clear event logs/i });
        await expect(clearDialog).toBeVisible();
        // Each picker is a typeable text Input (canonical yyyy-mm-dd) with a
        // calendar-icon Popover beside it, not a button — so type the range and
        // watch the scope list above gain its "from:" / "to:" lines.
        const fromInput = clearDialog.getByPlaceholder('any start');
        const toInput = clearDialog.getByPlaceholder('any end');
        await typewrite(page, fromInput, '2026-04-10', 55);
        await page.keyboard.press('Enter');
        await typewrite(page, toInput, '2026-04-15', 55);
        await page.keyboard.press('Enter');
        await page.waitForTimeout(400);
        await narrate(page, 'b06 from/to pickers scope the delete', 11);
        // Clear them again to surface the all-logs warning — the honest habit
        // this beat is teaching is the opposite of what this frame shows.
        await fromInput.fill('');
        await page.keyboard.press('Enter');
        await toInput.fill('');
        await page.keyboard.press('Enter');
        await page.waitForTimeout(400);
        const scopeCopy = clearDialog.getByText(/with no date range or view filters set/i).first();
        await expect(scopeCopy).toBeVisible();
        await centerInView(page, scopeCopy);
        await highlight(page, scopeCopy, 2400);
        await narrate(page, 'b06 set nothing and it wipes the site', 9);
        // Cancel out — never confirm on camera.
        await clickWithCursor(page, clearDialog.getByRole('button', { name: /^cancel$/i }));
        await expect(clearDialog).not.toBeVisible();

        // [b07] when you're still stuck (~23.2s). Web half: the header help menu
        // opens /docs in-app. The machine half — the owlette app's ⋯ menu →
        // "submit bug report", which attaches system info and the last hundred
        // lines of the service log — is a NATIVE segment.
        await clickWithCursor(page, page.getByRole('button', { name: 'help' }));
        const docsItem = page.getByRole('menuitem', { name: /^docs$/i });
        await expect(docsItem).toBeVisible();
        await highlight(page, docsItem, 2200);
        await narrate(page, 'b07 the help menu', 6);
        await clickWithCursor(page, docsItem);
        await page.waitForURL(/\/docs/, { timeout: 20_000 });
        await page.waitForTimeout(1500);
        await narrate(page, 'b07 docs, in the app — then cut to the native insert', 5.1);
        await slowPush(page, { scale: 1.05, originXPct: 50, originYPct: 45, seconds: 4.0 });
        await narrate(page, 'b07 docs, in the app — then cut to the native insert - close', 3.9);
        await slowPush(page, { scale: 1.0, seconds: 3.0 });
        await narrate(page, 'b07 docs, in the app — then cut to the native insert - settle', 1.0);
      },
    );
  } finally {
    await ctx.cleanup();
  }
});
