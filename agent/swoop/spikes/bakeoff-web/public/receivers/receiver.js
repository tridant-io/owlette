// The browser half of **the seam**.
//
// plan.md D3 requires that both ends hide the video path behind one seam —
// `transport::VideoSink` on the host, `web/lib/swoop/video/receiver.ts` in the
// browser — "so the second path can be added later without touching capture,
// encode, decode or presentation". This file is that seam for spike 0.2, shaped
// so the product file can be a typed copy of it.
//
// Stage 1 registered arm B only (`rtp-track.js`). Stage 2 added arm A
// (`data-channel.js`) and arm C (`script-transform.js`) by calling
// `registerReceiver`; `bakeoff.js` gained three import lines, a presentation
// canvas to hand to `start`, and three rows that are empty for arm B.
// Everything an arm does between "a peer connection exists" and "a frame is
// visible" stayed inside the arm.
//
// ## The contract
//
// A receiver owns everything between "an RTCPeerConnection exists" and "a frame
// is visible to the renderer, and here is when". It does NOT own signalling,
// the clock exchange, statistics or the run's bookkeeping — those are the
// harness's, and they are identical for every arm, which is the whole point.
//
// ```
//   harness                              receiver
//   -------                              --------
//   new RTCPeerConnection()
//   receiver.prepare(pc, config)  ---->  add transceivers / data channels
//   createOffer / POST / answer
//   receiver.start(pc, config)    ---->  attach media, begin observing
//   receiver.onFrame(cb)          <----  one FrameObservation per presented frame
//   receiver.stop()
//   receiver.diagnostics()        <----  whatever only this arm can know
// ```
//
// ### FrameObservation
//
// Every arm produces the same record, so the harness's arithmetic — and
// therefore the comparison between arms — is identical for all three.
//
// | field | clock | meaning |
// |---|---|---|
// | `frameId` | — | the host's monotonic frame number |
// | `rtp` | 90 kHz | the RTP timestamp, the join key between host and client |
// | `irap` | — | was this an IRAP access unit |
// | `bytes` | — | access-unit size the host sent |
// | `codec` | — | what the host says the bytes are |
// | `stamps` | QPC ticks | the host's six stamps, unconverted |
// | `arrivalMs` | `performance.now()` | last packet of the frame received |
// | `decodeMs` | duration | decoder processing duration, or null |
// | `presentedMs` | `performance.now()` | UA submitted the frame for composition |
// | `expectedDisplayMs` | `performance.now()` | UA's estimate of display time |
// | `callbackMs` | `performance.now()` | the observing callback entered |
// | `rvMs` | `performance.now()` | **renderer-visible** (see below) |
// | `readbackMs` | `performance.now()` | pixels actually read back, on sampled frames only |
//
// `rvMs` is spike 0.1 §2.1's renderer-visible instant: the last moment before
// the client's compositor, excluding its scanout and its panel.
//
// **How an arm fills it differs, and the difference is measured rather than
// waved away.** An arm that presents into a canvas it owns (A and C) can read
// its own pixels back for ~0.00 ms (spike 0.1 §6) and does, per frame. Arm B
// presents into a `<video>` element, where "read the pixels back" means
// `drawImage` from a hardware-decoded video texture plus `getImageData` — a
// GPU→CPU download that **changed what was being measured**: with a readback on
// every presented frame this harness held Chrome to ~22 presented frames a
// second against a 60 fps source, and the stream ran 14 s behind within 25 s.
// So arm B fills `rvMs` from `requestVideoFrameCallback`'s `presentationTime`,
// the user agent's own "submitted for composition" timestamp — the same
// boundary, measured by the UA instead of by a probe that perturbs it — and
// reads pixels back on a sampled subset, into `readbackMs`, to prove the
// picture is live and to publish what the readback would have cost.
//
// A receiver that cannot fill a field sets it to `null`. It never guesses.

/** @type {Map<string, () => VideoReceiver>} */
const registry = new Map();

/**
 * Register an arm. `arm` is the one-letter spelling from plan.md D3 and from
 * the host's `client_config()`: "a", "b" or "c".
 */
export function registerReceiver(arm, factory) {
  if (registry.has(arm)) throw new Error(`receiver for arm ${arm} already registered`);
  registry.set(arm, factory);
}

/**
 * Build the receiver the host says it is running. The host's `client_config()`
 * carries the arm, so the page never has to be edited when an arm is added —
 * it only has to have imported the module that registers it.
 */
export function createReceiver(arm) {
  const factory = registry.get(arm);
  if (!factory) {
    throw new Error(
      `no receiver registered for arm "${arm}" (have: ${[...registry.keys()].join(', ') || 'none'})`,
    );
  }
  return factory();
}

export function registeredArms() {
  return [...registry.keys()];
}

/**
 * The measurement surface every arm presents into, and the one place `rvMs` is
 * defined. Shared deliberately: if each arm read its pixels back its own way,
 * the arms would not be comparable, which is the only thing this spike is for.
 *
 * Small (160x90) and `desynchronized: false`: spike 0.1 §6 measured a
 * synchronized in-DOM presented canvas reading back at 0.00 ms p50 against
 * 0.6-2.3 ms for a desynchronized one. This canvas is an instrument, not a
 * presentation path, so it takes the cheap option.
 *
 * `sampleEvery` exists because the cost is not the same for every source: from
 * a canvas it is free, from a hardware-decoded `<video>` it is a GPU→CPU
 * download that throttles presentation (see the FrameObservation note above).
 * An arm that cannot afford it per frame samples it.
 */
export class ReadbackProbe {
  constructor(canvas, sampleEvery = 1) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d', { desynchronized: false, willReadFrequently: true });
    this.sampleEvery = sampleEvery;
    this.calls = 0;
    this.lastPixel = null;
    this.identicalReads = 0;
    this.distinctPixels = new Set();
    this.reads = 0;
    this.costMs = [];
  }

  /** True when this call is one of the sampled ones. */
  due() {
    this.calls += 1;
    return this.calls % this.sampleEvery === 0;
  }

  /**
   * Draw `source` and read one pixel back. Returns the timestamps around it.
   * `drawMs` and `rvMs` bracket the instrument's own cost, so it can be
   * reported rather than absorbed into the arm's number.
   */
  observe(source) {
    const t0 = performance.now();
    this.ctx.drawImage(source, 0, 0, this.canvas.width, this.canvas.height);
    const drawMs = performance.now();
    const data = this.ctx.getImageData(0, 0, 1, 1).data;
    const rvMs = performance.now();
    this.reads += 1;
    const pixel = (data[0] << 16) | (data[1] << 8) | data[2];
    if (this.lastPixel === pixel) this.identicalReads += 1;
    this.lastPixel = pixel;
    this.distinctPixels.add(pixel);
    this.costMs.push(rvMs - t0);
    return { startMs: t0, drawMs, rvMs, pixel };
  }

  diagnostics() {
    const sorted = this.costMs.slice().sort((a, b) => a - b);
    return {
      framesSeen: this.calls,
      sampleEvery: this.sampleEvery,
      reads: this.reads,
      // Not an error on its own: one sampled pixel can legitimately repeat.
      // It is here so a run against a frozen picture cannot be mistaken for a
      // working one, which `distinctPixels` settles.
      identicalConsecutiveReads: this.identicalReads,
      distinctPixels: this.distinctPixels.size,
      costMsP50: sorted.length ? +sorted[Math.floor(sorted.length / 2)].toFixed(2) : null,
      costMsMax: sorted.length ? +sorted[sorted.length - 1].toFixed(2) : null,
      canvas: `${this.canvas.width}x${this.canvas.height}`,
      desynchronized: false,
    };
  }
}

/**
 * Join host-side per-frame records to client-side observations by RTP
 * timestamp. Both arrive out of order relative to each other — on arm B the
 * stamps travel on an SCTP data channel while the picture travels over RTP —
 * so neither side may assume the other got there first.
 *
 * Bounded on both sides: a run must not be able to grow the tab's memory, and
 * an unmatched record after 240 frames (four seconds at 60 fps) is never going
 * to match.
 */
export class FrameJoiner {
  constructor(emit, limit = 240) {
    this.emit = emit;
    this.limit = limit;
    this.hostRecords = new Map();
    this.clientRecords = new Map();
    this.unmatchedHost = 0;
    this.unmatchedClient = 0;
  }

  addHost(record) {
    const client = this.clientRecords.get(record.rtp);
    if (client) {
      this.clientRecords.delete(record.rtp);
      this.emit({ ...record, ...client });
      return;
    }
    this.hostRecords.set(record.rtp, record);
    this.#trim(this.hostRecords, () => (this.unmatchedHost += 1));
  }

  addClient(rtp, observation) {
    const host = this.hostRecords.get(rtp);
    if (host) {
      this.hostRecords.delete(rtp);
      this.emit({ ...host, ...observation });
      return;
    }
    this.clientRecords.set(rtp, observation);
    this.#trim(this.clientRecords, () => (this.unmatchedClient += 1));
  }

  #trim(map, onDrop) {
    while (map.size > this.limit) {
      const oldest = map.keys().next().value;
      map.delete(oldest);
      onDrop();
    }
  }

  diagnostics() {
    return {
      unmatchedHostRecordsDropped: this.unmatchedHost,
      unmatchedClientFramesDropped: this.unmatchedClient,
      hostRecordsWaiting: this.hostRecords.size,
      clientFramesWaiting: this.clientRecords.size,
      // The last few keys from each side. A join that silently fails looks
      // exactly like a slow stream unless you can see what the two sides are
      // keying on.
      lastHostKeys: [...this.hostRecords.keys()].slice(-5),
      lastClientKeys: [...this.clientRecords.keys()].slice(-5),
    };
  }
}
