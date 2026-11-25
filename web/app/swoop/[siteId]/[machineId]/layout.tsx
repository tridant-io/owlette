import type { Metadata } from 'next';
import { SwoopBarMark } from '@/components/swoop/SwoopBarMark';

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
 * the bar's position is this browser's, so the server renders it on top. on a
 * hard load the root layout's boot script marks the side before first paint;
 * on a client navigation into a session `SwoopBarMark` marks it in a layout
 * effect, before that commit paints. no <script> is rendered here: react
 * cannot run one it rebuilds on the client, and warns when asked to.
 */
export default function SwoopLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="fixed inset-0 overflow-hidden bg-background">
      <SwoopBarMark />
      {children}
    </div>
  );
}
