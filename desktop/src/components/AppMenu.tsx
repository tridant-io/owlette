import {
  BookOpen,
  Bug,
  FileCog,
  LogIn,
  LogOut,
  Menu,
  MonitorPlay,
  RotateCcw,
  RotateCw,
  ScrollText,
  Settings,
} from 'lucide-react'
import { useCallback, useEffect, useState } from 'react'
import { toast } from 'sonner'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { openExternalUrl, openOwlettePath } from '@/lib/agentCli'
import { OWLETTE_FILES, openSwoopViewer, swoopViewerInstalled } from '@/lib/ipc'
import { MENU_SURFACE } from '@/lib/surfaces'

/** Where the logs the operator wants live, relative to the data root. */
export const LOGS_DIR = 'logs'

/** Public docs — both environments read the same site. */
export const DOCS_URL = 'https://owlette.app/docs'

interface AppMenuProps {
  /** True when this machine belongs to a site — decides join vs leave. */
  paired: boolean
  onJoinSite: () => void
  onLeaveSite: () => void
  onReportIssue: () => void
  onOpenSettings: () => void
  /**
   * Restart the service without elevation: restart.flag on windows, the polkit
   * rule's `systemctl restart` on linux, a request to the daemon on macos.
   */
  onRestartService: () => void
}

/**
 * The overflow menu: swoop, then docs, submit issue, config and logs, then
 * settings with the recovery pair, and the site action last on its own.
 *
 * The site action lives BOTH here and in the footer, for different readers —
 * this menu is where someone who knows the app looks for `leave site`, the
 * footer's `join site` is for someone who doesn't know the menu exists. The
 * footer shows only `join`, and only while the service is up, so it never
 * competes with `start service`.
 *
 * Opening a file/folder/link goes through the host (`src-tauri/src/shell_open.rs`);
 * nothing is spawned from here.
 *
 * settings opens the app's settings window: appearance, start on login, hoot mcp
 * and, on a mac, permissions all live there rather than in the menu.
 *
 * swoop opens owlette swoop, the viewer app, and leads the menu: it is the row
 * people reach for. it is there only when the host finds the app installed.
 */
export function AppMenu({
  paired,
  onJoinSite,
  onLeaveSite,
  onReportIssue,
  onOpenSettings,
  onRestartService,
}: AppMenuProps) {
  const open = useCallback((path: string, what: string) => {
    void openOwlettePath(path).catch((cause: unknown) => {
      toast.error(`could not open ${what}`, {
        description: cause instanceof Error ? cause.message : String(cause),
      })
    })
  }, [])

  const openDocs = useCallback(() => {
    void openExternalUrl(DOCS_URL).catch((cause: unknown) => {
      toast.error('could not open the documentation', {
        description: cause instanceof Error ? cause.message : String(cause),
      })
    })
  }, [])

  const openSwoop = useCallback(() => {
    void openSwoopViewer().catch((cause: unknown) => {
      toast.error('could not open the owlette swoop desktop app', {
        description: cause instanceof Error ? cause.message : String(cause),
      })
    })
  }, [])

  const [swoopInstalled, setSwoopInstalled] = useState(false)

  useEffect(() => {
    let disposed = false
    void swoopViewerInstalled()
      .then((installed) => {
        if (!disposed) setSwoopInstalled(installed)
      })
      .catch(() => {
        // no bridge: no app to open, so the row stays hidden
      })
    return () => {
      disposed = true
    }
  }, [])

  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        aria-label="menu"
        data-testid="app-menu-trigger"
        className="inline-flex h-full w-[46px] items-center justify-center text-muted-foreground transition-colors hover:bg-accent hover:text-foreground focus-visible:outline-hidden"
      >
        <Menu className="size-4" />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className={`${MENU_SURFACE} w-52`}>
        {swoopInstalled && (
          <>
            <DropdownMenuItem data-testid="menu-swoop" onSelect={openSwoop}>
              <MonitorPlay aria-hidden className="size-4" />
              swoop
            </DropdownMenuItem>
            <DropdownMenuSeparator />
          </>
        )}
        <DropdownMenuItem data-testid="menu-docs" onSelect={openDocs}>
          <BookOpen aria-hidden className="size-4" />
          docs
        </DropdownMenuItem>
        <DropdownMenuItem data-testid="menu-report-issue" onSelect={onReportIssue}>
          <Bug aria-hidden className="size-4" />
          submit issue
        </DropdownMenuItem>
        <DropdownMenuItem
          data-testid="menu-config"
          onSelect={() => open(OWLETTE_FILES.config, 'config.json')}
        >
          <FileCog aria-hidden className="size-4" />
          config
        </DropdownMenuItem>
        <DropdownMenuItem data-testid="menu-logs" onSelect={() => open(LOGS_DIR, 'the logs folder')}>
          <ScrollText aria-hidden className="size-4" />
          logs
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuItem data-testid="menu-settings" onSelect={onOpenSettings}>
          <Settings aria-hidden className="size-4" />
          settings
        </DropdownMenuItem>
        {/* Recovery pair, escalating: the same restart the tray asks for,
            surfaced here for operators who never right-click a tray icon. */}
        <DropdownMenuItem data-testid="menu-restart-service" onSelect={onRestartService}>
          <RotateCcw aria-hidden className="size-4" />
          restart service
        </DropdownMenuItem>
        {/* Safe last resort: every pane is a view over service-owned files, so a
            reload rebuilds from disk truth. */}
        <DropdownMenuItem data-testid="menu-reload" onSelect={() => window.location.reload()}>
          <RotateCw aria-hidden className="size-4" />
          reload window
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        {paired ? (
          <DropdownMenuItem data-testid="menu-leave-site" onSelect={onLeaveSite}>
            <LogOut aria-hidden className="size-4" />
            leave site
          </DropdownMenuItem>
        ) : (
          <DropdownMenuItem data-testid="menu-join-site" onSelect={onJoinSite}>
            <LogIn aria-hidden className="size-4" />
            join site
          </DropdownMenuItem>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
