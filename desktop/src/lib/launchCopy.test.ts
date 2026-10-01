import { describe, expect, it } from 'vitest'
import { launchCopyFor } from './launchCopy'

describe('launchCopyFor', () => {
  it('keeps the windows wording the app has always shown', () => {
    expect(launchCopyFor('windows')).toEqual({
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
      priorityTooltip:
        'windows cpu priority for this process — leave normal unless it must outrank everything else',
      visibilityTooltip:
        'window visibility on launch — hidden suppresses the console window (ideal for background scripts); apps that create their own windows stay visible',
    })
  })

  it('calls it an app on macos and offers every file, bundles included', () => {
    expect(launchCopyFor('macos')).toEqual({
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
      priorityTooltip:
        'owlette sets cpu priority on windows only — on this machine the process runs at normal priority',
      visibilityTooltip:
        'owlette hides console windows on windows only — on this machine the process opens as it normally would',
    })
  })

  it('calls it a program on linux and offers every file, extensionless binaries included', () => {
    expect(launchCopyFor('linux')).toEqual({
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
      priorityTooltip:
        'owlette sets cpu priority on windows only — on this machine the process runs at normal priority',
      visibilityTooltip:
        'owlette hides console windows on windows only — on this machine the process opens as it normally would',
    })
  })

  it('never shows windows words off windows', () => {
    for (const os of ['macos', 'linux'] as const) {
      expect(JSON.stringify(launchCopyFor(os))).not.toMatch(/\bexe\b|executable|\.bat|\.cmd|unity build/)
    }
  })
})
