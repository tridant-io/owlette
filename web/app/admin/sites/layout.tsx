/**
 * title-only layout. `admin/sites/page.tsx` is a client component, and a
 * 'use client' module cannot export `metadata`, so the tab name lives here.
 */
import type { Metadata } from 'next';

export const metadata: Metadata = {
  title: 'admin · sites',
};

export default function Layout({ children }: { children: React.ReactNode }) {
  return children;
}
