/**
 * Native file and folder pickers.
 *
 * `@tauri-apps/plugin-dialog` opens the same Win32 common dialogs the legacy tkinter GUI
 * used, so an operator gets network paths, recent places and typed UNC instead of a
 * webview file input. Wrapped here (like ipc.ts) to keep filters and default-path rules
 * in one place per dialog.
 */

import { open } from '@tauri-apps/plugin-dialog'
import { launchCopy } from '@/lib/launchCopy'

/**
 * Where to open the picker. The current value is offered as the starting point, but a
 * path that no longer exists is dropped: Windows opens on the desktop when the default
 * path is bad, which looks like a bug.
 */
function startingPoint(current: string | undefined): string | undefined {
  const value = current?.trim()
  return value ? value : undefined
}

async function pickOne(options: Parameters<typeof open>[0]): Promise<string | null> {
  const picked = await open(options)
  if (Array.isArray(picked)) return picked[0] ?? null
  return typeof picked === 'string' ? picked : null
}

/** The executable, app or script the service should launch. */
export function pickExecutable(current?: string): Promise<string | null> {
  const copy = launchCopy()
  return pickOne({
    title: copy.pickerTitle,
    multiple: false,
    directory: false,
    defaultPath: startingPoint(current),
    filters: copy.pickerFilters,
  })
}

/** A document to hand the launch target — a `.toe` project, a playlist, anything. */
export function pickFile(current?: string): Promise<string | null> {
  return pickOne({
    title: launchCopy().filePickerTitle,
    multiple: false,
    directory: false,
    defaultPath: startingPoint(current),
  })
}

/** The working directory to launch in. */
export function pickDirectory(current?: string): Promise<string | null> {
  return pickOne({
    title: 'select a working directory',
    multiple: false,
    directory: true,
    defaultPath: startingPoint(current),
  })
}
