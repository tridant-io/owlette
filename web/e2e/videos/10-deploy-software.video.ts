/**
 * Scene — episode 10, "deploy software to many machines". All screen capture,
 * no b-roll.
 *
 * Rendered VO (voiceover/out/10-deploy-software/, ffprobe):
 *   b01 16.6s the use case · b02 19.1s new deployment + templates
 *   b03 24.3s installer url + silent flags · b04 28.8s the options that save you grief
 *   b05 14.9s choose your targets · b06 23.0s deploy and watch
 *   b07 28.3s retry the stragglers
 *
 * BEAT ORDER vs SCRIPT ORDER. b05 (pick targets) is performed BEFORE b04's
 * close-processes panel is opened: that checklist is built from the processes of
 * the SELECTED machines (DeploymentDialog.tsx:626-656) and reads "select target
 * machines to see managed processes" until something is ticked. The clips are
 * cut back into script order in the edit; the narrate() labels below say which
 * beat each dwell belongs to.
 *
 * CHECKSUM. The emulator cannot reach a real download host, so the auto-compute
 * row lands amber — "failed to compute checksum — retry or enter manually". The
 * scene takes the manual path and fills #manual-checksum with a 64-hex digest,
 * exactly as `specs/dispatch/create-deployment.spec.ts:59-63` does. Deploy stays
 * blocked until a digest exists (DeploymentDialog.tsx:319-328).
 *
 * NOT FRAMED: the seeded `depl-content-pack-spring` row carries
 * `status: 'scheduled'`, a status nothing in the product ever writes — the
 * badge only renders because `getStatusBadge` falls back to the pending style.
 * It stays in the fixture because `screenshots/deployments.spec.ts:32` asserts
 * it; this scene keeps it out of frame instead. Deleting it is a fixture +
 * spec change, not a capture change.
 *
 * Fixture: `deploy-roost-rolling` (10 machines, 4 deployments across statuses)
 * plus the admin storageState. Two things the fixture does not carry, seeded
 * here: a system preset + a saved template (the dropdown otherwise offers only
 * "none"), and managed processes on the machines b04 needs.
 *
 * Run:  cd web && npm run videos -- --grep "episode 10"
 * Out:  dev/video-tutorials/footage/web/10-deploy-software.mp4
 */

import { Timestamp } from 'firebase-admin/firestore';
import { test, expect } from '@playwright/test';
import { roleState } from '../helpers/roles';
import { getAdminDb, E2E_BASE_URL } from '../helpers/emulator';
import { TEST_USERS } from '../helpers/seed';
import { seedSystemPreset, clearSystemPreset } from '../helpers/coverageSeed';
import { seedScreenshotFixtures, FIXED_NOW_MS } from '../screenshots/fixtures';
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

const FIXED_NOW_SEC = Math.floor(FIXED_NOW_MS / 1000);
const SYSTEM_PRESET_ID = 'video-preset-touchdesigner';

test('episode 10 — deploy software to many machines', async ({ browser }) => {
  const ctx = await seedScreenshotFixtures('deploy-roost-rolling');
  try {
    const db = getAdminDb();
    // Auto-select the seeded site (admin is also on the baseline site-A).
    await db
      .collection('users')
      .doc(TEST_USERS.admin.uid)
      .set({ lastSiteId: ctx.siteId }, { merge: true });

    // b02: one library preset (grouped under its category label) and one saved
    // template, so both halves of the dropdown have something in them.
    // `system_presets` is a TOP-LEVEL collection — `deleteSiteSubtree` never
    // touches it, hence the explicit clear in `finally`.
    await seedSystemPreset(SYSTEM_PRESET_ID, {
      name: 'TouchDesigner 2024.40000',
      software_name: 'TouchDesigner',
      category: 'Creative Tools',
      description: 'derivative touchdesigner, silent install',
      installer_name: 'TouchDesigner-2024.40000.exe',
      installer_url: 'https://downloads.derivative.ca/TouchDesigner.2024.40000.exe',
      silent_flags: '/VERYSILENT /NORESTART',
      verify_path: 'C:\\Program Files\\Derivative\\TouchDesigner\\bin\\TouchDesigner.exe',
      order: 1,
    });
    // Saved templates live under the site, so this one goes with the fixture.
    await db
      .collection('sites')
      .doc(ctx.siteId)
      .collection('installer_templates')
      .doc('tmpl-stage-standard')
      .set({
        name: 'stage machines — standard build',
        installer_name: 'stage-standard.exe',
        installer_url: 'https://e2e-seed.test/installers/stage-standard.exe',
        silent_flags: '/S /norestart',
        verify_path: 'C:\\Owlette\\bin\\stage-standard.exe',
        parallel_install: false,
        sha256_checksum: 'ab'.repeat(32),
        createdAt: Timestamp.fromMillis(FIXED_NOW_MS - 60 * 60 * 24 * 9 * 1000),
      });

    // b04: the close-processes checklist reads `machine.processes`, which
    // `seedMachine` never writes. Two machines is enough for the panel to list
    // more than one name.
    for (const [machineId, proc] of [
      ['media-server-stage', { id: 'proc-td-stage', name: 'TouchDesigner', pid: 4218 }],
      ['td-control-room', { id: 'proc-td-control', name: 'TouchDesigner', pid: 3390 }],
      ['mainstage-led', { id: 'proc-resolume', name: 'Resolume Avenue', pid: 9024 }],
    ] as const) {
      await db
        .collection('sites')
        .doc(ctx.siteId)
        .collection('machines')
        .doc(machineId)
        .set(
          {
            metrics: {
              processes: {
                [proc.id]: {
                  name: proc.name,
                  status: 'RUNNING',
                  pid: proc.pid,
                  autolaunch: true,
                  launch_mode: 'always',
                  exe_path:
                    proc.name === 'TouchDesigner'
                      ? 'C:\\Program Files\\Derivative\\TouchDesigner\\bin\\TouchDesigner.exe'
                      : 'C:\\Program Files\\Resolume Avenue\\Avenue.exe',
                  file_path: '',
                  cwd: 'C:\\Owlette\\bin',
                  priority: 'Normal',
                  visibility: 'Show',
                  time_delay: '0',
                  time_to_init: '5',
                  relaunch_attempts: '3',
                  responsive: true,
                  last_updated: FIXED_NOW_SEC - 20,
                  index: 0,
                },
              },
            },
          },
          { merge: true },
        );
    }

    await recordScene(
      browser,
      '10-deploy-software',
      { baseURL: E2E_BASE_URL, storageState: roleState('admin').storageState },
      async (page) => {
        await openForCapture(page, '/deployments');

        // [b01] the use case (~16.6s). Pan the header once so `update owlette`
        // sits beside `new deployment`, then open one row's ⋮ so `uninstall
        // software` is on camera for a beat. Both are silent nods — episode 17
        // walks them properly and nothing about either is spoken here.
        const inFlightRow = page.getByText('stage show v4', { exact: false }).first();
        await expect(inFlightRow).toBeVisible();
        await narrate(page, 'b01 deployments list — settle', 8);
        const completedRowActions = page.getByRole('button', {
          name: /deployment actions for stage show v3/i,
        });
        await centerInView(page, completedRowActions);
        await clickWithCursor(page, completedRowActions);
        await highlight(page, page.getByRole('menuitem', { name: /uninstall software/i }), 2200);
        await narrate(page, 'b01 uninstall software, unspoken', 9);
        await page.keyboard.press('Escape');
        await page.waitForTimeout(400);

        // [b02] new deployment and templates (~19.1s).
        const newDeploymentBtn = page.getByRole('button', { name: /new deployment/i }).first();
        await clickWithCursor(page, newDeploymentBtn);
        const dialog = page.getByRole('dialog', { name: /deploy software/i });
        await expect(dialog).toBeVisible();

        const templateTrigger = dialog.getByRole('combobox').first();
        await clickWithCursor(page, templateTrigger);
        // Library presets group under their category label; user templates sit
        // under "Saved".
        await expect(page.getByRole('option', { name: /TouchDesigner 2024\.40000/ })).toBeVisible();
        await expect(
          page.getByRole('option', { name: /stage machines — standard build/ }),
        ).toBeVisible();
        await narrate(page, 'b02 presets + saved templates', 4.2);
        await slowPush(page, { scale: 1.04, originXPct: 50, originYPct: 50, seconds: 4.0 });
        await narrate(page, 'b02 presets + saved templates - close', 1.8);
        await slowPush(page, { scale: 1.0, seconds: 3.0 });
        await narrate(page, 'b02 presets + saved templates - settle', 1.0);
        // Close it — the beat ends on "let's build one from scratch".
        await page.keyboard.press('Escape');
        await page.waitForTimeout(300);
        await narrate(page, 'b02 back to a blank form', 6);

        // [b05, performed early] choose your targets (~14.9s). See the header
        // note: b04's checklist is empty until machines are selected.
        const onlineOnlyBtn = dialog.getByRole('button', { name: /^online only/i });
        await centerInView(page, onlineOnlyBtn);
        await clickWithCursor(page, onlineOnlyBtn);
        await narrate(page, 'b05 online only', 8);
        // The toggle-all label flips between "select all" and "deselect all".
        // All 10 seeded machines are online, so after "online only" it reads
        // "deselect all"; match either so a mixed-fleet seed cannot break this.
        const toggleAllBtn = dialog.getByRole('button', { name: /^(?:de)?select all$/i });
        await highlight(page, toggleAllBtn, 2200);
        await narrate(page, 'b05 select all / individual checkboxes', 8);

        // [b03] installer url and silent flags (~24.3s).
        const installerUrlInput = dialog.locator('#installer-url');
        await centerInView(page, installerUrlInput);
        await typewrite(
          page,
          installerUrlInput,
          'https://downloads.derivative.ca/TouchDesigner.2024.40000.exe',
          40,
        );
        await narrate(page, 'b03 url typed — filename derives', 5);
        // The checksum row resolves amber in the emulator; take the manual path.
        await clickWithCursor(page, dialog.getByRole('button', { name: /^enter manually$/i }));
        await typewrite(page, dialog.locator('#manual-checksum'), 'cd'.repeat(32), 12);
        await narrate(page, 'b03 checksum entered by hand', 6);
        const silentFlagsInput = dialog.locator('#silent-flags');
        await typewrite(page, silentFlagsInput, '/VERYSILENT /NORESTART', 45);
        await narrate(page, 'b03 silent flags', 9);

        // [b04] the options that save you grief (~28.8s).
        const parallelCheckbox = dialog.locator('#parallel-install');
        await centerInView(page, parallelCheckbox);
        await highlight(page, parallelCheckbox, 1800);
        await narrate(page, 'b04 parallel install', 9);

        const closeProcessesToggle = dialog.getByRole('button', {
          name: /close running processes before install/i,
        });
        await clickWithCursor(page, closeProcessesToggle);
        await page.waitForTimeout(500);
        // With targets already selected the panel lists the real managed
        // processes rather than "select target machines to see managed
        // processes". `exact: true` matches only the checklist's <Label>: the
        // panel's helper copy ("comma-separated exe names for non-managed
        // process…") contains the phrase too, and a substring match resolves to
        // both — a strict-mode violation.
        await expect(dialog.getByText('managed processes', { exact: true })).toBeVisible();
        await narrate(page, 'b04 managed-process checklist', 10);
        const additionalProcesses = dialog.locator('#additional-processes');
        await typewrite(page, additionalProcesses, 'obs64.exe', 55);
        await narrate(page, 'b04 amber warning + restart-after', 9);

        // Close without submitting: a real deploy would sit at pending forever
        // with no agent, and b06 needs a board with movement on it.
        await clickWithCursor(page, dialog.getByRole('button', { name: /^cancel$/i }).first());
        await expect(dialog).not.toBeVisible();

        // [b06] deploy and watch (~23.0s) — expand the seeded in-flight record:
        // 3 completed, 1 installing at 64%, 6 pending, each queued target
        // carrying a cancel control.
        await centerInView(page, inFlightRow);
        await clickWithCursor(page, inFlightRow);
        await expect(
          page.getByText('media-server-stage', { exact: false }).first(),
        ).toBeVisible();
        await narrate(page, 'b06 progress board', 5.1);
        await slowPush(page, { scale: 1.05, originXPct: 50, originYPct: 45, seconds: 4.0 });
        await narrate(page, 'b06 progress board - close', 3.9);
        await slowPush(page, { scale: 1.0, seconds: 3.0 });
        await narrate(page, 'b06 progress board - settle', 1.0);
        await highlight(
          page,
          page.getByRole('button', { name: /cancel deployment to nyc-signage-01/i }),
          2400,
        );
        await narrate(page, 'b06 per-target cancel', 7);
        await clickWithCursor(page, inFlightRow);
        await page.waitForTimeout(300);

        // [b07] retry the stragglers (~28.3s). The failed record has one target
        // down on "msi exit code 1603".
        const failedRow = page
          .getByText('touchdesigner 2024.40000 driver bump', { exact: false })
          .first();
        await centerInView(page, failedRow);
        await highlight(page, failedRow, 1800);
        await narrate(page, 'b07 a failed rollout is normal', 8);

        const failedRowActions = page.getByRole('button', {
          name: /deployment actions for touchdesigner 2024\.40000 driver bump/i,
        });
        await clickWithCursor(page, failedRowActions);
        const retryItem = page.getByRole('menuitem', { name: /retry failed/i });
        await expect(retryItem).toBeVisible();
        await highlight(page, retryItem, 2200);
        await narrate(page, 'b07 retry failed', 11);
        await page.keyboard.press('Escape');
        await page.waitForTimeout(400);
        // Then the single-machine arrow inside the expanded row.
        await clickWithCursor(page, failedRow);
        const perTargetRetry = page.getByRole('button', {
          name: /retry deployment to museum-kiosk-2/i,
        });
        await centerInView(page, perTargetRetry);
        await highlight(page, perTargetRetry, 2400);
        await narrate(page, 'b07 per-machine retry arrow', 9);
      },
    );
  } finally {
    await clearSystemPreset(SYSTEM_PRESET_ID);
    await ctx.cleanup();
  }
});
