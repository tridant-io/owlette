'use client';

import { useState } from 'react';
import Link from 'next/link';
import { AlertTriangle, Fingerprint, KeyRound, ShieldCheck } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { LoadingWord } from '@/components/LoadingWord';
import { PasskeyManager } from '@/components/PasskeyManager';
import { useMfaFactors } from '@/hooks/useMfaFactors';
import { browserSupportsWebAuthn } from '@/hooks/usePasskeys';
import { toast } from '@/lib/toast';

/**
 * The account's second factors, as one list. TOTP and passkeys were separate panel blocks;
 * universal 2FA makes them the same feature (any one factor satisfies the gate), so they are
 * counted, shown and managed together.
 *
 * Rules this UI encodes:
 * - Removing the LAST factor is ALLOWED — it re-arms `requiresMfaSetup`. Every removal control
 *   warns and none refuses: someone who lost the device holding their only factor must still be
 *   able to detach it.
 * - Zero factors is a legitimate momentary state and the panel says so.
 * - Adding a factor to an account that has one requires clearing a challenge first
 *   (`checkMfaEnrollmentGate`), and must never dead-end: passkey accounts step up inline, the
 *   TOTP path routes through /verify-2fa back to /setup-2fa.
 */

interface MfaFactorsSectionProps {
  userId: string;
  /** Close the settings dialog before following a link out of it. */
  onNavigateAway?: () => void;
}

function formatDate(iso: string): string {
  return new Date(iso).toLocaleDateString(undefined, {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  });
}

export function MfaFactorsSection({ userId, onNavigateAway }: MfaFactorsSectionProps) {
  const { factors, loading, error, refresh, removeTotp, stepUpWithPasskey } =
    useMfaFactors(userId);

  const [removeOpen, setRemoveOpen] = useState(false);
  const [removeCode, setRemoveCode] = useState('');
  const [useBackupCode, setUseBackupCode] = useState(false);
  const [removing, setRemoving] = useState(false);
  const [steppingUp, setSteppingUp] = useState(false);

  const { totp, passkeys, totalFactors, mfaVerified } = factors;

  // The gate only bites when a factor exists; a zero-factor account is in mandatory setup.
  const needsChallenge = totalFactors > 0 && !mfaVerified;
  const isLastFactor = totalFactors === 1;

  // Inline verify needs a passkey AND a browser that can assert it; otherwise use the code path.
  const canStepUpInline = passkeys.length > 0 && browserSupportsWebAuthn();

  // /setup-2fa's first request 403s while the gate is armed, so route through the challenge.
  const totpSetupHref = needsChallenge ? '/verify-2fa?redirect=/setup-2fa' : '/setup-2fa';

  const closeRemoveDialog = () => {
    setRemoveOpen(false);
    setRemoveCode('');
    setUseBackupCode(false);
  };

  const handleStepUp = async () => {
    setSteppingUp(true);
    try {
      await stepUpWithPasskey();
      toast.success('verified — you can add another factor now');
    } catch (err) {
      if (err instanceof Error && err.name === 'NotAllowedError') {
        toast.error('passkey verification was cancelled');
      } else {
        toast.error(err instanceof Error ? err.message : 'passkey verification failed');
      }
    } finally {
      setSteppingUp(false);
    }
  };

  const handleRemoveTotp = async () => {
    const code = removeCode.trim();
    if (!code) {
      toast.error('enter a code to confirm');
      return;
    }

    setRemoving(true);
    try {
      await removeTotp(code, useBackupCode);
      toast.success('authenticator app removed');
      closeRemoveDialog();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'failed to remove authenticator app');
    } finally {
      setRemoving(false);
    }
  };

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <div>
          <Label className="text-foreground">two-factor authentication</Label>
          <p className="text-xs text-muted-foreground">
            {loading
              ? 'checking your second factors'
              : totalFactors === 1
                ? '1 second factor on this account'
                : `${totalFactors} second factors on this account`}
          </p>
        </div>
      </div>

      {loading ? (
        <p className="text-sm text-muted-foreground">
          <LoadingWord />
        </p>
      ) : error ? (
        <div className="flex items-center justify-between gap-3 rounded-md border border-border bg-card/50 p-4">
          <p className="text-sm text-danger">{error}</p>
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="h-8 shrink-0 cursor-pointer border-border text-accent-cyan hover:bg-muted hover:text-accent-cyan"
            onClick={() => refresh()}
          >
            retry
          </Button>
        </div>
      ) : (
        <>
          {totalFactors === 0 && (
            <div className="flex items-start gap-2 rounded-md border border-warning-border bg-warning-surface p-3">
              <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-warning" />
              <p className="text-xs text-warning">
                this account has no second factor. you&apos;ll be asked to set one up
                the next time you sign in.
              </p>
            </div>
          )}

          {isLastFactor && (
            <div className="flex items-start gap-2 rounded-md border border-warning-border bg-warning-surface p-3">
              <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-warning" />
              <p className="text-xs text-warning">
                this is your only second factor. add another so you don&apos;t lose
                access if you lose this one.
              </p>
            </div>
          )}

          {needsChallenge && (
            <div className="space-y-2 rounded-md border border-border bg-card/50 p-3">
              <div className="flex items-start gap-2">
                <ShieldCheck className="mt-0.5 h-4 w-4 shrink-0 text-accent-cyan" />
                <p className="text-xs text-muted-foreground">
                  verify a factor you already have before adding another. this stops
                  someone with your signed-in browser from quietly attaching one of
                  their own.
                </p>
              </div>
              <div className="flex flex-wrap items-center gap-2 pl-6">
                {canStepUpInline && (
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    className="h-8 cursor-pointer border-border text-accent-cyan hover:bg-muted hover:text-accent-cyan"
                    onClick={handleStepUp}
                    disabled={steppingUp}
                  >
                    <Fingerprint className="mr-2 h-3.5 w-3.5" />
                    {steppingUp ? 'waiting for device...' : 'verify with passkey'}
                  </Button>
                )}
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  asChild
                  className="h-8 cursor-pointer border-border text-accent-cyan hover:bg-muted hover:text-accent-cyan"
                >
                  <Link href="/verify-2fa?redirect=/dashboard" onClick={onNavigateAway}>
                    use a code instead
                  </Link>
                </Button>
              </div>
            </div>
          )}

          <div className="flex items-center justify-between gap-3 rounded-md border border-border bg-card/50 p-4">
            <div className="flex min-w-0 items-center gap-3">
              <KeyRound className="h-4 w-4 shrink-0 text-muted-foreground" />
              <div className="min-w-0">
                <p className="text-sm text-foreground">authenticator app</p>
                <p className="text-xs text-muted-foreground">
                  {totp.enrolled
                    ? totp.enrolledAt
                      ? `added ${formatDate(totp.enrolledAt)}`
                      : 'active'
                    : 'six-digit codes from an app like 1Password or Authy'}
                </p>
              </div>
            </div>
            {totp.enrolled ? (
              <Button
                type="button"
                variant="outline"
                size="sm"
                className="h-8 shrink-0 cursor-pointer border-border text-destructive hover:bg-muted"
                onClick={() => setRemoveOpen(true)}
              >
                remove
              </Button>
            ) : (
              <Button
                type="button"
                variant="outline"
                size="sm"
                asChild
                className="h-8 shrink-0 cursor-pointer border-border text-accent-cyan hover:bg-muted hover:text-accent-cyan"
              >
                <Link href={totpSetupHref} onClick={onNavigateAway}>
                  set up
                </Link>
              </Button>
            )}
          </div>

          {/* Nested, not a sibling further down the panel, so both factor types live in one
              place. `refresh` keeps the counts above honest after a register or delete. */}
          <PasskeyManager
            userId={userId}
            compact
            onChange={refresh}
            onChallengeRequired={refresh}
            isLastFactor={isLastFactor}
          />
        </>
      )}

      {/* `/api/mfa/disable` demands live proof of possession — a warm session is deliberately
          not enough — so the code field is part of the confirmation, not a second step. */}
      <Dialog open={removeOpen} onOpenChange={(open) => !open && closeRemoveDialog()}>
        <DialogContent className="border-border text-foreground sm:max-w-sm">
          <DialogHeader>
            <DialogTitle className="text-foreground">remove authenticator app</DialogTitle>
            <DialogDescription className="text-muted-foreground">
              enter a code from your authenticator to confirm. you won&apos;t be able
              to sign in with it anymore.
            </DialogDescription>
          </DialogHeader>

          {isLastFactor && (
            <div className="flex items-start gap-2 rounded-md border border-warning-border bg-warning-surface p-3">
              <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-warning" />
              <p className="text-xs text-warning">
                this is your last second factor — you&apos;ll be asked to set one up
                again next time you sign in.
              </p>
            </div>
          )}

          <div className="space-y-3">
            <Input
              value={removeCode}
              onChange={(e) => setRemoveCode(e.target.value)}
              placeholder={useBackupCode ? 'backup code' : '6-digit code'}
              className="border-border bg-background text-foreground placeholder:text-muted-foreground"
              inputMode={useBackupCode ? 'text' : 'numeric'}
              maxLength={useBackupCode ? 16 : 6}
              autoFocus
              disabled={removing}
              onKeyDown={(e) => {
                if (e.key === 'Enter') handleRemoveTotp();
              }}
            />
            <div className="flex items-center gap-2">
              <Checkbox
                id="removeTotpUseBackupCode"
                checked={useBackupCode}
                onCheckedChange={(checked) => {
                  setUseBackupCode(checked === true);
                  setRemoveCode('');
                }}
                disabled={removing}
              />
              <Label
                htmlFor="removeTotpUseBackupCode"
                className="cursor-pointer text-xs text-muted-foreground"
              >
                use a backup code instead
              </Label>
            </div>
          </div>

          <DialogFooter className="gap-2 sm:gap-0">
            <Button
              type="button"
              variant="ghost"
              className="cursor-pointer border border-border bg-secondary"
              onClick={closeRemoveDialog}
              disabled={removing}
            >
              cancel
            </Button>
            <Button
              type="button"
              variant="destructive"
              className="cursor-pointer"
              onClick={handleRemoveTotp}
              disabled={removing}
            >
              {removing ? 'removing...' : 'remove'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
