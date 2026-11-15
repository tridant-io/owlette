import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const screenRecordingGranted = vi.fn()
const accessibilityGranted = vi.fn()
const clipboardSharing = vi.fn()
const openScreenRecordingSettings = vi.fn()
const requestAccessibility = vi.fn()
const requestClipboardSharing = vi.fn()

vi.mock('@/lib/ipc', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/ipc')>()),
  screenRecordingGranted: () => screenRecordingGranted(),
  accessibilityGranted: () => accessibilityGranted(),
  clipboardSharing: () => clipboardSharing(),
  openScreenRecordingSettings: () => openScreenRecordingSettings(),
  requestAccessibility: () => requestAccessibility(),
  requestClipboardSharing: () => requestClipboardSharing(),
}))

const { PermissionsPage } = await import('./PermissionsPage')

beforeEach(() => {
  screenRecordingGranted.mockReset().mockResolvedValue(true)
  accessibilityGranted.mockReset().mockResolvedValue(false)
  clipboardSharing.mockReset().mockResolvedValue(null)
  openScreenRecordingSettings.mockReset().mockResolvedValue(undefined)
  requestAccessibility.mockReset().mockResolvedValue(undefined)
  requestClipboardSharing.mockReset().mockResolvedValue(undefined)
})

describe('PermissionsPage', () => {
  it('says allowed or not allowed per row and hides an unknown answer', async () => {
    render(<PermissionsPage />)

    await waitFor(() => expect(screen.getByTestId('permission-accessibility')).toBeTruthy())
    expect(screen.getByText('swoop needs these to show and control this mac.')).toBeTruthy()
    expect(screen.getByTestId('permission-screen-recording').textContent).toBe('screen recordingallowed')
    expect(screen.getByTestId('permission-accessibility').textContent).toContain('not allowed')
    expect(screen.queryByTestId('permission-clipboard')).toBeNull()
  })

  it('asks only from a click, and only for what is missing', async () => {
    render(<PermissionsPage />)
    await waitFor(() => expect(screen.getByTestId('permission-accessibility')).toBeTruthy())
    expect(requestAccessibility).not.toHaveBeenCalled()

    fireEvent.click(screen.getByRole('button', { name: 'open system settings' }))

    expect(requestAccessibility).toHaveBeenCalledTimes(1)
  })

  it('keeps the relaunch note on screen recording', async () => {
    screenRecordingGranted.mockResolvedValue(false)
    render(<PermissionsPage />)

    await waitFor(() => expect(screen.getByTestId('permission-screen-recording')).toBeTruthy())
    expect(screen.getByText(/quit and reopen owlette/)).toBeTruthy()
    fireEvent.click(screen.getAllByRole('button', { name: 'open system settings' })[0])
    expect(openScreenRecordingSettings).toHaveBeenCalledTimes(1)
  })
})
