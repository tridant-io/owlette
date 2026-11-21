'use client';

/**
 * /settings/alerts — self-serve alert-email preferences, and the destination of
 * the "manage alerts" link in every alert email (wrapEmailLayout). Recipients
 * toggle individual categories instead of only fully unsubscribing; each toggle
 * saves immediately (optimistic, reverting on failure). Same toggles as the
 * account-settings dialog's "alerts" section — this is the deep-linkable view.
 */

import { useEffect } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import { useAuth } from '@/contexts/AuthContext';
import { AlertEmailToggles } from '@/components/AlertEmailToggles';
import { OwletteEyeIcon } from '@/components/landing/OwletteEye';
import { ChevronLeft, Loader2 } from 'lucide-react';

export default function ManageAlertsPage() {
  const router = useRouter();
  const { user, loading: authLoading } = useAuth();

  // Send unauthenticated visitors to login, preserving the return path so they
  // land back here after signing in (the email link is the common entry point).
  useEffect(() => {
    if (!authLoading && !user) {
      router.replace('/login?redirect=/settings/alerts');
    }
  }, [authLoading, user, router]);

  if (authLoading || !user) {
    return (
      <div className="flex min-h-screen items-center justify-center">
        <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-background">
      <div className="mx-auto w-full max-w-2xl px-4 py-10">
        <Link
          href="/dashboard"
          className="mb-6 inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground"
        >
          <ChevronLeft className="h-4 w-4" />
          back to dashboard
        </Link>

        <div className="mb-6 flex items-center gap-3">
          <OwletteEyeIcon size={36} />
          <div>
            <h1 className="text-xl font-semibold text-foreground">manage alerts</h1>
            <p className="text-sm text-muted-foreground">
              choose which email alerts you receive. sent to{' '}
              <span className="font-medium text-foreground">{user.email}</span>.
            </p>
          </div>
        </div>

        <AlertEmailToggles />

        <p className="mt-6 text-xs text-muted-foreground">
          changes save automatically. need more control (CC recipients, threshold
          rules)? open account settings from the dashboard.
        </p>
      </div>
    </div>
  );
}
