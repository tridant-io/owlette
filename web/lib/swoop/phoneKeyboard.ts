/**
 * the phone keyboard's text, as a us keyboard's keys.
 *
 * a phone's keyboard types text, not keys: its keydowns carry no `code`, and
 * the word it is composing is rewritten as you go. so the field it types into
 * is read after each change, the change is worked out against what the field
 * held before, and it goes to the machine as backspaces and typed keys.
 *
 * a key is a us keyboard's. the machine's own layout decides what a key
 * types, as it does for a pc's keyboard, so on a us layout what you type is
 * what arrives. the protocol has no text message yet (the wave 6 seam in
 * `input.ts`), so a character a us keyboard has no key for is not sent.
 */

export interface TypedKey {
  code: string;
  shift: boolean;
}

/** each key's character without shift, then with it. */
const PUNCTUATION: ReadonlyArray<readonly [string, string, string]> = [
  ['Minus', '-', '_'],
  ['Equal', '=', '+'],
  ['BracketLeft', '[', '{'],
  ['BracketRight', ']', '}'],
  ['Backslash', '\\', '|'],
  ['Semicolon', ';', ':'],
  ['Quote', "'", '"'],
  ['Backquote', '`', '~'],
  ['Comma', ',', '<'],
  ['Period', '.', '>'],
  ['Slash', '/', '?'],
];

/** the digit row with shift, from 0 to 9. */
const SHIFTED_DIGITS = ')!@#$%^&*(';

const KEYS: ReadonlyMap<string, TypedKey> = (() => {
  const keys = new Map<string, TypedKey>();
  for (let i = 0; i < 26; i += 1) {
    const letter = String.fromCharCode(97 + i);
    const code = `Key${letter.toUpperCase()}`;
    keys.set(letter, { code, shift: false });
    keys.set(letter.toUpperCase(), { code, shift: true });
  }
  for (let digit = 0; digit < 10; digit += 1) {
    keys.set(String(digit), { code: `Digit${digit}`, shift: false });
    keys.set(SHIFTED_DIGITS[digit], { code: `Digit${digit}`, shift: true });
  }
  for (const [code, plain, shifted] of PUNCTUATION) {
    keys.set(plain, { code, shift: false });
    keys.set(shifted, { code, shift: true });
  }
  keys.set(' ', { code: 'Space', shift: false });
  keys.set('\n', { code: 'Enter', shift: false });
  keys.set('\t', { code: 'Tab', shift: false });
  return keys;
})();

/** what a phone's keyboard puts in place of plain punctuation as you type (ios's smart punctuation). */
const FOLDS: ReadonlyMap<string, string> = new Map([
  [String.fromCharCode(0x2018), "'"],
  [String.fromCharCode(0x2019), "'"],
  [String.fromCharCode(0x201c), '"'],
  [String.fromCharCode(0x201d), '"'],
  [String.fromCharCode(0x2013), '-'],
  [String.fromCharCode(0x2014), '-'],
  [String.fromCharCode(0x2026), '...'],
  [String.fromCharCode(0x00a0), ' '],
]);

/**
 * held in the field at all times, so a backspace always has something to
 * delete and arrives as a change: a phone fires no input event for a
 * backspace in an empty field. a zero-width space, which nothing displays.
 */
export const FIELD_SENTINEL = String.fromCharCode(0x200b);

/** the keys for typed text, and how many characters had none. */
export function keysFor(text: string): { keys: TypedKey[]; dropped: number } {
  const keys: TypedKey[] = [];
  let dropped = 0;
  for (const char of Array.from(text)) {
    const folded = FOLDS.get(char) ?? char;
    for (const plain of folded) {
      const key = KEYS.get(plain);
      if (key) keys.push(key);
      else dropped += 1;
    }
  }
  return { keys, dropped };
}

/**
 * what took the field from `before` to `after`: how much went off its end,
 * and what came after the part that stayed. a phone types and deletes at the
 * end of a field nobody can see, so the end is where every change is.
 */
export function textChange(before: string, after: string): { backspaces: number; typed: string } {
  const was = Array.from(before);
  const now = Array.from(after);
  let same = 0;
  while (same < was.length && same < now.length && was[same] === now[same]) same += 1;
  return { backspaces: was.length - same, typed: now.slice(same).join('') };
}
