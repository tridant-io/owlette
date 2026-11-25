import { act, render } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ResolvedTheme } from '@/lib/theme'

let announce: ((theme: ResolvedTheme) => void) | undefined
const stop = vi.fn()

vi.mock('@/lib/ipc', () => ({
  onResolvedAppearance: (handler: (theme: ResolvedTheme) => void) => {
    announce = handler
    return Promise.resolve(stop)
  },
}))

const { HostTheme } = await import('./HostTheme')

afterEach(() => {
  document.documentElement.className = ''
  announce = undefined
})

describe('HostTheme', () => {
  it('draws the theme the host resolved, then follows what it announces', () => {
    const { unmount } = render(
      <HostTheme initial="light">
        <p>app</p>
      </HostTheme>,
    )
    expect(document.documentElement.classList.contains('light')).toBe(true)

    act(() => announce?.('dark'))
    expect(document.documentElement.classList.contains('dark')).toBe(true)
    expect(document.documentElement.classList.contains('light')).toBe(false)

    unmount()
  })
})
