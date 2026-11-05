/**
 * Text that sits on translucent fills keeps WCAG AA in the theme it renders in.
 *
 * theme-contrast.test.ts holds token against token, over a card. The admin,
 * settings, deployments, logs and talons pages also lay text on stacks it can't
 * express: a cyan callout on the bare page, the night-only 15-20% tints, the
 * inverse tooltip's quiet line, badge fills with no foreground of their own.
 * This composites each stack the way the browser paints it, from the real
 * globals.css values.
 */
import { readFileSync } from 'fs';
import path from 'path';

type Rgb = [number, number, number];

const css = readFileSync(path.join(__dirname, '../../app/globals.css'), 'utf8');

function block(selector: string): Record<string, string> {
  const escaped = selector.replace(/[.]/g, '\\.');
  const tokens: Record<string, string> = {};
  for (const [, body] of css.matchAll(new RegExp(`(?:^|\\n)${escaped}\\s*\\{([^}]*)\\}`, 'g'))) {
    for (const m of body.replace(/\/\*[\s\S]*?\*\//g, '').matchAll(/--([a-z0-9-]+):\s*([^;]+);/g)) {
      tokens[m[1]] = m[2].trim();
    }
  }
  return tokens;
}

function oklchToRgb(L: number, C: number, H: number): Rgb {
  const h = (H * Math.PI) / 180;
  const [a, b] = [C * Math.cos(h), C * Math.sin(h)];
  const l = (L + 0.3963377774 * a + 0.2158037573 * b) ** 3;
  const m = (L - 0.1055613458 * a - 0.0638541728 * b) ** 3;
  const s = (L - 0.0894841775 * a - 1.291485548 * b) ** 3;
  return [
    4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
    -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
    -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s,
  ].map((c) => {
    const v = Math.min(1, Math.max(0, c));
    return v <= 0.0031308 ? 12.92 * v : 1.055 * v ** (1 / 2.4) - 0.055;
  }) as Rgb;
}

const THEMES = { light: block(':root'), dark: { ...block(':root'), ...block('.dark') } };

/** `token` or `token/alpha%`, the way a tailwind opacity modifier writes it */
function paint(theme: keyof typeof THEMES, spec: string): { rgb: Rgb; alpha: number } {
  const [name, percent] = spec.split('/');
  const value = THEMES[theme][name];
  const m = value?.match(/^oklch\(\s*([\d.]+)\s+([\d.]+)\s+([\d.]+)\s*(?:\/\s*([\d.]+))?\s*\)$/);
  if (!m) throw new Error(`--${name} is not an oklch token in ${theme}`);
  const alpha = (m[4] ? Number(m[4]) : 1) * (percent ? Number(percent) / 100 : 1);
  return { rgb: oklchToRgb(Number(m[1]), Number(m[2]), Number(m[3])), alpha };
}

const luminance = (rgb: Rgb) =>
  rgb
    .map((c) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4))
    .reduce((sum, c, i) => sum + c * [0.2126, 0.7152, 0.0722][i], 0);

/** text over its stack of fills, bottom-up, composited on an opaque page */
function contrast(theme: keyof typeof THEMES, text: string, layers: string[]): number {
  const composite = (top: { rgb: Rgb; alpha: number }, base: Rgb) =>
    top.rgb.map((c, i) => c * top.alpha + base[i] * (1 - top.alpha)) as Rgb;
  const surface = layers.reduce<Rgb>((base, layer) => composite(paint(theme, layer), base), [1, 1, 1]);
  const [hi, lo] = [luminance(composite(paint(theme, text), surface)), luminance(surface)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

const CASES: Array<[keyof typeof THEMES, string, string[]]> = [
  // cyan callouts that sit on the page rather than a card
  ['light', 'accent-cyan', ['background', 'accent-cyan/10']],
  ['dark', 'accent-cyan', ['background', 'accent-cyan/10']],
  // the stronger cyan tints are night-only: the admin nav, the expiry chip
  ['dark', 'accent-cyan', ['card', 'accent-cyan/15']],
  ['dark', 'accent-cyan', ['card', 'accent-cyan/20']],
  // the inverse tooltip's quiet line
  ['light', 'tooltip-foreground/70', ['tooltip']],
  ['dark', 'muted-foreground', ['tooltip']],
  // deployment badges whose fill has no foreground of its own
  ...(['light', 'dark'] as const).flatMap((theme): Array<[keyof typeof THEMES, string, string[]]> => [
    [theme, 'primary-foreground', ['chart-4']],
    [theme, 'primary-foreground', ['accent-coral']],
    [theme, 'primary-foreground', ['accent-warm']],
    [theme, 'muted-foreground', ['muted']],
  ]),
  // severity and expiry chips keep their old 20% tints by night
  ['dark', 'danger', ['card', 'danger-solid/20']],
  ['dark', 'warning', ['card', 'warning-solid/20']],
  ['dark', 'info', ['card', 'info-solid/20']],
  ['dark', 'success', ['card', 'success/20']],
];

describe('composited text contrast', () => {
  it.each(CASES)('%s: --%s on %j clears 4.5:1', (theme, text, layers) => {
    expect(contrast(theme, text, layers)).toBeGreaterThanOrEqual(4.5);
  });
});
