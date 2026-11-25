import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const appearanceTheme = vi.fn()
const setAppearanceTheme = vi.fn()

vi.mock('@/lib/ipc', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/ipc')>()),
  appearanceTheme: () => appearanceTheme(),
  setAppearanceTheme: (theme: string) => setAppearanceTheme(theme),
}))

const { GeneralPage } = await import('./GeneralPage')

beforeEach(() => {
  appearanceTheme.mockReset().mockResolvedValue('dark')
  setAppearanceTheme.mockReset().mockResolvedValue('light')
})

describe('GeneralPage', () => {
  it('marks the stored appearance and saves a new choice', async () => {
    render(<GeneralPage startOnLogin={null} onStartOnLoginChange={vi.fn()} />)
    await waitFor(() =>
      expect(screen.getByTestId('settings-appearance-dark').getAttribute('aria-checked')).toBe('true'),
    )

    fireEvent.click(screen.getByTestId('settings-appearance-light'))

    expect(setAppearanceTheme).toHaveBeenCalledWith('light')
    expect(screen.getByTestId('settings-appearance-light').getAttribute('aria-checked')).toBe('true')
  })

  it('hides start on login until the host answers', () => {
    render(<GeneralPage startOnLogin={null} onStartOnLoginChange={vi.fn()} />)
    expect(screen.queryByRole('switch', { name: 'start on login' })).toBeNull()
  })

  it('flips start on login', () => {
    const onChange = vi.fn()
    render(<GeneralPage startOnLogin={true} onStartOnLoginChange={onChange} />)

    const toggle = screen.getByRole('switch', { name: 'start on login' })
    expect(toggle.getAttribute('aria-checked')).toBe('true')
    expect(screen.getByText('the tray menu has the same switch.')).toBeTruthy()
    fireEvent.click(toggle)

    expect(onChange).toHaveBeenCalledWith(false)
  })
})
