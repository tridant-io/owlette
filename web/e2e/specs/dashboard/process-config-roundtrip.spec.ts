/**
 * Dashboard → Firestore round-trip for the process config the agent consumes.
 *
 * The 3.0.0 regression that motivated this file (desktop-app config edits never
 * reaching Firestore) shipped because nothing asserted the cross-surface
 * contract. The desktop half needs a full-machine harness; the web half is this
 * file: every editable parameter in the dashboard's process dialog, the card's
 * launch-mode quick toggle, plus add and delete, each read back from
 * `config/{siteId}/machines/{machineId}` — the exact document the agent polls.
 *
 * Assertions are on wire field names and wire types: snake_case keys,
 * `time_delay` / `time_to_init` / `relaunch_attempts` as STRINGS (the agent
 * coerces with `float()`), `visibility` normalized to `Normal` / `Hidden`,
 * `launch_mode` one of off|always|scheduled with `autolaunch` derived from it.
 *
 * The UI renders process rows from the status doc (`metrics.processes`), which
 * only the agent rewrites — so a saved edit does NOT change the row on screen.
 * Every locator below therefore uses the SEEDED name, never the saved one.
 * See `e2e/helpers/processConfig.ts`.
 *
 * Admin role: process write controls are site-admin gated.
 */

import { test, expect, type Locator, type Page } from '@playwright/test';
import { clippedFocusRings } from '../../helpers/focusRing';
import { roleState } from '../../helpers/roles';
import { TEST_USERS } from '../../helpers/seed';
import {
  configProcessById,
  machineCard,
  pinDashboardContext,
  processEditButton,
  processRow,
  readConfigChangeFlag,
  readConfigProcesses,
  readStatusProcess,
  seedMachineWithProcesses,
  toasts,
  type SeedProcess,
} from '../../helpers/processConfig';

test.use(roleState('admin'));

const SITE_ID = 'site-A';
const MACHINE_ID = 'e2e-process-config';

const ALPHA_ID = 'proc-alpha';
const ALPHA_NAME = 'alpha.exe';
const BETA_ID = 'proc-beta';
const BETA_NAME = 'beta.exe';

/** `handleSetLaunchMode` falls back to this when `scheduled` is picked with no windows set. */
const DEFAULT_SCHEDULE_WIRE = [
  { days: ['mon', 'tue', 'wed', 'thu', 'fri'], ranges: [{ start: '09:00', stop: '17:00' }] },
];

const SEEDED_PROCESSES: SeedProcess[] = [
  {
    id: ALPHA_ID,
    name: ALPHA_NAME,
    exe_path: 'C:\\seed\\alpha\\alpha.exe',
    file_path: '',
    cwd: 'C:\\seed\\alpha',
    priority: 'Normal',
    // Legacy value the agent still writes; the dialog maps it onto `Normal`.
    visibility: 'Show',
    time_delay: '0',
    time_to_init: '10',
    relaunch_attempts: '3',
    launch_mode: 'off',
    status: 'INACTIVE',
  },
  {
    id: BETA_ID,
    name: BETA_NAME,
    exe_path: 'C:\\seed\\beta\\beta.exe',
    file_path: 'C:\\seed\\beta\\beta.cfg',
    cwd: 'C:\\seed\\beta',
    priority: 'High',
    visibility: 'Show',
    time_delay: '5',
    time_to_init: '20',
    relaunch_attempts: '2',
    launch_mode: 'always',
    status: 'RUNNING',
    pid: 4242,
  },
];

test.beforeEach(async () => {
  await pinDashboardContext(TEST_USERS.admin.uid, SITE_ID);
  await seedMachineWithProcesses(SITE_ID, MACHINE_ID, SEEDED_PROCESSES);
});

/** shadcn Select: click the trigger, then pick from the listbox Radix portals to <body>. */
async function chooseOption(page: Page, trigger: Locator, optionLabel: string): Promise<void> {
  await trigger.click();
  await page.getByRole('option', { name: optionLabel, exact: true }).click();
}

/** Open the edit dialog for a seeded process row and return the dialog locator. */
async function openEditDialog(page: Page, processName: string): Promise<Locator> {
  const card = machineCard(page, MACHINE_ID);
  await expect(card).toBeVisible();
  await processEditButton(processRow(card, processName)).click();

  const dialog = page.getByRole('dialog', { name: /^edit process$/i });
  await expect(dialog).toBeVisible();
  // Pre-filled from the status doc, so this doubles as a "right row" check.
  await expect(dialog.locator('#edit-name')).toHaveValue(processName);
  return dialog;
}

test('the edit dialog writes every editable parameter to the config doc', async ({ page }) => {
  await page.goto('/dashboard');
  const dialog = await openEditDialog(page, ALPHA_NAME);

  await dialog.locator('#edit-name').fill('alpha-renamed.exe');
  await dialog.getByRole('button', { name: 'always on', exact: true }).click();
  await dialog.locator('#edit-exe-path').fill('C:\\apps\\alpha\\Alpha.exe');
  await dialog.locator('#edit-file-path').fill('C:\\projects\\show.toe --fullscreen');
  await dialog.locator('#edit-cwd').fill('C:\\apps\\alpha');
  await chooseOption(page, dialog.locator('#edit-priority'), 'high');
  await chooseOption(page, dialog.locator('#edit-visibility'), 'hidden (console apps only)');
  await dialog.locator('#edit-time-delay').fill('12');
  await dialog.locator('#edit-time-init').fill('45');
  await dialog.locator('#edit-relaunch').fill('7');

  await dialog.getByRole('button', { name: /^save changes$/i }).click();
  // The dialog closes only after the PATCH resolves, so the write has landed.
  await expect(dialog).toBeHidden();

  const processes = await readConfigProcesses(SITE_ID, MACHINE_ID);
  expect(processes).toHaveLength(2);

  const alpha = configProcessById(processes, ALPHA_ID);
  expect(alpha).toMatchObject({
    id: ALPHA_ID,
    // Backfilled by withProcessLock and re-pinned to the legacy id.
    processId: ALPHA_ID,
    name: 'alpha-renamed.exe',
    exe_path: 'C:\\apps\\alpha\\Alpha.exe',
    file_path: 'C:\\projects\\show.toe --fullscreen',
    cwd: 'C:\\apps\\alpha',
    priority: 'High',
    visibility: 'Hidden',
    time_delay: '12',
    time_to_init: '45',
    relaunch_attempts: '7',
    launch_mode: 'always',
    // Derived server-side from launch_mode, never trusted from the body.
    autolaunch: true,
  });

  // Wire types: the three timing fields are strings, not numbers.
  expect(typeof alpha.time_delay).toBe('string');
  expect(typeof alpha.time_to_init).toBe('string');
  expect(typeof alpha.relaunch_attempts).toBe('string');

  // The sibling row is untouched by a single-process PATCH.
  expect(configProcessById(processes, BETA_ID)).toMatchObject({
    name: BETA_NAME,
    exe_path: 'C:\\seed\\beta\\beta.exe',
    launch_mode: 'always',
  });

  // The agent's poll nudge on the status doc.
  expect(await readConfigChangeFlag(SITE_ID, MACHINE_ID)).toBe(true);
});

test('the edit dialog can switch launch mode to off, clearing autolaunch', async ({ page }) => {
  await page.goto('/dashboard');
  const dialog = await openEditDialog(page, BETA_NAME);

  await dialog.getByRole('button', { name: 'off', exact: true }).click();
  await dialog.getByRole('button', { name: /^save changes$/i }).click();
  await expect(dialog).toBeHidden();

  const beta = configProcessById(await readConfigProcesses(SITE_ID, MACHINE_ID), BETA_ID);
  expect(beta.launch_mode).toBe('off');
  expect(beta.autolaunch).toBe(false);
  // Untouched fields survive the partial update...
  expect(beta.exe_path).toBe('C:\\seed\\beta\\beta.exe');
  expect(beta.priority).toBe('High');
  // ...but the dialog normalizes the legacy `Show` it was seeded with.
  expect(beta.visibility).toBe('Normal');
});

test('the card launch-mode toggle writes launch_mode, autolaunch and the default schedule', async ({
  page,
}) => {
  await page.goto('/dashboard');
  const card = machineCard(page, MACHINE_ID);
  await expect(card).toBeVisible();
  const row = processRow(card, ALPHA_NAME);

  // off → scheduled. No windows are configured, so the handler falls back to M–F 9–5.
  await row.getByRole('button', { name: 'scheduled', exact: true }).click();
  await expect(page.getByText(`launch mode set to scheduled for "${ALPHA_NAME}"`)).toBeVisible();

  let alpha = configProcessById(await readConfigProcesses(SITE_ID, MACHINE_ID), ALPHA_ID);
  expect(alpha.launch_mode).toBe('scheduled');
  expect(alpha.autolaunch).toBe(true);
  expect(alpha.schedules).toEqual(DEFAULT_SCHEDULE_WIRE);

  // The launch-mode action also mirrors onto the status doc so the dashboard
  // doesn't have to wait for the agent's next metrics upload.
  const statusRow = await readStatusProcess(SITE_ID, MACHINE_ID, ALPHA_ID);
  expect(statusRow).toMatchObject({ launch_mode: 'scheduled', autolaunch: true });

  // scheduled → off. The body omits `schedules`, so the configured windows stay.
  await row.getByRole('button', { name: 'off', exact: true }).click();
  await expect(page.getByText(`launch mode set to off for "${ALPHA_NAME}"`)).toBeVisible();

  alpha = configProcessById(await readConfigProcesses(SITE_ID, MACHINE_ID), ALPHA_ID);
  expect(alpha.launch_mode).toBe('off');
  expect(alpha.autolaunch).toBe(false);
  expect(alpha.schedules).toEqual(DEFAULT_SCHEDULE_WIRE);
});

test('adding a process appends a fully-formed row to the config doc', async ({ page }) => {
  await page.goto('/dashboard');
  const card = machineCard(page, MACHINE_ID);
  await expect(card).toBeVisible();

  await card.getByRole('button', { name: /^add process$/i }).click();
  const dialog = page.getByRole('dialog', { name: /^add process$/i });
  await expect(dialog).toBeVisible();

  await dialog.locator('#edit-name').fill('gamma.exe');
  await dialog.getByRole('button', { name: 'always on', exact: true }).click();
  await dialog.locator('#edit-exe-path').fill('C:\\apps\\gamma\\Gamma.exe');
  await dialog.locator('#edit-file-path').fill('C:\\projects\\gamma.cfg');
  await dialog.locator('#edit-cwd').fill('C:\\apps\\gamma');
  await chooseOption(page, dialog.locator('#edit-priority'), 'low');
  await chooseOption(page, dialog.locator('#edit-visibility'), 'hidden (console apps only)');
  await dialog.locator('#edit-time-delay').fill('3');
  await dialog.locator('#edit-time-init').fill('20');
  await dialog.locator('#edit-relaunch').fill('5');

  await dialog.getByRole('button', { name: /^create process$/i }).click();
  await expect(dialog).toBeHidden();

  const processes = await readConfigProcesses(SITE_ID, MACHINE_ID);
  expect(processes).toHaveLength(3);

  // New rows are appended, so the seeded pair keeps its order.
  const created = processes[2];
  expect(created).toMatchObject({
    name: 'gamma.exe',
    exe_path: 'C:\\apps\\gamma\\Gamma.exe',
    file_path: 'C:\\projects\\gamma.cfg',
    cwd: 'C:\\apps\\gamma',
    priority: 'Low',
    visibility: 'Hidden',
    time_delay: '3',
    time_to_init: '20',
    relaunch_attempts: '5',
    launch_mode: 'always',
    autolaunch: true,
    schedules: null,
  });

  // Server-generated UUID, mirrored onto the legacy id the agent reads.
  expect(created.processId).toMatch(
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
  );
  expect(created.id).toBe(created.processId);

  expect(await readConfigChangeFlag(SITE_ID, MACHINE_ID)).toBe(true);

  // The new row is invisible on the dashboard until the agent's next metrics
  // upload adds it to the status doc — the config doc above is the contract.
});

// The dialog's form scrolls, and a scroller clips both axes: with no inline
// gutter it cut the left edge off every full-width field's focus ring.
test('no tab stop in the add process dialog has its focus ring cut off', async ({ page }) => {
  await page.goto('/dashboard');
  const card = machineCard(page, MACHINE_ID);
  await expect(card).toBeVisible();

  await card.getByRole('button', { name: /^add process$/i }).click();
  const dialog = page.getByRole('dialog', { name: /^add process$/i });
  await expect(dialog).toBeVisible();
  // scheduled opens the schedule section, whose blocks scroll in a box of their own
  await dialog.getByRole('button', { name: 'scheduled', exact: true }).click();
  await expect(dialog.getByTestId('process-dialog-schedule-section')).toBeVisible();

  expect(await clippedFocusRings(page, dialog)).toEqual([]);
});

// outlines are for form fields (owner, 2026-11-20): a launch mode segment
// takes keyboard focus with none, rather than one its overflow-hidden group cuts
test('the launch mode toggle on a process row draws no focus outline', async ({ page }) => {
  await page.goto('/dashboard');
  const toggle = machineCard(page, MACHINE_ID).getByRole('group', {
    name: `launch mode for ${ALPHA_NAME}`,
  });
  await expect(toggle).toBeVisible();

  await page.keyboard.press('Shift');
  const outlines = await toggle.evaluate((group) =>
    Array.from(group.querySelectorAll<HTMLElement>('button')).map((button) => {
      button.focus();
      const style = button.matches(':focus-visible') ? getComputedStyle(button).outlineStyle : 'not focus-visible';
      return `${button.getAttribute('aria-label') ?? button.textContent?.trim()}: ${style}`;
    }),
  );
  expect(outlines).toEqual([
    'off: none',
    'always on: none',
    'scheduled: none',
    `configure schedule for ${ALPHA_NAME}: none`,
  ]);
});

test('deleting a process removes only that row from the config doc', async ({ page }) => {
  await page.goto('/dashboard');
  const dialog = await openEditDialog(page, BETA_NAME);

  // Icon-only trash in the dialog footer; no accessible name.
  await dialog.locator('button:has(svg.lucide-trash-2)').click();

  const confirmDialog = page.getByRole('dialog', { name: /^delete process$/i });
  await expect(confirmDialog).toBeVisible();
  await expect(confirmDialog).toContainText(BETA_NAME);
  await confirmDialog.getByRole('button', { name: /^delete process$/i }).click();
  await expect(confirmDialog).toBeHidden();

  const processes = await readConfigProcesses(SITE_ID, MACHINE_ID);
  expect(processes).toHaveLength(1);
  expect(processes[0]).toMatchObject({ id: ALPHA_ID, name: ALPHA_NAME });
  expect(await readConfigChangeFlag(SITE_ID, MACHINE_ID)).toBe(true);
});

test('a save that violates client-side validation never reaches the config doc', async ({
  page,
}) => {
  await page.goto('/dashboard');
  const dialog = await openEditDialog(page, ALPHA_NAME);

  await dialog.locator('#edit-exe-path').fill('');
  await dialog.getByRole('button', { name: /^save changes$/i }).click();

  await expect(toasts(page).filter({ hasText: 'executable path is required' })).toBeVisible();
  await expect(dialog).toBeVisible();

  const alpha = configProcessById(await readConfigProcesses(SITE_ID, MACHINE_ID), ALPHA_ID);
  expect(alpha.exe_path).toBe('C:\\seed\\alpha\\alpha.exe');
});
