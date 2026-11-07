// swoop-clarity task 2.5: the smooth-probe harness.
//
// measures the shipped smooth scaling renderer, web/lib/swoop/video/smooth.ts,
// which server.mjs serves as /smooth.js with its types stripped, never a copy,
// in whatever browser opens this page. a 2d canvas at the machine's size is
// painted every animation frame, encoded and decoded through a same-page
// webrtc pair (swoop's own receive path) and shown in a <video> laid out at
// the picture's box. with a cover, the renderer draws each presented frame
// over it from the video's rvfc chain, as the viewer does. after `seconds` it
// posts to server.mjs what the cover cost the video (rvfc callbacks, total and
// dropped frames), the main-thread time of each draw, and the gpu time per
// draw where the browser offers a timer query.
//
//   node server.mjs, then open (or let drive.mjs open)
//   http://127.0.0.1:17460/?source=1920x1080&box=1000x562&cover=canvas&seconds=5&label=edge-canvas
//
//   source=WxH       the machine's picture, 1920x1080 or 3840x2160 (default 1920x1080)
//   box=WxH          the picture's css box (default 1000x562)
//   cover=none       the video alone
//   cover=canvas     an opaque webgl2 canvas over the visible video
//   cover=under      the same canvas, the video under it at opacity 0
//   seconds=5        how long the counters run, once the picture is at full size
//   label=...        names the run file
//   allowSoftware=1  draws on a software renderer too; without it the canvas
//                    draws only where swoop's own smoothAvailable() would
//
// the source and a dom strip under the picture both carry a barcode of
// Date.now() & 0xffff: a red start block, then 16 cells, black or white, most
// significant bit first, white for 1. a screenshot then holds two clocks, the
// one the picture shows and the page's live one (drive.mjs latency).
// clock.html loads this file for the same barcode and runs only the clock.

import { createSmoothRenderer, smoothAvailable, smoothRenderer } from '/smooth.js';

const BITS = 16;
// a cell is 1/24 of the source's width, so the barcode stays readable in a
// picture shown at a third of its size.
const CELLS_PER_WIDTH = 24;
// webrtc's bandwidth estimate starts low and climbs; the counters wait for it.
const WARMUP_MS = 3000;
// a cap, not a target: the loopback's own estimate sets the rate under it.
const MAX_BITRATE = 40_000_000;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const say = (line) => window.beacon?.(line);

function parseSize(text, name) {
  const match = /^(\d+)x(\d+)$/.exec(text);
  if (!match) throw new Error(`${name}=${text}: expected WxH`);
  return [Number(match[1]), Number(match[2])];
}

function bit(value, index) {
  return (value >> (BITS - 1 - index)) & 1;
}

/** the barcode as dom cells; returns a painter for a 16-bit value. */
function makeStrip(container, cellWidth, cellHeight) {
  const cells = [];
  for (let i = 0; i <= BITS; i += 1) {
    const cell = document.createElement('div');
    cell.style.cssText = `flex:none;width:${cellWidth}px;height:${cellHeight}px;background:${i ? '#000' : '#f00'}`;
    container.append(cell);
    if (i) cells.push(cell);
  }
  return (value) => {
    cells.forEach((cell, i) => {
      cell.style.background = bit(value, i) ? '#fff' : '#000';
    });
  };
}

function paintBarcode(ctx, x, y, cell, height, value) {
  ctx.fillStyle = '#f00';
  ctx.fillRect(x, y, cell, height);
  for (let i = 0; i < BITS; i += 1) {
    ctx.fillStyle = bit(value, i) ? '#fff' : '#000';
    ctx.fillRect(x + (i + 1) * cell, y, cell, height);
  }
}

/** the machine's screen: a moving block, a static band of thin strokes, and the barcode. */
function makeSource(width, height) {
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d', { alpha: false });
  const cell = width / CELLS_PER_WIDTH;
  const background = '#303030';
  ctx.fillStyle = background;
  ctx.fillRect(0, 0, width, height);

  // the static band, painted once: 1-px vertical and horizontal stripes, then 10 px text.
  const bandX = cell;
  const bandY = Math.round(height * 0.6);
  const stripeW = Math.round(width / 3);
  const stripeH = Math.round(height / 12);
  ctx.fillStyle = '#000';
  ctx.fillRect(bandX, bandY, stripeW * 2, stripeH);
  ctx.fillStyle = '#fff';
  for (let x = 0; x < stripeW; x += 2) ctx.fillRect(bandX + x, bandY, 1, stripeH);
  for (let y = 0; y < stripeH; y += 2) ctx.fillRect(bandX + stripeW, bandY + y, stripeW, 1);
  ctx.font = '10px sans-serif';
  ctx.textBaseline = 'top';
  for (let row = 0; row < 5; row += 1) {
    ctx.fillText(
      `${width}x${height} row ${row + 1}: the quick brown fox jumps over the lazy dog 0123456789 il1| mwMW`,
      bandX,
      bandY + stripeH + 12 + row * 14,
    );
  }

  const blockY = Math.round(cell * 3);
  const blockW = Math.round(width / 8);
  const blockH = Math.round(height / 4);
  const step = Math.round(width / 240);
  let tick = 0;
  return {
    canvas,
    paint(now) {
      ctx.fillStyle = background;
      ctx.fillRect(0, blockY, width, blockH);
      ctx.fillStyle = '#e8e8e8';
      ctx.fillRect((tick * step) % (width - blockW), blockY, blockW, blockH);
      tick += 1;
      paintBarcode(ctx, cell, cell, cell, cell, now & 0xffff);
    },
  };
}

/** a same-page webrtc pair carrying `track`, h.264 where the browser offers it. */
async function loopback(track) {
  const send = new RTCPeerConnection();
  const receive = new RTCPeerConnection();
  send.onicecandidate = (e) => e.candidate && receive.addIceCandidate(e.candidate);
  receive.onicecandidate = (e) => e.candidate && send.addIceCandidate(e.candidate);
  const received = new Promise((resolve) => {
    receive.ontrack = (e) => resolve(new MediaStream([e.track]));
  });
  const sender = send.addTrack(track);
  const transceiver = send.getTransceivers().find((t) => t.sender === sender);
  const h264 = (RTCRtpReceiver.getCapabilities?.('video')?.codecs ?? []).filter((c) => /^video\/(h264|rtx)$/i.test(c.mimeType));
  if (h264.some((c) => /h264/i.test(c.mimeType)) && transceiver?.setCodecPreferences) {
    try {
      transceiver.setCodecPreferences(h264);
    } catch (err) {
      say(`setCodecPreferences refused h.264: ${err.message}`);
    }
  }
  await send.setLocalDescription(await send.createOffer());
  await receive.setRemoteDescription(send.localDescription);
  await receive.setLocalDescription(await receive.createAnswer());
  await send.setRemoteDescription(receive.localDescription);
  // chrome's encoder starts low and scales a big picture down to fit its
  // bitrate; the probe measures the renderer on the source's own size.
  const parameters = sender.getParameters();
  if (parameters.encodings?.[0]) parameters.encodings[0].maxBitrate = MAX_BITRATE;
  parameters.degradationPreference = 'maintain-resolution';
  await sender.setParameters(parameters).catch((err) => say(`setParameters: ${err.message}`));
  return { send, receive, stream: await received };
}

async function receivedCodec(receive) {
  const report = await receive.getStats();
  const codecs = new Map();
  let codec = null;
  let decoder = null;
  report.forEach((r) => {
    if (r.type === 'codec') codecs.set(r.id, r.mimeType);
  });
  report.forEach((r) => {
    if (r.type === 'inbound-rtp' && r.kind === 'video') {
      codec = codecs.get(r.codecId) ?? null;
      decoder = r.decoderImplementation ?? null;
    }
  });
  return { codec, decoder };
}

/** nearest rank, as spike 2.12's harness computes it. */
function summarize(values) {
  if (values.length === 0) return null;
  const v = values.slice().sort((a, b) => a - b);
  const rank = (p) => v[Math.min(v.length, Math.max(1, Math.ceil((p / 100) * v.length))) - 1];
  return { n: v.length, p50: rank(50), p95: rank(95), max: v[v.length - 1] };
}

async function post(result) {
  try {
    const res = await fetch('/result', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(result),
    });
    say(`posted ${(await res.json()).written}`);
  } catch (err) {
    say(`POST failed: ${err}`);
  }
}

async function probe() {
  const params = new URLSearchParams(location.search);
  const [width, height] = parseSize(params.get('source') ?? '1920x1080', 'source');
  const [boxW, boxH] = parseSize(params.get('box') ?? '1000x562', 'box');
  const cover = params.get('cover') ?? 'none';
  if (!['none', 'canvas', 'under'].includes(cover)) throw new Error(`cover=${cover}: none, canvas or under`);
  const seconds = Number(params.get('seconds') ?? 5);
  const label = params.get('label') ?? `probe-${cover}`;
  const allowSoftware = params.get('allowSoftware') === '1';
  const stateEl = document.getElementById('state');
  const state = (text) => {
    stateEl.textContent = text;
  };
  let hidden = document.visibilityState !== 'visible';
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState !== 'visible') hidden = true;
  });
  const startedAt = new Date().toISOString();
  const notes = [];

  const picture = document.getElementById('picture');
  const video = document.getElementById('video');
  const canvas = document.getElementById('cover');
  picture.style.width = `${boxW}px`;
  picture.style.height = `${boxH}px`;
  // the dom strip's cells are the size the picture shows the source's cells at.
  const paintStrip = makeStrip(
    document.getElementById('strip'),
    boxW / CELLS_PER_WIDTH,
    (width / CELLS_PER_WIDTH) * (boxH / height),
  );

  const rvfc = 'requestVideoFrameCallback' in HTMLVideoElement.prototype;
  if (!rvfc) notes.push('no requestVideoFrameCallback: no callbacks to count and nothing to draw from');
  const drawAllowed = smoothAvailable({ allowSoftware });
  let renderer = null;
  let dest = null;
  if (cover === 'none') {
    canvas.remove();
  } else {
    renderer = createSmoothRenderer(canvas);
    if (!renderer) throw new Error('createSmoothRenderer returned null: no webgl2 here, or its shaders did not build');
    const dpr = devicePixelRatio;
    renderer.resize(Math.round(boxW * dpr), Math.round(boxH * dpr));
    dest = { x: 0, y: 0, width: canvas.width, height: canvas.height };
    if (cover === 'under') video.style.opacity = '0';
    if (!drawAllowed) notes.push('smoothAvailable() is false here, so swoop would not draw and the canvas stays hidden (allowSoftware=1 draws anyway)');
  }
  const gl = renderer ? canvas.getContext('webgl2') : null;
  const timer = gl?.getExtension('EXT_disjoint_timer_query_webgl2') ?? null;

  const source = makeSource(width, height);
  const { send, receive, stream } = await loopback(source.canvas.captureStream(60).getVideoTracks()[0]);

  let measuring = false;
  let stopped = false;
  let callbacks = 0;
  const drawMs = [];
  const gpuMs = [];
  const pending = [];

  const pollGpu = () => {
    while (pending.length && gl.getQueryParameter(pending[0].query, gl.QUERY_RESULT_AVAILABLE)) {
      // read after availability, as the extension's own example does: reading
      // clears the flag, and a disjoint voids every query still in flight.
      if (gl.getParameter(timer.GPU_DISJOINT_EXT)) {
        pending.splice(0).forEach(({ query }) => gl.deleteQuery(query));
        return;
      }
      const { query, counted } = pending.shift();
      if (counted) gpuMs.push(gl.getQueryParameter(query, gl.QUERY_RESULT) / 1e6);
      gl.deleteQuery(query);
    }
  };

  const onPresented = () => {
    if (stopped) return;
    if (measuring) callbacks += 1;
    if (renderer && drawAllowed && !renderer.lost) {
      const query = timer ? gl.createQuery() : null;
      if (query) gl.beginQuery(timer.TIME_ELAPSED_EXT, query);
      const start = performance.now();
      renderer.draw(video, dest);
      const took = performance.now() - start;
      if (query) {
        gl.endQuery(timer.TIME_ELAPSED_EXT);
        pending.push({ query, counted: measuring });
      }
      if (measuring) drawMs.push(took);
    }
    video.requestVideoFrameCallback(onPresented);
  };

  const loop = () => {
    if (stopped) return;
    const now = Date.now();
    source.paint(now);
    paintStrip(now & 0xffff);
    if (timer) pollGpu();
    requestAnimationFrame(loop);
  };

  state('connecting');
  video.srcObject = stream;
  // never awaited: play() settles on the first frame, which the paint loop below produces.
  video.play().catch(() => {});
  requestAnimationFrame(loop);
  if (rvfc) video.requestVideoFrameCallback(onPresented);

  state('warming up');
  const deadline = performance.now() + 20000;
  while ((video.videoWidth !== width || video.videoHeight !== height) && performance.now() < deadline) await sleep(50);
  if (video.videoWidth !== width || video.videoHeight !== height) {
    notes.push(`the picture never reached ${width}x${height}; measured at ${video.videoWidth}x${video.videoHeight}`);
  }
  await sleep(WARMUP_MS);

  const before = video.getVideoPlaybackQuality?.() ?? null;
  const measuredFrom = performance.now();
  measuring = true;
  state('measuring');
  await sleep(seconds * 1000);
  measuring = false;
  const after = video.getVideoPlaybackQuality?.() ?? null;
  const measuredSeconds = (performance.now() - measuredFrom) / 1000;
  state('posting');
  // the last draws' timer queries resolve over the next frames.
  if (timer) {
    const until = performance.now() + 500;
    while (pending.some((p) => p.counted) && performance.now() < until) await sleep(20);
  }
  const { codec, decoder } = await receivedCodec(receive);
  stopped = true;
  send.close();
  receive.close();
  stream.getTracks().forEach((t) => t.stop());
  if (hidden) notes.push('the page was hidden during the run, so its timers were throttled: not a measurement');

  const result = {
    label,
    cover,
    source: `${width}x${height}`,
    box: `${boxW}x${boxH}`,
    seconds: measuredSeconds,
    startedAt,
    userAgent: navigator.userAgent,
    userAgentData: navigator.userAgentData
      ? { brands: navigator.userAgentData.brands, mobile: navigator.userAgentData.mobile }
      : null,
    devicePixelRatio,
    smoothRenderer: smoothRenderer(),
    smoothAvailable: smoothAvailable(),
    smoothAvailableAllowingSoftware: smoothAvailable({ allowSoftware: true }),
    drew: drawMs.length > 0,
    frame: `${video.videoWidth}x${video.videoHeight}`,
    codec,
    decoder,
    rvfcCallbacks: rvfc ? callbacks : null,
    totalVideoFrames: before && after ? after.totalVideoFrames - before.totalVideoFrames : null,
    droppedVideoFrames: before && after ? after.droppedVideoFrames - before.droppedVideoFrames : null,
    drawMs: summarize(drawMs),
    gpuMs: timer ? summarize(gpuMs) : null,
    gpuTimer: Boolean(timer),
    hidden,
    notes,
  };
  window.probeResult = result;
  await post(result);
  state('done');
}

function clock() {
  const digits = document.getElementById('digits');
  const cell = Math.floor(innerWidth / CELLS_PER_WIDTH);
  const paintStrip = makeStrip(document.getElementById('strip'), cell, cell);
  const loop = () => {
    const now = Date.now();
    digits.textContent = String(now).slice(-6);
    paintStrip(now & 0xffff);
    requestAnimationFrame(loop);
  };
  requestAnimationFrame(loop);
}

if (document.body.dataset.page === 'clock') {
  clock();
} else {
  probe().catch(async (err) => {
    const label = new URLSearchParams(location.search).get('label') ?? 'probe';
    window.probeResult = { label, error: String(err?.message ?? err), userAgent: navigator.userAgent };
    document.getElementById('state').textContent = `error: ${err?.message ?? err}`;
    say(`PROBE FAILED: ${err?.stack ?? err}`);
    await post(window.probeResult);
  });
}
