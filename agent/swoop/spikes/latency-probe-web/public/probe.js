// swoop spike 0.1 - latency harness, browser half: the probe.
//
// Four modes, selected with ?mode=. Every mode computes p50/p95 over its own
// series and POSTs the whole run to the local server, so a number never has to
// be read off a screen.
//
//   ?mode=clock&n=300&span=90000
//                             QPC <-> performance.now() offset, NTP-style;
//                             span spreads the exchanges over that many ms so
//                             the drift figure covers real wall time
//   ?mode=readback            which readback methods see the pixels a canvas
//                             just presented (review-1 F7)
//   ?mode=selfflip&n=150      renderer-visible instrument overhead: decide ->
//                             pixels readable, and what an rAF-scheduled probe
//                             would have reported instead
//   ?mode=clickflip           one flip per real click; the series the
//                             slow-motion camera pass is counted against
//
// Other parameters: &autorun=1 starts without a keypress, &post=0 suppresses
// the POST, &clock=http://127.0.0.1:17431 moves the QPC endpoint.
//
// Presentation rule this probe obeys, and the reason it exists (plan.md D17,
// review-1 F7): a desynchronized canvas is never read through drawImage into
// another canvas. Every sample here reads the renderer's own buffer.

const params = new URLSearchParams(location.search);
const MODE = params.get('mode') ?? 'readback';
const N = Number(params.get('n') ?? 150);
const AUTORUN = params.get('autorun') !== '0';
const POST = params.get('post') !== '0';
const CLOCK_ORIGIN = params.get('clock') ?? 'http://127.0.0.1:17431';
const SPAN_MS = Number(params.get('span') ?? 0);

const out = document.getElementById('out');
const stateEl = document.getElementById('state');
const modeEl = document.getElementById('mode');
const stage = document.getElementById('stage');
const canvas = document.getElementById('canvas');
const hint = document.getElementById('hint');

let log = '';
function say(line) {
  log += `${line}\n`;
  out.textContent = log;
}
function state(s) {
  stateEl.textContent = s;
}

// ---------------------------------------------------------------- statistics

function summarize(values) {
  const v = values.filter((x) => Number.isFinite(x)).slice().sort((a, b) => a - b);
  if (v.length === 0) return { n: 0, min: 0, p50: 0, p90: 0, p95: 0, p99: 0, max: 0, mean: 0, sd: 0 };
  const rank = (p) => v[Math.min(v.length, Math.max(1, Math.ceil((p / 100) * v.length))) - 1];
  const mean = v.reduce((a, b) => a + b, 0) / v.length;
  const sd = Math.sqrt(v.reduce((a, b) => a + (b - mean) ** 2, 0) / v.length);
  return {
    n: v.length,
    min: v[0],
    p50: rank(50),
    p90: rank(90),
    p95: rank(95),
    p99: rank(99),
    max: v[v.length - 1],
    mean,
    sd,
  };
}

function table(rows) {
  const head = 'series                            n      min      p50      p90      p95      p99      max     mean       sd';
  const lines = rows.map(([label, s]) =>
    `${label.padEnd(28)} ${String(s.n).padStart(5)} ${[s.min, s.p50, s.p90, s.p95, s.p99, s.max, s.mean, s.sd]
      .map((x) => x.toFixed(2).padStart(8))
      .join(' ')}`
  );
  return [head, ...lines].join('\n');
}

// ------------------------------------------------------------------ metadata

/// Smallest non-zero step `performance.now()` will report. Every browser-side
/// number in this harness is quantised by it, so it is recorded with every run.
function clockGranularityMs() {
  let smallest = Infinity;
  for (let i = 0; i < 200000; i += 1) {
    const a = performance.now();
    const b = performance.now();
    const d = b - a;
    if (d > 0 && d < smallest) smallest = d;
  }
  return Number.isFinite(smallest) ? smallest : 0;
}

function metadata() {
  return {
    userAgent: navigator.userAgent,
    timeOrigin: performance.timeOrigin,
    devicePixelRatio: window.devicePixelRatio,
    screen: { width: screen.width, height: screen.height, colorDepth: screen.colorDepth },
    inner: { width: innerWidth, height: innerHeight },
    crossOriginIsolated: self.crossOriginIsolated === true,
    performanceNowGranularityMs: clockGranularityMs(),
    startedAt: new Date().toISOString(),
  };
}

// A run whose window was hidden is not a measurement: rAF does not fire in a
// hidden tab and setTimeout is throttled to 1 Hz.
let everHidden = document.visibilityState !== 'visible';
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState !== 'visible') everHidden = true;
});

async function publish(result) {
  result.everHidden = everHidden;
  if (everHidden) say('WARNING: the window was hidden during this run - the numbers are throttled, not measured');
  if (!POST) return;
  try {
    const res = await fetch('/result', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(result),
    });
    const body = await res.json();
    say(`posted: ${body.written ?? JSON.stringify(body)}`);
  } catch (err) {
    say(`POST failed: ${err}`);
  }
}

// -------------------------------------------------------------- mode: clock
//
// Four-timestamp NTP exchange against latency-target's /qpc endpoint:
//
//   t0  performance.now() before the request
//   t1  QPC when the server had read the request line
//   t2  QPC just before the server wrote the response
//   t3  performance.now() when the response resolved
//
//   offset = ((t1 - t0) + (t2 - t3)) / 2      qpc_ms ~= performance.now() + offset
//   delay  = (t3 - t0) - (t2 - t1)            round trip with server time removed
//
// The estimate reported is the offset of the minimum-delay exchange (NTP's own
// filter), because that is the sample with the least room for path asymmetry.
// Its error is bounded by +/- delay/2.

async function runClock() {
  const url = `${CLOCK_ORIGIN}/qpc`;
  say(`clock endpoint: ${url}`);
  const samples = [];
  // Warm the connection so the measured series is not dominated by the TCP
  // handshake of its first exchange.
  for (let i = 0; i < 10; i += 1) {
    try {
      await (await fetch(url, { cache: 'no-store' })).json();
    } catch (err) {
      say(`clock endpoint unreachable: ${err}`);
      say('start it with:  latency-target.exe clock --seconds 180');
      return;
    }
  }
  // Spreading the exchanges over wall time is what makes the drift figure
  // mean anything: 400 back-to-back exchanges finish in a quarter of a second,
  // over which no drift is resolvable.
  const gapMs = SPAN_MS > 0 ? SPAN_MS / Math.max(1, N - 1) : 0;
  for (let i = 0; i < N; i += 1) {
    const t0 = performance.now();
    const res = await fetch(url, { cache: 'no-store' });
    const t3 = performance.now();
    const j = await res.json();
    samples.push({
      t0,
      t1: j.t1_ms,
      t2: j.t2_ms,
      t3,
      delay: t3 - t0 - (j.t2_ms - j.t1_ms),
      offset: ((j.t1_ms - t0) + (j.t2_ms - t3)) / 2,
      serverMs: j.t2_ms - j.t1_ms,
    });
    if (i % 25 === 0) state(`clock ${i}/${N}`);
    if (gapMs > 0 && i < N - 1) await new Promise((done) => setTimeout(done, gapMs));
  }

  const best = samples.reduce((a, b) => (b.delay < a.delay ? b : a));
  const third = Math.max(1, Math.floor(samples.length / 3));
  const head = samples.slice(0, third).reduce((a, b) => (b.delay < a.delay ? b : a));
  const tail = samples.slice(-third).reduce((a, b) => (b.delay < a.delay ? b : a));
  const elapsedMs = tail.t3 - head.t0;
  const driftMs = tail.offset - head.offset;

  const result = {
    mode: 'clock',
    meta: metadata(),
    clockOrigin: CLOCK_ORIGIN,
    spanMs: SPAN_MS,
    n: samples.length,
    offsetMs: best.offset,
    offsetUncertaintyMs: best.delay / 2,
    offsetMedianMs: summarize(samples.map((s) => s.offset)).p50,
    drift: { elapsedMs, driftMs, ppm: elapsedMs > 0 ? (driftMs / elapsedMs) * 1e6 : 0 },
    delay: summarize(samples.map((s) => s.delay)),
    serverResidence: summarize(samples.map((s) => s.serverMs)),
    offsetSpread: summarize(samples.map((s) => s.offset)),
    samples,
  };

  say('');
  say(`qpc_ms = performance.now() + ${best.offset.toFixed(4)} ms   (+/- ${(best.delay / 2).toFixed(4)} ms)`);
  say(`n=${samples.length}  minimum-delay exchange selected; median offset ${result.offsetMedianMs.toFixed(4)} ms`);
  say(`drift over ${(elapsedMs / 1000).toFixed(1)} s: ${driftMs.toFixed(4)} ms (${result.drift.ppm.toFixed(2)} ppm)`);
  say('');
  say(
    table([
      ['round trip (delay)', result.delay],
      ['server residence t2-t1', result.serverResidence],
      ['offset spread', result.offsetSpread],
    ])
  );
  await publish(result);
  state('done');
}

// ----------------------------------------------------------- mode: readback
//
// review-1 F7 says a desynchronized canvas "reads back empty through
// drawImage". Every later measurement in this project depends on knowing which
// readback methods are honest, so this settles it on the browser in front of us
// instead of inheriting it.

/// `mounted` matters: the `desynchronized` hint only has an effect on a canvas
/// the compositor actually presents, so a detached canvas tests nothing.
/// `presented` matters too: F7's claim is about pixels that have been handed to
/// the compositor, so those cases read one animation frame after the draw.
async function readbackCase({ label, mounted, presented, make, draw, read }) {
  const c = document.createElement('canvas');
  c.width = 64;
  c.height = 64;
  if (mounted) {
    c.style.cssText = 'position:fixed;left:8px;top:120px;width:64px;height:64px;z-index:5';
    document.body.appendChild(c);
  }
  let ctx;
  try {
    ctx = make(c);
  } catch (err) {
    c.remove();
    return { label, mounted, presented, error: String(err) };
  }
  if (!ctx) {
    c.remove();
    return { label, mounted, presented, error: 'context unavailable' };
  }
  const timings = [];
  let pixel = null;
  for (let i = 0; i < 60; i += 1) {
    draw(ctx, c);
    if (presented) {
      // Two frames: one to present the draw, one to be sure it is on screen.
      await new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done)));
    }
    const t0 = performance.now();
    pixel = read(ctx, c);
    timings.push(performance.now() - t0);
  }
  c.remove();
  return { label, mounted, presented, pixel: Array.from(pixel ?? []), readMs: summarize(timings) };
}

async function runReadback() {
  const scratch = document.createElement('canvas');
  scratch.width = 64;
  scratch.height = 64;
  const scratchCtx = scratch.getContext('2d', { willReadFrequently: true });

  const fillRed2d = (ctx, c) => {
    ctx.fillStyle = '#ff0000';
    ctx.fillRect(0, 0, c.width, c.height);
  };
  const readOwn2d = (ctx) => ctx.getImageData(32, 32, 1, 1).data;
  const readViaDrawImage = (_ctx, c) => {
    scratchCtx.clearRect(0, 0, scratch.width, scratch.height);
    scratchCtx.drawImage(c, 0, 0);
    return scratchCtx.getImageData(32, 32, 1, 1).data;
  };
  const clearRedGl = (gl) => {
    gl.clearColor(1, 0, 0, 1);
    gl.clear(gl.COLOR_BUFFER_BIT);
  };
  const readGl = (gl) => {
    const px = new Uint8Array(4);
    gl.readPixels(32, 32, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, px);
    return px;
  };

  const ctx2d = (desync) => (c) => c.getContext('2d', { desynchronized: desync });
  const ctxGl = (desync) => (c) => c.getContext('webgl2', { desynchronized: desync, preserveDrawingBuffer: true });

  const plan = [];
  for (const mounted of [false, true]) {
    for (const presented of mounted ? [false, true] : [false]) {
      const where = `${mounted ? 'in-dom ' : 'detached'}${presented ? '+presented' : '         '}`;
      for (const desync of [true, false]) {
        const d = desync ? 'desync=1' : 'desync=0';
        plan.push({ label: `${where} 2d     ${d} getImageData`, mounted, presented, make: ctx2d(desync), draw: fillRed2d, read: readOwn2d });
        plan.push({ label: `${where} 2d     ${d} drawImage`, mounted, presented, make: ctx2d(desync), draw: fillRed2d, read: readViaDrawImage });
        plan.push({ label: `${where} webgl2 ${d} readPixels`, mounted, presented, make: ctxGl(desync), draw: clearRedGl, read: readGl });
        plan.push({ label: `${where} webgl2 ${d} drawImage`, mounted, presented, make: ctxGl(desync), draw: clearRedGl, read: readViaDrawImage });
      }
    }
  }

  const cases = [];
  for (const spec of plan) {
    state(`readback ${cases.length + 1}/${plan.length}`);
    cases.push(await readbackCase(spec));
  }

  const result = { mode: 'readback', meta: metadata(), expectedPixel: [255, 0, 0, 255], cases };
  say('expected pixel: 255,0,0,255');
  say('');
  for (const c of cases) {
    if (c.error) {
      say(`${c.label.padEnd(48)} ERROR ${c.error}`);
      continue;
    }
    const ok = c.pixel[0] === 255 && c.pixel[1] === 0 && c.pixel[2] === 0 && c.pixel[3] === 255;
    say(`${c.label.padEnd(48)} ${ok ? 'OK   ' : 'WRONG'} pixel=${c.pixel.join(',')}  read p50=${c.readMs.p50.toFixed(3)} ms p95=${c.readMs.p95.toFixed(3)} ms`);
  }
  await publish(result);
  state('done');
}

// ----------------------------------------------------------- flip machinery

function stageCanvas() {
  stage.classList.add('on');
  const dpr = window.devicePixelRatio || 1;
  canvas.width = Math.round(innerWidth * dpr);
  canvas.height = Math.round(innerHeight * dpr);
  // desynchronized is the presentation contract's choice (plan.md D17); the
  // readback below reads this canvas's own buffer, never through drawImage.
  const ctx = canvas.getContext('2d', { desynchronized: true, willReadFrequently: true, alpha: false });
  return ctx;
}

const COLOURS = ['#000000', '#ffffff'];

/// One flip: fill, then read the renderer's own pixels back until they carry
/// the new colour. Returns the timestamps around it.
function flip(ctx, index, decideMs) {
  ctx.fillStyle = COLOURS[index];
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  const drawnMs = performance.now();
  const want = index === 1 ? 255 : 0;
  let readbackMs = drawnMs;
  let reads = 0;
  let pixel = null;
  // A single read is normally enough; the loop is bounded so a context that
  // never reflects the fill cannot hang the run.
  for (; reads < 8; reads += 1) {
    pixel = ctx.getImageData(canvas.width >> 1, canvas.height >> 1, 1, 1).data;
    readbackMs = performance.now();
    if (pixel[0] === want) break;
  }
  return { drawnMs, readbackMs, reads: reads + 1, pixel: pixel ? pixel[0] : -1 };
}

// -------------------------------------------------------- mode: selfflip
//
// The instrument measuring itself: from the moment the probe decides to flip to
// the moment those pixels are readable in the renderer. That difference is the
// probe's own overhead and has to be subtracted from, or at least stated
// alongside, every renderer-visible number this harness ever reports.
//
// It also records what a requestAnimationFrame-scheduled probe would have
// reported for the same flip, which is the quantisation the moonlight-web
// numbers in review-1 F3 carry.

/// The display's frame period as the browser sees it, from a continuous
/// requestAnimationFrame burst. It is the quantum an rAF-scheduled *sampler*
/// adds to any observation: an event arriving at a time uncorrelated with the
/// frame boundary is seen U(0, period) later, so mean period/2.
function rafBurst(frames) {
  return new Promise((done) => {
    const stamps = [];
    const step = (ts) => {
      stamps.push(ts);
      if (stamps.length <= frames) requestAnimationFrame(step);
      else done(stamps.slice(1).map((t, i) => t - stamps[i]));
    };
    requestAnimationFrame(step);
  });
}

async function runSelfflip() {
  const rafPeriod = summarize(await rafBurst(180));
  const ctx = stageCanvas();
  hint.textContent = 'selfflip';
  const samples = [];
  const rafDeltas = [];
  let lastRaf = 0;

  for (let i = 0; i < N; i += 1) {
    const decideMs = performance.now();
    const f = flip(ctx, i % 2, decideMs);
    const rafMs = await new Promise((done) => requestAnimationFrame((ts) => done({ cb: performance.now(), ts })));
    if (lastRaf) rafDeltas.push(rafMs.ts - lastRaf);
    lastRaf = rafMs.ts;
    samples.push({
      i,
      decideMs,
      drawMs: f.drawnMs - decideMs,
      readbackMs: f.readbackMs - decideMs,
      rafCallbackMs: rafMs.cb - decideMs,
      rafTimestampMs: rafMs.ts - decideMs,
      reads: f.reads,
      pixel: f.pixel,
    });
    if (i % 25 === 0) state(`selfflip ${i}/${N}`);
    // Dithered, and not scheduled on rAF: a fixed cadence would sample one
    // phase of the display's refresh period over and over.
    await new Promise((done) => setTimeout(done, 40 + (i % 17)));
  }

  stage.classList.remove('on');
  const result = {
    mode: 'selfflip',
    meta: metadata(),
    n: samples.length,
    decideToDraw: summarize(samples.map((s) => s.drawMs)),
    decideToReadback: summarize(samples.map((s) => s.readbackMs)),
    decideToRafCallback: summarize(samples.map((s) => s.rafCallbackMs)),
    decideToRafTimestamp: summarize(samples.map((s) => s.rafTimestampMs)),
    rafPeriodContinuous: rafPeriod,
    rafIntervalInLoop: summarize(rafDeltas),
    readsPerFlip: summarize(samples.map((s) => s.reads)),
    wrongPixels: samples.filter((s) => s.pixel !== (s.i % 2 === 1 ? 255 : 0)).length,
    samples,
  };
  say(
    table([
      ['decide -> fillRect done', result.decideToDraw],
      ['decide -> pixels readable', result.decideToReadback],
      ['decide -> next rAF callback', result.decideToRafCallback],
      ['decide -> rAF timestamp', result.decideToRafTimestamp],
      ['rAF period (continuous)', result.rafPeriodContinuous],
      ['rAF interval (this loop)', result.rafIntervalInLoop],
      ['getImageData reads / flip', result.readsPerFlip],
    ])
  );
  say(`wrong pixels after readback: ${result.wrongPixels} of ${samples.length}`);
  await publish(result);
  state('done');
}

// -------------------------------------------------------- mode: clickflip
//
// One flip per real pointerdown, with the browser's own view of how old the
// event already was when JavaScript saw it. This is the series the slow-motion
// camera pass is counted against: the camera supplies the photon time, this
// supplies everything before it.

async function runClickflip() {
  const ctx = stageCanvas();
  hint.textContent = 'clickflip - click anywhere, Esc to finish';
  const samples = [];
  let index = 0;

  ctx.fillStyle = COLOURS[0];
  ctx.fillRect(0, 0, canvas.width, canvas.height);

  await new Promise((finish) => {
    const onKey = (e) => {
      if (e.key === 'Escape') {
        window.removeEventListener('pointerdown', onDown, true);
        window.removeEventListener('keydown', onKey, true);
        finish();
      }
    };
    const onDown = (e) => {
      const handlerMs = performance.now();
      index = (index + 1) % 2;
      const f = flip(ctx, index, handlerMs);
      samples.push({
        i: samples.length,
        eventTimeStampMs: e.timeStamp,
        handlerMs,
        eventAgeMs: handlerMs - e.timeStamp,
        drawMs: f.drawnMs - handlerMs,
        readbackMs: f.readbackMs - handlerMs,
        colour: index,
        pixel: f.pixel,
      });
      hint.textContent = `clickflip ${samples.length}${N ? ` / ${N}` : ''} - Esc to finish`;
      state(`clickflip ${samples.length}`);
      if (N && samples.length >= N) {
        window.removeEventListener('pointerdown', onDown, true);
        window.removeEventListener('keydown', onKey, true);
        finish();
      }
    };
    window.addEventListener('pointerdown', onDown, true);
    window.addEventListener('keydown', onKey, true);
  });

  stage.classList.remove('on');
  const result = {
    mode: 'clickflip',
    meta: metadata(),
    n: samples.length,
    eventAge: summarize(samples.map((s) => s.eventAgeMs)),
    handlerToDraw: summarize(samples.map((s) => s.drawMs)),
    handlerToReadback: summarize(samples.map((s) => s.readbackMs)),
    eventToReadback: summarize(samples.map((s) => s.eventAgeMs + s.readbackMs)),
    samples,
  };
  say(
    table([
      ['event -> handler (event age)', result.eventAge],
      ['handler -> fillRect done', result.handlerToDraw],
      ['handler -> pixels readable', result.handlerToReadback],
      ['event -> pixels readable', result.eventToReadback],
    ])
  );
  await publish(result);
  state('done');
}

// ------------------------------------------------------------------- driver

const MODES = {
  clock: runClock,
  readback: runReadback,
  selfflip: runSelfflip,
  clickflip: runClickflip,
};

async function main() {
  modeEl.textContent = `mode: ${MODE}`;
  log = '';
  const run = MODES[MODE];
  if (!run) {
    say(`unknown mode "${MODE}". one of: ${Object.keys(MODES).join(', ')}`);
    return;
  }
  if (!AUTORUN) {
    say('press any key to start');
    await new Promise((go) => window.addEventListener('keydown', go, { once: true }));
  }
  state('running');
  say(`${MODE}: n=${N}`);
  try {
    await run();
  } catch (err) {
    stage.classList.remove('on');
    say(`run failed: ${err && err.stack ? err.stack : err}`);
    state('failed');
  }
}

main();
