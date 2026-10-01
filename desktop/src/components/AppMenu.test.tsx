import { fireEvent, render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const openOwlettePath = vi.fn()
const openExternalUrl = vi.fn()
const toastError = vi.fn()

vi.mock('@/lib/agentCli', () => ({
  openOwlettePath: (...args: unknown[]) => openOwlettePath(...args),
  openExternalUrl: (...args: unknown[]) => openExternalUrl(...args),
}))
vi.mock('sonner', () => ({ toast: { error: (...args: unknown[]) => toastError(...args) } }))

const { AppMenu, DOCS_URL, LOGS_DIR } = await import('./AppMenu')

function setup(paired: boolean) {
  const props = {
    paired,
    onJoinSite: vi.fn(),
    onLeaveSite: vi.fn(),
    onReportIssue: vi.fn(),
    onRestartService: vi.fn(),
    startOnLogin: true,
    onStartOnLoginChange: vi.fn(),
  }
  render(<AppMenu {...props} />)
  // jsdom has no PointerEvent constructor, so the trigger is opened from the
  // keyboard — the same path a keyboard operator takes.
  fireEvent.keyDown(screen.getByTestId('app-menu-trigger'), { key: 'Enter' })
  return props
}

beforeEach(() => {
  openOwlettePath.mockReset().mockResolvedValue(undefined)
  openExternalUrl.mockReset().mockResolvedValue(undefined)
  toastError.mockReset()
})

describe('AppMenu', () => {
  it('carries the four legacy overflow items, in order, in lowercase', async () => {
    setup(true)

    const items = await screen.findAllByRole('menuitem')
    // owlette_gui._toggle_overflow_menu listed config / logs / docs / feedback;
    // the site action is the row the legacy footer owned.
    expect(items.map((item) => item.textContent)).toEqual([
      'leave site',
      'config',
      'logs',
      'docs',
      'submit bug report',
      'restart service',
      'reload window',
    ])
  })

  it('offers joining when the machine has no site, and leaving when it has one', async () => {
    const unpaired = setup(false)
    fireEvent.click(await screen.findByTestId('menu-join-site'))
    expect(unpaired.onJoinSite).toHaveBeenCalledOnce()
    expect(screen.queryByTestId('menu-leave-site')).toBeNull()
  })

  it('routes leaving and feedback back to the app', async () => {
    const props = setup(true)

    fireEvent.click(await screen.findByTestId('menu-report-issue'))
    expect(props.onReportIssue).toHaveBeenCalledOnce()
  })

  it('opens config.json through the host, at the path the seam uses', async () => {
    setup(true)

    fireEvent.click(await screen.findByTestId('menu-config'))
    expect(openOwlettePath).toHaveBeenCalledExactlyOnceWith('config/config.json')
  })

  it('opens the logs folder through the host', async () => {
    setup(true)

    fireEvent.click(await screen.findByTestId('menu-logs'))
    expect(openOwlettePath).toHaveBeenCalledExactlyOnceWith(LOGS_DIR)
    expect(LOGS_DIR).toBe('logs')
  })

  it('opens the documentation in a browser, not in the window', async () => {
    setup(true)

    fireEvent.click(await screen.findByTestId('menu-docs'))
    expect(openExternalUrl).toHaveBeenCalledWith(DOCS_URL)
    expect(DOCS_URL).toBe('https://owlette.app/docs')
  })

  it('tells the operator when the shell refuses, instead of failing silently', async () => {
    openOwlettePath.mockRejectedValue(new Error('C:\\ProgramData\\Owlette\\logs does not exist'))
    setup(true)

    fireEvent.click(await screen.findByTestId('menu-logs'))
    await vi.waitFor(() => expect(toastError).toHaveBeenCalled())
    expect(toastError.mock.calls[0][0]).toBe('could not open the logs folder')
  })
})
