/**
 * swoop keymap — `KeyboardEvent.code` → ps/2 set-1 scancode + extended flag.
 *
 * the table below is a transcription of `agent/swoop/testdata/keymap.json`,
 * which is the single source of truth for both ends (the rust injector in
 * `agent/swoop` reads the same file). it is inlined rather than imported
 * because the json lives outside `web/`, and the bundle must not reach there.
 * `__tests__/lib/swoop/keymap.test.ts` reads the json and fails if this file
 * drifts from it by even one entry — that test is the only thing keeping the
 * copy honest, so do not weaken it.
 *
 * we key on `code` — the physical key — and never on `key`, which is layout-
 * and IME-dependent. the numpad and the control/arrow pad share scancode low
 * bytes and are told apart only by `extended`; left and right modifiers stay
 * distinct on the wire (PROTOCOL.md §5).
 */

/** scancodes by code, for every code the host can inject directly. */
const SCANCODES: Readonly<Record<string, number>> = Object.freeze({
  AltLeft: 56, AltRight: 56, ArrowDown: 80, ArrowLeft: 75, ArrowRight: 77, ArrowUp: 72,
  AudioVolumeDown: 46, AudioVolumeMute: 32, AudioVolumeUp: 48, Backquote: 41, Backslash: 43,
  Backspace: 14, BracketLeft: 26, BracketRight: 27, BrowserBack: 106, BrowserFavorites: 102,
  BrowserForward: 105, BrowserHome: 50, BrowserRefresh: 103, BrowserSearch: 101,
  BrowserStop: 104, CapsLock: 58, Comma: 51, ContextMenu: 93, ControlLeft: 29,
  ControlRight: 29, Convert: 121, Delete: 83, Digit0: 11, Digit1: 2, Digit2: 3, Digit3: 4,
  Digit4: 5, Digit5: 6, Digit6: 7, Digit7: 8, Digit8: 9, Digit9: 10, Eject: 44, End: 79,
  Enter: 28, Equal: 13, Escape: 1, F1: 59, F10: 68, F11: 87, F12: 88, F13: 100, F14: 101,
  F15: 102, F16: 103, F17: 104, F18: 105, F19: 106, F2: 60, F20: 107, F21: 108, F22: 109,
  F23: 110, F24: 118, F3: 61, F4: 62, F5: 63, F6: 64, F7: 65, F8: 66, F9: 67, Home: 71,
  Insert: 82, IntlBackslash: 86, IntlRo: 115, IntlYen: 125, KanaMode: 112, KeyA: 30, KeyB: 48,
  KeyC: 46, KeyD: 32, KeyE: 18, KeyF: 33, KeyG: 34, KeyH: 35, KeyI: 23, KeyJ: 36, KeyK: 37,
  KeyL: 38, KeyM: 50, KeyN: 49, KeyO: 24, KeyP: 25, KeyQ: 16, KeyR: 19, KeyS: 31, KeyT: 20,
  KeyU: 22, KeyV: 47, KeyW: 17, KeyX: 45, KeyY: 21, KeyZ: 44, Lang1: 114, Lang2: 113,
  Lang3: 120, Lang4: 119, LaunchApp1: 107, LaunchApp2: 33, LaunchMail: 108, MediaPlayPause: 34,
  MediaSelect: 109, MediaStop: 36, MediaTrackNext: 25, MediaTrackPrevious: 16, MetaLeft: 91,
  MetaRight: 92, Minus: 12, NonConvert: 123, NumLock: 69, Numpad0: 82, Numpad1: 79,
  Numpad2: 80, Numpad3: 81, Numpad4: 75, Numpad5: 76, Numpad6: 77, Numpad7: 71, Numpad8: 72,
  Numpad9: 73, NumpadAdd: 78, NumpadComma: 126, NumpadDecimal: 83, NumpadDivide: 53,
  NumpadEnter: 28, NumpadEqual: 89, NumpadMultiply: 55, NumpadSubtract: 74, PageDown: 81,
  PageUp: 73, Period: 52, Power: 94, Quote: 40, ScrollLock: 70, Semicolon: 39, ShiftLeft: 42,
  ShiftRight: 54, Slash: 53, Sleep: 95, Space: 57, Tab: 15, WakeUp: 99,
});

/** codes carrying the 0xE0 prefix. every one of them also has a scancode. */
const EXTENDED: readonly string[] = [
  'AltRight', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'ArrowUp', 'AudioVolumeDown',
  'AudioVolumeMute', 'AudioVolumeUp', 'BrowserBack', 'BrowserFavorites', 'BrowserForward',
  'BrowserHome', 'BrowserRefresh', 'BrowserSearch', 'BrowserStop', 'ContextMenu',
  'ControlRight', 'Delete', 'Eject', 'End', 'Home', 'Insert', 'LaunchApp1', 'LaunchApp2',
  'LaunchMail', 'MediaPlayPause', 'MediaSelect', 'MediaStop', 'MediaTrackNext',
  'MediaTrackPrevious', 'MetaLeft', 'MetaRight', 'NumpadDivide', 'NumpadEnter', 'PageDown',
  'PageUp', 'Power', 'Sleep', 'WakeUp',
];

/**
 * codes with no single scancode. the host injects these two as sequences
 * (PrintScreen as e0 2a e0 37, Pause by virtual key) — the viewer only needs to
 * know they are legal to send, so the sequences themselves stay host-side.
 */
const SEQUENCES: Readonly<Record<string, SequenceName>> = Object.freeze({
  PrintScreen: 'PrintScreen',
  Pause: 'Pause',
});

/**
 * codes the host cannot inject at all: `Fn`/`FnLock` never leave the keyboard,
 * `Help` has no agreed set-1 code, and the sun-series editing keys are absent
 * from every keyboard swoop targets. they are in the table so an unknown code
 * and a deliberately-dropped one stay distinguishable.
 */
const NOT_INJECTABLE: readonly string[] = [
  'Again', 'Copy', 'Cut', 'Find', 'Fn', 'FnLock', 'Help', 'Open', 'Paste', 'Props',
  'Select', 'Undo',
];

export type SequenceName = 'PrintScreen' | 'Pause';

export interface KeyMapping {
  /** null when the key is injected as a sequence, or not at all. */
  readonly scancode: number | null;
  readonly extended: boolean;
  readonly sequence?: SequenceName;
}

/** `keymap.json`'s `version`; bumped there, mirrored here. */
export const KEYMAP_VERSION = 1;

export const KEYMAP: Readonly<Record<string, KeyMapping>> = Object.freeze(
  (() => {
    const extended = new Set(EXTENDED);
    const table: Record<string, KeyMapping> = {};
    for (const [code, scancode] of Object.entries(SCANCODES)) {
      table[code] = Object.freeze({ scancode, extended: extended.has(code) });
    }
    for (const [code, sequence] of Object.entries(SEQUENCES)) {
      table[code] = Object.freeze({ scancode: null, extended: false, sequence });
    }
    for (const code of NOT_INJECTABLE) {
      table[code] = Object.freeze({ scancode: null, extended: false });
    }
    return table;
  })(),
);

export const EXTENDED_CODES: ReadonlySet<string> = new Set(EXTENDED);

/**
 * what cmd does on a mac client. `'ctrl'` is the editing-shortcut mapping most
 * users want (cmd+c copies on the host); `'win'` passes cmd through as the
 * windows key. the conversion happens here, in the browser, before the message
 * is sent — PROTOCOL.md §5: the host never guesses.
 */
export type CmdMapping = 'ctrl' | 'win';

/**
 * mac clients default to the ctrl mapping because cmd is where their editing
 * shortcuts live; everywhere else meta is a real windows key and passes through.
 * the toolbar can override either way.
 */
export function defaultCmdMapping(userAgent?: string): CmdMapping {
  const ua = userAgent ?? (typeof navigator === 'undefined' ? '' : navigator.userAgent);
  return /mac|iphone|ipad/i.test(ua) ? 'ctrl' : 'win';
}

/** the code we actually put on the wire for `code`. */
export function applyCmdMapping(code: string, mapping: CmdMapping): string {
  if (mapping !== 'ctrl') return code;
  if (code === 'MetaLeft') return 'ControlLeft';
  if (code === 'MetaRight') return 'ControlRight';
  return code;
}

/** null for a code the table does not know at all. */
export function lookupCode(code: string): KeyMapping | null {
  return Object.prototype.hasOwnProperty.call(KEYMAP, code) ? KEYMAP[code] : null;
}

/** true when the host has something to inject — a scancode or a sequence. */
export function isInjectable(code: string): boolean {
  const mapping = lookupCode(code);
  return mapping !== null && (mapping.scancode !== null || mapping.sequence !== undefined);
}
