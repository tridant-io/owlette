import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import App from '@/App'
import type { PathStatus } from '@/lib/ipc'
import { launchCopy } from '@/lib/launchCopy'
import type { OwletteConfig, ProcessEntry } from '@/lib/owletteConfig'

/** config.json on the fake disk, and the file-changed event a replace of it sends. */
const host = vi.hoisted(() => ({
  config: {} as unknown,
  status: (() => 'folder') as (path: string) => PathStatus | Promise<PathStatus>,
  fileChanged: [] as ((event: { payload: unknown }) => void)[],
  picked: vi.fn(),
  service: {} as unknown,
  start: vi.fn(),
  startOnLogin: null as boolean | null,
}))

vi.mock('@tauri-apps/api/core', () => ({
  invoke: async (command: string, args: { path?: string; json?: unknown; allowElevation?: boolean } = {}) => {
    switch (command) {
      case 'path_status':
        return host.status(args.path as string)
      case 'read_owlette_json':
        if (String(args.path).includes('config')) return structuredClone(host.config)
        return {}
      case 'write_owlette_json':
        if (String(args.path).includes('config')) host.config = structuredClone(args.json)
        return { path: args.path, bytes: 0 }
      case 'launch_args':
        return []
      case 'hostname':
        return 'TEST-BOX'
      case 'detail_sections':
        return { whatToRun: true, whenToRun: true, howToRun: true }
      case 'sidebar_width':
        return 288
      case 'sidebar_collapsed':
        return false
      case 'service_status':
        return host.service
      case 'service_start':
        return host.start(args.allowElevation)
      case 'startup_link_enabled':
        return host.startOnLogin
      case 'appearance_theme':
        return 'system'
      default:
        return null
    }
  },
}))

vi.mock('@tauri-apps/api/event', () => ({
  listen: async (event: string, handler: (event: { payload: unknown }) => void) => {
    if (event === 'owlette://file-changed') host.fileChanged.push(handler)
    return () => {}
  },
}))

vi.mock('@tauri-apps/api/webview', () => ({
  getCurrentWebview: () => ({ onDragDropEvent: async () => () => {} }),
}))

vi.mock('@tauri-apps/plugin-dialog', () => ({ open: host.picked }))

const PLAYER: ProcessEntry = {
  id: 'player',
  name: 'player',
  exe_path: 'C:\\apps\\player.exe',
  file_path: '',
  cwd: 'C:\\apps',
  time_delay: '0',
  time_to_init: '10',
  relaunch_attempts: '3',
  launch_mode: 'off',
  priority: 'High',
}
const SCREEN: ProcessEntry = { ...PLAYER, id: 'screen', name: 'screen', priority: 'Normal' }

const GONE = 'C:\\show\\old\\main.toe'

function disk(): OwletteConfig {
  return host.config as OwletteConfig
}

function onDisk(id: string): ProcessEntry {
  return (disk().processes ?? []).find((process) => process.id === id) as ProcessEntry
}

/** what the machine says when only these paths exist. */
function only(...paths: string[]) {
  return (path: string): PathStatus =>
    paths.includes(path) ? (/\.\w+$/.test(path) ? 'file' : 'folder') : 'missing'
}

async function openApp() {
  render(<App />)
  fireEvent.click(await screen.findByRole('button', { name: /player/ }))
  await screen.findByDisplayValue('player')
}

function select(name: string) {
  fireEvent.click(screen.getByRole('button', { name: new RegExp(name) }))
}

function pathField(label: string): HTMLInputElement {
  return screen.getByLabelText(label) as HTMLInputElement
}

/** type into a field and leave it, the way the operator does. */
function enter(label: string, value: string) {
  const input = pathField(label)
  fireEvent.focus(input)
  fireEvent.change(input, { target: { value } })
  fireEvent.blur(input)
}

beforeEach(() => {
  host.config = { processes: [PLAYER, SCREEN] }
  host.status = only('C:\\show')
  host.fileChanged = []
  host.picked.mockReset()
  host.service = { state: 'running', startType: 'auto', statusFile: { exists: false } }
  host.start.mockReset()
  host.startOnLogin = null
})

describe('start on login in the window menu', () => {
  /** the menu's checkbox, opened from the keyboard: jsdom has no PointerEvent. */
  async function startOnLoginItem() {
    fireEvent.keyDown(screen.getByTestId('app-menu-trigger'), { key: 'Enter' })
    return screen.findByTestId('menu-start-on-login')
  }

  it('shows a change made from the tray once the window comes back', async () => {
    host.startOnLogin = false
    render(<App />)
    expect((await startOnLoginItem()).getAttribute('aria-checked')).toBe('false')
    fireEvent.keyDown(screen.getByRole('menu'), { key: 'Escape' })
    await waitFor(() => expect(screen.queryByRole('menu')).toBeNull())

    // the tray rewrote the shortcut while the window was hidden, which does not unmount it
    host.startOnLogin = true
    await act(async () => {
      window.dispatchEvent(new Event('focus'))
    })

    expect((await startOnLoginItem()).getAttribute('aria-checked')).toBe('true')
  })
})

describe('starting the service from the footer', () => {
  it('says why a start the operator asked for failed, and keeps the launch-time start quiet', async () => {
    host.service = {
      installed: true,
      running: false,
      state: 'stopped',
      startType: 'auto_start',
      statusFile: { exists: false, ageSecs: null, stale: true },
    }
    host.start.mockRejectedValue('elevation was declined or could not be started')
    render(<App />)
    await waitFor(() => expect(host.start).toHaveBeenCalledWith(false))

    fireEvent.click(await screen.findByRole('button', { name: 'start service' }))

    expect(await screen.findByText('could not start the service')).toBeTruthy()
    expect(screen.getByText('elevation was declined or could not be started')).toBeTruthy()
    expect(host.start.mock.calls).toEqual([[false], [true]])
  })
})

describe('the warning about a path', () => {
  it('warns, names the process, and keeps what was typed when ok is pressed', async () => {
    await openApp()
    enter('path / args', GONE)

    const dialog = (await screen.findByRole('dialog')).textContent
    expect(dialog).toContain("can't find this file")
    expect(dialog).toContain('player')
    expect(dialog).toContain(GONE)
    expect(dialog).toContain('nearest folder that exists: C:\\show')

    fireEvent.click(screen.getByRole('button', { name: 'ok' }))
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    expect(pathField('path / args').value).toBe(GONE)
    expect(onDisk('player').file_path).toBe(GONE)
  })

  it('browses from the nearest folder that exists, and shows and saves the file picked there', async () => {
    host.picked.mockResolvedValue('C:\\show\\new.toe')
    host.status = only('C:\\show', 'C:\\show\\new.toe')
    await openApp()
    enter('path / args', GONE)

    await screen.findByRole('dialog')
    fireEvent.click(screen.getByRole('button', { name: 'browse' }))

    await waitFor(() => expect(onDisk('player').file_path).toBe('C:\\show\\new.toe'))
    expect(host.picked).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ defaultPath: 'C:\\show' }))
    await waitFor(() => expect(pathField('path / args').value).toBe('C:\\show\\new.toe'))
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
  })

  it('shows the picked file even when focus had moved on to another field', async () => {
    // a picker is open for seconds, so the dialog has long closed and handled focus by then.
    host.picked.mockImplementation(
      () => new Promise((resolve) => setTimeout(() => resolve('C:\\show\\new.toe'), 100)),
    )
    host.status = only('C:\\show', 'C:\\show\\new.toe')
    await openApp()

    const file = pathField('path / args')
    file.focus()
    fireEvent.change(file, { target: { value: GONE } })
    pathField('cwd').focus()

    await screen.findByRole('dialog')
    fireEvent.click(screen.getByRole('button', { name: 'browse' }))

    await waitFor(() => expect(onDisk('player').file_path).toBe('C:\\show\\new.toe'))
    await waitFor(() => expect(pathField('path / args').value).toBe('C:\\show\\new.toe'))
  })

  it('leaves the typed value in place when browse is cancelled', async () => {
    host.picked.mockResolvedValue(null)
    await openApp()
    enter('path / args', GONE)

    await screen.findByRole('dialog')
    fireEvent.click(screen.getByRole('button', { name: 'browse' }))

    await waitFor(() => expect(host.picked).toHaveBeenCalled())
    await act(async () => {})
    expect(onDisk('player').file_path).toBe(GONE)
    expect(pathField('path / args').value).toBe(GONE)
  })

  it('keeps the arguments after the path when browsing replaces it', async () => {
    host.picked.mockResolvedValue('C:\\show\\new.toe')
    host.status = only('C:\\show', 'C:\\show\\new.toe')
    await openApp()
    enter('path / args', `${GONE} --fullscreen`)

    await screen.findByRole('dialog')
    fireEvent.click(screen.getByRole('button', { name: 'browse' }))

    await waitFor(() => expect(onDisk('player').file_path).toBe('C:\\show\\new.toe --fullscreen'))
  })

  it('browses for a folder when the working directory is the one missing', async () => {
    host.picked.mockResolvedValue(null)
    host.status = only('D:\\')
    await openApp()
    enter('cwd', 'D:\\gone\\deeper')

    expect((await screen.findByRole('dialog')).textContent).toContain("can't find this folder")
    fireEvent.click(screen.getByRole('button', { name: 'browse' }))

    await waitFor(() =>
      expect(host.picked).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining({ directory: true, defaultPath: 'D:\\' }),
      ),
    )
  })

  it('warns about the launch target too', async () => {
    await openApp()
    enter(launchCopy().label, 'C:\\apps\\gone.exe')

    expect((await screen.findByRole('dialog')).textContent).toContain('C:\\apps\\gone.exe')
  })

  it.each(['--fullscreen', '-f C:\\show\\main.toe', 'scripts\\run.py'])('says nothing about %s', async (value) => {
    await openApp()
    enter('path / args', value)

    await waitFor(() => expect(onDisk('player').file_path).toBe(value))
    await act(async () => {})
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  it('says nothing about a path that exists', async () => {
    host.status = only('C:\\show\\main.toe')
    await openApp()
    enter('path / args', 'C:\\show\\main.toe')

    await waitFor(() => expect(onDisk('player').file_path).toBe('C:\\show\\main.toe'))
    await act(async () => {})
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  it('says nothing when a field that is not a path changed', async () => {
    host.status = only()
    await openApp()
    enter('name', 'media player')

    await waitFor(() => expect(onDisk('player').name).toBe('media player'))
    await act(async () => {})
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  it.each([
    ['launch target', 'exe', 'C:\\apps\\player', only('C:\\apps\\player'), 'this is a folder, not a file', 'C:\\apps\\player'],
    ['working directory', 'cwd', 'C:\\apps\\player.exe', only('C:\\apps\\player.exe'), 'this is a file, not a folder', 'C:\\apps'],
  ])('says so when the %s is the wrong kind of thing, and browses from there', async (_name, label, value, status, title, from) => {
    host.picked.mockResolvedValue(null)
    host.status = status
    await openApp()
    enter(label, value)

    expect((await screen.findByRole('dialog')).textContent).toContain(title)
    fireEvent.click(screen.getByRole('button', { name: 'browse' }))
    await waitFor(() =>
      expect(host.picked).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ defaultPath: from })),
    )
  })

  it('says owlette will not launch from a network path, without touching the disk', async () => {
    const status = vi.fn(only())
    host.status = status
    await openApp()
    status.mockClear()
    enter('path / args', '\\\\server\\share\\main.toe')

    const dialog = (await screen.findByRole('dialog')).textContent
    expect(dialog).toContain("owlette can't launch from a network path")
    expect(dialog).toContain('owlette refuses network paths')
    expect(dialog).not.toContain('browse starts')
    expect(status).not.toHaveBeenCalled()
  })

  it('says owlette will not launch through a symbolic link', async () => {
    host.status = (path) => (path === 'C:\\apps\\link.exe' ? 'file-link' : 'folder')
    await openApp()
    enter('exe', 'C:\\apps\\link.exe')

    const dialog = (await screen.findByRole('dialog')).textContent
    expect(dialog).toContain('symbolic link')
    expect(dialog).toContain('owlette refuses symbolic links')
  })

  it('does not call a path that only starts with two slashes a network path', async () => {
    await openApp()
    enter('path / args', '//flag')

    const dialog = (await screen.findByRole('dialog')).textContent
    expect(dialog).toContain("owlette can't launch from this path")
    expect(dialog).not.toContain('network')
  })

  it('keeps a bare argument after the path when browsing replaces it', async () => {
    host.picked.mockResolvedValue('C:\\show\\new.py')
    host.status = only('C:\\show', 'C:\\show\\new.py')
    await openApp()
    enter('path / args', 'C:/show/gone.py 8000')

    await screen.findByRole('dialog')
    fireEvent.click(screen.getByRole('button', { name: 'browse' }))

    await waitFor(() => expect(onDisk('player').file_path).toBe('C:\\show\\new.py 8000'))
  })
})

describe('leaving the process while its path is being checked', () => {
  /** a machine whose answer about `path` waits for `answer`, as a slow share does. */
  function slowly(path: string, then: PathStatus) {
    let answer = () => {}
    const held = new Promise<PathStatus>((resolve) => {
      answer = () => resolve(then)
    })
    host.status = (asked) => (asked === path ? held : asked === 'C:\\show' ? 'folder' : 'missing')
    return async () => {
      await act(async () => answer())
    }
  }

  it('still warns once the answer comes, naming the process it is about', async () => {
    const answer = slowly(GONE, 'missing')
    await openApp()
    enter('path / args', GONE)

    select('screen')
    await screen.findByDisplayValue('screen')
    expect(screen.queryByRole('dialog')).toBeNull()

    await answer()
    const dialog = (await screen.findByRole('dialog')).textContent
    expect(dialog).toContain('player')
    expect(dialog).toContain(GONE)
  })

  it('saves what is browsed to that process, on top of its current values on disk, and leaves the selected one alone', async () => {
    const answer = slowly(GONE, 'missing')
    host.picked.mockResolvedValue('C:\\show\\new.toe')
    await openApp()
    enter('path / args', GONE)
    await waitFor(() => expect(onDisk('player').file_path).toBe(GONE))

    select('screen')
    await screen.findByDisplayValue('screen')
    const screenBefore = structuredClone(onDisk('screen'))

    // the dashboard edits the process while the operator looks at the other one.
    host.config = {
      processes: [{ ...onDisk('player'), time_to_init: '45', cwd: 'C:\\elsewhere' }, onDisk('screen')],
    }

    await answer()
    await screen.findByRole('dialog')
    fireEvent.click(screen.getByRole('button', { name: 'browse' }))

    await waitFor(() => expect(onDisk('player').file_path).toBe('C:\\show\\new.toe'))
    expect(onDisk('player')).toMatchObject({ time_to_init: '45', cwd: 'C:\\elsewhere', priority: 'High', name: 'player' })
    expect(onDisk('screen')).toEqual(screenBefore)
    expect((screen.getByLabelText('name') as HTMLInputElement).value).toBe('screen')
    expect(pathField('path / args').value).toBe('')
  })

  it('drops the warning when the process was deleted meanwhile', async () => {
    const answer = slowly(GONE, 'missing')
    await openApp()
    enter('path / args', GONE)
    await waitFor(() => expect(onDisk('player').file_path).toBe(GONE))

    select('screen')
    await screen.findByDisplayValue('screen')

    host.config = { processes: [onDisk('screen')] }
    act(() => {
      for (const handler of host.fileChanged) handler({ payload: { file: 'config', path: 'config/config.json' } })
    })
    await waitFor(() => expect(screen.queryByRole('button', { name: /player/ })).toBeNull())

    await answer()
    await act(async () => {})
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  it('shows a second warning after the first instead of losing either', async () => {
    const answer = slowly(GONE, 'missing')
    await openApp()
    enter('path / args', GONE)

    select('screen')
    await screen.findByDisplayValue('screen')
    enter('cwd', 'D:\\gone')

    expect((await screen.findByRole('dialog')).textContent).toContain('D:\\gone')
    await answer()
    fireEvent.click(screen.getByRole('button', { name: 'ok' }))

    await waitFor(() => expect(screen.getByRole('dialog').textContent).toContain(GONE))
    expect(screen.getByRole('dialog').textContent).toContain('player')
  })

  it('does not lose a slow check to an entry in another field of the same process', async () => {
    const answer = slowly(GONE, 'missing')
    await openApp()
    enter('path / args', GONE)
    enter('cwd', 'D:\\gone')

    expect((await screen.findByRole('dialog')).textContent).toContain('D:\\gone')
    await answer()
    fireEvent.click(screen.getByRole('button', { name: 'ok' }))

    await waitFor(() => expect(screen.getByRole('dialog').textContent).toContain(GONE))
  })

  it('lets a newer entry for the same field replace the check in flight', async () => {
    const answer = slowly(GONE, 'missing')
    await openApp()
    enter('path / args', GONE)
    enter('path / args', 'C:\\show')

    await answer()
    await act(async () => {})
    expect(screen.queryByRole('dialog')).toBeNull()
  })
})
