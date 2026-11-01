/**
 * Launch the desktop app against the SANDBOX and attach to its WebView2.
 *
 * Playwright's documented route into a WebView2 host is a CDP endpoint opened by
 * `WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS=--remote-debugging-port`, then
 * `chromium.connectOverCDP`. `window.__TAURI_INTERNALS__` is non-configurable, so
 * `invoke` cannot be stubbed from the page: everything the window shows comes
 * from files it reads under `%PROGRAMDATA%\Owlette` (`src-tauri/src/paths.rs`),
 * which is exactly why pointing PROGRAMDATA at the sandbox is enough to make it
 * a participant in this suite rather than a spectator.
 *
 * Process control is shared with `e2e/desktop-screenshots/harness.ts` rather than
 * copied — same binary, same single-instance trap, same kill-by-verified-pid
 * rule. What is NOT shared is the data root: the screenshots harness publishes
 * into its own capture scratch tree, and this suite must publish into the one the
 * agent is watching.
 *
 * the app is single-instance, so a running copy has to go before a launch. this
 * only ever stops a copy it started: any other process with the exe's image name
 * stops the run instead, because that may be the operator's own window. the readme
 * has the recipe for running beside one.
 */

import { chromium, type Browser, type Page } from '@playwright/test'
import { execFileSync, spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  cdpPageReady,
  isDesktopPid,
  killDesktopPid,
  listDesktopPids,
  resolveDesktopExe,
  waitForExit,
} from '../desktop-screenshots/harness'
import { OUTPUT_DIR, agentEnv, assertSandboxSafe, removeSandbox } from './sandbox'

const DESKTOP_SESSION_FILE = path.join(OUTPUT_DIR, 'desktop-session.json')

export const CDP_PORT = Number(process.env.OWLETTE_DESKTOP_SYNC_CDP_PORT) || 9334

interface DesktopProcess {
  pid: number
  port: number
  webviewUserData: string
}

/** the copy this suite last started, the only one it may stop. */
function readDesktopSession(): DesktopProcess | null {
  try {
    return JSON.parse(fs.readFileSync(DESKTOP_SESSION_FILE, 'utf8')) as DesktopProcess
  } catch {
    return null
  }
}

/** True when a repo-built (or installed) exe was named for this run. */
export function desktopExeConfigured(): boolean {
  return Boolean(process.env.OWLETTE_DESKTOP_EXE)
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/**
 * start the app on the sandbox and wait for its debug page. no retry: a launch
 * that exits at once has folded into another instance holding the lock, which
 * another try would only raise again.
 */
export async function startDesktopOnSandbox(programData: string): Promise<DesktopProcess> {
  assertSandboxSafe(programData)
  const exe = resolveDesktopExe()
  if (!fs.existsSync(exe)) {
    throw new Error(
      `OWLETTE_DESKTOP_EXE points at a file that does not exist: ${exe}\n` +
        'Build it first: cd desktop && npx tauri build --no-bundle',
    )
  }

  const previous = readDesktopSession()
  const foreign = listDesktopPids().filter((pid) => pid !== previous?.pid)
  if (foreign.length > 0) {
    throw new Error(
      `desktop-sync did not start the running ${path.basename(exe)} (pid ${foreign.join(', ')}) ` +
        'and will not kill it: it may be the operator\'s app. Name a build with its own ' +
        'identifier and file name, or close it yourself. See e2e/desktop-sync/README.md.',
    )
  }
  if (previous) {
    killDesktopPid(previous.pid)
    await waitForExit(previous.pid)
  }

  const webviewUserData = fs.mkdtempSync(path.join(os.tmpdir(), 'owlette-sync-webview2-'))
  const child = spawn(exe, [], {
    detached: true,
    stdio: 'ignore',
    windowsHide: false,
    env: agentEnv(programData, {
      WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${CDP_PORT}`,
      WEBVIEW2_USER_DATA_FOLDER: webviewUserData,
    }),
  })
  child.unref()

  const pid = child.pid
  if (pid === undefined) throw new Error(`could not start ${exe}`)

  const deadline = Date.now() + 30_000
  while (Date.now() < deadline && isDesktopPid(pid)) {
    if (await cdpPageReady(CDP_PORT)) {
      const session = { pid, port: CDP_PORT, webviewUserData }
      fs.mkdirSync(OUTPUT_DIR, { recursive: true })
      fs.writeFileSync(DESKTOP_SESSION_FILE, `${JSON.stringify(session, null, 2)}\n`)
      return session
    }
    await delay(250)
  }

  killDesktopPid(pid)
  await waitForExit(pid)
  removeSandbox(webviewUserData)
  throw new Error(
    `${exe} exposed no debug page on port ${CDP_PORT}. If it exited at once, an instance with ` +
      'the same identifier holds the single-instance lock: see e2e/desktop-sync/README.md.',
  )
}

/** Attach to the running app's webview. Returns both so the caller can detach. */
export async function connectDesktopPage(
  port: number,
): Promise<{ browser: Browser; page: Page }> {
  const browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`)

  // The devtools target exists before WebView2 finishes navigating, so a fresh
  // launch can legitimately show only about:blank for a while. Poll instead of
  // failing on the first look.
  const deadline = Date.now() + 15_000
  let seen: string[] = []
  while (Date.now() < deadline) {
    const pages = browser.contexts().flatMap((context) => context.pages())
    const page = pages.find((candidate) => candidate.url().includes('tauri.localhost'))
    if (page) return { browser, page }
    seen = pages.map((p) => p.url())
    await new Promise((resolve) => setTimeout(resolve, 250))
  }
  await browser.close()
  throw new Error(`no owlette webview on the debug port (saw: ${seen.join(', ') || 'nothing'})`)
}

/** Stop whatever `startDesktopOnSandbox` left running. Safe when nothing did. */
export async function stopDesktopSession(): Promise<void> {
  const session = readDesktopSession()
  if (!session) return

  killDesktopPid(session.pid)
  await waitForExit(session.pid)

  // Only after the wait — WebView2 holds locks for as long as its browser
  // process lives.
  try {
    removeSandbox(session.webviewUserData)
  } catch (err) {
    // a lingering msedgewebview2.exe child is the usual cause, and the os reclaims the temp dir.
    console.warn(`[desktop-sync] webview profile removal failed (continuing): ${String(err)}`)
  }
  fs.rmSync(DESKTOP_SESSION_FILE, { force: true })
}

/**
 * Kill any helper the app spawned into the sandbox. Matched on command line, not
 * image name, so the operator's own python processes survive.
 */
export function killSandboxHelpers(programData: string): void {
  assertSandboxSafe(programData)
  let output = ''
  try {
    output = execFileSync(
      'powershell.exe',
      [
        '-NoProfile',
        '-NonInteractive',
        '-Command',
        `Get-CimInstance Win32_Process -Filter "Name='python.exe'" | ` +
          `Where-Object { $_.CommandLine -like '*${programData.replace(/'/g, "''")}*' } | ` +
          'ForEach-Object { $_.ProcessId }',
      ],
      { encoding: 'utf8', windowsHide: true },
    )
  } catch {
    return
  }

  for (const line of output.split(/\r?\n/)) {
    const pid = Number(line.trim())
    if (!Number.isInteger(pid) || pid <= 0) continue
    try {
      execFileSync('taskkill', ['/PID', String(pid), '/F'], {
        stdio: 'ignore',
        windowsHide: true,
      })
    } catch {
      // Already gone.
    }
  }
}
