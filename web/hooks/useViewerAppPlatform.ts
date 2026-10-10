'use client';

import { useSyncExternalStore } from 'react';
import { useViewerAppContext } from '@/contexts/ViewerAppContext';
import { viewerAppHasNativeKeys, viewerAppPlatform, type ViewerAppPlatform } from '@/lib/swoop/viewerApp';

const noSubscribe = () => () => {};

// inside the root layout's provider the answer is the request's, the same on the
// server and in hydration, so the first paint is already right. outside it (a
// bare test render) navigator decides, after hydration.

/** the desktop owlette swoop runs on; null in a browser. */
export function useViewerAppPlatform(): ViewerAppPlatform | null {
  const app = useViewerAppContext();
  return useSyncExternalStore(
    noSubscribe,
    () => (app ? app.platform : viewerAppPlatform()),
    () => (app ? app.platform : null),
  );
}

/** owlette swoop hands the page the os shortcuts its webview never sees. */
export function useViewerAppNativeKeys(): boolean {
  const app = useViewerAppContext();
  return useSyncExternalStore(
    noSubscribe,
    () => (app ? app.nativeKeys : viewerAppHasNativeKeys()),
    () => (app ? app.nativeKeys : false),
  );
}
