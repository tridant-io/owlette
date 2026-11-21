import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const hootMcpCommand = vi.fn()
let isMac = false

vi.mock('@/lib/platform', () => ({
  get IS_MAC() {
    return isMac
  },
  IS_LINUX: false,
}))
vi.mock('@/lib/ipc', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/ipc')>()),
  hootMcpCommand: () => hootMcpCommand(),
  appearanceTheme: () => Promise.resolve('system'),
  setAppearanceTheme: () => Promise.resolve('system'),
  fleetState: () => Promise.resolve(null),
  hootTools: () => Promise.resolve([]),
  onHootToolsSynced: () => Promise.resolve(() => {}),
  screenRecordingGranted: () => Promise.resolve(true),
  accessibilityGranted: () => Promise.resolve(true),
  clipboardSharing: () => Promise.resolve(true),
}))

const { SettingsDialog } = await import('./SettingsDialog')

function show(props: Partial<Parameters<typeof SettingsDialog>[0]> = {}) {
  render(
    <SettingsDialog
      open
      onOpenChange={vi.fn()}
      paired
      siteName="TEC"
      pending={false}
      startOnLogin={false}
      onStartOnLoginChange={vi.fn()}
      onTurnOn={vi.fn()}
      onTurnOff={vi.fn()}
      {...props}
    />,
  )
}

const navItem = (name: string) => screen.queryByRole('button', { name })

beforeEach(() => {
  isMac = false
  hootMcpCommand.mockReset().mockResolvedValue(['/py', '/fleet_mcp.py'])
})

describe('SettingsDialog', () => {
  it('has a title and opens on general', async () => {
    show()

    expect(screen.getByRole('dialog', { name: 'settings' })).toBeTruthy()
    await screen.findByRole('button', { name: 'hoot mcp' })
    expect(navItem('general')?.getAttribute('aria-current')).toBe('page')
    expect(navItem('hoot mcp')?.getAttribute('aria-current')).toBeNull()
  })

  it('switches pages from the nav', async () => {
    show()
    await screen.findByRole('button', { name: 'hoot mcp' })
    expect(screen.getByRole('radiogroup', { name: 'appearance' })).toBeTruthy()

    fireEvent.click(screen.getByRole('button', { name: 'hoot mcp' }))

    expect(navItem('hoot mcp')?.getAttribute('aria-current')).toBe('page')
    expect(navItem('general')?.getAttribute('aria-current')).toBeNull()
    expect(screen.queryByRole('radiogroup', { name: 'appearance' })).toBeNull()
    expect(screen.getByRole('switch', { name: /act on other machines in TEC/ })).toBeTruthy()
  })

  it('hides permissions off macOS', async () => {
    show()
    await screen.findByRole('button', { name: 'hoot mcp' })
    expect(navItem('permissions')).toBeNull()
  })

  it('shows permissions on macOS', async () => {
    isMac = true
    show()

    fireEvent.click(screen.getByRole('button', { name: 'permissions' }))

    expect(await screen.findByText('swoop needs these to show and control this mac.')).toBeTruthy()
  })

  it('hides the hoot mcp page where the host has no command', async () => {
    hootMcpCommand.mockResolvedValue(null)
    show()

    await waitFor(() => expect(hootMcpCommand).toHaveBeenCalled())
    expect(navItem('hoot mcp')).toBeNull()
    expect(navItem('general')?.getAttribute('aria-current')).toBe('page')
  })
})
