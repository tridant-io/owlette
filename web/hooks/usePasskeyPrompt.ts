'use client';

import { useSyncExternalStore } from 'react';
import { browserSupportsWebAuthn } from '@simplewebauthn/browser';
import { useInAppBrowser } from '@/hooks/useInAppBrowser';
import { useViewerAppPlatform } from '@/hooks/useViewerAppPlatform';

// the environment cannot change within a document, so there is nothing to subscribe to
const noSubscribe = () => () => {};
const getSupport = () => browserSupportsWebAuthn();
const getServerSupport = () => null;

/**
 * whether this page can run a passkey prompt: false in an embedded webview, whose ceremony only
 * reaches the HOST app's passkeys, and in owlette swoop (ADR 0012), though both report WebAuthn
 * support; otherwise whether the browser speaks WebAuthn at all.
 *
 * null until the client has checked. `browserSupportsWebAuthn()` reads `window.PublicKeyCredential`,
 * so answering it during render would make the server and hydrating renders disagree, and React's
 * recovery from that mismatch discards the SSR tree, which has swallowed clicks on these auth pages
 * before. useSyncExternalStore's server snapshot is a real value instead, with no cascading render.
 */
export function usePasskeyPrompt(): boolean | null {
  const supported = useSyncExternalStore(noSubscribe, getSupport, getServerSupport);
  const inApp = useInAppBrowser();
  const viewerApp = useViewerAppPlatform() !== null;
  if (inApp.isInApp || viewerApp) return false;
  return supported;
}
