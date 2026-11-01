/**
 * tier 1: the warning about a path the operator just entered, in the real app
 * against the real disk, through the real `path_status` command.
 *
 * every test stops at the warning. `browse` opens a native win32 file picker,
 * outside the webview, which cdp cannot drive; where the picker starts and what
 * its answer writes are covered in desktop/src/App.test.tsx.
 */

import fs from 'node:fs'
import path from 'node:path'
import type { Page } from '@playwright/test'
import { BUDGET, expect, makeProcess, readLocalProcesses, requireDesktopExe, test } from './fixtures'
import { readLocalConfig, writeLocalConfig } from './sandbox'

const PROCESS_ID = 'tier1-path-warning'
const NAME = 'tier1 path warning'
const OTHER_ID = 'tier1-path-warning-other'
const OTHER_NAME = 'tier1 elsewhere'

test.describe.configure({ mode: 'serial' })

requireDesktopExe()

/** a real folder and file in the sandbox, for the paths under test to be measured against. */
function makeShow(programData: string): { folder: string; file: string } {
  const folder = path.join(programData, 'path-warning-show')
  const file = path.join(folder, 'main.toe')
  fs.mkdirSync(folder, { recursive: true })
  fs.writeFileSync(file, '')
  return { folder, file }
}

function seedProcess(dataRoot: string): void {
  const config = readLocalConfig(dataRoot)
  const processes = Array.isArray(config.processes) ? config.processes : []
  config.processes = [
    ...processes.filter((process) => ![PROCESS_ID, OTHER_ID].includes((process as { id?: string }).id ?? '')),
    makeProcess({ id: PROCESS_ID, name: NAME }),
    makeProcess({ id: OTHER_ID, name: OTHER_NAME }),
  ]
  writeLocalConfig(dataRoot, config)
}

async function openProcess(page: Page): Promise<void> {
  const row = page.getByTestId('process-row').filter({ hasText: NAME })
  await expect(row).toBeVisible({ timeout: BUDGET.wireToDesktopMs })
  await row.click()
  await expect(page.locator('#name')).toHaveValue(NAME)
}

/** type a value and press enter, which saves it, and return the warning that follows. */
async function enter(page: Page, field: string, value: string) {
  await page.locator(field).fill(value)
  await page.locator(field).press('Enter')
  const warning = page.getByTestId('missing-path')
  await expect(warning).toBeVisible()
  return warning
}

test('a missing path warns, ok keeps it, and the nearest folder is named', async ({ sync, desktopPage }, testInfo) => {
  const { folder } = makeShow(sync.programData)
  seedProcess(sync.dataRoot)
  await openProcess(desktopPage)

  const typed = path.join(folder, 'old', 'v2', 'main.toe')
  const warning = await enter(desktopPage, '#file_path', typed)

  await expect(warning).toContainText("can't find this file")
  await expect(warning.getByTestId('missing-path-process')).toContainText(NAME)
  await expect(warning.getByTestId('missing-path-value')).toHaveText(typed)
  await expect(warning.getByTestId('missing-path-folder')).toContainText(folder)
  await expect(warning.getByRole('button', { name: 'browse' })).toBeVisible()
  await expect(warning).toBeInViewport({ ratio: 1 })
  await desktopPage.screenshot({ path: testInfo.outputPath('missing-path-warning.png') })

  await warning.getByRole('button', { name: 'ok' }).click()
  await expect(warning).toBeHidden()
  await expect(desktopPage.locator('#file_path')).toHaveValue(typed)
  expect(readLocalProcesses(sync.dataRoot).find((process) => process.id === PROCESS_ID)?.file_path).toBe(typed)
})

test('moving to another process during the check: the warning still comes, naming the first', async ({ sync, desktopPage }) => {
  const { folder } = makeShow(sync.programData)
  seedProcess(sync.dataRoot)
  await openProcess(desktopPage)

  const typed = path.join(folder, 'gone', 'main.toe')
  await desktopPage.locator('#file_path').fill(typed)
  // in one task, so the row is selected before the machine can have answered.
  await desktopPage.evaluate((other) => {
    document.querySelector<HTMLInputElement>('#file_path')?.blur()
    const rows = document.querySelectorAll<HTMLElement>('[data-testid="process-row"]')
    Array.from(rows).find((row) => row.textContent?.includes(other))?.click()
  }, OTHER_NAME)

  const warning = desktopPage.getByTestId('missing-path')
  await expect(warning).toBeVisible()
  await expect(warning.getByTestId('missing-path-process')).toContainText(NAME)
  await expect(warning.getByTestId('missing-path-value')).toHaveText(typed)
  await expect(desktopPage.locator('#name')).toHaveValue(OTHER_NAME)

  await warning.getByRole('button', { name: 'ok' }).click()
  await expect(warning).toBeHidden()
  await expect(desktopPage.locator('#file_path')).toHaveValue('')
  expect(readLocalProcesses(sync.dataRoot).find((process) => process.id === PROCESS_ID)?.file_path).toBe(typed)
})

test('a folder as the launch target and a file as the working directory say so', async ({ sync, desktopPage }) => {
  const { folder, file } = makeShow(sync.programData)
  seedProcess(sync.dataRoot)
  await openProcess(desktopPage)

  const launchTarget = await enter(desktopPage, '#exe_path', folder)
  await expect(launchTarget).toContainText('this is a folder, not a file')
  await launchTarget.getByRole('button', { name: 'ok' }).click()
  await expect(launchTarget).toBeHidden()

  const cwd = await enter(desktopPage, '#cwd', file)
  await expect(cwd).toContainText('this is a file, not a folder')
  await expect(cwd.getByTestId('missing-path-folder')).toContainText(folder)
  await cwd.getByRole('button', { name: 'ok' }).click()
  await expect(cwd).toBeHidden()
})

test('a network path says owlette will not launch from it, with no folder to offer', async ({ sync, desktopPage }) => {
  seedProcess(sync.dataRoot)
  await openProcess(desktopPage)

  const warning = await enter(desktopPage, '#file_path', '\\\\no-such-server\\share\\main.toe')

  await expect(warning).toContainText("owlette can't launch from a network path")
  await expect(warning.getByTestId('missing-path-folder')).toHaveCount(0)
})

test('a symbolic link as the launch target says owlette will not launch through it', async ({ sync, desktopPage }) => {
  const { folder, file } = makeShow(sync.programData)
  const link = path.join(folder, 'link.exe')
  try {
    fs.symlinkSync(file, link, 'file')
  } catch (error) {
    // making one takes developer mode or admin on windows.
    test.skip((error as NodeJS.ErrnoException).code === 'EPERM', 'this account cannot make symbolic links')
    throw error
  }
  seedProcess(sync.dataRoot)
  await openProcess(desktopPage)

  const warning = await enter(desktopPage, '#exe_path', link)

  await expect(warning).toContainText("owlette can't launch through a symbolic link")
  await expect(warning.getByTestId('missing-path-folder')).toContainText(folder)
})

test('a path that exists, and arguments, say nothing', async ({ sync, desktopPage }) => {
  const { folder, file } = makeShow(sync.programData)
  seedProcess(sync.dataRoot)
  await openProcess(desktopPage)

  await desktopPage.locator('#exe_path').fill(`${file}${path.sep}`)
  await desktopPage.locator('#exe_path').press('Enter')
  await expect
    .poll(() => readLocalProcesses(sync.dataRoot).find((process) => process.id === PROCESS_ID)?.exe_path)
    .toBe(`${file}${path.sep}`)
  await expect(desktopPage.getByTestId('missing-path')).toHaveCount(0)

  for (const value of [file, '--fullscreen --display 2', `${folder} --x`]) {
    await desktopPage.locator('#file_path').fill(value)
    await desktopPage.locator('#file_path').press('Enter')
    await expect
      .poll(() => readLocalProcesses(sync.dataRoot).find((process) => process.id === PROCESS_ID)?.file_path)
      .toBe(value)
    // a warning would have surfaced by the time this comes back: one probe, same channel.
    await expect(desktopPage.getByTestId('missing-path')).toHaveCount(0)
  }
})
