/**
 * Best-effort "open this url in the user's browser". Shared by `auth login`
 * (device-code pairing) and `swoop` (the viewer page).
 *
 * Deliberately silent on failure: every caller has already printed the url, so
 * a headless box or a missing handler must not fail the command.
 */

import { spawn } from 'child_process';
import { platform } from 'os';

export function openBrowser(url: string): void {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return;
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return;

  const p = platform();
  const command = p === 'win32' ? 'explorer.exe' : p === 'darwin' ? 'open' : 'xdg-open';
  try {
    const child = spawn(command, [parsed.toString()], {
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
