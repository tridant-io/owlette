import {
  readSize,
  readSmooth,
  setSize,
  setSmooth,
  smoothByDefault,
  subscribeView,
} from '@/lib/swoop/viewStore';

const CHROME = {
  brands: [
    { brand: 'Chromium', version: '130' },
    { brand: 'Google Chrome', version: '130' },
    { brand: 'Not?A_Brand', version: '99' },
  ],
  mobile: false,
};
const EDGE = {
  brands: [
    { brand: 'Microsoft Edge', version: '130' },
    { brand: 'Chromium', version: '130' },
  ],
  mobile: false,
};
const ANDROID_CHROME = { ...CHROME, mobile: true };

// jsdom's navigator has no client hints, like safari and firefox
const engine = (hints: typeof CHROME | undefined) => {
  Object.defineProperty(navigator, 'userAgentData', { configurable: true, value: hints });
};

const refuseStorage = () => {
  for (const method of ['getItem', 'setItem', 'removeItem'] as const) {
    jest.spyOn(Storage.prototype, method).mockImplementation(() => {
      throw new Error('blocked');
    });
  }
};

describe('viewStore', () => {
  afterEach(() => {
    jest.restoreAllMocks();
    localStorage.clear();
    delete (navigator as { userAgentData?: unknown }).userAgentData;
  });

  describe('size', () => {
    it('is fit until sharp is chosen, and stores only sharp', () => {
      expect(readSize()).toBe('fit');
      setSize('sharp');
      expect(readSize()).toBe('sharp');
      expect(localStorage.getItem('owlette.swoop.size')).toBe('sharp');
      setSize('fit');
      expect(readSize()).toBe('fit');
      expect(localStorage.getItem('owlette.swoop.size')).toBeNull();
    });

    it('reads anything it did not write as fit', () => {
      localStorage.setItem('owlette.swoop.size', 'cover');
      expect(readSize()).toBe('fit');
    });
  });

  describe('smooth scaling by default', () => {
    it('is on in a chromium desktop engine: chrome, edge and owlette swoop on windows', () => {
      expect(smoothByDefault({ userAgentData: CHROME })).toBe(true);
      expect(smoothByDefault({ userAgentData: EDGE })).toBe(true);
    });

    it('is off without client hints: safari, firefox and every webkit viewer', () => {
      expect(smoothByDefault({})).toBe(false);
    });

    it('is off on a phone, chromium or not', () => {
      expect(smoothByDefault({ userAgentData: ANDROID_CHROME })).toBe(false);
    });

    it('is off for client hints that name no chromium brand', () => {
      expect(smoothByDefault({ userAgentData: { brands: [{ brand: 'Not?A_Brand' }], mobile: false } })).toBe(false);
    });

    it('reads this browser when given no navigator, and is off where there is none', () => {
      engine(CHROME);
      expect(smoothByDefault()).toBe(true);
      engine(undefined);
      expect(smoothByDefault()).toBe(false);
      engine(CHROME);
      jest.spyOn(window, 'navigator', 'get').mockReturnValue(undefined as unknown as Navigator);
      expect(smoothByDefault()).toBe(false);
    });
  });

  describe('smooth scaling', () => {
    it("follows the engine's default until this viewer chooses", () => {
      engine(CHROME);
      expect(readSmooth()).toBe(true);
      engine(ANDROID_CHROME);
      expect(readSmooth()).toBe(false);
      expect(localStorage.getItem('owlette.swoop.smooth')).toBeNull();
    });

    it('keeps a choice of off where the default is on', () => {
      engine(CHROME);
      setSmooth(false);
      expect(readSmooth()).toBe(false);
      expect(localStorage.getItem('owlette.swoop.smooth')).toBe('off');
    });

    it('keeps a choice of on where the default is off', () => {
      setSmooth(true);
      expect(readSmooth()).toBe(true);
      expect(localStorage.getItem('owlette.swoop.smooth')).toBe('on');
    });

    it("reads anything it did not write as the engine's default", () => {
      engine(CHROME);
      localStorage.setItem('owlette.swoop.smooth', 'true');
      expect(readSmooth()).toBe(true);
    });
  });

  it('reads storage that refuses as the defaults, and never throws on a choice', () => {
    engine(CHROME);
    refuseStorage();
    expect(() => setSize('sharp')).not.toThrow();
    expect(() => setSmooth(false)).not.toThrow();
    expect(readSize()).toBe('fit');
    expect(readSmooth()).toBe(true);
    engine(undefined);
    expect(readSmooth()).toBe(false);
  });

  it("tells this tab's subscribers, and another tab's change too", () => {
    const onChange = jest.fn();
    const unsubscribe = subscribeView(onChange);
    setSize('sharp');
    setSmooth(true);
    expect(onChange).toHaveBeenCalledTimes(2);
    // another tab chose off: this tab reads it when the event arrives
    localStorage.setItem('owlette.swoop.smooth', 'off');
    window.dispatchEvent(new StorageEvent('storage', { key: 'owlette.swoop.smooth' }));
    expect(onChange).toHaveBeenCalledTimes(3);
    expect(readSmooth()).toBe(false);
    unsubscribe();
    setSize('fit');
    window.dispatchEvent(new StorageEvent('storage', { key: 'owlette.swoop.size' }));
    expect(onChange).toHaveBeenCalledTimes(3);
  });
});
