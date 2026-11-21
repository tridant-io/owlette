/**
 * Scene — episode 9, "the owlette app on the machine".
 * Script: dev/video-tutorials/scripts/09-the-owlette-app.md (FINAL).
 *
 * This is the CDP half of the episode. The tray icon and its right-click menu
 * are a native Win32 notification-area surface that no webview driver reaches,
 * and an OS file drop arrives as a Tauri host event (`useFileDrop` listens to
 * `onDragDropEvent`, not `ondrop`) that CDP cannot synthesize. Those beats are
 * the pywinauto/PowerShell segment — see NATIVE SEGMENT below and the handoff
 * table in README.md.
 *
 * VO durations, ffprobe of dev/video-tutorials/voiceover/out/09-the-owlette-app/
 * (rounded up ~0.5s per beat), and how each is split across the two surfaces:
 *
 *   beat  mp3      budget   this take   native / other
 *   b01   24.27s   24.8s    —           24.8  tray icon + tooltip + icon states
 *   b02   25.00s   25.5s    —           25.5  tray right-click menu
 *   b03   25.00s   25.5s    16.0        5.0 open-from-tray + 4.5 close-to-tray
 *   b04   28.03s   28.5s    10.0        18.5 drag a .toe from Explorer + confirm card
 *   b05   31.56s   32.1s    32.1        —
 *   b06   20.51s   21.0s    21.0        —
 *   b07   26.04s   26.5s    26.5        —
 *   b08   31.48s   32.0s    20.0        5.0 unpaired cut (2nd take, below)
 *                                       + 3.5 service-stopped cut (native)
 *                                       + 3.5 dashboard split-screen (web pipeline)
 *
 * NATIVE SEGMENT (not filmable here — hand to capture-native):
 *   b01, b02 entirely — the tray icon, its tooltip, the three icon states, and
 *     the right-click menu. `../desktop-screenshots/capture-tray-menu.ps1`
 *     already photographs that menu and carries the two rules worth keeping:
 *     one UI Automation lookup ~1.2s after the click (never a tight poll), and
 *     PrintWindow with PW_RENDERFULLCONTENT (never CopyFromScreen).
 *   b03's bookends — "click open owlette" and "close it and it tucks back into
 *     the tray". Closing hides the window, which ends this harness's subject.
 *   b04's drag-and-drop half — the drop overlay and the "add process" confirm
 *     card. Live hands or a pywinauto drag from Explorer.
 *   b08's service-stopped footer — `deriveFooterState` reads the real Windows
 *     SCM through the host, and the service state is NOT redirectable by
 *     PROGRAMDATA. Filming "start service" means actually stopping the service
 *     on the capture machine, which is a deliberate operator act, not a fixture.
 *
 * Run:  cd web && npm run videos:desktop -- --grep "episode 9"
 * Out:  dev/video-tutorials/footage/desktop/09-the-owlette-app.mp4
 *       dev/video-tutorials/footage/desktop/09-the-owlette-app-unpaired.mp4
 */

import { expect, test, type Locator, type Page } from '@playwright/test';
import { SCRATCH_ROOT } from '../desktop-screenshots/harness';
import {
  DEMO_PROCESS_COUNT,
  NEW_PROCESS_NAME,
  PROJECTOR,
  SERVER,
  SHOW,
  SIGNAGE,
  seedVideoScenario,
} from './fixtures';
import { endTake, recordDesktopScene, startTake, type DesktopTake } from './harness';
import {
  clearFocus,
  clickWithCursor,
  dragRowTo,
  highlight,
  narrate,
  parkPointer,
  rightClickWithCursor,
  settle,
} from './video-helpers';

test.describe.configure({ mode: 'serial' });

let take: DesktopTake | null = null;

test.afterEach(async () => {
  await endTake(take);
  take = null;
});

/** A sidebar row by the name it shows. */
function row(page: Page, name: string): Locator {
  return page.getByTestId('process-row').filter({ hasText: name });
}

/** Select a process and wait for the detail pane to be the one asked for. */
async function selectProcess(page: Page, name: string): Promise<void> {
  await clickWithCursor(page, row(page, name));
  await expect(page.locator('#name')).toHaveValue(name);
}

/**
 * Open a row's context menu, choose an action, and hold on the confirm dialog
 * long enough to read it. Always cancels: confirming would ask the host to stop
 * a pid the fixture only claims exists.
 */
async function readConfirm(page: Page, name: string, action: string, seconds: number): Promise<void> {
  await rightClickWithCursor(page, row(page, name));
  const item = page.getByRole('menuitem', { name: action });
  await expect(item).toBeVisible();
  await clickWithCursor(page, item);

  const dialog = page.getByRole('dialog', { name: action });
  await expect(dialog).toBeVisible();
  await highlight(page, dialog, 2200);
  await narrate(page, `b07 ${action} on ${name}`, seconds);

  await clickWithCursor(page, dialog.getByRole('button', { name: 'cancel' }));
  await expect(dialog).toBeHidden();
}

test('episode 9 — the owlette app', async () => {
  seedVideoScenario(SCRATCH_ROOT, 'paired');
  take = await startTake();

  const app = take.page;
  await expect(app.getByTestId('process-row')).toHaveCount(DEMO_PROCESS_COUNT);
  await expect(app.getByTestId('footer-status')).toContainText('connected');
  await parkPointer(app);
  await settle(app);

  await recordDesktopScene(take, '09-the-owlette-app', async (page) => {
    // [b03] the window — 16.0s of 25.5s. The tray click that opens it and the
    // close that tucks it away are the native bookends.
    await highlight(page, page.locator('header[data-titlebar]'), 2200);
    await narrate(page, 'b03 titlebar + wordmark + menu', 4);

    await highlight(page, page.getByTestId('process-list'), 2200);
    await narrate(page, 'b03 processes down the left', 4);

    await selectProcess(page, SHOW);
    await expect(page.getByTestId('detail-status')).toHaveText('running');
    await highlight(page, page.getByTestId('detail-header'), 2200);
    await narrate(page, 'b03 the selected process on the right', 4);

    await highlight(page, page.getByTestId('footer-status'), 2200);
    await narrate(page, 'b03 the footer', 4);

    // [b04] adding a process — 10.0s of 28.5s. Only the `+` half: an OS drop is
    // a Tauri host event, unreachable from CDP (see NATIVE SEGMENT).
    await clickWithCursor(page, page.getByRole('button', { name: 'add process' }));
    await expect(page.getByTestId('process-row')).toHaveCount(DEMO_PROCESS_COUNT + 1);
    await expect(page.locator('#name')).toHaveValue(NEW_PROCESS_NAME);
    await parkPointer(page);
    await narrate(page, 'b04 the plus button makes a blank one', 10);

    // [b05] the fields — 32.1s, all here. `signage player` is the off entry, so
    // the recovery group films dimmed, which is the point of that sentence.
    await selectProcess(page, SIGNAGE);
    await highlight(page, page.locator('#exe_path'), 1800);
    await narrate(page, 'b05 what to run — exe', 5);

    await highlight(page, page.locator('#file_path'), 1800);
    await narrate(page, 'b05 what to run — path / args', 4);

    await highlight(page, page.locator('#cwd'), 1800);
    await narrate(page, 'b05 what to run — cwd', 4);

    await highlight(page, page.getByTestId('launch-mode'), 1800);
    await narrate(page, 'b05 when to run', 5);

    // The redesign merged the old "recovery" and "advanced" groups into a single
    // "how to run" disclosure, COLLAPSED by default (DETAIL_SECTION_DEFAULTS).
    // Its fields are not in the DOM until it is opened, which is what broke the
    // previous take: it asserted on `recovery-fields`, an id the new UI no
    // longer has.
    await clickWithCursor(page, page.getByTestId('how-to-run-toggle'));
    await expect(page.getByTestId('how-to-run-fields')).toBeVisible();
    // Dimmed, not disabled: the fields stay editable, because configuring them
    // before switching the mode on is the normal flow.
    await expect(page.getByTestId('how-to-run-fields')).toHaveAttribute('data-dimmed', 'true');
    await highlight(page, page.locator('#relaunch_attempts'), 1800);
    await highlight(page, page.getByTestId('priority'), 1400);
    await highlight(page, page.getByTestId('visibility'), 1400);
    await narrate(page, 'b05 how to run - dimmed until a launch mode is set', 6);

    // No save button: leaving the field is the write. Tab, not Escape — Escape
    // would abandon the edit rather than commit it.
    await clickWithCursor(page, page.locator('#cwd'));
    await page.locator('#cwd').fill('');
    await page.locator('#cwd').pressSequentially('C:\\shows\\atrium', { delay: 55 });
    await page.keyboard.press('Tab');
    await clearFocus(page);
    await parkPointer(page);
    await narrate(page, 'b05 every field saves as you leave it', 4.1);

    // [b06] schedules, right here — 21.0s, all here. Opened from the OFF entry
    // on purpose: the pencil is offered in every launch mode.
    await clickWithCursor(page, page.getByTestId('edit-schedule'));
    const editor = page.getByTestId('schedule-editor');
    await expect(editor).toBeVisible();
    await clearFocus(page);
    await narrate(page, 'b06 the editor opens from off — not gated', 4);

    await highlight(page, page.getByTestId('week-summary'), 2200);
    await narrate(page, 'b06 the same week bar as the dashboard', 4);

    await clickWithCursor(page, editor.getByRole('button', { name: 'add schedule block' }));
    await narrate(page, 'b06 add a block', 4);

    await clickWithCursor(page, editor.getByRole('button', { name: 'save schedule' }));
    await expect(editor).toBeHidden();
    await narrate(page, 'b06 save', 3);

    await clickWithCursor(page, page.getByTestId('launch-mode-scheduled'));
    await expect(page.getByTestId('launch-mode-scheduled')).toHaveAttribute(
      'aria-checked',
      'true',
    );
    await narrate(page, 'b06 switch the mode on when you are ready', 3);

    await highlight(page, page.getByTestId('schedule-note'), 1800);
    await narrate(page, 'b06 the summary beside the control', 3);

    // [b07] reordering, and the row menu — 26.5s, all here.
    await parkPointer(page);
    await dragRowTo(page, row(page, SERVER), row(page, SHOW));
    await expect(page.getByTestId('process-row').first()).toContainText(SERVER);
    await narrate(page, 'b07 the order of the list is the launch order', 6);

    // The two confirms carry most of this beat (8.0 + 8.5 of 26.5) because the
    // sentence under them is about their wording — "whether the service brings
    // the process straight back, or whether it stays down". `highlight`'s
    // outline is a page-side timer that does not block, so the dwell here is the
    // whole of the picture: hold on each dialog long enough to read it.
    // Live entry: the confirm explains that the service brings it straight back.
    await readConfirm(page, SHOW, 'restart process', 8);

    // Stopped entry: restart and kill are DISABLED now. Run controls follow
    // liveness, not the launch mode (ProcessList.tsx: disabled={!anchorLive}),
    // so there is no second confirm to open - the previous take failed trying.
    // Showing them greyed out demonstrates the rule better than the old wording
    // contrast did.
    await rightClickWithCursor(page, row(page, PROJECTOR));
    const restartOff = page.getByRole('menuitem', { name: 'restart process' });
    await expect(restartOff).toBeVisible();
    await expect(restartOff).toHaveAttribute('aria-disabled', 'true');
    await highlight(page, restartOff, 2200);
    await narrate(page, 'b07 restart and kill only light up while it is running', 8.5);
    await page.keyboard.press('Escape');
    await parkPointer(page);
    await narrate(page, 'b07 the wording tells you what happens next', 4);

    // [b08] the footer, the menu, and the cloud — 20.0s of 32.0s. The
    // service-stopped cut is native; the unpaired cut is the take below; the
    // dashboard split-screen is the web pipeline's.
    await highlight(page, page.getByTestId('footer-status'), 2400);
    await narrate(page, 'b08 one line: connected, and to which site', 6);

    await clickWithCursor(page, page.getByTestId('app-menu-trigger'));
    await expect(page.getByTestId('menu-leave-site')).toBeVisible();
    await narrate(page, 'b08 the hamburger menu', 4);

    // Glide the items, never click them: config and logs open Explorer, docs
    // opens a browser — all three would take the shot off the app.
    for (const item of ['menu-config', 'menu-logs', 'menu-docs', 'menu-report-issue']) {
      await highlight(page, page.getByTestId(item), 900);
      await page.waitForTimeout(300);
    }
    await narrate(page, 'b08 join or leave, config, logs, docs, submit issue', 7);

    await page.keyboard.press('Escape');
    await expect(page.getByTestId('menu-leave-site')).toBeHidden();
    await parkPointer(page);
    await narrate(page, 'b08 handoff to episode 10', 3);
  });
});

/**
 * b08's second cut: the same window on a machine that belongs to no site, so the
 * footer reads "disabled" and offers `join site`. A separate take because it is
 * a different machine state, and a cut in the edit — not a transition on camera.
 */
test('episode 9 — the owlette app, unpaired footer cut', async () => {
  seedVideoScenario(SCRATCH_ROOT, 'unpaired');
  take = await startTake();

  const app = take.page;
  await expect(app.getByTestId('footer-status')).toContainText('disabled');
  await parkPointer(app);
  await settle(app);

  await recordDesktopScene(take, '09-the-owlette-app-unpaired', async (page) => {
    // [b08] 5.0s of 32.0s.
    await highlight(page, page.getByTestId('footer-status'), 1800);
    await narrate(page, 'b08 unpaired footer', 2.5);

    await highlight(page, page.getByRole('button', { name: 'join site' }), 1800);
    await narrate(page, 'b08 the button it needs', 2.5);
  });
});
