/**
 * Scene — episode 12, "hoot: manage machines by chat". All SCREEN capture.
 *
 * Rendered VO (voiceover/out/12-cortex/, ffprobe):
 *   b01 19.4s what hoot is · b02 32.5s one key, one place
 *   b03 18.7s point it at something · b04 21.5s the diagnosis
 *   b05 20.7s asking it to act · b06 25.4s the guardrails
 *   b07 17.0s the tab isn't the boss · b08 23.6s hoot on its own
 * EVERY beat was re-recorded for the v2 series — the 2026-05-30 take predates
 * the rename, the approval gate and async turns. Do not reuse any of it.
 *
 * WIRE NAMES: this file, its scene id and the fixture key keep `cortex` on
 * purpose (web/lib/hoot/WIRE_NAMES.md). Every word on screen says hoot.
 *
 * NEVER TYPE A PROMPT. A real answer needs a live LLM, so every beat films
 * pre-seeded conversations by navigating and scrolling.
 *
 * Fixture `diagnose-cortex-chat`, which now seeds four conversations:
 *   focus     — the 03:14 incident transcript (b01, b04)
 *   approval  — a tier-3 `run_powershell` call awaiting approve/deny (b05)
 *   running   — a tool part still executing, so it survives a reload (b07)
 *   autonomous— an `auto`-badged investigation in the sidebar (b08)
 * The approval and running parts live in their OWN conversations rather than as
 * extra turns on the focus thread: `screenshots/cortex-chat.spec.ts` and
 * `diagnose.spec.ts` capture that thread for docs, and an amber approval banner
 * or a permanent spinner in it would rewrite both stills. That keeps the
 * TRANSCRIPT identical in both; cortex-chat.spec.ts (scoped to `main`) is
 * untouched, while diagnose.spec.ts shoots the viewport with the conversation
 * sidebar in frame and so gains these three rows — accepted, and it re-bakes on
 * the next `npm run screenshots`.
 *
 * Run:  cd web && npm run videos -- --grep "episode 12"
 * Out:  dev/video-tutorials/footage/web/12-cortex.mp4
 */

import { test, expect } from '@playwright/test';
import { roleState } from '../helpers/roles';
import { getAdminDb, E2E_BASE_URL } from '../helpers/emulator';
import { TEST_USERS } from '../helpers/seed';
import {
  seedScreenshotFixtures,
  hootFocusConversationId,
  hootApprovalConversationId,
  hootRunningConversationId,
} from '../screenshots/fixtures';
import {
  recordScene,
  openForCapture,
  narrate,
  slowPush,
  highlight,
  clickWithCursor,
  centerInView,
} from './video-helpers';

test('episode 12 — hoot: manage machines by chat', async ({ browser }) => {
  // ~200s of scripted dwell; the 300s default leaves too little slack if
  // seeding slows. Same guard as the other long scenes (13/15/17).
  test.setTimeout(8 * 60_000);
  const ctx = await seedScreenshotFixtures('diagnose-cortex-chat');
  try {
    // Auto-select the seeded site on load.
    await getAdminDb()
      .collection('users')
      .doc(TEST_USERS.admin.uid)
      .set({ lastSiteId: ctx.siteId }, { merge: true });

    await recordScene(
      browser,
      '12-cortex',
      { baseURL: E2E_BASE_URL, storageState: roleState('admin').storageState },
      async (page) => {
        // [b01] what hoot is (~19.4s) — settle on the seeded incident chat with
        // the `hoot` nav item highlighted in the header.
        await openForCapture(page, `/hoot/${hootFocusConversationId(ctx.siteId)}`);
        await expect(
          page.getByText('03:14 incident', { exact: false }).first(),
        ).toBeVisible();
        await expect(page.getByText('access violation', { exact: false })).toBeVisible();
        await narrate(page, 'b01 hoot chat — settle', 6.0);
        await slowPush(page, { scale: 1.04, originXPct: 50, originYPct: 48, seconds: 4.0 });
        await narrate(page, 'b01 hoot chat — settle - close', 6.0);
        await slowPush(page, { scale: 1.0, seconds: 3.0 });
        await narrate(page, 'b01 hoot chat — settle - settle', 1.0);

        // [b02] one key, one place (~32.5s) — account settings → the hoot
        // section: provider, model, and the api key field with its "encrypted
        // with AES-256 and never leaves the server" line.
        const userMenuTrigger = page.getByTestId('user-menu-trigger');
        await clickWithCursor(page, userMenuTrigger);
        const accountSettingsItem = page.getByRole('menuitem', { name: /account settings/i });
        await expect(accountSettingsItem).toBeVisible();
        await clickWithCursor(page, accountSettingsItem);

        const settingsDialog = page.getByRole('dialog'); // VisuallyHidden DialogTitle
        await expect(settingsDialog).toBeVisible();
        const hootTab = settingsDialog.getByRole('button', { name: /^hoot$/i }).first();
        await clickWithCursor(page, hootTab);
        await expect(settingsDialog.locator('#llmProvider')).toBeVisible();
        await narrate(page, 'b02 provider + model', 4.2);
        await slowPush(page, { scale: 1.05, originXPct: 50, originYPct: 42, seconds: 4.0 });
        await narrate(page, 'b02 provider + model - close', 1.8);
        await slowPush(page, { scale: 1.0, seconds: 3.0 });
        await narrate(page, 'b02 provider + model - settle', 1.0);
        await centerInView(page, settingsDialog.locator('#llmApiKey'));
        await highlight(page, settingsDialog.locator('#llmApiKey'), 2600);
        await narrate(page, 'b02 the key, encrypted, server-side only', 5.7);
        await slowPush(page, { scale: 1.04, originXPct: 50, originYPct: 50, seconds: 4.0 });
        await narrate(page, 'b02 the key, encrypted, server-side only - close', 5.3);
        await slowPush(page, { scale: 1.0, seconds: 3.0 });
        await narrate(page, 'b02 the key, encrypted, server-side only - settle', 1.0);

        await page.keyboard.press('Escape');
        await expect(settingsDialog).not.toBeVisible();
        await page.waitForTimeout(400);

        // [b03] point it at something (~18.7s). Opening the picker is enough —
        // the master row is what the narration is about, and leaving the chat's
        // target alone keeps b04's thread intact.
        const machineSelector = page.getByLabel('hoot target');
        await centerInView(page, machineSelector);
        await highlight(page, machineSelector, 1800);
        await clickWithCursor(page, machineSelector);
        await page.waitForTimeout(400);
        const allMachinesOption = page
          .getByRole('menuitemcheckbox', { name: /^all machines/i })
          .first();
        await expect(allMachinesOption).toBeVisible();
        await highlight(page, allMachinesOption, 1600);
        await narrate(page, 'b03 all machines vs one machine', 4.2);
        await slowPush(page, { scale: 1.05, originXPct: 50, originYPct: 45, seconds: 4.0 });
        await narrate(page, 'b03 all machines vs one machine - close', 1.8);
        await slowPush(page, { scale: 1.0, seconds: 3.0 });
        await narrate(page, 'b03 all machines vs one machine - settle', 1.0);
        await page.keyboard.press('Escape');
        await page.waitForTimeout(300);
        await narrate(page, 'b03 close selector', 5);

        // [b04] the diagnosis (~21.5s) — the question, the answer, and the
        // inline checkLogs tool card, expanded.
        const userQuestion = page.getByText('what crashed at 3am?', { exact: false });
        await centerInView(page, userQuestion);
        await highlight(page, userQuestion, 1800);
        await narrate(page, 'b04 the question', 5);
        const assistantAnswer = page.getByText('access violation', { exact: false });
        await centerInView(page, assistantAnswer);
        await highlight(page, assistantAnswer, 2200);
        await narrate(page, 'b04 exit code, auto-restart, likely cause', 9);
        // Scoped to the ToolCallCard root (`my-2 rounded-lg border
        // overflow-hidden`, ToolCallCard.tsx:72-76) rather than to any text that
        // happens to contain "checkLogs" — the bare text match used to resolve
        // to the inner label span and the highlight framed one word.
        const toolCard = page
          .locator('div.rounded-lg.border.overflow-hidden')
          .filter({ hasText: 'checkLogs' })
          .first();
        await centerInView(page, toolCard);
        await highlight(page, toolCard, 2000);
        await clickWithCursor(page, toolCard.getByRole('button').first());
        await narrate(page, 'b04 open the tool card', 8);

        // [b05] asking it to act (~20.7s) — the tier-3 approve/deny card.
        // Routine tools (restart a configured process, grab a screenshot) just
        // run; a shell command stops and asks.
        await openForCapture(page, `/hoot/${hootApprovalConversationId(ctx.siteId)}`);
        const approvalCard = page
          .locator('div.rounded-lg.border.overflow-hidden')
          .filter({ hasText: 'hoot wants to run the privileged' })
          .first();
        await expect(approvalCard).toBeVisible();
        await centerInView(page, approvalCard);
        await highlight(page, approvalCard, 2800);
        await narrate(page, 'b05 hoot wants to run run_powershell', 10);
        await highlight(page, approvalCard.getByRole('button', { name: /^approve$/i }), 1800);
        await highlight(page, approvalCard.getByRole('button', { name: /^deny$/i }), 1800);
        // Neither is clicked: approving dispatches a real command to a machine
        // that has no agent, and the card would fall into a spinner that never
        // resolves.
        await narrate(page, 'b05 approve, or deny', 11);

        // [b06] the guardrails (~25.4s) — the per-machine hoot switch.
        // The site-wide approval gate this beat used to highlight left the hoot
        // header on 2026-11-11: it is a switch on the admin panel's hoot page
        // now, so the narration plays over the chat until the beat is re-shot.
        await narrate(page, 'b06 role ceiling + the site-wide approval gate', 12);

        // The per-machine switch only renders for a SINGLE targeted machine, so
        // the target has to move off "all machines". A row's NAME selects only
        // that machine (its checkbox column is what toggles within the set), and
        // the cursor lands on the name — so one click gets there from any state.
        // The conversation itself stays put now — re-aiming continues the open
        // chat instead of starting another. (The b03/b06 narration still says
        // switching opens a fresh conversation; Task 7.1 flags that line for the
        // next render.)
        const machineSelectorAgain = page.getByLabel('hoot target');
        await clickWithCursor(page, machineSelectorAgain);
        await page.waitForTimeout(400);
        await clickWithCursor(
          page,
          page.getByRole('menuitemcheckbox', { name: /^media-server-stage/i }).first(),
        );
        await page.keyboard.press('Escape');
        await page.waitForTimeout(600);
        const hootToggle = page.getByRole('button', { name: /hoot (active|inactive)/i });
        await expect(hootToggle).toBeVisible();
        await centerInView(page, hootToggle);
        await highlight(page, hootToggle, 2400);
        await narrate(page, 'b06 per-machine hoot switch', 13);

        // [b07] the tab isn't the boss (~17.0s) — a turn runs on the server.
        //
        // WHAT IS FILMABLE: the executing tool card, and that it is still there
        // after a full reload. WHAT IS NOT: the per-tool "cancel" button and the
        // square "stop response" button. Cancel needs a `toolCommands` entry
        // keyed by toolCallId (ChatWindow.tsx:361-366) and stop needs the chat
        // hook's live `isLoading` — both are written by the running turn, which
        // no fixture can stand in for. Shoot those two controls on a dev site
        // with a real key, or leave the beat on the reload.
        await openForCapture(page, `/hoot/${hootRunningConversationId(ctx.siteId)}`);
        const runningCard = page
          .locator('div.rounded-lg.border.overflow-hidden')
          .filter({ hasText: 'restart_process' })
          .first();
        await expect(runningCard).toBeVisible();
        await expect(runningCard.getByText('executing...')).toBeVisible();
        await centerInView(page, runningCard);
        await highlight(page, runningCard, 2400);
        await narrate(page, 'b07 a tool mid-execution', 7);
        await page.reload({ waitUntil: 'domcontentloaded' });
        await page.waitForTimeout(1500);
        const runningCardAfter = page
          .locator('div.rounded-lg.border.overflow-hidden')
          .filter({ hasText: 'restart_process' })
          .first();
        await expect(runningCardAfter.getByText('executing...')).toBeVisible();
        await highlight(page, runningCardAfter, 2400);
        await narrate(page, 'b07 reload — the turn is still there', 9);

        // [b08] hoot on its own (~23.6s). There is NO dashboard control that
        // turns autonomous mode on — `autonomousEnabled` is set out of band on
        // sites/{siteId}/settings/cortex — so this beat films the RESULT (an
        // `auto`-badged conversation in the sidebar) and the escalation-alerts
        // switch, never a "switch it on" click.
        const autoBadge = page.getByText('auto', { exact: true }).first();
        await centerInView(page, autoBadge);
        await highlight(page, autoBadge, 2600);
        await narrate(page, 'b08 an autonomous investigation in the sidebar', 11);

        await clickWithCursor(page, page.getByTestId('user-menu-trigger'));
        await clickWithCursor(page, page.getByRole('menuitem', { name: /account settings/i }));
        const settingsAgain = page.getByRole('dialog');
        await expect(settingsAgain).toBeVisible();
        await clickWithCursor(page, settingsAgain.getByRole('button', { name: /^alerts$/i }).first());
        const escalationToggle = settingsAgain.getByText('hoot escalation alerts', { exact: false });
        await centerInView(page, escalationToggle);
        await highlight(page, escalationToggle, 2600);
        await narrate(page, 'b08 escalation email instead of silence', 13);
      },
    );
  } finally {
    await ctx.cleanup();
  }
});
