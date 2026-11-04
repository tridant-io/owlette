'use client';

import { useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { useAuth } from '@/contexts/AuthContext';
import { toast } from '@/lib/toast';

/**
 * Gate for the admin panel. `minRole` names the tier that may see the wrapped
 * subtree; anyone below it is bounced to /dashboard with an error toast.
 *
 * `'superadmin'` is the platform tier (installers, presets, users, email).
 * `'admin'` is the SITE-SCOPED half (sites, tokens, schedules, alerts,
 * webhooks), and since wave 5.1 the global role no longer expresses it — a
 * global `admin` with no membership grants nothing. The gate is now
 * "administers at least one site", which is what those pages actually require:
 * previously such a user reached them, saw an empty site list on every one, and
 * had every write refused server-side.
 *
 * Still coarse by design — WHICH sites they may act on is scoped per page by
 * `useSites`, and again server-side on every write.
 */
export default function RequireAdminAccess({
  minRole,
  children,
}: {
  minRole: 'admin' | 'superadmin';
  children: React.ReactNode;
}) {
  const { user, loading, isSuperadmin, administersAnySite, userSites } = useAuth();
  const router = useRouter();

  // loading ends with the user doc while the membership rows may still be on
  // their way; deciding before userSites resolves bounces a site admin on a hard load
  const resolving = loading || (!!user && userSites === undefined);
  const allowed = minRole === 'admin' ? administersAnySite : isSuperadmin;

  useEffect(() => {
    if (resolving) return;

    // The proxy should already have redirected; double-check for safety.
    if (!user) {
      router.push('/login');
      return;
    }

    if (!allowed) {
      toast.error('access denied', {
        description: 'you do not have permission to access this page.',
      });
      router.push('/dashboard');
    }
  }, [user, resolving, allowed, router]);

  if (resolving || !user || !allowed) {
    return (
      <div className="flex items-center justify-center min-h-screen bg-background">
        <div className="text-center">
          <div className="inline-block h-8 w-8 animate-spin rounded-full border-4 border-solid border-accent-cyan border-r-transparent"></div>
          <p className="mt-4 text-muted-foreground">verifying permissions...</p>
        </div>
      </div>
    );
  }

  return <>{children}</>;
}
