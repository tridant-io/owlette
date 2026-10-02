import { modifierLegend } from '@/lib/swoop/modifierLegend';

const rows = (legend: ReturnType<typeof modifierLegend>) => legend.map((row) => `${row.press} > ${row.gets}`);

describe('modifierLegend', () => {
  it('a pc viewer on a mac: shortcuts match sends ctrl as cmd, keys match sends it as control', () => {
    expect(rows(modifierLegend('macos', false, 'swap'))).toEqual(['ctrl > cmd', 'windows key > cmd', 'alt > option']);
    expect(rows(modifierLegend('macos', false, 'passthrough'))).toEqual([
      'ctrl > control',
      'windows key > cmd',
      'alt > option',
    ]);
  });

  it('a mac viewer on windows: shortcuts match sends cmd as ctrl, keys match sends it as the windows key', () => {
    expect(rows(modifierLegend('windows', true, 'swap'))).toEqual(['control > ctrl', 'cmd > ctrl', 'option > alt']);
    expect(rows(modifierLegend('windows', true, 'passthrough'))).toEqual([
      'control > ctrl',
      'cmd > windows key',
      'option > alt',
    ]);
    expect(rows(modifierLegend('linux', true, 'swap'))).toEqual(rows(modifierLegend('windows', true, 'swap')));
  });

  it('the same system on both ends is identity under either setting', () => {
    for (const mapping of ['swap', 'passthrough'] as const) {
      expect(rows(modifierLegend('macos', true, mapping))).toEqual(['control > control', 'cmd > cmd', 'option > option']);
      expect(rows(modifierLegend('windows', false, mapping))).toEqual([
        'ctrl > ctrl',
        'windows key > windows key',
        'alt > alt',
      ]);
    }
  });
});
