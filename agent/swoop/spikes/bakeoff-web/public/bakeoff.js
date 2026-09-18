// swoop spike 0.2 — video-path bake-off, browser half.
//
// The harness: clock exchange, signalling, the run, the statistics and the
// POST. Everything here is identical for all three arms of plan.md D3 — the
// arm-specific half lives behind `receivers/receiver.js`, and adding arm A or C
// in stage 2 means importing one more module, not editing this file.
//
// Every number it produces is in spike 0.1's terms:
//
// - renderer-visible (`_rv`) only, never photon — §2.1;
// - `n` on every figure, p50 and p95 — §2.3;
// - `rafPeriodContinuous` per run as the evidence the client was at 60 Hz — §2.4;
// - host stamps reconciled through the four-timestamp QPC exchange, quoted no
//   finer than that exchange's own uncertainty — §2.5;
// - a same-machine row carries the literal words "ranking only" — §2.2.
//
//   ?arm=b&n=150&host=http://127.0.0.1:17441&autorun=1
//   ?arm=a&dcmode=unordered-nortx&n=150          # arm A's reliability matrix
//   ?arm=c&n=150                                 # RTCRtpScriptTransform
//
// `?arm=` must match the host's `--arm`; a mismatch is refused rather than
// measured.

import { createReceiver, registeredArms } from './receivers/receiver.js';
import './receivers/data-channel.js';
import './receivers/rtp-track.js';
import './receivers/script-transform.js';

const params = new URLSearchParams(location.search);
const ARM = params.get('arm') ?? 'b';
// Arm A only. review-1 F2's reliability matrix is a browser-side
// `createDataChannel` option, so it is a URL parameter and not a host flag.
// The spellings are the keys of `DC_MODES` in `receivers/data-channel.js`.
const DC_MODE = params.get('dcmode') ?? 'ordered-lifetime';
const N = Number(params.get('n') ?? 150);
// 120 frames is two seconds. Measured on arm B, a freshly connected stream
// starts about six refresh periods behind and drains one period per refresh
// until it settles - 98 -> 82 -> 65 -> 48 -> 32 -> 15 ms, steady from there.
// A 30-frame warmup left a third of the series inside that drain and made
// the distribution bimodal. The drain itself is reported as its own row
// rather than dropped silently.
const WARMUP = Number(params.get('warmup') ?? 120);
const HOST = params.get('host') ?? 'http://127.0.0.1:17441';
const CLOCK_N = Number(params.get('clockn') ?? 400);
const AUTORUN = params.get('autorun') !== '0';
const POST = params.get('post') !== '0';
const LABEL = params.get('label') ?? '';
// After the series is complete, perform an ICE restart on the live peer and
// measure how long the stream takes to come back. plan.md D13 promotes a
// relayed session to a direct one this way, and task 0.2's done-when asks for
// "ICE restart works" as a measurement rather than as an assertion. Off by
// default so it can never perturb a latency row.
const ICE_RESTART = params.get('icerestart') === '1';

const out = document.getElementById('out');
const stateEl = document.getElementById('state');
const video = document.getElementById('stage');
const canvas = document.getElementById('probe');
// Arms A and C present here; arm B presents into the `<video>` above and leaves
// this empty. Both are in the DOM for every run so no arm is measured against a
// layout the others did not have.
const present = document.getElementById('present');

// Everything the page says also goes to the page server's stdout. Spike 0.9
// lost a run to a page that loaded, silently did nothing and left no trace
// anywhere, and stage 2 lost one to a receiver that threw a message only the
// browser window ever saw. A run that stalls has to be diagnosable from the
// terminal that started it.
function say(line) {
  out.textContent += `${line}\n`;
  out.scrollTop = out.scrollHeight;
  fetch(`/progress?m=${encodeURIComponent(line)}`).catch(() => {});
}
function state(s) {
  stateEl.textContent = s;
}

// ---------------------------------------------------------------- statistics

// Nearest rank, the same definition as the Rust side's `stats::summarize` and
// spike 0.1's `summarize()`. A row computed two different ways is two rows.
function summarize(values) {
  const v = values.filter((x) => Number.isFinite(x)).slice().sort((a, b) => a - b);
  if (!v.length) return { n: 0 };
  const rank = (p) => v[Math.min(v.length, Math.max(1, Math.ceil((p / 100) * v.length))) - 1];
  const mean = v.reduce((a, b) => a + b, 0) / v.length;
  const sd = Math.sqrt(v.reduce((a, b) => a + (b - mean) ** 2, 0) / v.length);
  return {
    n: v.length,
    min: +v[0].toFixed(2),
    p50: +rank(50).toFixed(2),
    p90: +rank(90).toFixed(2),
    p95: +rank(95).toFixed(2),
    p99: +rank(99).toFixed(2),
    max: +v[v.length - 1].toFixed(2),
    mean: +mean.toFixed(2),
    sd: +sd.toFixed(2),
  };
}

function table(rows) {
  const head =
    'series                            n      min      p50      p90      p95      p99      max     mean       sd';
  const lines = rows.map(([label, s]) =>
    s.n
      ? `${label.padEnd(30)} ${String(s.n).padStart(4)} ${[s.min, s.p50, s.p90, s.p95, s.p99, s.max, s.mean, s.sd]
          .map((x) => x.toFixed(2).padStart(8))
          .join(' ')}`
      : `${label.padEnd(30)} ${'0'.padStart(4)}  (no samples)`,
  );
  return [head, ...lines].join('\n');
}

function clockGranularityMs() {
  let min = Infinity;
  for (let i = 0; i < 200000; i += 1) {
    const a = performance.now();
    const b = performance.now();
    const d = b - a;
    if (d > 0 && d < min) min = d;
  }
  return Number.isFinite(min) ? min : null;
}

// ------------------------------------------------------------- clock offset

// Spike 0.1 §2.5, unchanged: four timestamps, take the offset of the
// minimum-delay exchange, burst them back to back, publish the ± bound.
async function measureClockOffset(n) {
  const url = `${HOST}/qpc`;
  const samples = [];
  for (let i = 0; i < n; i += 1) {
    const t0 = performance.now();
    const res = await fetch(url, { cache: 'no-store' });
    const t3 = performance.now();
    const j = await res.json();
    const offset = ((j.t1_ms - t0) + (j.t2_ms - t3)) / 2;
    const delay = (t3 - t0) - (j.t2_ms - j.t1_ms);
    samples.push({ offset, delay, residence: j.t2_ms - j.t1_ms, freq: j.freq });
  }
  const best = samples.reduce((a, b) => (b.delay < a.delay ? b : a));
  const delays = samples.map((s) => s.delay).sort((a, b) => a - b);
  return {
    n: samples.length,
    // qpcMs ≈ performance.now() + offsetMs
    offsetMs: best.offset,
    uncertaintyMs: best.delay / 2,
    delayP50Ms: delays[Math.floor(delays.length / 2)],
    serverResidenceP50Ms: summarize(samples.map((s) => s.residence)).p50,
    qpcFreq: best.freq,
    method: 'four-timestamp NTP exchange, minimum-delay filter (spike 0.1 §2.5)',
  };
}

// ---------------------------------------------------------- refresh evidence

// §2.4: the client's refresh period is confirmed from the browser, not assumed.
// A run whose rafPeriodContinuous p50 is not 16.6-16.8 ms is not a 60 Hz row.
function startRafPeriodMonitor() {
  const periods = [];
  let last = null;
  let hiddenAt = null;
  let running = true;
  const tick = (ts) => {
    if (!running) return;
    if (document.hidden && hiddenAt === null) hiddenAt = ts;
    if (last !== null) periods.push(ts - last);
    last = ts;
    requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
  return {
    stop() {
      running = false;
      return { periods, everHidden: hiddenAt !== null };
    },
  };
}

// ------------------------------------------------------------------- getStats

// The list research/05-transport-bakeoff.md §7 asks for, plus what is needed to
// assert the row's own label (a same-machine row and a LAN row differ only in
// the selected candidate pair, so the pair is evidence, not decoration).
const INBOUND_KEYS = [
  'framesReceived', 'framesDecoded', 'framesDropped', 'keyFramesDecoded',
  'frameWidth', 'frameHeight', 'framesPerSecond', 'freezeCount', 'totalFreezesDuration',
  'jitter', 'jitterBufferDelay', 'jitterBufferEmittedCount', 'jitterBufferTargetDelay',
  'jitterBufferMinimumDelay', 'totalDecodeTime', 'totalProcessingDelay', 'totalAssemblyTime',
  'framesAssembledFromMultiplePackets', 'totalInterFrameDelay', 'totalSquaredInterFrameDelay',
  'packetsReceived', 'packetsLost', 'nackCount', 'pliCount', 'firCount', 'bytesReceived',
  'decoderImplementation', 'powerEfficientDecoder', 'mimeType', 'codecId',
];
const PAIR_KEYS = [
  'state', 'nominated', 'currentRoundTripTime', 'totalRoundTripTime',
  'availableIncomingBitrate', 'availableOutgoingBitrate', 'bytesReceived', 'bytesSent',
  'packetsReceived', 'packetsDiscardedOnSend', 'requestsSent', 'responsesReceived',
];
const CANDIDATE_KEYS = ['candidateType', 'protocol', 'address', 'port', 'networkType', 'relayProtocol'];

function pick(report, keys) {
  const o = {};
  for (const k of keys) if (report[k] !== undefined) o[k] = report[k];
  return o;
}

// Arm A has no inbound-rtp at all — its video is SCTP — so the data-channel
// report is the only place its byte count and message count exist.
const DATA_CHANNEL_KEYS = [
  'label', 'protocol', 'dataChannelIdentifier', 'state',
  'messagesSent', 'bytesSent', 'messagesReceived', 'bytesReceived',
];

async function collectStats(pc) {
  const stats = await pc.getStats();
  const byId = new Map();
  stats.forEach((r) => byId.set(r.id, r));
  const out = {
    inboundVideo: null,
    selectedPair: null,
    localCandidate: null,
    remoteCandidate: null,
    codec: null,
    transport: null,
    dataChannels: [],
  };
  stats.forEach((r) => {
    if (r.type === 'data-channel') out.dataChannels.push(pick(r, DATA_CHANNEL_KEYS));
    if (r.type === 'inbound-rtp' && r.kind === 'video') {
      out.inboundVideo = pick(r, INBOUND_KEYS);
      const codec = byId.get(r.codecId);
      if (codec) out.codec = pick(codec, ['mimeType', 'payloadType', 'clockRate', 'sdpFmtpLine']);
    }
    if (r.type === 'transport') {
      out.transport = pick(r, ['dtlsState', 'iceState', 'bytesReceived', 'selectedCandidatePairId', 'dtlsCipher', 'srtpCipher']);
      const pair = byId.get(r.selectedCandidatePairId);
      if (pair) {
        out.selectedPair = pick(pair, PAIR_KEYS);
        const local = byId.get(pair.localCandidateId);
        const remote = byId.get(pair.remoteCandidateId);
        if (local) out.localCandidate = pick(local, CANDIDATE_KEYS);
        if (remote) out.remoteCandidate = pick(remote, CANDIDATE_KEYS);
      }
    }
  });
  if (out.inboundVideo) {
    const i = out.inboundVideo;
    // The derived numbers §7 item 4 asks for. jitterBufferDelay is a running
    // total in seconds over jitterBufferEmittedCount frames.
    out.derived = {
      jitterBufferDelayMsPerFrame: i.jitterBufferEmittedCount
        ? +((i.jitterBufferDelay / i.jitterBufferEmittedCount) * 1000).toFixed(3)
        : null,
      decodeMsPerFrame: i.framesDecoded ? +((i.totalDecodeTime / i.framesDecoded) * 1000).toFixed(3) : null,
      assemblyMsPerFrame: i.framesAssembledFromMultiplePackets
        ? +((i.totalAssemblyTime / i.framesAssembledFromMultiplePackets) * 1000).toFixed(3)
        : null,
      processingMsPerFrame: i.framesDecoded ? +((i.totalProcessingDelay / i.framesDecoded) * 1000).toFixed(3) : null,
      interFrameDelayMsMean: i.framesDecoded ? +((i.totalInterFrameDelay / i.framesDecoded) * 1000).toFixed(3) : null,
    };
  }
  return out;
}

// --------------------------------------------------------------- the run

function extmapLines(sdp) {
  return (sdp ?? '').split(/\r?\n/).filter((l) => l.startsWith('a=extmap:'));
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Poll rather than listen: after an ICE restart `iceGatheringState` has to
// leave `complete` before it can re-enter it, and an event listener attached at
// the wrong moment either fires for the previous gather or never fires at all.
// Bounded, because a gather that never completes is a result too.
async function waitForGathering(pc, timeoutMs = 3000) {
  const deadline = performance.now() + timeoutMs;
  while (pc.iceGatheringState !== 'complete' && performance.now() < deadline) {
    await sleep(10);
  }
  return pc.iceGatheringState === 'complete';
}

function ufragOf(sdp) {
  const m = /^a=ice-ufrag:(.+)$/m.exec(sdp ?? '');
  return m ? m[1].trim() : null;
}

// ------------------------------------------------------------- ICE restart

// An ICE restart is *defined* by new ICE credentials on both sides, so the four
// ufrags either side of it are the evidence that one happened rather than a
// no-op renegotiation. The recovery figure is measured from `restartIce()` to
// the first frame that arrives after it, which is what a viewer would feel.
async function iceRestart(pc, frames, collect) {
  const before = await collect(pc);
  const framesBefore = frames.length;
  const record = {
    performed: true,
    localUfragBefore: ufragOf(pc.localDescription?.sdp),
    remoteUfragBefore: ufragOf(pc.remoteDescription?.sdp),
    selectedPairIdBefore: before.transport?.selectedCandidatePairId ?? null,
    localCandidateBefore: before.localCandidate ?? null,
    iceStateBefore: pc.iceConnectionState,
    framesBefore,
  };
  const t0 = performance.now();
  pc.restartIce();
  const offer = await pc.createOffer();
  await pc.setLocalDescription(offer);
  // Leaving `complete` first: see waitForGathering.
  const leaveBy = performance.now() + 500;
  while (pc.iceGatheringState === 'complete' && performance.now() < leaveBy) await sleep(5);
  record.gatheringCompleted = await waitForGathering(pc);
  record.offerSentMs = +(performance.now() - t0).toFixed(2);

  const res = await fetch(`${HOST}/reoffer`, {
    method: 'POST',
    headers: { 'content-type': 'application/sdp' },
    body: pc.localDescription.sdp,
  });
  const body = await res.json();
  if (body.error) throw new Error(`host refused the re-offer: ${body.error}`);
  await pc.setRemoteDescription({ type: 'answer', sdp: body.answer });
  record.answerAppliedMs = +(performance.now() - t0).toFixed(2);
  record.localUfragAfter = ufragOf(pc.localDescription?.sdp);
  record.remoteUfragAfter = ufragOf(body.answer);
  record.credentialsChanged =
    record.localUfragAfter !== record.localUfragBefore &&
    record.remoteUfragAfter !== record.remoteUfragBefore;

  // The number that matters: video back on the screen.
  const deadline = performance.now() + 10000;
  while (frames.length === framesBefore && performance.now() < deadline) await sleep(2);
  record.recoveredFrames = frames.length > framesBefore;
  record.firstFrameAfterMs = record.recoveredFrames
    ? +(performance.now() - t0).toFixed(2)
    : null;

  // Let ICE settle before reading the pair back, or the sample lands mid-check.
  await sleep(500);
  const after = await collect(pc);
  record.iceStateAfter = pc.iceConnectionState;
  record.selectedPairIdAfter = after.transport?.selectedCandidatePairId ?? null;
  record.localCandidateAfter = after.localCandidate ?? null;
  record.framesAfter = frames.length;
  record.pliCountAfter = after.inboundVideo?.pliCount ?? null;
  record.freezeCountAfter = after.inboundVideo?.freezeCount ?? null;
  return record;
}

async function connect(receiver, clientConfig) {
  const pc = new RTCPeerConnection({ iceServers: [], bundlePolicy: 'max-bundle' });
  receiver.prepare(pc, clientConfig);

  const offer = await pc.createOffer();
  await pc.setLocalDescription(offer);
  // Non-trickle: wait for gathering to finish, then post one SDP. The host
  // answers with every candidate it has, for the same reason.
  await waitForGathering(pc);

  const res = await fetch(`${HOST}/offer`, {
    method: 'POST',
    headers: { 'content-type': 'application/sdp' },
    body: pc.localDescription.sdp,
  });
  const body = await res.json();
  if (body.error) throw new Error(`host refused the offer: ${body.error}`);
  await pc.setRemoteDescription({ type: 'answer', sdp: body.answer });
  return { pc, hostReply: body };
}

async function run() {
  state('running');
  out.textContent = '';
  say(
    `arm ${ARM} (registered: ${registeredArms().join(', ')}), n=${N}, warmup=${WARMUP}` +
      (ARM === 'a' ? `, dcmode=${DC_MODE}` : ''),
  );

  const granularityMs = clockGranularityMs();
  say(`performance.now() granularity: ${granularityMs} ms`);

  const clockStart = await measureClockOffset(CLOCK_N);
  say(
    `clock offset: ${clockStart.offsetMs.toFixed(4)} ms ± ${clockStart.uncertaintyMs.toFixed(4)} ` +
      `(n=${clockStart.n}, delay p50 ${clockStart.delayP50Ms.toFixed(4)} ms)`,
  );

  const receiver = createReceiver(ARM);
  const frames = [];
  // Live inspection hook. A measurement harness that can only be questioned
  // after it finishes cannot be debugged when it stalls; this is how a run in
  // progress is interrogated (`Runtime.evaluate` over CDP, or the console).
  globalThis.swoopDiag = () => ({ frames: frames.length, receiver: receiver.diagnostics() });
  const { pc, hostReply } = await connect(receiver, {
    metaChannel: 'swoop-meta',
    videoChannel: 'swoop-video',
    transformWorker: '/receivers/transform-worker.js',
    dcMode: DC_MODE,
  });
  // The host answers with the arm it was started as. A page pointed at a host
  // running a different arm produces an offer the host cannot use, and the
  // failure looks like "no frames" rather than like a mismatch — so it is
  // refused here instead.
  if (hostReply.client?.arm && hostReply.client.arm !== ARM) {
    throw new Error(
      `host is running arm ${hostReply.client.arm}, page asked for arm ${ARM}` +
        ' — restart the host with --arm ' + ARM,
    );
  }
  // Part of the same live-inspection hook as `swoopDiag`: a run that stalls has
  // to be answerable while it is stalled, and `getStats` is where the answer is.
  globalThis.swoopStats = () => collectStats(pc);
  say(`host answered; udp ${hostReply.hostUdp}`);
  const negotiated = extmapLines(pc.remoteDescription.sdp);
  const playoutDelayNegotiated = negotiated.some((l) => l.includes('playout-delay'));
  say(`answer extmap: ${negotiated.length} lines, playout-delay ${playoutDelayNegotiated ? 'PRESENT' : 'ABSENT'}`);
  // Arm A negotiates no media line, so there is no RTP, no jitter buffer and
  // nothing for a header extension to be carried on. Only arms B and C have
  // something to warn about.
  if (!playoutDelayNegotiated && ARM !== 'a') {
    say('WARNING: playout-delay was not negotiated. Chrome\'s jitter buffer is free to grow to 40950 ms.');
  }

  const raf = startRafPeriodMonitor();
  let resolveDone;
  const done = new Promise((resolve) => {
    resolveDone = resolve;
  });
  // Handed to `start` rather than registered separately: an arm builds its
  // frame plumbing inside `start`, so a callback set before it would be
  // replaced and the first frames would be lost.
  await receiver.start(pc, {
    video,
    present,
    canvas,
    onFrame: (frame) => {
      frames.push(frame);
      if (frames.length % 25 === 0) state(`running — ${frames.length}/${N + WARMUP}`);
      if (frames.length >= N + WARMUP) resolveDone();
    },
  });
  // The series length decides the deadline, not a constant: the 60 s 50 Mbps
  // arm A row is 3 600 frames and would trip a fixed 90 s budget on the last
  // hundred.
  const budgetMs = Math.max(90000, Math.round(((N + WARMUP) / 60) * 1000 * 1.8));
  // A run that produces no frames at all fails at the deadline with nothing but
  // "0 frames" to go on, which is the least useful moment to have to start
  // debugging. These two reports cost nothing when the run is healthy — they
  // only fire while `frames` is still empty.
  const stillNothing = [5000, 20000].map((at) =>
    setTimeout(() => {
      if (frames.length === 0) say(`no frames after ${at / 1000} s: ${JSON.stringify(receiver.diagnostics())}`);
    }, at),
  );
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(
      () => reject(new Error(`only ${frames.length} frames in ${(budgetMs / 1000).toFixed(0)} s`)),
      budgetMs,
    );
  });
  try {
    await Promise.race([done, timeout]);
  } finally {
    clearTimeout(timer);
    stillNothing.forEach(clearTimeout);
  }

  let iceRestartResult = { performed: false };
  if (ICE_RESTART) {
    say('series complete — performing an ICE restart on the live peer');
    try {
      iceRestartResult = await iceRestart(pc, frames, collectStats);
      say(
        `ICE restart: credentials changed ${iceRestartResult.credentialsChanged}, ` +
          `first frame back ${iceRestartResult.firstFrameAfterMs} ms, ` +
          `state ${iceRestartResult.iceStateAfter}`,
      );
    } catch (err) {
      iceRestartResult = { performed: true, error: String(err.message ?? err) };
      say(`ICE restart FAILED: ${iceRestartResult.error}`);
    }
  }

  const stats = await collectStats(pc);
  const rafResult = raf.stop();
  receiver.stop();
  const clockEnd = await measureClockOffset(Math.min(CLOCK_N, 200));
  let hostReport = null;
  try {
    hostReport = await (await fetch(`${HOST}/hostreport`, { cache: 'no-store' })).json();
  } catch (err) {
    say(`host report unavailable: ${err.message}`);
  }
  pc.close();

  const result = build({
    frames,
    granularityMs,
    clockStart,
    clockEnd,
    rafResult,
    stats,
    hostReport,
    hostReply,
    iceRestartResult,
    negotiated,
    playoutDelayNegotiated,
    receiverDiagnostics: receiver.diagnostics(),
  });

  say('');
  say(result.text);
  state('done');
  if (POST) {
    try {
      const res = await fetch('/result', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(result.json),
      });
      const body = await res.json();
      say(`\nwritten: ${body.written ?? body.error}`);
    } catch (err) {
      say(`\nPOST failed: ${err.message}`);
    }
  }
  return result;
}

function build(ctx) {
  const { frames, clockStart } = ctx;
  const freq = clockStart.qpcFreq;
  const offset = clockStart.offsetMs;
  // qpcMs ≈ performance.now() + offset, so a host event in the browser's own
  // clock is (ticks / freq * 1000) − offset.
  const toPerf = (ticks) => (ticks * 1000) / freq - offset;
  const ms = (ticks) => (ticks * 1000) / freq;

  const measured = frames.slice(WARMUP);
  const warmup = frames.slice(0, WARMUP);
  const rvf = [];
  const rvfcf = [];
  const hostCapture = [];
  const hostEncode = [];
  const hostQueue = [];
  const hostTotal = [];
  const netArrival = [];
  const decode = [];
  const arrivalToRv = [];
  const presentToRv = [];
  const readbackCost = [];
  const stimulusPhase = [];
  // Arms A and C only: they own their presentation, so the two steps arm B's
  // user agent performs for it are visible here and are measured separately
  // rather than folded into one number that would not mean the same thing.
  const decodeOutToDrawn = [];
  const drawnToRv = [];
  const workerHop = [];
  // The arm-B-comparable instant for arms A and C.
  //
  // `_rv` is defined as the renderer reading its pixels back (spike 0.1 §2.1),
  // and for a canvas arm that is literally what the probe does — so arm A's and
  // arm C's `_rv` carries the probe's own cost, while arm B's comes from the
  // user agent's `presentationTime` and carries none (`receiver.js` explains
  // why arm B cannot afford a per-frame readback). Comparing the three on `_rv`
  // alone would charge A and C for an instrument B was not charged for, so the
  // draw instant — the same "submitted for composition" boundary the user agent
  // reports for arm B — is published as its own row and the difference between
  // the two is `drawn -> readback`.
  const presentToDrawn = [];
  const rafPeriods = ctx.rafResult.periods.filter((p) => p > 0);
  // The startup drain, kept as evidence rather than dropped: a reader has to be
  // able to see that the excluded frames were a monotonic drain and not an
  // inconvenient tail that was trimmed away.
  const warmupRv = warmup
    .filter((f) => Number.isFinite(f.rvMs))
    .map((f) => f.rvMs - toPerf(f.stamps.desktopPresent));
  const rafP50 = summarize(rafPeriods).p50 ?? 16.7;

  for (const f of measured) {
    const s = f.stamps;
    const presentPerf = toPerf(s.desktopPresent);
    if (Number.isFinite(f.rvMs)) rvf.push(f.rvMs - presentPerf);
    if (Number.isFinite(f.callbackMs)) rvfcf.push(f.callbackMs - presentPerf);
    hostCapture.push(ms(s.acquired - s.desktopPresent));
    hostEncode.push(ms(s.encodeDone - s.encodeSubmit));
    hostQueue.push(ms(s.pushed - s.enqueued));
    hostTotal.push(ms(s.pushed - s.desktopPresent));
    if (Number.isFinite(f.arrivalMs)) {
      netArrival.push(f.arrivalMs - toPerf(s.pushed));
      if (Number.isFinite(f.rvMs)) arrivalToRv.push(f.rvMs - f.arrivalMs);
    }
    if (Number.isFinite(f.decodeMs)) decode.push(f.decodeMs);
    if (Number.isFinite(f.presentedMs) && Number.isFinite(f.callbackMs)) {
      presentToRv.push(f.callbackMs - f.presentedMs);
    }
    if (Number.isFinite(f.readbackCostMs)) readbackCost.push(f.readbackCostMs);
    if (Number.isFinite(f.drawnMs) && Number.isFinite(f.callbackMs)) {
      decodeOutToDrawn.push(f.drawnMs - f.callbackMs);
    }
    if (Number.isFinite(f.drawnMs) && Number.isFinite(f.rvMs)) drawnToRv.push(f.rvMs - f.drawnMs);
    if (Number.isFinite(f.drawnMs)) presentToDrawn.push(f.drawnMs - presentPerf);
    if (Number.isFinite(f.workerHopMs)) workerHop.push(f.workerHopMs);
    // How much of the refresh period the stimulus actually sampled. On a
    // same-machine row the host compositor and Chrome's compositor share one
    // vsync, so this can be narrow — which is a finding, not a defect, and it
    // has to be visible rather than assumed away (spike 0.1 §2.3).
    stimulusPhase.push(((presentPerf % rafP50) + rafP50) % rafP50);
  }

  const placement = ctx.hostReport?.placement ?? 'unknown';
  const rankingOnly = placement === 'same-machine';
  const rows = [
    ['_rv  present -> composition', summarize(rvf)],
    ['_rv* present -> drawn (A/C)', summarize(presentToDrawn)],
    ['     present -> rVFC callback', summarize(rvfcf)],
    ['host capture (present->acquire)', summarize(hostCapture)],
    ['host encode (submit->done)', summarize(hostEncode)],
    ['host queue (enqueue->push)', summarize(hostQueue)],
    ['host total (present->push)', summarize(hostTotal)],
    ['net+jitter (push->arrival)', summarize(netArrival)],
    ['decode (processingDuration)', summarize(decode)],
    ['arrival -> composition', summarize(arrivalToRv)],
    ['rVFC callback - presentation', summarize(presentToRv)],
    ['decoder output -> drawn (A/C)', summarize(decodeOutToDrawn)],
    ['drawn -> readback (A/C)', summarize(drawnToRv)],
    ['transform worker hop (C)', summarize(workerHop)],
    ['readback cost (probe)', summarize(readbackCost)],
    ['rafPeriodContinuous', summarize(rafPeriods)],
    ['stimulus phase within refresh', summarize(stimulusPhase)],
    ['warmup _rv (drain, excluded)', summarize(warmupRv)],
  ];

  const header = [
    `arm ${ARM}${ARM === 'a' ? ` (${DC_MODE})` : ''} · ${ctx.hostReport?.codec ?? '?'} · placement "${placement}"` +
      (rankingOnly ? '  << RANKING ONLY — never an absolute product latency (0.1 §2.2) >>' : ''),
    `n measured ${measured.length} (warmup ${WARMUP} dropped) · rafPeriodContinuous p50 ${rafP50.toFixed(2)} ms` +
      ` · ${rafP50 >= 16.6 && rafP50 <= 16.8 ? '60 Hz client confirmed' : 'NOT a 60 Hz client — this row is unlabelled'}`,
    `clock offset ${offset.toFixed(4)} ms ± ${clockStart.uncertaintyMs.toFixed(4)} (n=${clockStart.n});` +
      ` no cross-clock figure below is quoted finer than that`,
    'C_photon(60 Hz, this box) = 10.1 ms (compositor, measured proxy) + S, where S = scanout + panel =' +
      ' PENDING [human] (spike 0.1 §5.3). Every figure here is renderer-visible (_rv). No photon number exists.',
    '_rv* is the arms A/C row that is comparable with arm B\'s _rv: arm B\'s comes from the user' +
      ' agent\'s presentationTime and carries no readback, and these arms read back per frame.',
  ].join('\n');

  const text = `${header}\n\n${table(rows)}`;

  const json = {
    spike: '0.2 stage 2',
    arm: ARM,
    // Arm A's reliability mode. Recorded for every arm so a row can never be
    // read as a mode it was not taken in; it is `null` where it means nothing.
    dcMode: ARM === 'a' ? DC_MODE : null,
    label: LABEL,
    when: new Date().toISOString(),
    placement,
    placementNote: ctx.hostReport?.placementNote ?? null,
    rankingOnly,
    browser: {
      userAgent: navigator.userAgent,
      performanceNowGranularityMs: ctx.granularityMs,
      devicePixelRatio: devicePixelRatio,
      crossOriginIsolated: self.crossOriginIsolated,
      hardwareConcurrency: navigator.hardwareConcurrency,
    },
    clock: { start: clockStart, end: ctx.clockEnd, driftMs: ctx.clockEnd.offsetMs - clockStart.offsetMs },
    refresh: {
      rafPeriodContinuous: summarize(rafPeriods),
      sixtyHzConfirmed: rafP50 >= 16.6 && rafP50 <= 16.8,
      windowEverHidden: ctx.rafResult.everHidden,
    },
    negotiation: {
      extmap: ctx.negotiated,
      playoutDelayNegotiated: ctx.playoutDelayNegotiated,
      hostReply: { hostUdp: ctx.hostReply.hostUdp, client: ctx.hostReply.client },
    },
    series: Object.fromEntries(rows.map(([k, v]) => [k, v])),
    startup: {
      framesDropped: warmup.length,
      firstRvMs: warmupRv.length ? +warmupRv[0].toFixed(2) : null,
      lastRvMs: warmupRv.length ? +warmupRv[warmupRv.length - 1].toFixed(2) : null,
      note:
        'a freshly connected stream starts several refresh periods behind and drains' +
        ' one period per refresh; these frames are excluded from every series above',
    },
    getStats: ctx.stats,
    iceRestart: ctx.iceRestartResult,
    receiver: ctx.receiverDiagnostics,
    host: ctx.hostReport,
    frames: measured.map((f) => ({
      frameId: f.frameId,
      rtp: f.rtp,
      irap: f.irap,
      bytes: f.bytes,
      codec: f.codec,
      stamps: f.stamps,
      arrivalMs: f.arrivalMs,
      decodeMs: f.decodeMs,
      presentedMs: f.presentedMs,
      expectedDisplayMs: f.expectedDisplayMs,
      callbackMs: f.callbackMs,
      drawnMs: f.drawnMs ?? null,
      workerHopMs: f.workerHopMs ?? null,
      rvMs: f.rvMs,
      readbackMs: f.readbackMs,
      readbackCostMs: f.readbackCostMs,
    })),
    text: null,
  };
  json.text = text;
  return { text, json };
}

function go() {
  run().catch((err) => {
    say(`FAILED: ${String(err.stack ?? err.message).split('\n').join(' | ')}`);
    state('failed');
  });
}

say(`harness loaded; arms ${registeredArms().join(',')}`);
document.getElementById('go').addEventListener('click', go);
if (AUTORUN) go();
