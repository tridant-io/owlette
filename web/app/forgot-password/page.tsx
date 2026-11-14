'use client';

import { useRef, useState } from 'react';
import { useAuth } from '@/contexts/AuthContext';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { AuthShell, authFooterLinkClass } from '@/components/auth/AuthShell';
import { TurnstileWidget, TURNSTILE_ENABLED, type TurnstileHandle } from '@/components/TurnstileWidget';
import { FormError } from '@/components/ui/form-error';
import { useFieldError } from '@/hooks/useFieldError';

export default function ForgotPasswordPage() {
  const { sendPasswordReset } = useAuth();
  const [email, setEmail] = useState('');
  const [loading, setLoading] = useState(false);
  const [sent, setSent] = useState(false);
  const [turnstileToken, setTurnstileToken] = useState('');
  /** Field-targeted validation — see hooks/useFieldError.ts. */
  const { error: formError, fail, clear: clearError, fieldProps } = useFieldError('forgot-form-error');
  const turnstileRef = useRef<TurnstileHandle>(null);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    clearError();
    if (!email.trim()) {
      return fail('email', 'enter your email address');
    }
    setLoading(true);
    try {
      await sendPasswordReset(email, turnstileToken);
      // Existence-agnostic by design: we show the same confirmation whether or
      // not an account exists for this address (Firebase email-enumeration
      // protection makes sendPasswordReset resolve either way).
      setSent(true);
    } catch {
      // sendPasswordReset surfaces its own error toast (invalid email,
      // rate-limit, misconfiguration). Stay on the form so the user can retry.
      // Turnstile tokens are single-use, so the consumed one must be cleared
      // or the retry fails with timeout-or-duplicate.
      turnstileRef.current?.reset();
    } finally {
      setLoading(false);
    }
  };

  return (
    <AuthShell
      brandTitle="reset password"
      brandDescription={
        sent ? 'check your email' : "enter your email and we'll send you a reset link"
      }
      footer={
        <>
          remember your password?{' '}
          <a href="/login" className={authFooterLinkClass}>
            sign in
          </a>
        </>
      }
    >
      {sent ? (
        <>
          {/* The email must stay inline so "a password reset link is on its way"
              remains contiguous in one element — password-reset.spec.ts matches
              that phrase directly. break-all because it is arbitrary user data
              with no break opportunity at @ or . */}
          <p className="text-center text-sm text-muted-foreground">
            if an account exists for{' '}
            <span className="break-all text-foreground">{email}</span>, a
            password reset link is on its way. it can take a minute to arrive — be sure to
            check your spam folder.
          </p>
          <Button
            type="button"
            variant="outline"
            onClick={() => setSent(false)}
            className="w-full cursor-pointer"
          >
            use a different email
          </Button>
        </>
      ) : (
        <form onSubmit={handleSubmit} className="space-y-5" noValidate>
          <div className="space-y-2">
            <Label htmlFor="email" className="text-foreground">email</Label>
            <Input
              id="email"
              {...fieldProps('email')}
              type="email"
              placeholder="you@example.com"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              required
              disabled={loading}
              className="dark:bg-input border-border text-foreground placeholder:text-muted-foreground"
            />
          </div>
          {/* Turnstile's `flexible` size has a 300px floor, which the column's
              p-8 leaves it 6px short of at 390px. Bleed to the column edges on
              phones rather than letting the card's overflow-hidden crop it. */}
          <TurnstileWidget
            action="forgot-password"
            onToken={setTurnstileToken}
            ref={turnstileRef}
            className="max-[420px]:-mx-8"
          />
          <FormError message={formError?.message} id="forgot-form-error" />
          <Button
            type="submit"
            className="w-full text-background font-medium cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed"
            disabled={loading || !email || (TURNSTILE_ENABLED && !turnstileToken)}
          >
            {loading ? 'sending...' : 'send reset link'}
          </Button>
        </form>
      )}
    </AuthShell>
  );
}
