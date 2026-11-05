/**
 * Best-effort "open this url in the user's browser". Shared by `auth login`
 * (device-code pairing) and `swoop` (the viewer page).
 *
 * Deliberately silent on failure: every caller prints the url, so a headless
 * box or a missing handler must not fail the command.
 */

import { spawn } from 'child_process';
import { platform } from 'os';

/** The url, normalised, when it is http(s); null otherwise. The cli opens nothing else. */
export function httpUrl(url: string): string | null {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null;
  return parsed.toString();
}

export function openBrowser(url: string): void {
  const target = httpUrl(url);
  if (!target) return;

  const p = platform();
  const command = p === 'win32' ? 'explorer.exe' : p === 'darwin' ? 'open' : 'xdg-open';
  try {
    const child = spawn(command, [target], {
      detached: true,
      stdio: 'ignore',
      windowsHide: true,
    });
    child.on('error', () => {
      /* best-effort - the user has the url to copy-paste */
    });
    child.unref();
  } catch {
    /* ignore */
  }
}
