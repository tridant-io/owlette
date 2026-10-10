'use client';

/**
 * `/swoop/{siteId}/{machineId}/verify` — the browser half of owlette swoop's
 * step-up. the app's webview reaches only the platform authenticator, so its
 * dialog opens this page in the system browser, where any passkey works,
 * password managers included. the proof opens the caller's 12-hour window on
 * this machine (`POST …/swoop/step-up`), and the app, polling, finds it.
 *
 * protected like every `/swoop` path: the proxy wants a session with mfa
 * complete. it renders inside the session layout's fixed, unscrolled box, so it
 * scrolls itself.
 */

import { use, useState } from 'react';
import { AlertTriangle, CheckCircle2, Fingerprint } from 'lucide-react';
import { useAuth } from '@/contexts/AuthContext';
import { AuthShell } from '@/components/auth/AuthShell';
import { Button } from '@/components/ui/button';
import { StepUpCodeFields, useStepUpCeremony } from '@/components/swoop/SwoopStepUpDialog';
import { submitStepUpProof } from '@/lib/swoop/stepUp';

export default function SwoopVerifyPage({
  params,
}: {
  params: Promise<{ siteId: string; machineId: string }>;
}) {
  const { siteId, machineId } = use(params);
  const { user } = useAuth();
  const [done, setDone] = useState(false);
  const ceremony = useStepUpCeremony(async (proof) => {
    await submitStepUpProof(siteId, machineId, proof);
    setDone(true);
  });
  const { pending, error, submit } = ceremony;

  const title = (
    <>
      allow control of <span className="break-all">{machineId}</span> from owlette swoop on this
      computer?
    </>
  );
  const footer = user?.email ? (
    <>
      signed in as <span className="break-all">{user.email}</span>
    </>
  ) : undefined;

  return (
    <div className="h-full overflow-y-auto">
      <AuthShell brandTitle={title} footer={footer}>
        {done ? (
          <div className="space-y-3 text-center" role="status">
            <CheckCircle2 className="mx-auto h-8 w-8 text-success" />
            <p className="text-sm text-foreground">done, go back to owlette swoop</p>
          </div>
        ) : (
          <>
            <div className="flex items-start gap-2 rounded border border-warning-border bg-warning-surface p-3 text-xs text-warning">
              <AlertTriangle className="mt-0.5 h-4 w-4 flex-shrink-0" />
              <span className="min-w-0">
                continue only if you just clicked verify in your browser in owlette swoop
              </span>
            </div>

            <div className="space-y-3">
              <Button
                type="button"
                className="w-full"
                onClick={() => submit('passkey')}
                disabled={pending !== null}
              >
                <Fingerprint />
                {pending === 'passkey' ? 'waiting for your passkey...' : 'use a passkey'}
              </Button>
              <p className="text-center text-xs text-muted-foreground">or enter a code</p>
              <StepUpCodeFields ceremony={ceremony} disabled={pending !== null} />
              {error && (
                <p role="alert" className="text-xs text-destructive">
                  {error}
                </p>
              )}
              <Button
                type="button"
                variant="outline"
                className="w-full"
                onClick={() => submit('code')}
                disabled={pending !== null}
              >
                {pending === 'code' ? 'checking...' : 'confirm'}
              </Button>
            </div>
          </>
        )}
      </AuthShell>
    </div>
  );
}
