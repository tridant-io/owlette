import type { Locator } from '@playwright/test';

/**
 * WCAG contrast of an element's text over its hover sweep, from computed colours.
 *
 * The browser does the colour work: each computed colour (lab, oklch, rgba) is
 * painted onto a 1px canvas in page order, from the first opaque ancestor
 * background, through the element's own fill, to the --btn-hover gradient the
 * sweep draws, and the text colour on top. The pixels give the luminances, so no
 * colour-space maths lives here. Read it once the sweep has settled at 100%.
 */
export function sweptContrast(target: Locator): Promise<number> {
  return target.evaluate((el) => {
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
    const sweep = style.backgroundImage.match(/(?:rgba?|lab|lch|oklab|oklch|color)\([^()]*\)/)?.[0];
    if (!sweep) throw new Error(`no sweep layer in ${style.backgroundImage}`);

    const surface = [...behind, style.backgroundColor, sweep];
    const luminance = (pixel: Uint8ClampedArray) => {
      const lin = (c: number) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
      return 0.2126 * lin(pixel[0] / 255) + 0.7152 * lin(pixel[1] / 255) + 0.0722 * lin(pixel[2] / 255);
    };
    const [hi, lo] = [luminance(paint([...surface, style.color])), luminance(paint(surface))].sort((a, b) => b - a);
    return (hi + 0.05) / (lo + 0.05);
  });
}
