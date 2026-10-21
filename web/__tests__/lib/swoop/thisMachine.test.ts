import {
  clearThisMachine,
  isThisMachine,
  markThisMachine,
  subscribeThisMachine,
} from '@/lib/swoop/thisMachine';

describe('thisMachine', () => {
  afterEach(() => {
    localStorage.clear();
    jest.restoreAllMocks();
  });

  it('names one machine, by site and id', () => {
    expect(isThisMachine('site-A', 'm1')).toBe(false);
    markThisMachine('site-A', 'm1');
    expect(isThisMachine('site-A', 'm1')).toBe(true);
    expect(isThisMachine('site-B', 'm1')).toBe(false);
    expect(isThisMachine('site-A', 'm2')).toBe(false);
  });

  it('is cleared only for the machine it names', () => {
    markThisMachine('site-A', 'm1');
    clearThisMachine('site-A', 'm2');
    expect(isThisMachine('site-A', 'm1')).toBe(true);
    clearThisMachine('site-A', 'm1');
    expect(isThisMachine('site-A', 'm1')).toBe(false);
  });

  it('reads storage that refuses as no machine at all', () => {
    jest.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('blocked');
    });
    jest.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('blocked');
    });
    expect(() => markThisMachine('site-A', 'm1')).not.toThrow();
    expect(isThisMachine('site-A', 'm1')).toBe(false);
  });

  it('hears another tab mark it', () => {
    const onChange = jest.fn();
    const unsubscribe = subscribeThisMachine(onChange);
    window.dispatchEvent(new StorageEvent('storage', { key: 'owlette.swoop.thisMachine' }));
    expect(onChange).toHaveBeenCalledTimes(1);
    unsubscribe();
    window.dispatchEvent(new StorageEvent('storage', { key: 'owlette.swoop.thisMachine' }));
    expect(onChange).toHaveBeenCalledTimes(1);
  });
});
