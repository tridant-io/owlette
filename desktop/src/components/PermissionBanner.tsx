import { Button } from '@/components/ui/button'
import { InlineNotice } from '@/components/ui/inline-notice'

/**
 * Says so when macOS has not granted this app Screen Recording (tri-platform
 * 4.4). Without the grant the service refuses every remote screenshot and
 * swoop cannot see the screen, and nothing else on the machine says why. The
 * app asks once per launch (`tcc.rs`); after that the only way in is the
 * switch in System Settings, which this opens, and the grant takes effect on
 * the next launch — the notice says so rather than pretending otherwise.
 *
 * `granted` is null off macOS and before the first answer: nothing to say.
 */
export const SCREEN_RECORDING_SETTINGS_URL =
  'x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture'

export function PermissionBanner({
  granted,
  onOpenSettings,
}: {
  granted: boolean | null
  onOpenSettings: () => void
}) {
  if (granted !== false) return null
  return (
    <InlineNotice className="m-3" data-testid="screen-recording-banner">
      <div className="flex flex-1 flex-wrap items-center gap-3">
        <p className="text-sm">
          screen recording is off for owlette on this mac: remote screenshots and swoop cannot see
          this screen. switch it on in system settings, then quit and reopen owlette.
        </p>
        <Button variant="outline" size="sm" onClick={onOpenSettings}>
          open system settings
        </Button>
      </div>
    </InlineNotice>
  )
}
