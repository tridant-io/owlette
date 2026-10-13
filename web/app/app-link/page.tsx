'use client';

import { Suspense, useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { useAuth } from '@/contexts/AuthContext';
import { AuthShell } from '@/components/auth/AuthShell';
import { Button } from '@/components/ui/button';
import { completeAppLinkSignIn, exchangeAppLink, safeNextPath } from '@/lib/appLink';

const TITLE = 'signing in owlette swoop';

/**
 * `/app-link?code=&next=` — where owlette swoop lands from a deep link carrying a code the signed-in
 * website minted. Public: exchange the code, sign in with the custom token, mint the session, go to
 * `next`. Already signed in, it just goes.
 */
function AppLinkInner() {
  const searchParams = useSearchParams();
  const router = useRouter();
  const { user, loading } = useAuth();
  const code = searchParams.get('code') ?? '';
  const next = safeNextPath(searchParams.get('next'));
  const [failed, setFailed] = useState(false);
  // decided once, when auth first resolves: the sign-in below flips `user` mid-flight, and
  // replacing on that flip would beat the session cookie to the proxy.
  const started = useRef(false);

  useEffect(() => {
    if (loading || started.current) return;
    started.current = true;
    if (user) {
      router.replace(next);
      return;
    }
    (async () => {
      try {
        const result = await exchangeAppLink(code);
        // a pending code belongs to a cold start, which polls with its secret instead.
        if (!('customToken' in result)) throw new Error('code is not approved');
        await completeAppLinkSignIn(result.customToken);
        router.replace(next);
      } catch {
        setFailed(true);
      }
    })();
  }, [loading, user, code, next, router]);

  if (!failed) {
    return <AuthShell brandTitle={TITLE} loading />;
  }

  return (
    <AuthShell brandTitle={TITLE} brandDescription="owlette swoop needs you to sign in again">
      <p role="alert" className="text-sm text-foreground">
        that sign-in link is no longer valid
      </p>
      <Button asChild className="w-full">
        <Link href={`/login?redirect=${encodeURIComponent(next)}`}>sign in</Link>
      </Button>
    </AuthShell>
  );
}

export default function AppLinkPage() {
  return (
    <Suspense fallback={<AuthShell brandTitle={TITLE} loading />}>
      <AppLinkInner />
    </Suspense>
  );
}
