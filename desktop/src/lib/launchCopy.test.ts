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
    })
  })

  it('never shows windows words off windows', () => {
    for (const os of ['macos', 'linux'] as const) {
      expect(JSON.stringify(launchCopyFor(os))).not.toMatch(/\bexe\b|executable|\.bat|\.cmd/)
    }
  })
})
