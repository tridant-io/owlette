'use client';

import { useState, useEffect, useSyncExternalStore, Suspense } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { useAuth } from '@/contexts/AuthContext';
import { doc, getDoc } from 'firebase/firestore';
import { db } from '@/lib/firebase';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { AuthShell, AuthDivider, authFooterLinkClass } from '@/components/auth/AuthShell';
import { Checkbox } from '@/components/ui/checkbox';
import { Label } from '@/components/ui/label';
import { Fingerprint } from 'lucide-react';
import { cn } from '@/lib/utils';
import { browserSupportsWebAuthn, startAuthentication } from '@simplewebauthn/browser';
import { useInAppBrowser } from '@/hooks/useInAppBrowser';
import { toast } from '@/lib/toast';

/**
 * `browserSupportsWebAuthn()` reads `window.PublicKeyCredential`, so answering it during
 * render makes the passkey button server-absent / client-present. React recovers from that
 * hydration mismatch by discarding the SSR tree, which has swallowed clicks on these auth
 * pages before (see `canUsePasskey` in app/login/page.tsx).
 *
 * useSyncExternalStore rather than a mounted flag (matching `useInAppBrowser`): the server
 * snapshot is a real value, not an initial state to correct, so no cascading render. The
 * environment can't change within a document, so there is nothing to subscribe to.
 */
const subscribeWebAuthnSupport = () => () => {};
const getWebAuthnSupport = () => browserSupportsWebAuthn();
const getWebAuthnSupportOnServer = () => false;

/**
 * Leave the challenge with a document load, NOT `router.push`.
 *
 * The proxy redirects a gated destination here whenever the session cookie is
 * still `mfaVerified: false` — and that includes the *prefetch* next/link fires
 * for "go to dashboard" on the landing header. The App Router caches that
 * redirect against the destination segment, so once the gate is satisfied a
 * client-side push resolves to the cached redirect and lands back on this page:
 * the screen never changes and only a manual reload gets through (reported by
 * Davor, 2026-09-04, via the passkey path).
 *
 * A document load re-runs the proxy against the freshly-minted cookie and
 * discards the stale router cache, so it is correct regardless of whether the
 * cache or the cookie is the straggler. `returnUrl` is already constrained to a
 * same-origin relative path by the open-redirect guard in the component.
 */
function leaveChallenge(returnUrl: string) {
  window.location.assign(returnUrl);
}

function Verify2FAContent() {
  const { user, loading, signOut } = useAuth();
  const router = useRouter();
  const searchParams = useSearchParams();
  // Accept `redirect` (proxy + login page) and the historical `return`. Must be a
  // same-origin relative path, else /dashboard — open-redirect guard.
  const rawReturn = searchParams.get('redirect') ?? searchParams.get('return') ?? '/dashboard';
  const returnUrl = (rawReturn.startsWith('/') && !rawReturn.startsWith('//')) ? rawReturn : '/dashboard';

  const [verificationCode, setVerificationCode] = useState('');
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [useBackupCode, setUseBackupCode] = useState(false);
  const [trustThisDevice, setTrustThisDevice] = useState(false);
  const [, setMfaReady] = useState(false);
  const canUsePasskey = useSyncExternalStore(
    subscribeWebAuthnSupport,
    getWebAuthnSupport,
    getWebAuthnSupportOnServer
  );
  const [isPasskeyPending, setIsPasskeyPending] = useState(false);
  const inApp = useInAppBrowser();
  /** Also gated on the host app: in an embedded webview the ceremony can only use the HOST
   * app's passkeys, so browserSupportsWebAuthn() is true but the prompt always fails. Safe
   * to hide — TOTP and backup codes are always rendered. */
  const showPasskey = canUsePasskey && !inApp.isInApp;

  useEffect(() => {
    if (!loading && !user) {
      router.push('/login');
      return;
    }

    // The proxy already gates this page; the client re-check picks the right copy and
    // handles landing here with no active challenge (stale bookmark after disabling MFA).
    if (user && db) {
      const userDocRef = doc(db, 'users', user.uid);
      getDoc(userDocRef)
        .then((docSnap) => {
          if (docSnap.exists()) {
            const userData = docSnap.data();

            // Not enrolled: nothing to verify.
            if (!userData.mfaEnrolled) {
              leaveChallenge(returnUrl);
              return;
            }

            setMfaReady(true);
          } else {
            // No user document: nothing to verify.
            leaveChallenge(returnUrl);
          }
        })
        .catch((error) => {
          console.error('Error loading MFA configuration:', error);
          toast.error('failed to load 2FA configuration');
        });
    }
  }, [user, loading, router, returnUrl]);

  const handleVerify = async (e: React.FormEvent) => {
    e.preventDefault();

    if (!verificationCode) {
      toast.error('please enter a verification code');
      return;
    }

    if (!useBackupCode && verificationCode.length !== 6) {
      toast.error('please enter a 6-digit code');
      return;
    }

    if (!user) {
      toast.error('user not authenticated');
      return;
    }

    setIsSubmitting(true);

    try {
      // Server-side verify — the TOTP secret never reaches the client.
      const response = await fetch('/api/mfa/verify-login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          userId: user.uid,
          code: verificationCode,
          isBackupCode: useBackupCode,
          trustDevice: trustThisDevice,
        }),
      });

      const data = await response.json();

      if (!response.ok || data.error) {
        toast.error(data.error || 'invalid code', {
          description: useBackupCode
            ? 'the backup code you entered is incorrect.'
            : 'please check your authenticator app and try again.',
        });
        setIsSubmitting(false);
        setVerificationCode('');
        return;
      }

      // No success toast here. `leaveChallenge` is a document load, which tears the
      // toaster down before anything renders — a toast on this path is guaranteed
      // unseen, so the dashboard arriving IS the confirmation. (Failures below keep
      // theirs: those paths stay on the page.)
      //
      // /api/mfa/verify-login has already flipped the session cookie to
      // mfaVerified=true and, when "trust this device" was checked, minted the
      // HTTPOnly device-trust cookie.
      leaveChallenge(returnUrl);
    } catch (error) {
      console.error('Error verifying 2FA:', error);
      toast.error('verification failed');
      setIsSubmitting(false);
    }
  };

  /**
   * Satisfy the gate with an owned passkey instead of a TOTP or backup code.
   *
   * Runs against `/api/passkeys/step-up/*`, NOT the `/authenticate/*` routes /login uses:
   * the caller is already signed in, so step-up requires a session, scopes the ceremony to
   * that session's uid, and only flips the MFA gate — no session or custom token is minted,
   * hence no `signInWithCustomToken` here.
   *
   * "trust this device" belongs to the code form; only /api/mfa/verify-login mints that cookie.
   */
  const handlePasskeyStepUp = async () => {
    if (!user) {
      toast.error('user not authenticated');
      return;
    }

    setIsPasskeyPending(true);

    try {
      // Options are scoped server-side to this session's own credentials.
      const optionsRes = await fetch('/api/passkeys/step-up/options', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      });

      const optionsData = await optionsRes.json();

      if (!optionsRes.ok) {
        toast.error(
          optionsData.code === 'no_passkeys'
            ? 'no passkeys are registered on this account'
            : 'could not start the passkey prompt',
          {
            description: 'use your authenticator app or a backup code instead.',
          }
        );
        setIsPasskeyPending(false);
        return;
      }

      // Browser prompt (PIN/biometric — the server demands `uv`).
      const credential = await startAuthentication({ optionsJSON: optionsData.options });

      // On success the session cookie is already mfaVerified=true when this resolves.
      const verifyRes = await fetch('/api/passkeys/step-up/verify', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ credential, challengeId: optionsData.challengeId }),
      });

      if (!verifyRes.ok) {
        toast.error('passkey verification failed', {
          description: 'please try again, or use your authenticator app.',
        });
        setIsPasskeyPending(false);
        return;
      }

      // No success toast — see the note on the code path above.
      leaveChallenge(returnUrl);
    } catch (error) {
      // Cancel/timeout is a user action, not a fault — don't surface the raw DOMException.
      if (error instanceof Error && error.name === 'NotAllowedError') {
        toast.error('passkey prompt was cancelled');
      } else {
        console.error('Error verifying passkey step-up:', error);
        toast.error('passkey verification failed');
      }
      setIsPasskeyPending(false);
    }
  };

  const handleCancel = async () => {
    await signOut();
    router.push('/login');
  };

  if (loading) {
    return <AuthShell brandTitle="two-factor authentication" loading />;
  }

  return (
    <AuthShell
      brandTitle="two-factor authentication"
      brandDescription={
        useBackupCode
          ? 'enter one of your backup codes'
          : 'enter the code from your authenticator app'
      }
      footer={
        <Button
          type="button"
          variant="link"
          onClick={handleCancel}
          className={`h-auto p-0 text-sm ${authFooterLinkClass}`}
        >
          cancel and sign out
        </Button>
      }
    >
      {/* Passkey sits ABOVE the code form, mirroring /login's ordering, so
          the "trust this device" checkbox reads as belonging to the code
          path it actually applies to. Hidden entirely in an embedded
          webview or a browser without WebAuthn — the form below is always
          rendered, so hiding this never strands the user. */}
      {showPasskey && (
        <>
          <Button
            type="button"
            variant="outline"
            className="w-full"
            onClick={handlePasskeyStepUp}
            disabled={isSubmitting || isPasskeyPending}
          >
            <Fingerprint className="mr-2 h-4 w-4" />
            {isPasskeyPending ? 'waiting for passkey...' : 'use a passkey'}
          </Button>
          <AuthDivider />
        </>
      )}

      <form onSubmit={handleVerify} className="space-y-6">
        <div className="space-y-2">
          <Label htmlFor="otp-code" className="sr-only">
            {useBackupCode ? 'backup code' : '6-digit code'}
          </Label>
          <Input
            id="otp-code"
            type="text"
            name="otp"
            autoComplete="one-time-code"
            inputMode={useBackupCode ? 'text' : 'numeric'}
            placeholder={useBackupCode ? 'backup code' : '000000'}
            value={verificationCode}
            onChange={(e) => {
              const value = useBackupCode
                ? e.target.value.toUpperCase()
                : e.target.value.replace(/\D/g, '').slice(0, 6);
              setVerificationCode(value);
            }}
            maxLength={useBackupCode ? 16 : 6}
            /* h-16 px-4 because text-2xl (32px line box) clips inside the
               Input primitive's h-9 at every viewport — /setup-2fa's
               identical field already does this. A 16-char backup code at
               text-2xl + tracking-widest needs ~269px, more than the column
               has on a phone, so that mode steps down a size until the
               column is wide enough. */
            className={cn(
              'h-16 px-4 text-center font-mono tracking-widest',
              useBackupCode ? 'text-lg @sm/auth-form:text-2xl' : 'text-2xl',
            )}
            autoFocus
          />
        </div>

        {/* Trust Device Checkbox */}
        <div className="flex items-center space-x-2">
          <Checkbox
            id="trustDevice"
            checked={trustThisDevice}
            onCheckedChange={(checked) => setTrustThisDevice(checked === true)}
            className="border-border"
          />
          <Label
            htmlFor="trustDevice"
            className="text-sm text-foreground cursor-pointer"
          >
            trust this device for 30 days
          </Label>
        </div>

        <Button
          type="submit"
          disabled={
            isSubmitting ||
            isPasskeyPending ||
            (!useBackupCode && verificationCode.length !== 6) ||
            (useBackupCode && !verificationCode)
          }
          className="w-full"
        >
          {isSubmitting ? 'verifying...' : 'verify'}
        </Button>

        {/* Stays in the form, directly under submit: it changes the field
            above it. Only the sign-out escape moves to the footer band. */}
        <Button
          type="button"
          variant="link"
          onClick={() => {
            setUseBackupCode(!useBackupCode);
            setVerificationCode('');
          }}
          className="w-full text-sm"
        >
          {useBackupCode
            ? 'use authenticator app instead'
            : 'use backup code instead'}
        </Button>
      </form>
    </AuthShell>
  );
}

export default function Verify2FAPage() {
  return (
    <Suspense fallback={<AuthShell brandTitle="two-factor authentication" loading />}>
      <Verify2FAContent />
    </Suspense>
  );
}
