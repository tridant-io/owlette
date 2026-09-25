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
 */

import { useState } from 'react';
import Link from 'next/link';
import { Fingerprint, ShieldCheck } from 'lucide-react';
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
import {
  codeStepUpProof,
  passkeyStepUpProof,
  SwoopStepUpError,
  type SwoopStepUpProof,
  type SwoopStepUpProps,
} from '@/lib/swoop/stepUp';

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

function StepUpForm({ enrolled, onProof, onCancel }: Omit<SwoopStepUpProps, 'open'>) {
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
              disabled={pending !== null}
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
              disabled={pending !== null}
            />
            <Label
              htmlFor="swoop-step-up-backup"
              className="cursor-pointer text-xs text-muted-foreground"
            >
              use a backup code instead
            </Label>
          </div>

          <Button
            type="button"
            variant="outline"
            className="w-full"
            onClick={() => submit('passkey')}
            disabled={pending !== null}
          >
            <Fingerprint />
            {pending === 'passkey' ? 'waiting for your passkey...' : 'use a passkey'}
          </Button>
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
    </>
  );
}
