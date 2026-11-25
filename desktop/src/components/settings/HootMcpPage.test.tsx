import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const fleetState = vi.fn()
const hootTools = vi.fn()
const setHootTool = vi.fn()
const copyText = vi.fn()
const openExternalUrl = vi.fn()
const toastError = vi.fn()

vi.mock('@/lib/ipc', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/ipc')>()),
  fleetState: () => fleetState(),
  hootTools: () => hootTools(),
  setHootTool: (id: string, on: boolean) => setHootTool(id, on),
  onHootToolsSynced: () => Promise.resolve(() => {}),
}))
vi.mock('@/lib/clipboard', () => ({ copyText: (text: string) => copyText(text) }))
vi.mock('@/lib/agentCli', () => ({
  openExternalUrl: (...args: unknown[]) => openExternalUrl(...args),
}))
vi.mock('sonner', () => ({ toast: { error: (...args: unknown[]) => toastError(...args) } }))

const { HootMcpPage } = await import('./HootMcpPage')
const { HOOT_MCP_DOCS_URL, hootCommandLine } = await import('@/lib/hootMcp')

const PYTHON = 'C:\\ProgramData\\Owlette\\python\\python.exe'
const SCRIPT = 'C:\\ProgramData\\Owlette\\agent\\src\\fleet_mcp.py'
const LINE = `"${PYTHON}" "${SCRIPT}"`
const ADMIN = 'https://owlette.app/admin/hoot?site=tec&machine=a4d'

const granted = {
  granted: true,
  maxTier: 2,
  wholeSite: false,
  machineIds: ['owlette-kiosk', 'TEC-MBA'],
  adminUrl: ADMIN,
}
const off = { ...granted, granted: false }
const TOOLS = [
  { id: 'claude-code', label: 'claude code', found: true, on: true, configured: true },
  { id: 'cursor', label: 'cursor', found: true, on: false, configured: false },
  { id: 'codex', label: 'codex', found: false, on: true, configured: false },
  { id: 'gemini', label: 'gemini cli', found: false, on: true, configured: false },
]

function show(props: Partial<Parameters<typeof HootMcpPage>[0]> = {}) {
  const onTurnOn = vi.fn()
  const onTurnOff = vi.fn()
  render(
    <HootMcpPage
      command={[PYTHON, SCRIPT]}
      paired
      siteName="TEC"
      pending={false}
      onTurnOn={onTurnOn}
      onTurnOff={onTurnOff}
      {...props}
    />,
  )
  return { onTurnOn, onTurnOff }
}

const hootSwitch = () => screen.getByRole('switch')

beforeEach(() => {
  fleetState.mockReset().mockResolvedValue(granted)
  hootTools.mockReset().mockResolvedValue(TOOLS)
  setHootTool.mockReset().mockResolvedValue(undefined)
  copyText.mockReset().mockResolvedValue(true)
  openExternalUrl.mockReset().mockResolvedValue(undefined)
  toastError.mockReset()
})

describe('hootCommandLine', () => {
  it('quotes each path and joins them with a space', () => {
    expect(hootCommandLine([PYTHON, SCRIPT])).toBe(LINE)
    expect(hootCommandLine(['/Library/App Support/python3', '/x/fleet_mcp.py'])).toBe(
      "'/Library/App Support/python3' '/x/fleet_mcp.py'",
    )
  })
})

describe('HootMcpPage states', () => {
  it('off: says what turning it on does, and asks on a click', async () => {
    fleetState.mockResolvedValue(off)
    const { onTurnOn } = show()

    await screen.findByText(
      "ai tools on this computer list hoot but can't act on other machines until a site admin allows it. turning this on asks one.",
    )
    expect(hootSwitch().getAttribute('aria-checked')).toBe('false')
    expect(screen.getByLabelText('let ai tools on this computer act on other machines in TEC')).toBe(
      hootSwitch(),
    )
    fireEvent.click(hootSwitch())
    expect(onTurnOn).toHaveBeenCalledTimes(1)
  })

  it('waiting: shows the switch on and the admin panel link', async () => {
    fleetState.mockResolvedValue(off)
    show({ pending: true })

    await screen.findByText(/waiting for a site admin to allow it/)
    expect(hootSwitch().getAttribute('aria-checked')).toBe('true')
    fireEvent.click(screen.getByRole('button', { name: 'open admin panel' }))
    expect(openExternalUrl).toHaveBeenCalledWith(ADMIN)
  })

  it('on: names how far and which machines, with the link to change them', async () => {
    const { onTurnOff } = show()

    await screen.findByText('bounded changes')
    expect(screen.getByText('owlette-kiosk, TEC-MBA')).toBeTruthy()
    expect(hootSwitch().getAttribute('aria-checked')).toBe('true')
    fireEvent.click(screen.getByRole('button', { name: 'change in the admin panel' }))
    expect(openExternalUrl).toHaveBeenCalledWith(ADMIN)
    fireEvent.click(hootSwitch())
    expect(onTurnOff).toHaveBeenCalledTimes(1)
  })

  it('on: reads the tiers and the reach in words', async () => {
    fleetState.mockResolvedValue({ ...granted, maxTier: 1, wholeSite: true })
    show()
    await screen.findByText('read')
    expect(screen.getByText('the whole site')).toBeTruthy()
  })

  it('on: says no machines when none are allowed', async () => {
    fleetState.mockResolvedValue({ ...granted, maxTier: 3, machineIds: [] })
    show()
    await screen.findByText('privileged')
    expect(screen.getByText('no machines')).toBeTruthy()
  })

  it('on: lists the found tools as tickboxes and the rest as not found', async () => {
    show()

    expect(await screen.findByText('add hoot to these ai tools on this computer')).toBeTruthy()
    expect(screen.getByRole('checkbox', { name: 'claude code' }).getAttribute('aria-checked')).toBe('true')
    expect(screen.getByRole('checkbox', { name: 'cursor' }).getAttribute('aria-checked')).toBe('false')
    expect(screen.queryByRole('checkbox', { name: 'codex' })).toBeNull()
    expect(
      screen.getByText('restart a tool after a change. not found here: codex, gemini cli.'),
    ).toBeTruthy()
  })

  it('ticking a tool saves it and reads the tools again', async () => {
    show()
    const cursor = await screen.findByRole('checkbox', { name: 'cursor' })
    hootTools.mockClear()

    fireEvent.click(cursor)

    expect(setHootTool).toHaveBeenCalledWith('cursor', true)
    await waitFor(() => expect(hootTools).toHaveBeenCalled())
  })

  it('a tool that cannot be saved toasts the reason', async () => {
    setHootTool.mockRejectedValue('config.json is not valid json')
    show()

    fireEvent.click(await screen.findByRole('checkbox', { name: 'cursor' }))

    await waitFor(() =>
      expect(toastError).toHaveBeenCalledWith('could not save that choice', {
        description: 'config.json is not valid json',
      }),
    )
  })

  it('on with no tools found: points at the command', async () => {
    hootTools.mockResolvedValue(TOOLS.map((tool) => ({ ...tool, found: false })))
    show()

    await screen.findByText(
      'no ai tools the app knows are on this computer. add hoot to yours with the command below.',
    )
    expect(screen.queryByRole('checkbox')).toBeNull()
  })

  it('not paired: the switch is off and disabled', () => {
    show({ paired: false })

    expect(screen.getByText('join a site first.')).toBeTruthy()
    expect((hootSwitch() as HTMLButtonElement).disabled).toBe(true)
    expect(hootSwitch().getAttribute('aria-checked')).toBe('false')
  })

  it('no state yet: waits for the service, switch disabled', async () => {
    fleetState.mockResolvedValue(null)
    show()

    expect(
      await screen.findByText('waiting for the owlette service to check with the server.'),
    ).toBeTruthy()
    expect((hootSwitch() as HTMLButtonElement).disabled).toBe(true)
  })

  it('reads the state again every ten seconds', async () => {
    vi.useFakeTimers()
    try {
      show()
      await act(async () => {})
      fleetState.mockClear()
      await act(async () => {
        vi.advanceTimersByTime(10_000)
      })
      expect(fleetState).toHaveBeenCalledTimes(1)
    } finally {
      vi.useRealTimers()
    }
  })
})

describe('HootMcpPage command', () => {
  it('shows the command for other tools and copies it', async () => {
    show()

    expect(await screen.findByText('other ai tools: add a stdio server with this command')).toBeTruthy()
    const box = screen.getByTestId('hoot-command')
    expect(box.textContent).toContain(LINE)
    expect(screen.getByTestId('hoot-command-state').textContent).toBe('click to copy')

    fireEvent.click(box)

    expect(copyText).toHaveBeenCalledWith(LINE)
    await waitFor(() =>
      expect(screen.getByTestId('hoot-command-state').textContent).toBe('copied to clipboard'),
    )
  })

  it('goes back to click to copy after two seconds', async () => {
    vi.useFakeTimers()
    try {
      show()
      await act(async () => {})
      fireEvent.click(screen.getByTestId('hoot-command'))
      await act(async () => {})
      expect(screen.getByTestId('hoot-command-state').textContent).toBe('copied to clipboard')
      await act(async () => {
        vi.advanceTimersByTime(2000)
      })
      expect(screen.getByTestId('hoot-command-state').textContent).toBe('click to copy')
    } finally {
      vi.useRealTimers()
    }
  })

  it('says so when the copy fails', async () => {
    copyText.mockResolvedValue(false)
    show()

    fireEvent.click(await screen.findByTestId('hoot-command'))

    await waitFor(() =>
      expect(toastError).toHaveBeenCalledWith('could not copy the command', expect.anything()),
    )
    expect(screen.getByTestId('hoot-command-state').textContent).toBe('click to copy')
  })

  it('shows no tools and no command before the service has answered or when not paired', async () => {
    fleetState.mockResolvedValue(null)
    show()
    await act(async () => {})
    expect(screen.queryByTestId('hoot-command')).toBeNull()
    expect(screen.queryByRole('checkbox')).toBeNull()
    cleanup()

    show({ paired: false })
    expect(screen.queryByTestId('hoot-command')).toBeNull()
  })

  it('shows the tools and the command allowed or not, so a tool can be left out either way', async () => {
    for (const [state, pending] of [
      [off, false],
      [off, true],
      [granted, false],
    ] as const) {
      fleetState.mockResolvedValue(state)
      show({ pending })
      expect(await screen.findByRole('checkbox', { name: 'cursor' })).toBeTruthy()
      expect(screen.getByTestId('hoot-command')).toBeTruthy()
      cleanup()
    }

    hootTools.mockResolvedValue(TOOLS.map((tool) => ({ ...tool, found: false })))
    fleetState.mockResolvedValue(off)
    show()
    expect(await screen.findByTestId('hoot-command')).toBeTruthy()
  })

  it('opens the guide in every state the page shows', async () => {
    for (const state of [null, off, granted]) {
      fleetState.mockResolvedValue(state)
      const { unmount } = render(
        <HootMcpPage
          command={[PYTHON, SCRIPT]}
          paired
          siteName="TEC"
          pending={false}
          onTurnOn={vi.fn()}
          onTurnOff={vi.fn()}
        />,
      )
      await act(async () => {})
      openExternalUrl.mockClear()
      fireEvent.click(screen.getByRole('button', { name: 'how it works' }))
      expect(openExternalUrl).toHaveBeenCalledWith(HOOT_MCP_DOCS_URL)
      unmount()
    }
  })
})
