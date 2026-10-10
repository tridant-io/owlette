'use client';

import { Suspense, useState } from 'react';
import { useSearchParams } from 'next/navigation';
import { AlertTriangle, CheckCircle2, Loader2 } from 'lucide-react';
import { useAuth } from '@/contexts/AuthContext';
import { AuthShell } from '@/components/auth/AuthShell';
import { Button } from '@/components/ui/button';
import { AppLinkError, approveAppLink } from '@/lib/appLink';

const TITLE = 'sign in owlette swoop on this computer?';

type ApproveState = 'ask' | 'approving' | 'done' | 'cancelled' | 'gone' | 'used' | 'failed';

const OUTCOME_COPY: Partial<Record<ApproveState, string>> = {
  done: 'done, go back to owlette swoop',
  cancelled: 'cancelled. owlette swoop was not signed in. you can close this tab.',
  gone: 'that sign-in request has expired. start again from owlette swoop.',
  used: 'that sign-in request was already answered. start again from owlette swoop if it is still asking.',
};

/**
 * `/app-link/approve?code=` — the system browser half of a cold app start (protected: the proxy
 * demands a session with mfa complete). Approving hands this browser's account and mfa state to the
 * owlette swoop window that asked; see lib/appLink.server.ts.
 */
function ApproveInner() {
  const searchParams = useSearchParams();
  const { user } = useAuth();
  const code = searchParams.get('code') ?? '';
  const [state, setState] = useState<ApproveState>(code ? 'ask' : 'gone');

  const approve = async () => {
    setState('approving');
    try {
      await approveAppLink(code);
      setState('done');
    } catch (error) {
      const status = error instanceof AppLinkError ? error.status : 0;
      setState(status === 404 ? 'gone' : status === 409 ? 'used' : 'failed');
    }
  };

  const footer = user?.email ? (
    <>
      signed in as <span className="break-all">{user.email}</span>
    </>
  ) : undefined;

  const outcome = OUTCOME_COPY[state];
  if (outcome) {
    return (
      <AuthShell brandTitle={TITLE} footer={footer}>
        <div className="space-y-3 text-center" role="status">
          {state === 'done' ? <CheckCircle2 className="mx-auto h-8 w-8 text-success" /> : null}
          <p className="text-sm text-foreground">{outcome}</p>
        </div>
      </AuthShell>
    );
  }

  const busy = state === 'approving';
  return (
    <AuthShell brandTitle={TITLE} footer={footer}>
      <div className="flex items-start gap-2 rounded border border-warning-border bg-warning-surface p-3 text-xs text-warning">
        <AlertTriangle className="mt-0.5 h-4 w-4 flex-shrink-0" />
        <span className="min-w-0">
          approve only if you just clicked sign in with your browser in the app
        </span>
      </div>
      {state === 'failed' ? (
        <p role="alert" className="text-sm text-destructive">
          that didn&apos;t work. try again.
        </p>
      ) : null}
      <div className="flex gap-3">
        <Button type="button" variant="outline" className="flex-1" disabled={busy} onClick={() => setState('cancelled')}>
          cancel
        </Button>
        <Button type="button" className="flex-1" disabled={busy} onClick={approve}>
          {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : 'approve'}
        </Button>
      </div>
    </AuthShell>
  );
}

export default function AppLinkApprovePage() {
  return (
    <Suspense fallback={<AuthShell brandTitle={TITLE} loading />}>
      <ApproveInner />
    </Suspense>
  );
}
