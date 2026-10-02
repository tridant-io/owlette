import { fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { PermissionBanner } from '@/components/PermissionBanner'

function banner(
  screenRecording: boolean | null,
  accessibility: boolean | null,
  clipboardSharing: boolean | null = true,
) {
  const openScreenRecording = vi.fn()
  const requestAccessibility = vi.fn()
  const recheckAccessibility = vi.fn()
  const openClipboard = vi.fn()
  const recheckClipboard = vi.fn()
  const element = (recording: boolean | null, access: boolean | null, clip: boolean | null = clipboardSharing) => (
    <PermissionBanner
      screenRecording={recording}
      accessibility={access}
      onOpenScreenRecordingSettings={openScreenRecording}
      onRequestAccessibility={requestAccessibility}
      onRecheckAccessibility={recheckAccessibility}
      clipboardSharing={clip}
      onOpenClipboardSettings={openClipboard}
      onRecheckClipboardSharing={recheckClipboard}
    />
  )
  const rendered = render(element(screenRecording, accessibility))
  const answer = (recording: boolean | null, access: boolean | null, clip?: boolean | null) =>
    rendered.rerender(element(recording, access, clip))
  return {
    ...rendered,
    answer,
    openScreenRecording,
    requestAccessibility,
    recheckAccessibility,
    openClipboard,
    recheckClipboard,
  }
}

afterEach(() => {
  vi.useRealTimers()
})

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

  it('asks again every five seconds while the accessibility notice shows, and stops once granted', () => {
    vi.useFakeTimers()
    const { answer, recheckAccessibility } = banner(true, false)
    vi.advanceTimersByTime(4_999)
    expect(recheckAccessibility).not.toHaveBeenCalled()
    vi.advanceTimersByTime(1)
    expect(recheckAccessibility).toHaveBeenCalledTimes(1)
    vi.advanceTimersByTime(5_000)
    expect(recheckAccessibility).toHaveBeenCalledTimes(2)

    answer(true, true)
    expect(screen.queryByTestId('accessibility-banner')).toBeNull()
    vi.advanceTimersByTime(60_000)
    expect(recheckAccessibility).toHaveBeenCalledTimes(2)
  })

  it('names the consequence and opens the setting when clipboard sharing is off', () => {
    const { openClipboard, openScreenRecording, requestAccessibility } = banner(true, true, false)
    expect(screen.getByTestId('clipboard-banner').textContent).toMatch(/clipboard sharing is off/i)
    expect(screen.getByTestId('clipboard-banner').textContent).toMatch(/paste from other apps/i)
    expect(screen.queryByTestId('accessibility-banner')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: /open system settings/i }))
    expect(openClipboard).toHaveBeenCalledTimes(1)
    expect(openScreenRecording).not.toHaveBeenCalled()
    expect(requestAccessibility).not.toHaveBeenCalled()
  })

  it('asks again every five seconds while the clipboard notice shows, and stops once allowed', () => {
    vi.useFakeTimers()
    const { answer, recheckClipboard } = banner(true, true, false)
    vi.advanceTimersByTime(5_000)
    expect(recheckClipboard).toHaveBeenCalledTimes(1)
    answer(true, true, true)
    expect(screen.queryByTestId('clipboard-banner')).toBeNull()
    vi.advanceTimersByTime(60_000)
    expect(recheckClipboard).toHaveBeenCalledTimes(1)
  })

  it('never asks again on a timer when there is no accessibility notice', () => {
    vi.useFakeTimers()
    for (const [screenRecording, accessibility] of [
      [null, null],
      [true, true],
      [false, true],
      [false, null],
    ] as const) {
      const { recheckAccessibility, unmount } = banner(screenRecording, accessibility)
      vi.advanceTimersByTime(60_000)
      expect(recheckAccessibility).not.toHaveBeenCalled()
      unmount()
    }
  })
})
