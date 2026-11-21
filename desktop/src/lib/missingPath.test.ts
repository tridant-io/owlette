import { describe, expect, it } from 'vitest'
import type { PathStatus } from '@/lib/ipc'
import type { DesktopOs } from '@/lib/launchCopy'
import { findMissingPath, nearestExistingFolder, withArgs, type PathField, type PathProbe } from '@/lib/missingPath'

function disk(
  files: string[] = [],
  folders: string[] = [],
  unknown: string[] = [],
  links: Record<string, PathStatus> = {},
): PathProbe {
  return async (path) =>
    links[path] ??
    (unknown.includes(path)
      ? 'unknown'
      : files.includes(path)
        ? 'file'
        : folders.includes(path)
          ? 'folder'
          : 'missing')
}

const noDisk: PathProbe = async (path) => {
  throw new Error(`probed ${path}`)
}

describe('findMissingPath, path / args', () => {
  const find = (value: string, probe: PathProbe, os: DesktopOs = 'windows') =>
    findMissingPath('file_path', value, probe, os)

  it('names the path and the nearest folder', async () => {
    expect(await find('C:\\show\\gone\\main.toe', disk([], ['C:\\show']))).toEqual({
      value: 'C:\\show\\gone\\main.toe',
      path: 'C:\\show\\gone\\main.toe',
      folder: 'C:\\show',
      rest: '',
      problem: 'missing',
    })
  })

  it.each([
    ['"C:\\my show\\gone.toe" --fullscreen', 'C:\\my show\\gone.toe', '--fullscreen'],
    ['C:\\my show\\gone.toe --fullscreen', 'C:\\my show\\gone.toe', '--fullscreen'],
    ['C:\\show\\gone.exe /S', 'C:\\show\\gone.exe', '/S'],
    ['C:/show/gone.py 8000', 'C:/show/gone.py', '8000'],
    ['C:/show/gone.py 8000 --fast', 'C:/show/gone.py', '8000 --fast'],
    ['C:/show/gone.py 127.0.0.1', 'C:/show/gone.py', '127.0.0.1'],
    ['C:/show/gone.py --config a.json', 'C:/show/gone.py', '--config a.json'],
    ['C:/shows/Show v1.2 final.toe', 'C:/shows/Show v1.2 final.toe', ''],
    ['C:/shows/Show v1.2', 'C:/shows/Show v1.2', ''],
    ['C:/show -v2/gone.toe', 'C:/show -v2/gone.toe', ''],
  ])('splits %s into the path and its arguments', async (value, path, rest) => {
    expect(await find(value, disk())).toMatchObject({ path, rest })
  })

  it.each([
    ['C:/show/sub --x', 'C:/show/sub'],
    ['"C:/my show/dir" 8000', 'C:/my show/dir'],
    ['C:/show/sub.v2 8000', 'C:/show/sub.v2'],
  ])('says nothing about %s: a folder that exists, followed by arguments', async (value, folder) => {
    expect(await find(value, disk([], [folder]))).toBeNull()
  })

  it('takes a link to a folder followed by arguments for the folder it is', async () => {
    expect(await find('C:/show/sub --x', disk([], [], [], { 'C:/show/sub': 'folder-link' }))).toBeNull()
  })

  it('says nothing when the whole value is a file, a dash in its folder included', async () => {
    const path = 'C:/Users/me/OneDrive - Acme/show/main.toe'
    expect(await find(path, disk([path]))).toBeNull()
  })

  it('keeps a dash with spaces in the path when it names a missing one', async () => {
    const path = 'C:/Users/me/OneDrive - Acme/gone.toe'
    expect(await find(path, disk())).toMatchObject({ path, rest: '' })
  })

  it.each([
    ['C:/show/run.py 8000', 'C:/show/run.py'],
    ['C:/show/setup.exe /S', 'C:/show/setup.exe'],
    ['"C:/my show/run.py" 8000', 'C:/my show/run.py'],
  ])('says nothing about %s: a file on disk followed by arguments', async (value, file) => {
    expect(await find(value, disk([file]))).toBeNull()
  })

  it('does not take a folder that a space happens to end for the file', async () => {
    expect(await find('C:\\show dir\\gone.toe', disk([], ['C:\\show']))).toMatchObject({
      path: 'C:\\show dir\\gone.toe',
    })
  })

  it.each(['', '  ', '--fullscreen', '-f C:\\show\\main.toe', 'scripts\\run.py', '%USERPROFILE%\\show\\main.toe', '/S'])(
    'says nothing about %j: arguments and relative paths',
    async (value) => {
      expect(await find(value, disk())).toBeNull()
    },
  )

  it('says nothing when the machine could not answer, as a dead mapped drive cannot', async () => {
    expect(await find('Z:\\main.toe', disk([], [], ['Z:\\main.toe']))).toBeNull()
  })

  it('allows a folder: the agent hands it over as an argument', async () => {
    expect(await find('C:\\show', disk([], ['C:\\show']))).toBeNull()
  })

  it('reads paths off windows too', async () => {
    expect(await find('"/opt/my show/gone" --x', disk([], ['/opt']), 'linux')).toMatchObject({
      path: '/opt/my show/gone',
      folder: '/opt',
      rest: '--x',
    })
    expect(await find('$HOME/show/run', disk(), 'linux')).toBeNull()
  })
})

describe('findMissingPath, the launch target', () => {
  const find = (value: string, probe: PathProbe) => findMissingPath('exe_path', value, probe, 'windows')

  it('takes the whole value as the path: it carries no arguments', async () => {
    expect(await find('C:\\apps\\my app - v2.exe', disk())).toMatchObject({ path: 'C:\\apps\\my app - v2.exe', rest: '' })
    expect(await find('C:\\apps\\my app - v2.exe', disk(['C:\\apps\\my app - v2.exe']))).toBeNull()
  })

  it.each(['python', '%ProgramFiles%\\x.exe', '~/run'])('warns about %s: the agent launches no target that is not absolute', async (value) => {
    expect(await find(value, disk())).toEqual({ value, path: value, folder: null, rest: '', problem: 'missing' })
  })
})

describe('findMissingPath, the working directory', () => {
  it('warns about a missing absolute folder and leaves a relative one alone', async () => {
    expect(await findMissingPath('cwd', 'D:\\gone\\deeper', disk([], ['D:\\']), 'windows')).toMatchObject({ folder: 'D:\\' })
    expect(await findMissingPath('cwd', 'deeper', disk(), 'windows')).toBeNull()
  })
})

describe('findMissingPath, the wrong kind of thing', () => {
  it('warns about a folder as the launch target, and browses inside it', async () => {
    expect(await findMissingPath('exe_path', 'C:\\apps\\player', disk([], ['C:\\apps\\player']), 'windows')).toEqual({
      value: 'C:\\apps\\player',
      path: 'C:\\apps\\player',
      folder: 'C:\\apps\\player',
      rest: '',
      problem: 'folder',
    })
  })

  it.each(['/Applications/Player.app', '/Applications/Player.app/'])('takes %s as a launch target on macos', async (value) => {
    expect(await findMissingPath('exe_path', value, disk([], [value]), 'macos')).toBeNull()
  })

  it.each<[DesktopOs, string]>([
    ['macos', '/Applications/Player'],
    ['linux', '/opt/Player.app'],
    ['windows', 'C:\\apps\\Player.app'],
  ])('warns on %s about the folder %s: only a macos bundle launches', async (os, value) => {
    expect(await findMissingPath('exe_path', value, disk([], [value]), os)).toMatchObject({ problem: 'folder' })
  })

  it('warns about a file as the working directory, and browses in its parent', async () => {
    expect(await findMissingPath('cwd', 'C:\\show\\main.toe', disk(['C:\\show\\main.toe']), 'windows')).toEqual({
      value: 'C:\\show\\main.toe',
      path: 'C:\\show\\main.toe',
      folder: 'C:\\show',
      rest: '',
      problem: 'file',
    })
  })

  it('says nothing about the right kind of thing', async () => {
    expect(await findMissingPath('exe_path', 'C:\\apps\\player.exe', disk(['C:\\apps\\player.exe']), 'windows')).toBeNull()
    expect(await findMissingPath('cwd', 'C:\\show', disk([], ['C:\\show']), 'windows')).toBeNull()
  })
})

describe('findMissingPath, a network path', () => {
  const SHARES = ['\\\\server\\share\\main.toe', '//server/share/main.toe']

  it.each(SHARES.flatMap((path) => (['exe_path', 'file_path', 'cwd'] as const).map((field) => [field, path] as const)))(
    'warns about %s %s on windows without touching the disk',
    async (field, path) => {
      expect(await findMissingPath(field, path, noDisk, 'windows')).toEqual({
        value: path,
        path,
        folder: null,
        rest: '',
        problem: 'network',
      })
    },
  )

  it('keeps the arguments after a network path', async () => {
    expect(await findMissingPath('file_path', '\\\\server\\share\\main.toe --fullscreen', noDisk, 'windows')).toMatchObject({
      path: '\\\\server\\share\\main.toe',
      rest: '--fullscreen',
      problem: 'network',
    })
  })

  it('says nothing about a quoted share: the agent only refuses a value that starts with the slashes', async () => {
    expect(await findMissingPath('file_path', '"\\\\server\\my share\\main.toe" --fullscreen', noDisk, 'windows')).toBeNull()
  })

  it.each<[PathField, string]>([
    ['exe_path', '/\\server\\share\\main.exe'],
    ['file_path', '\\/server/share/main.toe'],
  ])('warns about %s %s: the agent turns its slashes round before checking', async (field, value) => {
    expect(await findMissingPath(field, value, noDisk, 'windows')).toMatchObject({ problem: 'network' })
  })

  it('says nothing about a working directory of /\\server\\share: the agent checks that field as typed', async () => {
    expect(await findMissingPath('cwd', '/\\server\\share', noDisk, 'windows')).toBeNull()
  })

  it.each<[PathField, string]>([
    ['exe_path', '\\\\?\\C:\\apps\\player.exe'],
    ['cwd', '\\\\.\\pipe\\show'],
    ['file_path', '//flag'],
    ['cwd', '\\\\server'],
  ])('does not call %s %s a network path, though the agent refuses it', async (field, value) => {
    expect(await findMissingPath(field, value, noDisk, 'windows')).toMatchObject({ problem: 'refused', folder: null })
  })

  it.each(['--project \\\\server\\share\\main.toe', '-f //server/share/main.toe', '/S'])(
    'says nothing about %s: arguments that mention a share',
    async (value) => {
      expect(await findMissingPath('file_path', value, disk(), 'windows')).toBeNull()
    },
  )

  it.each<DesktopOs>(['macos', 'linux'])('reads //server/share as an ordinary path on %s: the agent refuses no such thing', async (os) => {
    const path = '//server/share/main.toe'
    expect(await findMissingPath('exe_path', path, disk([path]), os)).toBeNull()
    expect(await findMissingPath('exe_path', path, disk(), os)).toMatchObject({ problem: 'missing' })
    expect(await findMissingPath('cwd', '\\\\server\\share', noDisk, os)).toBeNull()
  })
})

describe('findMissingPath, a symbolic link', () => {
  const LINK = '/opt/show/link'
  const WINDOWS_LINK = 'C:\\show\\link'
  const LINK_STATUSES: PathStatus[] = ['file-link', 'folder-link', 'broken-link']

  it.each(LINK_STATUSES)('warns about a launch target or working directory that is a %s, everywhere', async (status) => {
    for (const field of ['exe_path', 'cwd'] as const) {
      expect(await findMissingPath(field, WINDOWS_LINK, disk([], [], [], { [WINDOWS_LINK]: status }), 'windows')).toEqual({
        value: WINDOWS_LINK,
        path: WINDOWS_LINK,
        folder: 'C:\\show',
        rest: '',
        problem: 'link',
      })
      expect(await findMissingPath(field, LINK, disk([], [], [], { [LINK]: status }), 'linux')).toMatchObject({
        folder: '/opt/show',
        problem: 'link',
      })
    }
  })

  it.each(LINK_STATUSES)('warns about path / args that is a %s on windows: the agent checks the whole value', async (status) => {
    expect(await findMissingPath('file_path', WINDOWS_LINK, disk([], [], [], { [WINDOWS_LINK]: status }), 'windows')).toMatchObject({
      folder: 'C:\\show',
      problem: 'link',
    })
  })

  it.each<[DesktopOs, PathStatus, boolean]>([
    ['linux', 'file-link', true],
    ['macos', 'file-link', true],
    ['linux', 'folder-link', false],
    ['linux', 'broken-link', false],
    ['macos', 'folder-link', false],
    ['macos', 'broken-link', false],
  ])('on %s, path / args that is a %s warns: %s. off windows only a link to a file is refused', async (os, status, warns) => {
    const found = await findMissingPath('file_path', LINK, disk([], [], [], { [LINK]: status }), os)
    expect(found?.problem ?? null).toBe(warns ? 'link' : null)
  })

  it('says nothing about a link followed by arguments: the agent never reads it as a path', async () => {
    const links: Record<string, PathStatus> = { 'C:\\show\\run.py': 'file-link' }
    expect(await findMissingPath('file_path', 'C:\\show\\run.py 8000', disk([], [], [], links), 'windows')).toBeNull()
  })
})

describe('nearestExistingFolder', () => {
  it('walks up past every folder that is gone', async () => {
    expect(await nearestExistingFolder('C:\\show\\old\\v2\\main.toe', disk([], ['C:\\show']))).toBe('C:\\show')
  })

  it('stops at the drive', async () => {
    expect(await nearestExistingFolder('D:\\gone\\main.toe', disk([], ['D:\\']))).toBe('D:\\')
  })

  it('takes a link to a folder for the folder it is', async () => {
    expect(await nearestExistingFolder('C:\\link\\gone\\main.toe', disk([], [], [], { 'C:\\link': 'folder-link' }))).toBe('C:\\link')
  })

  it('stops at the root off windows', async () => {
    expect(await nearestExistingFolder('/gone/run', disk([], ['/']))).toBe('/')
  })

  it('stops walking at the first folder the machine could not answer for', async () => {
    const asked: string[] = []
    const probe: PathProbe = async (path) => {
      asked.push(path)
      return 'unknown'
    }
    expect(await nearestExistingFolder('C:\\a\\b\\c.toe', probe)).toBeNull()
    expect(asked).toEqual(['C:\\a\\b'])
  })
})

describe('withArgs', () => {
  it('leaves a value with no arguments as picked', () => {
    expect(withArgs('C:\\my show\\new.toe', '')).toBe('C:\\my show\\new.toe')
  })

  it('keeps the arguments, and quotes a path with a space', () => {
    expect(withArgs('C:\\show\\new.toe', '--fullscreen')).toBe('C:\\show\\new.toe --fullscreen')
    expect(withArgs('C:\\my show\\new.toe', '--fullscreen')).toBe('"C:\\my show\\new.toe" --fullscreen')
  })
})
