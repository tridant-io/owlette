import { Monitor, Moon, Sun, type LucideIcon } from 'lucide-react'
import { useCallback, useEffect, useState } from 'react'
import { Switch } from '@/components/ui/switch'
import { appearanceTheme, setAppearanceTheme } from '@/lib/ipc'
import { cn } from '@/lib/utils'
import { DEFAULT_THEME, THEMES, type ThemeChoice } from '@/lib/theme'
import { SettingsRow } from './SettingsRow'

const THEME_ICONS: Record<ThemeChoice, LucideIcon> = { system: Monitor, dark: Moon, light: Sun }

/**
 * Appearance and start on login. The host owns the appearance: it stores the
 * choice and re-themes the window, and the page follows.
 */
export function GeneralPage({
  startOnLogin,
  onStartOnLoginChange,
}: {
  /** null until the host answers: the row stays hidden. */
  startOnLogin: boolean | null
  onStartOnLoginChange: (enabled: boolean) => void
}) {
  const [appearance, setAppearance] = useState<ThemeChoice>(DEFAULT_THEME)

  useEffect(() => {
    let disposed = false
    void appearanceTheme()
      .then((stored) => {
        if (!disposed) setAppearance(stored)
      })
      .catch(() => {
        // no bridge (browser dev run) or an unreadable file: the default stands
      })
    return () => {
      disposed = true
    }
  }, [])

  const choose = useCallback((next: ThemeChoice) => {
    setAppearance(next)
    // the host re-themes the window before it writes, so a failed write costs
    // only the next launch, as with the other layout preferences
    void setAppearanceTheme(next).catch(() => {})
  }, [])

  return (
    <div className="divide-y">
      <SettingsRow label="appearance">
        {/* the same segmented look as the process editor's launch mode */}
        <div
          role="radiogroup"
          aria-label="appearance"
          className="flex w-fit overflow-hidden rounded-lg border border-border bg-card"
        >
          {THEMES.map((theme) => {
            const Icon = THEME_ICONS[theme]
            const active = theme === appearance
            return (
              <button
                key={theme}
                type="button"
                role="radio"
                aria-checked={active}
                data-testid={`settings-appearance-${theme}`}
                onClick={() => choose(theme)}
                className={cn(
                  'flex h-8 cursor-pointer items-center gap-1.5 px-3 text-xs font-medium transition-colors outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset',
                  active ? 'bg-accent text-foreground' : 'text-muted-foreground hover:bg-muted/50',
                )}
              >
                <Icon aria-hidden className="size-3.5" />
                {theme}
              </button>
            )
          })}
        </div>
      </SettingsRow>
      {startOnLogin !== null && (
        <SettingsRow
          label="start on login"
          hint="the tray menu has the same switch."
          htmlFor="settings-start-on-login"
        >
          <Switch
            id="settings-start-on-login"
            checked={startOnLogin}
            onCheckedChange={onStartOnLoginChange}
          />
        </SettingsRow>
      )}
    </div>
  )
}
