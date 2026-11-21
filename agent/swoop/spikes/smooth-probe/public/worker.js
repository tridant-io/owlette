// swoop-clarity: the smooth-probe's cover=canvas-worker. the shipped
// smooth.ts (served as /smooth.js, never a copy) draws in this worker on the
// cover canvas's offscreen control, so its frames reach the compositor without
// a main-thread commit. the page's rvfc callback sends each presented frame as
// a VideoFrame; the worker draws it at once and closes it, so the decoder's
// frame pool never waits on a queue here.

import { createSmoothRenderer } from '/smooth.js';

let renderer = null;
let dest = null;
const drawMs = [];
let draws = 0;

onmessage = ({ data }) => {
  if (data.kind === 'init') {
    const { canvas, width, height } = data;
    // smooth.ts shows and hides its canvas through `style`, which an OffscreenCanvas lacks.
    canvas.style = {};
    renderer = createSmoothRenderer(canvas);
    if (!renderer) {
      postMessage({ ok: false, error: 'createSmoothRenderer returned null on the offscreen canvas' });
      return;
    }
    renderer.resize(width, height);
    dest = { x: 0, y: 0, width, height };
    postMessage({ ok: true });
  } else if (data.kind === 'frame') {
    const { frame, counted } = data;
    if (renderer && !renderer.lost) {
      // smooth.ts reads the element's size; a VideoFrame names it display size.
      frame.videoWidth = frame.displayWidth;
      frame.videoHeight = frame.displayHeight;
      const start = performance.now();
      renderer.draw(frame, dest);
      if (counted) {
        drawMs.push(performance.now() - start);
        draws += 1;
      }
    }
    frame.close();
  } else if (data.kind === 'report') {
    postMessage({ drawMs, draws });
  }
};
