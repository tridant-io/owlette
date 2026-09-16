/**
 * The scratch `%PROGRAMDATA%` the agent-under-test and the desktop app both read.
 *
 * `agent/src/shared_utils.get_data_path` and `desktop/src-tauri/src/paths.rs`
 * both resolve their data root from the PROGRAMDATA environment variable on
 * every call, which is the seam this suite drives. Redirecting it to a temp tree
 * is what keeps a test run away from `C:\ProgramData\Owlette` — the operator's
 * live install, whose config.json drives real machines.
 *
 * That redirect is load-bearing enough to be checked twice: {@link assertSandboxSafe}
 * refuses anything that is not under the OS temp dir, and
 * {@link probeAgentEnv} makes the agent's OWN path code report back where it
 * would write before a single agent process is started. The second check exists
 * because the first cannot see a variable that failed to propagate: Windows
 * environment names are case-insensitive but many spawn paths are not, and a
 * `PROGRAMDATA=` that loses to an inherited `ProgramData=` fails silently and
 * points the agent straight at the live install.
 */

import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { EMULATOR_PROJECT_ID, E2E_BASE_URL, FIRESTORE_EMULATOR_URL } from '../helpers/emulator'

/** The site the agent pairs to. Seeded by `helpers/seed.ts` as part of the baseline. */
export const SITE_ID = 'site-A'

/** Repo root, from `web/` (Playwright's cwd for every config here). */
export const REPO_ROOT = path.resolve(process.cwd(), '..')
export const AGENT_SRC = path.join(REPO_ROOT, 'agent', 'src')

/** Interpreter for the agent and the helper scripts. Must have the agent's deps. */
export const PYTHON = process.env.OWLETTE_PYTHON || 'python'

export const OUTPUT_DIR = path.resolve('e2e/.output/desktop-sync')
export const SESSION_FILE = path.join(OUTPUT_DIR, 'session.json')

/** Emulator host in the `host:port` form the agent's FIRESTORE_EMULATOR_HOST wants. */
export const FIRESTORE_EMULATOR_HOST_PORT = FIRESTORE_EMULATOR_URL.replace(/^https?:\/\//, '')

export interface SyncSession {
  /** The scratch PROGRAMDATA (the tree that CONTAINS `Owlette`). */
  programData: string
  /** `<programData>/Owlette` — what `get_data_path()` returns. */
  dataRoot: string
  siteId: string
  /** Exactly what the agent will use as its Firestore machine id. */
  machineId: string
  agentPid: number
  agentLog: string
  startedAt: number
}

// Sandbox construction

/**
 * Refuse to run against anything that could be a real install.
 *
 * Equality with `C:\ProgramData` is the headline case, but the containment check
 * is the one that actually holds the line: a sandbox must live under the OS temp
 * dir, so no accident — an unset variable, a half-built path, a `.` — can ever
 * resolve somewhere with real data in it.
 */
export function assertSandboxSafe(programData: string): void {
  const resolved = path.resolve(programData)
  const lower = resolved.toLowerCase()

  const liveRoots = [
    'c:\\programdata',
    path.resolve(`${process.env.SystemDrive || 'C:'}\\ProgramData`).toLowerCase(),
  ]
  if (liveRoots.includes(lower)) {
    throw new Error(
      `desktop-sync refuses to run: sandbox PROGRAMDATA resolved to the LIVE root (${resolved}).`,
    )
  }

  const tmp = path.resolve(os.tmpdir()).toLowerCase()
  if (lower !== tmp && !lower.startsWith(tmp + path.sep)) {
    throw new Error(
      `desktop-sync refuses to run: sandbox PROGRAMDATA (${resolved}) is not under the OS temp dir (${os.tmpdir()}).`,
    )
  }
}

/** A fresh scratch PROGRAMDATA, guaranteed unique so two runs never share one. */
export function createSandbox(): string {
  fs.mkdirSync(OUTPUT_DIR, { recursive: true })
  const programData = fs.mkdtempSync(path.join(os.tmpdir(), 'owlette-desktop-sync-'))
  assertSandboxSafe(programData)
  return programData
}

export function dataRootOf(programData: string): string {
  return path.join(programData, 'Owlette')
}

/**
 * The child environment for EVERY agent-side process this suite starts.
 *
 * Case-variant keys are stripped before PROGRAMDATA is set. Node's spawn happens
 * to de-duplicate the Windows environment block case-insensitively, but relying
 * on that is how the redirect silently fails somewhere else later — and the cost
 * of that failure is an agent writing to the operator's live install.
 *
 * OWLETTE_DATA_ROOT is stripped too: it outranks PROGRAMDATA in the agent's path
 * resolution (agent/src/osadapter/__init__.py), so an inherited one would point
 * the agent somewhere other than this sandbox.
 */
export function agentEnv(programData: string, extra: Record<string, string> = {}) {
  assertSandboxSafe(programData)
  const inherited = Object.fromEntries(
    Object.entries(process.env).filter(
      ([key]) =>
        !/^(programdata|owlette_data_root|firestore_emulator_host|owlette_disable_watchdog_restart)$/i.test(
          key,
        ),
    ),
  )
  return {
    ...inherited,
    PROGRAMDATA: programData,
    // The one product change this suite needs: agent/src/firestore_rest_client.py
    // honours this and talks to the emulator over the same /v1 surface.
    FIRESTORE_EMULATOR_HOST: FIRESTORE_EMULATOR_HOST_PORT,
    // ConnectionManager's emergency brake (agent/src/connection_manager.py:51):
    // no self-restart storms out of a test sandbox.
    OWLETTE_DISABLE_WATCHDOG_RESTART: '1',
    ...extra,
  } as NodeJS.ProcessEnv
}

// The agent's own view of where it will write

export interface AgentEnvProbe {
  dataRoot: string
  configPath: string
  /** `shared_utils.get_hostname()` — the value that becomes the Firestore machine id. */
  hostname: string
}

/**
 * Ask the agent's real path code where it would write, in a child spawned
 * exactly the way the agent will be. This is the check that would have caught a
 * lost PROGRAMDATA before anything touched the live tree.
 */
export function probeAgentEnv(programData: string): AgentEnvProbe {
  const script = [
    'import json, sys',
    'sys.path.insert(0, ".")',
    'import shared_utils',
    'print(json.dumps({',
    '  "dataRoot": shared_utils.get_data_path(),',
    '  "configPath": shared_utils.CONFIG_PATH,',
    '  "hostname": shared_utils.get_hostname(),',
    '}))',
  ].join('\n')

  const raw = execFileSync(PYTHON, ['-c', script], {
    cwd: AGENT_SRC,
    env: agentEnv(programData),
    encoding: 'utf8',
    windowsHide: true,
  })

  const probe = JSON.parse(raw.trim().split(/\r?\n/).pop() as string) as AgentEnvProbe
  const expected = path.resolve(dataRootOf(programData)).toLowerCase()
  if (path.resolve(probe.dataRoot).toLowerCase() !== expected) {
    throw new Error(
      'desktop-sync refuses to run: the agent resolved a DIFFERENT data root than the sandbox.\n' +
        `  sandbox expects: ${dataRootOf(programData)}\n` +
        `  agent resolved:  ${probe.dataRoot}\n` +
        'PROGRAMDATA did not reach the child, or an OWLETTE_DATA_ROOT override outranked it. ' +
        'Do NOT retry until the spawn env is fixed — ' +
        'the next attempt would drive the live install.',
    )
  }
  return probe
}

// Seeds

/**
 * The config the agent boots from.
 *
 * No `rebootSchedule`: the main loop would evaluate one and could schedule a
 * real reboot of the test machine. `processes: []` so nothing is ever launched.
 */
export function baseConfig(siteId = SITE_ID): Record<string, unknown> {
  return {
    version: '1.6.0',
    environment: 'development',
    processes: [],
    logging: {
      level: 'INFO',
      max_age_days: 90,
      firebase_shipping: { enabled: false, ship_errors_only: true },
    },
    sentry: { enabled: false, dsn: '' },
    firebase: {
      enabled: true,
      site_id: siteId,
      project_id: EMULATOR_PROJECT_ID,
      api_base: `${E2E_BASE_URL}/api`,
    },
  }
}

/**
 * Lay out the sandbox tree.
 *
 * The `.migrations` flag files are not optional. Without them the service runs
 * its one-shot boot migrations, and `_sweep_legacy_launch_tasks` shells out to
 * `schtasks` against the REAL machine's task store — the sandbox does not
 * contain scheduled tasks, so there is nothing there to isolate it.
 * (`agent/src/owlette_service.py:6704`, `:6815`.)
 */
export function seedSandbox(programData: string, siteId = SITE_ID): string {
  assertSandboxSafe(programData)
  const root = dataRootOf(programData)

  for (const dir of ['config', 'tmp', 'logs', 'cache', '.migrations']) {
    fs.mkdirSync(path.join(root, dir), { recursive: true })
  }
  for (const flag of ['legacy-launch-tasks-swept', 'content-store-moved']) {
    fs.writeFileSync(path.join(root, '.migrations', flag), '')
  }

  writeLocalConfig(root, baseConfig(siteId))
  return root
}

export function configPath(dataRoot: string): string {
  return path.join(dataRoot, 'config', 'config.json')
}

export function readLocalConfig(dataRoot: string): Record<string, unknown> {
  return JSON.parse(fs.readFileSync(configPath(dataRoot), 'utf8')) as Record<string, unknown>
}

/**
 * Write config.json the way every real writer does — scratch file then rename —
 * so the agent's 0.5s mtime poll (`LOCAL_CONFIG_POLL_INTERVAL`) never sees a
 * half-written document. This is what stands in for the desktop app in the
 * headless tier.
 */
export function writeLocalConfig(dataRoot: string, config: unknown): void {
  const target = configPath(dataRoot)
  fs.mkdirSync(path.dirname(target), { recursive: true })
  const scratch = `${target}.${process.pid}.tmp`
  fs.writeFileSync(scratch, `${JSON.stringify(config, null, 4)}\n`)
  fs.renameSync(scratch, target)
}

// Session handoff (global-setup → specs → global-teardown)

export function writeSession(session: SyncSession): void {
  fs.mkdirSync(OUTPUT_DIR, { recursive: true })
  fs.writeFileSync(SESSION_FILE, `${JSON.stringify(session, null, 2)}\n`)
}

export function readSession(): SyncSession {
  return JSON.parse(fs.readFileSync(SESSION_FILE, 'utf8')) as SyncSession
}

export function clearSession(): void {
  fs.rmSync(SESSION_FILE, { force: true })
}

/** Remove the scratch tree. Guarded — this is a recursive delete. */
export function removeSandbox(programData: string): void {
  assertSandboxSafe(programData)
  fs.rmSync(programData, { recursive: true, force: true })
}
