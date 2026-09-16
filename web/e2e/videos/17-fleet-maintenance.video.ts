/**
 * Scene — episode 17, "keeping the fleet current".
 *
 * Rendered VO (voiceover/out/17-fleet-maintenance/, ffprobe):
 *   b01 14.0s the upkeep nobody schedules · b02 18.3s the button that tells you
 *   b03 22.4s why three-point-oh is a wall · b04 25.8s roll it to one machine
 *   b05 22.4s then the rest of them · b06 23.2s the token ledger
 *   b07 25.0s revoke the right one · b08 28.5s retiring a machine, in order
 *   b09 25.2s the monthly rhythm
 *
 * TWO CLIPS, because the episode deliberately crosses a role boundary:
 *   17-fleet-maintenance.mp4        — the site ADMIN's session (b01-b05,
 *                                     b07-b09). b07's revoke-token menu item and
 *                                     its route are BOTH site-admin as of
 *                                     e0c8341a, and the beat says so out loud,
 *                                     so it must not be shot as a superadmin.
 *   17-fleet-maintenance-b06-tokens.mp4 — /admin/tokens, shot as a superadmin.
 *
 * Fixture `dashboard-mixed-states` plus three things it does not carry, seeded
 * here and cleaned up after:
 *   - `installer_metadata/latest` at 3.2.0 — a TOP-LEVEL doc, so
 *     `deleteSiteSubtree` never touches it. Without it `useInstallerVersion`
 *     has no latest version and the orange update button never renders.
 *   - per-machine `agent_version` — the fixture writes 3.0.0 for every machine,
 *     which would make the whole fleet outdated and the version column
 *     uniform. Two machines are left behind (one of them the offline one, for
 *     b05's disabled row) and one has none at all, which is the "—" b03 names.
 *   - one completed deployment, for b08's `uninstall software` dialog.
 *
 * NOTHING IS CONFIRMED ON CAMERA. Update, revoke and remove all dispatch real
 * commands; every dialog here is opened, framed, and cancelled.
 *
 * Run:  cd web && npm run videos -- --grep "episode 17"
 * Out:  dev/video-tutorials/footage/web/17-fleet-maintenance.mp4
 *       dev/video-tutorials/footage/web/17-fleet-maintenance-b06-tokens.mp4
 */

import { FieldValue, Timestamp } from 'firebase-admin/firestore';
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
  slowScrollToBottom,
  centerInView,
  clickWithCursor,
  moveCursorTo,
} from './video-helpers';

// TWO recordScene clips, ~190s of dwell and a large pre-seed in one test — the
// config's 5-minute per-test default covers all of it and nothing else.
test.setTimeout(8 * 60_000);

const LATEST_VERSION = '3.2.0';
const TOKEN_IDS = [
  'video-token-td-control-room-current',
  'video-token-td-control-room-duplicate',
  'video-token-media-server-stage',
  'video-token-lobby-display',
];

test('episode 17 — keeping the fleet current', async ({ browser }) => {
  const ctx = await seedScreenshotFixtures('dashboard-mixed-states');
  try {
    const db = getAdminDb();
    for (const uid of [TEST_USERS.admin.uid, TEST_USERS.superadmin.uid]) {
      await db.collection('users').doc(uid).set({ lastSiteId: ctx.siteId }, { merge: true });
    }

    // The latest installer, as the release flow writes it.
    await db.collection('installer_metadata').doc('latest').set({
      version: LATEST_VERSION,
      download_url: `https://e2e-seed.test/installers/Owlette-Installer-v${LATEST_VERSION}.exe`,
      file_size: 118_293_504,
      checksum_sha256: 'ab'.repeat(32),
      release_date: Timestamp.fromMillis(FIXED_NOW_MS - 60 * 60 * 24 * 6 * 1000),
      release_notes: 'temperature via the signed PawnIO driver; WinRing0 retired.',
      deletedAt: null,
    });

    // Per-machine agent versions: current, behind, and unknown.
    const machinesRef = db.collection('sites').doc(ctx.siteId).collection('machines');
    const versions: Record<string, string> = {
      'lobby-display': LATEST_VERSION,
      'museum-kiosk-1': LATEST_VERSION,
      'media-server-stage': LATEST_VERSION,
      'nyc-signage-01': LATEST_VERSION,
      'unreal-render-1': LATEST_VERSION,
      'lobby-2': LATEST_VERSION,
      'mainstage-led': LATEST_VERSION,
      // Behind the 3.0 service-host wall — the machines b04/b05 roll forward.
      'td-control-room': '2.12.21',
      // Offline AND behind: b05's disabled row.
      'touring-rig-04': '2.12.21',
    };
    for (const [machineId, version] of Object.entries(versions)) {
      await machinesRef.doc(machineId).set({ agent_version: version }, { merge: true });
    }
    // b03's "—" column: a machine that has never reported a version.
    await machinesRef.doc('museum-kiosk-2').update({ agent_version: FieldValue.delete() });

    // b08: something to uninstall. `deleteSiteSubtree` drops deployments.
    await db
      .collection('sites')
      .doc(ctx.siteId)
      .collection('deployments')
      .doc('depl-signage-player-v6')
      .set({
        name: 'signage player v6',
        installer_name: 'signage-player-6.0.exe',
        installer_url: 'https://e2e-seed.test/installers/signage-player-6.0.exe',
        silent_flags: '/S',
        status: 'completed',
        createdAt: Timestamp.fromMillis(FIXED_NOW_MS - 60 * 60 * 24 * 12 * 1000),
        completedAt: Timestamp.fromMillis(FIXED_NOW_MS - 60 * 60 * 24 * 12 * 1000 + 900_000),
        targets: ['lobby-display', 'nyc-signage-01', 'lobby-2'].map((machineId) => ({
          machineId,
          status: 'completed',
          progress: 100,
        })),
      });

    // b06: the token ledger. `agent_refresh_tokens` is TOP-LEVEL — a doc is
    // "live" while it carries neither `supersededAt`/`supersededBy` nor a past
    // `expiresAt` (lib/agentTokens.ts). Two share a machineId so the
    // `duplicates` filter has something to find.
    const tokensRef = db.collection('agent_refresh_tokens');
    const tokenSeed: Array<{ id: string; machineId: string; version: string; ageDays: number }> = [
      { id: TOKEN_IDS[0], machineId: 'td-control-room', version: '2.12.21', ageDays: 210 },
      { id: TOKEN_IDS[1], machineId: 'td-control-room', version: LATEST_VERSION, ageDays: 4 },
      { id: TOKEN_IDS[2], machineId: 'media-server-stage', version: LATEST_VERSION, ageDays: 31 },
      { id: TOKEN_IDS[3], machineId: 'lobby-display', version: LATEST_VERSION, ageDays: 88 },
    ];
    for (const t of tokenSeed) {
      await tokensRef.doc(t.id).set({
        siteId: ctx.siteId,
        machineId: t.machineId,
        agentUid: `agent-${t.machineId}`,
        version: t.version,
        createdBy: 'admin@e2e.test',
        createdAt: Timestamp.fromMillis(FIXED_NOW_MS - t.ageDays * 24 * 60 * 60 * 1000),
        lastUsed: Timestamp.fromMillis(FIXED_NOW_MS - 60 * 60 * 1000),
      });
    }

    // ── Clip 1: the site admin's session ─────────────────────────────────────
    await recordScene(
      browser,
      '17-fleet-maintenance',
      { baseURL: E2E_BASE_URL, storageState: roleState('admin').storageState },
      async (page) => {
        // [b01] the upkeep nobody schedules (~14.0s) — a slow pan across the
        // mixed fleet.
        await openForCapture(page, '/dashboard');
        await expect(page.getByTestId('machine-card')).toHaveCount(10);
        await slowScrollToBottom(page, 10);
        await page.evaluate(() => window.scrollTo({ top: 0, behavior: 'instant' }));
        await narrate(page, 'b01 the fleet still needs upkeep', 5);

        // [b02] the button that tells you (~18.3s). The button is scoped to the
        // selected site (`useMachines(currentSiteId)`) and renders ONLY when at
        // least one of that site's machines is behind `installer_metadata/latest`
        // — no button means the site is current, which is b09's punchline.
        await openForCapture(page, '/deployments');
        const updateButton = page.getByRole('button', { name: /update owlette/i });
        await expect(updateButton).toBeVisible({ timeout: 20_000 });
        await centerInView(page, updateButton);
        await highlight(page, updateButton, 3000);
        await narrate(page, 'b02 orange button, version + count badge', 5.7);
        await slowPush(page, { scale: 1.04, originXPct: 50, originYPct: 48, seconds: 4.0 });
        await narrate(page, 'b02 orange button, version + count badge - close', 5.3);
        await slowPush(page, { scale: 1.0, seconds: 3.0 });
        await narrate(page, 'b02 orange button, version + count badge - settle', 1.0);

        // [b03] why three-point-oh is a wall (~22.4s). Manage sites → expand the
        // site → the per-machine list with its agent version column.
        await openForCapture(page, '/dashboard');
        await clickWithCursor(page, page.getByTestId('site-switcher-trigger'));
        await clickWithCursor(page, page.getByRole('menuitem', { name: /manage sites/i }));
        const manageDialog = page.getByRole('dialog');
        await expect(manageDialog).toBeVisible();
        await narrate(page, 'b03 3.0 replaced the service host', 8);
        await clickWithCursor(
          page,
          manageDialog.getByRole('button', { name: /^machines on / }),
        );
        await page.waitForTimeout(1000);
        await expect(manageDialog.getByText('v2.12.21', { exact: false }).first()).toBeVisible();
        await narrate(page, 'b03 every machine lists the version it is on', 4.5);
        await slowPush(page, { scale: 1.05, originXPct: 50, originYPct: 42, seconds: 4.0 });
        await narrate(page, 'b03 every machine lists the version it is on - close', 2.5);
        await slowPush(page, { scale: 1.0, seconds: 3.0 });
        await narrate(page, 'b03 every machine lists the version it is on - settle', 1.0);
        await page.keyboard.press('Escape');
        await page.waitForTimeout(500);

        // [b04] roll it to one machine (~25.8s).
        await openForCapture(page, '/deployments');
        await clickWithCursor(page, page.getByRole('button', { name: /update owlette/i }));
        const updateDialog = page.getByRole('dialog', { name: /update owlette agents/i });
        await expect(updateDialog).toBeVisible();
        await narrate(page, 'b04 what happens during an update', 9);
        await clickWithCursor(page, updateDialog.getByRole('button', { name: /^deselect all$/i }));
        // Each machine is one <label> wrapping its checkbox — anchor on the row
        // rather than on list order, which follows the machines listener.
        const tdRow = updateDialog
          .locator('label')
          .filter({ hasText: 'td-control-room' })
          .first();
        await centerInView(page, tdRow);
        await clickWithCursor(page, tdRow.getByRole('checkbox'));
        await expect(tdRow.getByText('current: v2.12.21', { exact: false })).toBeVisible();
        await narrate(page, 'b04 one box, current → latest', 8);
        // Framed, never clicked: this dispatches a real update command.
        await highlight(page, updateDialog.getByRole('button', { name: /^update \d+ machine/i }), 2600);
        await narrate(page, 'b04 checksum verified, service restarts itself', 9);

        // [b05] then the rest of them (~22.4s). Offline machines still list but
        // cannot be ticked — an agent that is not listening cannot take the
        // command.
        await clickWithCursor(page, updateDialog.getByRole('button', { name: /^select all$/i }));
        const offlineRow = updateDialog
          .getByText('must be online to receive an update', { exact: false })
          .first();
        await centerInView(page, offlineRow);
        await highlight(page, offlineRow, 2800);
        await narrate(page, 'b05 select all; offline rows stay disabled', 4.5);
        await slowPush(page, { scale: 1.04, originXPct: 50, originYPct: 50, seconds: 4.0 });
        await narrate(page, 'b05 select all; offline rows stay disabled - close', 2.5);
        await slowPush(page, { scale: 1.0, seconds: 3.0 });
        await narrate(page, 'b05 select all; offline rows stay disabled - settle', 1.0);
        await narrate(page, 'b05 fifteen minutes on updating → may have failed', 8);
        await clickWithCursor(page, updateDialog.getByRole('button', { name: /^cancel$/i }));
        await expect(updateDialog).not.toBeVisible();

        // [b07] revoke the right one (~25.0s). Site-admin power, on the admin's
        // own site — since e0c8341a this menu item and its route are both
        // site-admin, so do NOT reshoot it as a superadmin.
        await openForCapture(page, '/dashboard');
        const tdCard = page
          .getByTestId('machine-card')
          .filter({ hasText: 'td-control-room' });
        await centerInView(page, tdCard);
        const menuTrigger = tdCard.getByTestId('machine-context-menu-trigger');
        // The ⋮ trigger sits inside a Radix Tooltip; an unforced click times out.
        await moveCursorTo(page, menuTrigger);
        await page.waitForTimeout(250);
        await menuTrigger.click({ force: true });
        await page.waitForTimeout(600);
        await clickWithCursor(page, page.getByTestId('machine-context-menu-revoke-token'));
        const revokeDialog = page.getByRole('dialog');
        await expect(revokeDialog).toBeVisible();
        await highlight(page, revokeDialog.getByRole('button', { name: /revoke current token/i }), 2600);
        await narrate(page, 'b07 revoke current — the newest credential only', 12);
        await highlight(page, revokeDialog.getByRole('button', { name: /revoke all for hostname/i }), 2600);
        await narrate(page, 'b07 revoke all — every machine sharing the name', 14);
        await page.keyboard.press('Escape');
        await page.waitForTimeout(500);

        // [b08] retiring a machine, in order (~28.5s). Uninstall while the agent
        // is still online, THEN remove.
        await openForCapture(page, '/deployments');
        const deploymentActions = page.getByRole('button', {
          name: /deployment actions for signage player v6/i,
        });
        await centerInView(page, deploymentActions);
        await clickWithCursor(page, deploymentActions);
        await clickWithCursor(page, page.getByRole('menuitem', { name: /uninstall software/i }));
        const uninstallDialog = page.getByRole('dialog');
        await expect(uninstallDialog).toBeVisible();
        await narrate(page, 'b08 uninstall first, while the agent is up', 13);
        await page.keyboard.press('Escape');
        await page.waitForTimeout(500);

        await openForCapture(page, '/dashboard');
        const retireCard = page
          .getByTestId('machine-card')
          .filter({ hasText: 'touring-rig-04' });
        await centerInView(page, retireCard);
        const retireTrigger = retireCard.getByTestId('machine-context-menu-trigger');
        await moveCursorTo(page, retireTrigger);
        await page.waitForTimeout(250);
        await retireTrigger.click({ force: true });
        await page.waitForTimeout(600);
        await clickWithCursor(page, page.getByTestId('machine-context-menu-remove'));
        const removeDialog = page.getByRole('dialog');
        await expect(removeDialog).toBeVisible();
        await centerInView(page, removeDialog);
        await narrate(page, 'b08 remove machine — what actually gets deleted', 4.8);
        await slowPush(page, { scale: 1.05, originXPct: 50, originYPct: 45, seconds: 4.0 });
        await narrate(page, 'b08 remove machine — what actually gets deleted - close', 3.2);
        await slowPush(page, { scale: 1.0, seconds: 3.0 });
        await narrate(page, 'b08 remove machine — what actually gets deleted - settle', 1.0);
        await page.keyboard.press('Escape');
        await page.waitForTimeout(500);

        // [b09] the monthly rhythm (~25.2s). Bring the fleet current so the
        // orange button disappears — "no button to press" is the closing line,
        // and it has to be true on camera rather than cut around.
        for (const machineId of ['td-control-room', 'touring-rig-04']) {
          await machinesRef.doc(machineId).set({ agent_version: LATEST_VERSION }, { merge: true });
        }
        await machinesRef.doc('museum-kiosk-2').set({ agent_version: LATEST_VERSION }, { merge: true });
        await openForCapture(page, '/deployments');
        await expect(page.getByRole('button', { name: /update owlette/i })).toHaveCount(0);
        await narrate(page, 'b09 no orange badge left on this site', 12);
        await openForCapture(page, '/dashboard');
        await slowScrollToBottom(page, 9);
        await narrate(page, 'b09 all green — the best sign of all', 5);
      },
    );

    // ── Clip 2: the token ledger ─────────────────────────────────────────────
    // [b06] (~23.2s). /admin/tokens is wrapped in RequireAdminAccess at
    // minRole 'admin', and the list route is site-scoped AGENT_TOKEN_REVOKE.
    await recordScene(
      browser,
      '17-fleet-maintenance-b06-tokens',
      { baseURL: E2E_BASE_URL, storageState: roleState('superadmin').storageState },
      async (page) => {
        await openForCapture(page, '/admin/tokens');
        await expect(
          page.getByRole('heading', { name: 'agent tokens', exact: true }),
        ).toBeVisible();
        await expect(page.getByText('4 live', { exact: false })).toBeVisible({ timeout: 20_000 });
        await narrate(page, 'b06 every live token for the selected site', 9);
        await highlight(page, page.getByPlaceholder('search machine id or agent uid'), 1800);
        await narrate(page, 'b06 search + version filter', 6);
        const duplicatesToggle = page.getByRole('button', { name: /^duplicates/i });
        await centerInView(page, duplicatesToggle);
        await clickWithCursor(page, duplicatesToggle);
        await page.waitForTimeout(600);
        await narrate(page, 'b06 duplicates — one hostname, two tokens', 9);
      },
    );
  } finally {
    const db = getAdminDb();
    await db.collection('installer_metadata').doc('latest').delete().catch(() => undefined);
    for (const id of TOKEN_IDS) {
      await db.collection('agent_refresh_tokens').doc(id).delete().catch(() => undefined);
    }
    await ctx.cleanup();
  }
});
