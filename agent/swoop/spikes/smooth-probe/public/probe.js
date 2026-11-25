// swoop-clarity task 2.5: the smooth-probe harness.
//
// measures the shipped smooth scaling renderer, web/lib/swoop/video/smooth.ts,
// which server.mjs serves as /smooth.js with its types stripped, never a copy,
// in whatever browser opens this page. a 2d canvas at the machine's size is
// painted every animation frame, encoded and decoded through webrtc (swoop's
// own receive path) and shown in a <video> laid out at the picture's box. with
// a cover, the renderer draws each presented frame over it from the video's
// rvfc chain, as the viewer does. after `seconds` it posts to server.mjs what
// the cover cost the video (rvfc callbacks, total and dropped frames), the
// main-thread time of each draw, and the gpu time per draw where the browser
// offers a timer query, plus the counters that say where a cost comes from
// (the frames each callback saw presented, the animation-frame cadence, and
// the webrtc receiver's own frame counts).
//
//   node server.mjs, then open (or let drive.mjs open)
//   http://127.0.0.1:17460/?source=1920x1080&box=1000x562&cover=canvas&seconds=5&label=edge-canvas
//
//   source=WxH       the machine's picture, 1920x1080 or 3840x2160 (default 1920x1080)
//   box=WxH          the picture's css box (default 1000x562)
//   cover=...        one of COVERS below (default none)
//   seconds=5        how long the counters run, once the picture is at full size
//   label=...        names the run file
//   allowSoftware=1  draws on a software renderer too; without it the canvas
//                    draws only where swoop's own smoothAvailable() would
//   role=both        the source and the picture in this page, over a same-page
//                    webrtc pair (the default, and task 2.5's numbers)
//   role=send        only the source and its sender: another browser's page
//                    receives it, as a viewer receives a remote machine
//   role=receive     only the picture, from a role=send page; drive.mjs passes
//                    the offer and answer through window.probeSignal
//   strip=1          with role=receive, paint the live barcode (latency mode);
//                    otherwise a receiver runs no animation-frame loop of its
//                    own, as swoop's viewer runs none today
//   raf=1            with role=receive, an animation-frame loop that changes
//                    nothing, as task 3.1's measuring double rAF after each
//                    draw would make the viewer run one
//   load=N, gpu=N    the cpu and gpu load drive.mjs read before the run, recorded as is
//
// the source and a dom strip under the picture both carry a barcode of
// Date.now() & 0xffff: a red start block, then 16 cells, black or white, most
// significant bit first, white for 1. a screenshot then holds two clocks, the
// one the picture shows and the page's live one (drive.mjs latency).
// clock.html loads this file for the same barcode and runs only the clock.

import { createSmoothRenderer, smoothAvailable, smoothRenderer } from '/smooth.js';

// every cover but none, canvas and under isolates one part of the canvas's
// cost or tries another way to draw (the cover investigation, 2026-11-09).
const COVERS = {
  none: 'the video alone',
  'none-raf': 'the video alone, on a page that repaints the dom strip every animation frame (a page that commits every frame)',
  canvas: 'smooth.ts on a webgl2 canvas over the visible video, drawn in the rvfc callback',
  under: 'canvas, with the video under it at opacity 0',
  'canvas-raf': 'canvas, but the rvfc callback only flags the frame and the next animation frame draws it',
  'canvas-static': 'canvas, drawn once and never again: what the extra layer alone costs',
  'canvas-clear': 'canvas, cleared to a new colour per callback and never uploading the video: what a canvas commit per frame costs',
  'draw-hidden': 'the full smooth.ts draw per callback on a canvas that is not in the page: the upload and pass without a layer',
  'canvas-opaque': 'canvas, on a context made with alpha false',
  'canvas-desync': 'canvas, on a context made with alpha false and desynchronized true',
  'canvas-desync-alpha': 'canvas, on a context made with desynchronized true and smooth.ts own alpha true',
  'canvas-vf': 'canvas, uploading new VideoFrame(video) instead of the element',
  'canvas-worker': 'smooth.ts in a worker on transferControlToOffscreen, sent new VideoFrame(video) from the rvfc callback',
  'canvas-poll': 'canvas, but an animation-frame loop draws whenever new VideoFrame(video) has a new timestamp (rvfc only counts): bends plan C2',
  webgpu: 'the same area average in webgpu from importExternalTexture, drawn in the rvfc callback, on an opaque canvas',
  'webgpu-alpha': 'webgpu, on a premultiplied canvas that is transparent outside the picture, as smooth.ts draws',
};

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

/** h.264 first on the sender's transceiver, where the browser offers it. */
function preferH264(pc, sender) {
  const transceiver = pc.getTransceivers().find((t) => t.sender === sender);
  const h264 = (RTCRtpReceiver.getCapabilities?.('video')?.codecs ?? []).filter((c) => /^video\/(h264|rtx)$/i.test(c.mimeType));
  if (h264.some((c) => /h264/i.test(c.mimeType)) && transceiver?.setCodecPreferences) {
    try {
      transceiver.setCodecPreferences(h264);
    } catch (err) {
      say(`setCodecPreferences refused h.264: ${err.message}`);
    }
  }
}

// chrome's encoder starts low and scales a big picture down to fit its
// bitrate; the probe measures the renderer on the source's own size.
async function holdResolution(sender) {
  const parameters = sender.getParameters();
  if (parameters.encodings?.[0]) parameters.encodings[0].maxBitrate = MAX_BITRATE;
  parameters.degradationPreference = 'maintain-resolution';
  await sender.setParameters(parameters).catch((err) => say(`setParameters: ${err.message}`));
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
  preferH264(send, sender);
  await send.setLocalDescription(await send.createOffer());
  await receive.setRemoteDescription(send.localDescription);
  await receive.setLocalDescription(await receive.createAnswer());
  await send.setRemoteDescription(receive.localDescription);
  await holdResolution(sender);
  return { send, receive, stream: await received };
}

/** the local description once ice gathering is done: drive.mjs passes whole descriptions, no trickle. */
async function gathered(pc) {
  const deadline = performance.now() + 5000;
  while (pc.iceGatheringState !== 'complete' && performance.now() < deadline) await sleep(20);
  return pc.localDescription.sdp;
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

const INBOUND = ['framesReceived', 'framesDecoded', 'framesDropped', 'keyFramesDecoded', 'freezeCount', 'totalFreezesDuration', 'totalInterFrameDelay', 'totalSquaredInterFrameDelay'];
const OUTBOUND = ['framesEncoded', 'framesSent'];

/** the receiver's and (in role=both) the sender's frame counters, to diff across the run. */
async function rtcCounters(receive, send) {
  const out = { inbound: null, outbound: null };
  (await receive.getStats()).forEach((r) => {
    if (r.type === 'inbound-rtp' && r.kind === 'video') out.inbound = Object.fromEntries(INBOUND.map((k) => [k, r[k] ?? 0]));
  });
  if (send) {
    (await send.getStats()).forEach((r) => {
      if (r.type === 'outbound-rtp' && r.kind === 'video') {
        out.outbound = { ...Object.fromEntries(OUTBOUND.map((k) => [k, r[k] ?? 0])), qualityLimitationReason: r.qualityLimitationReason ?? null };
      }
    });
  }
  return out;
}

function rtcDelta(before, after) {
  const diff = (b, a, keys) => (b && a ? Object.fromEntries(keys.map((k) => [k, a[k] - b[k]])) : null);
  const inbound = diff(before.inbound, after.inbound, INBOUND);
  if (inbound && inbound.framesDecoded > 1) {
    // the spread of the gaps between decoded frames: how evenly frames reach the renderer.
    const n = inbound.framesDecoded;
    const mean = inbound.totalInterFrameDelay / n;
    inbound.interFrameMs = mean * 1000;
    inbound.interFrameJitterMs = Math.sqrt(Math.max(0, inbound.totalSquaredInterFrameDelay / n - mean * mean)) * 1000;
  }
  const outbound = diff(before.outbound, after.outbound, OUTBOUND);
  if (outbound) outbound.qualityLimitationReason = after.outbound.qualityLimitationReason;
  return { inbound, outbound };
}

/** nearest rank, as spike 2.12's harness computes it. */
function summarize(values) {
  if (values.length === 0) return null;
  const v = values.slice().sort((a, b) => a - b);
  const rank = (p) => v[Math.min(v.length, Math.max(1, Math.ceil((p / 100) * v.length))) - 1];
  return { n: v.length, p50: rank(50), p95: rank(95), max: v[v.length - 1] };
}

/** a run of frame timestamps against the display's refresh: how many refreshes passed with no callback. */
function cadence(times) {
  if (times.length < 3) return null;
  const gaps = times.slice(1).map((t, i) => t - times[i]);
  const refresh = gaps.slice().sort((a, b) => a - b)[Math.floor(gaps.length / 2)];
  let skipped = 0;
  let longGaps = 0;
  for (const gap of gaps) {
    const refreshes = Math.round(gap / refresh);
    if (refreshes > 1) {
      longGaps += 1;
      skipped += refreshes - 1;
    }
  }
  return { count: times.length, refreshMs: refresh, longGaps, skipped };
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

// ------------------------------------------------------------------ covers

/** a gpu timer around each draw, where EXT_disjoint_timer_query_webgl2 is offered. */
function gpuTimer(gl) {
  const timer = gl?.getExtension('EXT_disjoint_timer_query_webgl2') ?? null;
  const pending = [];
  const gpuMs = [];
  return {
    available: Boolean(timer),
    gpuMs,
    pending,
    begin() {
      if (!timer) return null;
      const query = gl.createQuery();
      gl.beginQuery(timer.TIME_ELAPSED_EXT, query);
      return query;
    },
    end(query, counted) {
      if (!query) return;
      gl.endQuery(timer.TIME_ELAPSED_EXT);
      pending.push({ query, counted });
    },
    poll() {
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
    },
  };
}

/** the context smooth.ts will get: the first getContext on a canvas fixes its attributes. */
function precreate(canvas, attributes) {
  return canvas.getContext('webgl2', {
    alpha: true,
    premultipliedAlpha: true,
    antialias: false,
    depth: false,
    stencil: false,
    preserveDrawingBuffer: false,
    ...attributes,
  });
}

/**
 * every webgl2 cover on the main thread. `draw` runs in the rvfc callback (for
 * canvas-raf it is scheduled from it, and for canvas-poll an animation-frame
 * loop runs it whenever the video's current frame has changed).
 */
function webglCover(cover, canvas, video, width, height, notes, run) {
  if (cover === 'canvas-opaque') precreate(canvas, { alpha: false });
  if (cover === 'canvas-desync' || cover === 'canvas-desync-alpha') {
    const gl = precreate(canvas, { alpha: cover === 'canvas-desync-alpha', desynchronized: true });
    notes.push(`desynchronized granted: ${gl?.getContextAttributes?.().desynchronized ?? 'unknown'}`);
  }
  // draw-hidden draws on a canvas that never joins the page, so nothing is composited.
  const target = cover === 'draw-hidden' ? document.createElement('canvas') : canvas;
  if (cover === 'draw-hidden') canvas.remove();
  const renderer = createSmoothRenderer(target);
  if (!renderer) throw new Error('createSmoothRenderer returned null: no webgl2 here, or its shaders did not build');
  renderer.resize(width, height);
  const dest = { x: 0, y: 0, width, height };
  const gl = target.getContext('webgl2');
  const timer = gpuTimer(gl);
  const drawMs = [];
  let drawn = 0;
  let flagged = false;

  // smooth.ts reads the element's size; a VideoFrame names it display size.
  const asVideo = (frame) => Object.assign(frame, { videoWidth: frame.displayWidth, videoHeight: frame.displayHeight });

  const draw = (measuring, polled) => {
    if (renderer.lost || !video.videoWidth) return;
    const query = timer.begin();
    const start = performance.now();
    if (polled) {
      renderer.draw(asVideo(polled), dest);
    } else if (cover === 'canvas-vf') {
      const frame = new VideoFrame(video);
      renderer.draw(asVideo(frame), dest);
      frame.close();
    } else if (cover === 'canvas-clear' && drawn > 0) {
      gl.clearColor(drawn & 1 ? 0.2 : 0.1, 0.1, 0.1, 1);
      gl.clear(gl.COLOR_BUFFER_BIT);
    } else {
      renderer.draw(video, dest);
    }
    // a canvas outside the page is never composited, so nothing else flushes its commands.
    if (cover === 'draw-hidden') gl.flush();
    const took = performance.now() - start;
    timer.end(query, measuring);
    drawn += 1;
    if (measuring) drawMs.push(took);
  };

  if (cover === 'canvas-poll') {
    // the frame's own timestamp says whether the video moved on since the last draw.
    let last = null;
    const poll = () => {
      if (run.stopped()) return;
      if (video.videoWidth && !renderer.lost) {
        const frame = new VideoFrame(video);
        if (frame.timestamp !== last) {
          last = frame.timestamp;
          draw(run.measuring(), frame);
        }
        frame.close();
      }
      requestAnimationFrame(poll);
    };
    requestAnimationFrame(poll);
  }

  return {
    timer,
    lost: () => renderer.lost,
    onPresented(measuring) {
      if (cover === 'canvas-poll') return;
      if (cover === 'canvas-static' && drawn > 0) return;
      if (cover === 'canvas-raf') {
        if (!flagged) {
          flagged = true;
          requestAnimationFrame(() => {
            flagged = false;
            draw(measuring());
          });
        }
        return;
      }
      draw(measuring());
    },
    poll: () => timer.available && timer.poll(),
    async finish() {
      return { drawMs: summarize(drawMs), gpuMs: timer.available ? summarize(timer.gpuMs) : null, gpuTimer: timer.available, draws: drawMs.length, drawsTotal: drawn };
    },
  };
}

/** smooth.ts in a worker, on the canvas's offscreen control, fed a VideoFrame per callback. */
async function workerCover(canvas, video, width, height) {
  const offscreen = canvas.transferControlToOffscreen();
  const worker = new Worker('/worker.js', { type: 'module' });
  const replies = [];
  const reply = () => new Promise((resolve) => replies.push(resolve));
  worker.onmessage = ({ data }) => replies.shift()?.(data);
  worker.onerror = (e) => say(`WORKER ERROR: ${e.message}`);
  const ready = reply();
  worker.postMessage({ kind: 'init', canvas: offscreen, width, height }, [offscreen]);
  const { ok, error } = await ready;
  if (!ok) throw new Error(`worker renderer: ${error}`);
  const postMs = [];
  let posted = 0;
  return {
    lost: () => false,
    onPresented(measuring) {
      if (!video.videoWidth) return;
      const start = performance.now();
      const frame = new VideoFrame(video);
      const counted = measuring();
      worker.postMessage({ kind: 'frame', frame, counted }, [frame]);
      posted += 1;
      if (counted) postMs.push(performance.now() - start);
    },
    poll() {},
    async finish() {
      const report = reply();
      worker.postMessage({ kind: 'report' });
      const { drawMs, draws } = await report;
      worker.terminate();
      // drawMs is the main thread's cost (the VideoFrame and the post); the worker's own draw is workerDrawMs.
      return { drawMs: summarize(postMs), workerDrawMs: summarize(drawMs), gpuMs: null, gpuTimer: false, draws, drawsTotal: posted };
    },
  };
}

/** the area average in webgpu from an external texture (gpu.js). */
async function webgpuCover(canvas, video, width, height, opaque) {
  const { createGpuSmoothRenderer } = await import('/gpu.js');
  const renderer = await createGpuSmoothRenderer(canvas, width, height, { opaque });
  const drawMs = [];
  let drawn = 0;
  return {
    lost: () => renderer.lost,
    onPresented(measuring) {
      if (renderer.lost || !video.videoWidth) return;
      const start = performance.now();
      renderer.draw(video);
      drawn += 1;
      if (measuring()) drawMs.push(performance.now() - start);
    },
    poll() {},
    async finish() {
      return { drawMs: summarize(drawMs), gpuMs: null, gpuTimer: false, draws: drawMs.length, drawsTotal: drawn, adapter: renderer.adapter };
    },
  };
}

// --------------------------------------------------------------------- probe

/** role=send: the source and its sender, until the page is closed. */
async function sendOnly(width, height, state) {
  document.getElementById('picture').remove();
  const source = makeSource(width, height);
  const send = new RTCPeerConnection();
  const sender = send.addTrack(source.canvas.captureStream(60).getVideoTracks()[0]);
  preferH264(send, sender);
  window.probeSignal = {
    async offer() {
      await send.setLocalDescription(await send.createOffer());
      return gathered(send);
    },
    async accept(sdp) {
      await send.setRemoteDescription({ type: 'answer', sdp });
      await holdResolution(sender);
    },
    async counters() {
      return (await rtcCounters(send, send)).outbound;
    },
  };
  const loop = () => {
    source.paint(Date.now());
    requestAnimationFrame(loop);
  };
  requestAnimationFrame(loop);
  state('sending');
}

async function probe() {
  const params = new URLSearchParams(location.search);
  const [width, height] = parseSize(params.get('source') ?? '1920x1080', 'source');
  const [boxW, boxH] = parseSize(params.get('box') ?? '1000x562', 'box');
  const cover = params.get('cover') ?? 'none';
  if (!(cover in COVERS)) throw new Error(`cover=${cover}: one of ${Object.keys(COVERS).join(', ')}`);
  const role = params.get('role') ?? 'both';
  if (!['both', 'send', 'receive'].includes(role)) throw new Error(`role=${role}: both, send or receive`);
  const seconds = Number(params.get('seconds') ?? 5);
  const label = params.get('label') ?? `probe-${cover}`;
  const allowSoftware = params.get('allowSoftware') === '1';
  const stripOn = role !== 'receive' || params.get('strip') === '1' || cover === 'none-raf';
  const stateEl = document.getElementById('state');
  const state = (text) => {
    stateEl.textContent = text;
  };
  if (role === 'send') return sendOnly(width, height, state);

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
  const paintStrip = stripOn
    ? makeStrip(document.getElementById('strip'), boxW / CELLS_PER_WIDTH, (width / CELLS_PER_WIDTH) * (boxH / height))
    : null;

  const rvfc = 'requestVideoFrameCallback' in HTMLVideoElement.prototype;
  if (!rvfc) notes.push('no requestVideoFrameCallback: no callbacks to count and nothing to draw from');
  const drawAllowed = smoothAvailable({ allowSoftware });
  const dpr = devicePixelRatio;
  const deviceW = Math.round(boxW * dpr);
  const deviceH = Math.round(boxH * dpr);
  let measuring = false;
  let stopped = false;
  const run = { measuring: () => measuring, stopped: () => stopped };
  let drawer = null;
  if (cover === 'none' || cover === 'none-raf') {
    canvas.remove();
  } else {
    if (!drawAllowed) notes.push('smoothAvailable() is false here, so swoop would not draw and the canvas stays hidden (allowSoftware=1 draws anyway)');
    if (cover === 'canvas-worker') drawer = await workerCover(canvas, video, deviceW, deviceH);
    else if (cover === 'webgpu' || cover === 'webgpu-alpha') drawer = await webgpuCover(canvas, video, deviceW, deviceH, cover === 'webgpu');
    else drawer = webglCover(cover, canvas, video, deviceW, deviceH, notes, run);
    if (cover === 'under') video.style.opacity = '0';
  }

  let send = null;
  let receive;
  let stream;
  let source = null;
  if (role === 'both') {
    source = makeSource(width, height);
    ({ send, receive, stream } = await loopback(source.canvas.captureStream(60).getVideoTracks()[0]));
  } else {
    receive = new RTCPeerConnection();
    const received = new Promise((resolve) => {
      receive.ontrack = (e) => resolve(new MediaStream([e.track]));
    });
    window.probeSignal = {
      async answer(sdp) {
        await receive.setRemoteDescription({ type: 'offer', sdp });
        await receive.setLocalDescription(await receive.createAnswer());
        return gathered(receive);
      },
    };
    state('waiting for the sender');
    stream = await received;
  }

  let callbacks = 0;
  let lastPresented = null;
  let presented = 0;
  let coalesced = 0;
  let maxPerCallback = 0;
  const callbackTimes = [];
  const callbackLagMs = [];
  const rafTimes = [];

  const onPresented = (now, metadata) => {
    if (stopped) return;
    if (measuring) {
      callbacks += 1;
      callbackTimes.push(now);
      if (lastPresented !== null) {
        const seen = metadata.presentedFrames - lastPresented;
        presented += seen;
        if (seen > 1) coalesced += 1;
        maxPerCallback = Math.max(maxPerCallback, seen);
      }
      if (metadata.presentationTime) callbackLagMs.push(now - metadata.presentationTime);
    }
    lastPresented = metadata.presentedFrames;
    drawer?.poll();
    if (drawer && drawAllowed && !drawer.lost()) drawer.onPresented(() => measuring);
    video.requestVideoFrameCallback(onPresented);
  };

  const loop = (t) => {
    if (stopped) return;
    if (measuring) rafTimes.push(t);
    const now = Date.now();
    source?.paint(now);
    paintStrip?.(now & 0xffff);
    requestAnimationFrame(loop);
  };

  state('connecting');
  video.srcObject = stream;
  // never awaited: play() settles on the first frame, which the paint loop below produces.
  video.play().catch(() => {});
  if (source || paintStrip || params.get('raf') === '1') requestAnimationFrame(loop);
  if (rvfc) video.requestVideoFrameCallback(onPresented);

  state('warming up');
  const deadline = performance.now() + 20000;
  while ((video.videoWidth !== width || video.videoHeight !== height) && performance.now() < deadline) await sleep(50);
  if (video.videoWidth !== width || video.videoHeight !== height) {
    notes.push(`the picture never reached ${width}x${height}; measured at ${video.videoWidth}x${video.videoHeight}`);
  }
  await sleep(WARMUP_MS);

  const before = video.getVideoPlaybackQuality?.() ?? null;
  const rtcBefore = await rtcCounters(receive, send);
  const measuredFrom = performance.now();
  measuring = true;
  state('measuring');
  await sleep(seconds * 1000);
  measuring = false;
  const after = video.getVideoPlaybackQuality?.() ?? null;
  const rtcAfter = await rtcCounters(receive, send);
  const measuredSeconds = (performance.now() - measuredFrom) / 1000;
  state('posting');
  // the last draws' timer queries resolve over the next frames.
  if (drawer?.timer?.available) {
    const until = performance.now() + 500;
    while (drawer.timer.pending.some((p) => p.counted) && performance.now() < until) await sleep(20);
  }
  const drawn = drawer ? await drawer.finish() : null;
  const { codec, decoder } = await receivedCodec(receive);
  stopped = true;
  send?.close();
  receive.close();
  stream.getTracks().forEach((t) => t.stop());
  if (hidden) notes.push('the page was hidden during the run, so its timers were throttled: not a measurement');

  const result = {
    label,
    cover,
    coverMeans: COVERS[cover],
    role,
    source: `${width}x${height}`,
    box: `${boxW}x${boxH}`,
    seconds: measuredSeconds,
    startedAt,
    cpuLoadAtStart: params.has('load') ? Number(params.get('load')) : null,
    gpuLoadAtStart: params.has('gpu') ? Number(params.get('gpu')) : null,
    userAgent: navigator.userAgent,
    userAgentData: navigator.userAgentData
      ? { brands: navigator.userAgentData.brands, mobile: navigator.userAgentData.mobile }
      : null,
    devicePixelRatio,
    smoothRenderer: smoothRenderer(),
    smoothAvailable: smoothAvailable(),
    smoothAvailableAllowingSoftware: smoothAvailable({ allowSoftware: true }),
    drew: Boolean(drawn?.drawsTotal),
    frame: `${video.videoWidth}x${video.videoHeight}`,
    codec,
    decoder,
    rvfcCallbacks: rvfc ? callbacks : null,
    totalVideoFrames: before && after ? after.totalVideoFrames - before.totalVideoFrames : null,
    droppedVideoFrames: before && after ? after.droppedVideoFrames - before.droppedVideoFrames : null,
    // what the callbacks saw: frames presented between them, and callbacks that saw more than one.
    presentedFrames: presented,
    coalescedCallbacks: coalesced,
    maxFramesPerCallback: maxPerCallback,
    callbackCadence: cadence(callbackTimes),
    callbackLagMs: summarize(callbackLagMs),
    rafCadence: cadence(rafTimes),
    rtc: rtcDelta(rtcBefore, rtcAfter),
    draws: drawn?.draws ?? null,
    drawMs: drawn?.drawMs ?? null,
    workerDrawMs: drawn?.workerDrawMs ?? null,
    gpuMs: drawn?.gpuMs ?? null,
    gpuTimer: drawn?.gpuTimer ?? false,
    gpuAdapter: drawn?.adapter ?? null,
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
