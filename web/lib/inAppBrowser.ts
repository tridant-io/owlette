/**
 * In-app browser (embedded webview) detection and remediation.
 *
 * Federated Google sign-in cannot work inside a third-party webview, and no
 * configuration changes that:
 *  1. `signInWithPopup` throws `auth/popup-blocked` — iOS WKWebView returns null
 *     from `window.open()` unless the HOST app opted in at build time
 *     (`javaScriptCanOpenWindowsAutomatically` + a `WKUIDelegate`). Someone
 *     else's binary, so this fails 100% of the time, not intermittently.
 *  2. `signInWithRedirect` is not a fallback: Google rejects embedded
 *     user-agents outright (`disallowed_useragent`), stranding the user on an
 *     error page with no catchable Firebase code. Also, our
 *     `*.firebaseapp.com` authDomain vs owlette.app is exactly the cross-origin
 *     shape WebKit storage partitioning breaks.
 *
 * Only remediation: leave the webview, or use a non-federated credential.
 *
 * FAIL OPEN ALWAYS — every function degrades to "not in-app" on error. Callers
 * de-emphasise Google, never remove it, so a false positive can't block sign-in.
 */
import InAppSpy from 'inapp-spy';

export interface InAppBrowserInfo {
  /** True when running inside a third-party app's embedded webview. */
  isInApp: boolean;
  /** Host app display name ("LinkedIn"), when the UA identifies one. */
  appName?: string;
  /** Stable host app key ("linkedin"), when the UA identifies one. */
  appKey?: string;
}

/** Shared negative result. Frozen so a caller can't mutate the default. */
const NOT_IN_APP: InAppBrowserInfo = Object.freeze({ isInApp: false });

/**
 * Marker appended to the URL handed to the system browser. Deliberately NOT
 * used to suppress the notice — it only tells the copy the easy escape was
 * already tried, so it escalates to the manual instructions.
 */
export const ESCAPE_MARKER_PARAM = 'iab';

/**
 * Identify the host app, if any. Returns `NOT_IN_APP` during SSR — call after
 * mount (see `useInAppBrowser`), or the client render disagrees and hydration
 * mismatches. `ua` is injectable for tests.
 *
 * Synchronous UA matching only; inapp-spy's `SFSVCExperimental` probe is
 * deliberately unused — SFSafariViewController and Chrome Custom Tabs are the
 * real browser (popups work), so it is pure false-positive surface, and the
 * probe has broken on a Safari point release before.
 */
export function detectInAppBrowser(ua?: string): InAppBrowserInfo {
  const agent = ua ?? (typeof navigator === 'undefined' ? '' : navigator.userAgent);
  if (!agent) return NOT_IN_APP;

  try {
    const { isInApp, appName, appKey } = InAppSpy({ ua: agent });
    if (!isInApp) return NOT_IN_APP;

    // inapp-spy's catch-all `(iPhone|iPod|iPad)(?!.*Safari/)` also matches an
    // installed PWA (we ship display:standalone), which would tell first-party
    // WebKit on our own origin that google sign-in is broken and hide passkeys.
    // Gated on `!appKey` — a UA that names LinkedIn/Instagram is in-app
    // regardless — and on `navigator.standalone`, NOT matchMedia
    // '(display-mode: standalone)', which chrome-less third-party webviews also
    // match: that would suppress real detection (OWLETTE-WEB-45).
    if (!appKey && isIOSStandalone()) return NOT_IN_APP;

    return { isInApp: true, appName, appKey };
  } catch {
    // Detection is an enhancement, never a gate.
    return NOT_IN_APP;
  }
}

/** True in an iOS Home Screen web app. Set only by first-party WebKit. */
function isIOSStandalone(): boolean {
  return (
    typeof navigator !== 'undefined' &&
    (navigator as Navigator & { standalone?: boolean }).standalone === true
  );
}

/**
 * Firebase codes meaning "this environment cannot open a sign-in popup". Single
 * source of truth for both auth pages' remediation notice and for how
 * AuthContext reports the failure — all three must agree.
 */
const POPUP_UNAVAILABLE_CODES = new Set([
  'auth/popup-blocked',
  'auth/operation-not-supported-in-this-environment',
]);

/** True when the error means the browser refused to open the sign-in popup. */
export function isPopupUnavailableError(error: unknown): boolean {
  const code = (error as { code?: unknown } | null | undefined)?.code;
  return typeof code === 'string' && POPUP_UNAVAILABLE_CODES.has(code);
}

export type Platform = 'ios' | 'android' | 'other';

export function detectPlatform(ua?: string): Platform {
  const agent = ua ?? (typeof navigator === 'undefined' ? '' : navigator.userAgent);
  return platformOf(agent);
}

/** Name the actual app ("safari") when the platform is known — more actionable
 * than "your browser". */
export function systemBrowserLabel(ua?: string): string {
  switch (detectPlatform(ua)) {
    case 'ios':
      return 'safari';
    case 'android':
      return 'chrome';
    default:
      return 'your browser';
  }
}

function platformOf(ua: string): Platform {
  if (/iPhone|iPad|iPod/i.test(ua)) return 'ios';
  // iPadOS 13+ reports a desktop Macintosh UA; touch points disambiguate it.
  if (
    /Macintosh/i.test(ua) &&
    typeof navigator !== 'undefined' &&
    navigator.maxTouchPoints > 1
  ) {
    return 'ios';
  }
  if (/Android/i.test(ua)) return 'android';
  return 'other';
}

/** Current page URL carrying the escape marker. Exported for tests. */
export function buildEscapeTarget(href: string): string {
  try {
    const url = new URL(href);
    url.searchParams.set(ESCAPE_MARKER_PARAM, '1');
    return url.toString();
  } catch {
    return href;
  }
}

/**
 * Android intent URL handing the page to the default browser.
 *
 * The `#Intent;…;end` block IS the fragment, so any existing fragment must be
 * dropped: the first `#` wins, and a crafted `#Intent;package=…` on our origin
 * could otherwise inject intent parameters. Path and query survive via the URL
 * object, which percent-encodes the `;` that would end the block early.
 *
 * Exported for tests — the real call navigates, which jsdom cannot follow.
 */
export function buildAndroidIntentUrl(href: string): string {
  let scheme = 'https';
  let rest = href.replace(/^[a-z]+:\/\//i, '');

  try {
    const url = new URL(href);
    url.hash = '';
    scheme = url.protocol.replace(':', '');
    rest = `${url.host}${url.pathname}${url.search}`;
  } catch {
    // Naive split: a malformed href fails closed (intent won't resolve).
  }

  const fallback = encodeURIComponent(`${scheme}://${rest}`);
  return (
    `intent://${rest}#Intent;scheme=${scheme};` +
    `action=android.intent.action.VIEW;` +
    `S.browser_fallback_url=${fallback};end`
  );
}

/**
 * Best-effort hand-off to the system browser. Returns the scheme attempted;
 * the webview gives no completion signal.
 *
 * Uses `location.href`, never `window.open` — `window.open` is the exact
 * primitive that returns null here, i.e. the bug being worked around.
 *
 * iOS `x-safari-` is a private, undocumented Apple scheme, already dead in
 * TikTok/X/WeChat/Snapchat. A one-tap shortcut, NOT the mechanism — the notice
 * must always also carry the manual "open in browser" instructions.
 */
export function escapeToSystemBrowser(href?: string): Platform {
  if (typeof window === 'undefined') return 'other';

  const target = buildEscapeTarget(href ?? window.location.href);
  const platform = platformOf(navigator.userAgent);

  if (platform === 'ios') {
    window.location.href = `x-safari-${target}`;
    return platform;
  }

  if (platform === 'android') {
    window.location.href = buildAndroidIntentUrl(target);
    return platform;
  }

  window.location.href = target;
  return platform;
}

/**
 * MUST be called synchronously from a user-gesture handler — WebKit rejects the
 * clipboard promise outside one, so awaiting anything first silently breaks it.
 * Falls back to legacy textarea+execCommand, which some in-app webviews need.
 */
export async function copyToClipboard(text: string): Promise<boolean> {
  if (typeof navigator !== 'undefined' && navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch {
      // Fall through to the legacy path.
    }
  }

  if (typeof document === 'undefined') return false;

  const textarea = document.createElement('textarea');
  textarea.value = text;
  // Off-screen but selectable (`display:none` can't be selected) — which leaves
  // it in the tab order and a11y tree, hence the unconditional removal below.
  textarea.setAttribute('readonly', '');
  textarea.style.position = 'fixed';
  textarea.style.top = '-9999px';
  textarea.style.opacity = '0';

  try {
    document.body.appendChild(textarea);
    textarea.select();
    return document.execCommand('copy');
  } catch {
    return false;
  } finally {
    textarea.remove();
  }
}

/**
 * Sentry tags/extra for the browsing environment. The raw user-agent is the
 * load-bearing field: Sentry's parsed `browser` family collapses every
 * unrecognised iOS webview to "Mobile Safari UI/WKWebView" (a uap-core fallback
 * rule), so alert off the raw string, not the parsed family.
 */
export function inAppDiagnostics(): {
  tags: Record<string, string>;
  extra: Record<string, unknown>;
} {
  if (typeof navigator === 'undefined') {
    return { tags: {}, extra: {} };
  }

  const ua = navigator.userAgent;
  const info = detectInAppBrowser(ua);

  return {
    tags: {
      in_app_browser: String(info.isInApp),
      in_app_app: info.appKey ?? 'unknown',
      in_app_platform: platformOf(ua),
    },
    extra: {
      userAgent: ua,
      // Installed PWA vs embedded webview. The Firebase SDK short-circuits
      // before window.open in standalone, so expect false on popup-blocked.
      standalone:
        (navigator as Navigator & { standalone?: boolean }).standalone ?? null,
      displayModeStandalone:
        typeof window !== 'undefined' && typeof window.matchMedia === 'function'
          ? window.matchMedia('(display-mode: standalone)').matches
          : null,
    },
  };
}
