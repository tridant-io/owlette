/**
 * Locating and starting owlette swoop, the desktop viewer app. Every seam is
 * injected, so no test touches the real filesystem or spawns anything.
 */

import { findViewerApp, launchViewerApp, viewerAppAcceptsUrl } from '../../src/lib/viewerApp';

const VIEWER_URL = 'https://owlette.app/swoop/site-1/m-1';
const WIN_ENV = { LOCALAPPDATA: 'C:\\Users\\op\\AppData\\Local', ProgramData: 'C:\\ProgramData' };
const WIN_USER = 'C:\\Users\\op\\AppData\\Local\\owlette swoop\\owlette-swoop-viewer.exe';
const WIN_AGENT = 'C:\\ProgramData\\Owlette\\app\\owlette-swoop-viewer.exe';
const MAC_EXE = '/Applications/owlette swoop.app/Contents/MacOS/owlette-swoop-viewer';

function existsOnly(...files: string[]) {
  return jest.fn((file: string) => files.includes(file));
}

// a child that emits `event` (the real one emits `spawn` or `error`) once listened to
function spawnStub(event: 'spawn' | 'error' = 'spawn') {
  const child = {
    on: jest.fn((name: string, listener: () => void) => {
      if (name === event) process.nextTick(listener);
    }),
    unref: jest.fn(),
  };
  const spawn = jest.fn((_command: string, _args: string[], _options: object) => child);
  return { spawn, child };
}

describe('findViewerApp', () => {
  it('windows: prefers the per-user install', () => {
    const exists = existsOnly(WIN_USER, WIN_AGENT);
    expect(findViewerApp('win32', WIN_ENV, exists)).toBe(WIN_USER);
  });

  it('windows: falls back to the copy inside the agent install', () => {
    const exists = existsOnly(WIN_AGENT);
    expect(findViewerApp('win32', WIN_ENV, exists)).toBe(WIN_AGENT);
    expect(exists).toHaveBeenNthCalledWith(1, WIN_USER);
  });

  it('windows: null when neither exists', () => {
    expect(findViewerApp('win32', WIN_ENV, existsOnly())).toBeNull();
  });

  it('windows: skips a location whose env var is unset', () => {
    const exists = existsOnly(WIN_AGENT);
    expect(findViewerApp('win32', { ProgramData: 'C:\\ProgramData' }, exists)).toBe(WIN_AGENT);
    expect(exists).toHaveBeenCalledTimes(1);
  });

  it('macos: the binary inside /Applications/owlette swoop.app', () => {
    expect(findViewerApp('darwin', {}, existsOnly(MAC_EXE))).toBe(MAC_EXE);
    expect(findViewerApp('darwin', {}, existsOnly())).toBeNull();
  });

  it('linux: the first owlette-swoop-viewer on PATH', () => {
    const exists = existsOnly('/usr/bin/owlette-swoop-viewer', '/opt/bin/owlette-swoop-viewer');
    const env = { PATH: '/usr/local/bin::/usr/bin:/opt/bin' };
    expect(findViewerApp('linux', env, exists)).toBe('/usr/bin/owlette-swoop-viewer');
    expect(exists).toHaveBeenNthCalledWith(1, '/usr/local/bin/owlette-swoop-viewer');
  });

  it('linux: null when it is not on PATH, or there is no PATH', () => {
    expect(findViewerApp('linux', { PATH: '/usr/bin' }, existsOnly())).toBeNull();
    expect(findViewerApp('linux', {}, existsOnly('/usr/bin/owlette-swoop-viewer'))).toBeNull();
  });

  it('linux: uses the injected PATH lookup', () => {
    const which = jest.fn(() => '/snap/bin/owlette-swoop-viewer');
    const env = { PATH: '/snap/bin' };
    const exists = existsOnly();
    expect(findViewerApp('linux', env, exists, which)).toBe('/snap/bin/owlette-swoop-viewer');
    expect(which).toHaveBeenCalledWith('owlette-swoop-viewer', env, exists);
  });

  it('null on a platform owlette swoop does not ship for', () => {
    expect(findViewerApp('freebsd', { PATH: '/usr/bin' }, () => true)).toBeNull();
  });
});

describe('viewerAppAcceptsUrl', () => {
  it.each([
    VIEWER_URL,
    'https://dev.owlette.app/swoop/site-1/m-1',
    'https://OWLETTE.app:443/swoop/site-1/m-1',
  ])('accepts %s', (url) => {
    expect(viewerAppAcceptsUrl(url)).toBe(true);
  });

  it.each([
    'http://owlette.app/swoop/site-1/m-1',
    'https://owlette.app:3000/swoop/site-1/m-1',
    'https://staging.owlette.app/swoop/site-1/m-1',
    'https://owlette.app.evil.com/swoop/site-1/m-1',
    'https://user@owlette.app/swoop/site-1/m-1',
    'http://localhost:3000/swoop/site-1/m-1',
    'owlette-swoop://owlette.app/swoop/site-1/m-1',
    'not a url',
  ])('refuses %s', (url) => {
    expect(viewerAppAcceptsUrl(url)).toBe(false);
  });
});

describe('launchViewerApp', () => {
  const DETACHED = { detached: true, stdio: 'ignore' };

  it('windows: runs the exe with the url as its only argument, detached', async () => {
    const { spawn, child } = spawnStub();

    await expect(launchViewerApp(WIN_USER, VIEWER_URL, { platform: 'win32', spawn })).resolves.toBe(
      true,
    );

    expect(spawn).toHaveBeenCalledWith(WIN_USER, [VIEWER_URL], DETACHED);
    expect(child.on).toHaveBeenCalledWith('error', expect.any(Function));
    expect(child.unref).toHaveBeenCalled();
  });

  it('linux: runs the binary from PATH the same way', async () => {
    const { spawn, child } = spawnStub();
    const exe = '/usr/bin/owlette-swoop-viewer';

    await expect(launchViewerApp(exe, VIEWER_URL, { platform: 'linux', spawn })).resolves.toBe(true);

    expect(spawn).toHaveBeenCalledWith(exe, [VIEWER_URL], DETACHED);
    expect(child.unref).toHaveBeenCalled();
  });

  it('macos: goes through `open -n -a` so launch services owns the process', async () => {
    const { spawn, child } = spawnStub();

    await expect(launchViewerApp(MAC_EXE, VIEWER_URL, { platform: 'darwin', spawn })).resolves.toBe(
      true,
    );

    expect(spawn).toHaveBeenCalledWith(
      'open',
      ['-n', '-a', '/Applications/owlette swoop.app', '--args', VIEWER_URL],
      DETACHED,
    );
    expect(child.unref).toHaveBeenCalled();
  });

  it.each([
    'file:///C:/Windows/System32/calc.exe',
    'owlette-swoop://owlette.app/swoop/site-1/m-1',
    'javascript:alert(1)',
    'not a url',
  ])('refuses %s and spawns nothing', async (url) => {
    const { spawn } = spawnStub();

    await expect(launchViewerApp(WIN_USER, url, { platform: 'win32', spawn })).resolves.toBe(false);
    expect(spawn).not.toHaveBeenCalled();
  });

  it('false when the process does not start', async () => {
    const { spawn } = spawnStub('error');

    await expect(launchViewerApp(WIN_USER, VIEWER_URL, { platform: 'win32', spawn })).resolves.toBe(
      false,
    );
  });

  it('false when the spawn throws', async () => {
    const spawn = jest.fn(() => {
      throw new Error('EINVAL');
    });

    await expect(launchViewerApp(WIN_USER, VIEWER_URL, { platform: 'win32', spawn })).resolves.toBe(
      false,
    );
  });
});
