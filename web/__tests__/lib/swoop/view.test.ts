/**
 * the picture's box in `lib/swoop/view.ts`: fit snapped down to 1:1 or 1:2,
 * sharp's whole fractions, and an origin on whole device pixels.
 */

import { layoutPicture, shownAt, type PictureLayout, type PictureLayoutInput } from '@/lib/swoop/view';

const HD = { width: 1280, height: 720 };
const UHD = { width: 3840, height: 2160 };

const layout = (input: Partial<PictureLayoutInput> & Pick<PictureLayoutInput, 'area'>) =>
  layoutPicture({ dpr: 1, frame: HD, size: 'fit', wholeFractions: false, ...input });

const at = (width: number, height: number, left = 0, top = 0) => ({ left, top, width, height });

// the box's edges on the screen's device pixel grid
const device = (area: PictureLayoutInput['area'], box: PictureLayout['box'], dpr: number) => ({
  left: (area.left + box.left) * dpr,
  top: (area.top + box.top) * dpr,
  width: box.width * dpr,
  height: box.height * dpr,
});

describe('fit', () => {
  it('snaps a picture a little over full size down to 1:1, centred', () => {
    expect(layout({ area: at(1300, 760) })).toEqual({
      box: { left: 10, top: 20, width: 1280, height: 720 },
      ratio: 1,
      exact: true,
      n: 1,
    });
  });

  it('snaps a picture a little over half size down to 1:2', () => {
    expect(layout({ area: at(660, 380) })).toEqual({
      box: { left: 10, top: 10, width: 640, height: 360 },
      ratio: 0.5,
      exact: true,
      n: 2,
    });
  });

  it('snaps in device pixels at dpr 2', () => {
    const result = layout({ area: at(680, 380), dpr: 2 });
    expect(result).toMatchObject({ ratio: 1, exact: true, n: 1 });
    expect(result.box).toEqual({ left: 20, top: 10, width: 640, height: 360 });
  });

  it('snaps in device pixels at dpr 1.5, on a whole device origin', () => {
    const area = at(880, 500);
    const result = layout({ area, dpr: 1.5 });
    expect(result).toMatchObject({ ratio: 1, exact: true, n: 1 });
    const box = device(area, result.box, 1.5);
    expect(box.left).toBeCloseTo(20);
    expect(box.top).toBeCloseTo(15);
    expect(box.width).toBeCloseTo(1280);
    expect(box.height).toBeCloseTo(720);
  });

  it('never snaps up: just under full size stays where it is', () => {
    const result = layout({ area: at(1242, 800) });
    expect(result).toMatchObject({ exact: false, n: null });
    expect(result.ratio).toBeCloseTo(0.97, 2);
    expect(result.box.width).toBe(1242);
  });

  it('does not snap past the band', () => {
    const result = layout({ area: at(1434, 900) });
    expect(result).toMatchObject({ exact: false, n: null });
    expect(result.ratio).toBeCloseTo(1.12, 2);
  });

  it('lays an unsnapped picture on whole device pixels', () => {
    expect(layout({ area: at(1000, 600) })).toEqual({
      box: { left: 0, top: 19, width: 1000, height: 563 },
      ratio: 1000 / 1280,
      exact: false,
      n: null,
    });
  });

  it('takes the area\'s exact device size over its css size times dpr', () => {
    const area = at(853.4, 480);
    expect(layout({ area, dpr: 1.5 }).n).toBe(1);
    expect(layout({ area, dpr: 1.5, devicePixels: { width: 1279, height: 720 } })).toMatchObject({ exact: false, n: null });
  });
});

describe('sharp', () => {
  it('shows a 4K machine at 1:3 when smooth scaling can draw it', () => {
    expect(layout({ area: at(1300, 760), frame: UHD, size: 'sharp', wholeFractions: true })).toEqual({
      box: { left: 10, top: 20, width: 1280, height: 720 },
      ratio: 1 / 3,
      exact: true,
      n: 3,
    });
  });

  it('falls back to fit below 1:2 when smooth scaling cannot draw it', () => {
    const result = layout({ area: at(1300, 760), frame: UHD, size: 'sharp', wholeFractions: false });
    expect(result).toMatchObject({ exact: false, n: null, ratio: 1300 / 3840 });
    expect(result.box).toEqual({ left: 0, top: 15, width: 1300, height: 731 });
  });

  it('needs no smooth scaling for 1:2', () => {
    expect(layout({ area: at(1000, 600), size: 'sharp' })).toEqual({
      box: { left: 180, top: 120, width: 640, height: 360 },
      ratio: 0.5,
      exact: true,
      n: 2,
    });
  });

  it('is not exact when the frame does not divide by its fraction', () => {
    const result = layout({ area: at(1000, 600), frame: { width: 2560, height: 1440 }, size: 'sharp', wholeFractions: true });
    expect(result).toMatchObject({ exact: false, n: 3 });
    expect(result.box).toMatchObject({ width: 853, height: 480 });
  });
});

describe('the origin', () => {
  it('lands on a whole device pixel even when the area does not', () => {
    const area = at(680, 380, 10.25, 30.75);
    const result = layout({ area, dpr: 2 });
    const box = device(area, result.box, 2);
    expect(box).toEqual({ left: 61, top: 82, width: 1280, height: 720 });
  });
});

describe('before the first frame', () => {
  it('is the whole area', () => {
    const area = at(1300, 760, 5, 48);
    expect(layout({ area, frame: { width: 0, height: 0 } })).toEqual({
      box: { left: 0, top: 0, width: 1300, height: 760 },
      ratio: 0,
      exact: false,
      n: null,
    });
  });

  it('is the whole area while the area has no size', () => {
    expect(layout({ area: at(0, 0), size: 'sharp', wholeFractions: true })).toMatchObject({ ratio: 0, n: null });
  });
});

describe('shownAt', () => {
  it('is a whole percent', () => {
    expect(shownAt(1)).toBe(100);
    expect(shownAt(0.5)).toBe(50);
    expect(shownAt(1 / 3)).toBe(33);
    expect(shownAt(1000 / 1280)).toBe(78);
  });
});
