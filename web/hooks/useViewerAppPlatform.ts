'use client';

import { useSyncExternalStore } from 'react';
import { viewerAppPlatform, type ViewerAppPlatform } from '@/lib/swoop/viewerApp';

const noSubscribe = () => () => {};

/** the desktop owlette swoop runs on; null in a browser and on the server. */
export function useViewerAppPlatform(): ViewerAppPlatform | null {
  return useSyncExternalStore(noSubscribe, () => viewerAppPlatform(), () => null);
}
