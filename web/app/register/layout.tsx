/**
 * Title-only layout. `register/page.tsx` is a client component, and a
 * 'use client' module cannot export `metadata` — so the tab name lives here.
 * Renders children unchanged; it exists purely for the title.
 */
import type { Metadata } from 'next';

export const metadata: Metadata = {
  title: 'create account',
};

export default function Layout({ children }: { children: React.ReactNode }) {
  return children;
}
