/**
 * Title-only layout for both halves of an owlette swoop sign-in (`/app-link`
 * and `/app-link/approve`). Both pages are client components, and a
 * 'use client' module cannot export `metadata` — so the tab name lives here.
 * Renders children unchanged; it exists purely for the title.
 */
import type { Metadata } from 'next';

export const metadata: Metadata = {
  title: 'swoop sign-in',
};

export default function Layout({ children }: { children: React.ReactNode }) {
  return children;
}
