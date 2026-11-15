import { useCallback, useEffect, useState } from 'react'
import { Button } from '@/components/ui/button'
import {
  accessibilityGranted,
  clipboardSharing,
  openScreenRecordingSettings,
  requestAccessibility,
  requestClipboardSharing,
  screenRecordingGranted,
} from '@/lib/ipc'

type Answers = { screenRecording: boolean | null; accessibility: boolean | null; clipboard: boolean | null }

/**
 * What macOS has granted this app, the same three answers the permission
 * banner acts on, with the same click-only actions: asking can raise a system
 * prompt, so it never happens on its own. A null answer (not a mac, or macOS
 * could not say) shows no row. The answers are read again when the window
 * regains focus, which is how a grant made in System Settings shows up.
 */
export function PermissionsPage() {
  const [answers, setAnswers] = useState<Answers>({
    screenRecording: null,
    accessibility: null,
    clipboard: null,
  })

  const read = useCallback(() => {
    void Promise.all([screenRecordingGranted(), accessibilityGranted(), clipboardSharing()])
      .then(([screenRecording, accessibility, clipboard]) =>
        setAnswers({ screenRecording, accessibility, clipboard }),
      )
      .catch(() => {
        // no bridge: nothing to show
      })
  }, [])

  useEffect(() => {
    read()
    window.addEventListener('focus', read)
    return () => window.removeEventListener('focus', read)
  }, [read])

  const act = (ask: () => Promise<void>) => () => {
    void ask()
      .catch(() => {})
      .then(read)
  }

  return (
    <div className="flex flex-col">
      <p className="pb-2 text-sm text-muted-foreground">
        swoop needs these to show and control this mac.
      </p>
      {answers.screenRecording !== null && (
        <PermissionRow
          name="screen recording"
          testId="permission-screen-recording"
          allowed={answers.screenRecording}
          onAsk={act(openScreenRecordingSettings)}
          note="switch it on in system settings, then quit and reopen owlette."
        />
      )}
      {answers.accessibility !== null && (
        <PermissionRow
          name="accessibility"
          testId="permission-accessibility"
          allowed={answers.accessibility}
          onAsk={act(requestAccessibility)}
        />
      )}
      {answers.clipboard !== null && (
        <PermissionRow
          name="clipboard sharing"
          testId="permission-clipboard"
          allowed={answers.clipboard}
          onAsk={act(requestClipboardSharing)}
        />
      )}
    </div>
  )
}

function PermissionRow({
  name,
  testId,
  allowed,
  onAsk,
  note,
}: {
  name: string
  testId: string
  allowed: boolean
  onAsk: () => void
  note?: string
}) {
  return (
    <div data-testid={testId} className="flex flex-col gap-1 border-t py-3">
      <div className="flex items-center gap-3">
        <span className="flex-1 text-sm">{name}</span>
        <span className={allowed ? 'text-sm text-success' : 'text-sm text-warning'}>
          {allowed ? 'allowed' : 'not allowed'}
        </span>
        {!allowed && (
          <Button type="button" size="sm" variant="outline" onClick={onAsk}>
            open system settings
          </Button>
        )}
      </div>
      {!allowed && note && <p className="text-xs text-muted-foreground">{note}</p>}
    </div>
  )
}
