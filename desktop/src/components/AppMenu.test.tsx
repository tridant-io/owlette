import { fireEvent, render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const openOwlettePath = vi.fn()
const openExternalUrl = vi.fn()
const toastError = vi.fn()
const appearanceTheme = vi.fn()
const setAppearanceTheme = vi.fn()
const swoopViewerInstalled = vi.fn()
const openSwoopViewer = vi.fn()

vi.mock('@/lib/agentCli', () => ({
  openOwlettePath: (...args: unknown[]) => openOwlettePath(...args),
  openExternalUrl: (...args: unknown[]) => openExternalUrl(...args),
}))
vi.mock('@/lib/ipc', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/ipc')>()),
  appearanceTheme: () => appearanceTheme(),
  setAppearanceTheme: (theme: string) => setAppearanceTheme(theme),
  swoopViewerInstalled: () => swoopViewerInstalled(),
  openSwoopViewer: () => openSwoopViewer(),
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

/** opens the appearance submenu from the keyboard, as the root menu is opened */
async function openAppearance() {
  fireEvent.keyDown(await screen.findByTestId('menu-appearance'), { key: 'ArrowRight' })
  return screen.findAllByRole('menuitemradio')
}

function checked(theme: string) {
  return screen.getByTestId(`menu-appearance-${theme}`).getAttribute('aria-checked')
}

beforeEach(() => {
  openOwlettePath.mockReset().mockResolvedValue(undefined)
  openExternalUrl.mockReset().mockResolvedValue(undefined)
  toastError.mockReset()
  appearanceTheme.mockReset().mockResolvedValue('system')
  setAppearanceTheme.mockReset().mockImplementation((theme: string) => Promise.resolve(theme))
  swoopViewerInstalled.mockReset().mockResolvedValue(false)
  openSwoopViewer.mockReset().mockResolvedValue(undefined)
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
      'appearance',
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

describe('AppMenu swoop', () => {
  it('leads the menu with swoop when owlette swoop is installed, and opens it', async () => {
    swoopViewerInstalled.mockResolvedValue(true)
    setup(true)

    const swoop = await screen.findByTestId('menu-swoop')
    expect(screen.getAllByRole('menuitem')[0]).toBe(swoop)
    expect(swoop.textContent).toBe('swoop')

    fireEvent.click(swoop)
    expect(openSwoopViewer).toHaveBeenCalledOnce()
  })

  it('has no swoop row when owlette swoop is not installed', async () => {
    setup(true)

    await vi.waitFor(() => expect(swoopViewerInstalled).toHaveBeenCalledOnce())
    await screen.findByTestId('menu-leave-site')
    expect(screen.queryByTestId('menu-swoop')).toBeNull()
  })

  it('has no swoop row when the host cannot say', async () => {
    swoopViewerInstalled.mockRejectedValue(new Error('no bridge'))
    setup(true)

    await vi.waitFor(() => expect(swoopViewerInstalled).toHaveBeenCalledOnce())
    await screen.findByTestId('menu-leave-site')
    expect(screen.queryByTestId('menu-swoop')).toBeNull()
  })

  it('tells the operator when owlette swoop will not open', async () => {
    swoopViewerInstalled.mockResolvedValue(true)
    openSwoopViewer.mockRejectedValue('owlette swoop is not installed')
    setup(true)

    fireEvent.click(await screen.findByTestId('menu-swoop'))
    await vi.waitFor(() => expect(toastError).toHaveBeenCalled())
    expect(toastError).toHaveBeenCalledWith('could not open the owlette swoop desktop app', {
      description: 'owlette swoop is not installed',
    })
  })
})

describe('AppMenu appearance', () => {
  it('offers system, dark and light, and opens on the stored choice', async () => {
    appearanceTheme.mockResolvedValue('light')
    setup(true)

    const options = await openAppearance()
    expect(options.map((option) => option.textContent)).toEqual(['system', 'dark', 'light'])
    await vi.waitFor(() => expect(checked('light')).toBe('true'))
    expect(checked('system')).toBe('false')
    expect(checked('dark')).toBe('false')
  })

  it('follows the system when the host cannot say what is stored', async () => {
    appearanceTheme.mockRejectedValue(new Error('no bridge'))
    setup(true)

    await openAppearance()
    expect(checked('system')).toBe('true')
  })

  it('hands the choice to the host, which themes the window', async () => {
    setup(true)

    await openAppearance()
    fireEvent.click(screen.getByTestId('menu-appearance-dark'))
    expect(setAppearanceTheme).toHaveBeenCalledExactlyOnceWith('dark')
  })

  it('opens outside the menu panel, which would otherwise clip it', async () => {
    // the panel's backdrop-blur makes it the containing block for the fixed
    // submenu, and its overflow then hides everything past its right edge:
    // the owner saw a highlighted "appearance" row and no submenu
    setup(true)

    await openAppearance()
    const panel = screen.getByTestId('menu-appearance').closest('[data-slot="dropdown-menu-content"]')
    const submenu = screen.getByTestId('menu-appearance-dark').closest('[data-slot="dropdown-menu-sub-content"]')
    expect(panel).not.toBeNull()
    expect(submenu).not.toBeNull()
    expect(panel!.contains(submenu)).toBe(false)
  })
})
