/** @jest-environment node */

import { readFileSync } from 'fs';
import path from 'path';

import {
  EXTENDED_CODES,
  KEYMAP,
  KEYMAP_VERSION,
  applyCmdMapping,
  defaultCmdMapping,
  isInjectable,
  lookupCode,
} from '@/lib/swoop/keymap';
import { decodeInputMessage, encodeInputMessage } from '@/lib/swoop/protocol';

// the source of truth both ends read. keymap.ts is a transcription of it; this
// file is the only thing that keeps the transcription honest.
const KEYMAP_JSON = path.resolve(__dirname, '../../../../agent/swoop/testdata/keymap.json');

interface JsonEntry {
  scancode: number | null;
  extended: boolean;
  sequence?: string;
  note?: string;
}

const source = JSON.parse(readFileSync(KEYMAP_JSON, 'utf8')) as {
  version: number;
  sequences: Record<string, unknown>;
  codes: Record<string, JsonEntry>;
};

describe('keymap.json parity', () => {
  it('mirrors the version', () => {
    expect(KEYMAP_VERSION).toBe(source.version);
  });

  it('carries exactly the codes the json carries', () => {
    expect(Object.keys(KEYMAP).sort()).toEqual(Object.keys(source.codes).sort());
    expect(Object.keys(KEYMAP)).toHaveLength(162);
  });

  it.each(Object.keys(source.codes))('%s round-trips', (code) => {
    const expected = source.codes[code];
    const mapping = lookupCode(code);
    expect(mapping).not.toBeNull();
    expect(mapping!.scancode).toBe(expected.scancode);
    expect(mapping!.extended).toBe(expected.extended);
    expect(mapping!.sequence).toBe(expected.sequence);

    // and the same code survives the wire it is looked up from.
    const decoded = decodeInputMessage(
      encodeInputMessage({ t: 'k', code, down: true, seq: 1, tsUs: 2 }),
      { ctl: true },
    );
    expect(decoded.ok).toBe(true);
    expect(decoded.ok && decoded.value).toEqual({ t: 'k', code, down: true, seq: 1, tsUs: 2 });
  });

  it('has the same extended-key set as the json, exactly', () => {
    const fromJson = Object.entries(source.codes)
      .filter(([, entry]) => entry.extended)
      .map(([code]) => code)
      .sort();
    expect([...EXTENDED_CODES].sort()).toEqual(fromJson);
    expect(fromJson).toHaveLength(39);
  });

  it('keys the shared low bytes apart by extended alone', () => {
    // the hazard the whole "never use event.key" rule exists for.
    for (const [numpad, pad] of [
      ['Numpad4', 'ArrowLeft'],
      ['Numpad0', 'Insert'],
      ['NumpadDecimal', 'Delete'],
      ['Enter', 'NumpadEnter'],
      ['ControlLeft', 'ControlRight'],
    ] as const) {
      expect(KEYMAP[numpad].scancode).toBe(KEYMAP[pad].scancode);
      expect(KEYMAP[numpad].extended).not.toBe(KEYMAP[pad].extended);
    }
  });

  it('treats the sequence keys as injectable and the dead keys as not', () => {
    for (const code of Object.keys(source.sequences)) {
      expect(KEYMAP[code].scancode).toBeNull();
      expect(isInjectable(code)).toBe(true);
    }
    for (const code of ['Fn', 'FnLock', 'Help', 'Copy', 'Paste', 'Undo']) {
      expect(isInjectable(code)).toBe(false);
    }
    expect(lookupCode('NoSuchKey')).toBeNull();
    expect(isInjectable('NoSuchKey')).toBe(false);
  });
});

describe('cmd mapping', () => {
  it('maps cmd to ctrl when configured', () => {
    expect(applyCmdMapping('MetaLeft', 'ctrl')).toBe('ControlLeft');
    expect(applyCmdMapping('MetaRight', 'ctrl')).toBe('ControlRight');
  });

  it('passes cmd through as the windows key when configured', () => {
    expect(applyCmdMapping('MetaLeft', 'win')).toBe('MetaLeft');
    expect(applyCmdMapping('MetaRight', 'win')).toBe('MetaRight');
  });

  it('leaves every other code alone under both mappings', () => {
    for (const code of Object.keys(source.codes)) {
      if (code === 'MetaLeft' || code === 'MetaRight') continue;
      expect(applyCmdMapping(code, 'ctrl')).toBe(code);
      expect(applyCmdMapping(code, 'win')).toBe(code);
    }
  });

  it('defaults to ctrl on a mac and win elsewhere', () => {
    expect(defaultCmdMapping('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)')).toBe('ctrl');
    expect(defaultCmdMapping('Mozilla/5.0 (Windows NT 10.0; Win64; x64)')).toBe('win');
    expect(defaultCmdMapping('Mozilla/5.0 (X11; Linux x86_64)')).toBe('win');
  });
});
