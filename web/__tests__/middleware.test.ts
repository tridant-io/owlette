/** @jest-environment node */

/**
 * Tests for the security-version response header attached by the
 * Next.js proxy (the "middleware" in Next.js 16+ parlance).
 *
 * !! THIS IS UX, NOT SAFETY !! — see `lib/securityVersion.ts`.
 */

import { NextRequest } from 'next/server';

const mockValidateSession = jest.fn();
const mockEvaluateSessionMfa = jest.fn();
jest.mock('@/lib/sessionManager.server', () => ({
  validateSessionFromRequest: (...args: unknown[]) => mockValidateSession(...args),
  evaluateSessionMfa: (...args: unknown[]) => mockEvaluateSessionMfa(...args),
}));

import { proxy } from '@/proxy';
import {
  CURRENT_SECURITY_VERSION,
  SECURITY_VERSION_HEADER,
} from '@/lib/securityVersion';

function makeRequest(pathname: string): NextRequest {
  return new NextRequest(new URL(`http://localhost${pathname}`));
}

describe('proxy — x-security-version header', () => {
  beforeEach(() => {
    mockValidateSession.mockResolvedValue(null);
    // Default "no session" so the page-route test redirects to /login instead of
    // entering the protected-path branch.
    mockEvaluateSessionMfa.mockResolvedValue({
      outcome: 'unauthenticated',
      userId: null,
    });
  });

  it('attaches x-security-version on /api/* responses', async () => {
    const response = await proxy(makeRequest('/api/sites'));
    expect(response.headers.get(SECURITY_VERSION_HEADER)).toBe(
      String(CURRENT_SECURITY_VERSION),
    );
  });

  it('attaches x-security-version on nested /api/* paths', async () => {
    const response = await proxy(makeRequest('/api/installer/upload'));
    expect(response.headers.get(SECURITY_VERSION_HEADER)).toBe(
      String(CURRENT_SECURITY_VERSION),
    );
  });

  it('does not skip header even on unauthenticated /api/* calls', async () => {
    mockValidateSession.mockResolvedValue(null);
    const response = await proxy(makeRequest('/api/agent/heartbeat'));
    expect(response.headers.get(SECURITY_VERSION_HEADER)).toBe(
      String(CURRENT_SECURITY_VERSION),
    );
  });

  it('emits header value as a numeric string (not object/JSON)', async () => {
    const response = await proxy(makeRequest('/api/test'));
    const value = response.headers.get(SECURITY_VERSION_HEADER);
    expect(value).not.toBeNull();
    expect(Number.isFinite(Number.parseInt(value as string, 10))).toBe(true);
  });

  it('does not attach the header on non-api routes (page routes)', async () => {
    const response = await proxy(makeRequest('/dashboard'));
    // Page routes redirect or pass through; the header must not be stamped.
    expect(response.headers.get(SECURITY_VERSION_HEADER)).toBeNull();
  });

  it('still redirects legacy /api/folders before stamping the header', async () => {
    const response = await proxy(makeRequest('/api/folders/abc'));
    expect(response.status).toBe(308);
    // Redirects bypass the header; the client follows the 308 and reads it from
    // the resolved /api/roosts response.
    expect(response.headers.get('location')).toContain('/api/roosts/abc');
  });
});

describe('proxy — MFA gate', () => {
  beforeEach(() => {
    mockValidateSession.mockResolvedValue(null);
    mockEvaluateSessionMfa.mockReset();
  });

  it('redirects unauthenticated requests on protected paths to /login', async () => {
    mockEvaluateSessionMfa.mockResolvedValue({
      outcome: 'unauthenticated',
      userId: null,
    });
    const response = await proxy(makeRequest('/dashboard'));
    expect(response.status).toBe(307);
    const loc = response.headers.get('location');
    expect(loc).toContain('/login');
    expect(loc).toContain('redirect=%2Fdashboard');
  });

  it('redirects authenticated-but-MFA-pending requests to /verify-2fa', async () => {
    mockEvaluateSessionMfa.mockResolvedValue({
      outcome: 'challenge',
      userId: 'user-1',
    });
    const response = await proxy(makeRequest('/dashboard'));
    expect(response.status).toBe(307);
    const loc = response.headers.get('location');
    expect(loc).toContain('/verify-2fa');
    expect(loc).toContain('redirect=%2Fdashboard');
  });

  it('lets MFA-verified sessions through to protected paths', async () => {
    mockEvaluateSessionMfa.mockResolvedValue({
      outcome: 'pass',
      userId: 'user-1',
    });
    const response = await proxy(makeRequest('/dashboard'));
    // pass = NextResponse.next(); no redirect, no Location header.
    expect(response.headers.get('location')).toBeNull();
  });

  it('allows /verify-2fa for authenticated-but-pending sessions (so the challenge can be completed)', async () => {
    mockEvaluateSessionMfa.mockResolvedValue({
      outcome: 'challenge',
      userId: 'user-1',
    });
    const response = await proxy(makeRequest('/verify-2fa'));
    expect(response.headers.get('location')).toBeNull();
  });

  it('redirects unauthenticated /verify-2fa requests to /login', async () => {
    mockEvaluateSessionMfa.mockResolvedValue({
      outcome: 'unauthenticated',
      userId: null,
    });
    const response = await proxy(makeRequest('/verify-2fa'));
    expect(response.status).toBe(307);
    expect(response.headers.get('location')).toContain('/login');
  });

  it('redirects already-verified sessions away from /verify-2fa', async () => {
    mockEvaluateSessionMfa.mockResolvedValue({
      outcome: 'pass',
      userId: 'user-1',
    });
    const response = await proxy(makeRequest('/verify-2fa'));
    expect(response.status).toBe(307);
    // Default redirect is /dashboard when no safe redirect param is set.
    expect(response.headers.get('location')).toContain('/dashboard');
  });

  it('preserves redirect param when bouncing already-verified users off /verify-2fa', async () => {
    mockEvaluateSessionMfa.mockResolvedValue({
      outcome: 'pass',
      userId: 'user-1',
    });
    const response = await proxy(makeRequest('/verify-2fa?redirect=%2Fadmin'));
    expect(response.status).toBe(307);
    expect(response.headers.get('location')).toContain('/admin');
  });

  it('rejects open-redirect attempts in /verify-2fa redirect param', async () => {
    mockEvaluateSessionMfa.mockResolvedValue({
      outcome: 'pass',
      userId: 'user-1',
    });
    // `//evil.example.com` is a protocol-relative URL → not safe.
    const response = await proxy(
      makeRequest('/verify-2fa?redirect=%2F%2Fevil.example.com')
    );
    expect(response.headers.get('location')).toContain('/dashboard');
    expect(response.headers.get('location')).not.toContain('evil.example.com');
  });

  it('bounces MFA-pending users off /login to /verify-2fa', async () => {
    mockEvaluateSessionMfa.mockResolvedValue({
      outcome: 'challenge',
      userId: 'user-1',
    });
    const response = await proxy(makeRequest('/login'));
    expect(response.status).toBe(307);
    expect(response.headers.get('location')).toContain('/verify-2fa');
  });

  it('bounces MFA-verified users off /login to /dashboard', async () => {
    mockEvaluateSessionMfa.mockResolvedValue({
      outcome: 'pass',
      userId: 'user-1',
    });
    const response = await proxy(makeRequest('/login'));
    expect(response.status).toBe(307);
    expect(response.headers.get('location')).toContain('/dashboard');
  });


  it('preserves the redirect param when bouncing MFA-pending users off /dashboard', async () => {
    // The challenge redirect carries the requested path so verification returns
    // the user to it.
    mockEvaluateSessionMfa.mockResolvedValue({
      outcome: 'challenge',
      userId: 'user-1',
    });
    const response = await proxy(makeRequest('/admin/users'));
    expect(response.status).toBe(307);
    const loc = response.headers.get('location') ?? '';
    expect(loc).toContain('/verify-2fa');
    expect(loc).toContain('redirect=%2Fadmin%2Fusers');
  });

  it('fail-soft: when evaluateSessionMfa returns unauthenticated due to a downstream error, protected paths redirect to /login (not 500)', async () => {
    // Legacy sessions take a one-time Firestore round-trip in evaluateSessionMfa;
    // a failed read returns the unauthenticated outcome rather than throwing, so
    // the proxy redirects instead of 500ing.
    mockEvaluateSessionMfa.mockResolvedValue({
      outcome: 'unauthenticated',
      userId: null,
    });
    const response = await proxy(makeRequest('/dashboard'));
    // The proxy should produce a 307 redirect, NEVER a 500.
    expect(response.status).toBe(307);
    expect(response.headers.get('location')).toContain('/login');
  });

  it('redirect-after-verify lands back on the original protected path on success', async () => {
    // After a TOTP submit the user is back on /verify-2fa?redirect=<original>; a
    // `pass` session must bounce to that path, not the default /dashboard.
    mockEvaluateSessionMfa.mockResolvedValue({
      outcome: 'pass',
      userId: 'user-1',
    });
    const response = await proxy(
      makeRequest('/verify-2fa?redirect=%2Fdeployments'),
    );
    expect(response.status).toBe(307);
    expect(response.headers.get('location')).toContain('/deployments');
  });
});

// Wave 3: mandatory-enrollment gate (`requiresMfaSetup`)

describe('proxy — mandatory 2FA setup gate', () => {
  beforeEach(() => {
    mockValidateSession.mockResolvedValue(null);
    mockEvaluateSessionMfa.mockReset();
  });

  /** Zero-factor accounts resolve to `pass` + `requiresSetup: true` — the normal
   *  shape of this state, not an edge case. */
  function setupRequiredSession(outcome: 'pass' | 'challenge' = 'pass') {
    mockEvaluateSessionMfa.mockResolvedValue({
      outcome,
      userId: 'user-1',
      requiresSetup: true,
    });
  }

  it('redirects a requires-setup session off a protected path to /setup-2fa', async () => {
    setupRequiredSession();
    const response = await proxy(makeRequest('/dashboard'));
    expect(response.status).toBe(307);
    const loc = response.headers.get('location') ?? '';
    expect(loc).toContain('/setup-2fa');
    expect(loc).toContain('redirect=%2Fdashboard');
  });

  it('gates the protected routes the dashboard-only nag never covered', async () => {
    // Why the gate moved into the proxy: /roosts, /talons and /settings were
    // reachable by a zero-factor account that never opened /dashboard.
    setupRequiredSession();
    for (const path of ['/roosts', '/talons', '/settings/api-keys', '/admin']) {
      const response = await proxy(makeRequest(path));
      expect(response.status).toBe(307);
      expect(response.headers.get('location')).toContain('/setup-2fa');
    }
  });

  it('does NOT redirect a requires-setup session that is already on /setup-2fa', async () => {
    // /setup-2fa is inside PROTECTED_PATHS; without the exemption this loops.
    setupRequiredSession();
    const response = await proxy(makeRequest('/setup-2fa'));
    expect(response.headers.get('location')).toBeNull();
  });

  it('sends a requires-setup session to /setup-2fa rather than /verify-2fa when both apply', async () => {
    // Transient state (stale `mfaRequired`, or a fail-closed challenge from a
    // Firestore blip): with no factor to present the challenge page is a dead
    // end, so setup wins.
    setupRequiredSession('challenge');
    const response = await proxy(makeRequest('/dashboard'));
    expect(response.status).toBe(307);
    const loc = response.headers.get('location') ?? '';
    expect(loc).toContain('/setup-2fa');
    expect(loc).not.toContain('/verify-2fa');
  });

  it('renders /setup-2fa (not the challenge) for a requires-setup session with a pending challenge', async () => {
    setupRequiredSession('challenge');
    const response = await proxy(makeRequest('/setup-2fa'));
    expect(response.headers.get('location')).toBeNull();
  });

  it('leaves /api/* untouched — the enrollment gate lives in the routes', async () => {
    // API-side protection is `lib/mfaEnrollmentGate.server.ts`; the proxy must not
    // gate /api or non-browser clients break.
    setupRequiredSession();
    const response = await proxy(makeRequest('/api/sites'));
    expect(response.headers.get('location')).toBeNull();
    expect(response.headers.get(SECURITY_VERSION_HEADER)).toBe(
      String(CURRENT_SECURITY_VERSION),
    );
  });

  it('leaves an enrolled, verified session untouched', async () => {
    mockEvaluateSessionMfa.mockResolvedValue({
      outcome: 'pass',
      userId: 'user-1',
      requiresSetup: false,
    });
    const response = await proxy(makeRequest('/dashboard'));
    expect(response.headers.get('location')).toBeNull();
  });

  it('still challenges an enrolled-but-unverified session (setup gate does not swallow it)', async () => {
    mockEvaluateSessionMfa.mockResolvedValue({
      outcome: 'challenge',
      userId: 'user-1',
      requiresSetup: false,
    });
    const response = await proxy(makeRequest('/dashboard'));
    expect(response.status).toBe(307);
    expect(response.headers.get('location')).toContain('/verify-2fa');
  });

  it('sends an unauthenticated request to /login, never to /setup-2fa', async () => {
    mockEvaluateSessionMfa.mockResolvedValue({
      outcome: 'unauthenticated',
      userId: null,
      requiresSetup: false,
    });
    const response = await proxy(makeRequest('/dashboard'));
    expect(response.status).toBe(307);
    expect(response.headers.get('location')).toContain('/login');
  });
});

// Item 22: CSP header includes a per-request nonce

describe('proxy — CSP header', () => {
  beforeEach(() => {
    mockEvaluateSessionMfa.mockResolvedValue({
      outcome: 'pass',
      userId: 'user-1',
    });
  });

  it('attaches a Content-Security-Policy header on every response', async () => {
    const response = await proxy(makeRequest('/dashboard'));
    const csp = response.headers.get('Content-Security-Policy');
    expect(csp).not.toBeNull();
    expect(csp!.length).toBeGreaterThan(0);
  });

  it('script-src nonce is present and unique per request', async () => {
    // style-src uses 'unsafe-inline', not a nonce: Next 16 emits inline <style>
    // during hydration/navigation that the request nonce can't cover, and browsers
    // ignore 'unsafe-inline' when a nonce is present. Scripts stay nonce +
    // strict-dynamic locked.
    const response = await proxy(makeRequest('/dashboard'));
    const csp = response.headers.get('Content-Security-Policy') ?? '';
    const matches = csp.match(/'nonce-([A-Za-z0-9+/=]+)'/g) ?? [];
    expect(matches.length).toBeGreaterThanOrEqual(1);
    const uniqueNonces = new Set(matches.map((m) => m.split('-')[1]));
    expect(uniqueNonces.size).toBe(1);
  });

  it('generates a fresh nonce on each request', async () => {
    const a = await proxy(makeRequest('/dashboard'));
    const b = await proxy(makeRequest('/dashboard'));
    const cspA = a.headers.get('Content-Security-Policy') ?? '';
    const cspB = b.headers.get('Content-Security-Policy') ?? '';
    const nonceA = (cspA.match(/'nonce-([A-Za-z0-9+/=]+)'/) ?? [])[1];
    const nonceB = (cspB.match(/'nonce-([A-Za-z0-9+/=]+)'/) ?? [])[1];
    expect(nonceA).toBeTruthy();
    expect(nonceB).toBeTruthy();
    expect(nonceA).not.toBe(nonceB);
  });

  it('script-src does NOT allow unsafe-inline', async () => {
    const response = await proxy(makeRequest('/dashboard'));
    const csp = response.headers.get('Content-Security-Policy') ?? '';
    const scriptSrc = csp
      .split(';')
      .map((s) => s.trim())
      .find((s) => s.startsWith('script-src '));
    expect(scriptSrc).toBeTruthy();
    expect(scriptSrc).not.toMatch(/'unsafe-inline'/);
  });

  it("script-src includes 'strict-dynamic' and a nonce", async () => {
    const response = await proxy(makeRequest('/dashboard'));
    const csp = response.headers.get('Content-Security-Policy') ?? '';
    const scriptSrc = csp
      .split(';')
      .map((s) => s.trim())
      .find((s) => s.startsWith('script-src ')) ?? '';
    expect(scriptSrc).toContain("'strict-dynamic'");
    expect(scriptSrc).toMatch(/'nonce-[A-Za-z0-9+/=]+'/);
  });

  it('frame-ancestors is locked to none (clickjacking)', async () => {
    const response = await proxy(makeRequest('/dashboard'));
    const csp = response.headers.get('Content-Security-Policy') ?? '';
    expect(csp).toMatch(/frame-ancestors 'none'/);
  });

  it('attaches CSP on /api/* responses too', async () => {
    mockValidateSession.mockResolvedValue(null);
    const response = await proxy(makeRequest('/api/sites'));
    expect(response.headers.get('Content-Security-Policy')).not.toBeNull();
  });

  it('limits Scalar CSP allowances to the API reference shell', async () => {
    const scalar = await proxy(makeRequest('/docs/api'));
    const scalarCsp = scalar.headers.get('Content-Security-Policy') ?? '';
    expect(scalarCsp).toContain('https://fonts.scalar.com');
    expect(scalarCsp).toContain('https://api.scalar.com');

    const migratedPage = await proxy(makeRequest('/docs/api/authentication'));
    const migratedCsp = migratedPage.headers.get('Content-Security-Policy') ?? '';
    expect(migratedCsp).not.toContain('https://fonts.scalar.com');
    expect(migratedCsp).not.toContain('https://api.scalar.com');
  });
});

// swoop: the page is a protected path, and the signaling socket is the only swoop
// connection CSP can gate — RTCPeerConnection (ICE, STUN/TURN, media) is outside
// connect-src entirely.

describe('proxy — swoop page gate + signaling connect-src', () => {
  const SIGNAL_URL_KEY = 'SWOOP_SIGNAL_URL';
  const originalSignalUrl = process.env[SIGNAL_URL_KEY];

  beforeEach(() => {
    mockValidateSession.mockResolvedValue(null);
    mockEvaluateSessionMfa.mockReset();
    delete process.env[SIGNAL_URL_KEY];
  });

  afterAll(() => {
    if (originalSignalUrl === undefined) {
      delete process.env[SIGNAL_URL_KEY];
    } else {
      process.env[SIGNAL_URL_KEY] = originalSignalUrl;
    }
  });

  function connectSrc(response: Response): string {
    return (response.headers.get('Content-Security-Policy') ?? '')
      .split(';')
      .map((directive) => directive.trim())
      .find((directive) => directive.startsWith('connect-src ')) ?? '';
  }

  it('redirects an unauthenticated /swoop request to /login', async () => {
    mockEvaluateSessionMfa.mockResolvedValue({
      outcome: 'unauthenticated',
      userId: null,
    });
    const response = await proxy(makeRequest('/swoop/site-1/machine-1'));
    expect(response.status).toBe(307);
    const loc = response.headers.get('location') ?? '';
    expect(loc).toContain('/login');
    expect(loc).toContain('redirect=%2Fswoop%2Fsite-1%2Fmachine-1');
  });

  it('challenges an authenticated-but-MFA-pending /swoop request', async () => {
    // A live remote session is keyboard and mouse on someone's machine — a password
    // alone must never reach it.
    mockEvaluateSessionMfa.mockResolvedValue({
      outcome: 'challenge',
      userId: 'user-1',
    });
    const response = await proxy(makeRequest('/swoop/site-1/machine-1'));
    expect(response.status).toBe(307);
    expect(response.headers.get('location')).toContain('/verify-2fa');
  });

  it('allows the signaling origin over https and wss when SWOOP_SIGNAL_URL is set', async () => {
    // The origin only — a path on the env value must not leak into the policy.
    process.env[SIGNAL_URL_KEY] = 'https://swoop-signal.example.workers.dev/v1/room';
    mockEvaluateSessionMfa.mockResolvedValue({ outcome: 'pass', userId: 'user-1' });

    const directive = connectSrc(await proxy(makeRequest('/swoop/site-1/machine-1')));
    expect(directive).toContain('https://swoop-signal.example.workers.dev');
    expect(directive).toContain('wss://swoop-signal.example.workers.dev');
    expect(directive).not.toContain('/v1/room');
  });

  it('emits no swoop origin at all when SWOOP_SIGNAL_URL is unset', async () => {
    // Dev and preview run without a signaling worker; an empty value must not widen
    // connect-src or emit a stray token.
    mockEvaluateSessionMfa.mockResolvedValue({ outcome: 'pass', userId: 'user-1' });

    const directive = connectSrc(await proxy(makeRequest('/swoop/site-1/machine-1')));
    expect(directive).not.toContain('swoop');
    // The Firestore listener source is the only websocket origin left.
    expect(directive.match(/wss:\/\/\S+/g)).toEqual(['wss://*.firebaseio.com']);
  });

  it('ignores a malformed SWOOP_SIGNAL_URL instead of failing every request', async () => {
    // buildContentSecurityPolicy runs on every response; a bad value must not 500 the site.
    process.env[SIGNAL_URL_KEY] = 'not a url';
    mockEvaluateSessionMfa.mockResolvedValue({ outcome: 'pass', userId: 'user-1' });

    const directive = connectSrc(await proxy(makeRequest('/swoop/site-1/machine-1')));
    expect(directive).toContain("connect-src 'self'");
    expect(directive).not.toContain('not a url');
  });
});
