/**
 * owlette swoop, the viewer app, as the web sees it.
 *
 * the app appends `owlette-swoop-viewer/<version>` to its webview's user
 * agent. a ua token rather than ipc: the app gives the remote origin no ipc
 * beyond its own window's title bar, the token survives navigation, and
 * playwright can set it.
 *
 * every function reads `navigator` / `location` only through its default
 * argument, so a server render gets "not the app" instead of a throw.
 */

const TOKEN = 'owlette-swoop-viewer/';
// ` (keys)` right after the version (`desktop/viewer/src/windows.rs`)
const NATIVE_KEYS_RE = /owlette-swoop-viewer\/\S+ \(keys\)/;

// the app re-checks the host and rewrites the link to https, so these only
// keep a path segment from carrying anything but an id.
const SITE_ID_RE = /^[A-Za-z0-9_-]+$/;
const MACHINE_ID_RE = /^[A-Za-z0-9_.-]+$/;
// an app-link code is base64url, so it goes into the query as it is.
const CODE_RE = /^[A-Za-z0-9_-]{16,}$/;

const currentUserAgent = (): string =>
  typeof navigator === 'undefined' ? '' : navigator.userAgent;

const currentHost = (): string => (typeof location === 'undefined' ? '' : location.host);

export function isViewerApp(ua: string = currentUserAgent()): boolean {
  return ua.includes(TOKEN);
}

/**
 * owlette swoop captures the os shortcuts a webview never sees and hands them
 * to the page (`InputCapture.nativeKey`) where its build says so in the ua.
 */
export function viewerAppHasNativeKeys(ua: string = currentUserAgent()): boolean {
  return NATIVE_KEYS_RE.test(ua);
}

export type ViewerAppPlatform = 'mac' | 'windows' | 'linux';

/**
 * the desktop owlette swoop runs on, for its title bar: macos keeps its own
 * traffic lights, windows and linux get the page's buttons. null in a browser.
 * the app builds one ua per platform (`desktop/viewer/src/windows.rs`), so
 * anything neither mac nor windows is its linux one.
 */
export function viewerAppPlatform(ua: string = currentUserAgent()): ViewerAppPlatform | null {
  if (!isViewerApp(ua)) return null;
  if (ua.includes('Macintosh')) return 'mac';
  if (ua.includes('Windows')) return 'windows';
  return 'linux';
}

/**
 * `owlette-swoop://<host>/app-link?code=<code>&next=/swoop/<site>/<machine>`: the app signs in as
 * this browser is, then opens that machine's swoop window.
 */
export function viewerAppLink(
  siteId: string,
  machineId: string,
  { host = currentHost(), code }: { host?: string; code: string },
): string {
  if (!SITE_ID_RE.test(siteId)) throw new Error(`invalid site id: ${siteId}`);
  if (!MACHINE_ID_RE.test(machineId)) throw new Error(`invalid machine id: ${machineId}`);
  if (!host) throw new Error('no host for the owlette swoop link');
  if (!CODE_RE.test(code)) throw new Error('invalid app-link code');
  const session = `/swoop/${siteId}/${machineId}`;
  return `owlette-swoop://${host}/app-link?code=${code}&next=${encodeURIComponent(session)}`;
}
