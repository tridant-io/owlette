/**
 * the keyboard lock api, chromium-only and switched off in brave: `navigator.keyboard`
 * is not in the dom lib, so this is the half swoop uses. shared by the toolbar,
 * which takes the lock with fullscreen, and the stage, which says how to leave.
 */

export interface KeyboardLock {
  lock(keyCodes?: string[]): Promise<void>;
  unlock(): void;
}

export const keyboardLock = (): KeyboardLock | null => {
  if (typeof navigator === 'undefined') return null;
  const api = (navigator as Navigator & { keyboard?: KeyboardLock }).keyboard;
  return typeof api?.lock === 'function' ? api : null;
};

export const hasKeyboardLock = (): boolean => keyboardLock() !== null;
