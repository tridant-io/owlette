/**
 * the keyboard lock the toolbar takes with fullscreen (dev/active/swoop-viewer,
 * task 3.3): the browser's where it has one, and none inside owlette swoop,
 * which captures the os shortcuts itself.
 */

import { hasKeyboardLock, keyboardLock } from '@/lib/swoop/keyboardLock';

const MAC_APP =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) owlette-swoop-viewer/4.1.8 (keys)';
const WINDOWS_APP =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36 Edg/141.0.0.0 owlette-swoop-viewer/4.1.8';

const api = { lock: jest.fn(() => Promise.resolve()), unlock: jest.fn() };
const withApi = () => Object.defineProperty(navigator, 'keyboard', { value: api, configurable: true });

afterEach(() => {
  jest.restoreAllMocks();
  Reflect.deleteProperty(navigator, 'keyboard');
});

describe('keyboardLock', () => {
  it("is the browser's lock where it has one, and none where it has not", () => {
    // jsdom has none, as firefox and safari
    expect(keyboardLock()).toBeNull();
    expect(hasKeyboardLock()).toBe(false);
    withApi();
    expect(keyboardLock()).toBe(api);
    expect(hasKeyboardLock()).toBe(true);
  });

  it('is none inside owlette swoop where the app captures keys itself (the (keys) token)', () => {
    withApi();
    jest.spyOn(navigator, 'userAgent', 'get').mockReturnValue(MAC_APP);
    expect(keyboardLock()).toBeNull();
    expect(hasKeyboardLock()).toBe(false);
  });

  it('is still asked for inside owlette swoop without native keys, as on windows for now', () => {
    withApi();
    jest.spyOn(navigator, 'userAgent', 'get').mockReturnValue(WINDOWS_APP);
    expect(keyboardLock()).toBe(api);
    expect(hasKeyboardLock()).toBe(true);
  });
});
