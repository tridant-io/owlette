/**
 * Drive the *installed* owlette desktop app (`owlette-desktop.exe`) from
 * Playwright, so the docs show the UI that actually ships.
 *
 * - Tauri 2 / WebView2: `WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS=--remote-debugging-port`
 *   exposes a plain CDP endpoint. `window.__TAURI_INTERNALS__` is non-configurable
 *   and non-writable, so `invoke` cannot be stubbed from the page — everything the
 *   app shows must come from the files it reads.
 * - Those files come from `%PROGRAMDATA%\Owlette` (`src-tauri/src/paths.rs`), so
 *   redirecting `PROGRAMDATA` to a scratch tree keeps the real `config.json`
 *   untouched and keeps demo processes out of the operator's fleet.
 * - The window title comes from `COMPUTERNAME` (`src-tauri/src/tray.rs`); a generic
 *   one keeps the build machine's hostname out of the docs.
 *
 * `%APPDATA%\app.owlette.desktop\layout.json` is the one bit of real state we
 * touch — read via the known-folder API, so not redirectable. Snapshotted and
 * restored byte-for-byte.
 *
 * The trap: the app is single-instance, so a second launch folds into the running
 * one instead of giving us a process to attach to. Kill the tray by verified pid
 * (never by image name); the service re-spawns one ~30s after teardown.
 */

import { execFileSync, spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

/** The installed agent's data root — real, read-only. */
const OWLETTE_ROOT = process.env.OWLETTE_DATA_ROOT || 'C:\\ProgramData\\Owlette'

/**
 * The binary to drive. Defaults to the INSTALLED app, which is the whole point
 * for docs captures: they have to show what ships.
 *
 * `OWLETTE_DESKTOP_EXE` overrides it with a repo build
 * (`desktop/src-tauri/target/release/owlette-desktop.exe`), so a suite can drive
 * a change before it is installed anywhere. `e2e/desktop-sync` requires the
 * override and skips without it.
 */
export function resolveDesktopExe(): string {
  return process.env.OWLETTE_DESKTOP_EXE || path.join(OWLETTE_ROOT, 'app', 'owlette-desktop.exe')
}

/**
 * Image name for pid matching. Derived from the exe under test, not hardcoded:
 * an override pointing at a differently-named build would otherwise be launched
 * and then never recognised in the process table — so it would never be waited
 * for and never killed.
 */
function desktopImageName(): string {
  return path.basename(resolveDesktopExe()).toLowerCase()
}

/** The desktop app's liveness marker; the service reads it too. */
const TRAY_PID_FILE = path.join(OWLETTE_ROOT, 'tmp', 'tray.pid')

const PYTHON_DIR = path.join(OWLETTE_ROOT, 'python')

/** Per-user window geometry. Not redirectable — snapshotted and restored. */
const LAYOUT_FILE = path.join(
  process.env.APPDATA || path.join(process.env.USERPROFILE || '', 'AppData', 'Roaming'),
  'app.owlette.desktop',
  'layout.json',
)

const SESSION_DIR = path.resolve('e2e/.output/desktop-screenshots')
const SESSION_FILE = path.join(SESSION_DIR, 'session.json')
const LAYOUT_BACKUP = path.join(SESSION_DIR, 'layout.backup.json')
/** Sentinel: no layout file existed before this run. */
const LAYOUT_ABSENT = path.join(SESSION_DIR, 'layout.absent')
/** Parks the operator's `tray.pid` while the capture instance owns it. */
const TRAY_PID_BACKUP = path.join(SESSION_DIR, 'tray.pid.backup')

const SCRATCH_PROGRAMDATA = path.join(SESSION_DIR, 'programdata')
export const SCRATCH_ROOT = path.join(SCRATCH_PROGRAMDATA, 'Owlette')

/**
 * Capture window size, logical px: wide enough that the detail form doesn't
 * wrap, short enough to fit a docs column unscaled. The sidebar width is pinned
 * alongside it because both live in the same layout file.
 */
export const CAPTURE_WINDOW = { width: 1060, height: 640 } as const
export const CAPTURE_SIDEBAR_WIDTH = 288

export const CAPTURE_HOSTNAME = 'STUDIO-01'

export const CDP_PORT = Number(process.env.OWLETTE_DESKTOP_CDP_PORT) || 9333

export interface DesktopSession {
  pid: number
  port: number
  root: string
  /** Per-run WebView2 profile, removed by {@link stopDesktop}. See below. */
  webviewUserData?: string
}

// Process control — always by verified pid.

/** Image name of a pid, or null when gone / unreadable. */
function imageNameOf(pid: number): string | null {
  try {
    const output = execFileSync('tasklist', ['/FI', `PID eq ${pid}`, '/FO', 'CSV', '/NH'], {
      encoding: 'utf8',
      windowsHide: true,
    })
    const match = output.match(/^"([^"]+)"/m)
    return match ? match[1] : null
  } catch {
    return null
  }
}

export function isDesktopPid(pid: number): boolean {
  return imageNameOf(pid)?.toLowerCase() === desktopImageName()
}

/**
 * Kill one desktop instance by pid. Verify the image name first: pids recycle,
 * and a name-wide `taskkill /IM` would take out the operator's other windows.
 */
export function killDesktopPid(pid: number): boolean {
  if (!isDesktopPid(pid)) return false
  try {
    execFileSync('taskkill', ['/PID', String(pid), '/F'], { stdio: 'ignore', windowsHide: true })
  } catch {
    return false
  }
  return true
}

/**
 * Every running `owlette-desktop.exe`, by pid. `tray.pid` is unreliable here —
 * a `/F` kill never removes it, and a Start-menu launch writes it only after
 * boot — and *any* live instance holds the single-instance lock, so the process
 * table is the only sure answer. Enumeration only; kills stay per-pid.
 */
export function listDesktopPids(): number[] {
  try {
    const output = execFileSync(
      'tasklist',
      ['/FI', `IMAGENAME eq ${desktopImageName()}`, '/FO', 'CSV', '/NH'],
      { encoding: 'utf8', windowsHide: true },
    )
    return [...output.matchAll(/^"[^"]+","(\d+)"/gm)]
      .map((match) => Number(match[1]))
      .filter((pid) => Number.isInteger(pid) && pid > 0)
  } catch {
    return []
  }
}

/**
 * Claim the real `tmp/tray.pid` for the capture instance.
 *
 * `owlette_service._is_tray_alive` spawns a tray every tick that file doesn't
 * name a live process, and our instance publishes into the *scratch* tree — so
 * without this the service races us for the single-instance lock all session and
 * leaves a dead notification-area icon behind. {@link releaseTrayPid} restores
 * the old contents verbatim.
 */
function claimTrayPid(pid: number): void {
  fs.mkdirSync(SESSION_DIR, { recursive: true })
  if (!fs.existsSync(TRAY_PID_BACKUP) && fs.existsSync(TRAY_PID_FILE)) {
    fs.copyFileSync(TRAY_PID_FILE, TRAY_PID_BACKUP)
  }
  try {
    fs.mkdirSync(path.dirname(TRAY_PID_FILE), { recursive: true })
    fs.writeFileSync(TRAY_PID_FILE, String(pid))
  } catch {
    // Not fatal — the service keeps topping the tray up and the launch retry
    // already tolerates that.
  }
}

/** Put the operator's `tray.pid` back. Safe to call when nothing was claimed. */
export function releaseTrayPid(): void {
  if (!fs.existsSync(TRAY_PID_BACKUP)) return
  try {
    fs.copyFileSync(TRAY_PID_BACKUP, TRAY_PID_FILE)
  } catch {
    // The app removes this on a clean exit and the service rewrites it within
    // 30s, so a failed restore isn't worth failing the run.
  }
  fs.rmSync(TRAY_PID_BACKUP, { force: true })
}

export async function waitForExit(pid: number, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (!isDesktopPid(pid)) return
    await delay(200)
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/**
 * Put the operator's window size aside and pin a canonical one.
 *
 * The app rewrites this file on hide and again on exit, so the restore MUST run
 * after the capture instance is gone — hence {@link restoreLayout} in teardown.
 *
 * The geometry is a parameter because the video sibling (`e2e/desktop-videos`)
 * needs a larger window than a docs column wants; the defaults are the stills
 * geometry.
 *
 * The appearance is pinned dark: with none stored the window follows the os,
 * and a capture machine in light mode would otherwise film every take light. The
 * stills' light project switches the live window itself (`set_appearance_theme`).
 */
export function snapshotLayout(
  windowSize: { width: number; height: number } = CAPTURE_WINDOW,
  sidebarWidth: number = CAPTURE_SIDEBAR_WIDTH,
): void {
  fs.mkdirSync(SESSION_DIR, { recursive: true })
  fs.rmSync(LAYOUT_BACKUP, { force: true })
  fs.rmSync(LAYOUT_ABSENT, { force: true })

  if (fs.existsSync(LAYOUT_FILE)) fs.copyFileSync(LAYOUT_FILE, LAYOUT_BACKUP)
  else fs.writeFileSync(LAYOUT_ABSENT, '')

  fs.mkdirSync(path.dirname(LAYOUT_FILE), { recursive: true })
  fs.writeFileSync(
    LAYOUT_FILE,
    `${JSON.stringify(
      {
        sidebar: { width: sidebarWidth },
        window: { width: windowSize.width, height: windowSize.height, maximized: false },
        appearance: { theme: 'dark' },
      },
      null,
      2,
    )}\n`,
  )
}

export function restoreLayout(): void {
  if (fs.existsSync(LAYOUT_BACKUP)) {
    fs.mkdirSync(path.dirname(LAYOUT_FILE), { recursive: true })
    fs.copyFileSync(LAYOUT_BACKUP, LAYOUT_FILE)
    fs.rmSync(LAYOUT_BACKUP, { force: true })
    return
  }
  if (fs.existsSync(LAYOUT_ABSENT)) {
    fs.rmSync(LAYOUT_FILE, { force: true })
    fs.rmSync(LAYOUT_ABSENT, { force: true })
  }
}

/**
 * Build the demo `%PROGRAMDATA%\Owlette` the capture instance reads.
 *
 * `python/` is a junction, not a copy: the app refuses to start the pairing
 * helper without `python/python.exe`, and the embedded runtime is ~200 MB.
 * Torn down with `rmdir`, which removes the link without following it.
 */
export function buildScratchRoot(): string {
  removeScratchRoot()

  for (const relative of ['config', 'tmp', 'agent/src', 'logs']) {
    fs.mkdirSync(path.join(SCRATCH_ROOT, ...relative.split('/')), { recursive: true })
  }

  if (fs.existsSync(PYTHON_DIR)) {
    fs.symlinkSync(PYTHON_DIR, path.join(SCRATCH_ROOT, 'python'), 'junction')
  }

  return SCRATCH_ROOT
}

/** Tear down the scratch tree, link first so the junction target survives. */
export function removeScratchRoot(): void {
  const junction = path.join(SCRATCH_ROOT, 'python')
  if (fs.existsSync(junction)) {
    // `rmdir` on a reparse point removes the link. NEVER `rm -r` here — it
    // would delete the installed interpreter.
    try {
      fs.rmdirSync(junction)
    } catch {
      fs.unlinkSync(junction)
    }
  }
  fs.rmSync(SCRATCH_PROGRAMDATA, { recursive: true, force: true })
}

/**
 * Write a seam file the app watches, the way the service does (scratch +
 * rename), so the watcher fires once and never reads half a document.
 */
export function writeSeamFile(root: string, relative: string, body: unknown): void {
  const target = path.join(root, ...relative.split('/'))
  fs.mkdirSync(path.dirname(target), { recursive: true })
  const scratch = `${target}.${process.pid}.tmp`
  fs.writeFileSync(scratch, `${JSON.stringify(body, null, 4)}\n`)
  fs.renameSync(scratch, target)
}

export function writeTextFile(root: string, relative: string, body: string): void {
  const target = path.join(root, ...relative.split('/'))
  fs.mkdirSync(path.dirname(target), { recursive: true })
  fs.writeFileSync(target, body)
}

/** Is a CDP endpoint serving a page target yet? */
export async function cdpPageReady(port: number): Promise<boolean> {
  try {
    const response = await fetch(`http://127.0.0.1:${port}/json/list`)
    if (!response.ok) return false
    const targets = (await response.json()) as { type?: string }[]
    return targets.some((target) => target.type === 'page')
  } catch {
    return false
  }
}

/**
 * Kill the tray and start a capture instance in its place.
 *
 * The service tops the tray up on a 30s cooldown and can win the single-instance
 * lock between our kill and our launch — our process then exits immediately,
 * having forwarded argv. Hence the retry: each attempt re-kills the holder.
 *
 * `args` is the launch argv — empty (the default) opens the window on a plain
 * launch, which is what the stills want. `['--pair', '--server', 'prod']` is the
 * handoff the installer performs, and is how the video sibling films the pairing
 * dialog without a second instance folding into this one.
 */
export async function startDesktop(
  root: string,
  port: number,
  args: readonly string[] = [],
): Promise<DesktopSession> {
  const exe = resolveDesktopExe()
  // One profile per run, in the OS temp dir.
  //
  // Without it WebView2 puts the user data folder beside the exe (or in the
  // per-user default for the installed app), which the OPERATOR's own running
  // instance owns. Two processes sharing one profile is how a run inherits
  // localStorage/session state it never seeded — and, worse, how the operator's
  // window loses its own state when we tear ours down. `stopDesktop` removes it.
  const webviewUserData = fs.mkdtempSync(path.join(os.tmpdir(), 'owlette-webview2-'))

  const attempts = 3
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    for (const holder of listDesktopPids()) {
      killDesktopPid(holder)
      await waitForExit(holder)
    }

    const child = spawn(exe, [...args], {
      detached: true,
      stdio: 'ignore',
      windowsHide: false,
      env: {
        ...process.env,
        PROGRAMDATA: SCRATCH_PROGRAMDATA,
        COMPUTERNAME: CAPTURE_HOSTNAME,
        WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${port}`,
        WEBVIEW2_USER_DATA_FOLDER: webviewUserData,
      },
    })
    child.unref()

    const pid = child.pid
    if (pid === undefined) throw new Error(`could not start ${exe}`)
    claimTrayPid(pid)

    const deadline = Date.now() + 30_000
    while (Date.now() < deadline) {
      if (!isDesktopPid(pid)) break // lost the single-instance race
      if (await cdpPageReady(port)) return { pid, port, root, webviewUserData }
      await delay(250)
    }

    killDesktopPid(pid)
    await waitForExit(pid)
  }

  fs.rmSync(webviewUserData, { recursive: true, force: true })
  throw new Error(
    `${exe} did not expose a debug page on port ${port} after ${attempts} attempts`,
  )
}

export async function stopDesktop(session: DesktopSession): Promise<void> {
  killDesktopPid(session.pid)
  await waitForExit(session.pid)
  if (session.webviewUserData) {
    // After the wait, never before: WebView2 holds locks on this tree for as
    // long as the browser process lives. Best-effort — a leftover in the OS
    // temp dir is not worth failing a teardown over.
    try {
      fs.rmSync(session.webviewUserData, { recursive: true, force: true })
    } catch {
      // Locked by a lingering msedgewebview2.exe child; the OS reclaims it.
    }
  }
}

/**
 * Kill any pairing stand-in left in the scratch tree. The app's own cleanup
 * never runs because we stop it with `taskkill /F`. Match on the command line,
 * not the image name, so an unrelated python the operator has open survives.
 */
export function killScratchHelpers(): void {
  let output = ''
  try {
    output = execFileSync(
      'powershell.exe',
      [
        '-NoProfile',
        '-NonInteractive',
        '-Command',
        `Get-CimInstance Win32_Process -Filter "Name='python.exe'" | ` +
          `Where-Object { $_.CommandLine -like '*${SCRATCH_ROOT.replace(/'/g, "''")}*' } | ` +
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
    if (imageNameOf(pid)?.toLowerCase() !== 'python.exe') continue
    try {
      execFileSync('taskkill', ['/PID', String(pid), '/F'], { stdio: 'ignore', windowsHide: true })
    } catch {
      // Already gone.
    }
  }
}

export function readSession(): DesktopSession {
  return JSON.parse(fs.readFileSync(SESSION_FILE, 'utf8')) as DesktopSession
}

export function writeSession(session: DesktopSession): void {
  fs.mkdirSync(SESSION_DIR, { recursive: true })
  fs.writeFileSync(SESSION_FILE, `${JSON.stringify(session, null, 2)}\n`)
}

export function clearSession(): void {
  fs.rmSync(SESSION_FILE, { force: true })
}
