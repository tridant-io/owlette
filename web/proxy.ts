import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { evaluateSessionMfa } from '@/lib/sessionManager.server';
import { CURRENT_SECURITY_VERSION, SECURITY_VERSION_HEADER } from '@/lib/securityVersion';

/**
 * Next.js proxy for route protection — runs server-side before pages load, so unlike a
 * client redirect it can't be bypassed by disabling JavaScript. Renamed from
 * `middleware.ts` per Next 16's deprecation of that file convention; behavior unchanged.
 *
 * Uses encrypted HTTPOnly session cookies (iron-session), validates expiry on every
 * request, and on protected paths enforces both the MFA challenge (`mfaRequired &&
 * !mfaVerified` → /verify-2fa) and mandatory enrollment (`requiresMfaSetup`, re-armed by
 * lib/mfaFactors.server.ts at zero factors → /setup-2fa). Enrollment used to be a client
 * effect in app/dashboard/page.tsx, which every other protected route walked past.
 */

// Protected pages: authenticated session AND a satisfied MFA challenge.
const PROTECTED_PATHS = [
  '/dashboard',
  '/deployments',
  '/admin',
  '/roosts',
  '/setup',
  '/add',
  // `/cortex` is absent on purpose: next.config.ts permanently redirects it to `/hoot`.
  '/hoot',
  '/talons',
  // /swoop/[siteId]/[machineId] drives a live remote session — keyboard and mouse on
  // someone's machine — so it never renders without a completed MFA challenge.
  '/swoop',
  // /settings/* manages account + security state — needs completed MFA, not just password.
  '/settings',
] as const;

// Must stay reachable while MFA is pending, or the challenge could never be completed.
const MFA_CHALLENGE_PATH = '/verify-2fa';

// Prefix collision: '/setup-2fa'.startsWith('/setup') is true, so this page is already
// matched as protected — without the explicit exemption below it redirects to itself.
const MFA_SETUP_PATH = '/setup-2fa';
const isDev = process.env.NODE_ENV === 'development';
const isEmulatorBuild = process.env.NEXT_PUBLIC_USE_FIREBASE_EMULATOR === 'true';

function createCspNonce() {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return btoa(String.fromCharCode(...bytes));
}

function isScalarApiReferencePath(pathname: string) {
  return pathname === '/docs/api' || pathname === '/docs/api/';
}

/**
 * connect-src sources for the swoop signaling socket, derived from SWOOP_SIGNAL_URL: the
 * https origin (the page's own fetches) and its wss form (the room WebSocket). Unset —
 * dev, preview, any deployment without a signaling worker — emits nothing, so those keep
 * working. The browser learns the URL from the session-create API response, never from a
 * NEXT_PUBLIC_ variable, so this is the only place the origin reaches the client.
 *
 * NOTE: CSP does not constrain RTCPeerConnection. STUN/TURN and the media path are outside
 * connect-src entirely — this buys the signaling socket only.
 */
function swoopSignalConnectSources() {
  const raw = process.env.SWOOP_SIGNAL_URL;
  if (!raw) return '';

  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    // A malformed value must not 500 every request the proxy touches.
    return '';
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') return '';

  // https://host → wss://host (http → ws for a local wrangler dev worker).
  return ` ${parsed.origin} ${parsed.origin.replace(/^http/, 'ws')}`;
}

function buildContentSecurityPolicy(nonce: string, pathname: string) {
  const scalarApiReference = isScalarApiReferencePath(pathname);
  const scalarFontSource = scalarApiReference ? ' https://fonts.scalar.com' : '';
  const scalarConnectSource = scalarApiReference ? ' https://api.scalar.com' : '';
  const swoopConnectSource = swoopSignalConnectSources();

  return [
    "default-src 'self'",
    // Next reads this request CSP pre-render and nonces framework inline scripts.
    // 'strict-dynamic' lets nonce-bearing scripts load their children on modern browsers;
    // the host allowlist (incl. challenges.cloudflare.com for the Turnstile loader) is the
    // older-CSP fallback. unsafe-eval is dev-only, for Fast Refresh.
    `script-src 'self' 'nonce-${nonce}' 'strict-dynamic' ${isDev ? "'unsafe-eval' " : ''}https://accounts.google.com https://apis.google.com https://*.gstatic.com https://challenges.cloudflare.com`,
    // 'unsafe-inline' for styles: Next 16 emits inline <style> during client navigation that
    // the request-header nonce (scripts only) doesn't cover — without it the login page hits
    // style-src-elem violations, fails hydration with React #418 and the form goes inert.
    // No style nonce: browsers ignore 'unsafe-inline' when a nonce is present.
    "style-src 'self' 'unsafe-inline'",
    "style-src-elem 'self' 'unsafe-inline'",
    "style-src-attr 'unsafe-inline'",
    `img-src 'self' data: blob: https:${isEmulatorBuild ? ' http://127.0.0.1:*' : ''}`,
    `font-src 'self' data:${scalarFontSource}`,
    `connect-src 'self' https://*.firebaseio.com https://*.googleapis.com https://firestore.googleapis.com wss://*.firebaseio.com https://accounts.google.com https://*.ingest.sentry.io https://*.r2.cloudflarestorage.com https://challenges.cloudflare.com${scalarConnectSource}${swoopConnectSource}${isEmulatorBuild ? ' http://127.0.0.1:* ws://127.0.0.1:*' : ''}`,
    // Turnstile's challenge iframe; without this the widget mounts permanently blank.
    "frame-src 'self' https://accounts.google.com https://*.firebaseapp.com https://challenges.cloudflare.com",
    "frame-ancestors 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "object-src 'none'",
    ...(isDev ? [] : ["upgrade-insecure-requests"]),
  ].join('; ');
}

function setCspHeader(response: NextResponse, csp: string) {
  response.headers.set('Content-Security-Policy', csp);
  return response;
}

function nextWithCsp(request: NextRequest, csp: string, nonce: string) {
  const requestHeaders = new Headers(request.headers);
  requestHeaders.set('Content-Security-Policy', csp);
  requestHeaders.set('x-nonce', nonce);

  return setCspHeader(
    NextResponse.next({
      request: {
        headers: requestHeaders,
      },
    }),
    csp
  );
}

function redirectWithCsp(url: URL, csp: string, status?: number) {
  return setCspHeader(
    status ? NextResponse.redirect(url, status) : NextResponse.redirect(url),
    csp
  );
}

export async function proxy(request: NextRequest) {
  const { pathname, search } = request.nextUrl;
  const nonce = createCspNonce();
  const csp = buildContentSecurityPolicy(nonce, pathname);

  // Legacy redirect: /api/folders/* → /api/roosts/* (folders→roosts rename).
  // Remove 30 days after external users migrated (added 2026-04-22).
  if (pathname.startsWith('/api/folders/') || pathname === '/api/folders') {
    const rewritten = pathname.replace(/^\/api\/folders/, '/api/roosts');
    return redirectWithCsp(new URL(rewritten + search, request.url), csp, 308);
  }

  // Stamp every /api/* response with the current security version so stale tabs can detect
  // they're out of sync and prompt a reload. UX nudge only — see lib/securityVersion.ts.
  //
  // /api/* is deliberately NOT session-gated here (auth, MFA challenge, or enrollment):
  // API routes authenticate themselves (session cookie, API key, or agent token) and apply
  // lib/mfaEnrollmentGate.server.ts inside the routes that change a factor. The proxy
  // can't tell an agent/API-key caller from a browser one, so blanket-gating would break
  // every non-browser client. Do not "fix" this by adding a gate.
  if (pathname.startsWith('/api/')) {
    const response = nextWithCsp(request, csp, nonce);
    response.headers.set(SECURITY_VERSION_HEADER, String(CURRENT_SECURITY_VERSION));
    return response;
  }

  const isProtectedPath = PROTECTED_PATHS.some(path => pathname.startsWith(path));
  const isMfaChallengePath = pathname === MFA_CHALLENGE_PATH || pathname.startsWith(`${MFA_CHALLENGE_PATH}/`);
  const isMfaSetupPath = pathname === MFA_SETUP_PATH || pathname.startsWith(`${MFA_SETUP_PATH}/`);

  // Session + MFA state in one pass. `requiresSetup` comes from the cookie's cached
  // `requiresMfaSetup`, not a live Firestore read — this runs on every request. May
  // persist a one-time migration write for pre-flag sessions (see evaluateSessionMfa).
  const { outcome, userId, requiresSetup } = await evaluateSessionMfa(request);
  const isAuthenticated = outcome !== 'unauthenticated';

  // Protected pages: require auth AND a satisfied MFA gate.
  if (isProtectedPath) {
    if (!isAuthenticated) {
      const loginUrl = new URL('/login', request.url);
      loginUrl.searchParams.set('redirect', pathname);

      if (process.env.NODE_ENV === 'development') {
        console.log('[Proxy] Redirecting to login from:', pathname);
      }

      return redirectWithCsp(loginUrl, csp);
    }

    // ORDER MATTERS: mandatory setup is checked BEFORE the challenge. The two flags are
    // mutually exclusive on a freshly-stamped session, and diverge exactly where getting it
    // wrong bricks the user — a cookie whose `mfaRequired` was cached before the last factor
    // was removed, and the fail-closed `challenge` evaluateSessionMfa forces when its
    // upgrade lookup throws. Neither account has anything to present at /verify-2fa, while
    // /setup-2fa is actionable, so setup wins.
    //
    // The `!isMfaSetupPath` guard is load-bearing: /setup-2fa starts with /setup, so it is
    // already inside PROTECTED_PATHS and would otherwise redirect to itself forever.
    if (requiresSetup) {
      if (!isMfaSetupPath) {
        const setupUrl = new URL(MFA_SETUP_PATH, request.url);
        // Same `redirect` contract as the login/challenge gates. The page finishes to /dashboard
        // today, so adding a bounce-back is a page change, not a proxy change.
        setupUrl.searchParams.set('redirect', pathname);

        if (process.env.NODE_ENV === 'development') {
          console.log('[Proxy] MFA setup required — redirecting to setup-2fa from:', pathname);
        }

        return redirectWithCsp(setupUrl, csp);
      }
      // Already on /setup-2fa: render it and skip the challenge branch (hence `else if`) —
      // "setup wins" must be total, or an account with both flags set bounces off the page
      // that fixes it. Safe: routes behind it still enforce lib/mfaEnrollmentGate.server.ts.
    } else if (outcome === 'challenge') {
      const verifyUrl = new URL(MFA_CHALLENGE_PATH, request.url);
      // Preserve the destination for post-challenge bounce-back. `redirect` matches the login
      // contract; verify-2fa also accepts the historical `return` param.
      verifyUrl.searchParams.set('redirect', pathname);

      if (process.env.NODE_ENV === 'development') {
        console.log('[Proxy] MFA required — redirecting to verify-2fa from:', pathname);
      }

      return redirectWithCsp(verifyUrl, csp);
    }

    if (process.env.NODE_ENV === 'development') {
      console.log('[Proxy] Allowing access to protected route:', pathname, 'userId:', userId);
    }
  }

  // The challenge page must stay reachable for an authenticated-but-unverified user.
  // Otherwise: unauthenticated → /login, already-verified → /dashboard.
  if (isMfaChallengePath) {
    if (!isAuthenticated) {
      const loginUrl = new URL('/login', request.url);
      return redirectWithCsp(loginUrl, csp);
    }
    if (outcome === 'pass') {
      const redirectParam = request.nextUrl.searchParams.get('redirect')
        ?? request.nextUrl.searchParams.get('return');
      if (
        redirectParam &&
        redirectParam.startsWith('/') &&
        !redirectParam.startsWith('//') &&
        PROTECTED_PATHS.some(p => redirectParam.startsWith(p))
      ) {
        return redirectWithCsp(new URL(redirectParam, request.url), csp);
      }
      return redirectWithCsp(new URL('/dashboard', request.url), csp);
    }
    // outcome === 'challenge' — render the page so the user can submit TOTP / backup code.
  }

  // Logged-in users on login/register go to the dashboard — unless MFA is still pending,
  // in which case send them to the challenge so they don't get stuck on login.
  if (pathname === '/login' || pathname === '/register') {
    if (isAuthenticated) {
      if (outcome === 'challenge') {
        return redirectWithCsp(new URL(MFA_CHALLENGE_PATH, request.url), csp);
      }

      const redirectParam = request.nextUrl.searchParams.get('redirect');

      if (redirectParam &&
          redirectParam.startsWith('/') &&
          !redirectParam.startsWith('//') &&
          PROTECTED_PATHS.some(path => redirectParam.startsWith(path))) {
        // Known protected paths only — prevents open redirect.
        return redirectWithCsp(new URL(redirectParam, request.url), csp);
      }

      return redirectWithCsp(new URL('/dashboard', request.url), csp);
    }
  }

  return nextWithCsp(request, csp, nonce);
}

/** Routes this proxy runs on. */
export const config = {
  // All routes except static assets. /api/* is included so the proxy can stamp the
  // x-security-version response header (lib/securityVersion.ts — UX, not safety).
  matcher: [
    '/((?!_next/static|_next/image|favicon.ico|.*\\.png$|.*\\.jpg$|.*\\.jpeg$|.*\\.gif$|.*\\.svg$|.*\\.ico$).*)',
  ],
};
