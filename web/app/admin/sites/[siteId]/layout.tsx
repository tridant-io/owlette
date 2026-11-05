/**
 * title-only layout. `admin/sites/[siteId]/page.tsx` is a client component, and a
 * 'use client' module cannot export `metadata`, so the tab name lives here.
 */
import type { Metadata } from 'next';

export const metadata: Metadata = {
  title: 'admin · site settings',
};

export default function Layout({ children }: { children: React.ReactNode }) {
  return children;
}
