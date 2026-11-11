import { fireEvent, render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const hootMcpCommand = vi.fn()
const copyText = vi.fn()
const openExternalUrl = vi.fn()
const toastError = vi.fn()

vi.mock('@/lib/ipc', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/ipc')>()),
  hootMcpCommand: () => hootMcpCommand(),
}))
vi.mock('@/lib/clipboard', () => ({ copyText: (text: string) => copyText(text) }))
vi.mock('@/lib/agentCli', () => ({
  openExternalUrl: (...args: unknown[]) => openExternalUrl(...args),
}))
vi.mock('sonner', () => ({ toast: { error: (...args: unknown[]) => toastError(...args) } }))

const { ConnectAgentDialog } = await import('./ConnectAgentDialog')
const { HOOT_MCP_DOCS_URL, claudeCodeCommand } = await import('@/lib/hootMcp')

const PYTHON = 'C:\\ProgramData\\Owlette\\python\\python.exe'
const SCRIPT = 'C:\\ProgramData\\Owlette\\agent\\src\\fleet_mcp.py'
const LINE = `claude mcp add hoot -- "${PYTHON}" "${SCRIPT}"`

function open() {
  const onClose = vi.fn()
  render(<ConnectAgentDialog open onClose={onClose} />)
  return onClose
}

beforeEach(() => {
  hootMcpCommand.mockReset().mockResolvedValue([PYTHON, SCRIPT])
  copyText.mockReset().mockResolvedValue(true)
  openExternalUrl.mockReset().mockResolvedValue(undefined)
  toastError.mockReset()
})

describe('claudeCodeCommand', () => {
  it('registers the server as hoot, with each path quoted', () => {
    expect(claudeCodeCommand([PYTHON, SCRIPT])).toBe(LINE)
    expect(claudeCodeCommand(['C:\\Program Files\\o\\python.exe', 'C:\\Program Files\\o\\fleet_mcp.py'])).toBe(
      'claude mcp add hoot -- "C:\\Program Files\\o\\python.exe" "C:\\Program Files\\o\\fleet_mcp.py"',
    )
  })
})

describe('ConnectAgentDialog', () => {
  it('shows the claude code line and the two paths the host gave', async () => {
    open()

    expect((await screen.findByTestId('connect-agent-command')).textContent).toBe(LINE)
    expect(screen.getByTestId('connect-agent-python').textContent).toBe(PYTHON)
    expect(screen.getByTestId('connect-agent-script').textContent).toBe(SCRIPT)
    expect(screen.getByTestId('connect-agent-copy-state').textContent).toBe('click to copy')
  })

  it('says who turns the machine on, and where', () => {
    open()

    expect(screen.getByRole('dialog').textContent).toContain(
      "a site owner or admin turns this machine on first, in the dashboard's admin panel, under hoot.",
    )
  })

  it('copies the whole line on a click and says so', async () => {
    open()

    fireEvent.click(await screen.findByTestId('connect-agent-command'))

    await vi.waitFor(() => expect(copyText).toHaveBeenCalledWith(LINE))
    await vi.waitFor(() =>
      expect(screen.getByTestId('connect-agent-copy-state').textContent).toBe('copied to clipboard'),
    )
    expect(toastError).not.toHaveBeenCalled()
  })

  it('says to copy by hand when the clipboard refuses', async () => {
    copyText.mockResolvedValue(false)
    open()

    fireEvent.click(await screen.findByTestId('connect-agent-command'))

    await vi.waitFor(() => expect(toastError).toHaveBeenCalledOnce())
    expect(toastError.mock.calls[0][0]).toBe('could not copy the command')
    expect(screen.getByTestId('connect-agent-copy-state').textContent).toBe('click to copy')
  })

  it('opens the guide', () => {
    open()

    fireEvent.click(screen.getByTestId('connect-agent-guide'))

    expect(openExternalUrl).toHaveBeenCalledWith(HOOT_MCP_DOCS_URL)
  })

  it.each([
    ['the host has no command for this machine', () => hootMcpCommand.mockResolvedValue(null)],
    ['there is no host to ask', () => hootMcpCommand.mockRejectedValue(new Error('no bridge'))],
  ])('shows no command when %s', async (_label, arrange) => {
    arrange()
    open()

    await vi.waitFor(() => expect(hootMcpCommand).toHaveBeenCalledOnce())
    expect(screen.getByTestId('connect-agent-unavailable')).toBeTruthy()
    expect(screen.queryByTestId('connect-agent-command')).toBeNull()
  })

  it('does not ask the host until it is opened', () => {
    render(<ConnectAgentDialog open={false} onClose={vi.fn()} />)

    expect(hootMcpCommand).not.toHaveBeenCalled()
  })

  it('closes from its button', () => {
    const onClose = open()

    fireEvent.click(screen.getByRole('button', { name: 'done' }))

    expect(onClose).toHaveBeenCalledOnce()
  })
})
