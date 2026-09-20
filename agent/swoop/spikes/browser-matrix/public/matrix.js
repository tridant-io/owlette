// swoop spike 2.12 - browser support matrix, the whole harness.
//
//   ?mode=auto       caps, decode, fp, readback, stall - everything that needs no gesture
//   ?mode=caps       isConfigSupported / getCapabilities / decodingInfo, plus feature presence
//   ?mode=decode     a real decode of the canned chunks (support claims and real decode disagree)
//   ?mode=stall      the static-desktop decoder stall, webcodecs and loopback-rtp arms, with and
//                    without the host floor-frame-rate workaround
//   ?mode=soak       one decoding window; launch 2/4/6/8 of them to find the decoder ceiling
//   ?mode=fp         RTCCertificate.getFingerprints() and the a=fingerprint fallback
//   ?mode=readback   spike 0.1 §6's review-1 F7 re-test on this browser
//   ?mode=perms      keyboard lock, pointer lock unadjustedMovement, clipboard - needs clicks
//
//   &label=chrome-win   names the run file. &n= sets a mode's sample count where it has one.
//   &idx= &group=       soak only: which window this is and which soak it belongs to.
//   &stream=h264-1080p  which canned stream a mode uses where it takes one.
//   &autorun=1          start without a click. &post=0 keeps the result off the server.
//
// What this harness deliberately does NOT do: it never infers one browser's
// behaviour from another's, and every number it writes carries the n it came
// from. A cell nobody ran stays empty in the memo.

const params = new URLSearchParams(location.search);
const MODE = params.get('mode') ?? 'auto';
const LABEL = params.get('label') ?? 'unlabelled';
const AUTORUN = params.get('autorun') === '1';
const POST = params.get('post') !== '0';
const STREAM = params.get('stream') ?? 'h264-1080p';
const IDX = Number(params.get('idx') ?? 0);
const GROUP = params.get('group') ?? '';
const SECS = Number(params.get('secs') ?? 30);

const out = document.getElementById('out');
const stateEl = document.getElementById('state');
const presentEl = document.getElementById('present');
const sourceEl = document.getElementById('source');
const videoEl = document.getElementById('stage');
const gesturesEl = document.getElementById('gestures');

const say = (line) => window.beacon(line);
const state = (s) => { stateEl.textContent = s; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const waitUntil = (targetMs) => sleep(Math.max(0, targetMs - performance.now()));

// ---------------------------------------------------------------- statistics
// Same nearest-rank definition as spikes 0.1 and 0.2, so figures from the three
// harnesses are comparable.

function summarize(values) {
  const v = values.filter((x) => Number.isFinite(x)).slice().sort((a, b) => a - b);
  if (v.length === 0) return { n: 0, min: 0, p50: 0, p90: 0, p95: 0, p99: 0, max: 0, mean: 0, sd: 0 };
  const rank = (p) => v[Math.min(v.length, Math.max(1, Math.ceil((p / 100) * v.length))) - 1];
  const mean = v.reduce((a, b) => a + b, 0) / v.length;
  const sd = Math.sqrt(v.reduce((a, b) => a + (b - mean) ** 2, 0) / v.length);
  return { n: v.length, min: v[0], p50: rank(50), p90: rank(90), p95: rank(95), p99: rank(99), max: v[v.length - 1], mean, sd };
}

const ms = (x) => (Number.isFinite(x) ? x.toFixed(2) : '--');

// ------------------------------------------------------------------ metadata

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

function gpuRenderer() {
  try {
    const gl = document.createElement('canvas').getContext('webgl2') ?? document.createElement('canvas').getContext('webgl');
    if (!gl) return null;
    const ext = gl.getExtension('WEBGL_debug_renderer_info');
    return ext ? gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER);
  } catch {
    return null;
  }
}

function metadata() {
  return {
    userAgent: navigator.userAgent,
    platform: navigator.userAgentData?.platform ?? navigator.platform ?? null,
    brands: navigator.userAgentData?.brands ?? null,
    hardwareConcurrency: navigator.hardwareConcurrency ?? null,
    deviceMemory: navigator.deviceMemory ?? null,
    gpuRenderer: gpuRenderer(),
    devicePixelRatio: window.devicePixelRatio,
    screen: { width: screen.width, height: screen.height, colorDepth: screen.colorDepth },
    crossOriginIsolated: self.crossOriginIsolated === true,
    performanceNowGranularityMs: clockGranularityMs(),
    startedAt: new Date().toISOString(),
  };
}

let everHidden = document.visibilityState !== 'visible';
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState !== 'visible') everHidden = true;
});

async function publish(result) {
  result.label = LABEL;
  result.everHidden = everHidden;
  if (everHidden) say('WARNING: the window was hidden during this run - timers were throttled, so this is not a measurement');
  if (!POST) return;
  try {
    const res = await fetch('/result', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(result),
    });
    say(`posted: ${(await res.json()).written}`);
  } catch (err) {
    say(`POST failed: ${err}`);
  }
}

// -------------------------------------------------------- the canned streams

const streamCache = new Map();

async function loadStream(name) {
  if (streamCache.has(name)) return streamCache.get(name);
  const meta = await fetch(`/streams/${name}.json`).then((r) => r.json());
  const bytes = new Uint8Array(await fetch(`/streams/${meta.file}`).then((r) => r.arrayBuffer()));
  if (bytes.length !== meta.bytes) throw new Error(`${name}: got ${bytes.length} bytes, index says ${meta.bytes}`);
  const chunks = [];
  let offset = 0;
  meta.frames.forEach((f, i) => {
    chunks.push(new EncodedVideoChunk({
      type: f.key ? 'key' : 'delta',
      timestamp: Math.round((i * 1e6) / meta.fps),
      duration: Math.round(1e6 / meta.fps),
      data: bytes.subarray(offset, offset + f.len),
    }));
    offset += f.len;
  });
  const loaded = { meta, chunks };
  streamCache.set(name, loaded);
  return loaded;
}

/// A copy of a chunk with a new timestamp, for a soak that replays the stream:
/// timestamps that walk backwards at every loop boundary are not something a
/// decoder is obliged to make sense of.
function retime(chunk, timestampUs) {
  const data = new Uint8Array(chunk.byteLength);
  chunk.copyTo(data);
  return new EncodedVideoChunk({ type: chunk.type, timestamp: timestampUs, duration: chunk.duration ?? undefined, data });
}

// ------------------------------------------------------------- mode: caps
//
// Two different questions, asked separately because they have different answers:
// what WebCodecs claims it can decode, and what the WebRTC receiver advertises.
// Arm B (the G1 winner) rides the second one; WebCodecs is the deferred second
// video path and the e2e stub decision.

const CODECS = [
  { codec: 'avc1.42E01E', note: 'h264 baseline 3.0' },
  { codec: 'avc1.4D401F', note: 'h264 main 3.1' },
  { codec: 'avc1.64002A', note: 'h264 high 4.2 (the canned stream)' },
  { codec: 'avc3.64002A', note: 'h264 high 4.2, avc3 (in-band parameter sets)' },
  { codec: 'hev1.1.6.L123.B0', note: 'hevc main 8-bit 4.1 (the canned stream)' },
  { codec: 'hvc1.1.6.L123.B0', note: 'hevc main 8-bit 4.1, hvc1 spelling' },
  { codec: 'hev1.1.6.L93.B0', note: 'hevc main 8-bit 3.1' },
  { codec: 'hev1.2.4.L123.B0', note: 'hevc main10 4.1' },
  { codec: 'vp8', note: 'vp8' },
  { codec: 'vp09.00.10.08', note: 'vp9 profile 0 8-bit' },
  { codec: 'av01.0.04M.08', note: 'av1 main 8-bit' },
];

const ACCEL = ['no-preference', 'prefer-hardware', 'prefer-software'];

async function runCaps() {
  const result = { mode: 'caps', meta: metadata(), webcodecs: [], webrtc: {}, mediaCapabilities: [], features: {} };

  result.features = {
    VideoDecoder: typeof window.VideoDecoder === 'function',
    VideoEncoder: typeof window.VideoEncoder === 'function',
    RTCPeerConnection: typeof window.RTCPeerConnection === 'function',
    RTCRtpScriptTransform: typeof window.RTCRtpScriptTransform === 'function',
    generateCertificate: typeof window.RTCPeerConnection?.generateCertificate === 'function',
    keyboardLock: typeof navigator.keyboard?.lock === 'function',
    clipboardRead: typeof navigator.clipboard?.read === 'function',
    clipboardReadText: typeof navigator.clipboard?.readText === 'function',
    clipboardWrite: typeof navigator.clipboard?.write === 'function',
    requestPointerLock: typeof Element.prototype.requestPointerLock === 'function',
    requestVideoFrameCallback: typeof HTMLVideoElement.prototype.requestVideoFrameCallback === 'function',
    getCoalescedEvents: typeof PointerEvent.prototype.getCoalescedEvents === 'function',
    getScreenDetails: typeof window.getScreenDetails === 'function',
    // The hint is advisory: this records whether the context reports honouring it.
    desynchronizedHonoured: (() => {
      try {
        const c = document.createElement('canvas');
        return c.getContext('2d', { desynchronized: true })?.getContextAttributes?.().desynchronized ?? null;
      } catch { return null; }
    })(),
  };

  if (typeof window.VideoDecoder === 'function') {
    for (const entry of CODECS) {
      for (const accel of ACCEL) {
        const config = { codec: entry.codec, codedWidth: 1920, codedHeight: 1080, hardwareAcceleration: accel, optimizeForLatency: true };
        try {
          const support = await VideoDecoder.isConfigSupported(config);
          result.webcodecs.push({ ...entry, hardwareAcceleration: accel, supported: support.supported === true });
        } catch (err) {
          result.webcodecs.push({ ...entry, hardwareAcceleration: accel, supported: false, error: `${err.name}: ${err.message}` });
        }
      }
    }
  }

  for (const kind of ['video', 'audio']) {
    try {
      result.webrtc[`receiver_${kind}`] = (RTCRtpReceiver.getCapabilities(kind)?.codecs ?? []).map((c) => c.mimeType);
      result.webrtc[`sender_${kind}`] = (RTCRtpSender.getCapabilities(kind)?.codecs ?? []).map((c) => c.mimeType);
    } catch (err) {
      result.webrtc[`receiver_${kind}`] = `error: ${err}`;
    }
  }
  try {
    result.webrtc.headerExtensions = (RTCRtpReceiver.getCapabilities('video')?.headerExtensions ?? []).map((h) => h.uri);
  } catch { result.webrtc.headerExtensions = null; }

  // `webrtc` takes the rtp mime, `file` takes a container mime. Asking `file`
  // about "video/H265" answers "no" on every browser and means nothing.
  const MEDIA_CAPS = [
    { type: 'webrtc', contentType: 'video/H264;codecs=avc1.64002A' },
    { type: 'webrtc', contentType: 'video/H265;codecs=hev1.1.6.L123.B0' },
    { type: 'webrtc', contentType: 'video/VP8' },
    { type: 'webrtc', contentType: 'video/AV1' },
    { type: 'file', contentType: 'video/mp4;codecs="avc1.64002A"' },
    { type: 'file', contentType: 'video/mp4;codecs="hvc1.1.6.L123.B0"' },
  ];
  for (const { type, contentType } of MEDIA_CAPS) {
    try {
      const info = await navigator.mediaCapabilities.decodingInfo({
        type,
        video: { contentType, width: 1920, height: 1080, bitrate: 8e6, framerate: 60 },
      });
      result.mediaCapabilities.push({ type, contentType, supported: info.supported, smooth: info.smooth, powerEfficient: info.powerEfficient });
    } catch (err) {
      result.mediaCapabilities.push({ type, contentType, error: `${err.name}: ${err.message}` });
    }
  }

  say('features:');
  for (const [k, v] of Object.entries(result.features)) say(`  ${k.padEnd(28)} ${v}`);
  say('');
  say('VideoDecoder.isConfigSupported:');
  for (const row of result.webcodecs) {
    say(`  ${row.codec.padEnd(20)} ${row.hardwareAcceleration.padEnd(17)} ${row.supported ? 'yes' : 'NO '} ${row.error ?? ''}`);
  }
  say('');
  say(`webrtc receiver video codecs: ${JSON.stringify(result.webrtc.receiver_video)}`);
  say(`webrtc video header extensions: ${JSON.stringify(result.webrtc.headerExtensions)}`);
  say('');
  say('mediaCapabilities.decodingInfo:');
  for (const row of result.mediaCapabilities) {
    say(`  ${row.type.padEnd(7)} ${row.contentType.padEnd(40)} ${row.error ?? `supported=${row.supported} smooth=${row.smooth} powerEfficient=${row.powerEfficient}`}`);
  }
  await publish(result);
  return result;
}

// ----------------------------------------------------------- decode machinery
//
// Submission is paced at the stream's own frame rate, one access unit per frame
// period, because that is how a live stream arrives and it is the only way the
// DPB-hold failure (spike 0.9: 208 ms against 8 ms) is visible at all. Dumping
// the file into the decoder at once measures throughput and hides the delay.

function drawFrame(frame, canvas) {
  const ctx = canvas.getContext('2d');
  ctx.drawImage(frame, 0, 0, canvas.width, canvas.height);
  // Proof that real pixels came out, not just that a callback fired: a decoder
  // that emits blank frames counts as a failure, and every browser has one.
  const px = ctx.getImageData(canvas.width >> 1, canvas.height >> 1, 1, 1).data;
  return px[0] + px[1] + px[2];
}

async function decodeRun({ name, codec, hardwareAcceleration, canvas, count, paced = true }) {
  const { meta, chunks } = await loadStream(name);
  const limit = Math.min(count ?? chunks.length, chunks.length);
  const config = {
    codec: codec ?? meta.codec,
    codedWidth: meta.width,
    codedHeight: meta.height,
    optimizeForLatency: true,
    ...(hardwareAcceleration ? { hardwareAcceleration } : {}),
  };
  const run = { stream: name, config, framesIn: limit };

  if (typeof window.VideoDecoder !== 'function') return { ...run, error: 'VideoDecoder is not implemented' };
  try {
    run.isConfigSupported = (await VideoDecoder.isConfigSupported(config)).supported === true;
  } catch (err) {
    run.isConfigSupported = false;
    run.isConfigSupportedError = `${err.name}: ${err.message}`;
  }

  const submitted = [];
  const latencies = [];
  let outputs = 0;
  let nonBlack = 0;
  let sampled = 0;
  let decoderError = null;

  const decoder = new VideoDecoder({
    output: (frame) => {
      const i = outputs;
      outputs += 1;
      if (submitted[i] !== undefined) latencies.push(performance.now() - submitted[i]);
      try {
        if (canvas && (i === 0 || i % 10 === 0)) {
          sampled += 1;
          if (drawFrame(frame, canvas) > 24) nonBlack += 1;
        }
      } finally {
        frame.close();
      }
    },
    error: (err) => { decoderError = `${err.name}: ${err.message}`; },
  });

  try {
    decoder.configure(config);
  } catch (err) {
    return { ...run, configureError: `${err.name}: ${err.message}` };
  }

  const frameMs = 1000 / meta.fps;
  const t0 = performance.now();
  for (let i = 0; i < limit && !decoderError; i += 1) {
    if (paced) await waitUntil(t0 + i * frameMs);
    submitted[i] = performance.now();
    try {
      decoder.decode(chunks[i]);
    } catch (err) {
      // The error callback usually fires first and carries the real reason; a
      // throw from decode() is just the closed codec that followed it.
      decoderError = decoderError ?? `decode() threw: ${err.name}: ${err.message}`;
      break;
    }
  }

  run.framesOutBeforeFlush = outputs;
  try {
    await decoder.flush();
  } catch (err) {
    decoderError = decoderError ?? `flush() rejected: ${err.name}: ${err.message}`;
  }
  run.framesOutAfterFlush = outputs;
  run.framesHeldAtEndOfStream = run.framesOutAfterFlush - run.framesOutBeforeFlush;
  run.submitToOutputMs = summarize(latencies);
  run.pixelsChecked = sampled;
  run.pixelsNonBlack = nonBlack;
  run.decoderError = decoderError;
  try { decoder.close(); } catch { /* already closed by the error path */ }
  return run;
}

async function runDecode() {
  const result = { mode: 'decode', meta: metadata(), runs: [] };
  for (const name of ['h264-1080p', 'hevc-1080p']) {
    const { meta } = await loadStream(name);
    // Both spellings, because a decoder that takes one and refuses the other is
    // a real and common outcome and the product has to pick one.
    const spellings = name.startsWith('hevc')
      ? [meta.codec, meta.codec.replace('hev1', 'hvc1')]
      : [meta.codec, meta.codec.replace('avc1', 'avc3')];
    for (const codec of spellings) {
      for (const accel of ['no-preference', 'prefer-hardware', 'prefer-software']) {
        state(`decode ${name} ${codec} ${accel}`);
        const run = await decodeRun({ name, codec, hardwareAcceleration: accel, canvas: presentEl });
        result.runs.push({ ...run, hardwareAcceleration: accel });
        say(
          `${name.padEnd(12)} ${codec.padEnd(20)} ${accel.padEnd(17)} ` +
          `claimed=${run.isConfigSupported} out=${run.framesOutAfterFlush ?? 0}/${run.framesIn} ` +
          `held=${run.framesHeldAtEndOfStream ?? '--'} nonblack=${run.pixelsNonBlack ?? 0}/${run.pixelsChecked ?? 0} ` +
          `submit->output p50=${ms(run.submitToOutputMs?.p50)} p95=${ms(run.submitToOutputMs?.p95)} ` +
          `${run.configureError ?? run.decoderError ?? ''}`,
        );
      }
    }
  }
  await publish(result);
  return result;
}

// -------------------------------------------------------------- mode: stall
//
// The claim (plan.md D5): hardware decoders on macOS stall on a static desktop,
// and the host keeping a floor frame rate clears it. Two arms, because the
// product decodes through WebRTC (arm B) and the deferred second path decodes
// through WebCodecs, and they do not have to behave the same.

async function stallWebCodecs({ name, idleMs, floorHz }) {
  const { meta, chunks } = await loadStream(name);
  const prime = 30;
  const outputs = [];
  let decoderError = null;
  const decoder = new VideoDecoder({
    output: (frame) => { outputs.push(performance.now()); frame.close(); },
    error: (err) => { decoderError = `${err.name}: ${err.message}`; },
  });
  const config = { codec: meta.codec, codedWidth: meta.width, codedHeight: meta.height, optimizeForLatency: true };
  try { decoder.configure(config); } catch (err) { return { arm: 'webcodecs', name, idleMs, floorHz, configureError: String(err) }; }

  const frameMs = 1000 / meta.fps;
  const submitted = [];
  const t0 = performance.now();
  for (let i = 0; i < prime; i += 1) {
    await waitUntil(t0 + i * frameMs);
    submitted[i] = performance.now();
    decoder.decode(chunks[i]);
  }
  const outputsAtIdleStart = outputs.length;

  // The idle window. floorHz = 0 is the static desktop with nothing sent; a
  // non-zero floorHz is the host workaround, sending the same cadence a real
  // floor-frame-rate host would.
  let next = prime;
  const idleEnd = performance.now() + idleMs;
  if (floorHz > 0) {
    const stepMs = 1000 / floorHz;
    let k = 0;
    while (performance.now() < idleEnd && next < chunks.length - 10) {
      await waitUntil(idleEnd - idleMs + k * stepMs);
      submitted[next] = performance.now();
      decoder.decode(chunks[next]);
      next += 1;
      k += 1;
    }
  } else {
    await sleep(idleMs);
  }

  const outputsAtIdleEnd = outputs.length;
  const heldThroughIdle = next - outputsAtIdleEnd;

  // Resume at full rate and time the first frame out of the other side.
  const resumeStart = performance.now();
  const resumeLatencies = [];
  const firstResumeOutputIndex = outputs.length;
  const resumeCount = Math.min(20, chunks.length - next);
  for (let i = 0; i < resumeCount; i += 1) {
    await waitUntil(resumeStart + i * frameMs);
    submitted[next + i] = performance.now();
    decoder.decode(chunks[next + i]);
  }
  const deadline = performance.now() + 2000;
  while (outputs.length < firstResumeOutputIndex + resumeCount && performance.now() < deadline && !decoderError) {
    await sleep(5);
  }
  for (let i = firstResumeOutputIndex; i < outputs.length; i += 1) {
    const submitTime = submitted[i];
    if (submitTime !== undefined) resumeLatencies.push(outputs[i] - submitTime);
  }
  const steady = [];
  for (let i = 0; i < Math.min(outputsAtIdleStart, prime); i += 1) {
    if (submitted[i] !== undefined) steady.push(outputs[i] - submitted[i]);
  }

  try { await decoder.flush(); } catch { /* the error path already recorded why */ }
  try { decoder.close(); } catch { /* already closed */ }

  return {
    arm: 'webcodecs',
    stream: name,
    idleMs,
    floorHz,
    primeFrames: prime,
    outputsAtIdleStart,
    outputsAtIdleEnd,
    framesHeldThroughIdle: heldThroughIdle,
    framesSubmittedDuringIdle: floorHz > 0 ? next - prime : 0,
    firstAfterIdleMs: resumeLatencies[0] ?? null,
    resumeSubmitToOutputMs: summarize(resumeLatencies),
    steadySubmitToOutputMs: summarize(steady),
    decoderError,
  };
}

/// A loopback RTCPeerConnection: a canvas captureStream encoded and decoded by
/// this browser and rendered into a <video>. It is not the product's host, but
/// it is the product's *receive* path (arm B), and a canvas that stops changing
/// is exactly the static desktop the stall claim is about.
async function stallLoopback({ idleMs, floorHz, codecFilter }) {
  const W = 1280;
  const H = 720;
  sourceEl.width = W;
  sourceEl.height = H;
  const ctx = sourceEl.getContext('2d');
  let tick = 0;
  const paint = () => {
    tick += 1;
    ctx.fillStyle = '#101418';
    ctx.fillRect(0, 0, W, H);
    ctx.fillStyle = '#e0e6ef';
    ctx.fillRect((tick * 13) % (W - 120), 40, 120, H - 80);
  };
  paint();

  // captureStream(0) + requestFrame() is the only way to make a canvas source
  // that is genuinely still: with a frame rate argument the browser keeps
  // pushing frames whether or not anything changed, and then there is no static
  // desktop to test. Where requestFrame is missing, captureStream() with no
  // argument captures on change, which is the same shape with less control.
  let stream = sourceEl.captureStream(0);
  let pushFrame = stream.getVideoTracks()[0];
  let captureMode = 'captureStream(0)+requestFrame';
  if (typeof pushFrame.requestFrame !== 'function') {
    stream.getTracks().forEach((t) => t.stop());
    stream = sourceEl.captureStream();
    pushFrame = null;
    captureMode = 'captureStream() on-change';
  }
  const emit = () => { paint(); pushFrame?.requestFrame(); };
  emit(); // one frame before negotiation, so the track is not empty at connect
  const pc1 = new RTCPeerConnection();
  const pc2 = new RTCPeerConnection();
  const cleanup = () => { pc1.close(); pc2.close(); stream.getTracks().forEach((t) => t.stop()); };
  try {
    pc1.onicecandidate = (e) => e.candidate && pc2.addIceCandidate(e.candidate);
    pc2.onicecandidate = (e) => e.candidate && pc1.addIceCandidate(e.candidate);
    const tracked = new Promise((resolve) => { pc2.ontrack = (e) => resolve(e.streams[0] ?? new MediaStream([e.track])); });
    const sender = pc1.addTrack(stream.getVideoTracks()[0], stream);

    let negotiatedCodec = null;
    if (codecFilter) {
      const caps = RTCRtpSender.getCapabilities('video');
      const wanted = (caps?.codecs ?? []).filter((c) => c.mimeType.toLowerCase() === codecFilter.toLowerCase());
      if (wanted.length === 0) return { arm: 'loopback', codecFilter, error: `${codecFilter} is not in RTCRtpSender.getCapabilities('video')` };
      const transceiver = pc1.getTransceivers().find((t) => t.sender === sender);
      transceiver.setCodecPreferences(wanted);
    }

    await pc1.setLocalDescription(await pc1.createOffer());
    await pc2.setRemoteDescription(pc1.localDescription);
    await pc2.setLocalDescription(await pc2.createAnswer());
    await pc1.setRemoteDescription(pc2.localDescription);
    videoEl.srcObject = await tracked;
    // Never awaited: with a captureStream(0) source no frame has been produced
    // yet, and play()'s promise does not settle until one has. Awaiting it here
    // deadlocks against the paint loop below, which is what produces that frame.
    videoEl.play().catch(() => {});

    // Presented-frame times. rVFC where it exists, getStats elsewhere: Firefox
    // shipped rVFC late enough that the fallback is not hypothetical.
    const presented = [];
    const useRvfc = typeof videoEl.requestVideoFrameCallback === 'function';
    let stop = false;
    if (useRvfc) {
      const onFrame = () => { presented.push(performance.now()); if (!stop) videoEl.requestVideoFrameCallback(onFrame); };
      videoEl.requestVideoFrameCallback(onFrame);
    } else {
      let last = -1;
      (async () => {
        while (!stop) {
          const stats = await pc2.getStats();
          stats.forEach((r) => {
            if (r.type === 'inbound-rtp' && r.kind === 'video' && r.framesDecoded > last) { last = r.framesDecoded; presented.push(performance.now()); }
          });
          await sleep(8);
        }
      })();
    }

    let painting = true;
    const loop = () => { if (painting) emit(); if (!stop) requestAnimationFrame(loop); };
    requestAnimationFrame(loop);

    await sleep(3000);
    const steadyGaps = [];
    for (let i = 1; i < presented.length; i += 1) steadyGaps.push(presented[i] - presented[i - 1]);
    const steadyFrames = presented.length;

    // static desktop
    painting = false;
    const idleStart = performance.now();
    const beforeIdle = presented.length;
    if (floorHz > 0) {
      const stepMs = 1000 / floorHz;
      while (performance.now() < idleStart + idleMs) {
        emit();
        await sleep(stepMs);
      }
    } else {
      await sleep(idleMs);
    }
    const framesDuringIdle = presented.length - beforeIdle;

    // resume
    const resumeAt = performance.now();
    const beforeResume = presented.length;
    painting = true;
    const deadline = resumeAt + 3000;
    while (presented.length === beforeResume && performance.now() < deadline) await sleep(2);
    const firstAfterIdleMs = presented.length > beforeResume ? presented[beforeResume] - resumeAt : null;
    await sleep(1000);
    stop = true;

    const stats = { framesDecoded: null, framesDropped: null, freezeCount: null, totalFreezesDuration: null, decoderImplementation: null, codec: null };
    const report = await pc2.getStats();
    const codecs = new Map();
    report.forEach((r) => { if (r.type === 'codec') codecs.set(r.id, r.mimeType); });
    report.forEach((r) => {
      if (r.type === 'inbound-rtp' && r.kind === 'video') {
        stats.framesDecoded = r.framesDecoded;
        stats.framesDropped = r.framesDropped ?? null;
        stats.freezeCount = r.freezeCount ?? null;
        stats.totalFreezesDuration = r.totalFreezesDuration ?? null;
        stats.decoderImplementation = r.decoderImplementation ?? null;
        stats.codec = codecs.get(r.codecId) ?? null;
      }
    });
    negotiatedCodec = stats.codec;

    return {
      arm: 'loopback',
      codecFilter: codecFilter ?? null,
      negotiatedCodec,
      captureMode,
      presentedFrameSource: useRvfc ? 'requestVideoFrameCallback' : 'getStats.framesDecoded',
      steadyFrames,
      steadyFrameGapMs: summarize(steadyGaps),
      idleMs,
      floorHz,
      framesPresentedDuringIdle: framesDuringIdle,
      firstAfterIdleMs,
      stats,
    };
  } finally {
    cleanup();
  }
}

async function runStall() {
  const reps = Number(params.get('reps') ?? 5);
  const result = { mode: 'stall', meta: metadata(), reps, idleMs: 3000, webcodecs: [], loopback: [], summary: [] };

  for (const name of ['h264-1080p', 'hevc-1080p']) {
    for (const floorHz of [0, 2]) {
      const firsts = [];
      for (let r = 0; r < reps; r += 1) {
        state(`stall webcodecs ${name} floor=${floorHz} ${r + 1}/${reps}`);
        const row = await stallWebCodecs({ name, idleMs: 3000, floorHz });
        result.webcodecs.push({ ...row, rep: r });
        if (Number.isFinite(row.firstAfterIdleMs)) firsts.push(row.firstAfterIdleMs);
      }
      const s = summarize(firsts);
      result.summary.push({ arm: 'webcodecs', stream: name, floorHz, firstAfterIdleMs: s });
      say(`webcodecs ${name.padEnd(12)} floor=${String(floorHz).padStart(2)}Hz  first-after-idle n=${s.n} p50=${ms(s.p50)} p95=${ms(s.p95)} max=${ms(s.max)} ms`);
    }
  }

  for (const codecFilter of ['video/H264', 'video/H265']) {
    for (const floorHz of [0, 2]) {
      const firsts = [];
      let note = '';
      for (let r = 0; r < reps; r += 1) {
        state(`stall loopback ${codecFilter} floor=${floorHz} ${r + 1}/${reps}`);
        try {
          const row = await stallLoopback({ idleMs: 3000, floorHz, codecFilter });
          result.loopback.push({ ...row, rep: r });
          if (Number.isFinite(row.firstAfterIdleMs)) firsts.push(row.firstAfterIdleMs);
          note = row.error ?? `negotiated=${row.negotiatedCodec ?? '--'} capture=${row.captureMode} idle-frames=${row.framesPresentedDuringIdle}`;
        } catch (err) {
          result.loopback.push({ arm: 'loopback', codecFilter, floorHz, rep: r, error: `${err.name}: ${err.message}` });
          note = `FAILED ${err}`;
        }
      }
      const s = summarize(firsts);
      result.summary.push({ arm: 'loopback', codecFilter, floorHz, firstAfterIdleMs: s, note });
      say(`loopback  ${codecFilter.padEnd(12)} floor=${String(floorHz).padStart(2)}Hz  first-after-idle n=${s.n} p50=${ms(s.p50)} p95=${ms(s.p95)} max=${ms(s.max)} ms  ${note}`);
    }
  }
  await publish(result);
  return result;
}

// --------------------------------------------------------------- mode: soak
//
// One window decodes one 1080p60 stream on a loop for `secs`. The ceiling is
// found by launching 2, 4, 6 and 8 of these and comparing sustained output rate
// and errors - `group` ties the windows of one soak together, `idx` names them.

async function runSoak() {
  const { meta, chunks } = await loadStream(STREAM);
  const config = { codec: meta.codec, codedWidth: meta.width, codedHeight: meta.height, optimizeForLatency: true };
  const result = { mode: 'soak', meta: metadata(), group: GROUP, idx: IDX, secs: SECS, stream: STREAM, config };

  if (typeof window.VideoDecoder !== 'function') {
    result.error = 'VideoDecoder is not implemented';
    await publish(result);
    return result;
  }

  const latencies = [];
  let outputs = 0;
  let nonBlack = 0;
  let sampled = 0;
  let decoderError = null;
  const submitted = [];
  const decoder = new VideoDecoder({
    output: (frame) => {
      const i = outputs;
      outputs += 1;
      if (submitted[i] !== undefined) latencies.push(performance.now() - submitted[i]);
      try {
        if (i % 30 === 0) { sampled += 1; if (drawFrame(frame, presentEl) > 24) nonBlack += 1; }
      } finally { frame.close(); }
    },
    error: (err) => { decoderError = `${err.name}: ${err.message}`; },
  });
  decoder.configure(config);

  const frameMs = 1000 / meta.fps;
  const start = performance.now();
  const end = start + SECS * 1000;
  let submittedCount = 0;
  let loops = 0;
  // Each loop restarts at the stream's IDR. Feeding past the end and wrapping
  // without a reconfigure would hand the decoder a dangling reference, which
  // PROTOCOL.md section 4 forbids and chrome hard-fails on for h.265.
  while (performance.now() < end && !decoderError) {
    for (let i = 0; i < chunks.length && performance.now() < end && !decoderError; i += 1) {
      await waitUntil(start + submittedCount * frameMs);
      submitted[submittedCount] = performance.now();
      try {
        decoder.decode(loops === 0 ? chunks[i] : retime(chunks[i], Math.round((submittedCount * 1e6) / meta.fps)));
      } catch (err) {
        decoderError = `decode() threw: ${err.name}: ${err.message}`;
        break;
      }
      submittedCount += 1;
    }
    loops += 1;
  }
  const elapsedMs = performance.now() - start;
  try { await decoder.flush(); } catch { /* recorded through decoderError */ }
  try { decoder.close(); } catch { /* already closed */ }

  result.loops = loops;
  result.framesSubmitted = submittedCount;
  result.framesOut = outputs;
  result.elapsedMs = elapsedMs;
  result.submittedFps = (submittedCount * 1000) / elapsedMs;
  result.outputFps = (outputs * 1000) / elapsedMs;
  result.submitToOutputMs = summarize(latencies);
  result.pixelsChecked = sampled;
  result.pixelsNonBlack = nonBlack;
  result.decoderError = decoderError;
  say(`soak idx=${IDX} group=${GROUP}: in ${submittedCount} out ${outputs} over ${(elapsedMs / 1000).toFixed(1)} s`);
  say(`  submitted ${result.submittedFps.toFixed(2)} fps, output ${result.outputFps.toFixed(2)} fps, submit->output p50=${ms(result.submitToOutputMs.p50)} p95=${ms(result.submitToOutputMs.p95)}`);
  say(`  non-black ${nonBlack}/${sampled}  error=${decoderError ?? 'none'}`);
  await publish(result);
  return result;
}

// ----------------------------------------------------------------- mode: fp
//
// The whole `fp` binding (PROTOCOL.md section 8) needs the browser's dtls
// fingerprint at *mint* time, before the api will issue a viewer token. There
// are exactly two ways to get it and this decides which exist here.

async function runFp() {
  const result = { mode: 'fp', meta: metadata(), certificate: {}, sdp: {}, agree: null };

  let cert = null;
  try {
    cert = await RTCPeerConnection.generateCertificate({ name: 'ECDSA', namedCurve: 'P-256' });
    result.certificate.generateCertificate = true;
  } catch (err) {
    result.certificate.generateCertificate = false;
    result.certificate.error = `${err.name}: ${err.message}`;
  }

  if (cert) {
    result.certificate.getFingerprints = typeof cert.getFingerprints === 'function';
    if (result.certificate.getFingerprints) {
      try {
        const prints = cert.getFingerprints();
        result.certificate.fingerprints = prints.map((f) => ({ algorithm: f.algorithm, valueLength: f.value.length }));
        const sha256 = prints.find((f) => f.algorithm === 'sha-256');
        // Canonical form, PROTOCOL.md section 9: "<hash-func> <HEX:WITH:COLONS>",
        // hash token lowercase, hex uppercase. Recorded as a shape, never as the
        // value: a fingerprint is per-certificate and this file is written to disk.
        result.certificate.canonicalShape = sha256 ? `${sha256.algorithm} ${sha256.value.toUpperCase()}`.replace(/[0-9A-F]/g, 'X') : null;
        result.certificate.hexCase = sha256 ? (sha256.value === sha256.value.toUpperCase() ? 'upper' : 'lower') : null;
      } catch (err) {
        result.certificate.fingerprintsError = `${err.name}: ${err.message}`;
      }
    }
  }

  const pc = new RTCPeerConnection(cert ? { certificates: [cert] } : {});
  try {
    pc.addTransceiver('video', { direction: 'recvonly' });
    const offer = await pc.createOffer();
    const line = (offer.sdp ?? '').split('\n').map((l) => l.trim()).find((l) => l.startsWith('a=fingerprint:'));
    result.sdp.fingerprintLinePresent = Boolean(line);
    result.sdp.requiresSetLocalDescription = false;
    if (line) {
      const [algorithm, value] = line.slice('a=fingerprint:'.length).split(' ');
      result.sdp.algorithm = algorithm;
      result.sdp.hexCase = value === value.toUpperCase() ? 'upper' : 'lower';
      result.sdp.shape = `${algorithm} ${value}`.replace(/[0-9A-Fa-f]/g, 'X');
      if (result.certificate.fingerprints) {
        const sha256 = cert.getFingerprints().find((f) => f.algorithm === 'sha-256');
        result.agree = Boolean(sha256) && value.toLowerCase() === sha256.value.toLowerCase();
      }
    } else {
      // Some engines only fill the fingerprint in once the description is set.
      await pc.setLocalDescription(offer);
      const after = (pc.localDescription?.sdp ?? '').split('\n').map((l) => l.trim()).find((l) => l.startsWith('a=fingerprint:'));
      result.sdp.fingerprintLinePresent = Boolean(after);
      result.sdp.requiresSetLocalDescription = Boolean(after);
    }
  } catch (err) {
    result.sdp.error = `${err.name}: ${err.message}`;
  } finally {
    pc.close();
  }

  say(`generateCertificate: ${result.certificate.generateCertificate}`);
  say(`RTCCertificate.getFingerprints(): ${result.certificate.getFingerprints}`);
  say(`fingerprints: ${JSON.stringify(result.certificate.fingerprints ?? result.certificate.fingerprintsError ?? null)}`);
  say(`a=fingerprint in createOffer(): ${result.sdp.fingerprintLinePresent} (needed setLocalDescription first: ${result.sdp.requiresSetLocalDescription})`);
  say(`sdp algorithm=${result.sdp.algorithm} hex case=${result.sdp.hexCase}`);
  say(`certificate and sdp agree: ${result.agree}`);
  await publish(result);
  return result;
}

// ----------------------------------------------------------- mode: readback
//
// Spike 0.1 §6 tested review-1 F7 ("a desynchronized canvas reads back empty
// through drawImage") on chrome 153 and it did not reproduce; 0.1 §6 item 2
// assigned the safari and firefox re-test to this task. The plan is lifted from
// latency-probe-web/public/probe.js unchanged so the two runs are comparable.

async function readbackCase({ label, mounted, presented, make, draw, read }) {
  const c = document.createElement('canvas');
  c.width = 64;
  c.height = 64;
  if (mounted) {
    c.style.cssText = 'position:fixed;left:8px;bottom:8px;width:64px;height:64px;z-index:5';
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

  const fillRed2d = (ctx, c) => { ctx.fillStyle = '#ff0000'; ctx.fillRect(0, 0, c.width, c.height); };
  const readOwn2d = (ctx) => ctx.getImageData(32, 32, 1, 1).data;
  const readViaDrawImage = (_ctx, c) => {
    scratchCtx.clearRect(0, 0, scratch.width, scratch.height);
    scratchCtx.drawImage(c, 0, 0);
    return scratchCtx.getImageData(32, 32, 1, 1).data;
  };
  const clearRedGl = (gl) => { gl.clearColor(1, 0, 0, 1); gl.clear(gl.COLOR_BUFFER_BIT); };
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
  for (const c of cases) {
    if (c.error) { say(`${c.label.padEnd(48)} ERROR ${c.error}`); continue; }
    const ok = c.pixel[0] === 255 && c.pixel[1] === 0 && c.pixel[2] === 0 && c.pixel[3] === 255;
    say(`${c.label.padEnd(48)} ${ok ? 'OK   ' : 'WRONG'} pixel=${c.pixel.join(',')}  read p50=${c.readMs.p50.toFixed(3)} p95=${c.readMs.p95.toFixed(3)} ms`);
  }
  await publish(result);
  return result;
}

// -------------------------------------------------------------- mode: perms
//
// Keyboard lock, pointer lock and clipboard all need a real click, so this mode
// is a click-through. The api outcome is recorded automatically; whether a
// *prompt* appeared is not observable from javascript at all, so the operator
// records that with two buttons after each step.

async function runPerms() {
  const result = { mode: 'perms', meta: metadata(), steps: [] };

  const permissionState = async (name) => {
    try { return (await navigator.permissions.query({ name })).state; } catch (err) { return `query failed: ${err.name}`; }
  };

  const record = (step) => {
    result.steps.push(step);
    say(`${step.name.padEnd(32)} ${step.outcome} ${step.detail ?? ''}`);
    return step;
  };

  const askPrompt = (step) => new Promise((resolve) => {
    const wrap = document.createElement('div');
    wrap.innerHTML = `<span class="hint">did a browser prompt appear for "${step.name}"? </span>`;
    for (const [text, value] of [['yes', true], ['no', false], ['unsure', null]]) {
      const b = document.createElement('button');
      b.textContent = text;
      b.onclick = () => { step.promptObserved = value; say(`  prompt observed for ${step.name}: ${value}`); wrap.remove(); resolve(); };
      wrap.appendChild(b);
    }
    gesturesEl.appendChild(wrap);
  });

  const button = (name, fn) => new Promise((resolve) => {
    const b = document.createElement('button');
    b.textContent = name;
    b.onclick = async () => {
      b.disabled = true;
      let step;
      try {
        step = record(await fn());
      } catch (err) {
        step = record({ name, outcome: 'threw', detail: `${err.name}: ${err.message}` });
      }
      await askPrompt(step);
      resolve();
    };
    gesturesEl.appendChild(b);
  });

  result.permissionsBefore = {
    'clipboard-read': await permissionState('clipboard-read'),
    'clipboard-write': await permissionState('clipboard-write'),
  };
  say(`permissions before: ${JSON.stringify(result.permissionsBefore)}`);
  say('click each button in order; after each one, say whether a prompt appeared.');

  await button('keyboard lock (fullscreen)', async () => {
    if (typeof navigator.keyboard?.lock !== 'function') return { name: 'keyboard lock (fullscreen)', outcome: 'absent', detail: 'navigator.keyboard.lock is not implemented' };
    await document.documentElement.requestFullscreen();
    try {
      await navigator.keyboard.lock(['Escape', 'MetaLeft', 'MetaRight', 'AltLeft', 'Tab']);
      const held = document.fullscreenElement !== null;
      navigator.keyboard.unlock();
      return { name: 'keyboard lock (fullscreen)', outcome: 'resolved', detail: `fullscreen held=${held}` };
    } finally {
      if (document.fullscreenElement) await document.exitFullscreen();
    }
  });

  await button('pointer lock (unadjustedMovement)', async () => {
    const el = sourceEl;
    const settled = new Promise((resolve) => {
      const onChange = () => { cleanup(); resolve({ outcome: document.pointerLockElement ? 'locked' : 'released' }); };
      const onError = () => { cleanup(); resolve({ outcome: 'pointerlockerror' }); };
      const cleanup = () => {
        document.removeEventListener('pointerlockchange', onChange);
        document.removeEventListener('pointerlockerror', onError);
      };
      document.addEventListener('pointerlockchange', onChange);
      document.addEventListener('pointerlockerror', onError);
      setTimeout(() => { cleanup(); resolve({ outcome: 'timeout' }); }, 3000);
    });
    let promiseOutcome = 'no promise returned';
    try {
      const p = el.requestPointerLock({ unadjustedMovement: true });
      if (p && typeof p.then === 'function') { await p; promiseOutcome = 'promise resolved'; }
    } catch (err) {
      promiseOutcome = `promise rejected: ${err.name}: ${err.message}`;
    }
    const { outcome } = await settled;
    let raw = null;
    if (document.pointerLockElement) {
      raw = await new Promise((resolve) => {
        const onMove = (e) => { document.removeEventListener('mousemove', onMove); resolve({ movementX: e.movementX, movementY: e.movementY }); };
        document.addEventListener('mousemove', onMove);
        setTimeout(() => { document.removeEventListener('mousemove', onMove); resolve(null); }, 1500);
      });
      document.exitPointerLock();
    }
    return { name: 'pointer lock (unadjustedMovement)', outcome, detail: `${promiseOutcome}; first movement=${JSON.stringify(raw)}` };
  });

  const marker = `swoop-matrix-${Date.now()}`;
  await button('clipboard write', async () => {
    await navigator.clipboard.writeText(marker);
    return { name: 'clipboard write', outcome: 'resolved', detail: `wrote ${marker.length} chars` };
  });

  await button('clipboard read', async () => {
    const text = await navigator.clipboard.readText();
    return { name: 'clipboard read', outcome: 'resolved', detail: `matched what we wrote: ${text === marker}` };
  });

  result.permissionsAfter = {
    'clipboard-read': await permissionState('clipboard-read'),
    'clipboard-write': await permissionState('clipboard-write'),
  };
  say(`permissions after: ${JSON.stringify(result.permissionsAfter)}`);
  await publish(result);
  return result;
}

// ------------------------------------------------------------------- driver

const MODES = {
  caps: runCaps,
  decode: runDecode,
  stall: runStall,
  soak: runSoak,
  fp: runFp,
  readback: runReadback,
  perms: runPerms,
};

// Everything that needs no click, in one command per browser.
const AUTO = ['caps', 'decode', 'fp', 'readback', 'stall'];

async function main() {
  const modes = MODE === 'auto' ? AUTO : MODE.split(',').filter((m) => MODES[m]);
  if (modes.length === 0) { say(`unknown mode "${MODE}"`); state('error'); return; }
  say(`label=${LABEL} modes=${modes.join(',')}`);
  for (const mode of modes) {
    say('');
    say(`===== ${mode} =====`);
    state(mode);
    try {
      await MODES[mode]();
    } catch (err) {
      say(`${mode} FAILED: ${err?.stack ?? err}`);
    }
  }
  state('done');
  say('');
  say('done.');
}

document.getElementById('go').onclick = () => { document.getElementById('go').disabled = true; main(); };
if (AUTORUN) { document.getElementById('go').disabled = true; main(); }
