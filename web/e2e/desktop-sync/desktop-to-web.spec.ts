/**
 * Tier 1, upstream — an operator edits the desktop app, the fleet sees it.
 *
 * The desktop app has NO save button: every field soft-saves on blur or Enter,
 * debounced 100ms (`desktop/src/components/ProcessDetail.tsx:46`), and
 * `coerceForm` (`desktop/src/lib/owletteConfig.ts:159`) rewrites the value on the
 * way to disk — an initialise time under 10 floors to `'10'`, a negative delay
 * resets to the default. So the assertion is never the typed value; it is the
 * COERCED value, which is what makes this worth testing end to end at all.
 *
 * Three oracles, in the order the data actually moves:
 *   1. the wire — `config/{siteId}/machines/{machineId}`, written by the agent's
 *      local-config watcher.
 *   2. the status doc — `metrics.processes`, republished on the agent's metrics
 *      cadence. The dashboard renders names and timing fields from HERE, not
 *      from the config doc.
 *   3. the dashboard — `launch_mode` overlays live from the config doc, so it
 *      moves on the fast path while the text field waits for the status doc.
 *
 * the app is single-instance, so this needs its own build beside a live install,
 * and refuses to run otherwise. see README.md.
 */

import { expect as playwrightExpect } from '@playwright/test'
import { machineCard, processRow } from '../helpers/processConfig'
import {
  BUDGET,
  agentLogTail,
  expect,
  makeProcess,
  readStatusProcess,
  readWireProcesses,
  requireDesktopExe,
  test,
  readStatusProcessIds,
} from './fixtures'
import { readLocalConfig, writeLocalConfig } from './sandbox'

const PROCESS_ID = 'tier1-up'
const PROCESS_NAME = 'tier1 upstream'

test.describe.configure({ mode: 'serial' })

// The dashboard oracle needs a signed-in browser. `admin` is a site-admin on
// site-A; global-setup captured its state and pinned its dashboard context.
test.use({ storageState: 'e2e/fixtures/admin.json' })

requireDesktopExe()

test.beforeAll(async ({}, testInfo) => {
  testInfo.setTimeout(120_000)
})

/**
 * Give the app a row to select. Seeded through config.json rather than the
 * cloud: the desktop app renders from the local file, and seeding upstream would
 * make this spec depend on the downstream path it is not testing.
 */
test('seed a process the desktop app can select', async ({ sync }) => {
  const config = readLocalConfig(sync.dataRoot)
  const processes = Array.isArray(config.processes) ? config.processes : []
  config.processes = [
    ...processes.filter((p) => (p as { id?: string }).id !== PROCESS_ID),
    makeProcess({ id: PROCESS_ID, name: PROCESS_NAME, time_to_init: '30' }),
  ]
  writeLocalConfig(sync.dataRoot, config)

  await expect
    .poll(async () => (await readWireProcesses(sync.siteId, sync.machineId)).map((p) => p.id), {
      message: `seed never reached the config doc.\n${agentLogTail(sync.dataRoot)}`,
      timeout: BUDGET.desktopToWireMs,
    })
    .toContain(PROCESS_ID)
})

test('a launch-mode change in the desktop app reaches the wire and the dashboard', async ({
  sync,
  desktopPage,
  page,
}) => {
  await desktopPage.getByTestId('process-row').filter({ hasText: PROCESS_NAME }).click()
  await playwrightExpect(desktopPage.locator('#name')).toHaveValue(PROCESS_NAME)

  // The segmented control writes on click — no blur needed, no save button.
  await desktopPage.getByTestId('launch-mode-always').click()

  const startedAt = Date.now()
  await expect
    .poll(
      async () =>
        (await readWireProcesses(sync.siteId, sync.machineId)).find((p) => p.id === PROCESS_ID)
          ?.launch_mode,
      {
        message: `launch_mode never reached the config doc.\n${agentLogTail(sync.dataRoot)}`,
        timeout: BUDGET.desktopToWireMs,
      },
    )
    .toBe('always')
  console.log(`[tier1] desktop launch_mode → wire: ${Date.now() - startedAt}ms`)

  // `autolaunch` is the legacy mirror the agent still reads; a desktop write
  // that moved one without the other would leave the two disagreeing.
  const wire = (await readWireProcesses(sync.siteId, sync.machineId)).find(
    (p) => p.id === PROCESS_ID,
  )
  expect(wire?.autolaunch).toBe(true)

  // The dashboard overlays launch_mode live from the config doc (see
  // e2e/helpers/processConfig.ts), so this needs no metrics upload.
  await page.goto('/dashboard')
  const card = machineCard(page, sync.machineId)
  await playwrightExpect(card).toBeVisible({ timeout: BUDGET.wireToDesktopMs })
  await playwrightExpect(processRow(card, PROCESS_NAME).first()).toBeVisible({
    timeout: BUDGET.desktopToStatusMs,
  })
})

test('a coerced text field lands coerced on the wire and in the status doc', async ({
  sync,
  desktopPage,
}) => {
  await desktopPage.getByTestId('process-row').filter({ hasText: PROCESS_NAME }).click()
  await playwrightExpect(desktopPage.locator('#name')).toHaveValue(PROCESS_NAME)

  // 2 is below the floor of 10. The desktop is expected to store '10'.
  await desktopPage.locator('#time_to_init').fill('2')
  await desktopPage.locator('#time_to_init').blur()

  // The field itself snaps back — coerceForm reseeds the draft from disk.
  await playwrightExpect(desktopPage.locator('#time_to_init')).toHaveValue('10')

  const startedAt = Date.now()
  await expect
    .poll(
      async () =>
        (await readWireProcesses(sync.siteId, sync.machineId)).find((p) => p.id === PROCESS_ID)
          ?.time_to_init,
      {
        message: `coerced time_to_init never reached the config doc.\n${agentLogTail(sync.dataRoot)}`,
        timeout: BUDGET.desktopToWireMs,
      },
    )
    .toBe('10')
  console.log(`[tier1] desktop time_to_init → wire: ${Date.now() - startedAt}ms`)

  // The dashboard renders this field from the STATUS doc. A successful local
  // push triggers an immediate metrics upload, so this is bounded by the SLO —
  // no cadence warm-up, deliberately: waiting for the cadence here is how the
  // 20-120s row-latency field bug went undetected.
  const statusStartedAt = Date.now()
  await expect
    .poll(async () => (await readStatusProcess(sync.siteId, sync.machineId, PROCESS_ID))?.time_to_init, {
      message: `coerced time_to_init never reached metrics.processes.\n${agentLogTail(sync.dataRoot)}`,
      timeout: BUDGET.desktopToStatusMs,
    })
    .toBe('10')
  console.log(`[tier1] desktop time_to_init → status doc: ${Date.now() - statusStartedAt}ms`)
})

test('a process deleted on the machine leaves the dashboard within the SLO', async ({
  sync,
  desktopPage: _desktopPage, // keeps the app (and its gui.pid) alive for the test
  page,
}) => {
  // The field bug this pins: row membership renders from metrics.processes, and
  // before the immediate post-push heartbeat a delete stayed on the dashboard
  // for 20-120s. The budgets here are the product bar, not the cadence.
  await page.goto('/dashboard')
  const card = machineCard(page, sync.machineId)
  await playwrightExpect(processRow(card, PROCESS_NAME).first()).toBeVisible({
    timeout: BUDGET.desktopToDashboardMs,
  })

  // The desktop app's own write mechanism (a config.json rewrite) — its UI
  // codepath for edits is already exercised above.
  const config = readLocalConfig(sync.dataRoot)
  config.processes = (Array.isArray(config.processes) ? config.processes : []).filter(
    (p) => (p as { id?: string }).id !== PROCESS_ID,
  )
  writeLocalConfig(sync.dataRoot, config)

  const startedAt = Date.now()
  await expect
    .poll(async () => (await readWireProcesses(sync.siteId, sync.machineId)).map((p) => p.id), {
      message: `delete never reached the config doc.
${agentLogTail(sync.dataRoot)}`,
      timeout: BUDGET.desktopToWireMs,
    })
    .not.toContain(PROCESS_ID)
  console.log(`[tier1] delete → wire: ${Date.now() - startedAt}ms`)

  await expect
    .poll(async () => readStatusProcessIds(sync.siteId, sync.machineId), {
      message: `delete never left metrics.processes — row membership is stale.
${agentLogTail(sync.dataRoot)}`,
      timeout: BUDGET.desktopToStatusMs,
    })
    .not.toContain(PROCESS_ID)
  console.log(`[tier1] delete → status doc: ${Date.now() - startedAt}ms`)

  await playwrightExpect(processRow(card, PROCESS_NAME)).toHaveCount(0, {
    timeout: BUDGET.desktopToDashboardMs,
  })
  console.log(`[tier1] delete → dashboard row gone: ${Date.now() - startedAt}ms`)
})
