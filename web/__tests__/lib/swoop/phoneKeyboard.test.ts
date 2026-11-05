/**
 * the phone keyboard's text as a us keyboard's keys (`lib/swoop/phoneKeyboard.ts`):
 * the table, the folded smart punctuation, and the change worked out from a
 * field's text before and after.
 */

import { FIELD_SENTINEL, keysFor, textChange } from '@/lib/swoop/phoneKeyboard';

const typed = (text: string) => keysFor(text).keys.map(({ code, shift }) => (shift ? `shift+${code}` : code));

describe('keysFor', () => {
  it('types letters, capitals, digits and the shifted digit row', () => {
    expect(typed('aZ9!')).toEqual(['KeyA', 'shift+KeyZ', 'Digit9', 'shift+Digit1']);
  });

  it('types each punctuation key, with and without shift', () => {
    expect(typed('-_=+[{]}\\|;:\'"`~,<.>/?')).toEqual([
      'Minus', 'shift+Minus', 'Equal', 'shift+Equal', 'BracketLeft', 'shift+BracketLeft',
      'BracketRight', 'shift+BracketRight', 'Backslash', 'shift+Backslash', 'Semicolon',
      'shift+Semicolon', 'Quote', 'shift+Quote', 'Backquote', 'shift+Backquote', 'Comma',
      'shift+Comma', 'Period', 'shift+Period', 'Slash', 'shift+Slash',
    ]);
  });

  it('types space, a new line as enter, and tab', () => {
    expect(typed(' \n\t')).toEqual(['Space', 'Enter', 'Tab']);
  });

  it('folds smart quotes, dashes and the ellipsis into the ascii they stand for', () => {
    const smart = [0x2019, 0x201c, 0x2014, 0x2026].map((code) => String.fromCharCode(code)).join('');
    expect(typed(smart)).toEqual(['Quote', 'shift+Quote', 'Minus', 'Period', 'Period', 'Period']);
  });

  it('drops what a us keyboard has no key for, and counts it', () => {
    const accented = String.fromCharCode(0x00e9);
    const emoji = String.fromCodePoint(0x1f989);
    expect(keysFor(`a${accented}${emoji}b`)).toEqual({
      keys: [
        { code: 'KeyA', shift: false },
        { code: 'KeyB', shift: false },
      ],
      dropped: 2,
    });
  });
});

describe('textChange', () => {
  it('is the typed tail when text is added', () => {
    expect(textChange(`${FIELD_SENTINEL}hel`, `${FIELD_SENTINEL}help`)).toEqual({ backspaces: 0, typed: 'p' });
  });

  it('is backspaces when text goes, the sentinel included', () => {
    expect(textChange(`${FIELD_SENTINEL}ab`, `${FIELD_SENTINEL}a`)).toEqual({ backspaces: 1, typed: '' });
    expect(textChange(FIELD_SENTINEL, '')).toEqual({ backspaces: 1, typed: '' });
  });

  it('rewrites an autocorrected word as backspaces then the new text', () => {
    expect(textChange(`${FIELD_SENTINEL}teh`, `${FIELD_SENTINEL}the `)).toEqual({ backspaces: 2, typed: 'he ' });
  });

  it('counts an emoji as one character, not two', () => {
    const emoji = String.fromCodePoint(0x1f989);
    expect(textChange(`a${emoji}`, 'a')).toEqual({ backspaces: 1, typed: '' });
  });
});
