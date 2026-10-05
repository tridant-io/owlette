'use client';

import { useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { useAuth } from '@/contexts/AuthContext';
import { PageHeader } from '@/components/PageHeader';
import { ApiKeysManager } from '@/components/ApiKeysManager';

/**
 * Deep-link route for api-key management.
 *
 * The account-settings dialog is the primary surface now; this page is a thin
 * wrapper around the same panel. It survives rather than redirecting because
 * nine e2e navigations across five specs, three docs pages, and
 * e2e/COVERAGE.md point at the route, and nothing can deep-link a dialog
 * section by URL today (`initialSection` is a prop, not a query param).
 */
export default function ApiKeysSettingsPage() {
  const router = useRouter();
  const { user, loading: authLoading } = useAuth();

  useEffect(() => {
    if (authLoading) return;
    if (!user) router.push('/login');
  }, [user, authLoading, router]);

  if (authLoading || !user) return null;

  return (
    <div className="page-cascade min-h-screen bg-background">
      <PageHeader currentPage="api keys" />
      <main className="relative z-10 mx-auto max-w-4xl px-4 py-8 sm:px-6">
        <ApiKeysManager />
      </main>
    </div>
  );
}
