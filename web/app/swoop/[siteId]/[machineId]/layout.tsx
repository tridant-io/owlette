import type { Metadata } from 'next';
import { headers } from 'next/headers';
import { BAR_POSITION_SCRIPT } from '@/lib/swoop/barPosition';

/**
 * the swoop shell: the whole window, and nothing else in it.
 *
 * a remote session needs every pixel and must not scroll, so this layout pins
 * a fixed full-window box over the app. the site footer is NOT removed here —
 * the root layout renders it as a sibling, so a nested layout cannot reach it;
 * `components/Footer.tsx` early-returns on `/swoop` instead.
 */

/**
 * the tab is named after the machine, with no brand in front of it: a session
 * per machine is told apart by its tab, so `absolute` keeps the root template
 * from putting "owlette - " on every one.
 */
export async function generateMetadata({
  params,
}: {
  params: Promise<{ machineId: string }>;
}): Promise<Metadata> {
  const { machineId } = await params;
  return { title: { absolute: `swoop - ${machineId}` } };
}

/**
 * the bar's position is this browser's, so the server renders it on top; the
 * script ahead of the page marks the side before anything is painted, and the
 * page's layout follows the mark rather than waiting for hydration. nonced, as
 * the CSP requires of every inline script.
 */
export default async function SwoopLayout({ children }: { children: React.ReactNode }) {
  const nonce = (await headers()).get('x-nonce') ?? undefined;
  return (
    <div className="fixed inset-0 overflow-hidden bg-background">
      {/* suppressHydrationWarning: the browser blanks the nonce attribute once
          the script is inserted, so hydration reads "" against the real one */}
      <script nonce={nonce} suppressHydrationWarning dangerouslySetInnerHTML={{ __html: BAR_POSITION_SCRIPT }} />
      {children}
    </div>
  );
}
