/**
 * Tier 1, downstream — an operator edits the dashboard, the machine follows.
 *
 * This is the half `e2e/specs/dashboard/process-config-roundtrip.spec.ts` cannot
 * reach. That file stops at the config document, because nothing in the main
 * suite plays the agent. Here a real agent is polling it, so the chain runs all
 * the way to the window on the operator's desk:
 *
 *   dialog save → PATCH → `config/{siteId}/machines/{machineId}`
 *     → agent config listener (adaptive 2–10s, `firebase_client._config_listener_loop`)
 *     → `handle_config_update` writes config.json
 *     → the desktop app's file watcher (120ms) + React's 80ms debounce
 *     → the field on screen
 *
 * Hence the 30s budget: it is the sum of real intervals, not a guess, and the
 * 10s idle ceiling on the agent's listener is the dominant term.
 *
 * The dashboard renders process rows from the STATUS doc, which only the agent
 * writes — so the row is located by its SEEDED name throughout, exactly as the
 * web-only roundtrip spec does. What changes on screen is the DESKTOP app.
 *
 * the app is single-instance, so this needs its own build beside a live install,
 * and refuses to run otherwise. see README.md.
 */

import { expect as playwrightExpect, type Locator, type Page } from '@playwright/test'
import { machineCard, processEditButton, processRow } from '../helpers/processConfig'
import {
  BUDGET,
  agentLogTail,
  expect,
  makeProcess,
  readLocalProcesses,
  readWireProcesses,
  requireDesktopExe,
  test,
  readStatusProcessIds,
} from './fixtures'
import { readLocalConfig, writeLocalConfig } from './sandbox'

const PROCESS_ID = 'tier1-down'
const SEEDED_NAME = 'tier1 downstream'
const RENAMED = 'tier1 renamed by dashboard'

test.describe.configure({ mode: 'serial' })

test.use({ storageState: 'e2e/fixtures/admin.json' })

requireDesktopExe()

test.beforeAll(async ({}, testInfo) => {
  testInfo.setTimeout(120_000)
})

/** Open the dashboard's edit dialog for a row, located by its seeded name. */
async function openEditDialog(page: Page, machineId: string, name: string): Promise<Locator> {
  const card = machineCard(page, machineId)
  await playwrightExpect(card).toBeVisible({ timeout: BUDGET.wireToDesktopMs })
  await processEditButton(processRow(card, name).first()).click()

  const dialog = page.getByRole('dialog', { name: /^edit process$/i })
  await playwrightExpect(dialog).toBeVisible()
  await playwrightExpect(dialog.locator('#edit-name')).toHaveValue(name)
  return dialog
}

/**
 * Seed through config.json and let the agent publish it BOTH ways: up to the
 * config doc (so the dialog has something to PATCH) and into the status doc (so
 * the dashboard has a row to render). Both are the agent's own work — seeding
 * the documents directly would skip the very machinery under test.
 */
test('seed a process the dashboard can edit', async ({ sync, desktopPage }) => {
  // Touching desktopPage here starts the app for the whole (serial) file, which
  // also puts `tmp/gui.pid` in place and moves metrics to the 5s cadence.
  await playwrightExpect(desktopPage.getByTestId('process-list')).toBeVisible()

  const config = readLocalConfig(sync.dataRoot)
  const processes = Array.isArray(config.processes) ? config.processes : []
  config.processes = [
    ...processes.filter((p) => (p as { id?: string }).id !== PROCESS_ID),
    makeProcess({ id: PROCESS_ID, name: SEEDED_NAME, time_to_init: '20' }),
  ]
  writeLocalConfig(sync.dataRoot, config)

  await expect
    .poll(async () => (await readWireProcesses(sync.siteId, sync.machineId)).map((p) => p.id), {
      message: `seed never reached the config doc.\n${agentLogTail(sync.dataRoot)}`,
      timeout: BUDGET.desktopToWireMs,
    })
    .toContain(PROCESS_ID)

  // The dashboard row comes from the status doc; the push's immediate metrics
  // upload must publish it within the SLO — no cadence warm-up.
  await expect
    .poll(async () => readStatusProcessIds(sync.siteId, sync.machineId), {
      message: `seed never reached metrics.processes.
${agentLogTail(sync.dataRoot)}`,
      timeout: BUDGET.desktopToStatusMs,
    })
    .toContain(PROCESS_ID)
})

test('a dashboard edit reaches the desktop app', async ({ sync, desktopPage, page }) => {
  await page.goto('/dashboard')
  const dialog = await openEditDialog(page, sync.machineId, SEEDED_NAME)

  await dialog.locator('#edit-name').fill(RENAMED)
  await dialog.locator('#edit-time-init').fill('45')
  await dialog.getByRole('button', { name: 'always on', exact: true }).click()

  await dialog.getByRole('button', { name: /^save changes$/i }).click()
  // The dialog closes only once the PATCH resolves, so the wire write has landed.
  await playwrightExpect(dialog).toBeHidden()

  const startedAt = Date.now()

  // Sanity: the write really is on the wire before we blame the agent for
  // anything that follows.
  const wire = (await readWireProcesses(sync.siteId, sync.machineId)).find(
    (p) => p.id === PROCESS_ID,
  )
  expect(wire?.name).toBe(RENAMED)
  expect(wire?.time_to_init).toBe('45')
  expect(wire?.launch_mode).toBe('always')

  // Link 1: the agent applies it to config.json.
  await expect
    .poll(() => readLocalProcesses(sync.dataRoot).find((p) => p.id === PROCESS_ID)?.name, {
      message: `dashboard edit never reached config.json.\n${agentLogTail(sync.dataRoot)}`,
      timeout: BUDGET.wireToLocalMs,
    })
    .toBe(RENAMED)
  console.log(`[tier1] dashboard → config.json: ${Date.now() - startedAt}ms`)

  // Link 2: the app re-reads the file and repaints. Asserted on the LIST first
  // — the detail pane only updates for the selected row.
  await playwrightExpect(
    desktopPage.getByTestId('process-row').filter({ hasText: RENAMED }),
  ).toBeVisible({ timeout: BUDGET.wireToDesktopMs })

  await desktopPage.getByTestId('process-row').filter({ hasText: RENAMED }).click()
  await playwrightExpect(desktopPage.locator('#name')).toHaveValue(RENAMED)
  await playwrightExpect(desktopPage.locator('#time_to_init')).toHaveValue('45')
  console.log(`[tier1] dashboard → desktop UI: ${Date.now() - startedAt}ms`)

  // The local-only `firebase` block must survive the pull, or the agent unpairs
  // itself the moment the dashboard is used (`config_sync.LOCAL_ONLY_KEYS`).
  const local = readLocalConfig(sync.dataRoot)
  expect((local.firebase as Record<string, unknown> | undefined)?.site_id).toBe(sync.siteId)
})
