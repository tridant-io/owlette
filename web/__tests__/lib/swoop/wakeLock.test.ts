/**
 * the screen wake lock feature: taken while the tab is visible, taken again
 * when the tab comes back, released on detach, and absent without the api.
 */

import { attach } from '@/lib/swoop/wakeLock';

import type { SwoopSession } from '@/lib/swoop/features';

interface FakeSentinel {
  release: jest.Mock<Promise<void>, []>;
  addEventListener: jest.Mock<void, [string, () => void]>;
  /** what the browser does when the tab is hidden. */
  releaseByBrowser: () => void;
}

function fakeWakeLock() {
  const sentinels: FakeSentinel[] = [];
  const request = jest.fn(async (_type: 'screen') => {
    let onRelease: (() => void) | null = null;
    const sentinel: FakeSentinel = {
      release: jest.fn(async () => {
        onRelease?.();
      }),
      addEventListener: jest.fn((_name: string, handler: () => void) => {
        onRelease = handler;
      }),
      releaseByBrowser: () => onRelease?.(),
    };
    sentinels.push(sentinel);
    return sentinel as unknown as WakeLockSentinel;
  });
  Object.defineProperty(navigator, 'wakeLock', { configurable: true, value: { request } });
  return { request, sentinels };
}

function setVisibility(state: DocumentVisibilityState) {
  Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => state });
  document.dispatchEvent(new Event('visibilitychange'));
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));
const session = {} as SwoopSession;

afterEach(() => {
  Object.defineProperty(navigator, 'wakeLock', { configurable: true, value: undefined });
  Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'visible' });
});

describe('swoop wake lock', () => {
  it('takes the screen lock on attach and releases it on detach', async () => {
    const lock = fakeWakeLock();
    setVisibility('visible');
    const detach = attach(session);
    await flush();
    expect(lock.request).toHaveBeenCalledWith('screen');
    detach();
    expect(lock.sentinels[0].release).toHaveBeenCalledTimes(1);
  });

  it('takes it again when the tab comes back after the browser let it go', async () => {
    const lock = fakeWakeLock();
    setVisibility('visible');
    const detach = attach(session);
    await flush();
    expect(lock.request).toHaveBeenCalledTimes(1);
    // hidden: the browser releases it and a request would be refused anyway.
    lock.sentinels[0].releaseByBrowser();
    setVisibility('hidden');
    await flush();
    expect(lock.request).toHaveBeenCalledTimes(1);
    setVisibility('visible');
    await flush();
    expect(lock.request).toHaveBeenCalledTimes(2);
    detach();
  });

  it('holds one lock at a time', async () => {
    const lock = fakeWakeLock();
    setVisibility('visible');
    const detach = attach(session);
    await flush();
    setVisibility('visible');
    await flush();
    expect(lock.request).toHaveBeenCalledTimes(1);
    detach();
  });

  it('is a no-op without the api', () => {
    Object.defineProperty(navigator, 'wakeLock', { configurable: true, value: undefined });
    expect(() => attach(session)()).not.toThrow();
  });

  it('survives a refusal', async () => {
    const request = jest.fn(async () => {
      throw new DOMException('denied', 'NotAllowedError');
    });
    Object.defineProperty(navigator, 'wakeLock', { configurable: true, value: { request } });
    setVisibility('visible');
    const detach = attach(session);
    await flush();
    expect(request).toHaveBeenCalledTimes(1);
    expect(() => detach()).not.toThrow();
  });
});
