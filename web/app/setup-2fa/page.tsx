'use client';

import { useState, useEffect, useCallback } from 'react';
import { useRouter } from 'next/navigation';
import {
  browserSupportsWebAuthn,
  startAuthentication,
  startRegistration,
} from '@simplewebauthn/browser';
import { Fingerprint, Smartphone } from 'lucide-react';
import { useAuth } from '@/contexts/AuthContext';
import { useInAppBrowser } from '@/hooks/useInAppBrowser';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { AuthShell, authFooterLinkClass } from '@/components/auth/AuthShell';
import { BackupCodesPanel } from '@/components/BackupCodesPanel';
import { toast } from '@/lib/toast';
/* eslint-disable @next/next/no-img-element */

/**
 * The enrollment wizard.
 *
 *   choose ─┬─ totp-setup ─ totp-verify ─┬─ backup
 *           └─ passkey-register ─────────┘
 *
 * `choose` exists because a TOTP-only page locked out testers with no phone to
 * hand. Both branches end at `backup`, so recovery material is always issued.
 */
type SetupStep = 'choose' | 'totp-setup' | 'totp-verify' | 'passkey-register' | 'backup';

/** A refusal body from the enrollment routes — `{ error, code }` repo-wide. */
interface EnrollmentErrorBody {
  error?: string;
  code?: string;
}

export default function Setup2FAPage() {
  const { user, loading, requiresMfaSetup, signOut } = useAuth();
  const router = useRouter();
  const inApp = useInAppBrowser();

  const [secret, setSecret] = useState('');
  const [qrCodeUrl, setQrCodeUrl] = useState('');
  const [verificationCode, setVerificationCode] = useState('');
  const [backupCodes, setBackupCodes] = useState<string[]>([]);
  const [step, setStep] = useState<SetupStep>('choose');
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [isCancelling, setIsCancelling] = useState(false);
  /** True while either of the passkey branch's two WebAuthn ceremonies runs. */
  const [passkeyBusy, setPasskeyBusy] = useState(false);
  /**
   * Credential exists; register/verify already promoted the session for the
   * FIRST factor, so the rest of the step is only about recovery codes.
   */
  const [passkeyCreated, setPasskeyCreated] = useState(false);
  /**
   * Client-only detection (`window.PublicKeyCredential`), so it starts
   * 'unknown' to match the server render. The third state separates "not
   * checked yet" (say nothing) from "unsupported" (explain the missing option).
   */
  const [passkeySupport, setPasskeySupport] = useState<'unknown' | 'yes' | 'no'>('unknown');

  /**
   * Embedded webviews expose the API but can only use credentials for the HOST
   * app's associated domain, never owlette.app — so hide the button rather than
   * offer a guaranteed failure. TOTP carries the whole flow when false.
   */
  const showPasskey = passkeySupport === 'yes' && !inApp.isInApp;

  useEffect(() => {
    setPasskeySupport(browserSupportsWebAuthn() ? 'yes' : 'no');
  }, []);

  /**
   * Turn an enrollment refusal into something actionable. Only
   * `mfa_challenge_required` is branched on: a session that already holds a
   * factor 403s here, and the fix is clearing the challenge — so route them to
   * /verify-2fa instead of printing the slug.
   */
  const reportEnrollmentFailure = useCallback(
    (status: number, data: EnrollmentErrorBody, fallback: string) => {
      if (status === 403 && data.code === 'mfa_challenge_required') {
        toast.error('verify your existing 2FA first', {
          description:
            'this account already has a factor, so this session has to clear a challenge before adding another. taking you there now.',
        });
        router.push('/verify-2fa');
        return;
      }
      toast.error(data.error || fallback);
    },
    [router],
  );

  useEffect(() => {
    if (!loading && !user) {
      // replace, not push — pushing leaves /setup-2fa one back-press away, and
      // it re-redirects immediately. Also collapses handleCancel's double entry.
      router.replace('/login');
      return;
    }

    // Only once the TOTP branch is chosen — minting up front would leave a
    // half-finished authenticator entry on every passkey user's account.
    if (user && step === 'totp-setup' && !secret) {
      (async () => {
        try {
          const res = await fetch('/api/mfa/setup', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            credentials: 'include',
            body: JSON.stringify({
              userId: user.uid,
              email: user.email,
            }),
          });
          const data = await res.json();
          if (!res.ok || data.error) {
            reportEnrollmentFailure(res.status, data, `server error (${res.status})`);
            return;
          }
          setSecret(data.secret);
          setQrCodeUrl(data.qrCodeUrl);
        } catch (error) {
          console.error('Failed to generate MFA setup:', error);
          toast.error('failed to generate QR code', {
            description: error instanceof Error ? error.message : undefined,
          });
        }
      })();
    }
  }, [user, loading, router, step, secret, reportEnrollmentFailure]);

  const handleVerify = async (e: React.FormEvent) => {
    e.preventDefault();

    if (!verificationCode || verificationCode.length !== 6) {
      toast.error('enter the 6-digit code');
      return;
    }

    if (!user) {
      toast.error('you are not signed in');
      return;
    }

    setIsSubmitting(true);

    try {
      // `verify-setup` mints the sheet server-side and returns the plaintext
      // exactly once, keeping hashing/count/ordering on one side of the wire.
      const response = await fetch('/api/mfa/verify-setup', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          userId: user.uid,
          code: verificationCode,
        }),
      });

      const data = await response.json();

      if (!response.ok || data.error) {
        if (response.status === 403 && data.code === 'mfa_challenge_required') {
          reportEnrollmentFailure(response.status, data, 'could not enable 2FA');
          return;
        }
        toast.error(data.error || 'invalid code', {
          description: 'check your authenticator app and try again.',
        });
        return;
      }

      toast.success('2FA enabled', {
        description: 'two-factor authentication is on for this account.',
      });

      const issued: string[] = Array.isArray(data.backupCodes)
        ? data.backupCodes.filter((code: unknown): code is string => typeof code === 'string')
        : [];

      if (issued.length === 0) {
        // Shouldn't happen. An empty "save these codes" panel lies; the factor
        // is enrolled regardless, so let them through to a replacement surface.
        toast.error('your backup codes did not come through', {
          description: 'generate a new set from account settings.',
        });
        // replace, not push — the factor is enrolled, so this is an exit.
        router.replace('/dashboard');
        return;
      }

      setBackupCodes(issued);
      setStep('backup');
    } catch (error) {
      console.error('Error enabling 2FA:', error);
      toast.error('failed to enable 2FA');
    } finally {
      setIsSubmitting(false);
    }
  };

  /**
   * Ceremony runs inline rather than via `PasskeyManager`/`usePasskeys`: that
   * hook refetches `/api/passkeys/list` after every write and the component is
   * a list surface, neither of which suits a one-shot wizard step. Same
   * three-step ceremony, so the request shapes stay in step.
   *
   * No name prompt during mandatory setup — the server defaults to "Passkey"
   * and account settings can rename it.
   */
  const handleCreatePasskey = async () => {
    if (!user) {
      toast.error('you are not signed in');
      return;
    }

    setPasskeyBusy(true);
    try {
      const optionsRes = await fetch('/api/passkeys/register/options', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ userId: user.uid }),
      });
      const options = await optionsRes.json();
      if (!optionsRes.ok || options.error) {
        reportEnrollmentFailure(optionsRes.status, options, 'could not start passkey setup');
        return;
      }

      const credential = await startRegistration({ optionsJSON: options });

      const verifyRes = await fetch('/api/passkeys/register/verify', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ userId: user.uid, credential }),
      });
      const verifyData = await verifyRes.json();
      if (!verifyRes.ok || verifyData.error) {
        reportEnrollmentFailure(verifyRes.status, verifyData, 'could not finish passkey setup');
        return;
      }

      setPasskeyCreated(true);
      toast.success('passkey created', {
        description: 'you can sign in with it from now on.',
      });
    } catch (error) {
      if (error instanceof Error && error.name === 'NotAllowedError') {
        toast.error('passkey setup was cancelled');
      } else {
        console.error('Error registering passkey:', error);
        toast.error(error instanceof Error ? error.message : 'failed to create passkey');
      }
    } finally {
      setPasskeyBusy(false);
    }
  };

  /**
   * `/api/mfa/backup-codes` demands live proof of possession in the request (a
   * warm session is not enough, no bypass), so the just-registered passkey is
   * re-asserted. The second system prompt is deliberate; the button names it
   * first, which also keeps `credentials.get` in a user gesture (Safari).
   */
  const handleClaimBackupCodes = async () => {
    setPasskeyBusy(true);
    try {
      const optionsRes = await fetch('/api/passkeys/step-up/options', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      });
      const optionsData = await optionsRes.json();
      if (!optionsRes.ok || optionsData.error) {
        toast.error(optionsData.error || 'could not start passkey verification');
        return;
      }

      const credential = await startAuthentication({ optionsJSON: optionsData.options });

      const codesRes = await fetch('/api/mfa/backup-codes', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ credential, challengeId: optionsData.challengeId }),
      });
      const codesData = await codesRes.json();
      if (!codesRes.ok || codesData.error) {
        toast.error(codesData.error || 'could not create backup codes');
        return;
      }

      const issued: string[] = Array.isArray(codesData.backupCodes)
        ? codesData.backupCodes.filter((code: unknown): code is string => typeof code === 'string')
        : [];
      if (issued.length === 0) {
        toast.error('your backup codes did not come through', {
          description: 'try again, or generate a set from account settings.',
        });
        return;
      }

      setBackupCodes(issued);
      setStep('backup');
    } catch (error) {
      if (error instanceof Error && error.name === 'NotAllowedError') {
        toast.error('passkey verification was cancelled');
      } else {
        console.error('Error creating backup codes:', error);
        toast.error(error instanceof Error ? error.message : 'failed to create backup codes');
      }
    } finally {
      setPasskeyBusy(false);
    }
  };

  /**
   * `replace`, not `push`: enrolment is finished, so /setup-2fa must not sit one
   * back-press behind /dashboard. Pushing left a fully-enrolled user able to
   * walk back into the setup flow, which then had nothing to do. Same rule the
   * signed-out guard above already follows.
   */
  const handleFinish = () => {
    toast.success('setup complete', {
      description: 'you can now access your dashboard.',
    });
    router.replace('/dashboard');
  };

  /**
   * OWLETTE-WEB-46: `router.back()` sent new signups to /register, where a
   * blank form made them re-submit and hit auth/email-already-in-use. History
   * is not a destination — branch on why they are here instead:
   *   - mandatory (`requiresMfaSetup` from bootstrapUser.server.ts):
   *     /dashboard bounces straight back, so sign out is the only exit.
   *   - voluntary (second factor from settings): /dashboard.
   */
  const handleCancel = async () => {
    if (!requiresMfaSetup) {
      router.replace('/dashboard');
      return;
    }

    setIsCancelling(true);
    try {
      await signOut();
    } catch {
      // signOut raises its own toast; stay put rather than sending a still
      // signed-in user to /login.
      setIsCancelling(false);
      return;
    }
    router.replace('/login');
  };

  /** Mandatory setup has nothing to cancel back to — name it "sign out". */
  const cancelLabel = requiresMfaSetup ? 'sign out' : 'cancel';

  const copyToClipboard = (text: string) => {
    navigator.clipboard.writeText(text);
    toast.success('copied to clipboard');
  };

  /**
   * One definition so the OWLETTE-WEB-46 destination and label can't drift per
   * step. Lives in the shell's footer band now — rendered once for the whole
   * wizard instead of at the foot of four of the five steps. Still a real
   * <button>: setup-2fa-cancel.test.tsx queries it by button role.
   */
  const cancelButton = (
    <Button
      type="button"
      variant="link"
      onClick={handleCancel}
      disabled={isCancelling || isSubmitting || passkeyBusy}
      className={`h-auto p-0 text-sm ${authFooterLinkClass}`}
    >
      {cancelLabel}
    </Button>
  );

  if (loading) {
    return (
      <AuthShell width="wide" brandTitle="set up two-factor authentication" loading />
    );
  }

  return (
    /* `wide` pins the brand panel at 20rem and gives the rest to the form: this
       column carries a QR code, its explainer, and a ten-row backup-code sheet. */
    <AuthShell
      width="wide"
      brandTitle="set up two-factor authentication"
      brandDescription="secure your account with two-factor authentication (2FA)"
      footer={cancelButton}
    >
      {step === 'choose' && (
        <div className="space-y-6">
          <div className="text-sm text-muted-foreground space-y-2">
            <p className="font-semibold text-foreground">choose your second factor</p>
            <p>pick one to finish setting up. you can add the other later from account settings.</p>
          </div>

          {/* Passkey first, and labelled recommended: one ceremony, no
              second device, and it replaces the password at sign-in too. */}
          <div className="space-y-3">
            {showPasskey && (
              <button
                type="button"
                onClick={() => setStep('passkey-register')}
                className="w-full cursor-pointer rounded-lg border border-border bg-card/50 p-4 text-left transition-colors hover:border-accent-cyan hover:bg-muted/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              >
                <div className="flex items-start gap-3">
                  <Fingerprint className="mt-0.5 h-5 w-5 shrink-0 text-accent-cyan" />
                  <div className="space-y-1">
                    <p className="flex flex-wrap items-center gap-2 text-sm font-semibold text-foreground">
                      passkey
                      <span className="rounded-full border border-accent-cyan/40 px-2 py-0.5 text-xs font-medium text-accent-cyan">
                        recommended
                      </span>
                    </p>
                    <p className="text-sm text-muted-foreground">
                      use windows hello, touch ID, face ID, a security key, or a password manager.
                      nothing else to install.
                    </p>
                  </div>
                </div>
              </button>
            )}

            <button
              type="button"
              onClick={() => setStep('totp-setup')}
              className="w-full cursor-pointer rounded-lg border border-border bg-card/50 p-4 text-left transition-colors hover:border-accent-cyan hover:bg-muted/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              <div className="flex items-start gap-3">
                <Smartphone className="mt-0.5 h-5 w-5 shrink-0 text-muted-foreground" />
                <div className="space-y-1">
                  <p className="text-sm font-semibold text-foreground">authenticator app</p>
                  <p className="text-sm text-muted-foreground">
                    use a 6-digit code app on your phone or desktop — 1Password, Bitwarden, Authy,
                    Google Authenticator.
                  </p>
                </div>
              </div>
            </button>
          </div>

          {/* Only once the client has actually checked. Declaring "not
              supported" during the pre-hydration render would be a guess,
              and this is the sentence that stops a user hunting for an
              option that was never going to appear. */}
          {passkeySupport !== 'unknown' && !showPasskey && (
            <p className="text-xs text-muted-foreground">
              {inApp.isInApp
                ? `passkeys cannot be created inside ${inApp.appName ?? 'this app'}'s in-app browser — open owlette in your browser if you want one.`
                : 'this browser cannot create passkeys, so an authenticator app is the way in here.'}
            </p>
          )}
        </div>
      )}

      {step === 'totp-setup' && (
        <div className="space-y-6">
          <div className="text-sm text-muted-foreground space-y-2">
            <p className="font-semibold text-foreground">scan the QR code</p>
            <p>open your authenticator app (1Password, Bitwarden, Authy, Google Authenticator) and scan this QR code:</p>
          </div>

          {qrCodeUrl && (
            <div className="flex justify-center">
              {/* h-auto max-w-full: the intrinsic 250px overflows a 320px
                  viewport's column, and the card is overflow-hidden, so it
                  would be clipped rather than scrolled. */}
              <img
                src={qrCodeUrl}
                alt="2FA QR code"
                width={250}
                height={250}
                className="h-auto max-w-full rounded-lg border"
              />
            </div>
          )}

          <div className="space-y-2">
            <Label htmlFor="totp-secret" className="font-semibold text-muted-foreground">manual entry code:</Label>
            {/* Stacked until the column is wide enough: side by side, the
                copy button left the field showing about a third of a 32-char
                secret on a phone — and manual transcription is this control's
                entire purpose. Stays a single readonly input; setup-verify
                reads the secret with locator('input[readonly]'). */}
            <div className="flex flex-col gap-2 @sm/auth-form:flex-row">
              <Input
                id="totp-secret"
                value={secret}
                readOnly
                className="font-mono text-sm"
              />
              <Button
                type="button"
                variant="outline"
                onClick={() => copyToClipboard(secret)}
                className="@sm/auth-form:w-auto"
              >
                copy
              </Button>
            </div>
            <p className="text-xs text-muted-foreground">
              if you cannot scan the QR code, enter this code manually in your authenticator app —
              desktop apps take it too, so you do not need a phone.
            </p>
          </div>

          <div className="space-y-2">
            <Button
              onClick={() => setStep('totp-verify')}
              className="w-full text-background cursor-pointer"
            >
              continue to verification
            </Button>
            <Button
              type="button"
              variant="outline"
              onClick={() => setStep('choose')}
              className="w-full"
            >
              back
            </Button>
          </div>
        </div>
      )}

      {step === 'totp-verify' && (
        <form onSubmit={handleVerify} className="space-y-6">
          <div className="text-sm text-muted-foreground space-y-2">
            <p className="font-semibold text-foreground">verify your authenticator</p>
            <p>enter the 6-digit code from your authenticator app to verify:</p>
          </div>

          <div className="space-y-2">
            <Label htmlFor="totp-code" className="sr-only">6-digit code</Label>
            <Input
              id="totp-code"
              type="text"
              placeholder="000000"
              value={verificationCode}
              onChange={(e) => setVerificationCode(e.target.value.replace(/\D/g, '').slice(0, 6))}
              maxLength={6}
              className="text-center text-2xl font-mono tracking-widest h-16 px-4"
              autoComplete="one-time-code"
              inputMode="numeric"
              name="otp"
              autoFocus
            />
          </div>

          <div className="space-y-2">
            <Button
              type="submit"
              disabled={isSubmitting || verificationCode.length !== 6}
              className="w-full text-background cursor-pointer"
            >
              {isSubmitting ? 'verifying...' : 'verify & enable 2FA'}
            </Button>
            <Button
              type="button"
              variant="outline"
              onClick={() => setStep('totp-setup')}
              disabled={isSubmitting}
              className="w-full"
            >
              back
            </Button>
          </div>
        </form>
      )}

      {step === 'passkey-register' && (
        <div className="space-y-6">
          <div className="text-sm text-muted-foreground space-y-2">
            <p className="font-semibold text-foreground">
              {passkeyCreated ? 'passkey added' : 'create your passkey'}
            </p>
            <p>
              {passkeyCreated
                ? 'one more check with the same passkey and we can hand you your backup codes — the codes that get you back in if you ever lose this device.'
                : 'your device will ask for its usual unlock: fingerprint, face, PIN, or your security key. that unlock is what proves it is you, so there is no code to type.'}
            </p>
          </div>

          <div className="space-y-2">
            {passkeyCreated ? (
              <>
                <Button
                  type="button"
                  onClick={handleClaimBackupCodes}
                  disabled={passkeyBusy}
                  className="w-full text-background cursor-pointer"
                >
                  {passkeyBusy ? 'waiting for your device...' : 'get backup codes'}
                </Button>
                {/* The factor is already enrolled, so nothing on this screen
                    may hold the dashboard hostage — a cancelled prompt must
                    not strand a fully set-up account here. */}
                <Button
                  type="button"
                  variant="outline"
                  onClick={handleFinish}
                  disabled={passkeyBusy}
                  className="w-full"
                >
                  skip for now
                </Button>
              </>
            ) : (
              <>
                <Button
                  type="button"
                  onClick={handleCreatePasskey}
                  disabled={passkeyBusy}
                  className="w-full text-background cursor-pointer"
                >
                  {passkeyBusy ? 'waiting for your device...' : 'create passkey'}
                </Button>
                <Button
                  type="button"
                  variant="outline"
                  onClick={() => setStep('choose')}
                  disabled={passkeyBusy}
                  className="w-full"
                >
                  back
                </Button>
              </>
            )}
          </div>
        </div>
      )}

      {step === 'backup' && (
        <div className="space-y-6">
          <BackupCodesPanel codes={backupCodes} />

          <Button
            onClick={handleFinish}
            className="w-full text-background cursor-pointer"
          >
            continue to dashboard
          </Button>
        </div>
      )}
    </AuthShell>
  );
}
