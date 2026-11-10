/**
 * Title-only layout. `swoop/page.tsx` is a client component, and a
 * 'use client' module cannot export `metadata` — so the tab name lives here.
 * Renders children unchanged; it exists purely for the title. A session
 * names its own tab after the machine (`[siteId]/[machineId]/layout.tsx`).
 */
import type { Metadata } from 'next';

export const metadata: Metadata = {
  title: 'swoop',
};

export default function Layout({ children }: { children: React.ReactNode }) {
  return children;
}
