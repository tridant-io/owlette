/**
 * Scene — episode 14, "team & alerts". Every beat is SCREEN capture.
 *
 * Rendered VO (voiceover/out/14-team-and-alerts/, ffprobe):
 *   b01 24.2s the team, from your admin seat · b02 28.1s members: who's on this site
 *   b03 19.6s the rest of your panel · b04 11.7s alerts: let owlette tell you
 *   b05 29.8s build a rule · b06 18.2s your personal alert preferences
 *   b07 25.6s what actually arrives
 *
 * SITE ADMIN throughout — e6e99cbf opened /admin to site admins (guard
 * RequireAdminAccess, nav filtered by app/admin/navItems.ts). `superadmin`
 * must never render on camera: the recording role is global `admin`, the
 * internal-only nav items are absent for it by design, and the seeded site
 * owner gets a human display name below because the members table shows it.
 *
 * ALERT SCHEMA. /admin/alerts reads `sites/{id}/settings/alerts.rules[]`, seeded
 * inline below the way `screenshots/email-alerts.spec.ts` does. The base
 * scenario also writes `sites/{id}/alertRules/*`, which is DEAD DATA — written
 * only by fixtures.ts and read by nothing. The live automation schema is
 * `sites/{siteId}/talons` (scenario `automate-talons-list`), which is episode 13.
 *
 * b07 IS PART-BLOCKED — see the beat comment for the one-line product change
 * that unblocks the email frame.
 *
 * Run:  cd web && npm run videos -- --grep "episode 14"
 * Out:  dev/video-tutorials/footage/web/14-team-and-alerts.mp4
 */

import { test, expect } from '@playwright/test';
import { roleState } from '../helpers/roles';
import { getAdminAuth, getAdminDb, E2E_BASE_URL } from '../helpers/emulator';
import { TEST_USERS, seedMemberRow, seedUser } from '../helpers/seed';
import { FIXED_NOW_MS, seedScreenshotFixtures } from '../screenshots/fixtures';
import {
  recordScene,
  openForCapture,
  narrate,
  slowPush,
  highlight,
  clickWithCursor,
  typewrite,
  centerInView,
} from './video-helpers';

test('episode 14 — team & alerts', async ({ browser }) => {
  const ctx = await seedScreenshotFixtures('automate-schedule-editor');
  // b03's tokens, out here so the finally can delete them: episode 17's ledger
  // counts every live token on the site
  const tokenMachines = [
    ['mainstage-led', 26 * 24],
    ['media-server-stage', 19 * 24],
    ['td-control-room', 11 * 24],
    ['touring-rig-04', 6 * 24],
    ['unreal-render-1', 2 * 24],
  ] as const;
  try {
    // Pin the RECORDING admin to the seeded site so per-site selectors find
    // data. The admin is a member of the site (fixtures assign it), but the
    // crown belongs to someone else — b02's narration separates "the owner"
    // from "your own row", so the owner must be a distinct account.
    await getAdminDb()
      .collection('users')
      .doc(TEST_USERS.admin.uid)
      .set({ lastSiteId: ctx.siteId }, { merge: true });
    // the crown comes from an owner member row: the members list reads member
    // rows, never the site doc's `owner` field. the finally takes it off again
    await seedMemberRow(ctx.siteId, TEST_USERS.superadmin.uid, 'owner');
    // The owner row renders the account's display name — "E2E Superadmin"
    // would put the internal role word on camera, so the owner films as a
    // person. Both stores, because the members API reads the users doc and
    // the auth record is what a future re-seed restores from.
    await getAdminDb()
      .collection('users')
      .doc(TEST_USERS.superadmin.uid)
      .set({ displayName: 'avery quinn' }, { merge: true });
    await getAdminAuth().updateUser(TEST_USERS.superadmin.uid, { displayName: 'avery quinn' });

    // b02 adds a teammate by email on camera — the account must exist
    // (members POST resolves email via Admin Auth) and must NOT already be on
    // the site, so the add lands a genuinely new row.
    await seedUser({
      uid: 'rae-uid',
      email: 'rae@e2e.test',
      password: 'e2e-rae-password',
      role: 'member',
      sites: [],
      displayName: 'rae calloway',
    });

    // b03 pans the tokens and webhooks pages — empty states would put
    // "no active tokens" under narration about machine credentials, so both
    // get realistic rows. Tokens: top-level `agent_refresh_tokens`, one live
    // doc per machine (no supersededAt/expiresAt = live; shape mirrors what
    // the pairing flow writes, read back by /api/sites/{id}/agent-tokens).
    const hoursAgo = (h: number) => new Date(FIXED_NOW_MS - h * 3_600_000);
    for (const [machineId, ageHours] of tokenMachines) {
      await getAdminDb()
        .collection('agent_refresh_tokens')
        .doc(`e2e-token-${machineId}`)
        .set({
          siteId: ctx.siteId,
          machineId,
          agentUid: `agent-${machineId}`,
          version: '3.2.3',
          createdBy: 'device-code',
          createdAt: hoursAgo(ageHours),
          lastUsed: hoursAgo(1),
        });
    }
    // Webhooks: sites/{id}/webhooks/{id}, the full shape the POST route writes.
    await getAdminDb()
      .collection('sites')
      .doc(ctx.siteId)
      .collection('webhooks')
      .doc('e2e-webhook-ops')
      .set({
        schemaVersion: 1,
        url: 'https://hooks.example-productions.com/owlette',
        hostname: 'hooks.example-productions.com',
        events: ['machine.offline', 'deployment.completed', 'version.rolled_back'],
        description: 'ops channel bridge',
        signingSecret: 'whsec_e2e_demo_secret_000000000000',
        secretRotatedAt: null,
        createdAt: hoursAgo(14 * 24),
        updatedAt: hoursAgo(14 * 24),
        createdBy: TEST_USERS.admin.uid,
        paused: false,
        deletedAt: null,
        lastDeliveryAt: hoursAgo(3),
        lastDeliveryStatus: 'success',
        failureCount: 0,
      });

    // Threshold-rule schema on settings/alerts — what /admin/alerts reads.
    await getAdminDb()
      .collection('sites')
      .doc(ctx.siteId)
      .collection('settings')
      .doc('alerts')
      .set({
        rules: [
          {
            id: 'rule-gpu-overheating',
            name: 'GPU Overheating',
            metric: 'gpu_temp',
            operator: '>',
            value: 85,
            severity: 'warning',
            channels: ['email', 'webhook'],
            enabled: true,
            cooldownMinutes: 30,
          },
          {
            id: 'rule-high-cpu-stage',
            name: 'High CPU on stage machines',
            metric: 'cpu_percent',
            operator: '>',
            value: 95,
            severity: 'critical',
            channels: ['email'],
            enabled: true,
            cooldownMinutes: 15,
          },
          {
            id: 'rule-low-disk',
            name: 'Low Disk',
            metric: 'disk_percent',
            operator: '<',
            value: 10,
            severity: 'warning',
            channels: ['email', 'webhook'],
            enabled: true,
            cooldownMinutes: 60,
          },
        ],
      });

    await recordScene(
      browser,
      '14-team-and-alerts',
      { baseURL: E2E_BASE_URL, storageState: roleState('admin').storageState },
      async (page) => {
        // [b01] the team, from your admin seat (~24.2s). dashboard → the avatar
        // menu's "admin panel", which lands a site admin on their sites; then
        // frame the filtered nav — the visual proof of "only what's yours to run".
        await openForCapture(page, '/dashboard');
        await narrate(page, 'b01 first, people — register, no invite email', 6.0);
        await clickWithCursor(page, page.getByTestId('user-menu-trigger'));
        const adminPanelItem = page.getByRole('menuitem', { name: /admin panel/i });
        await expect(adminPanelItem).toBeVisible();
        await highlight(page, adminPanelItem, 1800);
        await clickWithCursor(page, adminPanelItem);
        await expect(page).toHaveURL(/\/admin\/sites$/);
        await expect(
          page.getByRole('heading', { name: 'sites', exact: true }),
        ).toBeVisible();
        await narrate(page, 'b01 from your admin panel, who is on each site', 3.5);
        await slowPush(page, { scale: 1.04, originXPct: 18, originYPct: 40, seconds: 3.2 });
        await narrate(page, 'b01 the nav only shows what is yours to run', 5.0);
        await slowPush(page, { scale: 1.0, seconds: 2.6 });
        await narrate(page, 'b01 settle', 0.5);
        // the site's gear (the fixture names site-A flagship), then its members
        // section. b01's narration is full, so this hop sits in its trimmed tail
        // and b02 opens on the members table.
        await clickWithCursor(page, page.getByRole('link', { name: 'settings for flagship', exact: true }));
        await clickWithCursor(
          page,
          page
            .getByRole('group', { name: 'site settings sections' })
            .getByRole('button', { name: 'members', exact: true }),
        );
        await expect(
          page.getByRole('heading', { name: 'members', exact: true }),
        ).toBeVisible();

        // [b02] members: who's on this site (~28.1s). crown + "you", then a real
        // add by email, then the row menu held open on "change access...": a
        // site admin promotes someone from here, on this site only.
        const ownerRow = page.getByRole('row').filter({ hasText: 'avery quinn' });
        await expect(ownerRow.getByText('owner', { exact: true })).toBeVisible();
        await highlight(page, ownerRow, 2200);
        await narrate(page, 'b02 the owner wears the crown, your own row too', 4.5);
        await clickWithCursor(page, page.getByRole('button', { name: /add member/i }));
        const addDialog = page.getByRole('dialog', { name: 'add member' });
        await expect(addDialog).toBeVisible();
        await typewrite(page, addDialog.getByLabel('name or email', { exact: true }), 'rae@e2e.test', 45);
        // the role stays on its default, member: b02's narration has them
        // appear as one
        await narrate(page, 'b02 the email they registered with', 3.5);
        await clickWithCursor(page, addDialog.getByRole('button', { name: /add member/i }));
        const raeRow = page.getByRole('row').filter({ hasText: 'rae calloway' });
        await expect(raeRow).toBeVisible();
        await narrate(page, 'b02 members watch, admins do', 6.5);
        await clickWithCursor(page, raeRow.getByRole('button').last());
        await highlight(page, page.getByRole('menuitem', { name: /change access/i }), 6000);
        await narrate(page, 'b02 promotion is per site — change access', 6.0);
        await page.keyboard.press('Escape');
        await page.waitForTimeout(400);

        // [b03] the rest of your panel (~19.6s). Walk the remaining nav as an
        // admin — tokens, schedules, webhooks — ending on alerts as the
        // hand-off. Motion resolves by mid-beat.
        await clickWithCursor(page, page.getByRole('link', { name: 'agent tokens' }));
        await expect(
          page.getByRole('heading', { name: 'agent tokens', exact: true }),
        ).toBeVisible();
        await slowPush(page, { scale: 1.04, originXPct: 50, originYPct: 45, seconds: 3.0 });
        await narrate(page, 'b03 every machine credential on your sites', 3.3);
        await slowPush(page, { scale: 1.0, seconds: 2.4 });
        await clickWithCursor(page, page.getByRole('link', { name: 'schedules' }));
        await expect(
          page.getByRole('heading', { name: 'schedules', exact: true }),
        ).toBeVisible();
        await narrate(page, 'b03 reusable schedule presets', 3.2);
        await clickWithCursor(page, page.getByRole('link', { name: 'webhooks' }));
        await expect(
          page.getByRole('heading', { name: 'webhooks', exact: true }),
        ).toBeVisible();
        await narrate(page, 'b03 feeds events into your other systems', 2.8);
        await highlight(page, page.getByRole('link', { name: 'alerts' }), 1600);
        await narrate(page, 'b03 and alerts — the other half', 1.0);

        // [b04] alerts: let owlette tell you (~11.7s) — enter by clicking the
        // nav item b03 just framed.
        await clickWithCursor(page, page.getByRole('link', { name: 'alerts' }));
        await expect(
          page.getByRole('heading', { name: 'alerts', exact: true }),
        ).toBeVisible();
        await expect(page.getByText('GPU Overheating', { exact: false })).toBeVisible();
        await narrate(page, 'b04 per-site rules list', 3.2);
        await slowPush(page, { scale: 1.04, originXPct: 50, originYPct: 50, seconds: 3.0 });
        await narrate(page, 'b04 per-site rules list - close', 1.8);
        await slowPush(page, { scale: 1.0, seconds: 2.4 });
        await narrate(page, 'b04 per-site rules list - settle', 0.5);

        // [b05] build a rule (~29.8s).
        const createRuleBtn = page.getByRole('button', { name: /create rule/i }).first();
        await clickWithCursor(page, createRuleBtn);
        const ruleDialog = page.getByRole('dialog', { name: /create alert rule/i });
        await expect(ruleDialog).toBeVisible();

        await typewrite(page, ruleDialog.locator('#rule-name'), 'GPU overheat', 45);

        // Selects, in DOM order: metric, operator, severity.
        const metricTrigger = ruleDialog.getByRole('combobox').nth(0);
        await clickWithCursor(page, metricTrigger);
        await page.waitForTimeout(300);
        await clickWithCursor(page, page.getByRole('option', { name: /GPU temperature/i }));
        await narrate(page, 'b05 metric', 5.0);

        const operatorTrigger = ruleDialog.getByRole('combobox').nth(1);
        await clickWithCursor(page, operatorTrigger);
        await page.waitForTimeout(300);
        await clickWithCursor(page, page.getByRole('option', { name: '>', exact: true }));
        await typewrite(page, ruleDialog.locator('#rule-value'), '85', 60);
        await narrate(page, 'b05 operator and value', 5.0);

        // Warning is already the default; opened only to show the options.
        const severityTrigger = ruleDialog.getByRole('combobox').nth(2);
        await clickWithCursor(page, severityTrigger);
        await page.waitForTimeout(300);
        const warningOption = page.getByRole('option', { name: /^warning$/i });
        await highlight(page, warningOption, 1400);
        await clickWithCursor(page, warningOption);
        await narrate(page, 'b05 severity, channels, cooldown', 8.5);

        await clickWithCursor(page, ruleDialog.getByRole('button', { name: /^cancel$/i }));
        await expect(ruleDialog).not.toBeVisible();
        const presetsBtn = page.getByRole('button', { name: /^presets$/i }).first();
        await clickWithCursor(page, presetsBtn);
        const firstPreset = page.getByRole('menuitem', { name: /GPU Overheating/i }).first();
        await expect(firstPreset).toBeVisible();
        await highlight(page, firstPreset, 2000);
        await narrate(page, 'b05 four ready-made templates', 9.5);
        // Dismiss without applying — it would add a duplicate rule.
        await page.keyboard.press('Escape');
        await page.waitForTimeout(300);

        // [b06] your personal alert preferences (~18.2s). The admin layout
        // renders no PageHeader, so `user-menu-trigger` does not exist there —
        // go back to the dashboard before opening the avatar menu.
        await openForCapture(page, '/dashboard');
        await clickWithCursor(page, page.getByTestId('user-menu-trigger'));
        const accountSettingsItem = page.getByRole('menuitem', { name: /account settings/i });
        await expect(accountSettingsItem).toBeVisible();
        await clickWithCursor(page, accountSettingsItem);

        // The settings dialog has a VisuallyHidden DialogTitle, so it has no
        // accessible name — scope by the tab list it is the only holder of
        // rather than matching every dialog on the page.
        const settingsDialog = page.getByRole('dialog').filter({
          has: page.getByRole('button', { name: /^alerts$/i }),
        });
        await expect(settingsDialog).toBeVisible();
        await clickWithCursor(page, settingsDialog.getByRole('button', { name: /^alerts$/i }).first());
        await expect(
          settingsDialog.getByText('machine offline alerts', { exact: false }),
        ).toBeVisible();
        await narrate(page, 'b06 the six category toggles', 8.5);

        const alertEmailSection = settingsDialog.getByText('alert email', { exact: true }).first();
        await centerInView(page, alertEmailSection);
        await highlight(page, alertEmailSection, 1800);
        await narrate(page, 'b06 alert email + up to five CCs', 8.0);

        // [b07] what actually arrives (~25.6s).
        //
        // TODO — THE EMAIL FRAME IS BLOCKED, and deliberately not faked here.
        // The offline email's body is built by `buildOfflineEmail` in
        // app/api/cron/health-check/route.ts:207-232, which is module-private.
        // `lib/emailTemplates.server.ts` exports only the chrome
        // (`wrapEmailLayout`, `emailDataTable`, `EMAIL_COLORS`,
        // `emailTimestamp`), so rebuilding the "machines offline" heading and
        // the three grouped sections here would be a copy of product markup that
        // silently drifts the day the route changes — the exact failure mode
        // this audit pass exists to remove.
        //
        // ONE-LINE FIX, then this beat is a `page.setContent()` away:
        //   1. `export` `buildOfflineEmail` from the health-check route (or lift
        //      it into lib/emailTemplates.server.ts beside
        //      `buildDisplayDigestEmail`, which is already exported and is the
        //      precedent).
        //   2. Here: import it, call it with a two-machine `OfflineSections` and
        //      an `unsubscribeUrl`, `await page.setContent(html)`, dwell ~14s
        //      across the subject line, the "machines offline" heading, the
        //      not-responding / shutting-down / still-offline sections, and the
        //      "manage alerts · unsubscribe" footer.
        //
        // What IS filmable today, and what this pass shoots: where that footer
        // link lands. /settings/alerts is the same set of toggles b06 just
        // walked, which is the point the narration makes about it.
        await openForCapture(page, '/settings/alerts');
        await expect(
          page.getByText('machine offline alerts', { exact: false }),
        ).toBeVisible({ timeout: 20_000 });
        await narrate(page, 'b07 where "manage alerts" lands', 4.2);
        await slowPush(page, { scale: 1.05, originXPct: 50, originYPct: 45, seconds: 4.0 });
        await narrate(page, 'b07 where "manage alerts" lands - close', 2.6);
        await slowPush(page, { scale: 1.0, seconds: 3.0 });
        await narrate(page, 'b07 where "manage alerts" lands - settle', 0.5);

        // The beat's hand-off shot: the display panel's store row, which
        // episode 15 opens on.
        await openForCapture(page, '/dashboard');
        const displayButton = page
          .getByTestId('machine-card')
          .filter({ hasText: 'media-server-stage' })
          .getByTestId('open-display-panel');
        await centerInView(page, displayButton);
        await clickWithCursor(page, displayButton);
        await expect(page.getByTestId('display-layout-panel')).toBeVisible();
        await highlight(page, page.getByTestId('display-store-button'), 2400);
        await narrate(page, 'b07 hand-off to display layouts', 10.5);
      },
    );
  } finally {
    const db = getAdminDb();
    await db.doc(`sites/${ctx.siteId}/members/${TEST_USERS.superadmin.uid}`).delete().catch(() => undefined);
    for (const [machineId] of tokenMachines) {
      await db.collection('agent_refresh_tokens').doc(`e2e-token-${machineId}`).delete().catch(() => undefined);
    }
    await ctx.cleanup();
  }
});
