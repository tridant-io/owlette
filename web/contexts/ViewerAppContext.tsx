'use client';

import { createContext, useContext, useMemo, type ReactNode } from 'react';
import type { ViewerAppPlatform } from '@/lib/swoop/viewerApp';

/** owlette swoop as the request's user agent told the server, so its first render is the app's. */
export interface ViewerApp {
  platform: ViewerAppPlatform | null;
  nativeKeys: boolean;
}

// null outside the provider: the hooks then read navigator after hydration
const ViewerAppContext = createContext<ViewerApp | null>(null);

export function ViewerAppProvider({ platform, nativeKeys, children }: ViewerApp & { children: ReactNode }) {
  const value = useMemo(() => ({ platform, nativeKeys }), [platform, nativeKeys]);
  return <ViewerAppContext.Provider value={value}>{children}</ViewerAppContext.Provider>;
}

export function useViewerAppContext(): ViewerApp | null {
  return useContext(ViewerAppContext);
}
