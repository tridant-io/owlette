/**
 * Title-only layout: names the tab after the issue, so several open issues can
 * be told apart.
 */
import type { Metadata } from 'next';

export async function generateMetadata({ params }: { params: Promise<{ number: string }> }): Promise<Metadata> {
  const { number } = await params;
  return { title: /^\d+$/.test(number) ? `admin · issue #${number}` : 'admin · issue' };
}

export default function Layout({ children }: { children: React.ReactNode }) {
  return children;
}
