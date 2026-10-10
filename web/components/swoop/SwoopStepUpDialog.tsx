'use client';

/**
 * the live second-factor ceremony that unlocks control.
 *
 * **these props are frozen.** the page mounts this component with exactly this
 * contract so the ceremony lands without the page or the hook being touched:
 * `onProof` receives the body `parseMfaProof` accepts and the hook forwards it
 * verbatim into the session-create request. a proof is never logged, never
 * stored and never inspected on the way through.
 *
 * `enrolled: false` means the account holds no second factor at all — the
 * dialog shows an enroll hint pointing at the security settings rather than a
 * code field, because such an account cannot take control at all.
 *
 * in owlette swoop a passkey prompt reaches only the platform authenticator, so
 * there the passkey button gives way to "verify in your browser": the system
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

export function SwoopStepUpDialog({ open, enrolled, onProof, onCancel }: SwoopStepUpProps) {
  return (
    <Dialog open={open} onOpenChange={(next) => !next && onCancel()}>
      <DialogContent className="sm:max-w-sm">
        {/* the form is a child so that closing the dialog unmounts it: a fresh
            ask never inherits the last attempt's code or error. */}
        <StepUpForm enrolled={enrolled} onProof={onProof} onCancel={onCancel} />
      </DialogContent>
    </Dialog>
  );
}

/**
 * the ceremony itself: the code being typed and the one attempt in flight.
 * shared with the browser's verify page, whose `onProof` posts the proof to the
 * step-up route instead of retrying a session.
 */
export function useStepUpCeremony(onProof: (proof: SwoopStepUpProof) => Promise<void>) {
  const [code, setCode] = useState('');
  const [isBackupCode, setIsBackupCode] = useState(false);
  const [pending, setPending] = useState<'code' | 'passkey' | null>(null);
  const [error, setError] = useState<string | null>(null);

  /**
   * one ceremony, then exactly one retry — `onProof` is what retries, and it is
   * called once. a second `step_up_required` re-opens this dialog through the
   * page, so the operator decides again rather than a loop deciding for them.
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

  return { code, setCode, isBackupCode, setIsBackupCode, pending, error, setError, submit };
}

export type StepUpCeremony = ReturnType<typeof useStepUpCeremony>;

/** the authenticator code field and its backup-code switch. */
export function StepUpCodeFields({
  ceremony,
  disabled,
}: {
  ceremony: StepUpCeremony;
  disabled: boolean;
}) {
  const { code, setCode, isBackupCode, setIsBackupCode, submit } = ceremony;
  return (
    <>
      <div className="space-y-2">
        <Label htmlFor="swoop-step-up-code">
          {isBackupCode ? 'backup code' : 'authenticator code'}
        </Label>
        <Input
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
    </>
  );
}

function StepUpForm({ enrolled, onProof, onCancel }: Omit<SwoopStepUpProps, 'open'>) {
  const ceremony = useStepUpCeremony(onProof);
  const { pending, error, setError, submit } = ceremony;
  const viewerApp = useViewerAppPlatform() !== null;
  const params = useParams<{ siteId: string; machineId: string }>();
  const machine =
    viewerApp && params?.siteId && params?.machineId
      ? { siteId: params.siteId, machineId: params.machineId }
      : null;

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
        return giveUp(
          "this sign-in skipped the second factor, so a check in your browser can't reach owlette swoop. enter a code here instead.",
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

  const browserCheck = !machine ? null : browserWait ? (
    <div className="space-y-3">
      <p role="status" className="text-center text-sm text-muted-foreground">
        waiting for your browser…
      </p>
      <p className="text-center text-xs text-muted-foreground">
        didn&apos;t open?{' '}
        <a href={browserWait} target="_blank" rel="noopener" className="underline underline-offset-2">
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
  );

  return (
    <>
      <DialogHeader>
        <DialogTitle>confirm it&apos;s you</DialogTitle>
        <DialogDescription>
          {/* 12 hours is `SWOOP_STEP_UP_WINDOW_MS`, which lives in a
              server-only module and so cannot be imported here. */}
          {enrolled
            ? 'taking control of a machine needs a second factor right now — not just a signed-in session. one check covers this machine for 12 hours, reconnects included.'
            : 'taking control of a machine needs a second factor, and this account has none enrolled.'}
        </DialogDescription>
      </DialogHeader>

      {enrolled ? (
        <div className="space-y-3">
          {browserCheck}
          {browserCheck ? (
            <p className="text-center text-xs text-muted-foreground">or enter a code</p>
          ) : null}

          <StepUpCodeFields ceremony={ceremony} disabled={busy} />

          {viewerApp ? null : (
            <Button
              type="button"
              variant="outline"
              className="w-full"
              onClick={() => submit('passkey')}
              disabled={busy}
            >
              <Fingerprint />
              {pending === 'passkey' ? 'waiting for your passkey...' : 'use a passkey'}
            </Button>
          )}
        </div>
      ) : (
        <div className="flex items-start gap-2 rounded-md border border-border bg-muted/40 p-3">
          <ShieldCheck className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" />
          <p className="text-xs text-muted-foreground">
            signing in with google or a password is not a second factor. enroll an
            authenticator app or a passkey in{' '}
            <Link href="/setup-2fa" className="underline underline-offset-2">
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
          {enrolled && (
            <Button type="button" onClick={() => submit('code')} disabled={pending !== null}>
              {pending === 'code' ? 'checking...' : 'confirm'}
            </Button>
          )}
        </DialogFooter>
      )}
    </>
  );
}
