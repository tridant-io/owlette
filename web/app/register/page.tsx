'use client';

import { useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { useAuth } from '@/contexts/AuthContext';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Checkbox } from '@/components/ui/checkbox';
import Link from 'next/link';
import { AuthShell, AuthDivider, authFooterLinkClass } from '@/components/auth/AuthShell';
import { toast } from '@/lib/toast';
import { validatePassword, validateEmail } from '@/lib/validators';
import { sanitizeError } from '@/lib/errorHandler';
import { isPopupUnavailableError } from '@/lib/inAppBrowser';
import { resolvePostSignInPath } from '@/lib/postSignIn';
import { TurnstileWidget, TURNSTILE_ENABLED, type TurnstileHandle } from '@/components/TurnstileWidget';
import { FormError } from '@/components/ui/form-error';
import { InAppBrowserNotice } from '@/components/InAppBrowserNotice';
import { InlineNotice } from '@/components/ui/inline-notice';
import { useFieldError } from '@/hooks/useFieldError';
import { useInAppBrowser } from '@/hooks/useInAppBrowser';
import { useRedirectIfAuthenticated } from '@/hooks/useRedirectIfAuthenticated';

export default function RegisterPage() {
  const [firstName, setFirstName] = useState('');
  const [lastName, setLastName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [agreedToTerms, setAgreedToTerms] = useState(false);
  const [loading, setLoading] = useState(false);
  const [turnstileToken, setTurnstileToken] = useState('');
  // Collapsed so Google dominates; latches open on first email focus and never
  // closes, so a partly-filled form can't collapse mid-entry.
  const [emailFormOpen, setEmailFormOpen] = useState(false);
  // Popup refused: covers unidentified webviews and ordinary popup blockers, so
  // the remediation shows even when detection said no.
  const [popupBlocked, setPopupBlocked] = useState(false);
  // Email already registered — rendered inline with a route to /login.
  const [existingAccount, setExistingAccount] = useState(false);
  // Marks the offending input invalid and focuses it — a message alone does not
  // say WHERE to fix it.
  const { error: formError, fail, clear: clearError, fieldProps } = useFieldError('register-form-error');
  const turnstileRef = useRef<TurnstileHandle>(null);
  // Latches once sign-in starts so the guard below can't pre-empt our own
  // post-signup navigation. A ref, not `loading`: `loading` clears in `finally`,
  // which runs while the push to /setup-2fa is still in flight.
  const authInFlight = useRef(false);
  const { signUp, signInWithGoogle } = useAuth();
  const inApp = useInAppBrowser();
  const router = useRouter();

  // Mirrors a proxy rule that client-side history pops bypass entirely.
  useRedirectIfAuthenticated({ skip: authInFlight.current });

  const googleUnavailable = inApp.isInApp || popupBlocked;
  // Force the email path open when Google is out — don't leave the fallback
  // we're pointing at collapsed behind a focus interaction.
  const emailExpanded = emailFormOpen || googleUnavailable;

  const handleRegister = async (e: React.FormEvent) => {
    e.preventDefault();
    clearError();
    setExistingAccount(false);

    // noValidate form: the browser's native bubble no longer fires.
    if (!email.trim()) {
      return fail('email', 'enter your email address');
    }
    if (!password) {
      return fail('password', 'choose a password');
    }

    const emailValidation = validateEmail(email);
    if (!emailValidation.isValid) {
      return fail('email', emailValidation.error ?? 'enter a valid email address');
    }

    const passwordValidation = validatePassword(password);
    if (!passwordValidation.isValid) {
      return fail('password', passwordValidation.error ?? 'choose a stronger password');
    }

    if (password !== confirmPassword) {
      return fail('confirmPassword', 'passwords do not match');
    }

    if (!agreedToTerms) {
      return fail('terms', 'agree to the terms of service and privacy policy to continue');
    }

    authInFlight.current = true;
    setLoading(true);

    try {
      await signUp(email, password, firstName, lastName, turnstileToken);
      toast.success('account created successfully!');
      // /setup-2fa is proxy-protected, so this races the session cookie.
      // Resolving narrows the window; it self-heals either way (a fresh session
      // has no MFA, so the proxy sends them back here).
      router.push(await resolvePostSignInPath('/setup-2fa'));
    } catch (error) {
      // Not a validation failure — render inline with a route to sign in, not a
      // toast that expires and leaves them on a form that can't succeed.
      if ((error as { code?: unknown } | null)?.code === 'auth/email-already-in-use') {
        setExistingAccount(true);
      } else {
        toast.error(sanitizeError(error));
      }
      // Re-arm the guard: the page stays mounted and another tab could sign in.
      authInFlight.current = false;
      // Turnstile tokens are single-use; clear the consumed one before a retry.
      turnstileRef.current?.reset();
    } finally {
      setLoading(false);
    }
  };

  const handleGoogleSignup = async () => {
    // No agreedToTerms gate: the checkbox lives in the email form, so consent on
    // this path comes from the notice under the Google button.
    const alreadyBlocked = googleUnavailable;
    authInFlight.current = true;
    setLoading(true);

    try {
      const result = await signInWithGoogle();

      // One popup serves sign-in and sign-up, so landing here does NOT mean an
      // account was created.
      toast.success(
        result?.isNewUser
          ? 'account created with Google!'
          : 'welcome back — signing you in',
      );

      // Resolve, don't push /dashboard blind: the session cookie is minted
      // asynchronously and racing it sent users to /login?redirect=%2Fdashboard.
      router.push(await resolvePostSignInPath('/dashboard'));
    } catch (error) {
      authInFlight.current = false;
      // A refused popup means this environment can't do federated sign-in at
      // all — show the inline remediation, not an expiring toast.
      if (isPopupUnavailableError(error)) {
        setPopupBlocked(true);
        // Notice already on screen means they used "try google anyway" — nothing
        // visible would change, so say so.
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

  return (
    <AuthShell
      brandTitle="create an account"
      brandDescription="join owlette to manage your fleet"
      footer={
        <>
          already have an account?{' '}
          <a href="/login" className={authFooterLinkClass}>
            sign in
          </a>
        </>
      }
    >
      {/* Google first: fastest path, no password, and it skips Turnstile
          (the server only gates password signups). Swapped for a notice
          when the browser can't run it; the notice keeps a "try anyway". */}
      {googleUnavailable ? (
        <InAppBrowserNotice
          isInApp={inApp.isInApp}
          appName={inApp.appName}
          escapeAttempted={inApp.escapeAttempted}
          onTryAnyway={handleGoogleSignup}
          tryAnywayDisabled={loading}
        />
      ) : (
        <div className="space-y-2">
        <Button
          type="button"
          variant="outline"
          className="w-full cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed"
          onClick={handleGoogleSignup}
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

        {/* The only terms notice a Google user ever sees — they never open the
            email form's checkbox. text-balance is required: the links are
            whitespace-nowrap, which otherwise orphans "privacy policy". */}
        <p className="text-balance text-center text-xs text-muted-foreground leading-snug">
          by continuing you agree to the{' '}
          <Link href="/terms" className="whitespace-nowrap hl-link text-accent-cyan" target="_blank">
            terms of service
          </Link>
          {' '}and{' '}
          <Link href="/privacy" className="whitespace-nowrap hl-link text-accent-cyan" target="_blank">
            privacy policy
          </Link>
        </p>
        </div>
      )}

      {/* "or" needs two live options; with Google out there is only one. */}
      {!googleUnavailable && <AuthDivider />}

      <form onSubmit={handleRegister} className="space-y-5" noValidate>
        <div className="space-y-2">
          <Label htmlFor="email" className="text-foreground">email</Label>
          <Input
            id="email"
            {...fieldProps('email')}
            type="email"
            placeholder="you@example.com"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            // Focus, not click, so keyboard tabbing expands it too.
            onFocus={() => setEmailFormOpen(true)}
            required
            disabled={loading}
            className="dark:bg-input border-border text-foreground placeholder:text-muted-foreground"
          />
        </div>

        {emailExpanded && (
          <div className="form-reveal">
            <div className="space-y-5">
            <div className="grid grid-cols-1 @sm/auth-form:grid-cols-2 gap-4">
              <div className="space-y-2">
                <Label htmlFor="firstName" className="text-foreground">first name</Label>
                <Input
                  id="firstName"
                  type="text"
                  placeholder="John"
                  value={firstName}
                  onChange={(e) => setFirstName(e.target.value)}
                  disabled={loading}
                  className="dark:bg-input border-border text-foreground placeholder:text-muted-foreground"
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="lastName" className="text-foreground">last name</Label>
                <Input
                  id="lastName"
                  type="text"
                  placeholder="Doe"
                  value={lastName}
                  onChange={(e) => setLastName(e.target.value)}
                  disabled={loading}
                  className="dark:bg-input border-border text-foreground placeholder:text-muted-foreground"
                />
              </div>
            </div>
            <div className="space-y-2">
              <Label htmlFor="password" className="text-foreground">password</Label>
              <Input
                id="password"
                {...fieldProps('password')}
                type="password"
                placeholder="••••••••"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                required
                disabled={loading}
                className="dark:bg-input border-border text-foreground placeholder:text-muted-foreground"
              />
              <p className="text-xs text-muted-foreground">
                must be 8+ characters with at least 2 of: lowercase, uppercase, numbers, special characters
              </p>
            </div>
            <div className="space-y-2">
              <Label htmlFor="confirmPassword" className="text-foreground">confirm password</Label>
              <Input
                id="confirmPassword"
                {...fieldProps('confirmPassword')}
                type="password"
                placeholder="••••••••"
                value={confirmPassword}
                onChange={(e) => setConfirmPassword(e.target.value)}
                required
                disabled={loading}
                className="dark:bg-input border-border text-foreground placeholder:text-muted-foreground"
              />
            </div>
            <div className="flex items-start space-x-2">
              <Checkbox
                id="terms"
                checked={agreedToTerms}
                onCheckedChange={(checked) => setAgreedToTerms(checked === true)}
                disabled={loading}
                // the hairline is dark-only (it vanishes on the light card) and
                // unchecked-only, or the dark: variant would outrank the checked cyan.
                className="mt-0.5 dark:data-[state=unchecked]:border-border"
              />
              {/* Label defaults to flex, which makes each inline child a
                  flex item and breaks "terms of service" mid-phrase in a
                  narrow column — force normal inline flow. */}
              <Label htmlFor="terms" className="block text-balance text-sm text-muted-foreground leading-snug cursor-pointer">
                i agree to the{' '}
                <Link href="/terms" className="whitespace-nowrap hl-link text-accent-cyan" target="_blank">
                  terms of service
                </Link>
                {' '}and{' '}
                <Link href="/privacy" className="whitespace-nowrap hl-link text-accent-cyan" target="_blank">
                  privacy policy
                </Link>
              </Label>
            </div>

            {/* No justify-center wrapper: size:'flexible' already spans the
                container; centering would leave it narrower than the inputs.
                That size has a 300px floor, though, which the column's p-8
                leaves it 6px short of at 390px — so bleed to the column edges
                on phones rather than letting overflow-hidden crop it. */}
            <TurnstileWidget
              action="register"
              onToken={setTurnstileToken}
              ref={turnstileRef}
              className="max-[420px]:-mx-8"
            />
            {existingAccount && (
              <InlineNotice data-testid="register-existing-account">
                <p className="text-sm leading-snug text-muted-foreground">
                  an account with this email already exists.{' '}
                  <Link href="/login" className="font-medium hl-link text-accent-cyan">
                    sign in instead
                  </Link>
                  , or{' '}
                  <Link href="/forgot-password" className="font-medium hl-link text-accent-cyan">
                    reset your password
                  </Link>
                  .
                </p>
              </InlineNotice>
            )}
            <FormError message={formError?.message} id="register-form-error" />
            <Button type="submit" className="w-full text-background font-medium cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed" disabled={loading || (TURNSTILE_ENABLED && !turnstileToken)}>
              {loading ? 'creating account...' : 'create account'}
            </Button>
            </div>
          </div>
        )}
      </form>
    </AuthShell>
  );
}
