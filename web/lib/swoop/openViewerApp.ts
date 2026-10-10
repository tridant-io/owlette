/**
 * open a machine in owlette swoop from a browser, signed in as the browser is.
 *
 * the browser mints a one-time app-link code for its own session and hands it
 * to the app in the owlette-swoop:// link, so the app never shows a login form.
 * whether the app is installed cannot be asked: the os takes the link and the
 * page hears nothing back. the app taking focus is the only sign, so a page
 * still visible and focused a moment later had no app to hand the link to.
 */

import { mintAppLink } from '@/lib/appLink';
import { toast } from '@/lib/toast';
import { viewerAppLink } from '@/lib/swoop/viewerApp';

const MISSING_AFTER_MS = 1500;

/** a code the app exchanges once, within 60 s, for this browser's session. */
const mintCode = async (): Promise<string> => (await mintAppLink()).code;

interface OpenViewerAppOptions {
  mint?: () => Promise<string>;
  /** nothing took the link: the page kept its focus */
  onMissing?: () => void;
  navigate?: (link: string) => void;
}

const goTo = (link: string) => {
  window.location.href = link;
};

/** nothing on this computer took the link: say so, and point at the download. */
function offerViewerApp(): void {
  toast.info("the owlette swoop desktop app isn't installed on this computer", {
    action: {
      label: 'get it',
      onClick: () => window.open('/download/swoop-viewer', '_blank', 'noopener'),
    },
  });
}

/** resolves once the link is handed over; a mint failure rejects and opens nothing. */
export async function openViewerApp(
  siteId: string,
  machineId: string,
  { mint = mintCode, onMissing = offerViewerApp, navigate = goTo }: OpenViewerAppOptions = {},
): Promise<void> {
  const link = viewerAppLink(siteId, machineId, { code: await mint() });

  const stop = () => {
    clearTimeout(timer);
    window.removeEventListener('blur', stop);
    document.removeEventListener('visibilitychange', stop);
  };
  const timer = setTimeout(() => {
    stop();
    if (document.visibilityState === 'visible' && document.hasFocus()) onMissing();
  }, MISSING_AFTER_MS);
  window.addEventListener('blur', stop);
  document.addEventListener('visibilitychange', stop);
  navigate(link);
}

/** `openViewerApp` for a click: a link that could not be made is said in a toast. */
export function openInViewerApp(siteId: string, machineId: string): void {
  openViewerApp(siteId, machineId).catch((err: unknown) => {
    toast.error('could not open the owlette swoop desktop app', {
      description: err instanceof Error ? err.message : undefined,
    });
  });
}
