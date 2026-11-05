/**
 * the keyboard menu's legend: what the viewer's three modifiers do on the
 * machine under the current setting, from the same conversion the input
 * capture runs (`applyModifierMapping`), so the legend can never drift from
 * what is sent.
 */

import type { MachineOsFamily } from '@/lib/machineOs';
import { applyModifierMapping, type ModifierMapping } from './keymap';

/** one row: the key you press, and the key the machine gets. */
export interface LegendRow {
  press: string;
  gets: string;
}

const VIEWER_KEYS = ['ControlLeft', 'MetaLeft', 'AltLeft'] as const;

/** a modifier's name on a system, by the code the browser gives the key. */
export function modifierName(code: string, mac: boolean): string {
  switch (code) {
    case 'ControlLeft':
    case 'ControlRight':
      return mac ? 'control' : 'ctrl';
    case 'MetaLeft':
    case 'MetaRight':
      return mac ? 'cmd' : 'windows key';
    case 'AltLeft':
    case 'AltRight':
      return mac ? 'option' : 'alt';
    default:
      return code;
  }
}

export function modifierLegend(host: MachineOsFamily, viewerIsMac: boolean, mapping: ModifierMapping): LegendRow[] {
  return VIEWER_KEYS.map((code) => ({
    press: modifierName(code, viewerIsMac),
    gets: modifierName(applyModifierMapping(code, host, viewerIsMac, mapping), host === 'macos'),
  }));
}
