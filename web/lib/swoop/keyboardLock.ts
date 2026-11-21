/**
 * the keyboard lock api, chromium-only (brave included: measured 2026-10-01 on
 * the owner's pc, where it exposes `navigator.keyboard.lock`): `navigator.keyboard`
 * is not in the dom lib, so this is the half swoop uses. shared by the toolbar,
 * which takes the lock with fullscreen, and the stage, which says how to leave.
 *
 * where owlette swoop captures the os shortcuts itself (`InputCapture.nativeKey`,
 * the ` (keys)` token) there is none to take. elsewhere in the app the webview's
 * lock is still asked for: what it does there is unmeasured, and asking costs nothing.
 */

import { viewerAppHasNativeKeys } from './viewerApp';

export interface KeyboardLock {
  lock(keyCodes?: string[]): Promise<void>;
  unlock(): void;
}

export const keyboardLock = (): KeyboardLock | null => {
  if (typeof navigator === 'undefined' || viewerAppHasNativeKeys()) return null;
  const api = (navigator as Navigator & { keyboard?: KeyboardLock }).keyboard;
  return typeof api?.lock === 'function' ? api : null;
};

export const hasKeyboardLock = (): boolean => keyboardLock() !== null;
