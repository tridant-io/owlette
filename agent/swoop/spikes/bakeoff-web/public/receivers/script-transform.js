// **Arm C** — arm B's RTP sender, read back through a receive-side
// `RTCRtpScriptTransform` and decoded by WebCodecs into a canvas this page owns.
//
// The question this arm exists to answer is a contradiction in the research:
//
// - `research/02-browser-client.md` §4.6 calls it "the single highest-value
//   one-day spike in the whole browser workstream" and says plainly that it
//   could not be established from a primary source whether the receive-side
//   transform runs **before or after** libwebrtc's frame buffer.
// - `research/01-parsec-and-peers.md` §1(e) asserts the opposite is settled:
//   "It does **not** let you bypass the jitter buffer — the receive-side
//   transform sits after depacketization but the frame still goes through
//   `VCMTiming`."
//
// If the transform is ahead of the frame buffer, arm C gets RTP's NACK/RTX,
// TWCC and pacing without the jitter buffer, and should beat arm B. If it is
// behind, arm C is arm B plus a decode hop and must lose. The two are
// distinguishable in this harness without reading any Chromium source: the host
// is the same sender with the same `playout-delay`, so the difference between
// arm B's `push → arrival` and arm C's `push → transform` is the answer.
//
// Everything after "here are the bytes" is `webcodecs.js`, shared with arm A,
// so the two arms are comparable. The host's stamps arrive on the same
// `swoop-meta` channel arm B uses, joined on the RTP timestamp by the same
// `FrameJoiner` — an RTP track has nowhere to carry them, and that is a
// property of the sender, which arm C shares.

import { FrameJoiner, ReadbackProbe, registerReceiver } from './receiver.js';
import { WebCodecsPresenter, codecStringFromAccessUnit } from './webcodecs.js';

class ScriptTransformReceiver {
  constructor() {
    this.arm = 'c';
    this.worker = null;
    this.presenter = null;
    this.probe = null;
    this.joiner = null;
    this.metaChannel = null;
    this.receiver = null;
    this.stream = null;
    this.trackSettled = null;
    this.onFrameCallback = null;
    this.running = false;

    this.supported = typeof RTCRtpScriptTransform !== 'undefined';
    this.transformAttached = false;
    this.transformShape = null;
    this.transformEnded = false;
    this.transformError = null;
    this.workerFrames = 0;
    this.workerBytes = 0;
    this.keyFrames = 0;
    this.framesObserved = 0;
    this.metaRecords = 0;
    this.metaParseErrors = 0;
    this.framesBeforeConfig = 0;
    this.codecStringFromStream = null;
    this.hopMs = [];
    this.firstFrameMs = null;
    this.lastFrameMs = null;
    this.pendingHop = new Map();
  }

  /** Called before `createOffer`. The sender is arm B's, so the offer is too. */
  prepare(pc, config) {
    if (!this.supported) {
      throw new Error('RTCRtpScriptTransform is missing; arm C cannot be measured here');
    }
    const transceiver = pc.addTransceiver('video', { direction: 'recvonly' });
    // Reliable and ordered, exactly as arm B: the stamps are a join key, so
    // their own delivery latency never enters a measured figure, but losing one
    // loses a whole sample.
    this.metaChannel = pc.createDataChannel(config.metaChannel ?? 'swoop-meta');
    this.metaChannel.onmessage = (event) => this.#onMeta(event.data);

    this.worker = new Worker(config.transformWorker ?? '/receivers/transform-worker.js');
    this.worker.onmessage = (event) => this.#onWorker(event.data);
    this.worker.onerror = (event) => {
      this.transformError = `worker: ${event.message}`;
      globalThis.beacon?.(`arm C: ${this.transformError}`);
    };

    // **Here, not in `ontrack`.** Every published example sets
    // `receiver.transform` inside `ontrack`, and on Chrome 153 that is too late
    // for a receiver: measured three times, the worker's `rtctransform` event
    // fired, `transformer.readable`, `writable`, `options` and
    // `sendKeyFrameRequest` were all present, and `reader.read()` then never
    // resolved once in 90 seconds while RTP flowed and the host's side channel
    // delivered 60 stamp records a second. `ontrack` fires during
    // `setRemoteDescription`, by which point the receive stream already exists
    // and its frame transformer has been wired without one. The transceiver's
    // receiver exists as soon as `addTransceiver` returns, which is before the
    // offer is even created, so that is where the transform goes. Moving this
    // one assignment was the only change between the last run that produced
    // nothing and the first that produced a picture.
    this.receiver = transceiver.receiver;
    try {
      this.receiver.transform = new RTCRtpScriptTransform(this.worker, { arm: 'c' });
    } catch (err) {
      this.transformError = `attach: ${err.message}`;
    }

    const settled = { resolve: null };
    this.trackSettled = new Promise((resolve) => {
      settled.resolve = resolve;
    });
    pc.ontrack = (event) => {
      this.stream = event.streams[0] ?? new MediaStream([event.track]);
      settled.resolve(event);
    };
  }

  /**
   * Called once the answer has been applied.
   *
   * The harness's `video` element is deliberately not used. This receiver
   * consumes every encoded frame and writes none back, so the element would
   * never get a picture — and `HTMLMediaElement.play()` on a stream that never
   * produces a frame returns a promise that never settles, which turned a
   * working arm into a silent hang with no error anywhere. Bypassing the
   * element is the whole point of arm C in any case.
   */
  async start(pc, { present, canvas, onFrame }) {
    this.onFrameCallback = onFrame;
    this.probe = new ReadbackProbe(canvas, 1);
    this.presenter = new WebCodecsPresenter({
      canvas: present,
      probe: this.probe,
      onObservation: (rtp, observation) => this.#onPresented(rtp, observation),
    });
    this.joiner = new FrameJoiner((frame) => {
      this.framesObserved += 1;
      this.onFrameCallback?.(frame);
    });
    this.running = true;

    await this.trackSettled;
    if (this.transformError) throw new Error(`arm C transform: ${this.transformError}`);
  }

  onFrame(cb) {
    this.onFrameCallback = cb;
  }

  stop() {
    this.running = false;
    this.presenter?.close();
    this.worker?.terminate();
  }

  diagnostics() {
    const hops = this.hopMs.slice().sort((a, b) => a - b);
    return {
      arm: this.arm,
      present: 'canvas',
      scriptTransformSupported: this.supported,
      transformAttached: this.transformAttached,
      transformShape: this.transformShape,
      transformEnded: this.transformEnded,
      transformError: this.transformError,
      framesFromTransform: this.workerFrames,
      keyFramesFromTransform: this.keyFrames,
      bytesFromTransform: this.workerBytes,
      framesObserved: this.framesObserved,
      framesDroppedBeforeConfig: this.framesBeforeConfig,
      codecStringFromStream: this.codecStringFromStream,
      metaRecords: this.metaRecords,
      metaParseErrors: this.metaParseErrors,
      metaChannelState: this.metaChannel?.readyState ?? 'none',
      // The cost of doing the decode on the page rather than in the worker.
      // Reported so it can be subtracted, not hidden inside arm C's total.
      workerHopMsP50: hops.length ? +hops[Math.floor(hops.length / 2)].toFixed(3) : null,
      workerHopMsP95: hops.length
        ? +hops[Math.min(hops.length - 1, Math.ceil(0.95 * hops.length) - 1)].toFixed(3)
        : null,
      transformBytesPerSecond:
        this.firstFrameMs !== null && this.lastFrameMs > this.firstFrameMs
          ? Math.round((this.workerBytes * 1000) / (this.lastFrameMs - this.firstFrameMs))
          : null,
      decoder: this.presenter?.diagnostics() ?? null,
      join: this.joiner?.diagnostics() ?? null,
    };
  }

  #onWorker(message) {
    if (message.type === 'attached') {
      this.transformAttached = true;
      this.transformShape = message.shape ?? null;
      globalThis.beacon?.(`arm C transform attached: ${JSON.stringify(message.shape)}`);
      return;
    }
    if (message.type === 'ended') {
      this.transformEnded = true;
      return;
    }
    if (message.type === 'error') {
      this.transformError = message.message;
      globalThis.beacon?.(`arm C worker: ${message.message}`);
      return;
    }
    if (message.type !== 'frame' || !this.running) return;

    const receivedMs = performance.now();
    if (this.firstFrameMs === null) this.firstFrameMs = receivedMs;
    this.lastFrameMs = receivedMs;
    // The worker's absolute stamp, converted into this document's
    // `performance.now()` base. Both time origins are Unix-epoch milliseconds,
    // so the conversion introduces no error of its own.
    const transformMs = message.atMs - performance.timeOrigin;
    this.workerFrames += 1;
    this.workerBytes += message.byteLength;
    this.hopMs.push(receivedMs - transformMs);

    const bytes = new Uint8Array(message.data);
    const isKey = message.frameType === 'key';
    if (isKey) this.keyFrames += 1;

    if (!this.presenter.configured) {
      if (!isKey) {
        this.framesBeforeConfig += 1;
        return;
      }
      // Arm C has no control channel of its own, so the `VideoDecoder` string
      // is read out of the parameter sets the stream carries in band. Which
      // codec it is comes from the bitstream too: the two NAL header layouts
      // cannot both yield a parameter set, so trying both is unambiguous and
      // removes a config field that could disagree with the wire.
      this.codecStringFromStream =
        codecStringFromAccessUnit(bytes, 'h264') ?? codecStringFromAccessUnit(bytes, 'hevc');
      if (!this.codecStringFromStream) {
        this.framesBeforeConfig += 1;
        return;
      }
      this.presenter
        .configure(this.codecStringFromStream)
        .then(() => this.#submit(bytes, message.rtp, isKey, transformMs, receivedMs))
        .catch((err) => globalThis.beacon?.(`arm C: decoder configure failed: ${err.message}`));
      return;
    }
    this.#submit(bytes, message.rtp, isKey, transformMs, receivedMs);
  }

  #submit(bytes, rtp, isKey, transformMs, receivedMs) {
    this.pendingHop.set(rtp, receivedMs - transformMs);
    this.presenter.decode({
      data: bytes,
      type: isKey ? 'key' : 'delta',
      timestampUs: Math.round((rtp * 1000) / 90),
      key: rtp,
      // The instant the frame left the transform, in the page's clock. This is
      // arm C's analogue of arm B's `receiveTime`, and comparing the two is
      // what settles where the transform sits relative to the frame buffer.
      arrivalMs: transformMs,
    });
  }

  #onPresented(rtp, observation) {
    if (!this.running) return;
    const workerHopMs = this.pendingHop.get(rtp) ?? null;
    this.pendingHop.delete(rtp);
    this.joiner.addClient(rtp >>> 0, { ...observation, workerHopMs });
  }

  #onMeta(text) {
    try {
      const record = JSON.parse(text);
      this.metaRecords += 1;
      this.joiner.addHost({
        frameId: record.frameId,
        rtp: record.rtp >>> 0,
        irap: record.irap,
        bytes: record.bytes,
        codec: record.codec,
        stamps: {
          desktopPresent: record.desktopPresent,
          acquired: record.acquired,
          encodeSubmit: record.encodeSubmit,
          encodeDone: record.encodeDone,
          enqueued: record.enqueued,
          pushed: record.pushed,
        },
      });
    } catch (err) {
      this.metaParseErrors += 1;
      if (this.metaParseErrors === 1) console.warn('meta parse failed', err, text);
    }
  }
}

registerReceiver('c', () => new ScriptTransformReceiver());
