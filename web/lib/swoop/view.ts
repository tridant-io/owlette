/**
 * where swoop's picture sits in its area, and at what size, in device pixels.
 *
 * browsers draw a `<video>` with a bilinear filter and no mipmaps. at 1:1 on
 * whole device pixels that is a plain copy, and at 1:2 on whole device pixels
 * each screen pixel is a clean average of a 2x2 block; at any other size thin
 * strokes land on uneven weights and stair-step. so fit snaps a picture that is
 * a little over 1:1 or 1:2 down to exactly that (never up: that would crop the
 * machine's edges and put them out of reach of input), and sharp shows the
 * largest whole fraction that fits. 1:3 and below are only exact through smooth
 * scaling's area average, so without it sharp falls back to fit there.
 *
 * the box is the picture's own box, not a letterbox inside a bigger element:
 * `useSwoopView` writes it straight onto the `<video>`'s style, so
 * `contentRect()`, input, touch and the overlays all read one box and can never
 * disagree with the fit (plan C1). its origin is rounded on the screen's device
 * pixel grid, not the area's, so the picture starts on a whole device pixel
 * even when the area does not.
 */

export type SwoopSize = 'fit' | 'sharp';

/** how far above 1:1 or 1:2 a fit still snaps down to it. */
export const SNAP_BAND = 0.1;

export interface PictureLayoutInput {
  /** the area's client rect, css px. */
  area: { left: number; top: number; width: number; height: number };
  dpr: number;
  /** the area's exact device size, when a `device-pixel-content-box` ResizeObserver gives one. */
  devicePixels?: { width: number; height: number } | null;
  /** videoWidth and videoHeight; 0 before the first frame. */
  frame: { width: number; height: number };
  size: SwoopSize;
  /** 1:3 and below can be drawn exactly: smooth scaling is on and able to draw. */
  wholeFractions: boolean;
}

export interface PictureLayout {
  /** css px, relative to the area. */
  box: { left: number; top: number; width: number; height: number };
  /** device pixels per frame pixel; 0 before the first frame. */
  ratio: number;
  /** a whole fraction of the frame on whole device pixels. */
  exact: boolean;
  /** the whole fraction's denominator, or null when the picture is not shown at one. */
  n: number | null;
}

/** a ratio as the whole percent the stats show. */
export const shownAt = (ratio: number): number => Math.round(ratio * 100);

export function layoutPicture({ area, dpr, devicePixels, frame, size, wholeFractions }: PictureLayoutInput): PictureLayout {
  const W = devicePixels?.width ?? Math.round(area.width * dpr);
  const H = devicePixels?.height ?? Math.round(area.height * dpr);
  const { width: fw, height: fh } = frame;
  // nothing to fit yet: no frame, or an area with no size
  if (fw <= 0 || fh <= 0 || W <= 0 || H <= 0) {
    return { box: { left: 0, top: 0, width: area.width, height: area.height }, ratio: 0, exact: false, n: null };
  }

  const r = Math.min(W / fw, H / fh);
  let n: number | null = null;
  if (size === 'sharp') {
    const whole = Math.max(1, Math.ceil(Math.max(fw / W, fh / H)));
    if (whole <= 2 || wholeFractions) n = whole;
  }
  if (n === null) {
    if (r >= 1 && r <= 1 + SNAP_BAND) n = 1;
    else if (r >= 0.5 && r <= 0.5 * (1 + SNAP_BAND)) n = 2;
  }
  const ratio = n === null ? r : 1 / n;

  const w = Math.min(W, Math.round(fw * ratio));
  const h = Math.min(H, Math.round(fh * ratio));
  const x = Math.round(area.left * dpr + (W - w) / 2);
  const y = Math.round(area.top * dpr + (H - h) / 2);
  return {
    box: { left: x / dpr - area.left, top: y / dpr - area.top, width: w / dpr, height: h / dpr },
    ratio,
    // a frame that does not divide by n is drawn a hair off 1:n, so its samples drift
    exact: n !== null && fw % n === 0 && fh % n === 0,
    n,
  };
}
