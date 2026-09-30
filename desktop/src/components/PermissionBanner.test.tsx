import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { PermissionBanner } from '@/components/PermissionBanner'

function banner(screenRecording: boolean | null, accessibility: boolean | null) {
  const openScreenRecording = vi.fn()
  const requestAccessibility = vi.fn()
  const rendered = render(
    <PermissionBanner
      screenRecording={screenRecording}
      accessibility={accessibility}
      onOpenScreenRecordingSettings={openScreenRecording}
      onRequestAccessibility={requestAccessibility}
    />,
  )
  return { ...rendered, openScreenRecording, requestAccessibility }
}

describe('PermissionBanner', () => {
  it('says nothing off macos or before the first answer', () => {
    expect(banner(null, null).container.innerHTML).toBe('')
  })

  it('says nothing while both grants are held', () => {
    expect(banner(true, true).container.innerHTML).toBe('')
  })

  it('names the consequence and opens the setting when screen recording is missing', () => {
    const { openScreenRecording, requestAccessibility } = banner(false, true)
    expect(screen.getByTestId('screen-recording-banner').textContent).toMatch(/screen recording is off/i)
    expect(screen.getByTestId('screen-recording-banner').textContent).toMatch(/quit and reopen/i)
    expect(screen.queryByTestId('accessibility-banner')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: /open system settings/i }))
    expect(openScreenRecording).toHaveBeenCalledTimes(1)
    expect(requestAccessibility).not.toHaveBeenCalled()
  })

  it('names the consequence and asks for the grant when accessibility is missing', () => {
    const { openScreenRecording, requestAccessibility } = banner(true, false)
    expect(screen.getByTestId('accessibility-banner').textContent).toBe(
      'accessibility is off for owlette on this mac: swoop can show this screen but cannot control it. ' +
        'switch it on in system settings.open system settings',
    )
    expect(screen.queryByTestId('screen-recording-banner')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: /open system settings/i }))
    expect(requestAccessibility).toHaveBeenCalledTimes(1)
    expect(openScreenRecording).not.toHaveBeenCalled()
  })

  it('shows one notice per missing grant, each with its own button', () => {
    const { openScreenRecording, requestAccessibility } = banner(false, false)
    const buttons = screen.getAllByRole('button', { name: /open system settings/i })
    expect(buttons).toHaveLength(2)
    fireEvent.click(buttons[1])
    expect(requestAccessibility).toHaveBeenCalledTimes(1)
    expect(openScreenRecording).not.toHaveBeenCalled()
    fireEvent.click(buttons[0])
    expect(openScreenRecording).toHaveBeenCalledTimes(1)
  })
})
