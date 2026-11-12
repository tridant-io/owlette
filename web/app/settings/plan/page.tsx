'use client';

/**
 * /settings/plan — the signed-in user's account plan. Every 402 `plan_required`
 * points here (`upgradeUrl`).
 *
 * While plans are not enforced the page says so and nothing else. With plans
 * enforced it shows its heading alone: a plan belongs to a site now (adr 0018),
 * and the account overview is not built yet.
 */

import { useEffect, type ReactNode } from 'react';
import { useRouter } from 'next/navigation';
import { CreditCard, Loader2 } from 'lucide-react';
import { useAuth } from '@/contexts/AuthContext';
import { usePlan } from '@/hooks/usePlan';
import { PageCascade } from '@/components/PageCascade';
import { PageHeader } from '@/components/PageHeader';
import { Button } from '@/components/ui/button';

export default function PlanSettingsPage() {
  const router = useRouter();
  const { user, loading: authLoading } = useAuth();
  const { plan, loading, error, refresh } = usePlan();

  useEffect(() => {
    if (authLoading) return;
    if (!user) router.push('/login');
  }, [user, authLoading, router]);

  if (authLoading || !user) return null;

  let body: ReactNode = null;
  if (!plan && loading) {
    body = (
      <div className="flex justify-center py-12">
        <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" aria-label="loading" />
      </div>
    );
  } else if (!plan) {
    body = (
      <div className="flex flex-wrap items-center gap-3">
        <p className="text-sm text-muted-foreground">{error ?? 'failed to load plan'}</p>
        <Button type="button" size="sm" variant="outline" onClick={() => void refresh()}>
          try again
        </Button>
      </div>
    );
  }

  return (
    <PageCascade className="min-h-screen bg-background">
      <PageHeader currentPage="plan" />
      <main className="relative z-10 mx-auto max-w-4xl px-4 py-6 sm:px-6 sm:py-8">
        <div className="mb-6">
          <h1 className="flex items-center gap-2 text-2xl font-semibold text-foreground">
            <CreditCard className="h-5 w-5" aria-hidden />
            plan
          </h1>
          {plan && !plan.enforced && (
            <p data-testid="plans-not-active" className="mt-1 text-sm text-muted-foreground">
              plans aren&apos;t active during beta, so every feature is included.
            </p>
          )}
        </div>
        {body}
      </main>
    </PageCascade>
  );
}
