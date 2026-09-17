import { beforeEach, describe, expect, it, vi } from 'vitest'

const invoke = vi.fn()
const listen = vi.fn()

vi.mock('@tauri-apps/api/core', () => ({ invoke: (...args: unknown[]) => invoke(...args) }))
vi.mock('@tauri-apps/api/event', () => ({ listen: (...args: unknown[]) => listen(...args) }))

const {
  OWLETTE_FILES,
  SERVICE_STATUS_STALE_SECONDS,
  isServiceDown,
  onOwletteFileChanged,
  onOwletteFileChangedFor,
  onSecondInstance,
  owletteDataRoot,
  readOwletteJson,
  serverFromArgs,
  serviceStart,
  serviceStatus,
  serviceStop,
  setSidebarWidth,
  sidebarWidth,
  terminatePid,
  writeOwletteJson,
} = await import('./ipc')

type ServiceStatus = Awaited<ReturnType<typeof serviceStatus>>
type FileChange = Parameters<Parameters<typeof onOwletteFileChanged>[0]>[0]

/** Capture the handler `listen` was given so tests can drive it. */
function emit<T>(payload: T) {
  const handler = listen.mock.calls.at(-1)?.[1] as (event: { payload: T }) => void
  handler({ payload })
}

beforeEach(() => {
  invoke.mockReset()
  invoke.mockResolvedValue(undefined)
  listen.mockReset()
  listen.mockResolvedValue(() => {})
})

describe('seam constants', () => {
  it('addresses the files the python service owns', () => {
    // The other half of these literals lives in src-tauri/src/paths.rs; a typo
    // on either side silently reads the wrong file.
    expect(OWLETTE_FILES).toEqual({
      config: 'config/config.json',
      appStates: 'tmp/app_states.json',
      serviceStatus: 'tmp/service_status.json',
    })
  })

  it('keeps the 120 s staleness rule the tray uses', () => {
    expect(SERVICE_STATUS_STALE_SECONDS).toBe(120)
  })
})

describe('json commands', () => {
  it('reads through read_owlette_json', async () => {
    invoke.mockResolvedValue({ processes: [{ id: 'a' }] })

    await expect(readOwletteJson(OWLETTE_FILES.config)).resolves.toEqual({
      processes: [{ id: 'a' }],
    })
    expect(invoke).toHaveBeenCalledWith('read_owlette_json', { path: 'config/config.json' })
  })

  it('writes through write_owlette_json, passing the document untouched', async () => {
    const document = { processes: [{ id: 'a', name: 'td' }], firebase: { enabled: true } }
    invoke.mockResolvedValue({ lock: 'acquired', waitedMs: 0, attempts: 1, bytes: 92 })

    const outcome = await writeOwletteJson(OWLETTE_FILES.config, document)

    expect(invoke).toHaveBeenCalledWith('write_owlette_json', {
      path: 'config/config.json',
      json: document,
    })
    expect(outcome.lock).toBe('acquired')
    expect(outcome.attempts).toBe(1)
  })

  it('surfaces a host error instead of resolving empty', async () => {
    invoke.mockRejectedValue('config/config.json contains invalid JSON: EOF while parsing')

    await expect(readOwletteJson(OWLETTE_FILES.config)).rejects.toContain('invalid JSON')
  })

  it('resolves the data root', async () => {
    invoke.mockResolvedValue('C:\\ProgramData\\Owlette')

    await expect(owletteDataRoot()).resolves.toBe('C:\\ProgramData\\Owlette')
    expect(invoke).toHaveBeenCalledWith('owlette_data_root')
  })
})

describe('service commands', () => {
  it('queries, starts and stops by command name only', async () => {
    invoke.mockResolvedValue({ method: 'noop', stateBefore: 'running' })

    await serviceStatus()
    await serviceStart(true)
    await serviceStop(false)

    expect(invoke.mock.calls.map(([command]) => command)).toEqual([
      'service_status',
      'service_start',
      'service_stop',
    ])
    // The status query takes nothing; start/stop carry the caller's decision
    // about whether a UAC prompt may be raised on its behalf.
    expect(invoke.mock.calls.map(([, args]) => args)).toEqual([
      undefined,
      { allowElevation: true },
      { allowElevation: false },
    ])
  })

  it('treats a stale status file as the service being down', () => {
    const healthy: ServiceStatus = {
      installed: true,
      running: true,
      state: 'running',
      startType: 'auto_start',
      stoppedCleanly: null,
      statusFile: { exists: true, ageSecs: 12, stale: false },
    }

    expect(isServiceDown(healthy)).toBe(false)
    // Running per the SCM but nothing has refreshed the file for two minutes.
    expect(isServiceDown({ ...healthy, statusFile: { exists: true, ageSecs: 300, stale: true } })).toBe(
      true,
    )
    expect(isServiceDown({ ...healthy, running: false, state: 'stopped' })).toBe(true)
    expect(isServiceDown({ ...healthy, installed: false })).toBe(true)
  })
})

describe('terminate_pid', () => {
  it('marshals camelCase arguments and forwards the timeout', async () => {
    invoke.mockResolvedValue({
      method: 'wm_close',
      waitedMs: 240,
      windowsClosed: 1,
      imagePath: 'C:\\apps\\player.exe',
    })

    await terminatePid(4242, 'C:\\apps\\player.exe', 2000)

    expect(invoke).toHaveBeenCalledWith('terminate_pid', {
      pid: 4242,
      expectedExe: 'C:\\apps\\player.exe',
      gracefulTimeoutMs: 2000,
    })
  })

  it('lets the host apply its own grace period when none is given', async () => {
    invoke.mockResolvedValue({ method: 'not_found', waitedMs: 0, windowsClosed: 0, imagePath: null })

    await terminatePid(4242, 'player.exe')

    expect(invoke).toHaveBeenCalledWith('terminate_pid', {
      pid: 4242,
      expectedExe: 'player.exe',
      gracefulTimeoutMs: null,
    })
  })
})

describe('layout memory', () => {
  it('reads the sidebar width with no arguments', async () => {
    invoke.mockResolvedValue(352)

    await expect(sidebarWidth()).resolves.toBe(352)
    expect(invoke).toHaveBeenCalledWith('sidebar_width')
  })

  it('writes the sidebar width and resolves to what the host kept', async () => {
    // The host clamps, so the answer is not always the request.
    invoke.mockResolvedValue(400)

    await expect(setSidebarWidth(9000)).resolves.toBe(400)
    expect(invoke).toHaveBeenCalledWith('set_sidebar_width', { width: 9000 })
  })
})

describe('event subscriptions', () => {
  const change: FileChange = {
    file: 'config',
    path: 'C:\\ProgramData\\Owlette\\config\\config.json',
    at: 1_700_000_000_000,
  }

  it('unwraps the payload of a file-changed event', async () => {
    const handler = vi.fn()
    const unlisten = await onOwletteFileChanged(handler)

    expect(listen).toHaveBeenCalledWith('owlette://file-changed', expect.any(Function))
    emit(change)
    expect(handler).toHaveBeenCalledWith(change)
    expect(typeof unlisten).toBe('function')
  })

  it('filters to a single seam file', async () => {
    const handler = vi.fn()
    await onOwletteFileChangedFor('app_states', handler)

    emit(change)
    expect(handler).not.toHaveBeenCalled()

    const appStates: FileChange = { ...change, file: 'app_states' }
    emit(appStates)
    expect(handler).toHaveBeenCalledExactlyOnceWith(appStates)
  })

  it('forwards a second instance argv', async () => {
    const handler = vi.fn()
    await onSecondInstance(handler)

    expect(listen).toHaveBeenCalledWith('owlette://second-instance', expect.any(Function))
    const payload = { argv: ['owlette.exe', '--tray'], cwd: 'C:\\ProgramData\\Owlette' }
    emit(payload)
    expect(handler).toHaveBeenCalledWith(payload)
  })
})

describe('serverFromArgs', () => {
  it('reads the two-token dev form', () => {
    expect(serverFromArgs(['--server', 'dev'])).toBe('dev')
  })

  it('reads the two-token prod form', () => {
    expect(serverFromArgs(['--server', 'prod'])).toBe('prod')
  })

  it('reads the joined form', () => {
    expect(serverFromArgs(['--server=dev'])).toBe('dev')
  })

  it('returns null when the flag is absent', () => {
    expect(serverFromArgs(['owlette-desktop.exe', '--tray'])).toBeNull()
  })

  it('returns null when the flag is the last token', () => {
    expect(serverFromArgs(['--pair', '--server'])).toBeNull()
  })

  it('returns null for a server it does not know', () => {
    expect(serverFromArgs(['--server', 'staging'])).toBeNull()
  })

  it('is case-sensitive — the installer emits lowercase', () => {
    expect(serverFromArgs(['--server', 'DEV'])).toBeNull()
  })

  it('lets the first occurrence win', () => {
    expect(serverFromArgs(['--server', 'dev', '--server', 'prod'])).toBe('dev')
  })

  it('parses a real launch argv', () => {
    const argv = ['C:\\ProgramData\\Owlette\\app\\owlette-desktop.exe', '--pair', '--server', 'dev']
    expect(serverFromArgs(argv)).toBe('dev')
  })
})
