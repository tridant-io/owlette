import { describe, expect, it, vi } from 'vitest'

import {
  DROP_DEFAULTS,
  classifyDrop,
  compareVersionNames,
  toProcessEntry,
  type ClassifiedDrop,
  type DropResult,
  type FsProbe,
  type UnsupportedDrop,
} from './dropClassifier'
import { NEW_PROCESS_DEFAULTS } from './owletteConfig'

/**
 * An in-memory disk. Paths match case-insensitively with either separator, which is how
 * Windows behaves and how the classifier must read Tauri / python GUI paths.
 */
function makeFs(tree: { dirs?: string[]; files?: string[] } = {}) {
  const nodes = new Map<string, { name: string; parent: string; dir: boolean }>()

  function ensure(path: string, dir: boolean) {
    const normalized = path.replace(/\//g, '\\').replace(/\\+$/, '')
    if (!normalized || nodes.has(normalized.toLowerCase())) return

    const cut = normalized.lastIndexOf('\\')
    if (cut > 0) ensure(normalized.slice(0, cut), true)
    nodes.set(normalized.toLowerCase(), {
      name: cut === -1 ? normalized : normalized.slice(cut + 1),
      parent: cut === -1 ? '' : normalized.slice(0, cut).toLowerCase(),
      dir,
    })
  }

  for (const dir of tree.dirs ?? []) ensure(dir, true)
  for (const file of tree.files ?? []) ensure(file, false)

  const key = (path: string) => path.replace(/\//g, '\\').replace(/\\+$/, '').toLowerCase()

  return {
    exists: vi.fn(async (path: string) => nodes.has(key(path))),
    isDir: vi.fn(async (path: string) => nodes.get(key(path))?.dir === true),
    listDir: vi.fn(async (path: string) => {
      const node = nodes.get(key(path))
      if (!node?.dir) throw new Error(`not a directory: ${path}`)
      return [...nodes.values()]
        .filter((entry) => entry.parent === key(path))
        .map((entry) => entry.name)
    }),
  } satisfies FsProbe
}

/** Two TouchDesigner versions plus the empty folder an uninstall leaves behind. */
const DERIVATIVE = {
  dirs: ['C:\\Program Files\\Derivative\\TouchDesigner'],
  files: [
    'C:\\Program Files\\Derivative\\TouchDesigner.2023.12120\\bin\\TouchDesigner.exe',
    'C:\\Program Files\\Derivative\\TouchDesigner.2025.30060\\bin\\TouchDesigner.exe',
  ],
}

const NEWEST_TD = 'C:\\Program Files\\Derivative\\TouchDesigner.2025.30060\\bin\\TouchDesigner.exe'
const PY_LAUNCHER = 'C:\\Windows\\py.exe'
const POWERSHELL = 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe'

/** A Unity player build, complete with the extra executables one ships with. */
function unityBuild(root: string, product: string) {
  return {
    dirs: [`${root}\\${product}_Data`, `${root}\\MonoBleedingEdge`],
    files: [
      `${root}\\${product}.exe`,
      `${root}\\UnityCrashHandler64.exe`,
      `${root}\\UnityPlayer.dll`,
      `${root}\\${product}_Data\\app.info`,
    ],
  }
}

async function classifyOne(
  path: string,
  fs: FsProbe,
  options?: Parameters<typeof classifyDrop>[2],
): Promise<DropResult> {
  const [result] = await classifyDrop([path], fs, options)
  return result
}

function expectClassified(result: DropResult): ClassifiedDrop {
  if (result.kind === 'unsupported') {
    throw new Error(`expected a classified drop, got unsupported: ${result.reason}`)
  }
  return result
}

function expectUnsupported(result: DropResult): UnsupportedDrop {
  if (result.kind !== 'unsupported') throw new Error(`expected unsupported, got ${result.kind}`)
  return result
}

describe('touchdesigner projects', () => {
  it('opens a .toe with the newest install, from the project folder', async () => {
    const fs = makeFs({ ...DERIVATIVE, files: [...DERIVATIVE.files, 'C:\\shows\\Orientation.toe'] })

    const result = expectClassified(await classifyOne('C:\\shows\\Orientation.toe', fs))

    expect(result.kind).toBe('touchdesigner')
    expect(result.entry.exe_path).toBe(NEWEST_TD)
    // The project is an argument to TouchDesigner.exe, never the launch target:
    // file association would raise the "open with" dialog on the kiosk.
    expect(result.entry.file_path).toBe('C:\\shows\\Orientation.toe')
    // cwd is the project's own folder so its relative asset paths resolve.
    expect(result.entry.cwd).toBe('C:\\shows')
    expect(result.entry.name).toBe('orientation')
    expect(result.needsInput).toEqual([])
  })

  it('skips a version folder that has no TouchDesigner.exe left in it', async () => {
    // `C:\Program Files\Derivative\TouchDesigner` (unversioned, no bin) exists on
    // real machines after an upgrade — it must never win on name alone.
    const fs = makeFs({ ...DERIVATIVE, files: [...DERIVATIVE.files, 'C:\\shows\\a.toe'] })

    const result = expectClassified(await classifyOne('C:\\shows\\a.toe', fs))

    expect(result.entry.exe_path).toBe(NEWEST_TD)
  })

  it('orders versions numerically, not as strings', async () => {
    const fs = makeFs({
      files: [
        'C:\\Program Files\\Derivative\\TouchDesigner.2025.9999\\bin\\TouchDesigner.exe',
        'C:\\Program Files\\Derivative\\TouchDesigner.2025.30060\\bin\\TouchDesigner.exe',
        'C:\\shows\\a.toe',
      ],
    })

    const result = expectClassified(await classifyOne('C:\\shows\\a.toe', fs))

    // A plain string sort puts 9999 last and would pick the older build.
    expect(result.entry.exe_path).toBe(NEWEST_TD)
  })

  it('asks for an exe path when touchdesigner is not installed', async () => {
    const fs = makeFs({ files: ['C:\\shows\\Orientation.toe'] })

    const result = expectClassified(await classifyOne('C:\\shows\\Orientation.toe', fs))

    expect(result.kind).toBe('touchdesigner')
    expect(result.needsInput).toEqual(['exe_path'])
    expect(result.entry.exe_path).toBe('')
    // Everything else is still derived, so the operator only fills the one gap.
    expect(result.entry.file_path).toBe('C:\\shows\\Orientation.toe')
    expect(result.entry.cwd).toBe('C:\\shows')
  })

  it('honours a custom derivative root', async () => {
    const fs = makeFs({
      files: ['D:\\Apps\\TouchDesigner.2024.1\\bin\\TouchDesigner.exe', 'D:\\shows\\a.toe'],
    })

    const result = expectClassified(
      await classifyOne('D:\\shows\\a.toe', fs, { touchDesignerRoot: 'D:\\Apps' }),
    )

    expect(result.entry.exe_path).toBe('D:\\Apps\\TouchDesigner.2024.1\\bin\\TouchDesigner.exe')
  })
})

describe('unity builds', () => {
  it('classifies a build folder by its _Data pair', async () => {
    const fs = makeFs(unityBuild('C:\\builds\\Kiosk', 'Kiosk'))

    const result = expectClassified(await classifyOne('C:\\builds\\Kiosk', fs))

    expect(result.kind).toBe('unity')
    // UnityCrashHandler64.exe is the trap: the _Data folder names the player.
    expect(result.entry.exe_path).toBe('C:\\builds\\Kiosk\\Kiosk.exe')
    expect(result.entry.file_path).toBe('')
    expect(result.entry.cwd).toBe('C:\\builds\\Kiosk')
    expect(result.entry.name).toBe('kiosk')
    expect(result.needsInput).toEqual([])
  })

  it('prefers the player named after the folder when a build holds two', async () => {
    const build = unityBuild('C:\\builds\\Kiosk', 'Kiosk')
    const fs = makeFs({
      dirs: [...build.dirs, 'C:\\builds\\Kiosk\\Alpha_Data'],
      files: [...build.files, 'C:\\builds\\Kiosk\\Alpha.exe'],
    })

    const result = expectClassified(await classifyOne('C:\\builds\\Kiosk', fs))

    expect(result.entry.exe_path).toBe('C:\\builds\\Kiosk\\Kiosk.exe')
  })

  it('picks deterministically when no pair matches the folder name', async () => {
    const fs = makeFs({
      dirs: ['C:\\builds\\out\\Zeta_Data', 'C:\\builds\\out\\Alpha_Data'],
      files: ['C:\\builds\\out\\Zeta.exe', 'C:\\builds\\out\\Alpha.exe'],
    })

    const result = expectClassified(await classifyOne('C:\\builds\\out', fs))

    expect(result.entry.exe_path).toBe('C:\\builds\\out\\Alpha.exe')
  })

  it('ignores a _Data folder with no executable beside it', async () => {
    const fs = makeFs({
      dirs: ['C:\\builds\\Kiosk\\Orphan_Data', 'C:\\builds\\Kiosk\\Kiosk_Data'],
      files: ['C:\\builds\\Kiosk\\Kiosk.exe'],
    })

    const result = expectClassified(await classifyOne('C:\\builds\\Kiosk', fs))

    expect(result.entry.exe_path).toBe('C:\\builds\\Kiosk\\Kiosk.exe')
  })

  it('drops the trailing separator a folder drop can carry', async () => {
    const fs = makeFs(unityBuild('C:\\builds\\Kiosk', 'Kiosk'))

    const result = expectClassified(await classifyOne('C:\\builds\\Kiosk\\', fs))

    expect(result.entry.cwd).toBe('C:\\builds\\Kiosk')
    expect(result.entry.exe_path).toBe('C:\\builds\\Kiosk\\Kiosk.exe')
  })

  it('recognises a player dropped as the exe rather than the folder', async () => {
    const fs = makeFs(unityBuild('C:\\builds\\Kiosk', 'Kiosk'))

    const result = expectClassified(await classifyOne('C:\\builds\\Kiosk\\Kiosk.exe', fs))

    expect(result.kind).toBe('unity')
    expect(result.entry.exe_path).toBe('C:\\builds\\Kiosk\\Kiosk.exe')
    expect(result.entry.cwd).toBe('C:\\builds\\Kiosk')
  })

  it('rejects a folder that is not a build', async () => {
    const fs = makeFs({ files: ['C:\\media\\clips\\intro.mp4'] })

    const result = expectUnsupported(await classifyOne('C:\\media\\clips', fs))

    expect(result.reason).toBe(
      'this folder is not a unity build (no <name>.exe beside a <name>_Data folder)',
    )
  })

  it('treats a folder named .app as a folder on windows', async () => {
    const fs = makeFs({ files: ['C:\\tools\\viewer.app\\readme.txt'] })

    const result = expectUnsupported(await classifyOne('C:\\tools\\viewer.app', fs))

    expect(result.reason).toContain('unity build')
  })
})

describe('macos app bundles', () => {
  it('runs a dropped .app as the app, from its own folder', async () => {
    const fs = makeFs({ dirs: ['/Applications/Resolume Arena.app/Contents/MacOS'] })

    const result = expectClassified(
      await classifyOne('/Applications/Resolume Arena.app', fs, { os: 'macos' }),
    )

    expect(result.kind).toBe('executable')
    expect(result.entry.name).toBe('resolume arena')
    expect(result.entry.exe_path).toBe('/Applications/Resolume Arena.app')
    expect(result.entry.file_path).toBe('')
    expect(result.entry.cwd).toBe('/Applications')
    expect(result.needsInput).toEqual([])
  })

  it('names the app, not an exe, when the folder is not one', async () => {
    const fs = makeFs({ files: ['/Users/kiosk/media/intro.mp4'] })

    const result = expectUnsupported(await classifyOne('/Users/kiosk/media', fs, { os: 'macos' }))

    expect(result.reason).toBe('this folder is not an app — drop the .app itself')
  })

  it('refuses a folder on linux without windows words', async () => {
    const fs = makeFs({ files: ['/home/kiosk/media/intro.mp4'] })

    const result = expectUnsupported(await classifyOne('/home/kiosk/media', fs, { os: 'linux' }))

    expect(result.reason).toBe('owlette does not know how to launch a folder')
  })
})

describe('bare executables', () => {
  it('runs the exe from its own folder', async () => {
    const fs = makeFs({ files: ['C:\\Program Files\\Signage\\Player.exe'] })

    const result = expectClassified(await classifyOne('C:\\Program Files\\Signage\\Player.exe', fs))

    expect(result.kind).toBe('executable')
    expect(result.entry.exe_path).toBe('C:\\Program Files\\Signage\\Player.exe')
    expect(result.entry.file_path).toBe('')
    expect(result.entry.cwd).toBe('C:\\Program Files\\Signage')
    expect(result.entry.name).toBe('player')
    expect(result.needsInput).toEqual([])
  })

  it('keeps the drive root usable as a working directory', async () => {
    const fs = makeFs({ files: ['C:\\Player.exe'] })

    const result = expectClassified(await classifyOne('C:\\Player.exe', fs))

    // `C:` alone is the drive's current directory, not its root.
    expect(result.entry.cwd).toBe('C:\\')
  })
})

describe('scripts', () => {
  it('launches a .bat as the executable itself', async () => {
    const fs = makeFs({ files: ['C:\\ops\\Start Show.bat'] })

    const result = expectClassified(await classifyOne('C:\\ops\\Start Show.bat', fs))

    expect(result.kind).toBe('script')
    // process_launcher.py wraps a .bat given as exe_path in cmd.exe itself;
    // putting `/c <script>` in file_path would be rewritten by the service's
    // path validator into a bogus absolute path.
    expect(result.entry.exe_path).toBe('C:\\ops\\Start Show.bat')
    expect(result.entry.file_path).toBe('')
    expect(result.entry.cwd).toBe('C:\\ops')
    expect(result.entry.name).toBe('start show')
    expect(result.needsInput).toEqual([])
  })

  it('treats .cmd the same way', async () => {
    const fs = makeFs({ files: ['C:\\ops\\run.cmd'] })

    const result = expectClassified(await classifyOne('C:\\ops\\run.cmd', fs))

    expect(result.entry.exe_path).toBe('C:\\ops\\run.cmd')
    expect(result.entry.file_path).toBe('')
  })

  it('runs a .py through the py launcher', async () => {
    const fs = makeFs({ files: [PY_LAUNCHER, 'C:\\ops\\watchdog.py'] })

    const result = expectClassified(await classifyOne('C:\\ops\\watchdog.py', fs))

    expect(result.kind).toBe('script')
    expect(result.entry.exe_path).toBe(PY_LAUNCHER)
    expect(result.entry.file_path).toBe('C:\\ops\\watchdog.py')
    expect(result.entry.cwd).toBe('C:\\ops')
    expect(result.entry.name).toBe('watchdog')
  })

  it('falls back to the newest installed python when the launcher is missing', async () => {
    const fs = makeFs({
      files: [
        'C:\\Program Files\\Python39\\python.exe',
        'C:\\Program Files\\Python313\\python.exe',
        'C:\\ops\\watchdog.py',
      ],
    })

    const result = expectClassified(await classifyOne('C:\\ops\\watchdog.py', fs))

    // 3.13 beats 3.9 — the digits compare as numbers, not as text.
    expect(result.entry.exe_path).toBe('C:\\Program Files\\Python313\\python.exe')
  })

  it('asks for an exe path when no python is installed', async () => {
    const fs = makeFs({ files: ['C:\\ops\\watchdog.py'] })

    const result = expectClassified(await classifyOne('C:\\ops\\watchdog.py', fs))

    expect(result.needsInput).toEqual(['exe_path'])
    expect(result.entry.exe_path).toBe('')
    expect(result.entry.file_path).toBe('C:\\ops\\watchdog.py')
  })

  it('runs a .ps1 through powershell', async () => {
    const fs = makeFs({ files: [POWERSHELL, 'C:\\ops\\health.ps1'] })

    const result = expectClassified(await classifyOne('C:\\ops\\health.ps1', fs))

    expect(result.entry.exe_path).toBe(POWERSHELL)
    expect(result.entry.file_path).toBe('C:\\ops\\health.ps1')
    expect(result.warnings).toEqual([])
  })

  it('warns when a .ps1 path contains spaces', async () => {
    const fs = makeFs({ files: [POWERSHELL, 'C:\\ops scripts\\health.ps1'] })

    const result = expectClassified(await classifyOne('C:\\ops scripts\\health.ps1', fs))

    // powershell strips the quotes and then reads the spaced path as a command
    // plus arguments — verified against the real powershell.exe.
    expect(result.warnings).toHaveLength(1)
    expect(result.warnings[0]).toContain('spaces')
  })

  it('asks for an exe path when powershell is missing', async () => {
    const fs = makeFs({ files: ['C:\\ops\\health.ps1'] })

    const result = expectClassified(await classifyOne('C:\\ops\\health.ps1', fs))

    expect(result.needsInput).toEqual(['exe_path'])
  })
})

describe('unsupported drops', () => {
  it('names the extension it cannot launch', async () => {
    const fs = makeFs({ files: ['C:\\art\\poster.psd'] })

    const result = expectUnsupported(await classifyOne('C:\\art\\poster.psd', fs))

    expect(result.reason).toContain('.psd')
  })

  it('handles a file with no extension', async () => {
    const fs = makeFs({ files: ['C:\\ops\\README'] })

    const result = expectUnsupported(await classifyOne('C:\\ops\\README', fs))

    expect(result.reason).toContain('no extension')
  })

  it('reports a path that has already gone', async () => {
    const result = expectUnsupported(await classifyOne('C:\\shows\\gone.toe', makeFs()))

    expect(result.reason).toContain('no longer exists')
  })

  it('turns a failing probe into one unsupported result, not a rejected batch', async () => {
    const fs = makeFs({ files: ['C:\\shows\\a.toe'] })
    fs.exists.mockRejectedValueOnce(new Error('access is denied'))

    const [first, second] = await classifyDrop(['C:\\locked\\x.toe', 'C:\\shows\\a.toe'], fs)

    expect(expectUnsupported(first).reason).toContain('access is denied')
    expect(second.kind).toBe('touchdesigner')
  })
})

describe('multi-path drops', () => {
  it('classifies a mixed drop, preserving the drop order', async () => {
    const build = unityBuild('C:\\builds\\Kiosk', 'Kiosk')
    const fs = makeFs({
      dirs: [...DERIVATIVE.dirs, ...build.dirs],
      files: [
        ...DERIVATIVE.files,
        ...build.files,
        PY_LAUNCHER,
        'C:\\shows\\Orientation.toe',
        'C:\\ops\\watchdog.py',
        'C:\\art\\poster.psd',
      ],
    })

    const results = await classifyDrop(
      [
        'C:\\shows\\Orientation.toe',
        'C:\\builds\\Kiosk',
        'C:\\builds\\Kiosk\\UnityCrashHandler64.exe',
        'C:\\ops\\watchdog.py',
        'C:\\art\\poster.psd',
      ],
      fs,
    )

    expect(results.map((result) => result.kind)).toEqual([
      'touchdesigner',
      'unity',
      'executable',
      'script',
      'unsupported',
    ])
  })

  it('probes for touchdesigner once no matter how many projects are dropped', async () => {
    const fs = makeFs({
      ...DERIVATIVE,
      files: [...DERIVATIVE.files, 'C:\\shows\\a.toe', 'C:\\shows\\b.toe', 'C:\\shows\\c.toe'],
    })

    await classifyDrop(['C:\\shows\\a.toe', 'C:\\shows\\b.toe', 'C:\\shows\\c.toe'], fs)

    // The resolver memoises the in-flight promise, so concurrent paths share
    // the scan instead of racing three of them.
    const scans = fs.listDir.mock.calls.filter(([path]) => path === 'C:\\Program Files\\Derivative')
    expect(scans).toHaveLength(1)
  })

  it('returns an empty list for an empty drop without touching the disk', async () => {
    const fs = makeFs()

    await expect(classifyDrop([], fs)).resolves.toEqual([])
    expect(fs.exists).not.toHaveBeenCalled()
  })
})

describe('config schema', () => {
  it('emits exactly the fields the python service writes', async () => {
    const fs = makeFs({ ...DERIVATIVE, files: [...DERIVATIVE.files, 'C:\\shows\\Orientation.toe'] })

    const result = expectClassified(await classifyOne('C:\\shows\\Orientation.toe', fs))

    // Field-for-field mirror of owlette_gui.py's new-process dict, minus the id
    // the confirm step mints. Numbers are strings on purpose — that is the shape
    // every existing entry in config.json has.
    expect(result.entry).toEqual({
      name: 'orientation',
      exe_path: NEWEST_TD,
      file_path: 'C:\\shows\\Orientation.toe',
      cwd: 'C:\\shows',
      priority: 'Normal',
      visibility: 'Normal',
      time_delay: '0',
      time_to_init: '10',
      relaunch_attempts: '5',
      launch_mode: 'off',
      autolaunch: false,
      schedules: null,
    })
  })

  it('starts every dropped process unsupervised', () => {
    // A drop configures a process; it never starts one behind the operator.
    expect(DROP_DEFAULTS.launch_mode).toBe('off')
    expect(DROP_DEFAULTS.autolaunch).toBe(false)
  })

  it('gives a dropped process the same numbers as one added with the + button', () => {
    // Two creation paths in one app, one set of defaults.
    expect(DROP_DEFAULTS.time_delay).toBe(NEW_PROCESS_DEFAULTS.time_delay)
    expect(DROP_DEFAULTS.time_to_init).toBe(NEW_PROCESS_DEFAULTS.time_to_init)
    expect(DROP_DEFAULTS.relaunch_attempts).toBe(NEW_PROCESS_DEFAULTS.relaunch_attempts)
  })

  it('adds the id ahead of the rest of the entry', async () => {
    const fs = makeFs({ files: ['C:\\Program Files\\Signage\\Player.exe'] })
    const result = expectClassified(await classifyOne('C:\\Program Files\\Signage\\Player.exe', fs))

    const entry = toProcessEntry(result.entry, 'f0d9-…')

    expect(entry.id).toBe('f0d9-…')
    expect(Object.keys(entry)[0]).toBe('id')
    expect(entry.exe_path).toBe('C:\\Program Files\\Signage\\Player.exe')
  })

  it('preserves forward-slash paths rather than mixing separators', async () => {
    const fs = makeFs({ files: ['C:/shows/Orientation.toe'] })

    const result = expectClassified(await classifyOne('C:/shows/Orientation.toe', fs))

    expect(result.entry.cwd).toBe('C:/shows')
  })

  it('reads a leading dot as the name, not as an extension', async () => {
    const fs = makeFs({ files: ['C:\\shows\\.toe'] })

    const result = expectUnsupported(await classifyOne('C:\\shows\\.toe', fs))

    // A leading dot is the whole name, not an extension — so this is not a
    // project at all and must not become an entry with an empty name.
    expect(result.reason).toContain('no extension')
  })
})

describe('compareVersionNames', () => {
  it('compares digit runs as numbers', () => {
    expect(compareVersionNames('TouchDesigner.2023.12120', 'TouchDesigner.2025.30060')).toBe(-1)
    expect(compareVersionNames('TouchDesigner.2025.30060', 'TouchDesigner.2025.9999')).toBe(1)
    expect(compareVersionNames('Python39', 'Python313')).toBe(-1)
  })

  it('sorts an unversioned name oldest', () => {
    expect(compareVersionNames('TouchDesigner', 'TouchDesigner.2023.12120')).toBe(-1)
  })

  it('ignores case in the text runs', () => {
    expect(compareVersionNames('touchdesigner.2025.1', 'TouchDesigner.2025.1')).toBe(0)
  })

  it('orders a whole directory listing newest last', () => {
    const sorted = ['TouchDesigner.2025.9999', 'TouchDesigner', 'TouchDesigner.2025.30060'].sort(
      compareVersionNames,
    )

    expect(sorted).toEqual([
      'TouchDesigner',
      'TouchDesigner.2025.9999',
      'TouchDesigner.2025.30060',
    ])
  })
})
