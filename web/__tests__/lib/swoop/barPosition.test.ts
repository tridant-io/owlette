import { readBarPosition, setBarPosition, subscribeBarPosition } from '@/lib/swoop/barPosition';

describe('barPosition', () => {
  afterEach(() => {
    localStorage.clear();
    jest.restoreAllMocks();
  });

  it('is on top until a side is chosen, and keeps the side', () => {
    expect(readBarPosition()).toBe('top');
    setBarPosition('left');
    expect(readBarPosition()).toBe('left');
    setBarPosition('right');
    expect(readBarPosition()).toBe('right');
    setBarPosition('top');
    expect(readBarPosition()).toBe('top');
    expect(localStorage.getItem('owlette.swoop.barPosition')).toBeNull();
  });

  it('reads anything it did not write as top', () => {
    localStorage.setItem('owlette.swoop.barPosition', 'bottom');
    expect(readBarPosition()).toBe('top');
  });

  it('reads storage that refuses as top', () => {
    jest.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('blocked');
    });
    jest.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('blocked');
    });
    expect(() => setBarPosition('left')).not.toThrow();
    expect(readBarPosition()).toBe('top');
  });

  it("tells this tab's subscribers, and another tab's change too", () => {
    const onChange = jest.fn();
    const unsubscribe = subscribeBarPosition(onChange);
    setBarPosition('left');
    expect(onChange).toHaveBeenCalledTimes(1);
    window.dispatchEvent(new StorageEvent('storage', { key: 'owlette.swoop.barPosition' }));
    expect(onChange).toHaveBeenCalledTimes(2);
    unsubscribe();
    setBarPosition('right');
    expect(onChange).toHaveBeenCalledTimes(2);
  });
});
