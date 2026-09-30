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
    expect(sendSpecialKey({ send, capture: { pressChord } }, key('sas'))).toBe(true);
    expect(send).toHaveBeenCalledWith('swoop-control', JSON.stringify({ t: 'sas' }));
    expect(pressChord).not.toHaveBeenCalled();
  });

  it('sends a chord through the input capture, so it takes its place in the sequence', () => {
    const send = jest.fn(() => true);
    const pressChord = jest.fn();
    expect(sendSpecialKey({ send, capture: { pressChord } }, key('alt-tab'))).toBe(true);
    expect(pressChord).toHaveBeenCalledWith(['AltLeft', 'Tab']);
    expect(send).not.toHaveBeenCalled();
  });

  it('reports a chord it cannot carry before the capture is attached', () => {
    const send = jest.fn(() => true);
    expect(sendSpecialKey({ send, capture: null }, key('win'))).toBe(false);
  });

  it.each(MACHINE_OS_FAMILIES)('every %s entry is either a chord of KeyboardEvent codes or the sas', (osFamily) => {
    const keys = specialKeysFor(osFamily);
    for (const entry of keys) {
      expect(Boolean(entry.sas) !== Boolean(entry.codes?.length)).toBe(true);
      for (const code of entry.codes ?? []) expect(code).toMatch(/^[A-Z][A-Za-z0-9]+$/);
    }
    expect(new Set(keys.map((k) => k.id)).size).toBe(keys.length);
  });

  it('offers ctrl+alt+del on windows alone, and linux the rest of the windows list', () => {
    expect(specialKeysFor('macos').some((k) => k.sas)).toBe(false);
    expect(specialKeysFor('linux')).toEqual(specialKeysFor('windows').filter((k) => !k.sas));
  });
});
