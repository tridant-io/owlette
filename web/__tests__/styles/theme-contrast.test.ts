/**
 * Both themes keep WCAG AA contrast on the token pairs the UI is built from.
 *
 * Reads the light (`:root`) and dark (`.dark`) blocks straight out of globals.css,
 * so a palette edit that drops a pair under the line fails here instead of on a
 * customer's screen. Translucent tokens (the dark status surfaces) are composited
 * over the card they sit on, the way the browser paints them.
 */
import { readFileSync } from 'fs';
import path from 'path';

type Rgb = [number, number, number];
type Paint = { rgb: Rgb; alpha: number };

const css = readFileSync(path.join(__dirname, '../../app/globals.css'), 'utf8');

/** every custom property declared in the top-level `selector { ... }` blocks, merged */
function block(selector: string): Record<string, string> {
  const escaped = selector.replace(/[.]/g, '\\.');
  const blocks = [...css.matchAll(new RegExp(`(?:^|\\n)${escaped}\\s*\\{([^}]*)\\}`, 'g'))];
  if (blocks.length === 0) throw new Error(`no ${selector} block in globals.css`);
  const tokens: Record<string, string> = {};
  for (const [, body] of blocks) {
    // comments mention tokens by name ("--foreground: at 14%"), so read declarations only
    const declarations = body.replace(/\/\*[\s\S]*?\*\//g, '');
    for (const match of declarations.matchAll(/--([a-z0-9-]+):\s*([^;]+);/g)) tokens[match[1]] = match[2].trim();
  }
  return tokens;
}

function oklchToRgb(L: number, C: number, H: number): Rgb {
  const h = (H * Math.PI) / 180;
  const a = C * Math.cos(h);
  const b = C * Math.sin(h);
  const l = (L + 0.3963377774 * a + 0.2158037573 * b) ** 3;
  const m = (L - 0.1055613458 * a - 0.0638541728 * b) ** 3;
  const s = (L - 0.0894841775 * a - 1.291485548 * b) ** 3;
  const linear = [
    4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
    -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
    -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s,
  ];
  return linear.map((c) => {
    const v = Math.min(1, Math.max(0, c));
    return v <= 0.0031308 ? 12.92 * v : 1.055 * v ** (1 / 2.4) - 0.055;
  }) as Rgb;
}

function parse(value: string): Paint {
  const oklch = value.match(/^oklch\(\s*([\d.]+%?)\s+([\d.]+)\s+([\d.]+)\s*(?:\/\s*([\d.]+))?\s*\)$/);
  if (oklch) {
    const L = oklch[1].endsWith('%') ? parseFloat(oklch[1]) / 100 : parseFloat(oklch[1]);
    return { rgb: oklchToRgb(L, parseFloat(oklch[2]), parseFloat(oklch[3])), alpha: oklch[4] ? parseFloat(oklch[4]) : 1 };
  }
  const rgb = value.match(/^rgb\(\s*(\d+)[,\s]+(\d+)[,\s]+(\d+)\s*\)$/);
  if (rgb) return { rgb: [rgb[1], rgb[2], rgb[3]].map((c) => Number(c) / 255) as Rgb, alpha: 1 };
  throw new Error(`unparseable colour: ${value}`);
}

const over = (top: Paint, base: Rgb): Rgb =>
  top.rgb.map((c, i) => c * top.alpha + base[i] * (1 - top.alpha)) as Rgb;

function luminance([r, g, b]: Rgb): number {
  const lin = (c: number) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
}

function contrast(a: Rgb, b: Rgb): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

const TEXT = 4.5;

/** [text token, surface token]; surfaces that are translucent sit on the card */
const TEXT_PAIRS: Array<[string, string]> = [
  ['foreground', 'background'],
  ['foreground', 'card'],
  ['foreground', 'secondary'],
  ['card-foreground', 'card'],
  ['popover-foreground', 'popover'],
  ['muted-foreground', 'background'],
  ['muted-foreground', 'card'],
  ['muted-foreground', 'card-sunken'],
  ['muted-foreground', 'secondary'],
  ['primary-foreground', 'primary'],
  ['accent-cyan', 'background'],
  ['accent-cyan', 'card'],
  ['destructive', 'card'],
  ['chart-axis', 'card'],
  // translucent pairs the ui relies on: cyan text on its own tint, faded muted text
  ['accent-cyan', 'accent-cyan@0.1'],
  ['muted-foreground@0.8', 'card'],
  ['muted-foreground@0.8', 'background'],
  // ink on sodium amber (the update flow)
  ['background', 'accent-warm'],
  // the first net and disk-io series double as readout text, also on stale rows dimmed to 80%
  ...(['series-nic-tx-1', 'series-nic-rx-1', 'series-disk-io-read', 'series-disk-io-write'] as const).flatMap(
    (series): Array<[string, string]> => [[series, 'card'], [series, 'background'], [`${series}@0.8`, 'card-sunken']],
  ),
  // the docs sidebar marks the open page with a heavier cyan tint than the app's 10%
  ['accent-cyan', 'accent-cyan@0.15'],
  // menus sit on --secondary
  ...(['danger', 'warning', 'success', 'info'] as const).flatMap((status): Array<[string, string]> => [
    [status, 'background'],
    [status, 'card'],
    [status, 'secondary'],
    [status, `${status}-surface`],
    [`${status}-solid-foreground`, `${status}-solid`],
  ]),
  ...[1, 2, 3, 4, 5, 6, 7, 8].flatMap((n): Array<[string, string]> => [
    [`block-${n}-foreground`, `block-${n}`],
    [`block-${n}-ink`, 'card'],
    [`block-${n}-ink`, 'raised'],
  ]),
];

/**
 * text set on the hover sweep (.btn-sweep, .menu-sweep): the --btn-hover scrim
 * over a menu, popover or card. a highlighted menu row or hovered ghost button
 * reads in these, the tinted ones through their -bright steps, and a row's quiet
 * line through accent-foreground at 80%.
 */
const SWEPT_TEXT = [
  'foreground',
  'accent-foreground',
  'accent-foreground@0.8',
  'danger-bright',
  'info-bright',
  'series-display-bright',
  'warning',
  'primary',
  'accent-warm-hover',
  'accent-cyan',
] as const;
const SWEPT_PAIRS: Array<[string, string]> = SWEPT_TEXT.flatMap((text): Array<[string, string]> =>
  (['raised', 'popover', 'card'] as const).map((surface): [string, string] => [text, surface]),
);
/**
 * glyphs on the sweep, held to the 3:1 of a graphic: muted-foreground stays on a
 * highlighted row only as an icon (quiet text takes accent-foreground@0.8, above),
 * and row / row-destructive are icon-only buttons that hover with a muted fill
 * under the sweep.
 */
const SWEPT_ICONS: Array<[string, string]> = [
  ...(['raised', 'popover', 'card'] as const).map((surface): [string, string] => ['muted-foreground', surface]),
  ['accent-cyan', 'muted'],
  ['danger-bright', 'muted'],
];
const GRAPHIC = 3;

/** a `color-mix(in oklab, <colour> N%, transparent)` scrim, as the hover tints are written */
function scrim(value: string): Paint {
  const mix = value.match(/^color-mix\(in oklab,\s*(.+?)\s+([\d.]+)%,\s*transparent\)$/);
  if (!mix) throw new Error(`not a scrim: ${value}`);
  const colour = parse(mix[1]);
  return { rgb: colour.rgb, alpha: colour.alpha * (Number(mix[2]) / 100) };
}

describe.each([
  ['light', ':root'],
  ['dark', '.dark'],
])('%s theme contrast', (_name, selector) => {
  const tokens = { ...block(':root'), ...block(selector) };
  const card = parse(tokens.card).rgb;
  /** a token's value, following `var(--other)` (the day -bright steps equal their base) */
  const resolve = (name: string): string => {
    const value = tokens[name];
    if (!value) throw new Error(`--${name} is not defined for ${selector}`);
    const ref = value.match(/^var\(--([a-z0-9-]+)\)$/);
    return ref ? resolve(ref[1]) : value;
  };
  /** `name` or `name@alpha`, composited over `base` the way the browser paints it */
  const paint = (spec: string, base: Rgb = card): Rgb => {
    const [name, alpha] = spec.split('@');
    const colour = parse(resolve(name));
    return over({ rgb: colour.rgb, alpha: colour.alpha * (alpha ? Number(alpha) : 1) }, base);
  };

  it.each(TEXT_PAIRS)('--%s on --%s clears 4.5:1', (text, surface) => {
    const behind = paint(surface);
    expect(contrast(paint(text, behind), behind)).toBeGreaterThanOrEqual(TEXT);
  });

  const swept = (surface: string): Rgb => over(scrim(resolve('btn-hover')), paint(surface));

  it.each(SWEPT_PAIRS)('--%s on the hover sweep over --%s clears 4.5:1', (text, surface) => {
    const behind = swept(surface);
    expect(contrast(paint(text, behind), behind)).toBeGreaterThanOrEqual(TEXT);
  });

  it.each(SWEPT_ICONS)('--%s icons on the hover sweep over --%s clear 3:1', (icon, surface) => {
    const behind = swept(surface);
    expect(contrast(paint(icon, behind), behind)).toBeGreaterThanOrEqual(GRAPHIC);
  });
});

// the swoop stage is themed from the page root, since it scopes `.dark` onto
// itself. at night it is the page's own background and muted text, covered above
it('the day swoop stage hints clear 4.5:1 on the stage', () => {
  const day = block(':root');
  expect(contrast(parse(day['swoop-stage-ink']).rgb, parse(day['swoop-stage']).rgb)).toBeGreaterThanOrEqual(TEXT);
});

describe('token coverage', () => {
  it('defines every dark token in the light block too', () => {
    const light = block(':root');
    const missing = Object.keys(block('.dark')).filter((name) => !(name in light));
    expect(missing).toEqual([]);
  });
});
