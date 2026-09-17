import { act, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AgentEvent } from '@/lib/agentCli'
import type { ServiceStatus } from '@/lib/ipc'

const startAgentRun = vi.fn()
vi.mock('@/lib/agentCli', () => ({
  startAgentRun: (...args: unknown[]) => startAgentRun(...args),
}))

const serviceStatus = vi.fn()
const serviceStart = vi.fn()
const serviceStop = vi.fn()
const logEvent = vi.fn((_level: string, _message: string) => Promise.resolve())
vi.mock('@/lib/ipc', () => ({
  serviceStatus: () => serviceStatus(),
  serviceStart: () => serviceStart(),
  serviceStop: () => serviceStop(),
  logEvent: (level: string, message: string) => logEvent(level, message),
}))

const { LeaveSiteDialog } = await import('./LeaveSiteDialog')

function scmStatus(state: ServiceStatus['state']): ServiceStatus {
  return {
    installed: true,
    running: state === 'running',
    state,
    startType: 'auto_start',
    // Leave-site stops the service deliberately, so a clean exit is the case
    // this fixture stands in for.
    stoppedCleanly: state === 'stopped' ? true : null,
    statusFile: { exists: true, ageSecs: 3, stale: false },
  }
}

/**
 * The SCM as the dialog sees it: running until stopped, stopped until started.
 * Queries answer from the last command, not a fixed script, because the real
 * sequence polls.
 */
function fakeService() {
  let state: ServiceStatus['state'] = 'running'
  serviceStatus.mockImplementation(() => Promise.resolve(scmStatus(state)))
  serviceStop.mockImplementation(() => {
    state = 'stopped'
    return Promise.resolve({ method: 'elevated', stateBefore: 'running' })
  })
  serviceStart.mockImplementation(() => {
    state = 'running'
    return Promise.resolve({ method: 'elevated', stateBefore: 'stopped' })
  })
  return {
    /** Pretend the service is already down before the leave begins. */
    down: () => {
      state = 'stopped'
    },
  }
}

/** A controllable stand-in for a live helper run. */
function fakeRun() {
  let emit: (event: AgentEvent) => void = () => {}
  let finish: (outcome: { code: number | null; terminal: null; stderr: string }) => void = () => {}

  startAgentRun.mockImplementation(
    (_mode: string, options: { onEvent?: (e: AgentEvent) => void }) => {
      emit = (event) => options.onEvent?.(event)
      return Promise.resolve({
        id: 'leave-0',
        completed: new Promise((resolve) => {
          finish = resolve
        }),
        cancel: vi.fn(),
      })
    },
  )

  return {
    emit: (event: AgentEvent) => act(() => emit(event)),
    exit: async (code: number, stderr = '') => {
      await act(async () => {
        finish({ code, terminal: null, stderr })
        await settle()
      })
    },
    /** Emit a terminal event and let the helper exit, as it really does. */
    finish: async (event: AgentEvent, code = 0) => {
      await act(async () => {
        emit(event)
        finish({ code, terminal: null, stderr: '' })
        await settle()
      })
    },
  }
}

/** Flush the promise chain the sequence is built from. */
async function settle() {
  for (let turn = 0; turn < 25; turn++) await Promise.resolve()
}

function open(props: Partial<Parameters<typeof LeaveSiteDialog>[0]> = {}) {
  const release = vi.fn()
  const all = {
    open: true,
    site: 'TEC',
    onClose: vi.fn(),
    onLeft: vi.fn(),
    onHold: vi.fn(() => release),
    ...props,
  }
  render(<LeaveSiteDialog {...all} />)
  return { ...all, release }
}

/** Click `leave site` and let the stop half of the sequence run. */
async function startLeave() {
  fireEvent.click(screen.getByRole('button', { name: 'leave site' }))
  await act(async () => {
    await settle()
  })
}

function copy(): string {
  return screen.getByTestId('leave-site-dialog').textContent ?? ''
}

/** Every line the dialog wrote to the host log, in order. */
function logLines(): string[] {
  return logEvent.mock.calls.map(([, message]) => message)
}

beforeEach(() => {
  startAgentRun.mockReset()
  serviceStatus.mockReset()
  serviceStart.mockReset()
  serviceStop.mockReset()
  logEvent.mockClear()
})

afterEach(() => {
  vi.useRealTimers()
})

describe('LeaveSiteDialog', () => {
  it('asks before doing anything, naming the site as the operator knows it', () => {
    open()

    expect(copy()).toContain('remove this machine from TEC?')
    expect(startAgentRun).not.toHaveBeenCalled()
    expect(serviceStop).not.toHaveBeenCalled()
  })

  it('names the site by id when no display name has reached this machine', () => {
    // What `siteNameOf` hands over when the service has not published a name:
    // the id, so the sentence still says which site it means.
    open({ site: 'default_site' })

    expect(copy()).toContain('remove this machine from default_site?')
  })

  it('says "its site" rather than nothing when the site is unknown', () => {
    open({ site: '' })

    expect(copy()).toContain('remove this machine from its site?')
  })

  it('backs out without touching the agent or the service', () => {
    const props = open()

    fireEvent.click(screen.getByRole('button', { name: 'cancel' }))
    expect(props.onClose).toHaveBeenCalledOnce()
    expect(startAgentRun).not.toHaveBeenCalled()
    expect(serviceStop).not.toHaveBeenCalled()
  })

  it('stops the service before the helper runs, and starts it after', async () => {
    fakeService()
    const run = fakeRun()
    open()

    await startLeave()

    // The stop is the first thing that happens, and the helper only runs once
    // the SCM has confirmed it — nothing can recreate the machine document.
    expect(serviceStop).toHaveBeenCalledOnce()
    expect(startAgentRun).toHaveBeenCalledWith('leave', expect.anything())
    expect(serviceStart).not.toHaveBeenCalled()

    await run.finish({ event: 'done', value: { siteId: 'default_site', deregistered: true } })

    expect(serviceStart).toHaveBeenCalledOnce()
    expect(copy()).toContain('no longer monitored')
  })

  it('shows each step as the agent reports it, but not the ones it cannot do', async () => {
    fakeService()
    const run = fakeRun()
    open()

    await startLeave()

    run.emit({ event: 'status', value: 'disabling cloud sync' })
    expect(screen.getByTestId('leave-status').textContent).toContain('disabling cloud sync')

    // The helper still asks NSSM to stop the service and fails; this dialog
    // has already done it, so its narration is not repeated.
    run.emit({ event: 'status', value: 'stopping the service' })
    expect(screen.getByTestId('leave-status').textContent).toContain('disabling cloud sync')

    run.emit({ event: 'status', value: 'deregistering this machine' })
    expect(screen.getByTestId('leave-status').textContent).toContain('deregistering this machine')
  })

  it('aborts before anything is torn down when the elevated stop is declined', async () => {
    fakeService()
    fakeRun()
    serviceStop.mockRejectedValue(new Error('elevation was declined or could not be started'))
    const props = open()

    await startLeave()

    expect(startAgentRun).not.toHaveBeenCalled()
    expect(serviceStart).not.toHaveBeenCalled()
    expect(props.onLeft).not.toHaveBeenCalled()
    expect(copy()).toContain('nothing on this machine changed')
    expect(copy()).toContain('still paired to TEC')
    expect(screen.getByTestId('leave-error').textContent).toContain(
      'the administrator prompt was declined',
    )
    // The claim on the service is handed back even on the path that gives up.
    expect(props.release).toHaveBeenCalledOnce()
  })

  it('offers a retry after a declined stop, because nothing was written', async () => {
    fakeService()
    const run = fakeRun()
    serviceStop.mockRejectedValueOnce(new Error('elevation was declined or could not be started'))
    open()

    await startLeave()
    fireEvent.click(screen.getByRole('button', { name: 'try again' }))
    await act(async () => {
      await settle()
    })

    expect(serviceStop).toHaveBeenCalledTimes(2)
    expect(startAgentRun).toHaveBeenCalledOnce()

    await run.finish({ event: 'done', value: { siteId: 'default_site', deregistered: true } })
    expect(copy()).toContain('no longer monitored')
  })

  it('leaves the service alone when it was already stopped', async () => {
    const service = fakeService()
    service.down()
    const run = fakeRun()
    open()

    await startLeave()
    await run.finish({ event: 'done', value: { siteId: 'default_site', deregistered: true } })

    // Nothing of ours stopped it, so nothing of ours starts it — the machine is
    // left in the service state it was found in, with no second UAC prompt.
    expect(serviceStop).not.toHaveBeenCalled()
    expect(serviceStart).not.toHaveBeenCalled()
    expect(copy()).toContain('no longer monitored')
  })

  it('cannot be dismissed while the service is being restarted', async () => {
    fakeService()
    fakeRun()
    const props = open()

    await startLeave()

    const close = screen.getByRole('button', { name: 'close' }) as HTMLButtonElement
    expect(close.disabled).toBe(true)
    fireEvent.keyDown(screen.getByTestId('leave-site-dialog'), { key: 'Escape' })
    expect(props.onClose).not.toHaveBeenCalled()
  })

  it('reports success once the machine is deregistered', async () => {
    fakeService()
    const run = fakeRun()
    const props = open()

    await startLeave()
    await run.finish({ event: 'done', value: { siteId: 'default_site', deregistered: true } })

    expect(props.onLeft).toHaveBeenCalledOnce()
    expect(copy()).toContain('this machine has left TEC and is no longer monitored.')
    expect(props.release).toHaveBeenCalledOnce()
  })

  it('says where the row is when the local half worked and the delete did not', async () => {
    fakeService()
    const run = fakeRun()
    open()

    await startLeave()
    await run.finish({ event: 'done', value: { siteId: 'default_site', deregistered: false } })

    expect(copy()).toContain('its row is still on the dashboard — you can remove it there.')
    // Never phrased as "we could not do it, go and check" — it says what
    // happened and the one thing left to do.
    expect(copy()).not.toContain('could not')
  })

  it('says the service is still down when it could not be started again', async () => {
    fakeService()
    const run = fakeRun()
    serviceStart.mockRejectedValue(new Error('elevation was declined or could not be started'))
    open()

    await startLeave()
    await run.finish({ event: 'done', value: { siteId: 'default_site', deregistered: true } })

    expect(copy()).toContain('use start service in the footer to start it')
  })

  it('surfaces the agent’s error and points at the footer', async () => {
    fakeService()
    const run = fakeRun()
    open()

    await startLeave()
    await run.finish({ event: 'error', value: 'this machine is not paired with a site' }, 1)

    expect(screen.getByTestId('leave-error').textContent).toContain('not paired with a site')
    expect(copy()).toContain('the footer shows whether this machine is still in the site')
    // The service still comes back: a machine with no supervisor is worse than
    // one that is still on a dashboard.
    expect(serviceStart).toHaveBeenCalledOnce()
    expect(screen.queryByRole('button', { name: 'try again' })).toBeNull()
  })

  it('still restores the service when the helper could not be spawned at all', async () => {
    fakeService()
    startAgentRun.mockRejectedValue(new Error('python.exe was not found'))
    open()

    await startLeave()

    expect(screen.getByTestId('leave-error').textContent).toContain('python.exe was not found')
    expect(serviceStart).toHaveBeenCalledOnce()
    // A dialog that refuses to close while it works must always stop working.
    expect((screen.getByRole('button', { name: 'close' }) as HTMLButtonElement).disabled).toBe(false)
  })

  it('falls back to stderr when the helper dies without saying why', async () => {
    fakeService()
    const run = fakeRun()
    open()

    await startLeave()
    await run.exit(1, 'ImportError: no module named auth_manager')

    expect(screen.getByTestId('leave-error').textContent).toContain('ImportError')
  })

  describe('the host log', () => {
    it('records every step of a teardown that worked', async () => {
      // The 2026-08-13 leave stopped the service and went silent, with nothing in
      // the app log between "window opened" and the next launch. Each step
      // announces itself first, so a sequence that dies says which half.
      fakeService()
      const run = fakeRun()
      open()

      await startLeave()
      await run.finish({ event: 'done', value: { siteId: 'default_site', deregistered: true } })

      const lines = logLines()
      expect(lines[0]).toBe('leave-site: started')
      expect(lines).toContainEqual('leave-site: requesting the service stop')
      expect(lines).toContainEqual('leave-site: service stopped')
      expect(lines).toContainEqual('leave-site: spawning the leave helper')
      expect(lines).toContainEqual('leave-site: helper finished, deregistered=true')
      expect(lines).toContainEqual('leave-site: starting the service again')
      expect(lines).toContainEqual('leave-site: service running again')
      expect(lines.at(-1)).toBe('leave-site: done')
    })

    it('says the stop is what failed, and that nothing was changed', async () => {
      fakeService()
      serviceStop.mockRejectedValue(new Error('elevation was declined'))
      fakeRun()
      open()

      await startLeave()

      const lines = logLines()
      expect(lines).toContainEqual(
        'leave-site: stop failed: elevation was declined — nothing was changed',
      )
      // The teardown must not have been reached.
      expect(lines).not.toContainEqual('leave-site: spawning the leave helper')
      expect(logEvent).toHaveBeenCalledWith('error', expect.stringContaining('stop failed'))
    })

    it('records the helper progress lines it is showing the operator', async () => {
      fakeService()
      const run = fakeRun()
      open()

      await startLeave()
      run.emit({ event: 'status', value: 'deleting the machine document' })
      await run.finish({ event: 'done', value: { siteId: 'default_site', deregistered: false } })

      expect(logLines()).toContainEqual('leave-site: helper: deleting the machine document')
      expect(logLines()).toContainEqual('leave-site: helper finished, deregistered=false')
    })

    it('is never the reason a step fails', async () => {
      // A log write that rejects must not become a teardown that failed.
      logEvent.mockImplementation(() => Promise.reject(new Error('log file locked')))
      fakeService()
      const run = fakeRun()
      open()

      await startLeave()
      await run.finish({ event: 'done', value: { siteId: 'default_site', deregistered: true } })

      expect(copy()).toContain('no longer monitored')
      logEvent.mockImplementation(() => Promise.resolve())
    })
  })

  it('does not wait forever for a helper that speaks and then wedges', async () => {
    vi.useFakeTimers()
    fakeService()
    const run = fakeRun()
    open()

    await startLeave()
    run.emit({ event: 'done', value: { siteId: 'default_site', deregistered: true } })
    await act(async () => {
      // The exit event never arrives; the grace window closes instead.
      await vi.advanceTimersByTimeAsync(5_000)
      await settle()
    })

    expect(serviceStart).toHaveBeenCalledOnce()
    expect(copy()).toContain('no longer monitored')
  })
})
