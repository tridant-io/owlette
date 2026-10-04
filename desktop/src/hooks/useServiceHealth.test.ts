import { act, renderHook } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ServiceStatus } from '@/lib/ipc'

const serviceStatus = vi.fn<() => Promise<ServiceStatus>>()
const serviceStart = vi.fn<(allowElevation: boolean) => Promise<unknown>>()
const readOwletteJson = vi.fn<(path: string) => Promise<unknown>>()

vi.mock('@/lib/ipc', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/ipc')>()),
  serviceStatus: () => serviceStatus(),
  serviceStart: (allowElevation: boolean) => serviceStart(allowElevation),
  readOwletteJson: (path: string) => readOwletteJson(path),
}))

vi.mock('@/hooks/useOwletteFileWatch', () => ({ useOwletteFileWatch: vi.fn() }))

const { useServiceHealth } = await import('./useServiceHealth')

function stopped(): ServiceStatus {
  return {
    installed: true,
    running: false,
    state: 'stopped',
    startType: 'auto_start',
    statusFile: { exists: true, ageSecs: 5, stale: false },
  }
}

/** The service's marker timestamp format, `minutesAgo` minutes in the past. */
function markerFrom(minutesAgo: number): { started_at: string } {
  const then = new Date(Date.now() - minutesAgo * 60_000)
  const pad = (value: number) => String(value).padStart(2, '0')
  return {
    started_at:
      `${then.getFullYear()}-${pad(then.getMonth() + 1)}-${pad(then.getDate())} ` +
      `${pad(then.getHours())}:${pad(then.getMinutes())}:${pad(then.getSeconds())}`,
  }
}

async function mounted() {
  const view = renderHook(() => useServiceHealth())
  await act(async () => {})
  return view
}

beforeEach(() => {
  serviceStatus.mockReset()
  serviceStatus.mockResolvedValue(stopped())
  serviceStart.mockReset()
  serviceStart.mockResolvedValue({ method: 'scm', stateBefore: 'stopped' })
  readOwletteJson.mockReset()
  // No marker file and no status file content by default.
  readOwletteJson.mockRejectedValue(new Error('not found'))
})

describe('the launch-time auto-start', () => {
  it('starts a stopped service without ever allowing a UAC prompt', async () => {
    await mounted()

    // The negative control for the elevation gate: before the fix this call
    // carried no argument and the host fell back to an elevated cmd.
    expect(serviceStart).toHaveBeenCalledExactlyOnceWith(false)
  })

  it('stands down while a self-update owns the service', async () => {
    // The installer stopped the service on purpose and will restart it itself;
    // a start from here races the file replacement.
    readOwletteJson.mockImplementation((path) =>
      path === 'logs/update_in_progress.json'
        ? Promise.resolve(markerFrom(1))
        : Promise.reject(new Error('not found')),
    )

    await mounted()

    expect(serviceStart).not.toHaveBeenCalled()
  })

  it('treats a stale marker as debris from a failed update', async () => {
    readOwletteJson.mockImplementation((path) =>
      path === 'logs/update_in_progress.json'
        ? Promise.resolve(markerFrom(15))
        : Promise.reject(new Error('not found')),
    )

    await mounted()

    expect(serviceStart).toHaveBeenCalledExactlyOnceWith(false)
  })

  it('leaves a running service alone', async () => {
    serviceStatus.mockResolvedValue({ ...stopped(), running: true, state: 'running' })

    await mounted()

    expect(serviceStart).not.toHaveBeenCalled()
  })

  it('never undoes a stop made after launch', async () => {
    // The kiosk VM, 2026-10-04: `systemctl stop owlette-agent` was cancelled a
    // quarter second in by this start, which linux's polkit rule lets through.
    serviceStatus.mockResolvedValue({ ...stopped(), running: true, state: 'running' })
    const { result } = await mounted()

    serviceStatus.mockResolvedValue(stopped())
    await act(async () => result.current.refresh())
    await act(async () => {})

    expect(serviceStart).not.toHaveBeenCalled()
  })
})
