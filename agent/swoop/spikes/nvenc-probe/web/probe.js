// swoop spike 0.9, measurement 1 (decoder half).
//
// The claim under test (plan.md D5, research/review-1-latency.md): an NVENC
// H.264 stream without `bitstreamRestrictionFlag = 1` / `max_num_reorder_frames
// = 0` makes Chrome's hardware decoder hold a full DPB before it emits the
// first frame — ~208 ms — and the flag drops that to ~8 ms.
//
// Method: submit access units one per 16.67 ms, the way a live stream arrives,
// and time each chunk from `decode()` to its `output` callback. Dumping the
// whole stream at once would measure throughput and hide the delay entirely.

const FPS = 60;
const FRAME_US = Math.round(1e6 / FPS);
const SETTLE_MS = 2000;

const logEl = document.getElementById('log');
const runEl = document.getElementById('run');

function log(text, cls) {
  const line = document.createElement('div');
  if (cls) line.className = cls;
  line.textContent = text;
  logEl.appendChild(line);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function waitUntil(targetMs) {
  const delay = targetMs - performance.now();
  return delay <= 0 ? Promise.resolve() : sleep(delay);
}

function percentile(sorted, q) {
  if (!sorted.length) return null;
  return sorted[Math.round((sorted.length - 1) * q)];
}

function summarise(samples) {
  const sorted = [...samples].sort((a, b) => a - b);
  return {
    n: sorted.length,
    p50_ms: percentile(sorted, 0.5),
    p95_ms: percentile(sorted, 0.95),
    mean_ms: sorted.length ? sorted.reduce((a, b) => a + b, 0) / sorted.length : null,
    max_ms: sorted.length ? sorted[sorted.length - 1] : null,
  };
}

async function loadStream(name) {
  const [buffer, index] = await Promise.all([
    fetch(`streams/${name}.h264`).then((r) => r.arrayBuffer()),
    fetch(`streams/${name}.json`).then((r) => r.json()),
  ]);
  const bytes = new Uint8Array(buffer);
  const chunks = [];
  let offset = 0;
  for (const frame of index.frames) {
    chunks.push({ data: bytes.subarray(offset, offset + frame.len), key: frame.key });
    offset += frame.len;
  }
  if (offset !== bytes.length) {
    throw new Error(`${name}: index covers ${offset} of ${bytes.length} bytes`);
  }
  return { index, chunks };
}

async function runOne(name, stream, optimizeForLatency) {
  const submittedAt = new Map();
  const latencies = [];
  let framesOut = 0;
  let decoderError = null;

  const decoder = new VideoDecoder({
    output(frame) {
      const now = performance.now();
      const started = submittedAt.get(frame.timestamp);
      if (started !== undefined) latencies.push(now - started);
      framesOut += 1;
      frame.close();
    },
    error(e) {
      decoderError = String(e);
    },
  });

  const config = {
    codec: stream.index.codec,
    codedWidth: stream.index.width,
    codedHeight: stream.index.height,
    hardwareAcceleration: 'prefer-hardware',
    optimizeForLatency,
  };
  const support = await VideoDecoder.isConfigSupported(config);
  decoder.configure(config);

  const submitGaps = [];
  let previousSubmit = null;
  const start = performance.now();
  for (let i = 0; i < stream.chunks.length; i += 1) {
    await waitUntil(start + (i * 1000) / FPS);
    const chunk = stream.chunks[i];
    const timestamp = i * FRAME_US;
    const submitNow = performance.now();
    if (previousSubmit !== null) submitGaps.push(submitNow - previousSubmit);
    previousSubmit = submitNow;
    submittedAt.set(timestamp, submitNow);
    decoder.decode(
      new EncodedVideoChunk({
        type: chunk.key ? 'key' : 'delta',
        timestamp,
        data: chunk.data,
      }),
    );
    if (decoderError) break;
  }

  await sleep(SETTLE_MS);
  const framesOutBeforeFlush = framesOut;
  const beforeFlush = summarise(latencies);
  try {
    // Bounded: a decoder that never finishes flushing must not take the whole
    // measurement down with it, and "flush hung" is itself a result.
    await Promise.race([
      decoder.flush(),
      sleep(10000).then(() => Promise.reject(new Error('flush timed out after 10 s'))),
    ]);
  } catch (e) {
    decoderError = String(e);
  }
  const framesOutAfterFlush = framesOut;
  try {
    decoder.close();
  } catch (e) {
    decoderError = decoderError ?? String(e);
  }

  const result = {
    stream: name,
    optimize_for_latency: optimizeForLatency,
    config_supported: support.supported === true,
    chunks_in: stream.chunks.length,
    frames_out_before_flush: framesOutBeforeFlush,
    frames_out_after_flush: framesOutAfterFlush,
    frames_held_at_end_of_stream: stream.chunks.length - framesOutBeforeFlush,
    submit_to_output_before_flush: beforeFlush,
    // If the tab were throttled the submit interval would not be ~16.7 ms, and
    // every latency number above would be measuring the wrong thing.
    submit_interval: summarise(submitGaps),
    decoder_error: decoderError,
  };
  log(
    `${name} optimizeForLatency=${optimizeForLatency}: ` +
      `in ${result.chunks_in}, out ${result.frames_out_before_flush} ` +
      `(held ${result.frames_held_at_end_of_stream}), ` +
      `p50 ${beforeFlush.p50_ms?.toFixed(1)} ms, p95 ${beforeFlush.p95_ms?.toFixed(1)} ms`,
    decoderError ? 'err' : 'ok',
  );
  if (decoderError) log(`  decoder error: ${decoderError}`, 'err');
  return result;
}

async function main() {
  runEl.disabled = true;
  logEl.textContent = '';
  try {
    if (typeof VideoDecoder === 'undefined') {
      throw new Error('this browser has no WebCodecs VideoDecoder');
    }
    const manifest = await fetch('streams/manifest.json').then((r) => r.json());
    const runs = [];
    for (const name of manifest.streams) {
      const stream = await loadStream(name);
      log(`${name}: ${stream.chunks.length} access units, codec ${stream.index.codec}`);
      for (const optimize of [true, false]) {
        runs.push(await runOne(name, stream, optimize));
        // A logged beacon: the spike's only window into how far the page got,
        // and the gap that tells a hung run apart from a slow one. The server
        // 404s it and records the line.
        await fetch(`/progress?done=${encodeURIComponent(`${name}:${optimize}`)}`).catch(() => {});
        // Chrome releases a hardware decoder asynchronously after close();
        // starting the next configure() immediately can stall it.
        await sleep(1500);
      }
    }
    const report = {
      user_agent: navigator.userAgent,
      fps_submitted: FPS,
      settle_ms: SETTLE_MS,
      runs,
    };
    const response = await fetch('/report', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(report, null, 2),
    });
    log(
      response.ok ? 'posted results to the spike server; you can close this tab' : `POST failed: ${response.status}`,
      response.ok ? 'ok' : 'err',
    );
  } catch (e) {
    log(String(e), 'err');
    // Report failures too: a silent page and a page that never ran look the
    // same from the spike's side, and a pending measurement must not be
    // mistaken for one that produced nothing to say.
    await fetch('/report', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ error: String(e), stack: e && e.stack, user_agent: navigator.userAgent }, null, 2),
    }).catch(() => {});
  } finally {
    runEl.disabled = false;
  }
}

runEl.addEventListener('click', main);

// `?auto=1` lets the spike drive the whole measurement from one Chrome launch
// instead of needing a human to press the button.
if (new URLSearchParams(location.search).get('auto') === '1') {
  main();
}
