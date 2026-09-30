/**
 * the words for the launch target, per desktop. the saved field is `exe_path` on
 * every platform, but what it holds is an .exe on windows, an .app bundle on macos
 * and a binary on linux, so only the copy changes.
 */

import type { DialogFilter } from '@tauri-apps/plugin-dialog'
import { IS_LINUX, IS_MAC } from '@/lib/platform'

export type DesktopOs = 'windows' | 'macos' | 'linux'

export interface LaunchCopy {
  label: string
  tooltip: string
  placeholder: string
  browseAria: string
  /** the path / args row's tooltip, which names the launch target */
  fileTooltip: string
  pickerTitle: string
  pickerFilters: DialogFilter[]
  /** the path / args row's picker */
  filePickerTitle: string
}

const COPY: Record<DesktopOs, LaunchCopy> = {
  windows: {
    label: 'exe',
    tooltip: 'the full path to the executable or script to run (.exe, .bat, .cmd)',
    placeholder: 'the full path to your executable',
    browseAria: 'browse for an executable',
    fileTooltip: 'a file for the exe to open (e.g. a .toe project), or extra command-line arguments',
    pickerTitle: 'select an executable or script',
    pickerFilters: [
      { name: 'executables & scripts', extensions: ['exe', 'bat', 'cmd', 'com'] },
      { name: 'all files', extensions: ['*'] },
    ],
    filePickerTitle: 'select a file to open with this executable',
  },
  // no filters on macos or linux: the dialog plugin (rfd) cannot say "all files"
  // there. macos merges every filter into one allow-list where `*` is a literal
  // extension, and gtk turns `*` into `*.*`, so either way an extensionless
  // binary would be greyed out or hidden. unfiltered, an .app bundle still picks
  // as a single file, since the open panel treats packages as files.
  macos: {
    label: 'app',
    tooltip: 'the app bundle, program or script to run (.app, a binary, .sh, .command)',
    placeholder: '/Applications/YourApp.app',
    browseAria: 'browse for an app',
    fileTooltip: 'a file for the app to open (e.g. a .toe project), or extra command-line arguments',
    pickerTitle: 'select an app, program or script',
    pickerFilters: [],
    filePickerTitle: 'select a file to open with this app',
  },
  linux: {
    label: 'program',
    tooltip: 'the program or script to run (a binary, .sh, .AppImage)',
    placeholder: '/usr/bin/your-program',
    browseAria: 'browse for a program',
    fileTooltip: 'a file for the program to open (e.g. a .toe project), or extra command-line arguments',
    pickerTitle: 'select a program or script',
    pickerFilters: [],
    filePickerTitle: 'select a file to open with this program',
  },
}

export function launchCopyFor(os: DesktopOs): LaunchCopy {
  return COPY[os]
}

/** the running desktop's copy */
export function launchCopy(): LaunchCopy {
  return COPY[IS_MAC ? 'macos' : IS_LINUX ? 'linux' : 'windows']
}
