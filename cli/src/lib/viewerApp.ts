/**
 * Find and start owlette swoop, the desktop viewer app, for `owlette swoop`.
 *
 * Like `openBrowser`, it only ever hands over an http(s) url: the app loads the
 * same viewer page a browser would, and the cli never starts a session.
 */

import { spawn as nodeSpawn, type SpawnOptions } from 'child_process';
import { existsSync } from 'fs';
import path from 'path';
import { httpUrl } from './openBrowser';

const BINARY = 'owlette-swoop-viewer';
const MAC_APP = '/Applications/owlette swoop.app';
// the app's allowed_origin (desktop/viewer/src/origin.rs) opens its home page for any other url
const APP_ORIGINS = ['https://owlette.app', 'https://dev.owlette.app'];

type Exists = (file: string) => boolean;
type Which = (name: string, env: NodeJS.ProcessEnv, exists: Exists) => string | null;
type Spawn = (
  command: string,
  args: string[],
  options: SpawnOptions,
) => { on(event: 'spawn' | 'error', listener: () => void): unknown; unref(): void };

export interface LaunchOptions {
  platform?: NodeJS.Platform;
  spawn?: Spawn;
}

/** First `name` found in a directory on PATH, or null. */
function findOnPath(name: string, env: NodeJS.ProcessEnv, exists: Exists): string | null {
  for (const dir of (env.PATH ?? '').split(path.posix.delimiter)) {
    if (!dir) continue;
    const candidate = path.posix.join(dir, name);
    if (exists(candidate)) return candidate;
  }
  return null;
}

/** Path to the installed owlette swoop executable, or null when it is not installed. */
export function findViewerApp(
  platform: NodeJS.Platform = process.platform,
  env: NodeJS.ProcessEnv = process.env,
  exists: Exists = existsSync,
  which: Which = findOnPath,
): string | null {
  if (platform === 'linux') return which(BINARY, env, exists);

  const candidates: string[] = [];
  if (platform === 'win32') {
    // per-user standalone install first, then the copy inside the agent install
    if (env.LOCALAPPDATA) {
      candidates.push(path.win32.join(env.LOCALAPPDATA, 'owlette swoop', `${BINARY}.exe`));
    }
    if (env.ProgramData) {
      candidates.push(path.win32.join(env.ProgramData, 'Owlette', 'app', `${BINARY}.exe`));
    }
  } else if (platform === 'darwin') {
    candidates.push(`${MAC_APP}/Contents/MacOS/${BINARY}`);
  }
  return candidates.find((file) => exists(file)) ?? null;
}

/** True when owlette swoop opens `url` itself: https on owlette.app or dev.owlette.app. */
export function viewerAppAcceptsUrl(url: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  return APP_ORIGINS.includes(parsed.origin) && !parsed.username && !parsed.password;
}

/**
 * Start owlette swoop on `url`, detached so it outlives the cli. Resolves false
 * when the url is not http(s) or the process does not start, so the caller can
 * fall back to the browser.
 */
export function launchViewerApp(
  exe: string,
  url: string,
  opts: LaunchOptions = {},
): Promise<boolean> {
  const target = httpUrl(url);
  if (!target) return Promise.resolve(false);

  const platform = opts.platform ?? process.platform;
  const spawn: Spawn = opts.spawn ?? nodeSpawn;
  // macOS: through launch services so the app is not a child of this terminal;
  // -n because `open` only activates an app that is already running and drops --args
  const [command, args]: [string, string[]] =
    platform === 'darwin'
      ? ['open', ['-n', '-a', MAC_APP, '--args', target]]
      : [exe, [target]];
  return new Promise((resolve) => {
    try {
      // no windowsHide: it starts a gui app with its first window hidden
      const child = spawn(command, args, { detached: true, stdio: 'ignore' });
      child.on('spawn', () => resolve(true));
      // stays attached after the spawn, so a late error cannot crash the cli
      child.on('error', () => resolve(false));
      child.unref();
    } catch {
      resolve(false);
    }
  });
}
