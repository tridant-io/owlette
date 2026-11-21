'use client';

/**
 * the resend behind every "verify your email" prompt: VerifyEmailBanner, the
 * plan banner and the plan page's trial card. POST /api/auth/verify-email is
 * rate-limited, and a refusal's detail is shown as it comes.
 */

import { useState } from 'react';
import { useAuth } from '@/contexts/AuthContext';
import { toast } from '@/lib/toast';

export function useSendVerification() {
  const { user } = useAuth();
  const [sending, setSending] = useState(false);

  const send = async () => {
    setSending(true);
    try {
      const res = await fetch('/api/auth/verify-email', { method: 'POST' });
      if (res.ok) {
        toast.success('verification email sent', user?.email ? { description: `check ${user.email}` } : undefined);
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

  return { send, sending };
}
