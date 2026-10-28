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
  /** what a drop with no program found is told to point at */
  missingTarget: string
  /** the same, for a touchdesigner project whose touchdesigner was not found */
  missingTouchDesigner: string
  /** the field in a sentence: "<name> has no exe path" */
  pathName: string
  /** why an entry with no launch target cannot leave `off` */
  pathRequired: string
  /** why a dropped folder was not added */
  folderRefusal: string
  /** the empty process list's drop hint, naming only what a drop can add here */
  dropHint: string
  /**
   * whether the priority and visibility controls exist here: the service applies
   * both on windows only (`osadapter.posix.launch_managed_process` ignores them),
   * so elsewhere they are not shown at all
   */
  launchOptions: boolean
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
    missingTarget: 'the executable',
    missingTouchDesigner: 'TouchDesigner.exe',
    pathName: 'exe path',
    pathRequired: 'an exe path is required before a launch mode can be set',
    folderRefusal: 'this folder is not a unity build (no <name>.exe beside a <name>_Data folder)',
    dropHint:
      'drag an app, a script, a touchdesigner project or a unity build folder anywhere in this window to add it',
    launchOptions: true,
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
    missingTarget: 'the app',
    missingTouchDesigner: 'TouchDesigner.app',
    pathName: 'app path',
    pathRequired: 'an app path is required before a launch mode can be set',
    folderRefusal: 'this folder is not an app — drop the .app itself',
    dropHint: 'drag an app or a touchdesigner project anywhere in this window to add it',
    launchOptions: false,
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
    missingTarget: 'the program',
    missingTouchDesigner: 'touchdesigner',
    pathName: 'program path',
    pathRequired: 'a program path is required before a launch mode can be set',
    folderRefusal: 'owlette does not know how to launch a folder',
    dropHint: 'drag a python script anywhere in this window to add it',
    launchOptions: false,
  },
}

export function launchCopyFor(os: DesktopOs): LaunchCopy {
  return COPY[os]
}

/** the running desktop */
export function desktopOs(): DesktopOs {
  return IS_MAC ? 'macos' : IS_LINUX ? 'linux' : 'windows'
}

/** the running desktop's copy */
export function launchCopy(): LaunchCopy {
  return COPY[desktopOs()]
}
