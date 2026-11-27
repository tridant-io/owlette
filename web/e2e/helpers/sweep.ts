import { expect, type Locator } from '@playwright/test';

/**
 * the hover sweep (.btn-sweep, .menu-sweep in globals.css) as a spec reads it.
 *
 * the sweep is a --btn-hover gradient whose background-size runs 0% -> 100% over
 * an unchanged background-color, so it is asserted as geometry, not colour: that
 * catches a missing scrim, a transparent --btn-hover and a dropped class alike.
 */

/** the sweep's gradient layer, how far it has run, and the fill under it */
export const sweepState = (target: Locator) =>
  target.evaluate((el) => {
    const style = getComputedStyle(el);
    return { image: style.backgroundImage, size: style.backgroundSize, color: style.backgroundColor };
  });

/** polled: the computed size runs through the 200ms transition */
export const expectSweepSize = (target: Locator, size: '0% 100%' | '100% 100%', message?: string) =>
  expect.poll(async () => (await sweepState(target)).size, { message }).toBe(size);

/** at rest: the layer is there, not transparent, and collapsed to zero width */
export async function expectSweepAtRest(target: Locator, what: string) {
  const rest = await sweepState(target);
  expect(rest.image, `${what} should carry the sweep layer`).toContain('gradient');
  expect(rest.image, `${what}: the sweep colour must not be transparent`).not.toContain('rgba(0, 0, 0, 0)');
  expect(rest.size, `${what} should be collapsed at rest`).toBe('0% 100%');
  return rest;
}

/**
 * wcag contrast of an element's text over its sweep, from computed colours.
 *
 * the browser does the colour work: each computed colour (lab, oklch, rgba) is
 * painted onto a 1px canvas in page order, from the first opaque ancestor
 * background, through the element's own fill, to the gradient the sweep draws,
 * and the text colour on top. the pixels give the luminances, so no colour-space
 * maths lives here. read it once the sweep has settled at 100%.
 *
 * the sweep is the bottom layer, so a link whose glyph layers ride above its fill
 * (`.hl-link`) reads right. `ink`, an element inside the target, is text that sets
 * its own colour, as a filter's match does: its own fill and colour go on top.
 */
export async function sweptContrast(target: Locator, ink?: Locator): Promise<number> {
  const inkHandle = ink ? await ink.elementHandle() : null;
  return target.evaluate((el, inkEl) => {
    const ctx = Object.assign(document.createElement('canvas'), { width: 1, height: 1 }).getContext('2d', {
      willReadFrequently: true,
    })!;
    const paint = (fills: string[]) => {
      ctx.clearRect(0, 0, 1, 1);
      for (const fill of fills) {
        // an unparseable colour would leave the last fill in place and pass silently
        ctx.fillStyle = '#010203';
        ctx.fillStyle = fill;
        if (ctx.fillStyle === '#010203') throw new Error(`canvas cannot paint ${fill}`);
        ctx.fillRect(0, 0, 1, 1);
      }
      return ctx.getImageData(0, 0, 1, 1).data;
    };

    // the backgrounds behind the element, outermost first, down to the first opaque one
    const behind: string[] = [];
    for (let node = el.parentElement; node; node = node.parentElement) {
      const fill = getComputedStyle(node).backgroundColor;
      behind.unshift(fill);
      if (paint([fill])[3] === 255) break;
    }
    const style = getComputedStyle(el);
    const sweep = style.backgroundImage.match(/(?:rgba?|lab|lch|oklab|oklch|color)\([^()]*\)/g)?.at(-1);
    if (!sweep) throw new Error(`no sweep layer in ${style.backgroundImage}`);

    const text = inkEl ? getComputedStyle(inkEl) : style;
    const surface = [...behind, style.backgroundColor, sweep, ...(inkEl ? [text.backgroundColor] : [])];
    const luminance = (pixel: Uint8ClampedArray) => {
      const lin = (c: number) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
      return 0.2126 * lin(pixel[0] / 255) + 0.7152 * lin(pixel[1] / 255) + 0.0722 * lin(pixel[2] / 255);
    };
    const [hi, lo] = [luminance(paint([...surface, text.color])), luminance(paint(surface))].sort((a, b) => b - a);
    return (hi + 0.05) / (lo + 0.05);
  }, inkHandle);
}
