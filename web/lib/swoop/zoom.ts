/**
 * swoop's local zoom: the picture scaled and panned on this screen only.
 *
 * the host never hears of it. its feedback viewport is stats that nothing
 * acts on, and input needs nothing of its own: the zoom is a transform on the
 * `<video>`, and `contentRect()` measures the video's transformed box, so a
 * touch normalises over the picture as it is on screen.
 *
 * the transform is `translate(x, y) scale(s)` about the element's top left,
 * in the stage's css pixels. the picture inside the element is letterboxed,
 * so the clamps work on the picture's box, not the element's: zoomed past the
 * stage, the picture's edges never come inside it; narrower than the stage
 * along an axis, it sits in the middle of that axis.
 *
 * "stage" here is where the picture is shown: the video's layout box, which
 * is the stage's own except while the phone keyboard pads the stage, and
 * then the part the keyboard leaves.
 */

export const ZOOM_MAX = 5;

export interface ZoomState {
  scale: number;
  x: number;
  y: number;
}

export const NO_ZOOM: ZoomState = { scale: 1, x: 0, y: 0 };

export interface Point {
  x: number;
  y: number;
}

export interface Size {
  width: number;
  height: number;
}

/** a box in the element's own css pixels, before any transform. */
export interface Box {
  left: number;
  top: number;
  width: number;
  height: number;
}

/** the letterboxed picture inside an element of `element` size, for a frame of `frame` size. */
export function fitBox(element: Size, frame: Size): Box {
  if (frame.width <= 0 || frame.height <= 0) return { left: 0, top: 0, ...element };
  const scale = Math.min(element.width / frame.width, element.height / frame.height);
  const width = frame.width * scale;
  const height = frame.height * scale;
  return { left: (element.width - width) / 2, top: (element.height - height) / 2, width, height };
}

const clampAxis = (offset: number, scale: number, start: number, length: number, stage: number): number => {
  const span = length * scale;
  if (span <= stage) return (stage - span) / 2 - start * scale;
  return Math.min(-start * scale, Math.max(stage - (start + length) * scale, offset));
};

export function clampZoom(state: ZoomState, picture: Box, stage: Size): ZoomState {
  const scale = Math.min(ZOOM_MAX, Math.max(1, state.scale));
  // at 1 the picture is where the letterbox put it, whatever the pan said
  if (scale === 1) return NO_ZOOM;
  return {
    scale,
    x: clampAxis(state.x, scale, picture.left, picture.width, stage.width),
    y: clampAxis(state.y, scale, picture.top, picture.height, stage.height),
  };
}

export const distance = (a: Point, b: Point): number => Math.hypot(a.x - b.x, a.y - b.y);
export const midpoint = (a: Point, b: Point): Point => ({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 });

/**
 * a pinch from two fingers' starting points to where they are now, in the
 * stage's coordinates: the scale follows their spread, and the picture point
 * that was under their midpoint stays under it, so their travel pans.
 */
export function pinchZoom(
  start: { state: ZoomState; a: Point; b: Point },
  now: { a: Point; b: Point },
  picture: Box,
  stage: Size,
): ZoomState {
  const spread = distance(start.a, start.b);
  const ratio = spread > 0 ? distance(now.a, now.b) / spread : 1;
  // clamped before the pan is worked out, or a pinch past the limit slides the picture
  const scale = Math.min(ZOOM_MAX, Math.max(1, start.state.scale * ratio));
  const from = midpoint(start.a, start.b);
  const to = midpoint(now.a, now.b);
  // the element point under the fingers' first midpoint
  const anchor = { x: (from.x - start.state.x) / start.state.scale, y: (from.y - start.state.y) / start.state.scale };
  return clampZoom({ scale, x: to.x - anchor.x * scale, y: to.y - anchor.y * scale }, picture, stage);
}

export const zoomTransform = (state: ZoomState): string =>
  state.scale === 1 ? '' : `translate(${state.x}px, ${state.y}px) scale(${state.scale})`;
