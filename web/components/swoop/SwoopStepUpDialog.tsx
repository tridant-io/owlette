'use client';

/**
 * the live second-factor ceremony that unlocks control.
 *
 * `onProof` receives the body `parseMfaProof` accepts and the hook forwards it
 * verbatim into the session-create request. a proof is never logged, never
 * stored and never inspected on the way through. the dialog stays open until
 * that create answers: a refused answer (a wrong code, too many tries) is said
 * here, with the field ready for another, never on a page of its own.
 *
 * it asks only for what the account holds and this page can run
 * (`useSecondFactorChoices`): an authenticator code only with an authenticator
 * app, a passkey only with a passkey, and a backup code beside either. an
 * account with no second factor at all gets an enroll hint pointing at the
 * security settings instead, because it cannot take control at all.
 *
 * in owlette swoop a passkey prompt reaches only the platform authenticator, so
 * there an account's passkey gives way to "verify in your browser": the system
 * browser passes the ceremony on `/swoop/<site>/<machine>/verify`, this dialog
 * polls until the window reads open and answers `STEP_UP_WINDOW_OPEN`, and the
 * hook retries the session with no proof. codes work in the app as they are.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { Fingerprint, Globe, ShieldCheck } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { useSecondFactorChoices } from '@/hooks/useSecondFactorChoices';
import { holdsSecondFactor } from '@/lib/secondFactors';
import { useViewerAppPlatform } from '@/hooks/useViewerAppPlatform';
import {
  codeStepUpProof,
  passkeyStepUpProof,
  readStepUpWindow,
  STEP_UP_WINDOW_OPEN,
  stepUpVerifyUrl,
  SwoopStepUpError,
  type SwoopStepUpProof,
  type SwoopStepUpProps,
} from '@/lib/swoop/stepUp';

// every 3 s for at most 10 minutes, as owlette swoop's browser sign-in waits
const BROWSER_POLL_MS = 3000;
const BROWSER_WAIT_MS = 10 * 60 * 1000;

export function SwoopStepUpDialog({ open, factors, onProof, onCancel }: SwoopStepUpProps) {
  return (
    <Dialog open={open} onOpenChange={(next) => !next && onCancel()}>
      <DialogContent className="sm:max-w-sm">
        {/* the form is a child so that closing the dialog unmounts it: a fresh
            ask never inherits the last attempt's code or error. */}
        <StepUpForm factors={factors} onProof={onProof} onCancel={onCancel} />
      </DialogContent>
    </Dialog>
  );
}

/**
 * the ceremony itself: the code being typed and the one attempt in flight.
 * shared with the browser's verify page, whose `onProof` posts the proof to the
 * step-up route instead of retrying a session. without an authenticator app
 * (`authenticator: false`) a code can only be a backup code, and with no backup
 * codes left (`backupCode: false`) a code can only be an authenticator's.
 */
export function useStepUpCeremony(
  onProof: (proof: SwoopStepUpProof) => Promise<void>,
  { authenticator, backupCode }: { authenticator: boolean; backupCode: boolean },
) {
  const [code, setCode] = useState('');
  const [backupChosen, setBackupChosen] = useState(false);
  const isBackupCode = !authenticator || backupChosen;
  const [pending, setPending] = useState<'code' | 'passkey' | null>(null);
  const [error, setError] = useState<string | null>(null);

  /**
   * one ceremony, then exactly one retry — `onProof` is what retries, and it is
   * called once. a refused retry rejects, and the operator decides again here
   * rather than a loop deciding for them.
   */
  const submit = async (kind: 'code' | 'passkey') => {
    if (pending) return;
    setPending(kind);
    setError(null);

    let proof: SwoopStepUpProof;
    try {
      proof = kind === 'passkey' ? await passkeyStepUpProof() : codeStepUpProof(code, isBackupCode);
    } catch (err) {
      // only a ceremony's own message is written for an operator; anything else
      // is reported plainly rather than put on screen raw.
      setError(
        err instanceof SwoopStepUpError ? err.message : 'that could not be checked. try again.',
      );
      setPending(null);
      return;
    }

    // the entered code is cleared the moment it has been handed over.
    setCode('');
    try {
      await onProof(proof);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'taking control failed. try again.');
      setPending(null);
    }
  };

  return {
    code,
    setCode,
    authenticator,
    backupCode,
    isBackupCode,
    setIsBackupCode: setBackupChosen,
    pending,
    error,
    setError,
    submit,
  };
}

export type StepUpCeremony = ReturnType<typeof useStepUpCeremony>;

/**
 * the code field, with its backup-code switch when the account has both an
 * authenticator app and a backup code left. a refusal hands the cleared field
 * straight back.
 */
export function StepUpCodeFields({
  ceremony,
  disabled,
}: {
  ceremony: StepUpCeremony;
  disabled: boolean;
}) {
  const { code, setCode, authenticator, backupCode, isBackupCode, setIsBackupCode, error, submit } = ceremony;
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (error && !disabled) input.current?.focus();
  }, [error, disabled]);

  return (
    <>
      <div className="space-y-2">
        <Label htmlFor="swoop-step-up-code">
          {isBackupCode ? 'backup code' : 'authenticator code'}
        </Label>
        <Input
          ref={input}
          id="swoop-step-up-code"
          value={code}
          onChange={(e) => setCode(e.target.value)}
          placeholder={isBackupCode ? 'backup code' : '6-digit code'}
          inputMode={isBackupCode ? 'text' : 'numeric'}
          maxLength={isBackupCode ? 16 : 6}
          autoComplete="one-time-code"
          autoFocus
          disabled={disabled}
          onKeyDown={(e) => {
            if (e.key === 'Enter') submit('code');
          }}
        />
      </div>

      {authenticator && backupCode && (
        <div className="flex items-center gap-2">
          <Checkbox
            id="swoop-step-up-backup"
            checked={isBackupCode}
            onCheckedChange={(checked) => {
              setIsBackupCode(checked === true);
              setCode('');
            }}
            disabled={disabled}
          />
          <Label
            htmlFor="swoop-step-up-backup"
            className="cursor-pointer text-xs text-muted-foreground"
          >
            use a backup code instead
          </Label>
        </div>
      )}
    </>
  );
}

/** the link that opens a backup-code field for an account with no authenticator app. */
export function BackupCodeLink({ onClick, disabled }: { onClick: () => void; disabled: boolean }) {
  return (
    <p className="text-center">
      <button
        type="button"
        onClick={onClick}
        disabled={disabled}
        className="hl-link cursor-pointer text-xs text-accent-cyan disabled:pointer-events-none disabled:opacity-50"
      >
        use a backup code instead
      </button>
    </p>
  );
}

function StepUpForm({ factors, onProof, onCancel }: Omit<SwoopStepUpProps, 'open'>) {
  const choices = useSecondFactorChoices(factors);
  const enrolled = holdsSecondFactor(factors);
  const ceremony = useStepUpCeremony(onProof, {
    authenticator: choices.authenticatorCode,
    backupCode: choices.backupCode,
  });
  const { pending, error, setError, submit } = ceremony;
  const viewerApp = useViewerAppPlatform() !== null;
  const params = useParams<{ siteId: string; machineId: string }>();
  // the browser check stands in for a passkey the app cannot prompt for
  const machine =
    viewerApp && factors.passkeys > 0 && params?.siteId && params?.machineId
      ? { siteId: params.siteId, machineId: params.machineId }
      : null;
  // a backup code waits behind its link while the account has another way here
  const [backupOpen, setBackupOpen] = useState(false);
  const showCode = choices.authenticatorCode || (choices.backupCode && (backupOpen || (!choices.passkey && !machine)));

  /** the verification page while owlette swoop waits on the browser for it. */
  const [browserWait, setBrowserWait] = useState<string | null>(null);
  /** identity of the running wait, or null; a stale run's answers are dropped. */
  const browserRun = useRef<symbol | null>(null);
  const browserTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  /** reads only refs, so it is safe as the unmount cleanup. */
  const stopBrowserPoll = useCallback(() => {
    browserRun.current = null;
    if (browserTimer.current) clearTimeout(browserTimer.current);
    browserTimer.current = null;
  }, []);

  useEffect(() => stopBrowserPoll, [stopBrowserPoll]);

  const cancelBrowserCheck = () => {
    stopBrowserPoll();
    setBrowserWait(null);
  };

  const verifyInBrowser = async () => {
    if (!machine || pending || browserWait) return;
    const run = Symbol('browser-check');
    browserRun.current = run;
    const url = stepUpVerifyUrl(machine.siteId, machine.machineId);
    setError(null);
    setBrowserWait(url);

    const giveUp = (message: string) => {
      stopBrowserPoll();
      setBrowserWait(null);
      setError(message);
    };
    const deadline = Date.now() + BROWSER_WAIT_MS;
    let opened = false;

    // the first read comes before the browser opens: a sign-in that skipped
    // the second factor never reads a window opened elsewhere, so it is told
    // to use a code rather than sent to pass a check that cannot reach it.
    const poll = async () => {
      if (browserRun.current !== run) return;
      if (Date.now() >= deadline) return giveUp("that didn't go through, try again");

      // a failed read is transient: the next poll retries and the deadline bounds it
      const status = await readStepUpWindow(machine.siteId, machine.machineId).catch(() => null);
      if (browserRun.current !== run) return;
      if (status && !status.sessionPassedCeremony) {
        const instead = choices.authenticatorCode ? ' enter a code here instead.' : choices.backupCode ? ' enter a backup code here instead.' : '';
        return giveUp(
          `this sign-in skipped the second factor, so a check in your browser can't reach owlette swoop.${instead}`,
        );
      }
      if (status?.open) {
        stopBrowserPoll();
        try {
          await onProof(STEP_UP_WINDOW_OPEN);
        } catch (err) {
          setBrowserWait(null);
          setError(err instanceof Error ? err.message : 'taking control failed. try again.');
        }
        return;
      }
      if (!opened) {
        opened = true;
        // the app hands this to the system browser and answers null every time
        window.open(url, '_blank');
      }
      browserTimer.current = setTimeout(poll, BROWSER_POLL_MS);
    };
    await poll();
  };

  const busy = pending !== null || browserWait !== null;

  // the way that needs no code: the passkey here, or in owlette swoop the browser
  const primary = machine ? (
    browserWait ? (
      <div className="space-y-3">
        <p role="status" className="text-center text-sm text-muted-foreground">
          waiting for your browser…
        </p>
        <p className="text-center text-xs text-muted-foreground">
          didn&apos;t open?{' '}
          <a href={browserWait} target="_blank" rel="noopener" className="hl-link text-accent-cyan">
            open the verification page
          </a>
        </p>
        <Button type="button" variant="outline" className="w-full" onClick={cancelBrowserCheck}>
          cancel
        </Button>
      </div>
    ) : (
      <Button type="button" className="w-full" onClick={verifyInBrowser} disabled={busy}>
        <Globe />
        verify in your browser
      </Button>
    )
  ) : choices.passkey ? (
    <Button type="button" className="w-full" onClick={() => submit('passkey')} disabled={busy}>
      <Fingerprint />
      {pending === 'passkey' ? 'waiting for your passkey...' : 'use a passkey'}
    </Button>
  ) : null;

  return (
    <>
      <DialogHeader>
        <DialogTitle>confirm it&apos;s you</DialogTitle>
        <DialogDescription>
          {/* 7 days is `SWOOP_STEP_UP_WINDOW_MS`, which lives in a
              server-only module and so cannot be imported here. */}
          {enrolled
            ? 'taking control of a machine needs a second factor right now — not just a signed-in session. one check covers this machine for 7 days, reconnects included.'
            : 'taking control of a machine needs a second factor, and this account has none enrolled.'}
        </DialogDescription>
      </DialogHeader>

      {enrolled ? (
        <div className="space-y-3">
          {primary}
          {primary && choices.authenticatorCode ? (
            <p className="text-center text-xs text-muted-foreground">or enter a code</p>
          ) : null}
          {!primary && !choices.authenticatorCode && choices.passkeyHint ? (
            <p className="text-xs text-muted-foreground">{choices.passkeyHint}</p>
          ) : null}

          {showCode ? (
            <StepUpCodeFields ceremony={ceremony} disabled={busy} />
          ) : choices.backupCode ? (
            <BackupCodeLink onClick={() => setBackupOpen(true)} disabled={busy} />
          ) : null}
        </div>
      ) : (
        <div className="flex items-start gap-2 rounded-md border border-border bg-muted/40 p-3">
          <ShieldCheck className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" />
          <p className="text-xs text-muted-foreground">
            signing in with google or a password is not a second factor. enroll an
            authenticator app or a passkey in{' '}
            <Link href="/setup-2fa" className="hl-link text-accent-cyan">
              security settings
            </Link>
            , then start the session again.
          </p>
        </div>
      )}

      {error && (
        <p role="alert" className="text-xs text-destructive">
          {error}
        </p>
      )}

      {/* the wait has its own cancel; two would mean two different things */}
      {browserWait ? null : (
        <DialogFooter className="gap-2 sm:gap-0">
          <Button type="button" variant="ghost" onClick={onCancel} disabled={pending !== null}>
            cancel
          </Button>
          {enrolled && showCode && (
            <Button type="button" onClick={() => submit('code')} disabled={pending !== null}>
              {pending === 'code' ? 'checking...' : 'confirm'}
            </Button>
          )}
        </DialogFooter>
      )}
    </>
  );
}
