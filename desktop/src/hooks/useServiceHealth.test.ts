import { act, renderHook, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ServiceCommandOutcome, ServiceState, ServiceStatus } from '@/lib/ipc'

const serviceStatus = vi.fn<() => Promise<ServiceStatus>>()
const serviceStart = vi.fn<(allowElevation: boolean) => Promise<ServiceCommandOutcome>>()
const readOwletteJson = vi.fn<() => Promise<unknown>>()
const launchArgs = vi.fn<() => Promise<string[]>>()
const fileWatch = vi.fn()

vi.mock('@/lib/ipc', async () => {
  const actual = await vi.importActual<typeof import('@/lib/ipc')>('@/lib/ipc')
  return {
    ...actual,
    serviceStatus: () => serviceStatus(),
    serviceStart: (allowElevation: boolean) => serviceStart(allowElevation),
    readOwletteJson: () => readOwletteJson(),
    launchArgs: () => launchArgs(),
  }
})

vi.mock('@/hooks/useOwletteFileWatch', () => ({
  useOwletteFileWatch: (file: string, handler: () => void) => fileWatch(file, handler),
}))

const { useServiceHealth } = await import('./useServiceHealth')

/** A status document in the shape the host returns. `fresh` is the status file. */
function status(state: ServiceState, fresh = true): ServiceStatus {
  return {
    installed: true,
    running: state === 'running',
    state,
    startType: 'auto_start',
    stoppedCleanly: state === 'stopped' ? true : null,
    statusFile: { exists: fresh, ageSecs: fresh ? 0 : 3_600, stale: !fresh },
  }
}

const SCM: ServiceCommandOutcome = { method: 'scm', stateBefore: 'stopped' }

beforeEach(() => {
  vi.clearAllMocks()
  serviceStart.mockResolvedValue(SCM)
  readOwletteJson.mockResolvedValue({})
  launchArgs.mockResolvedValue(['owlette-desktop.exe'])
})

/**
 * Drive the hook through a sequence of SCM states, one settled render each.
 *
 * `serviceStatus` is re-read by a 15 s interval and by the file watcher, so a
 * test only has to change what the next query answers and let a refresh happen.
 */
async function walk(states: ServiceStatus[]) {
  serviceStatus.mockResolvedValue(states[0])
  const view = renderHook(() => useServiceHealth())
  await waitFor(() => expect(view.result.current.status).toEqual(states[0]))

  for (const next of states.slice(1)) {
    serviceStatus.mockResolvedValue(next)
    await act(async () => {
      view.result.current.refresh()
    })
    await waitFor(() => expect(view.result.current.status).toEqual(next))
  }
  return view
}

describe('auto-start', () => {
  it('starts an installed-but-stopped service when the operator opened the app', async () => {
    await walk([status('stopped')])

    await waitFor(() => expect(serviceStart).toHaveBeenCalledTimes(1))
    expect(serviceStart).toHaveBeenCalledWith(true)
  })

  /**
   * THE REGRESSION. A session that opens with a healthy service must never
   * auto-start it later — the only way that state arrives is the operator
   * stopping it, which before this fix meant quitting from the tray produced a
   * second UAC prompt and, once starts went silent, resurrected the service
   * they had just asked to stop.
   */
  it('never starts the service after a session that began with it running', async () => {
    await walk([status('running'), status('stop_pending'), status('stopped', false)])

    expect(serviceStart).not.toHaveBeenCalled()
  })

  it('does not act while the service is still coming up or going down', async () => {
    await walk([status('start_pending'), status('stop_pending')])

    expect(serviceStart).not.toHaveBeenCalled()
  })

  /**
   * The other half of the same guard: arming on a transitional state would make
   * the hook skip the start entirely. Opening the app during the seconds a stop
   * takes to drain is exactly the reported workflow.
   */
  it('still starts once a stop that was in flight at launch has finished', async () => {
    await walk([status('stop_pending'), status('stopped')])

    await waitFor(() => expect(serviceStart).toHaveBeenCalledTimes(1))
  })

  it('only ever starts once', async () => {
    await walk([status('stopped'), status('stopped'), status('stopped')])

    await waitFor(() => expect(serviceStart).toHaveBeenCalledTimes(1))
  })

  it.each([['--tray'], ['--restart-prompt'], ['--pair']])(
    'refuses to raise a prompt when the service launched us with %s',
    async (flag) => {
      launchArgs.mockResolvedValue(['owlette-desktop.exe', flag])

      await walk([status('stopped')])

      await waitFor(() => expect(serviceStart).toHaveBeenCalledTimes(1))
      expect(serviceStart).toHaveBeenCalledWith(false)
    },
  )

  it('stands down while a claim holds the service down', async () => {
    serviceStatus.mockResolvedValue(status('running'))
    const view = renderHook(() => useServiceHealth())
    await waitFor(() => expect(view.result.current.status).toBeTruthy())

    let release = () => {}
    act(() => {
      release = view.result.current.hold()
    })

    serviceStatus.mockResolvedValue(status('stopped'))
    await act(async () => {
      view.result.current.refresh()
    })
    await waitFor(() => expect(view.result.current.status?.state).toBe('stopped'))
    expect(serviceStart).not.toHaveBeenCalled()

    // Releasing must not hand the decision back to the auto-start either: the
    // operator's own drive outranks it.
    act(() => release())
    await act(async () => {
      view.result.current.refresh()
    })
    expect(serviceStart).not.toHaveBeenCalled()
  })
})

describe('elevation', () => {
  it('reports a refused start as needing admin, not as an error', async () => {
    serviceStart.mockResolvedValue({ method: 'needs_elevation', stateBefore: 'stopped' })

    const view = await walk([status('stopped')])

    await waitFor(() => expect(view.result.current.elevationRequired).toBe(true))
    expect(view.result.current.error).toBeNull()
  })

  it('clears the flag once a start goes through', async () => {
    serviceStart.mockResolvedValue({ method: 'needs_elevation', stateBefore: 'stopped' })
    const view = await walk([status('stopped')])
    await waitFor(() => expect(view.result.current.elevationRequired).toBe(true))

    serviceStart.mockResolvedValue(SCM)
    await act(async () => {
      await view.result.current.start()
    })

    expect(view.result.current.elevationRequired).toBe(false)
  })

  it('lets an explicit start elevate even in a tray launch', async () => {
    launchArgs.mockResolvedValue(['owlette-desktop.exe', '--tray'])
    const view = await walk([status('running')])

    await act(async () => {
      await view.result.current.start()
    })

    expect(serviceStart).toHaveBeenLastCalledWith(true)
  })
})

describe('errors', () => {
  it('clears a poll failure as soon as polling recovers', async () => {
    serviceStatus.mockRejectedValue(new Error('could not connect to the service manager'))
    const view = renderHook(() => useServiceHealth())
    await waitFor(() => expect(view.result.current.scmError).toMatch(/service manager/))

    serviceStatus.mockResolvedValue(status('running'))
    await act(async () => {
      view.result.current.refresh()
    })

    await waitFor(() => expect(view.result.current.scmError).toBeNull())
  })

  /**
   * The two channels are separate for this reason: the 15 s poll would otherwise
   * wipe the message explaining why the button the operator pressed did nothing.
   */
  it('does not let a recovering poll erase a failed start', async () => {
    serviceStart.mockRejectedValue(new Error('elevation was declined'))
    const view = await walk([status('running')])

    await act(async () => {
      await view.result.current.start()
    })
    expect(view.result.current.error).toMatch(/elevation was declined/)

    await act(async () => {
      view.result.current.refresh()
    })

    expect(view.result.current.error).toMatch(/elevation was declined/)
    expect(view.result.current.scmError).toBeNull()
  })
})

describe('bringingUp', () => {
  /**
   * THE REPORTED BUG. Relaunching after a quit finds the service genuinely
   * stopped for a beat before the auto-start lands. Reporting that beat honestly
   * — "service not running", red, with a `start service` button — is what put an
   * error and a call to action in front of an operator who had just opened the
   * app and whose service was already on its way up.
   */
  it('is true from the first render, before the auto-start has been decided', async () => {
    // Never resolve: this is the window between mount and knowing anything.
    serviceStatus.mockReturnValue(new Promise(() => {}))
    const view = renderHook(() => useServiceHealth())

    expect(view.result.current.bringingUp).toBe(true)
  })

  it('stays true across the whole launch-with-a-stopped-service sequence', async () => {
    const view = await walk([status('stopped')])

    // Decided, and a start issued — still bringing up, never a gap.
    await waitFor(() => expect(serviceStart).toHaveBeenCalled())
    expect(view.result.current.bringingUp).toBe(true)

    // ...and once it is up but not yet publishing.
    serviceStatus.mockResolvedValue(status('running', false))
    await act(async () => {
      view.result.current.refresh()
    })
    await waitFor(() => expect(view.result.current.status?.state).toBe('running'))
    expect(view.result.current.bringingUp).toBe(true)
  })

  it('is false once a service that was already up is found publishing', async () => {
    const view = await walk([status('running')])

    await waitFor(() => expect(view.result.current.bringingUp).toBe(false))
  })

  /** A service already running-but-silent when the window opened is wedged. */
  it('is false for a running-but-silent service we merely walked in on', async () => {
    const view = await walk([status('running', false)])

    await waitFor(() => expect(view.result.current.bringingUp).toBe(false))
  })

  /** The operator stopped it; nobody is bringing it up, so the button belongs. */
  it('is false for a service stopped after the auto-start has had its turn', async () => {
    const view = await walk([status('running'), status('stopped')])

    await waitFor(() => expect(view.result.current.bringingUp).toBe(false))
    expect(serviceStart).not.toHaveBeenCalled()
  })
})

describe('a start that does not take', () => {
  /**
   * The bring-up is stamped optimistically, before the answer comes back. If it
   * stays stamped after a refusal, the footer sits on yellow `connecting…` for
   * 45 s with the recovery button hidden, for a service that is not coming.
   */
  it('stops claiming a bring-up when elevation was refused', async () => {
    serviceStart.mockResolvedValue({ method: 'needs_elevation', stateBefore: 'stopped' })

    const view = await walk([status('stopped')])

    await waitFor(() => expect(view.result.current.elevationRequired).toBe(true))
    expect(view.result.current.bringingUp).toBe(false)
  })

  it('stops claiming a bring-up when the start throws', async () => {
    serviceStart.mockRejectedValue(new Error('elevation was declined'))

    const view = await walk([status('stopped')])

    await waitFor(() => expect(view.result.current.error).toMatch(/declined/))
    expect(view.result.current.bringingUp).toBe(false)
  })

  it('keeps the bring-up when the start really was issued', async () => {
    const view = await walk([status('stopped')])

    await waitFor(() => expect(serviceStart).toHaveBeenCalled())
    expect(view.result.current.bringingUp).toBe(true)
  })
})
