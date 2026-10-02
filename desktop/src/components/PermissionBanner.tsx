import { useEffect, type ReactNode } from 'react'
import { Button } from '@/components/ui/button'
import { InlineNotice } from '@/components/ui/inline-notice'

/** How often a showing accessibility or clipboard notice asks again whether it still applies. */
const RECHECK_MS = 5_000

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
 * Without clipboard sharing (macOS 15.4's Paste from Other Apps, per app) the
 * swoop streamer never reads this Mac's pasteboard, so a viewer gets nothing
 * copied here. An app cannot grant that to itself, and macOS lists an app in
 * that pane only once it has read: the button makes one read, which raises
 * the system's paste alert, and opens the pane; the notice re-reads the
 * setting every five seconds while it shows.
 *
 * Each answer is null off macOS and before the first answer, and
 * Accessibility's is null when the app could not find out (`tcc.rs`):
 * nothing to say.
 */
export function PermissionBanner({
  screenRecording,
  accessibility,
  clipboardSharing,
  onOpenScreenRecordingSettings,
  onRequestAccessibility,
  onRecheckAccessibility,
  onRequestClipboardSharing,
  onRecheckClipboardSharing,
}: {
  screenRecording: boolean | null
  accessibility: boolean | null
  clipboardSharing: boolean | null
  onOpenScreenRecordingSettings: () => void
  onRequestAccessibility: () => void
  onRecheckAccessibility: () => void
  onRequestClipboardSharing: () => void
  onRecheckClipboardSharing: () => void
}) {
  const accessibilityMissing = accessibility === false
  const clipboardOff = clipboardSharing === false
  useEffect(() => {
    if (!accessibilityMissing) return
    const timer = window.setInterval(onRecheckAccessibility, RECHECK_MS)
    return () => window.clearInterval(timer)
  }, [accessibilityMissing, onRecheckAccessibility])
  useEffect(() => {
    if (!clipboardOff) return
    const timer = window.setInterval(onRecheckClipboardSharing, RECHECK_MS)
    return () => window.clearInterval(timer)
  }, [clipboardOff, onRecheckClipboardSharing])

  if (screenRecording !== false && !accessibilityMissing && !clipboardOff) return null
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
      {clipboardOff && (
        <Notice testId="clipboard-banner" onOpenSettings={onRequestClipboardSharing}>
          clipboard sharing is off for owlette on this mac: a swoop viewer gets nothing you copy here.
          allow the paste alert, then set owlette to allow under paste from other apps.
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
  // the button makes the row taller than a line of text, so the icon is
  // centred on the row rather than set against the first line, and loses the
  // nudge that lines it up with that line
  return (
    <InlineNotice data-testid={testId} className="items-center [&>svg]:mt-0">
      <div className="flex flex-1 items-center justify-between gap-4">
        <p className="text-sm">{children}</p>
        <Button variant="outline" size="sm" className="shrink-0" onClick={onOpenSettings}>
          open system settings
        </Button>
      </div>
    </InlineNotice>
  )
}
