/**
 * the process editor's path warning: after a save changes a path field, the
 * dashboard asks the machine with `check_path`, and warns only on a clear answer.
 * these specs play the agent's answer into `commands/completed`, the way dispatch
 * specs do, in the JSON the real agent writes (agent/src/path_commands.py);
 * `e2e/desktop-sync/tier0-check-path.spec.ts` has the real agent answering.
 *
 * silence is the contract as much as the warning is: the save is never held up, and
 * an old agent or an offline machine hears nothing. a warning outlives the user
 * moving on to another process: it names the process, browse saves to that process,
 * and it goes if the process is gone or the field holds something else.
 *
 * as in `process-config-roundtrip.spec.ts`, rows render from the status doc, so
 * locators use the SEEDED name and outcomes are read from the config doc.
 */

import { test, expect, type Locator, type Page } from '@playwright/test';
import { roleState } from '../../helpers/roles';
import { getAdminDb } from '../../helpers/emulator';
import { TEST_USERS } from '../../helpers/seed';
import { completeCommand } from '../../helpers/stubAgent';
import {
  configProcessById,
  machineCard,
  pinDashboardContext,
  processEditButton,
  processRow,
  readConfigProcesses,
  seedMachineWithProcesses,
  toasts,
  type WireProcess,
} from '../../helpers/processConfig';

test.use(roleState('admin'));

const SITE_ID = 'site-A';
const MACHINE_ID = 'e2e-path-check';
const PROCESS_ID = 'proc-show';
const PROCESS_NAME = 'show.exe';
const OTHER_ID = 'proc-other';
const OTHER_NAME = 'other.exe';

function commandsDoc(name: 'pending' | 'completed') {
  return getAdminDb()
    .collection('sites').doc(SITE_ID)
    .collection('machines').doc(MACHINE_ID)
    .collection('commands').doc(name);
}

function configDoc() {
  return getAdminDb().collection('config').doc(SITE_ID).collection('machines').doc(MACHINE_ID);
}

interface PendingCheck {
  id: string;
  field: string;
  value: string;
}

/** the check_path commands waiting for the agent, oldest id first. */
async function pendingChecks(): Promise<PendingCheck[]> {
  const pending = (await commandsDoc('pending').get()).data() ?? {};
  return Object.entries(pending)
    .filter(([, command]) => command?.type === 'check_path')
    .map(([id, command]) => ({ id, field: command.field, value: command.value }))
    .sort((a, b) => a.id.localeCompare(b.id));
}

/** waits for the next check_path about `field` and returns it. */
async function nextCheck(field: string): Promise<PendingCheck> {
  let found: PendingCheck | undefined;
  await expect
    .poll(async () => {
      found = (await pendingChecks()).find((check) => check.field === field);
      return found !== undefined;
    })
    .toBe(true);
  return found!;
}

/** the agent's answer about a path that isn't there. */
function missingAnswer(path: string, rest: string, nearest: string | null) {
  return JSON.stringify({ status: 'missing', warning: 'missing', path, rest, nearest });
}

function folderAnswer(path: string, parent: string | null, folders: string[], files: string[]) {
  return JSON.stringify({
    status: 'folder', warning: null, path, rest: '', nearest: null, parent, folders, files, truncated: false,
  });
}

async function answer(check: PendingCheck, result: string): Promise<void> {
  await completeCommand(SITE_ID, MACHINE_ID, check.id, result, { cmdType: 'check_path' });
}

async function openEditor(page: Page, processName = PROCESS_NAME): Promise<Locator> {
  const card = machineCard(page, MACHINE_ID);
  await expect(card).toBeVisible();
  await processEditButton(processRow(card, processName)).click();
  const dialog = page.getByRole('dialog', { name: /^edit process$/i });
  await expect(dialog).toBeVisible();
  await expect(dialog.locator('#edit-name')).toHaveValue(processName);
  return dialog;
}

/** saves a new value for one field; the save is done when this returns, with no agent in the room. */
async function saveField(page: Page, input: string, value: string): Promise<void> {
  const editor = await openEditor(page);
  await editor.locator(input).fill(value);
  await editor.getByRole('button', { name: /^save changes$/i }).click();
  await expect(editor).toBeHidden();
}

async function saveFilePath(page: Page, value: string): Promise<void> {
  await saveField(page, '#edit-file-path', value);
  expect(configProcessById(await readConfigProcesses(SITE_ID, MACHINE_ID), PROCESS_ID).file_path).toBe(value);
}

async function readProcess(id = PROCESS_ID): Promise<WireProcess> {
  return configProcessById(await readConfigProcesses(SITE_ID, MACHINE_ID), id);
}

test.beforeEach(async () => {
  await pinDashboardContext(TEST_USERS.admin.uid, SITE_ID);
  await seedMachineWithProcesses(SITE_ID, MACHINE_ID, [
    {
      id: PROCESS_ID,
      name: PROCESS_NAME,
      exe_path: 'C:\\show\\show.exe',
      file_path: '',
      cwd: 'C:\\show',
    },
    { id: OTHER_ID, name: OTHER_NAME, exe_path: 'C:\\other\\other.exe', file_path: '', cwd: '' },
  ]);
  await commandsDoc('pending').set({});
  await commandsDoc('completed').set({});
});

test('a missing path warns after the save, naming the process and field, and ok leaves it as typed', async ({ page }, testInfo) => {
  await page.goto('/dashboard');
  await saveFilePath(page, 'C:\\show\\gone.toe');

  // only the changed field is asked about.
  const check = await nextCheck('file_path');
  expect(check.value).toBe('C:\\show\\gone.toe');
  expect(await pendingChecks()).toHaveLength(1);

  await answer(check, missingAnswer('C:\\show\\gone.toe', '', 'C:\\show'));

  const warning = page.getByRole('dialog', { name: /^can't find this file$/i });
  await expect(warning).toBeVisible();
  await expect(warning).toContainText('C:\\show\\gone.toe');
  await expect(warning).toContainText(MACHINE_ID);
  await expect(warning.getByTestId('path-warning-process')).toHaveText(`${PROCESS_NAME} · file path / command arguments`);
  await page.screenshot({ path: testInfo.outputPath('missing-path-warning.png') });

  await warning.getByRole('button', { name: /^ok$/i }).click();
  await expect(warning).toBeHidden();

  expect((await readProcess()).file_path).toBe('C:\\show\\gone.toe');
});

test('browse opens the nearest folder, goes up and in, and picking a file saves it with the arguments kept', async ({
  page,
}, testInfo) => {
  await page.goto('/dashboard');
  await saveFilePath(page, 'C:\\show\\old\\run.py 8000');

  await answer(await nextCheck('file_path'), missingAnswer('C:\\show\\old\\run.py', '8000', 'C:\\show\\old'));

  const warning = page.getByRole('dialog', { name: /^can't find this file$/i });
  await warning.getByRole('button', { name: /^browse$/i }).click();

  const browser = page.getByRole('dialog', { name: `browse ${MACHINE_ID}` });
  await expect(browser).toBeVisible();

  const opened = await nextCheck('folder');
  expect(opened.value).toBe('C:\\show\\old');
  await answer(opened, folderAnswer('C:\\show\\old', 'C:\\show', ['archive'], ['readme.txt']));
  await expect(browser.getByTestId('folder-browser-path')).toHaveText('C:\\show\\old');
  await expect(browser.getByRole('button', { name: 'readme.txt' })).toBeVisible();

  // up: the listing the agent sends for the parent replaces this one.
  await browser.getByRole('button', { name: 'up', exact: true }).click();
  const up = await nextCheck('folder');
  expect(up.value).toBe('C:\\show');
  await answer(up, folderAnswer('C:\\show', 'C:\\', ['new show', 'old'], ['notes.txt']));
  await expect(browser.getByRole('button', { name: 'new show' })).toBeVisible();

  // into a folder, by name.
  await browser.getByRole('button', { name: 'new show' }).click();
  const into = await nextCheck('folder');
  expect(into.value).toBe('C:\\show\\new show');
  await answer(into, folderAnswer('C:\\show\\new show', 'C:\\show', ['media'], ['run.py', 'settings.json']));
  await expect(browser.getByRole('button', { name: 'run.py' })).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath('missing-path-folder-browser.png') });

  await browser.getByRole('button', { name: 'run.py' }).click();
  await expect(browser).toBeHidden();

  // a space in the path needs quotes once arguments follow it, or the agent splits it.
  const saved = await readProcess();
  expect(saved.file_path).toBe('"C:\\show\\new show\\run.py" 8000');
  // the pick changes that one field and nothing else.
  expect(saved.exe_path).toBe('C:\\show\\show.exe');
  expect(saved.cwd).toBe('C:\\show');
  // and it isn't asked about again: it was just on screen.
  expect(await pendingChecks()).toHaveLength(0);
});

test('a working directory picks the folder itself, not a file in it', async ({ page }) => {
  await page.goto('/dashboard');
  await saveField(page, '#edit-cwd', 'C:\\show\\gone');

  await answer(await nextCheck('cwd'), missingAnswer('C:\\show\\gone', '', 'C:\\show'));
  const warning = page.getByRole('dialog', { name: /^can't find this folder$/i });
  await warning.getByRole('button', { name: /^browse$/i }).click();

  const browser = page.getByRole('dialog', { name: `browse ${MACHINE_ID}` });
  await answer(await nextCheck('folder'), folderAnswer('C:\\show', 'C:\\', [], ['a.txt']));
  await expect(browser.getByRole('button', { name: 'a.txt' })).toBeDisabled();

  await browser.getByRole('button', { name: /^use this folder$/i }).click();
  await expect(browser).toBeHidden();
  expect((await readProcess()).cwd).toBe('C:\\show');
});

test('a folder as launch target warns and browse starts inside it', async ({ page }) => {
  await page.goto('/dashboard');
  await saveField(page, '#edit-exe-path', 'C:\\show\\app');

  await answer(
    await nextCheck('exe_path'),
    JSON.stringify({ status: 'folder', warning: 'folder', path: 'C:\\show\\app', rest: '', nearest: 'C:\\show\\app' }),
  );

  const warning = page.getByRole('dialog', { name: /^this is a folder, not a file$/i });
  await expect(warning).toContainText('browse starts inside it');
  await warning.getByRole('button', { name: /^browse$/i }).click();

  expect((await nextCheck('folder')).value).toBe('C:\\show\\app');
});

test('a file as working directory warns and browse starts in its folder', async ({ page }) => {
  await page.goto('/dashboard');
  await saveField(page, '#edit-cwd', 'C:\\show\\app.exe');

  await answer(
    await nextCheck('cwd'),
    JSON.stringify({ status: 'file', warning: 'file', path: 'C:\\show\\app.exe', rest: '', nearest: 'C:\\show' }),
  );

  const warning = page.getByRole('dialog', { name: /^this is a file, not a folder$/i });
  await warning.getByRole('button', { name: /^browse$/i }).click();

  expect((await nextCheck('folder')).value).toBe('C:\\show');
});

test('a symbolic link warns in the words the desktop app uses', async ({ page }) => {
  await page.goto('/dashboard');
  await saveField(page, '#edit-exe-path', 'C:\\show\\link.exe');

  await answer(
    await nextCheck('exe_path'),
    JSON.stringify({ status: 'file', warning: 'link', path: 'C:\\show\\link.exe', rest: '', nearest: 'C:\\show' }),
  );

  await expect(page.getByRole('dialog', { name: /^owlette can't launch through a symbolic link$/i })).toBeVisible();
});

test('a network path warns with nothing to browse', async ({ page }) => {
  await page.goto('/dashboard');
  await saveField(page, '#edit-exe-path', '\\\\nas\\show\\app.exe');

  await answer(
    await nextCheck('exe_path'),
    JSON.stringify({ status: 'unknown', warning: 'network', path: '\\\\nas\\show\\app.exe', rest: '', nearest: null }),
  );

  const warning = page.getByRole('dialog', { name: /^owlette can't launch from a network path$/i });
  await expect(warning).toBeVisible();
  await expect(warning.getByRole('button', { name: /^browse$/i })).toHaveCount(0);
});

test('a launch target that is not a full path warns, with nothing to browse', async ({ page }) => {
  await page.goto('/dashboard');
  await saveField(page, '#edit-exe-path', 'show.exe');

  await answer(
    await nextCheck('exe_path'),
    JSON.stringify({ status: 'unknown', warning: 'not_absolute', path: 'show.exe', rest: '', nearest: null }),
  );

  const warning = page.getByRole('dialog', { name: /^this isn't a full path$/i });
  await expect(warning).toBeVisible();
  await expect(warning.getByRole('button', { name: /^browse$/i })).toHaveCount(0);
  await warning.getByRole('button', { name: /^ok$/i }).click();
  await expect(warning).toBeHidden();
});

/** no warning dialog and no error toast, a beat after the answer had its chance to land. */
async function expectSilence(page: Page): Promise<void> {
  await page.waitForTimeout(1_000);
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(toasts(page).filter({ hasText: /error|failed|unknown|offline/i })).toHaveCount(0);
}

test('an agent too old to know the command says nothing', async ({ page }) => {
  await page.goto('/dashboard');
  await saveFilePath(page, 'C:\\show\\gone.toe');

  // what an agent below this version really writes: a completed command, in words.
  await answer(await nextCheck('file_path'), 'Unknown command type: check_path');

  await expectSilence(page);
});

test('an offline machine says nothing and queues nothing', async ({ page }) => {
  await page.goto('/dashboard');
  const editor = await openEditor(page);
  await getAdminDb()
    .collection('sites').doc(SITE_ID)
    .collection('machines').doc(MACHINE_ID)
    .set({ online: false }, { merge: true });
  await editor.locator('#edit-file-path').fill('C:\\show\\gone.toe');
  await editor.getByRole('button', { name: /^save changes$/i }).click();
  await expect(editor).toBeHidden();

  await expectSilence(page);
  expect(await pendingChecks()).toHaveLength(0);
});

test('a check that found the path says nothing', async ({ page }) => {
  await page.goto('/dashboard');
  await saveFilePath(page, 'C:\\show\\main.toe');

  await answer(
    await nextCheck('file_path'),
    JSON.stringify({ status: 'file', warning: null, path: 'C:\\show\\main.toe', rest: '', nearest: null }),
  );

  await expectSilence(page);
});

test('an unchanged path is not asked about', async ({ page }) => {
  await page.goto('/dashboard');
  const editor = await openEditor(page);
  await editor.locator('#edit-time-delay').fill('5');
  await editor.getByRole('button', { name: /^save changes$/i }).click();
  await expect(editor).toBeHidden();

  await page.waitForTimeout(1_000);
  expect(await pendingChecks()).toHaveLength(0);
});

test('switching to another process keeps the warning, and browse saves to the process it warned about', async ({ page }) => {
  await page.goto('/dashboard');
  await saveFilePath(page, 'C:\\show\\gone.toe');
  const check = await nextCheck('file_path');

  // the user has moved on and is editing another process when the answer lands.
  await openEditor(page, OTHER_NAME);
  await answer(check, missingAnswer('C:\\show\\gone.toe', '', 'C:\\show'));

  const warning = page.getByRole('dialog', { name: /^can't find this file$/i });
  await expect(warning).toBeVisible();
  await expect(warning.getByTestId('path-warning-process')).toHaveText(`${PROCESS_NAME} · file path / command arguments`);
  await warning.getByRole('button', { name: /^browse$/i }).click();

  const browser = page.getByRole('dialog', { name: `browse ${MACHINE_ID}` });
  await answer(await nextCheck('folder'), folderAnswer('C:\\show', 'C:\\', [], ['main.toe']));
  await browser.getByRole('button', { name: 'main.toe' }).click();
  await expect(browser).toBeHidden();

  expect((await readProcess()).file_path).toBe('C:\\show\\main.toe');
  expect((await readProcess(OTHER_ID)).file_path).toBe('');
  // and the editor the user moved on to is still there, with their other process in it.
  await expect(page.locator('#edit-name')).toHaveValue(OTHER_NAME);
});

test('reopening and closing the editor before the answer keeps the warning', async ({ page }) => {
  await page.goto('/dashboard');
  await saveFilePath(page, 'C:\\show\\gone.toe');
  const check = await nextCheck('file_path');

  const reopened = await openEditor(page);
  await reopened.getByRole('button', { name: /^cancel$/i }).click();
  await expect(reopened).toBeHidden();
  await answer(check, missingAnswer('C:\\show\\gone.toe', '', 'C:\\show'));

  await expect(page.getByRole('dialog', { name: /^can't find this file$/i })).toBeVisible();
});

test('the warning goes when the process is gone', async ({ page }) => {
  await page.goto('/dashboard');
  await saveFilePath(page, 'C:\\show\\gone.toe');
  await answer(await nextCheck('file_path'), missingAnswer('C:\\show\\gone.toe', '', 'C:\\show'));
  const warning = page.getByRole('dialog', { name: /^can't find this file$/i });
  await expect(warning).toBeVisible();

  const processes = await readConfigProcesses(SITE_ID, MACHINE_ID);
  await configDoc().update({ processes: processes.filter((process) => process.id !== PROCESS_ID) });

  await expect(warning).toBeHidden();
});

test('the warning goes when the field no longer holds that value', async ({ page }) => {
  await page.goto('/dashboard');
  await saveFilePath(page, 'C:\\show\\gone.toe');
  await answer(await nextCheck('file_path'), missingAnswer('C:\\show\\gone.toe', '', 'C:\\show'));
  const warning = page.getByRole('dialog', { name: /^can't find this file$/i });
  await expect(warning).toBeVisible();

  const processes = await readConfigProcesses(SITE_ID, MACHINE_ID);
  await configDoc().update({
    processes: processes.map((process) => (process.id === PROCESS_ID ? { ...process, file_path: 'C:\\elsewhere.toe' } : process)),
  });

  await expect(warning).toBeHidden();
});

test('esc during a pick saving does not lose the next warning', async ({ page }) => {
  await page.goto('/dashboard');
  const editor = await openEditor(page);
  await editor.locator('#edit-exe-path').fill('C:\\gone\\app.exe');
  await editor.locator('#edit-cwd').fill('C:\\gone');
  await editor.getByRole('button', { name: /^save changes$/i }).click();
  await expect(editor).toBeHidden();

  await answer(await nextCheck('exe_path'), missingAnswer('C:\\gone\\app.exe', '', 'C:\\'));
  const first = page.getByRole('dialog', { name: /^can't find this file$/i });
  await first.getByRole('button', { name: /^browse$/i }).click();
  const browser = page.getByRole('dialog', { name: `browse ${MACHINE_ID}` });
  await answer(await nextCheck('folder'), folderAnswer('C:\\', null, [], ['app.exe']));

  // hold the pick's save open until esc has landed.
  let release = () => {};
  const held = new Promise<void>((resolve) => { release = resolve; });
  await page.route(`**/processes/${PROCESS_ID}`, async (route) => {
    await held;
    await route.continue();
  });

  await browser.getByRole('button', { name: 'app.exe' }).click();
  await page.keyboard.press('Escape');
  await expect(browser).toBeHidden();
  await answer(await nextCheck('cwd'), missingAnswer('C:\\gone', '', 'C:\\'));
  release();

  await expect(page.getByRole('dialog', { name: /^can't find this folder$/i })).toBeVisible();
  await expect.poll(async () => (await readProcess()).exe_path).toBe('C:\\app.exe');
});
