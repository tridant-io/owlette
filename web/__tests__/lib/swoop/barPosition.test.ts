import {
  BAR_POSITION_BOOT_SCRIPT,
  BAR_POSITION_SCRIPT,
  applyBarPosition,
  autoPosition,
  currentBarPosition,
  readBarChoice,
  setBarChoice,
  setPictureAspect,
  subscribeBarPosition,
} from '@/lib/swoop/barPosition';

const mark = () => document.documentElement.dataset.swoopBar;

const windowSize = (width: number, height: number) => {
  Object.defineProperty(window, 'innerWidth', { configurable: true, value: width });
  Object.defineProperty(window, 'innerHeight', { configurable: true, value: height });
};

describe('barPosition', () => {
  afterEach(() => {
    localStorage.clear();
    delete document.documentElement.dataset.swoopBar;
    jest.restoreAllMocks();
    windowSize(1024, 768);
  });

  it('marks <html> with a side and clears the mark for top, where the layout reads it', () => {
    setBarChoice('left');
    expect(mark()).toBe('left');
    setBarChoice('right');
    expect(mark()).toBe('right');
    setBarChoice('top');
    expect(mark()).toBeUndefined();
  });

  it('has the inline script mark a stored side before anything renders', () => {
    localStorage.setItem('owlette.swoop.barPosition', 'right');
    new Function(BAR_POSITION_SCRIPT)();
    expect(mark()).toBe('right');
  });

  it('has the inline script treat nothing stored, anything unknown and refused storage as auto', () => {
    // a 16:9 window, where auto puts the bar on the side
    windowSize(1600, 900);
    new Function(BAR_POSITION_SCRIPT)();
    expect(mark()).toBe('left');

    delete document.documentElement.dataset.swoopBar;
    localStorage.setItem('owlette.swoop.barPosition', 'bottom');
    new Function(BAR_POSITION_SCRIPT)();
    expect(mark()).toBe('left');

    delete document.documentElement.dataset.swoopBar;
    jest.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('blocked');
    });
    expect(() => new Function(BAR_POSITION_SCRIPT)()).not.toThrow();
    expect(mark()).toBe('left');
  });

  it('has the inline script keep a stored top on top, wherever auto would go', () => {
    windowSize(1600, 900);
    localStorage.setItem('owlette.swoop.barPosition', 'top');
    new Function(BAR_POSITION_SCRIPT)();
    expect(mark()).toBeUndefined();
  });

  it('is auto until a position is chosen, and keeps the one chosen, top included', () => {
    expect(readBarChoice()).toBe('auto');
    setBarChoice('left');
    expect(readBarChoice()).toBe('left');
    setBarChoice('top');
    expect(readBarChoice()).toBe('top');
    expect(localStorage.getItem('owlette.swoop.barPosition')).toBe('top');
    setBarChoice('auto');
    expect(readBarChoice()).toBe('auto');
    expect(localStorage.getItem('owlette.swoop.barPosition')).toBeNull();
  });

  it('reads anything it did not write as auto', () => {
    localStorage.setItem('owlette.swoop.barPosition', 'bottom');
    expect(readBarChoice()).toBe('auto');
  });

  it('reads storage that refuses as auto', () => {
    jest.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('blocked');
    });
    jest.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('blocked');
    });
    expect(() => setBarChoice('left')).not.toThrow();
    expect(readBarChoice()).toBe('auto');
  });

  it("tells this tab's subscribers, and another tab's change too", () => {
    const onChange = jest.fn();
    const unsubscribe = subscribeBarPosition(onChange);
    setBarChoice('left');
    expect(onChange).toHaveBeenCalledTimes(1);
    // another tab wrote right: this tab's mark follows before it re-renders
    localStorage.setItem('owlette.swoop.barPosition', 'right');
    window.dispatchEvent(new StorageEvent('storage', { key: 'owlette.swoop.barPosition' }));
    expect(onChange).toHaveBeenCalledTimes(2);
    expect(mark()).toBe('right');
    unsubscribe();
    setBarChoice('right');
    expect(onChange).toHaveBeenCalledTimes(2);
  });
});

describe('auto', () => {
  afterEach(() => {
    localStorage.clear();
    delete document.documentElement.dataset.swoopBar;
    setPictureAspect(16, 9);
  });

  it('takes the side whose picture is taller, and the top on a phone', () => {
    // a 16:9 window: the side letterbox is free, the top bar costs height
    expect(autoPosition(1600, 900)).toBe('left');
    // a 16:10 window: the top letterbox is free instead
    expect(autoPosition(1920, 1200)).toBe('top');
    expect(autoPosition(700, 400)).toBe('top');
    // a 4:3 picture is height-bound in a window a 16:9 one is not
    expect(autoPosition(1500, 1000)).toBe('top');
    expect(autoPosition(1500, 1000, 4 / 3)).toBe('left');
  });

  it('gets the same answer from the inline script as from the page, so first paint never jumps', () => {
    localStorage.setItem('owlette.swoop.barPosition', 'auto');
    for (const width of [640, 800, 1024, 1280, 1366, 1440, 1600, 1920, 2560, 3440]) {
      for (const height of [480, 600, 768, 800, 900, 1000, 1080, 1200, 1440]) {
        windowSize(width, height);
        delete document.documentElement.dataset.swoopBar;
        new Function(BAR_POSITION_SCRIPT)();
        expect([width, height, currentBarPosition()]).toEqual([width, height, autoPosition(width, height)]);
      }
    }
  });

  it('follows the window, and then the shape of the picture once it is known', () => {
    windowSize(1600, 900);
    setBarChoice('auto');
    expect(readBarChoice()).toBe('auto');
    expect(mark()).toBe('left');

    windowSize(1500, 1000);
    applyBarPosition();
    expect(mark()).toBeUndefined();

    setPictureAspect(1024, 768);
    expect(mark()).toBe('left');
  });
});

describe('the root layout boot script', () => {
  afterEach(() => {
    delete document.documentElement.dataset.swoopBar;
    window.history.replaceState({}, '', '/');
  });

  it('marks a session page like the inline script does', () => {
    window.history.replaceState({}, '', '/swoop/site-a/kiosk.lobby');
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: 1600 });
    Object.defineProperty(window, 'innerHeight', { configurable: true, value: 700 });
    new Function(BAR_POSITION_BOOT_SCRIPT)();
    expect(document.documentElement.dataset.swoopBar).toBe('left');
  });

  it('leaves every other page alone', () => {
    window.history.replaceState({}, '', '/dashboard');
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: 1600 });
    Object.defineProperty(window, 'innerHeight', { configurable: true, value: 700 });
    new Function(BAR_POSITION_BOOT_SCRIPT)();
    expect(document.documentElement.dataset.swoopBar).toBeUndefined();
  });
});
