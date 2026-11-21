import { readMouseCapture, setMouseCapture, subscribeMouseCapture } from '@/lib/swoop/mouseCapture';

describe('mouseCapture', () => {
  afterEach(() => {
    localStorage.clear();
    jest.restoreAllMocks();
  });

  it('is off until this browser turns it on, and off again when it is turned off', () => {
    expect(readMouseCapture()).toBe(false);
    setMouseCapture(true);
    expect(readMouseCapture()).toBe(true);
    setMouseCapture(false);
    expect(readMouseCapture()).toBe(false);
    expect(localStorage.getItem('owlette.swoop.mouseCapture')).toBeNull();
  });

  it('reads storage that refuses as off, and setting it there throws nothing', () => {
    jest.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('blocked');
    });
    jest.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('blocked');
    });
    expect(() => setMouseCapture(true)).not.toThrow();
    expect(readMouseCapture()).toBe(false);
  });

  it("tells subscribers of this tab's changes and of another tab's, until they unsubscribe", () => {
    const listener = jest.fn();
    const unsubscribe = subscribeMouseCapture(listener);
    setMouseCapture(true);
    expect(listener).toHaveBeenCalledTimes(1);
    window.dispatchEvent(new StorageEvent('storage', { key: 'owlette.swoop.mouseCapture' }));
    expect(listener).toHaveBeenCalledTimes(2);
    unsubscribe();
    setMouseCapture(false);
    window.dispatchEvent(new StorageEvent('storage', { key: 'owlette.swoop.mouseCapture' }));
    expect(listener).toHaveBeenCalledTimes(2);
  });
});
