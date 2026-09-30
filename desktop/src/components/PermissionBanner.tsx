import { useEffect, type ReactNode } from 'react'
import { Button } from '@/components/ui/button'
import { InlineNotice } from '@/components/ui/inline-notice'

/** How often a showing accessibility notice asks again whether it still applies. */
const ACCESSIBILITY_RECHECK_MS = 5_000

/**
 * Says so, one notice per missing grant, when macOS has not granted this app
 * Screen Recording (tri-platform 4.4) or Accessibility (swoop-macos 2.3).
 *
 * Without Screen Recording the service refuses every remote screenshot and
 * swoop cannot see the screen, and nothing else on the machine says why. The
 * app asks once per launch (`tcc.rs`); after that the only way in is the
 * switch in System Settings, which this opens, and the grant takes effect on
 * the next launch — the notice says so rather than pretending otherwise.
 *
 * Without Accessibility swoop shows the screen but its input is dropped. The
 * app never asks for it on its own: the ask raises a system prompt, so it is
 * made only by this notice's button, which also opens the pane. That grant
 * takes effect at once, so while its notice shows it calls
 * `onRecheckAccessibility` every five seconds, and the notice clears without
 * the window losing and regaining focus. The callback must keep its identity
 * across renders, or the interval restarts before it ever fires.
 *
 * Each answer is null off macOS and before the first answer: nothing to say.
 */
export function PermissionBanner({
  screenRecording,
  accessibility,
  onOpenScreenRecordingSettings,
  onRequestAccessibility,
  onRecheckAccessibility,
}: {
  screenRecording: boolean | null
  accessibility: boolean | null
  onOpenScreenRecordingSettings: () => void
  onRequestAccessibility: () => void
  onRecheckAccessibility: () => void
}) {
  const accessibilityMissing = accessibility === false
  useEffect(() => {
    if (!accessibilityMissing) return
    const timer = window.setInterval(onRecheckAccessibility, ACCESSIBILITY_RECHECK_MS)
    return () => window.clearInterval(timer)
  }, [accessibilityMissing, onRecheckAccessibility])

  if (screenRecording !== false && !accessibilityMissing) return null
  return (
    <div className="m-3 space-y-3">
      {screenRecording === false && (
        <Notice testId="screen-recording-banner" onOpenSettings={onOpenScreenRecordingSettings}>
          screen recording is off for owlette on this mac: remote screenshots and swoop cannot see
          this screen. switch it on in system settings, then quit and reopen owlette.
        </Notice>
      )}
      {accessibilityMissing && (
        <Notice testId="accessibility-banner" onOpenSettings={onRequestAccessibility}>
          accessibility is off for owlette on this mac: swoop can show this screen but cannot
          control it. switch it on in system settings.
        </Notice>
      )}
    </div>
  )
}

function Notice({
  testId,
  onOpenSettings,
  children,
}: {
  testId: string
  onOpenSettings: () => void
  children: ReactNode
}) {
  return (
    <InlineNotice data-testid={testId}>
      <div className="flex flex-1 items-center justify-between gap-4">
        <p className="text-sm">{children}</p>
        <Button variant="outline" size="sm" className="shrink-0" onClick={onOpenSettings}>
          open system settings
        </Button>
      </div>
    </InlineNotice>
  )
}
