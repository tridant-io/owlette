'use client';

/**
 * Asks a password account to verify its email, with a rate-limited resend.
 * Blocks nothing: after beta, a verified email is what starts the trial.
 *
 * Mounted under the app header. Renders null for signed-out users, federated
 * (Google) accounts, which arrive verified, and verified accounts.
 */

import { useEffect, useState } from 'react';
import { Mail } from 'lucide-react';
import { useAuth } from '@/contexts/AuthContext';
import { auth } from '@/lib/firebase';
import { Button } from '@/components/ui/button';
import { toast } from '@/lib/toast';

export function VerifyEmailBanner() {
  const { user } = useAuth();
  const [verified, setVerified] = useState(false);
  const [sending, setSending] = useState(false);

  const pending =
    !!user &&
    !user.emailVerified &&
    !verified &&
    (user.providerData ?? []).some((provider) => provider.providerId === 'password');

  // the link usually opens in another tab, so recheck whenever this one comes back
  useEffect(() => {
    if (!pending) return;
    const recheck = () => {
      const current = auth?.currentUser;
      if (!current || document.visibilityState !== 'visible') return;
      current.reload().then(
        () => {
          if (current.emailVerified) setVerified(true);
        },
        // offline or signed out mid-flight; the next focus tries again
        () => undefined,
      );
    };
    window.addEventListener('focus', recheck);
    document.addEventListener('visibilitychange', recheck);
    return () => {
      window.removeEventListener('focus', recheck);
      document.removeEventListener('visibilitychange', recheck);
    };
  }, [pending]);

  if (!pending) return null;

  const resend = async () => {
    setSending(true);
    try {
      const res = await fetch('/api/auth/verify-email', { method: 'POST' });
      if (res.ok) {
        toast.success('verification email sent', { description: `check ${user.email}` });
        return;
      }
      const data = await res.json().catch(() => ({}));
      toast.error('could not send the email', {
        description: typeof data.detail === 'string' ? data.detail : 'please try again later.',
      });
    } catch {
      toast.error('could not send the email', { description: 'please try again later.' });
    } finally {
      setSending(false);
    }
  };

  return (
    <div
      data-testid="verify-email-banner"
      className="relative z-10 border-b border-border bg-accent-cyan/10"
    >
      <div className="mx-auto flex max-w-screen-2xl flex-wrap items-center justify-center gap-x-2 gap-y-1 px-4 py-1 text-sm">
        <Mail className="h-4 w-4 shrink-0 text-accent-cyan" aria-hidden />
        <span className="text-foreground">please verify your email address.</span>
        <Button type="button" variant="link" size="sm" onClick={resend} disabled={sending}>
          {sending ? 'sending...' : 'send verification email'}
        </Button>
      </div>
    </div>
  );
}
