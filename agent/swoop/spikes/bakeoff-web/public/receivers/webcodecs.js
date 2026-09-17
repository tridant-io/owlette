// The decode-and-present half that **arms A and C share**.
//
// The two arms differ only in where their encoded bytes come from — an
// `RTCDataChannel` for A, a receive-side `RTCRtpScriptTransform` for C. If they
// also differed in how they decoded or presented, the bake-off would be
// measuring two things at once and could not answer plan.md D3's question. So
// everything after "here are the bytes of one access unit" lives here, once.
//
// The path is `VideoDecoder` → `drawImage` into a canvas this page owns →
// `ReadbackProbe`. `research/02-browser-client.md` §2.4 ranks WebGPU
// `importExternalTexture` fastest and Canvas 2D slowest *for throughput*, and
// recommends WebGPU in a worker for the product. This spike uses Canvas 2D on
// the main thread on purpose:
//
// - the measurement contract (spike 0.1 §2.1) defines renderer-visible as the
//   renderer reading the pixels back out of the surface it drew into, and a 2D
//   context is the one surface `getImageData` can read without a second path;
// - `ReadbackProbe` is shared with arm B, so a presentation path that needed
//   its own probe would make the arms incomparable;
// - the probe publishes its own cost per run, so if Canvas 2D is the limiter
//   that shows up as a number rather than as an unexplained p95.
//
// The cost of the choice is therefore bounded and visible, and the faster
// presentation paths are an optimisation *after* G1, not a variable inside it.

/** `optimizeForLatency` is a hint (02 §2.3) — `decodeQueueSize` is the check. */
const DECODER_CONFIG_BASE = {
  optimizeForLatency: true,
  hardwareAcceleration: 'no-preference',
};

/** Strip emulation-prevention bytes, so a parameter set can be read as RBSP. */
function rbsp(bytes) {
  const out = [];
  let zeros = 0;
  for (const b of bytes) {
    if (zeros >= 2 && b === 3) {
      zeros = 0;
      continue;
    }
    zeros = b === 0 ? zeros + 1 : 0;
    out.push(b);
  }
  return Uint8Array.from(out);
}

/** Annex-B NAL units as `{ type, start, end }`, payload including the header. */
export function parseAnnexB(bytes, codec) {
  const starts = [];
  for (let i = 0; i + 2 < bytes.length; i += 1) {
    if (bytes[i] === 0 && bytes[i + 1] === 0 && bytes[i + 2] === 1) {
      starts.push(i + 3);
      i += 2;
    }
  }
  const out = [];
  for (let n = 0; n < starts.length; n += 1) {
    const start = starts[n];
    let end = n + 1 < starts.length ? starts[n + 1] - 3 : bytes.length;
    while (end > start && bytes[end - 1] === 0) end -= 1;
    if (end <= start) continue;
    const type = codec === 'hevc' ? (bytes[start] >> 1) & 0x3f : bytes[start] & 0x1f;
    out.push({ type, start, end });
  }
  return out;
}

/**
 * The `VideoDecoder` codec string for an access unit that carries parameter
 * sets, read out of the bitstream rather than assumed from the host's flag.
 *
 * Arm A does not need this — its host sends the string it parsed itself, and
 * this is used to cross-check it. Arm C has no side channel to carry one, so
 * this is how it configures its decoder at all.
 */
export function codecStringFromAccessUnit(bytes, codec) {
  const nals = parseAnnexB(bytes, codec);
  if (codec === 'hevc') {
    const sps = nals.find((n) => n.type === 33);
    if (!sps) return null;
    const d = rbsp(bytes.subarray(sps.start + 2, sps.end));
    if (d.length < 13) return null;
    // One byte holds sps_video_parameter_set_id(4) + max_sub_layers_minus1(3)
    // + temporal_id_nesting(1), so profile_tier_level starts at byte 1.
    const ptl = d.subarray(1, 13);
    const profileSpace = ptl[0] >> 6;
    const tier = (ptl[0] >> 5) & 1;
    const profileIdc = ptl[0] & 0x1f;
    let compat = ((ptl[1] << 24) | (ptl[2] << 16) | (ptl[3] << 8) | ptl[4]) >>> 0;
    // The compatibility flags go out bit-reversed, per ISO/IEC 14496-15 §E.3.
    let reversed = 0;
    for (let i = 0; i < 32; i += 1) reversed = ((reversed << 1) | ((compat >>> i) & 1)) >>> 0;
    let out = `hvc1.${profileSpace > 0 ? String.fromCharCode(64 + profileSpace) : ''}${profileIdc}.`;
    out += `${reversed.toString(16).toUpperCase()}.${tier === 1 ? 'H' : 'L'}${ptl[11]}`;
    const constraints = [...ptl.subarray(5, 11)];
    while (constraints.length && constraints[constraints.length - 1] === 0) constraints.pop();
    for (const b of constraints) out += `.${b.toString(16).toUpperCase()}`;
    return out;
  }
  const sps = nals.find((n) => n.type === 7);
  if (!sps) return null;
  const p = bytes.subarray(sps.start + 1, sps.end);
  if (p.length < 3) return null;
  const hex = (v) => v.toString(16).padStart(2, '0');
  return `avc1.${hex(p[0])}${hex(p[1])}${hex(p[2])}`;
}

/**
 * Decode one access unit at a time and present it, reporting the client half of
 * a `FrameObservation` (see `receiver.js`) for every frame that reaches the
 * canvas.
 *
 * The arm supplies a `key` with each chunk and gets the same `key` back with
 * the observation, so arm A can carry its host stamps inline and arm C can join
 * on the RTP timestamp, without this file knowing which is which.
 */
export class WebCodecsPresenter {
  constructor({ canvas, probe, onObservation }) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d', { desynchronized: false, alpha: false });
    this.probe = probe;
    this.onObservation = onObservation;
    this.decoder = null;
    this.codecString = null;
    this.configSupported = null;
    // chunk timestamp (µs) -> what the arm and the clock knew at submit time.
    this.inFlight = new Map();
    this.decoded = 0;
    this.presented = 0;
    this.decodeErrors = [];
    this.droppedBeforeConfigure = 0;
    this.unmatchedOutputs = 0;
    this.maxDecodeQueueSize = 0;
    this.sized = null;
  }

  get configured() {
    return this.decoder !== null && this.decoder.state === 'configured';
  }

  /**
   * Configure the decoder. Annex-B with no `description`, which is the
   * live-streaming form the W3C registrations define and the one the host
   * emits (parameter sets in band on every IRAP).
   */
  async configure(codecString) {
    const config = { ...DECODER_CONFIG_BASE, codec: codecString };
    try {
      const support = await VideoDecoder.isConfigSupported(config);
      this.configSupported = support.supported === true;
      if (!support.supported) throw new Error(`isConfigSupported said no for ${codecString}`);
    } catch (err) {
      this.configSupported = false;
      throw err;
    }
    this.decoder = new VideoDecoder({
      output: (frame) => this.#onFrame(frame),
      error: (err) => this.decodeErrors.push(String(err.message ?? err)),
    });
    this.decoder.configure(config);
    this.codecString = codecString;
  }

  /**
   * Hand one access unit to the decoder. `timestampUs` is the join key as well
   * as the chunk timestamp: WebCodecs copies it onto the decoded `VideoFrame`,
   * which is the only way the output callback can find its way back to the arm's
   * own record.
   */
  decode({ data, type, timestampUs, key, arrivalMs }) {
    if (!this.configured) {
      this.droppedBeforeConfigure += 1;
      return;
    }
    this.inFlight.set(timestampUs, { key, arrivalMs, submitMs: performance.now() });
    this.decoder.decode(new EncodedVideoChunk({ type, timestamp: timestampUs, data }));
    if (this.decoder.decodeQueueSize > this.maxDecodeQueueSize) {
      this.maxDecodeQueueSize = this.decoder.decodeQueueSize;
    }
  }

  #onFrame(frame) {
    // Entered the observing callback — `receiver.js`'s `callbackMs`.
    const callbackMs = performance.now();
    this.decoded += 1;
    const pending = this.inFlight.get(frame.timestamp);
    this.inFlight.delete(frame.timestamp);
    if (this.sized !== `${frame.displayWidth}x${frame.displayHeight}`) {
      this.canvas.width = frame.displayWidth;
      this.canvas.height = frame.displayHeight;
      this.sized = `${frame.displayWidth}x${frame.displayHeight}`;
    }
    this.ctx.drawImage(frame, 0, 0);
    const drawnMs = performance.now();
    const width = frame.displayWidth;
    const height = frame.displayHeight;
    // Immediately, or GPU memory balloons and GC stalls appear (02 §2.4).
    frame.close();

    // Per frame, not sampled: arms A and C own the surface, so the readback is
    // canvas-to-canvas and spike 0.1 §6 measured it at 0.00 ms p50. Arm B
    // cannot afford it and says so in its own receiver.
    const sampled = this.probe.due() ? this.probe.observe(this.canvas) : null;
    this.presented += 1;
    if (!pending) {
      this.unmatchedOutputs += 1;
      return;
    }
    this.onObservation(pending.key, {
      arrivalMs: pending.arrivalMs,
      decodeMs: callbackMs - pending.submitMs,
      // Null on purpose: `presentedMs` is defined as the *user agent's* own
      // "submitted for composition" timestamp, which only `requestVideoFrameCallback`
      // publishes. These arms do the presenting themselves, so the equivalent
      // instant is `drawnMs` and it is reported under its own name rather than
      // borrowed into a field that would then mean two things.
      presentedMs: null,
      expectedDisplayMs: null,
      callbackMs,
      drawnMs,
      width,
      height,
      rvMs: sampled ? sampled.rvMs : null,
      readbackMs: sampled ? sampled.rvMs : null,
      readbackCostMs: sampled ? sampled.rvMs - sampled.startMs : null,
    });
  }

  diagnostics() {
    return {
      codecString: this.codecString,
      configSupported: this.configSupported,
      decoderState: this.decoder?.state ?? 'none',
      framesDecoded: this.decoded,
      framesPresented: this.presented,
      framesDroppedBeforeConfigure: this.droppedBeforeConfigure,
      outputsWithNoSubmitRecord: this.unmatchedOutputs,
      // A rising queue is the early-warning that the decoder is the bottleneck
      // (02 §2.3). Flat at 0-1 means `optimizeForLatency` was honoured.
      maxDecodeQueueSize: this.maxDecodeQueueSize,
      inFlightAtEnd: this.inFlight.size,
      decodeErrors: this.decodeErrors.slice(0, 5),
      canvas: this.sized,
      readback: this.probe?.diagnostics() ?? null,
    };
  }

  close() {
    try {
      if (this.decoder && this.decoder.state !== 'closed') this.decoder.close();
    } catch {
      // A decoder that is already gone is not an error worth failing a run for.
    }
  }
}
