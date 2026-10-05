import { BAR_POSITION_SCRIPT, readBarPosition, setBarPosition, subscribeBarPosition } from '@/lib/swoop/barPosition';

const mark = () => document.documentElement.dataset.swoopBar;

describe('barPosition', () => {
  afterEach(() => {
    localStorage.clear();
    delete document.documentElement.dataset.swoopBar;
    jest.restoreAllMocks();
  });

  it('marks <html> with a side and clears the mark for top, where the layout reads it', () => {
    setBarPosition('left');
    expect(mark()).toBe('left');
    setBarPosition('right');
    expect(mark()).toBe('right');
    setBarPosition('top');
    expect(mark()).toBeUndefined();
  });

  it('has the inline script mark a stored side before anything renders', () => {
    localStorage.setItem('owlette.swoop.barPosition', 'right');
    new Function(BAR_POSITION_SCRIPT)();
    expect(mark()).toBe('right');
  });

  it('has the inline script leave anything else on top, and survive refused storage', () => {
    localStorage.setItem('owlette.swoop.barPosition', 'bottom');
    new Function(BAR_POSITION_SCRIPT)();
    expect(mark()).toBeUndefined();
    jest.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('blocked');
    });
    expect(() => new Function(BAR_POSITION_SCRIPT)()).not.toThrow();
    expect(mark()).toBeUndefined();
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
    // another tab wrote right: this tab's mark follows before it re-renders
    localStorage.setItem('owlette.swoop.barPosition', 'right');
    window.dispatchEvent(new StorageEvent('storage', { key: 'owlette.swoop.barPosition' }));
    expect(onChange).toHaveBeenCalledTimes(2);
    expect(mark()).toBe('right');
    unsubscribe();
    setBarPosition('right');
    expect(onChange).toHaveBeenCalledTimes(2);
  });
});
