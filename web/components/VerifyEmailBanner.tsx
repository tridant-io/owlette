'use client';

/**
 * Asks a password account to verify its email, with a rate-limited resend.
 * Blocks nothing: after beta, a verified email is what starts the trial.
 *
 * Mounted under the app header. Renders null for signed-out users, federated
 * (Google) accounts, which arrive verified, and verified accounts.
 */

import { useCallback, useState } from 'react';
import { Mail } from 'lucide-react';
import { useAuth } from '@/contexts/AuthContext';
import { useEmailVerifiedOnReturn } from '@/hooks/useEmailVerifiedOnReturn';
import { useSendVerification } from '@/hooks/useSendVerification';
import { Button } from '@/components/ui/button';

export function VerifyEmailBanner() {
  const { user } = useAuth();
  const [verified, setVerified] = useState(false);
  const { send, sending } = useSendVerification();

  const pending =
    !!user &&
    !user.emailVerified &&
    !verified &&
    (user.providerData ?? []).some((provider) => provider.providerId === 'password');

  useEmailVerifiedOnReturn(
    pending,
    useCallback(() => setVerified(true), []),
  );

  if (!pending) return null;

  return (
    <div
      data-testid="verify-email-banner"
      className="relative z-10 border-b border-border bg-accent-cyan/10"
    >
      <div className="mx-auto flex max-w-screen-2xl flex-wrap items-center justify-center gap-x-2 gap-y-1 px-4 py-1 text-sm">
        <Mail className="h-4 w-4 shrink-0 text-accent-cyan" aria-hidden />
        {/* the short copy keeps the banner one row on a phone */}
        <span className="text-foreground">
          <span className="sm:hidden">verify your email.</span>
          <span className="hidden sm:inline">please verify your email address.</span>
        </span>
        <Button
          type="button"
          variant="link"
          size="sm"
          onClick={send}
          disabled={sending}
          aria-label="send verification email"
        >
          {sending ? (
            'sending...'
          ) : (
            <>
              <span className="sm:hidden">send link</span>
              <span className="hidden sm:inline">send verification email</span>
            </>
          )}
        </Button>
      </div>
    </div>
  );
}
