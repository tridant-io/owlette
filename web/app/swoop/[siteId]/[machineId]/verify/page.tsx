'use client';

/**
 * `/swoop/{siteId}/{machineId}/verify` — the browser half of owlette swoop's
 * step-up. the app's webview reaches only the platform authenticator, so its
 * dialog opens this page in the system browser, where any passkey works,
 * password managers included. the proof opens the caller's 7-day window on
 * this machine (`POST …/swoop/step-up`), and the app, polling, finds it.
 *
 * it asks only for what the account holds and this browser can run
 * (`useSecondFactorChoices`), as the dialog does, and a refused proof is said
 * here with the field ready for another.
 *
 * protected like every `/swoop` path: the proxy wants a session with mfa
 * complete. it renders inside the session layout's fixed, unscrolled box, so it
 * scrolls itself.
 */

import { use, useState } from 'react';
import { CheckCircle2, Fingerprint } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useAuth } from '@/contexts/AuthContext';
import { AuthShell, AuthSignedInAs } from '@/components/auth/AuthShell';
import { Button } from '@/components/ui/button';
import {
  BackupCodeLink,
  StepUpCodeFields,
  useStepUpCeremony,
} from '@/components/swoop/SwoopStepUpDialog';
import { useSecondFactorChoices } from '@/hooks/useSecondFactorChoices';
import { ANY_FACTOR, holdsSecondFactor } from '@/lib/secondFactors';
import { submitStepUpProof } from '@/lib/swoop/stepUp';

export default function SwoopVerifyPage({
  params,
}: {
  params: Promise<{ siteId: string; machineId: string }>;
}) {
  const { siteId, machineId } = use(params);
  const { user, loading, signOut, mfaFactors } = useAuth();
  const router = useRouter();
  const [done, setDone] = useState(false);
  const [codeOpen, setCodeOpen] = useState(false);
  // the proxy lets only a session with a second factor this far, so an
  // inventory that reads empty is a legacy or unreadable user document: every
  // way in, as /verify-2fa offers, rather than none
  const choices = useSecondFactorChoices(holdsSecondFactor(mfaFactors) ? mfaFactors : ANY_FACTOR);
  const ceremony = useStepUpCeremony(
    async (proof) => {
      await submitStepUpProof(siteId, machineId, proof);
      setDone(true);
    },
    { authenticator: choices.authenticatorCode, backupCode: choices.backupCode },
  );
  const { pending, error, submit } = ceremony;
  // a code waits behind its link while the passkey is here to use
  const showCode = (choices.authenticatorCode || choices.backupCode) && (codeOpen || !choices.passkey);

  const title = (
    <>
      allow control of <span className="break-all">{machineId}</span>?
    </>
  );
  // the wrong account at this screen is a real case (a shared desk, a browser left
  // signed in): the way out is here, and it returns to this very page after sign-in
  const signInAsSomeoneElse = async () => {
    const here = `${window.location.pathname}${window.location.search}`;
    await signOut();
    router.replace(`/login?redirect=${encodeURIComponent(here)}`);
  };
  const footer = user?.email ? (
    <AuthSignedInAs email={user.email} onSwitch={() => void signInAsSomeoneElse()} />
  ) : undefined;

  // the account's factors come with the user document
  if (loading) {
    return (
      <div className="h-full overflow-y-auto">
        <AuthShell compact brandTitle={title} loading />
      </div>
    );
  }

  return (
    <div className="h-full overflow-y-auto">
      <AuthShell
        compact
        brandTitle={title}
        brandDescription="for owlette swoop on this computer. continue only if you just clicked verify."
        footer={footer}
      >
        {done ? (
          <div className="space-y-3 text-center" role="status">
            <CheckCircle2 className="mx-auto h-8 w-8 text-success" />
            <p className="text-sm text-foreground">done, go back to owlette swoop</p>
          </div>
        ) : (
          <div className="space-y-3">
            {choices.passkey && (
              <Button
                type="button"
                className="w-full"
                onClick={() => submit('passkey')}
                disabled={pending !== null}
              >
                <Fingerprint />
                {pending === 'passkey' ? 'waiting for your passkey...' : 'use a passkey'}
              </Button>
            )}
            {!choices.passkey && !choices.authenticatorCode && choices.passkeyHint && (
              <p className="text-xs text-muted-foreground">{choices.passkeyHint}</p>
            )}
            {showCode ? (
              <>
                <StepUpCodeFields ceremony={ceremony} disabled={pending !== null} />
                <Button
                  type="button"
                  variant={choices.passkey ? 'outline' : 'default'}
                  className="w-full"
                  onClick={() => submit('code')}
                  disabled={pending !== null}
                >
                  {pending === 'code' ? 'checking...' : 'confirm'}
                </Button>
              </>
            ) : choices.authenticatorCode ? (
              <p className="text-center">
                <button
                  type="button"
                  onClick={() => setCodeOpen(true)}
                  className="hl-link cursor-pointer text-xs text-accent-cyan"
                >
                  enter a code instead
                </button>
              </p>
            ) : choices.backupCode ? (
              <BackupCodeLink onClick={() => setCodeOpen(true)} disabled={pending !== null} />
            ) : null}
            {error && (
              <p role="alert" className="text-xs text-destructive">
                {error}
              </p>
            )}
          </div>
        )}
      </AuthShell>
    </div>
  );
}
