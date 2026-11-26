/**
 * `demo/page.tsx` is a client component, and a 'use client' module cannot
 * export `metadata` — so the tab name lives here, beside the provider that
 * hands the page's hooks their sample data.
 */
import type { Metadata } from 'next';
import { DemoProvider } from './DemoProvider';

export const metadata: Metadata = {
  title: 'demo',
};

export default function Layout({ children }: { children: React.ReactNode }) {
  return <DemoProvider>{children}</DemoProvider>;
}
