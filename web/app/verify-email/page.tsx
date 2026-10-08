'use client';

/**
 * Landing page for the link in the verification email (lib/emailVerification.server.ts).
 * Public on purpose: applyActionCode needs no session, so the link works whether or
 * not this browser is signed in.
 */

import { Suspense, useEffect, useState } from 'react';
import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { applyActionCode } from 'firebase/auth';
import { auth } from '@/lib/firebase';
import { Button } from '@/components/ui/button';
import { AuthShell } from '@/components/auth/AuthShell';

type Result = 'verified' | 'invalid';

function VerifyEmail() {
  const oobCode = useSearchParams().get('oobCode');
  const [result, setResult] = useState<Result | null>(null);
  const status = !oobCode || !auth ? 'invalid' : (result ?? 'verifying');

  useEffect(() => {
    if (!oobCode || !auth) return;
    const firebaseAuth = auth;
    applyActionCode(firebaseAuth, oobCode).then(
      () => {
        setResult('verified');
        // a signed-in tab caches emailVerified; refresh it so the banner hides
        firebaseAuth.currentUser?.reload().catch(() => undefined);
      },
      () => setResult('invalid'),
    );
  }, [oobCode]);

  const brandDescription =
    status === 'verified'
      ? 'thanks, your email address is confirmed.'
      : status === 'invalid'
        ? 'this verification link is invalid or has already been used'
        : 'verifying your email...';

  return (
    <AuthShell
      brandTitle={status === 'verified' ? 'email verified' : 'verify your email'}
      brandDescription={brandDescription}
      loading={status === 'verifying'}
    >
      {status === 'invalid' && (
        <p className="text-center text-sm text-muted-foreground">
          verification links can only be used once. if your email still isn&apos;t verified, sign in and choose send verification email on the banner.
        </p>
      )}
      <Button asChild className="w-full text-background font-medium">
        <Link href="/dashboard">continue to dashboard</Link>
      </Button>
    </AuthShell>
  );
}

export default function VerifyEmailPage() {
  return (
    /* identical shell to the resolving page, so the card keeps its shape */
    <Suspense
      fallback={
        <AuthShell brandTitle="verify your email" brandDescription="verifying your email..." loading />
      }
    >
      <VerifyEmail />
    </Suspense>
  );
}
