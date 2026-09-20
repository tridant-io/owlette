import type { Metadata } from 'next';

/**
 * the swoop shell: the whole window, and nothing else in it.
 *
 * a remote session needs every pixel and must not scroll, so this layout pins
 * a fixed full-window box over the app. the site footer is NOT removed here —
 * the root layout renders it as a sibling, so a nested layout cannot reach it;
 * `components/Footer.tsx` early-returns on `/swoop` instead.
 */

export const metadata: Metadata = {
  title: 'swoop',
};

export default function SwoopLayout({ children }: { children: React.ReactNode }) {
  return <div className="fixed inset-0 overflow-hidden bg-background">{children}</div>;
}
