/**
 * the key combinations a browser or the viewer's own windows keeps for itself,
 * sent from a menu instead. every one is a chord on the input channel — the
 * same path as a typed key, so it takes its place in the channel's sequence —
 * except ctrl+alt+del, which is a control message the host turns into a real
 * secure-attention sequence (PROTOCOL §5 `sas`, requires `ctl`).
 *
 * the list is the host's: each chord names the host's own keys and is sent as
 * written, never through the modifier mapping. only windows has a
 * secure-attention sequence.
 */

import type { MachineOsFamily } from '@/lib/machineOs';
import type { InputCapture } from './input';
import { encodeControlMessage } from './protocol';

export interface SpecialKey {
  id: string;
  label: string;
  /** what it does, for the menu; absent when the label says it all. */
  hint?: string;
  /** `KeyboardEvent.code` names, pressed in order and released in reverse. */
  codes?: readonly string[];
  /** the secure-attention sequence: a control message, not a chord. */
  sas?: true;
}

const WINDOWS_KEYS: readonly SpecialKey[] = [
  { id: 'sas', label: 'ctrl + alt + del', sas: true },
  { id: 'win', label: 'windows key', codes: ['MetaLeft'] },
  { id: 'alt-tab', label: 'alt + tab', codes: ['AltLeft', 'Tab'] },
  { id: 'alt-f4', label: 'alt + f4', hint: 'close window', codes: ['AltLeft', 'F4'] },
  { id: 'win-d', label: 'win + d', hint: 'show desktop', codes: ['MetaLeft', 'KeyD'] },
  { id: 'win-l', label: 'win + l', hint: 'lock', codes: ['MetaLeft', 'KeyL'] },
  { id: 'ctrl-esc', label: 'ctrl + esc', hint: 'start menu', codes: ['ControlLeft', 'Escape'] },
  { id: 'ctrl-shift-esc', label: 'ctrl + shift + esc', hint: 'task manager', codes: ['ControlLeft', 'ShiftLeft', 'Escape'] },
  { id: 'print', label: 'print screen', codes: ['PrintScreen'] },
  { id: 'esc', label: 'esc', codes: ['Escape'] },
];

const MACOS_KEYS: readonly SpecialKey[] = [
  { id: 'cmd-tab', label: 'cmd + tab', codes: ['MetaLeft', 'Tab'] },
  { id: 'cmd-space', label: 'cmd + space', hint: 'spotlight', codes: ['MetaLeft', 'Space'] },
  { id: 'cmd-q', label: 'cmd + q', hint: 'quit app', codes: ['MetaLeft', 'KeyQ'] },
  { id: 'cmd-ctrl-q', label: 'cmd + ctrl + q', hint: 'lock', codes: ['MetaLeft', 'ControlLeft', 'KeyQ'] },
  { id: 'esc', label: 'esc', codes: ['Escape'] },
];

const LINUX_KEYS: readonly SpecialKey[] = WINDOWS_KEYS.filter((key) => !key.sas);

/** the menu for a machine running `hostOs`. */
export function specialKeysFor(hostOs: MachineOsFamily): readonly SpecialKey[] {
  if (hostOs === 'macos') return MACOS_KEYS;
  if (hostOs === 'linux') return LINUX_KEYS;
  return WINDOWS_KEYS;
}

export interface SpecialKeyTarget {
  /** the session's control channel send. */
  send: (label: 'swoop-control', data: string) => boolean;
  /** the live input capture, or null before attach / for view only. */
  capture: Pick<InputCapture, 'pressChord'> | null;
}

/** send one special key. false when nothing could carry it. */
export function sendSpecialKey(target: SpecialKeyTarget, key: SpecialKey): boolean {
  if (key.sas) return target.send('swoop-control', encodeControlMessage({ t: 'sas' }));
  if (!key.codes || !target.capture) return false;
  target.capture.pressChord(key.codes);
  return true;
}
