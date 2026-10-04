/**
 * Screenshots of the owlette desktop app for the agent docs. Driven over CDP
 * against the release binary at `C:\ProgramData\Owlette\app\owlette-desktop.exe`
 * with a scratch `%PROGRAMDATA%` of fixtures (see `harness.ts` / `fixtures.ts`).
 * Output: `web/public/docs-screens/`, referenced by `web/content/docs/agent/*.mdx`.
 * Each shot is taken once per project theme; the light one is `agent-*-light.png`.
 *
 * Serial by construction — one window, and each scenario replaces the previous
 * one's seam files underneath it.
 */

import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { chromium, expect, test, type Browser, type Locator, type Page } from '@playwright/test'
import {
  DEMO_PAIR_PHRASE,
  DEMO_PROCESS_NAMES,
  DEMO_SITE_ID,
  hasProcesses,
  seedScenario,
  type Scenario,
} from './fixtures'
import { CAPTURE_HOSTNAME, SCRATCH_ROOT, readSession } from './harness'
import { projectTheme, themedPath, type ShotTheme } from '../screenshots/themes'

const DOCS_DIR = 'public/docs-screens'

/**
 * Nothing may still be moving when the shutter opens: the launch-mode indicator
 * slides for 200 ms and Radix fades overlays in — mid-animation shots diff
 * between runs.
 */
const NO_MOTION = `
  *, *::before, *::after {
    animation-duration: 0s !important;
    animation-delay: 0s !important;
    transition-duration: 0s !important;
    transition-delay: 0s !important;
  }
`

/** Somewhere inert to park the pointer: the titlebar has no hover state. */
const POINTER_PARK = { x: 420, y: 5 }

let browser: Browser
let page: Page
let theme: ShotTheme

test.describe.configure({ mode: 'serial' })

test.beforeAll(async () => {
  const session = readSession()
  browser = await chromium.connectOverCDP(`http://127.0.0.1:${session.port}`)

  const pages = browser.contexts()[0]?.pages() ?? []
  const found = pages.find((candidate) => candidate.url().includes('tauri.localhost'))
  if (!found) {
    throw new Error(`no owlette webview on the debug port (saw: ${pages.map((p) => p.url()).join(', ')})`)
  }
  page = found

  await page.addStyleTag({ content: NO_MOTION })
  fs.mkdirSync(DOCS_DIR, { recursive: true })

  theme = projectTheme()
  await useAppTheme(theme)
})

test.afterAll(async () => {
  // Only disconnects the webview — global teardown stops the app and restores
  // the layout file.
  await browser?.close()
})

/**
 * Put the window in this project's theme, the way the app menu does: the host
 * pins the window theme, the webview's `prefers-color-scheme` follows it, and
 * next-themes swaps the class, so the class is the proof. The capture opens dark
 * (`snapshotLayout`), so a dark run asks nothing of the binary; switching needs
 * `set_appearance_theme`, which an app built before light mode does not have.
 */
async function useAppTheme(target: ShotTheme): Promise<void> {
  const html = page.locator('html')
  if (await html.evaluate((el, name) => el.classList.contains(name), target)) return

  try {
    await page.evaluate(async (choice) => {
      const tauri = (window as unknown as {
        __TAURI_INTERNALS__: { invoke: (cmd: string, args: Record<string, unknown>) => Promise<unknown> }
      }).__TAURI_INTERNALS__
      await tauri.invoke('set_appearance_theme', { theme: choice })
    }, target)
  } catch (error) {
    throw new Error(
      `could not switch the app to ${target}; an app built before light mode has no set_appearance_theme (${String(error)})`,
    )
  }
  await expect(html).toContainClass(target)
}

/** Drop focus the previous test left behind — it draws a ring in the next shot. */
async function clearFocus(): Promise<void> {
  await page.evaluate(() => {
    const active = document.activeElement
    if (active instanceof HTMLElement) active.blur()
  })
}

/** Swap the machine under the window and wait for the app to have re-read it. */
async function useScenario(scenario: Scenario): Promise<void> {
  await clearFocus()
  await page.mouse.move(POINTER_PARK.x, POINTER_PARK.y)

  seedScenario(SCRATCH_ROOT, scenario)
  // The same predicate the seed writes from: a scenario added later cannot be
  // given rows and then waited on as if the list were empty.
  if (hasProcesses(scenario)) {
    await expect(page.getByTestId('process-row')).toHaveCount(DEMO_PROCESS_NAMES.length)
  } else {
    await expect(page.getByTestId('process-list-empty')).toBeVisible()
  }

  // The list may already look right, so the footer is the only proof the new
  // `config.json` was read.
  await expect(page.getByTestId('footer-status')).toContainText(
    scenario === 'unpaired' ? 'disabled' : 'connected',
  )

  // Neither check can see a difference confined to `app_states.json` — `paired`
  // and `paired-stalled` write the same config and the same footer — so a test
  // that turns on a status waits on that row itself.
}

/** Select a process by the name the sidebar shows, leaving no hover behind. */
async function selectProcess(name: string): Promise<void> {
  await page.getByTestId('process-row').filter({ hasText: name }).click()
  await expect(page.locator('#name')).toHaveValue(name)
  await page.mouse.move(POINTER_PARK.x, POINTER_PARK.y)
}

/** Everything has arrived and stopped moving. */
async function settle(): Promise<void> {
  await page.evaluate(() => document.fonts.ready.then(() => undefined))
  await page.waitForTimeout(300)
}

async function shoot(name: string, target?: Locator): Promise<void> {
  await settle()
  await (target ?? page).screenshot({ path: themedPath(`${DOCS_DIR}/${name}`, theme) })
}

/** The right-hand pane, identified by the control only it contains. */
function detailPanel(): Locator {
  return page.locator('section').filter({ has: page.getByTestId('launch-mode') })
}

test('a configured machine: process list and per-process detail', async () => {
  await useScenario('paired')
  await selectProcess('gallery show')
  await expect(page.getByTestId('detail-status')).toHaveText('running')

  await shoot('agent.png')
})

test('launch modes: the segmented control and a scheduled process', async () => {
  await useScenario('paired')
  await selectProcess('lobby kiosk')
  await expect(page.getByTestId('launch-mode-scheduled')).toHaveAttribute('aria-checked', 'true')
  await expect(page.getByTestId('schedule-note')).toBeVisible()

  await shoot('agent-launch-mode.png', detailPanel())
})

test('the schedule editor', async () => {
  await useScenario('paired')
  await selectProcess('lobby kiosk')

  await page.getByTestId('edit-schedule').click()
  await expect(page.getByTestId('schedule-editor')).toBeVisible()
  // The dialog autofocuses the block-name field with its text selected; a caret
  // and selection highlight are not part of the UI.
  await clearFocus()
  await page.mouse.move(POINTER_PARK.x, POINTER_PARK.y)

  await shoot('agent-schedule-editor.png')

  // Escape discards the draft; `save schedule` is the only path that writes.
  await page.keyboard.press('Escape')
  await expect(page.getByTestId('schedule-editor')).toBeHidden()
})

test('the app menu', async () => {
  await useScenario('paired')
  await selectProcess('gallery show')

  await page.getByTestId('app-menu-trigger').click()
  await expect(page.getByTestId('menu-leave-site')).toBeVisible()

  await shoot('agent-menu.png')

  await page.keyboard.press('Escape')
  await expect(page.getByTestId('menu-leave-site')).toBeHidden()
})

test('leaving a site: the confirmation', async () => {
  await useScenario('paired')
  await selectProcess('gallery show')

  await page.getByTestId('app-menu-trigger').click()
  await page.getByTestId('menu-leave-site').click()

  const dialog = page.getByTestId('leave-site-dialog')
  await expect(dialog).toBeVisible()
  // The confirm phase is copy and two buttons — the service is stopped and the
  // machine document deleted only once `leave site` is pressed, and the only
  // key this test presses is Escape. Naming the site proves that phase rendered.
  await expect(dialog).toContainText(DEMO_SITE_ID)
  // Radix moves focus into the dialog on open (`cancel` is the first control);
  // a focus ring on a button the reader is not being told to press is noise.
  await clearFocus()
  await page.mouse.move(POINTER_PARK.x, POINTER_PARK.y)

  await shoot('agent-leave-site.png')

  await page.keyboard.press('Escape')
  await expect(dialog).toBeHidden()
})

test('the bug report dialog', async () => {
  await useScenario('paired')
  await selectProcess('gallery show')

  await page.getByTestId('app-menu-trigger').click()
  await page.getByTestId('menu-report-issue').click()

  const dialog = page.getByTestId('report-issue-dialog')
  await expect(dialog).toBeVisible()
  // An empty draft, which is also what makes this shot safe to take: `submit`
  // stays disabled until something is typed, so a capture run cannot post to
  // `bug_reports`. The counter is the opening state stated in full
  // (`ReportIssueDialog.MAX_DESCRIPTION`, 1000).
  await expect(page.getByTestId('report-remaining')).toHaveText('1000 characters left')
  await expect(page.getByRole('button', { name: 'submit', exact: true })).toBeDisabled()
  await clearFocus()
  await page.mouse.move(POINTER_PARK.x, POINTER_PARK.y)

  await shoot('agent-report-issue.png')

  await page.keyboard.press('Escape')
  await expect(dialog).toBeHidden()
})

test('how to run: the folded section, opened', async () => {
  await useScenario('paired')
  // Always-on, so the group is at full strength: `ProcessDetail` dims it and
  // appends "applies once a launch mode is set" while the mode is off
  // (`unmanaged`), and a dimmed shot would document the wrong thing about
  // fields that apply to every managed process.
  await selectProcess('gallery show')

  // Closed on first launch since 3.2.2 (`DETAIL_SECTION_DEFAULTS.howToRun`),
  // which is why attempts / priority / visibility appear in no other shot.
  await page.getByTestId('how-to-run-toggle').click()
  await expect(page.getByTestId('how-to-run-fields')).toBeVisible()
  await clearFocus()
  await page.mouse.move(POINTER_PARK.x, POINTER_PARK.y)

  // Three open sections nearly fill the pane, and the pane scrolls: with the
  // last field below the fold this shot would show everything except its
  // subject. If this ever fails, the fix is a taller capture window
  // (`CAPTURE_WINDOW`), not a scrolled shot.
  await expect(page.getByTestId('visibility')).toBeInViewport({ ratio: 1 })

  await shoot('agent-how-to-run.png', detailPanel())

  // Fold it back. Not tidiness: the open state is owned above the pane so it
  // survives a process change, and it is written to the per-user layout file
  // the moment it is toggled (`set_detail_section`) — every later detail shot
  // would inherit it.
  await page.getByTestId('how-to-run-toggle').click()
  await expect(page.getByTestId('how-to-run-fields')).toBeHidden()
})

test('restart and kill on a process that is not running', async () => {
  await useScenario('paired')
  // The kiosk has no row in `app_states.json` — outside its window, nothing
  // launched it — so it reads INACTIVE while its launch mode is `scheduled`.
  // That pair is the shot: since 3.2.2 both controls follow liveness alone, so
  // a managed process that is not up has both greyed out.
  await selectProcess('lobby kiosk')
  await expect(page.getByTestId('detail-status')).toHaveText('inactive')
  await expect(page.getByRole('button', { name: 'restart process' })).toBeDisabled()
  await expect(page.getByRole('button', { name: 'kill process' })).toBeDisabled()

  // The header, not the panel: `agent-launch-mode.png` is already this process's
  // panel, so a second panel-wide shot would differ from it by two buttons.
  await shoot('agent-run-controls.png', page.getByTestId('detail-header'))
})

test('the status dots: running, stalled and inactive together', async () => {
  await useScenario('paired-stalled')
  // Selecting is not incidental — the selected row is drawn differently, and
  // without this whichever process the previous test left selected would decide
  // which row is highlighted here.
  await selectProcess('gallery show')

  // `useScenario` cannot see this scenario arrive (same config, same footer as
  // `paired`), so the rows are the proof: one status word moved in
  // `app_states.json`, and the kiosk's absence from it is the hollow ring.
  const row = (name: string) => page.getByTestId('process-row').filter({ hasText: name })
  await expect(row('gallery show')).toHaveAttribute('data-status', 'RUNNING')
  await expect(row('media server')).toHaveAttribute('data-status', 'STALLED')
  await expect(row('lobby kiosk')).toHaveAttribute('data-status', 'INACTIVE')

  await shoot('agent-process-states.png', page.getByTestId('process-list'))
})

/*
 * NOT captured: the drop-confirm review card (`DropConfirm`).
 *
 * There is no route to it that isn't a real OS drag. `useFileDrop` subscribes to
 * the host's `tauri://drag-*` events, and with `dragDropEnabled`
 * (tauri.conf.json) the webview hands drops to Rust so the page's own `ondrop`
 * never fires — which leaves CDP's drag primitives, an html5 DataTransfer
 * synthesized inside the page, with nothing to deliver to and no file paths to
 * carry. The only thing left is to invoke `plugin:event|emit` from the page and
 * have the backend broadcast a `tauri://drag-drop` nobody performed, i.e. to
 * fabricate the interaction.
 *
 * It would not even buy a truthful picture. Every field on the card is derived
 * by `classifyDrop` from THIS machine's disk (a TouchDesigner install under
 * `C:\Program Files\Derivative`, `C:\Windows\py.exe`), and the dropped file has
 * to exist — for a capture that means the scratch tree, so the card would show
 * an `e2e/.output/...` path and would differ between capture machines, which is
 * the opposite of what this pipeline promises. If the shot is ever needed it has
 * to come from a real drag, driven the way `capture-tray-menu.ps1` drives the
 * tray.
 */

test('a machine with nothing to supervise yet', async () => {
  // Enrolled but unconfigured — the state the drop hint is written for.
  await useScenario('paired-empty')

  await shoot('agent-empty.png')
})

test('joining a site', async () => {
  await useScenario('unpaired')

  await page.getByTestId('app-menu-trigger').click()
  await page.getByTestId('menu-join-site').click()

  const dialog = page.getByTestId('join-site-dialog')
  await expect(dialog).toBeVisible()
  await expect(page.getByTestId('join-phrase')).toContainText(DEMO_PAIR_PHRASE)
  await page.mouse.move(POINTER_PARK.x, POINTER_PARK.y)

  await shoot('agent-join-site.png')

  // Closing cancels the helper, exactly as it does for a real pairing run.
  await page.keyboard.press('Escape')
  await expect(dialog).toBeHidden()
  await page.waitForTimeout(500)
})

/**
 * Last, because it is the only step that takes the pointer. The tray menu is a
 * native Win32 popup that CDP can't reach, so UI Automation captures it; its
 * hostname/version are the fixture's, from the same capture instance.
 *
 * Dark only. Windows draws the popup in the os theme, never the window's (tao
 * allows dark menus for the app once and leaves the choice to the os), so a
 * light project would photograph the same menu again.
 */
test('the tray right-click menu', async () => {
  test.skip(theme === 'light', 'native menu: windows draws it in the os theme, not the app theme')
  await useScenario('paired')

  const script = path.resolve('e2e/desktop-screenshots/capture-tray-menu.ps1')
  const target = path.resolve(DOCS_DIR, 'agent-right-click.png')

  const output = execFileSync(
    'powershell.exe',
    [
      '-NoProfile',
      '-NonInteractive',
      '-ExecutionPolicy',
      'Bypass',
      '-File',
      script,
      '-Out',
      target,
      // Disambiguates our tray button from a not-yet-pruned predecessor.
      '-ExpectHostname',
      CAPTURE_HOSTNAME,
    ],
    { encoding: 'utf8', windowsHide: true },
  )

  expect(output).toContain('wrote')
  expect(fs.statSync(target).size).toBeGreaterThan(1000)
})
