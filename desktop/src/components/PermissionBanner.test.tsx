import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { PermissionBanner } from '@/components/PermissionBanner'

describe('PermissionBanner', () => {
  it('says nothing off macos or before the first answer', () => {
    const { container } = render(<PermissionBanner granted={null} onOpenSettings={() => {}} />)
    expect(container.innerHTML).toBe('')
  })

  it('says nothing while the grant is held', () => {
    const { container } = render(<PermissionBanner granted={true} onOpenSettings={() => {}} />)
    expect(container.innerHTML).toBe('')
  })

  it('names the consequence and opens the setting when the grant is missing', () => {
    const open = vi.fn()
    render(<PermissionBanner granted={false} onOpenSettings={open} />)
    expect(screen.getByTestId('screen-recording-banner').textContent).toMatch(/screen recording is off/i)
    expect(screen.getByTestId('screen-recording-banner').textContent).toMatch(/quit and reopen/i)
    fireEvent.click(screen.getByRole('button', { name: /open system settings/i }))
    expect(open).toHaveBeenCalledTimes(1)
  })
})
