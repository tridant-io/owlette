'use client';

import { Suspense, useEffect, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { confirmPasswordReset, verifyPasswordResetCode } from 'firebase/auth';
import { auth } from '@/lib/firebase';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { AuthShell, authFooterLinkClass } from '@/components/auth/AuthShell';
import { EyeIcon, EyeOffIcon } from 'lucide-react';
import { toast } from '@/lib/toast';
import { FormError } from '@/components/ui/form-error';

type Status = 'verifying' | 'ready' | 'invalid';

function ResetPasswordForm() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const oobCode = searchParams.get('oobCode');

  const [status, setStatus] = useState<Status>('verifying');
  const [accountEmail, setAccountEmail] = useState('');
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [error, setError] = useState('');
  const [submitting, setSubmitting] = useState(false);

  // Validate the oobCode on mount. verifyPasswordResetCode resolves with the
  // account email when the code is valid, and rejects when it's malformed,
  // already used, or expired.
  useEffect(() => {
    if (!oobCode || !auth) {
      setStatus('invalid');
      return;
    }
    let cancelled = false;
    verifyPasswordResetCode(auth, oobCode)
      .then((email) => {
        if (cancelled) return;
        setAccountEmail(email);
        setStatus('ready');
      })
      .catch(() => {
        if (!cancelled) setStatus('invalid');
      });
    return () => {
      cancelled = true;
    };
  }, [oobCode]);

  const validate = (): boolean => {
    setError('');
    if (password.length < 6) {
      setError('password must be at least 6 characters');
      return false;
    }
    if (password !== confirm) {
      setError('passwords do not match');
      return false;
    }
    return true;
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!oobCode || !auth) {
      setStatus('invalid');
      return;
    }
    if (!validate()) return;

    setSubmitting(true);
    try {
      await confirmPasswordReset(auth, oobCode, password);
      toast.success('password updated', {
        description: 'you can now sign in with your new password.',
      });
      router.push('/login');
    } catch (err: unknown) {
      const code = (err as { code?: string } | null)?.code;
      if (code === 'auth/expired-action-code' || code === 'auth/invalid-action-code') {
        setStatus('invalid');
      } else if (code === 'auth/weak-password') {
        setError('password is too weak — please choose a stronger one');
      } else {
        setError('could not reset your password. please try again.');
      }
    } finally {
      setSubmitting(false);
    }
  };

  /* The account email is rendered EXACTLY ONCE on this page (here, in the brand
     description): password-reset.spec.ts asserts getByText(email) with no
     .first(), so a second copy is a strict-mode failure. break-words because it
     is arbitrary user data. */
  const brandDescription =
    status === 'ready' ? (
      <>
        resetting the password for{' '}
        <span className="break-words text-foreground">{accountEmail}</span>
      </>
    ) : status === 'invalid' ? (
      'this reset link is invalid or has expired'
    ) : (
      'verifying your reset link...'
    );

  return (
    <AuthShell
      brandTitle="set a new password"
      brandDescription={brandDescription}
      loading={status === 'verifying'}
      /* Reserve the resolved height so the card does not jump ~250px upward
         when verification completes — the wrapper centres it vertically. */
      contentClassName={status === 'verifying' ? 'md:min-h-[26rem]' : undefined}
      footer={
        <a href="/login" className={authFooterLinkClass}>
          back to sign in
        </a>
      }
    >
      {status === 'invalid' && (
        <div className="space-y-4">
          <p className="text-center text-sm text-muted-foreground">
            password reset links expire after a short while and can only be used once. request a fresh one to continue.
          </p>
          <Button
            type="button"
            onClick={() => router.push('/forgot-password')}
            className="w-full text-background font-medium cursor-pointer"
          >
            request a new link
          </Button>
        </div>
      )}

      {status === 'ready' && (
        <form onSubmit={handleSubmit} className="space-y-5" noValidate>
          <div className="space-y-2">
            <Label htmlFor="newPassword" className="text-foreground">new password</Label>
            <div className="relative">
              <Input
                id="newPassword"
                type={showPassword ? 'text' : 'password'}
                placeholder="••••••••"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                required
                disabled={submitting}
                className="dark:bg-input border-border pr-10 text-foreground placeholder:text-muted-foreground"
              />
              <button
                type="button"
                onClick={() => setShowPassword(!showPassword)}
                /* inset-y-0 + px-3 grows the hit area to the full field height
                   without moving the glyph — it was a 16x16 tap target. */
                className="absolute inset-y-0 right-0 flex items-center px-3 cursor-pointer text-muted-foreground hover:text-foreground"
                aria-label={showPassword ? 'hide password' : 'show password'}
              >
                {showPassword ? <EyeOffIcon className="h-4 w-4" /> : <EyeIcon className="h-4 w-4" />}
              </button>
            </div>
            <p className="text-xs text-muted-foreground">must be at least 6 characters</p>
          </div>

          <div className="space-y-2">
            <Label htmlFor="confirmPassword" className="text-foreground">confirm new password</Label>
            <Input
              id="confirmPassword"
              type={showPassword ? 'text' : 'password'}
              placeholder="••••••••"
              value={confirm}
              onChange={(e) => setConfirm(e.target.value)}
              required
              disabled={submitting}
              className="dark:bg-input border-border text-foreground placeholder:text-muted-foreground"
            />
          </div>

          <FormError message={error} />

          <Button
            type="submit"
            className="w-full text-background font-medium cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed"
            disabled={submitting || !password || !confirm}
          >
            {submitting ? 'resetting...' : 'reset password'}
          </Button>
        </form>
      )}
    </AuthShell>
  );
}

export default function ResetPasswordPage() {
  return (
    /* Identical shell to the resolved page, so the card does not change shape
       when the boundary resolves. */
    <Suspense
      fallback={
        <AuthShell
          brandTitle="set a new password"
          brandDescription="verifying your reset link..."
          loading
          contentClassName="md:min-h-[26rem]"
        />
      }
    >
      <ResetPasswordForm />
    </Suspense>
  );
}
