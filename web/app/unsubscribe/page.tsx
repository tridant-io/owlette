'use client';

import { useSearchParams } from 'next/navigation';
import { Suspense, useState } from 'react';
import Link from 'next/link';
import { Loader2 } from 'lucide-react';
import { AuthShell, authFooterLinkClass } from '@/components/auth/AuthShell';
import { Button } from '@/components/ui/button';

type UnsubscribeState = 'ask' | 'working' | 'done' | 'weekly' | 'failed';

/**
 * `/unsubscribe?token=` — where an alert email's unsubscribe link lands
 * (GET /api/unsubscribe sends it here). it asks first: mail scanners open links
 * on their own, so only a button changes anything (POST /api/unsubscribe): one
 * turns alerts off, the other keeps them as one weekly digest.
 */
function UnsubscribeContent() {
  const token = useSearchParams().get('token') ?? '';
  const [state, setState] = useState<UnsubscribeState>(token ? 'ask' : 'failed');

  const submit = async (body: { token: string; delivery?: 'weekly' }, done: UnsubscribeState) => {
    setState('working');
    try {
      const res = await fetch('/api/unsubscribe', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      setState(res.ok ? done : 'failed');
    } catch {
      setState('failed');
    }
  };

  const footer = (
    <Link href="/dashboard" className={authFooterLinkClass}>
      go to dashboard
    </Link>
  );

  if (state === 'done') {
    return (
      <AuthShell brandTitle="unsubscribed" brandDescription="alert emails are off" footer={footer}>
        <p className="text-center text-muted-foreground">
          all alert emails, including offline notifications, have been turned off. you can re-enable specific alert categories anytime in account settings.
        </p>
      </AuthShell>
    );
  }

  if (state === 'weekly') {
    return (
      <AuthShell brandTitle="weekly digest" brandDescription="alert emails stay on" footer={footer}>
        <p className="text-center text-muted-foreground">
          your alert emails now arrive as one weekly digest, mondays at 8:00 am your time. change it anytime in manage alerts.
        </p>
      </AuthShell>
    );
  }

  if (state === 'failed') {
    return (
      /* deliberately not "something went wrong" in the description: static.spec.ts
         matches that phrase with no .first(), so it may appear exactly once, in the body. */
      <AuthShell brandTitle="unsubscribe" brandDescription="we couldn't update your preferences" footer={footer}>
        <p className="text-center text-muted-foreground">
          something went wrong. please try again or update your preferences in account settings.
        </p>
      </AuthShell>
    );
  }

  const busy = state === 'working';
  return (
    <AuthShell brandTitle="unsubscribe" brandDescription="turn off alert emails?" footer={footer}>
      <p className="text-center text-muted-foreground">
        this turns off every alert email, including offline notifications. you can re-enable specific alert categories anytime in account settings. or keep them, as one email a week.
      </p>
      {/* one group, as on the login page: space-y-6 would split the two answers apart */}
      <div className="space-y-2">
        <Button type="button" className="w-full" disabled={busy} onClick={() => void submit({ token }, 'done')}>
          {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : 'turn off alert emails'}
        </Button>
        <Button type="button" variant="outline" className="w-full" disabled={busy} onClick={() => void submit({ token, delivery: 'weekly' }, 'weekly')}>
          weekly digest instead
        </Button>
      </div>
    </AuthShell>
  );
}

export default function UnsubscribePage() {
  return (
    /* useSearchParams forces this boundary; the fallback is the same shell so
       the card does not change shape when it resolves. */
    <Suspense fallback={<AuthShell brandTitle="unsubscribe" loading />}>
      <UnsubscribeContent />
    </Suspense>
  );
}
