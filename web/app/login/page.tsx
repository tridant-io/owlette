'use client';

import { Suspense, useCallback, useRef, useState, useEffect } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { useAuth } from '@/contexts/AuthContext';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { AuthShell, AuthDivider, AuthFooterDot, authFooterLinkClass } from '@/components/auth/AuthShell';
import { SwoopWindowStrip } from '@/components/swoop/SwoopWindowControls';
import { Fingerprint, Globe } from 'lucide-react';
import { toast } from '@/lib/toast';
import { sanitizeError } from '@/lib/errorHandler';
import { isPopupUnavailableError } from '@/lib/inAppBrowser';
import { resolvePostSignInPath } from '@/lib/postSignIn';
import {
  AppLinkError,
  completeAppLinkSignIn,
  exchangeAppLink,
  safeNextPath,
  startAppLink,
} from '@/lib/appLink';
import { isViewerApp } from '@/lib/swoop/viewerApp';
import { signInWithCustomToken } from 'firebase/auth';
import { auth as firebaseAuth } from '@/lib/firebase';
import {
  WebAuthnAbortService,
  browserSupportsWebAuthn,
  browserSupportsWebAuthnAutofill,
  startAuthentication,
} from '@simplewebauthn/browser';
import { FormError } from '@/components/ui/form-error';
import { InAppBrowserNotice } from '@/components/InAppBrowserNotice';
import { useFieldError } from '@/hooks/useFieldError';
import { useInAppBrowser } from '@/hooks/useInAppBrowser';
import { useRedirectIfAuthenticated } from '@/hooks/useRedirectIfAuthenticated';

// every 3 s for the 10 min a pending code lives is at most 200 exchange calls, under the route's
// 300/h per-ip limit; a faster poll would get a full wait rate-limited part way through.
const APP_LINK_POLL_MS = 3000;
// the client keeps its own 10 min deadline instead of comparing the route's expiresAt with the
// local clock: a clock running ahead would give up on the first poll. the route's 410 still
// ends the wait earlier when the server expires the code first.
const APP_LINK_WAIT_MS = 10 * 60 * 1000;

/**
 * Wire half of a passkey sign-in (options → ceremony → verify → Firebase session), shared by the
 * explicit button and the conditional-UI (autofill) ceremony.
 *
 * Module scope, not a closure over component state: the conditional ceremony stays pending for the
 * life of the page, and an effect depending on a per-render closure would restart it every commit.
 *
 * Resolves true once a Firebase session exists, false when `isCurrent` retired the run before the
 * authenticator was touched. Everything else throws — callers grade failures differently.
 */
async function runPasskeyCeremony({
  useBrowserAutofill = false,
  onCredential,
  isCurrent,
}: {
  useBrowserAutofill?: boolean;
  /** Fires between credential commit and server round-trip — passive prompt becomes a sign-in. */
  onCredential?: () => void;
  /** Polled before the ceremony starts; false retires the run silently. */
  isCurrent?: () => boolean;
} = {}): Promise<boolean> {
  const optionsRes = await fetch('/api/passkeys/authenticate/options', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({}),
  });

  if (!optionsRes.ok) {
    throw new Error('Failed to get authentication options');
  }

  const { options, challengeId } = await optionsRes.json();

  // A conditional run can be retired during that network hop (unmount, strict mode's second pass).
  // Bail before touching the authenticator: under client-side routing the document survives the
  // navigation, so a stray pending ceremony would follow the user onto the next page.
  if (isCurrent && !isCurrent()) {
    return false;
  }

  // Without `useBrowserAutofill` this is the browser's modal prompt; with it the credential is
  // offered in the autofill dropdown and the promise sits pending, possibly for the whole visit.
  const credential = await startAuthentication({ optionsJSON: options, useBrowserAutofill });
  onCredential?.();

  const verifyRes = await fetch('/api/passkeys/authenticate/verify', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ credential, challengeId }),
  });

  if (!verifyRes.ok) {
    const data = await verifyRes.json();
    throw new Error(data.error || 'Passkey authentication failed');
  }

  const { customToken } = await verifyRes.json();

  if (firebaseAuth) {
    await signInWithCustomToken(firebaseAuth, customToken);
  }

  return true;
}

function LoginForm() {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [loading, setLoading] = useState(false);
  /**
   * Progressive disclosure for the email path, mirroring /register. Latches open on first email
   * focus and never closes, so a partly-filled form can't collapse mid-entry.
   */
  const [emailFormOpen, setEmailFormOpen] = useState(false);
  /** Field-targeted validation — see hooks/useFieldError.ts. */
  const { error: formError, fail, clear: clearError, fieldProps } = useFieldError('login-form-error');
  const [redirectUrl, setRedirectUrl] = useState('/dashboard');
  // Detected client-side only (browserSupportsWebAuthn reads window.PublicKeyCredential). Deciding
  // during render is a hydration mismatch (React #418) — recoverable, but it discards the SSR tree,
  // and in E2E the in-flight re-render drops the login click and the suite hangs on /login.
  const [canUsePasskey, setCanUsePasskey] = useState(false);
  /**
   * Can the browser offer passkeys in its own autofill dropdown (conditional UI)? Separate and
   * async from WebAuthn support; resolved off-render for the same hydration reason as canUsePasskey.
   */
  const [canAutofillPasskey, setCanAutofillPasskey] = useState(false);
  /**
   * Google sign-in failed because the popup was refused. Covers unidentified webviews plus ordinary
   * popup blockers, so the remediation appears even when detection said no.
   */
  const [popupBlocked, setPopupBlocked] = useState(false);
  /**
   * inside owlette swoop, whose webview fails both google and passkey sign-in (measured), so a
   * signed-in browser approves the app instead. read after mount, as canUsePasskey.
   */
  const [viewerApp, setViewerApp] = useState(false);
  /** the absolute approval url while its browser approval is being waited on. */
  const [browserWait, setBrowserWait] = useState<string | null>(null);
  const [browserLinkExpired, setBrowserLinkExpired] = useState(false);
  /** identity of the running browser approval poll, or null; a stale run's answers are dropped. */
  const browserRun = useRef<symbol | null>(null);
  const browserPollTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  /**
   * Latched once a sign-in starts here so the guard below can't pre-empt the navigation in
   * progress. A ref, not `loading`: `loading` clears in `finally`, while the push is still in
   * flight — and that push may be to /verify-2fa, not the guard's target.
   */
  const authInFlight = useRef(false);
  /**
   * Identity of the pending conditional-UI ceremony, or null. Doubles as the concurrency guard (a
   * second simultaneous conditional `credentials.get()` throws); cleared by whichever of cleanup,
   * cancel, or the run settling happens first.
   */
  const conditionalRun = useRef<symbol | null>(null);
  const { signIn, signInWithGoogle } = useAuth();
  const inApp = useInAppBrowser();
  const router = useRouter();
  const searchParams = useSearchParams();

  /** Host app recognised up front, or the popup was refused when they tapped. */
  const googleUnavailable = inApp.isInApp || popupBlocked;
  /**
   * Gated on the host app, NOT `googleUnavailable` — a blocked popup in Safari says nothing about
   * WebAuthn. Inside an embedded webview the ceremony can only use the HOST app's associated
   * domain, so browserSupportsWebAuthn() is true while the ceremony always fails.
   * https://passkeys.dev/docs/reference/ios/
   */
  const showPasskey = canUsePasskey && !inApp.isInApp && !viewerApp;
  /** "or" only earns its place while a non-email option is still on screen. */
  const showDivider = !googleUnavailable || showPasskey;
  /**
   * Force the email path open once Google is out rather than hiding the fallback behind a focus
   * gesture. Applies even when passkey survives — it may not be enrolled on this account.
   */
  const emailExpanded = emailFormOpen || googleUnavailable;

  useEffect(() => {
    setCanUsePasskey(browserSupportsWebAuthn());
    setViewerApp(isViewerApp());
  }, []);

  useEffect(() => {
    let active = true;
    browserSupportsWebAuthnAutofill()
      .then((supported) => {
        if (active) setCanAutofillPasskey(supported);
      })
      .catch(() => {
        // Probe failure = no conditional UI. Silent; the explicit passkey button still covers them.
      });
    return () => {
      active = false;
    };
  }, []);

  useEffect(() => {
    setRedirectUrl(safeNextPath(searchParams.get('redirect'), '/dashboard'));
  }, [searchParams]);

  // Shared with /register via lib/postSignIn. As a local helper here it was missed by /register,
  // which then raced the session cookie on every Google signup.
  const checkMfaAndRedirect = (settleMs?: number) =>
    resolvePostSignInPath(redirectUrl, settleMs);

  // Mirrors the proxy rule, which a client-side history pop never reaches. Reads the param directly
  // rather than `redirectUrl`: effects flush in declaration order, so the guard would fire against
  // the '/dashboard' default before setRedirectUrl landed and strand ?redirect=%2Froost visitors.
  useRedirectIfAuthenticated({
    target: safeNextPath(searchParams.get('redirect'), '/dashboard'),
    skip: authInFlight.current,
  });

  const handleEmailLogin = async (e: React.FormEvent) => {
    e.preventDefault();
    clearError();

    // Ours now that the form is noValidate — no native bubble to fall back on.
    if (!email.trim()) {
      return fail('email', 'enter your email address');
    }
    if (!password) {
      return fail('password', 'enter your password');
    }

    authInFlight.current = true;
    setLoading(true);

    try {
      await signIn(email, password);

      // Settles for the session cookie, then polls — see lib/postSignIn.
      const redirectPath = await checkMfaAndRedirect();

      if (redirectPath.includes('/verify-2fa')) {
        toast.info('2FA verification required');
      } else {
        toast.success('logged in successfully!');
      }

      router.push(redirectPath);
    } catch (error) {
      // Re-arm the guard: this page stays mounted and the session can still change (other tab).
      authInFlight.current = false;
      toast.error(sanitizeError(error));
    } finally {
      setLoading(false);
    }
  };

  const handleGoogleLogin = async () => {
    const alreadyBlocked = googleUnavailable;
    authInFlight.current = true;
    setLoading(true);

    try {
      await signInWithGoogle();

      // Settles for the session cookie, then polls — see lib/postSignIn.
      const redirectPath = await checkMfaAndRedirect();

      if (redirectPath.includes('/verify-2fa')) {
        toast.info('2FA verification required');
      } else {
        toast.success('logged in with Google!');
      }

      router.push(redirectPath);
    } catch (error) {
      // Nobody was signed in — re-arm the guard. See the email path above.
      authInFlight.current = false;
      // A refused popup is not transient — this environment cannot do federated sign-in at all, so
      // show the inline remediation rather than a toast that expires with no next step.
      if (isPopupUnavailableError(error)) {
        setPopupBlocked(true);
        // Notice already on screen means they came via "try google anyway"; nothing would change.
        if (alreadyBlocked) {
          toast.error('google sign-in is still blocked in this browser');
        }
      } else {
        toast.error(sanitizeError(error));
      }
    } finally {
      setLoading(false);
    }
  };

  /** stops the browser approval poll; reads only refs, so it is safe as an unmount cleanup. */
  const stopBrowserPoll = useCallback(() => {
    browserRun.current = null;
    if (browserPollTimer.current) clearTimeout(browserPollTimer.current);
    browserPollTimer.current = null;
  }, []);

  useEffect(() => stopBrowserPoll, [stopBrowserPoll]);

  const cancelBrowserSignIn = () => {
    stopBrowserPoll();
    setBrowserWait(null);
  };

  /**
   * owlette swoop's sign-in: a pending app-link code opens in the system browser, which approves it
   * with its own signed-in session; this page polls until the code turns into a custom token whose
   * claim carries the browser's mfa, so the app lands on `next` with no /verify-2fa hop.
   */
  const handleBrowserSignIn = async () => {
    stopBrowserPoll();
    setBrowserLinkExpired(false);
    const next = safeNextPath(searchParams.get('redirect'));
    const run = Symbol('app-link');
    browserRun.current = run;

    setLoading(true);
    let link: Awaited<ReturnType<typeof startAppLink>>;
    try {
      link = await startAppLink();
    } catch (error) {
      toast.error(sanitizeError(error));
      return;
    } finally {
      setLoading(false);
    }
    // unmounted while the code was minted: nothing is left to poll for.
    if (browserRun.current !== run) return;

    // absolute, so the app hands it to the system browser as a web link. the return value says
    // nothing: the app denies the in-app window it would describe, so it is null every time.
    const approveUrl = new URL(link.approveUrl, window.location.origin).toString();
    window.open(approveUrl, '_blank');
    setBrowserWait(approveUrl);

    const expire = () => {
      stopBrowserPoll();
      setBrowserWait(null);
      setBrowserLinkExpired(true);
    };

    const deadline = Date.now() + APP_LINK_WAIT_MS;
    const poll = async () => {
      if (browserRun.current !== run) return;
      if (Date.now() >= deadline) return expire();

      let customToken: string | null = null;
      try {
        const result = await exchangeAppLink(link.code, link.secret);
        if ('customToken' in result) customToken = result.customToken;
      } catch (error) {
        if (browserRun.current !== run) return;
        if (error instanceof AppLinkError && (error.status === 404 || error.status === 410)) {
          return expire();
        }
        // anything else is transient: the next poll retries and the deadline bounds it.
      }
      if (browserRun.current !== run) return;

      if (!customToken) {
        browserPollTimer.current = setTimeout(poll, APP_LINK_POLL_MS);
        return;
      }

      stopBrowserPoll();
      authInFlight.current = true;
      try {
        await completeAppLinkSignIn(customToken);
        router.replace(next);
      } catch (error) {
        authInFlight.current = false;
        setBrowserWait(null);
        toast.error(sanitizeError(error));
      }
    };
    browserPollTimer.current = setTimeout(poll, APP_LINK_POLL_MS);
  };

  /**
   * Where both passkey paths land once a session exists. The verify route already minted the
   * session MFA-satisfied (`requireUserVerification: true` → `mfaSatisfiedBy: 'passkey-uv'`), so a
   * TOTP-enrolled user is born mfaVerified and the proxy skips /verify-2fa. The gate is still
   * decided server-side by the redirect below.
   */
  const finishPasskeySignIn = async () => {
    toast.success('signed in with passkey!');
    // No settle: verify already minted the session cookie, so waiting is dead latency.
    const redirectPath = await checkMfaAndRedirect(0);
    router.push(redirectPath);
  };

  /**
   * Retire the pending conditional-UI ceremony if this page still owns one. Guarded on our own run
   * because `WebAuthnAbortService` is a global singleton — otherwise this would cancel a ceremony
   * the explicit button started. Reads only refs, so the empty deps keep the identity stable and
   * the effect below can use it as a cleanup without restarting every render.
   */
  const cancelConditionalPasskey = useCallback(() => {
    if (!conditionalRun.current) return;
    conditionalRun.current = null;
    WebAuthnAbortService.cancelCeremony();
  }, []);

  const handlePasskeyLogin = async () => {
    authInFlight.current = true;
    setLoading(true);

    try {
      await runPasskeyCeremony();
      await finishPasskeySignIn();
    } catch (error) {
      // Nobody was signed in — re-arm the guard. See the email path above.
      authInFlight.current = false;
      if (error instanceof Error && error.name === 'NotAllowedError') {
        toast.error('passkey authentication was cancelled');
      } else {
        toast.error(sanitizeError(error));
      }
    } finally {
      setLoading(false);
    }
  };

  /**
   * The conditional ceremony must not resolve through the closure it started with — `redirectUrl`
   * can move under it via client-side navigation. Refreshed every commit; depending on the closure
   * in the effect instead would cancel and restart the ceremony on every render.
   */
  const finishPasskeySignInRef = useRef(finishPasskeySignIn);
  useEffect(() => {
    finishPasskeySignInRef.current = finishPasskeySignIn;
  });

  /**
   * WebAuthn conditional UI: offer the passkey inside the browser's autofill dropdown. It must
   * already be pending when the email field is focused, so it starts on mount. Unlike the button:
   *
   *  1. Must not latch `authInFlight`/`loading` up front — this ceremony is long-lived, so that
   *     would disable the form for the whole visit and suppress the already-signed-in guard. Both
   *     latch from `onCredential`, when it stops being passive.
   *  2. No toast on ceremony failure — the user never asked for it. Only failures after a
   *     credential is committed are reported.
   *  3. Gated on `showPasskey`: an embedded webview can only speak for the host app's RP.
   *
   * One ceremony per visit; the explicit button is the retry.
   */
  useEffect(() => {
    if (!showPasskey || !canAutofillPasskey) return;
    // Two concurrent conditional ceremonies throw, and strict mode runs this effect twice. Guard on
    // the run token, not a "has ever started" flag — cleanup clears the token, so strict mode's
    // second pass starts a fresh ceremony instead of leaving none pending.
    if (conditionalRun.current) return;

    const run = Symbol('conditional-passkey');
    conditionalRun.current = run;
    /** Set once the user picks a credential — see note 1 above. */
    let committed = false;

    void (async () => {
      try {
        const signedIn = await runPasskeyCeremony({
          useBrowserAutofill: true,
          isCurrent: () => conditionalRun.current === run,
          onCredential: () => {
            committed = true;
            authInFlight.current = true;
            setLoading(true);
          },
        });
        if (signedIn) {
          await finishPasskeySignInRef.current();
        }
      } catch (error) {
        if (!committed) {
          // Cancelled, aborted, superseded by the button, or options failed while nobody watched.
          return;
        }
        // Past the point of no return: undo what `onCredential` latched, then report.
        authInFlight.current = false;
        setLoading(false);
        toast.error(sanitizeError(error));
      } finally {
        if (conditionalRun.current === run) conditionalRun.current = null;
      }
    })();

    return cancelConditionalPasskey;
  }, [showPasskey, canAutofillPasskey, cancelConditionalPasskey]);

  /** owlette swoop's one passwordless option, or the wait for the browser to approve it. */
  const browserSignIn = browserWait ? (
    <div className="space-y-3">
      <p role="status" className="text-center text-sm text-muted-foreground">
        waiting for your browser…
      </p>
      <p className="text-center text-xs text-muted-foreground">
        didn&apos;t open?{' '}
        <a href={browserWait} target="_blank" rel="noopener" className={authFooterLinkClass}>
          open the sign-in page
        </a>
      </p>
      <Button type="button" variant="outline" className="w-full" onClick={cancelBrowserSignIn}>
        cancel
      </Button>
    </div>
  ) : (
    <>
      <FormError message={browserLinkExpired ? 'that link expired, try again' : null} />
      <Button type="button" className="w-full" onClick={handleBrowserSignIn} disabled={loading}>
        <Globe className="mr-2 h-4 w-4" />
        sign in with your browser
      </Button>
    </>
  );

  return (
    <AuthShell
      footer={
        <>
          <a href="/forgot-password" className={authFooterLinkClass}>
            forgot password?
          </a>
          {/* a phone's card is too narrow for both on one line: the sign-up
              line wraps whole onto its own row instead of mid-phrase */}
          <span className="hidden sm:inline">
            <AuthFooterDot />
          </span>
          <span className="block whitespace-nowrap sm:inline">
            don&apos;t have an account?{' '}
            <a href="/register" className={authFooterLinkClass}>
              sign up
            </a>
          </span>
        </>
      }
    >
      {/* Passwordless first: google + passkey are one group, space-y-6 splits off email. In
          owlette swoop the browser button stands in for both. */}
      <div className="space-y-2">
        {viewerApp ? (
          browserSignIn
        ) : googleUnavailable ? (
          /* Notice carries its own "try google anyway" — detection reorders, never removes. */
          <InAppBrowserNotice
            isInApp={inApp.isInApp}
            appName={inApp.appName}
            escapeAttempted={inApp.escapeAttempted}
            onTryAnyway={handleGoogleLogin}
            tryAnywayDisabled={loading}
          />
        ) : (
        <Button
          type="button"
          variant="outline"
          className="w-full cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed"
          onClick={handleGoogleLogin}
          disabled={loading}
        >
          <svg className="mr-2 h-4 w-4" viewBox="0 0 24 24">
            <path
              d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z"
              fill="#4285F4"
            />
            <path
              d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z"
              fill="#34A853"
            />
            <path
              d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z"
              fill="#FBBC05"
            />
            <path
              d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z"
              fill="#EA4335"
            />
          </svg>
          continue with Google
        </Button>
        )}

        {showPasskey && (
          <Button
            type="button"
            variant="outline"
            className="w-full cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed"
            onClick={handlePasskeyLogin}
            disabled={loading}
          >
            <Fingerprint className="mr-2 h-4 w-4" />
            continue with passkey
          </Button>
        )}
      </div>

      {viewerApp ? (
        <p className="text-center text-sm text-muted-foreground">or use your email and password</p>
      ) : (
        showDivider && <AuthDivider />
      )}

      <form onSubmit={handleEmailLogin} className="space-y-5" noValidate>
        <div className="space-y-2">
          <Label htmlFor="email" className="text-foreground">email</Label>
          <Input
            id="email"
            {...fieldProps('email')}
            type="email"
            // Trailing "webauthn" token is what lists passkeys in this field's autofill
            // dropdown; "username" keeps ordinary autofill and password managers working.
            // owlette swoop drops it: passkeys fail in its webview.
            autoComplete={viewerApp ? 'username' : 'username webauthn'}
            placeholder="you@example.com"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            // Focus (not click) so keyboard tabbing expands it, and so e2e fill() — which
            // focuses first, email before password — opens the form for the suite.
            onFocus={() => setEmailFormOpen(true)}
            required
            disabled={loading}
            className="dark:bg-input border-border text-foreground placeholder:text-muted-foreground"
          />
        </div>

        {emailExpanded && (
          <div className="form-reveal">
            <div className="space-y-5">
            <div className="space-y-2">
              <Label htmlFor="password" className="text-foreground">password</Label>
              <Input
                id="password"
                {...fieldProps('password')}
                type="password"
                placeholder="••••••••"
                value={password}
                onChange={(e) => {
                  setPassword(e.target.value);
                  // Password path chosen — retire the pending autofill ceremony.
                  cancelConditionalPasskey();
                }}
                required
                disabled={loading}
                className="dark:bg-input border-border text-foreground placeholder:text-muted-foreground"
              />
            </div>
            <FormError message={formError?.message} id="login-form-error" />
            <Button type="submit" className="w-full text-background font-medium cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed" disabled={loading}>
              {loading ? 'signing in...' : 'sign in with email'}
            </Button>
            </div>
          </div>
        )}
      </form>
    </AuthShell>
  );
}

export default function LoginPage() {
  return (
    <>
      {/* owlette swoop's window has no frame: its controls, and nothing in a browser */}
      <SwoopWindowStrip />
      {/* Same shell as the loaded form, so the card doesn't change shape when the
          suspense boundary resolves. */}
      <Suspense fallback={<AuthShell loading />}>
        <LoginForm />
      </Suspense>
    </>
  );
}
