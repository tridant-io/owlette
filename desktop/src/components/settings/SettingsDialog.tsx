import { Plug, ShieldCheck, SlidersHorizontal, type LucideIcon } from 'lucide-react'
import { useEffect, useState } from 'react'
import { Dialog, DialogContent, DialogTitle } from '@/components/ui/dialog'
import { hootMcpCommand } from '@/lib/ipc'
import { IS_MAC } from '@/lib/platform'
import { cn } from '@/lib/utils'
import { GeneralPage } from './GeneralPage'
import { HootMcpPage } from './HootMcpPage'
import { PermissionsPage } from './PermissionsPage'

export type SettingsPage = 'general' | 'hoot' | 'permissions'

const PAGES: Record<SettingsPage, { title: string; Icon: LucideIcon }> = {
  general: { title: 'general', Icon: SlidersHorizontal },
  hoot: { title: 'hoot mcp', Icon: Plug },
  permissions: { title: 'permissions', Icon: ShieldCheck },
}

export interface SettingsDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  /** True when this machine belongs to a site. */
  paired: boolean
  siteName: string | null
  /** App asked an admin to allow hoot mcp and has not yet seen the grant. */
  pending: boolean
  /** Run-on-login state, null until the host answers, hiding the row. */
  startOnLogin: boolean | null
  onStartOnLoginChange: (enabled: boolean) => void
  /** The switch was turned on: App confirms, then opens the admin panel. */
  onTurnOn: () => void
  /** The switch was turned off: App confirms, then drops the grant. */
  onTurnOff: () => void
}

/**
 * The app's settings in pages: general, hoot mcp (where the host has a command
 * for it) and, on a mac, the permissions swoop needs. Changes apply as they are
 * made; there is nothing to save. The hoot mcp switch only asks: App owns the
 * confirms and the calls that turn it on or off.
 */
export function SettingsDialog({ open, onOpenChange, ...rest }: SettingsDialogProps) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        aria-describedby={undefined}
        data-testid="settings-dialog"
        className="gap-0 overflow-hidden p-0 sm:max-w-2xl"
      >
        <SettingsPages {...rest} />
      </DialogContent>
    </Dialog>
  )
}

function SettingsPages({
  paired,
  siteName,
  pending,
  startOnLogin,
  onStartOnLoginChange,
  onTurnOn,
  onTurnOff,
}: Omit<SettingsDialogProps, 'open' | 'onOpenChange'>) {
  const [page, setPage] = useState<SettingsPage>('general')
  const [command, setCommand] = useState<string[] | null>(null)

  useEffect(() => {
    let disposed = false
    void hootMcpCommand()
      .then((parts) => {
        if (!disposed) setCommand(parts)
      })
      .catch(() => {
        // no bridge (a browser dev run): no command, so no hoot mcp page
      })
    return () => {
      disposed = true
    }
  }, [])

  const pages: SettingsPage[] = ['general']
  if (command) pages.push('hoot')
  if (IS_MAC) pages.push('permissions')
  const current = pages.includes(page) ? page : 'general'

  return (
    // one height for every page, capped by the window, so switching pages never
    // resizes the dialog and a tall page scrolls instead of leaving the window
    <div className="grid h-[min(30rem,calc(100dvh-4rem))] grid-rows-[auto_minmax(0,1fr)] sm:grid-cols-[10rem_minmax(0,1fr)] sm:grid-rows-1">
      <nav
        aria-label="settings pages"
        className="flex flex-col gap-0.5 border-b bg-card-sunken p-2 sm:border-r sm:border-b-0 sm:p-3"
      >
        <DialogTitle className="px-2 pt-1 pb-2 max-sm:sr-only">settings</DialogTitle>
        <ul className="flex gap-0.5 overflow-x-auto sm:flex-col">
          {pages.map((id) => {
            const { title, Icon } = PAGES[id]
            return (
              <li key={id}>
                <button
                  type="button"
                  aria-current={id === current ? 'page' : undefined}
                  onClick={() => setPage(id)}
                  className={cn(
                    'flex w-full cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 text-sm whitespace-nowrap text-muted-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring',
                    id === current && 'bg-accent text-foreground',
                  )}
                >
                  <Icon aria-hidden className="size-4 shrink-0" />
                  {title}
                </button>
              </li>
            )
          })}
        </ul>
      </nav>
      <div className="min-h-0 min-w-0 overflow-y-auto p-5">
        <h2 className="pb-2 pr-8 text-base font-semibold">{PAGES[current].title}</h2>
        {current === 'general' && (
          <GeneralPage startOnLogin={startOnLogin} onStartOnLoginChange={onStartOnLoginChange} />
        )}
        {current === 'hoot' && command && (
          <HootMcpPage
            command={command}
            paired={paired}
            siteName={siteName}
            pending={pending}
            onTurnOn={onTurnOn}
            onTurnOff={onTurnOff}
          />
        )}
        {current === 'permissions' && <PermissionsPage />}
      </div>
    </div>
  )
}
