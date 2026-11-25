import { MACHINE_OS_FAMILIES } from '@/lib/machineOs';
import { sendSpecialKey, specialKeysFor } from '@/lib/swoop/specialKeys';

describe('sendSpecialKey', () => {
  const key = (id: string) => {
    const found = specialKeysFor('windows').find((k) => k.id === id);
    if (!found) throw new Error(`no special key ${id}`);
    return found;
  };

  it('sends ctrl+alt+del as the sas control message, never as a chord', () => {
    const send = jest.fn(() => true);
    const pressChord = jest.fn();
    expect(sendSpecialKey({ send, capture: { pressChord, holdNextKey: jest.fn() } }, key('sas'))).toBe(true);
    expect(send).toHaveBeenCalledWith('swoop-control', JSON.stringify({ t: 'sas' }));
    expect(pressChord).not.toHaveBeenCalled();
  });

  it('sends a chord through the input capture, so it takes its place in the sequence', () => {
    const send = jest.fn(() => true);
    const pressChord = jest.fn();
    expect(sendSpecialKey({ send, capture: { pressChord, holdNextKey: jest.fn() } }, key('alt-tab'))).toBe(true);
    expect(pressChord).toHaveBeenCalledWith(['AltLeft', 'Tab']);
    expect(send).not.toHaveBeenCalled();
  });

  it('arms the super key through the capture, and withholds the item in fullscreen', () => {
    const send = jest.fn(() => true);
    const holdNextKey = jest.fn();
    const pressChord = jest.fn();
    expect(sendSpecialKey({ send, capture: { pressChord, holdNextKey } }, key('hold-win'))).toBe(true);
    expect(holdNextKey).toHaveBeenCalledWith('MetaLeft');
    expect(pressChord).not.toHaveBeenCalled();
    expect(send).not.toHaveBeenCalled();
    expect(sendSpecialKey({ send, capture: null }, key('hold-win'))).toBe(false);

    expect(specialKeysFor('macos').find((k) => k.id === 'hold-cmd')?.hold).toBe('MetaLeft');
    for (const host of ['windows', 'macos', 'linux'] as const) {
      expect(specialKeysFor(host, true).some((k) => k.hold)).toBe(false);
    }
  });

  it('reports a chord it cannot carry before the capture is attached', () => {
    const send = jest.fn(() => true);
    expect(sendSpecialKey({ send, capture: null }, key('win'))).toBe(false);
  });

  it.each(MACHINE_OS_FAMILIES)('every %s entry is a chord of KeyboardEvent codes, the sas, or one held key', (osFamily) => {
    const keys = specialKeysFor(osFamily);
    for (const entry of keys) {
      expect([entry.sas, entry.codes?.length, entry.hold].filter(Boolean)).toHaveLength(1);
      for (const code of [...(entry.codes ?? []), ...(entry.hold ? [entry.hold] : [])]) {
        expect(code).toMatch(/^[A-Z][A-Za-z0-9]+$/);
      }
    }
    expect(new Set(keys.map((k) => k.id)).size).toBe(keys.length);
  });

  it('offers ctrl+alt+del on windows alone, and linux the rest of the windows list', () => {
    expect(specialKeysFor('macos').some((k) => k.sas)).toBe(false);
    expect(specialKeysFor('linux')).toEqual(specialKeysFor('windows').filter((k) => !k.sas));
  });
});

describe('specialKeysFor inside owlette swoop', () => {
  const MAC = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko)';
  const WINDOWS = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0';
  const MAC_KEYS_APP = `${MAC} owlette-swoop-viewer/4.1.8 (keys)`;
  const as = (ua: string) => jest.spyOn(navigator, 'userAgent', 'get').mockReturnValue(ua);
  const ids = (hostOs: 'windows' | 'macos' | 'linux', fullscreen = false) =>
    specialKeysFor(hostOs, fullscreen).map((k) => k.id);

  afterEach(() => jest.restoreAllMocks());

  it('drops cmd+q in fullscreen, which the mac app hands the machine itself; cmd+tab stays', () => {
    as(MAC_KEYS_APP);
    expect(ids('macos', true)).toEqual(['cmd-tab', 'cmd-space', 'cmd-ctrl-q', 'esc']);
    // outside fullscreen the app captures nothing, and cmd+q would quit it
    expect(ids('macos')).toContain('cmd-q');
  });

  it("changes nothing without the app's native keys", () => {
    for (const ua of [MAC, `${MAC} owlette-swoop-viewer/4.1.8`, `${WINDOWS} owlette-swoop-viewer/4.1.8`]) {
      as(ua);
      expect(ids('macos', true)).toContain('cmd-q');
    }
  });

  it("leaves a windows or linux machine's list alone, from a mac and (until it captures keys) from windows", () => {
    as(WINDOWS);
    const browser = { windows: ids('windows', true), linux: ids('linux', true) };
    for (const ua of [MAC_KEYS_APP, `${WINDOWS} owlette-swoop-viewer/4.1.8 (keys)`]) {
      as(ua);
      expect(ids('windows', true)).toEqual(browser.windows);
      expect(ids('linux', true)).toEqual(browser.linux);
    }
  });
});
