import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { RecordedIdentity } from './ipc'
import type { AppStates } from './processStatus'

const terminatePid = vi.fn()

vi.mock('@/lib/ipc', () => ({ terminatePid: (...args: unknown[]) => terminatePid(...args) }))

const { NoLiveInstanceError, stopProcess } = await import('./processControl')

const entry = { id: 'a', name: 'player', exe_path: 'C:/apps/player.exe' }

/** A table with one running generation of `entry`. */
function running(): AppStates {
  return { '4242': { id: 'a', status: 'RUNNING', timestamp: 10 } }
}

function deps(states: AppStates) {
  let current = states
  const mutateStates = vi.fn(async (transform: (states: AppStates) => AppStates) => {
    current = transform(current)
    return current
  })
  return {
    readStates: vi.fn(async () => current),
    mutateStates,
    get states() {
      return current
    },
  }
}

beforeEach(() => {
  terminatePid.mockReset()
  terminatePid.mockResolvedValue({
    method: 'wm_close',
    waitedMs: 120,
    windowsClosed: 1,
    imagePath: 'C:\\apps\\player.exe',
  })
})

const PLAYER = 'c:\\apps\\player.exe'
const NOTEPAD = 'c:\\windows\\notepad.exe'

/**
 * The host's decision in process_ctl.rs over what each pid runs now: the recorded process first
 * (windows only, hence `checksRecord`), then the name. Returns the pids it terminated.
 */
function host(
  live: Record<number, { image: string; createTime: number }>,
  { checksRecord = true } = {},
): number[] {
  const terminated: number[] = []
  terminatePid.mockImplementation(async (pid: number, image: string, recorded: RecordedIdentity | null) => {
    const actual = live[pid]
    if (checksRecord && recorded && recorded.createTime !== actual.createTime) {
      throw new Error(`pid ${pid} is no longer the process the service recorded — refusing to terminate it`)
    }
    const expected = image.toLowerCase().replace(/\//g, '\\')
    if (expected.includes('\\') ? actual.image !== expected : !actual.image.endsWith(`\\${expected}`)) {
      throw new Error(`pid ${pid} is running ${actual.image}, not ${image} — refusing to terminate it`)
    }
    terminated.push(pid)
    return { method: 'terminated', waitedMs: 5000, windowsClosed: 0, imagePath: actual.image }
  })
  return terminated
}

/** Run the terminate, reporting what the table said about pid 4242 at that moment. */
function terminateObserving(io: ReturnType<typeof deps>) {
  const observed: { status?: unknown } = {}
  terminatePid.mockImplementation(async () => {
    observed.status = io.states['4242']?.status
    return {
      method: 'wm_close',
      waitedMs: 120,
      windowsClosed: 1,
      imagePath: 'C:\\apps\\player.exe',
    }
  })
  return observed
}

describe('kill', () => {
  it('terminates the live pid and marks it so the service leaves it alone', async () => {
    const io = deps(running())

    const result = await stopProcess(entry, 'kill', io)

    expect(terminatePid).toHaveBeenCalledWith(4242, 'C:/apps/player.exe', null)
    expect(result).toMatchObject({ pid: 4242, marker: 'KILLED' })
    expect(io.states['4242']).toEqual({ id: 'a', status: 'KILLED', timestamp: 10 })
  })

  it('claims nothing until the process is actually gone', async () => {
    const io = deps(running())
    const observed = terminateObserving(io)

    await stopProcess(entry, 'kill', io)

    // KILLED asserts a fact. Writing it first would be a lie if the kill failed.
    expect(observed.status).toBe('RUNNING')
  })
})

describe('restart', () => {
  it('marks the pid RESTARTING and lets the service relaunch it', async () => {
    const io = deps(running())

    const result = await stopProcess(entry, 'restart', io)

    expect(terminatePid).toHaveBeenCalledOnce()
    expect(result.marker).toBe('RESTARTING')
    expect(io.states['4242']).toEqual({ id: 'a', status: 'RESTARTING', timestamp: 10 })
  })

  it('writes the marker before the kill, or the exit reads as a crash', async () => {
    const io = deps(running())
    const observed = terminateObserving(io)

    await stopProcess(entry, 'restart', io)

    // The service polls: an exit it sees before the marker lands costs a false
    // crash alert, a screenshot and a Cortex event.
    expect(observed.status).toBe('RESTARTING')
  })

  it('writes it again after the kill, over the RUNNING the service wrote meanwhile', async () => {
    const io = deps(running())
    terminatePid.mockImplementation(async () => {
      // What the service does on every tick for a pid it can still see: closing
      // a process takes seconds, and it is alive for all of them.
      await io.mutateStates((states) => ({
        ...states,
        '4242': { ...states['4242'], status: 'RUNNING' },
      }))
      return { method: 'terminated', waitedMs: 5000, windowsClosed: 1, imagePath: 'C:\\apps\\player.exe' }
    })

    await stopProcess(entry, 'restart', io)

    expect(io.states['4242'].status).toBe('RESTARTING')
  })

  it('takes the marker back when the kill fails', async () => {
    const io = deps(running())
    terminatePid.mockRejectedValue(new Error('could not open process 4242: access is denied'))

    await expect(stopProcess(entry, 'restart', io)).rejects.toThrow(/access is denied/)

    // Nothing exited, so nothing may claim the operator caused an exit.
    expect(io.states['4242']).toEqual({ id: 'a', status: 'RUNNING', timestamp: 10 })
  })

  it('takes the marker back when the pid had already gone', async () => {
    const io = deps(running())
    terminatePid.mockResolvedValue({
      method: 'not_found',
      waitedMs: 0,
      windowsClosed: 0,
      imagePath: null,
    })

    await expect(stopProcess(entry, 'restart', io)).rejects.toBeInstanceOf(NoLiveInstanceError)

    // A process that died a moment before the click really did crash, and the
    // service must still be free to say so.
    expect(io.states['4242'].status).toBe('RUNNING')
  })
})

describe('identity check', () => {
  it('falls back to the bare image name when the full path does not match', async () => {
    terminatePid
      .mockRejectedValueOnce(
        new Error(
          'pid 4242 is running C:\\apps\\v2\\player.exe, not C:/apps/player.exe — refusing to terminate it',
        ),
      )
      .mockResolvedValueOnce({
        method: 'terminated',
        waitedMs: 5000,
        windowsClosed: 0,
        imagePath: 'C:\\apps\\v2\\player.exe',
      })

    const result = await stopProcess(entry, 'kill', deps(running()))

    expect(terminatePid.mock.calls.map(([, image]) => image)).toEqual([
      'C:/apps/player.exe',
      'player.exe',
    ])
    expect(result.method).toBe('terminated')
  })

  it('gives up when the pid is running something else entirely', async () => {
    terminatePid.mockRejectedValue(
      new Error('pid 4242 is running C:\\windows\\notepad.exe, not player.exe — refusing to terminate it'),
    )

    await expect(stopProcess(entry, 'kill', deps(running()))).rejects.toThrow(/refusing/)
  })

  it('walks past a recycled pid to the live instance', async () => {
    // windows reuses pids, and a dead row can read RUNNING until the service's sweep
    const io = deps({
      '30968': { id: 'a', status: 'RUNNING', create_time: 1788367385.5, exe: PLAYER },
      '14128': { id: 'a', status: 'RUNNING', create_time: 1788360000.25, exe: PLAYER },
    })
    const terminated = host({
      30968: { image: NOTEPAD, createTime: 1788369000.75 },
      14128: { image: PLAYER, createTime: 1788360000.25 },
    })

    await expect(stopProcess(entry, 'restart', io)).resolves.toMatchObject({ pid: 14128 })

    expect(terminated).toEqual([14128])
    expect(io.states['30968'].status).toBe('RUNNING')
    expect(io.states['14128'].status).toBe('RESTARTING')
  })

  it.each(['kill', 'restart'] as const)(
    'on %s, walks into no other process, even another entry running the same exe',
    async (mode) => {
      // the newest row's pid now runs notepad; an older KILLED row's pid now runs
      // entry b's player.exe, started after the service recorded this one
      const table: AppStates = {
        '30968': { id: 'a', status: 'RUNNING', timestamp: 20, create_time: 1788367385.5, exe: PLAYER },
        '14128': { id: 'a', status: 'KILLED', timestamp: 10, create_time: 1788360000.25, exe: PLAYER },
      }
      const io = deps(structuredClone(table))
      const terminated = host({
        30968: { image: NOTEPAD, createTime: 1788369000.75 },
        14128: { image: PLAYER, createTime: 1788368000.5 },
      })

      await expect(stopProcess(entry, mode, io)).rejects.toThrow(/refusing to terminate/)

      expect(terminated).toEqual([])
      expect(io.states).toEqual(table)
    },
  )

  it.each(['kill', 'restart'] as const)(
    'on %s, tries no row without a record once one was refused on its record',
    async (mode) => {
      // the newest row's pid now runs entry b's player.exe. the older row is a failed
      // launch, which the service strips of its record, and its pid runs a player.exe
      // too: the name is all the host could check there, and it would pass
      const table: AppStates = {
        '30968': { id: 'a', status: 'RUNNING', timestamp: 20, create_time: 1788367385.5, exe: PLAYER },
        '14128': { id: 'a', status: 'LAUNCH_FAILED', timestamp: 10 },
      }
      const io = deps(structuredClone(table))
      const terminated = host({
        30968: { image: PLAYER, createTime: 1788369000.75 },
        14128: { image: PLAYER, createTime: 1788368000.5 },
      })

      await expect(stopProcess(entry, mode, io)).rejects.toThrow(/no longer the process the service recorded/)

      expect(terminated).toEqual([])
      expect(terminatePid.mock.calls.map(([pid]) => pid)).not.toContain(14128)
      expect(io.states).toEqual(table)
    },
  )

  it('stops at a refusal on the name, which off windows is every refusal', async () => {
    // a host that does not check the record (macos, linux) refuses on the name alone,
    // which cannot tell a recycled pid from an entry whose exe path has changed
    const io = deps({
      '30968': { id: 'a', status: 'RUNNING', timestamp: 20, create_time: 1788367385.5, exe: PLAYER },
      '14128': { id: 'a', status: 'KILLED', timestamp: 10, create_time: 1788360000.25, exe: PLAYER },
    })
    const terminated = host(
      {
        30968: { image: NOTEPAD, createTime: 1788369000.75 },
        14128: { image: PLAYER, createTime: 1788368000.5 },
      },
      { checksRecord: false },
    )

    await expect(stopProcess(entry, 'kill', io)).rejects.toThrow(/is running c:\\windows\\notepad\.exe/)

    expect(terminated).toEqual([])
    expect(terminatePid.mock.calls.map(([pid]) => pid)).not.toContain(14128)
  })

  it('does not retry a failure that is not an identity mismatch', async () => {
    terminatePid.mockRejectedValue(new Error('could not open process 4242: access is denied'))

    await expect(stopProcess(entry, 'kill', deps(running()))).rejects.toThrow(/access is denied/)
    expect(terminatePid).toHaveBeenCalledOnce()
  })

  it('sends a script entry as the cmd.exe it really runs as', async () => {
    await stopProcess({ ...entry, exe_path: 'C:/apps/start.bat' }, 'kill', deps(running()))

    expect(terminatePid).toHaveBeenCalledWith(4242, 'cmd.exe', null)
  })

  it('hands the host what the service recorded about the pid', async () => {
    // the name alone passes for any cmd.exe, or for another entry running the same exe
    const io = deps({
      '4242': {
        id: 'a',
        status: 'RUNNING',
        timestamp: 10,
        create_time: 1788367385.5616167,
        exe: 'c:\\apps\\player.exe',
      },
    })

    await stopProcess(entry, 'kill', io)

    expect(terminatePid).toHaveBeenCalledWith(4242, 'C:/apps/player.exe', {
      createTime: 1788367385.5616167,
      exe: 'c:\\apps\\player.exe',
    })
  })

  it('keeps the name check alone for a row with no recorded creation time', async () => {
    await stopProcess(entry, 'kill', deps(running()))

    expect(terminatePid).toHaveBeenCalledWith(4242, 'C:/apps/player.exe', null)
  })
})

describe('nothing to stop', () => {
  it('reports no live instance when the entry owns no pid', async () => {
    await expect(stopProcess(entry, 'kill', deps({}))).rejects.toBeInstanceOf(NoLiveInstanceError)
    expect(terminatePid).not.toHaveBeenCalled()
  })

  it('reports no live instance when the pid has already gone', async () => {
    terminatePid.mockResolvedValue({
      method: 'not_found',
      waitedMs: 0,
      windowsClosed: 0,
      imagePath: null,
    })
    const io = deps(running())

    await expect(stopProcess(entry, 'kill', io)).rejects.toBeInstanceOf(NoLiveInstanceError)
    // Nothing was killed, so nothing may claim it was.
    expect(io.mutateStates).not.toHaveBeenCalled()
  })

  it('walks past a generation that has already gone to one that is alive', async () => {
    // Two RUNNING rows, no timestamps: the first pick is a dead generation the
    // service has not swept yet. Seen on a live agent — restart on a process
    // labelled running came back "no running instance".
    const io = deps({
      '30968': { id: 'a', status: 'RUNNING' },
      '14128': { id: 'a', status: 'RUNNING' },
    })
    terminatePid.mockImplementation(async (pid: number) =>
      pid === 30968
        ? { method: 'not_found', waitedMs: 0, windowsClosed: 0, imagePath: null }
        : { method: 'wm_close', waitedMs: 120, windowsClosed: 1, imagePath: 'C:\\apps\\player.exe' },
    )

    await expect(stopProcess(entry, 'restart', io)).resolves.toMatchObject({ pid: 14128 })

    expect(io.states['30968'].status).toBe('RUNNING')
    expect(io.states['14128'].status).toBe('RESTARTING')
  })

  it('refuses to guess when the entry has no executable', async () => {
    await expect(stopProcess({ id: 'a', name: 'x' }, 'kill', deps(running()))).rejects.toThrow(
      /no exe path/,
    )
  })
})
