'use client';

import { type ReactNode, useEffect } from 'react';
import { usePathname } from 'next/navigation';
import { AuthProvider } from '@/contexts/AuthContext';
import { ThemePreferenceSync } from '@/components/ThemePreferenceSync';

/**
 * Wraps children in AuthProvider. Previously lazy-loaded to defer Firebase SDK,
 * but dynamic import caused a tree-structure change (Fragment → Provider) that
 * unmounted/remounted the entire child tree, restarting all CSS animations.
 */
export function LazyAuthProvider({ children }: { children: ReactNode }) {
  const pathname = usePathname();

  // Track last non-admin path so the admin panel back button can show "back to X"
  useEffect(() => {
    if (pathname && !pathname.startsWith('/admin')) {
      sessionStorage.setItem('owlette_pre_admin_path', pathname);
    }
  }, [pathname]);

  return (
    <AuthProvider>
      <ThemePreferenceSync />
      {children}
    </AuthProvider>
  );
}
