/**
 * the local zoom's arithmetic in `lib/swoop/zoom.ts`: the letterbox, the
 * clamps that keep the picture over the stage, and a pinch anchored under the
 * fingers.
 */

import { NO_ZOOM, ZOOM_MAX, clampZoom, fitBox, pinchZoom, zoomTransform } from '@/lib/swoop/zoom';

// a 16:9 machine in a 400x400 stage: letterboxed top and bottom
const STAGE = { width: 400, height: 400 };
const PICTURE = fitBox(STAGE, { width: 1920, height: 1080 });

describe('fitBox', () => {
  it('letterboxes a wide frame into a square element', () => {
    expect(PICTURE).toEqual({ left: 0, top: 87.5, width: 400, height: 225 });
  });

  it('is the whole element before the first frame', () => {
    expect(fitBox(STAGE, { width: 0, height: 0 })).toEqual({ left: 0, top: 0, width: 400, height: 400 });
  });
});

describe('clampZoom', () => {
  it('is no zoom at all at 1, whatever the pan said', () => {
    expect(clampZoom({ scale: 1, x: 50, y: -20 }, PICTURE, STAGE)).toBe(NO_ZOOM);
    expect(clampZoom({ scale: 0.5, x: 0, y: 0 }, PICTURE, STAGE)).toBe(NO_ZOOM);
  });

  it('caps the scale', () => {
    expect(clampZoom({ scale: 20, x: 0, y: 0 }, PICTURE, STAGE).scale).toBe(ZOOM_MAX);
  });

  it('keeps the picture edges outside the stage along an axis it overfills', () => {
    const left = clampZoom({ scale: 2, x: 100, y: 0 }, PICTURE, STAGE);
    expect(left.x).toBeCloseTo(0);
    const right = clampZoom({ scale: 2, x: -1000, y: 0 }, PICTURE, STAGE);
    // the picture's right edge, 800 px wide, on the stage's
    expect(right.x).toBe(-400);
  });

  it('centres the picture along an axis it still fits', () => {
    // 225 tall at 1.5 is 337.5, inside 400: centred, whatever the pan
    const state = clampZoom({ scale: 1.5, x: 0, y: 999 }, PICTURE, STAGE);
    expect(state.y).toBeCloseTo((400 - 337.5) / 2 - 87.5 * 1.5);
  });
});

describe('pinchZoom', () => {
  it('scales with the spread and keeps the point under the fingers under them', () => {
    const start = { state: NO_ZOOM, a: { x: 150, y: 200 }, b: { x: 250, y: 200 } };
    const state = pinchZoom(start, { a: { x: 100, y: 200 }, b: { x: 300, y: 200 } }, PICTURE, STAGE);
    expect(state.scale).toBeCloseTo(2);
    // the element point (200, 200) is still at (200, 200) on screen
    expect(200 * state.scale + state.x).toBeCloseTo(200);
    expect(200 * state.scale + state.y).toBeCloseTo(200);
  });

  it('pans by the fingers travel, from a zoom already in place', () => {
    const zoomed = { scale: 2, x: -200, y: -200 };
    const start = { state: zoomed, a: { x: 150, y: 200 }, b: { x: 250, y: 200 } };
    const state = pinchZoom(start, { a: { x: 120, y: 200 }, b: { x: 220, y: 200 } }, PICTURE, STAGE);
    expect(state.scale).toBeCloseTo(2);
    expect(state.x).toBeCloseTo(-230);
  });

  it('stops at the cap without sliding the picture', () => {
    const start = { state: NO_ZOOM, a: { x: 190, y: 200 }, b: { x: 210, y: 200 } };
    const state = pinchZoom(start, { a: { x: 0, y: 200 }, b: { x: 400, y: 200 } }, PICTURE, STAGE);
    expect(state.scale).toBe(ZOOM_MAX);
    expect(200 * state.scale + state.x).toBeCloseTo(200);
  });
});

describe('zoomTransform', () => {
  it('is nothing at 1 and a translate then scale otherwise', () => {
    expect(zoomTransform(NO_ZOOM)).toBe('');
    expect(zoomTransform({ scale: 2, x: -10, y: 5 })).toBe('translate(-10px, 5px) scale(2)');
  });
});
