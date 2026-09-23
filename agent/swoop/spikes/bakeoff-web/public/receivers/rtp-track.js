// **Arm B** — RTP media track into a `<video>` element.
//
// The baseline plan.md D3 measures the other two arms against. Everything that
// makes it fast is on the *host* (the `playout-delay` header extension with
// `min = 0`, `max = 100 ms`); the browser's job is to not undo it and to
// observe honestly.
//
// Three things this receiver does and why:
//
// 1. **`receiver.jitterBufferTarget = 0`.** Belt and braces. In Chrome this is
//    a *minimum*, not a target (`SetJitterBufferMinimumDelay` →
//    `base_minimum_playout_delay_`), so it can only raise the floor; setting it
//    to 0 makes sure the page is not the thing raising it. The host's
//    `max = 100 ms` overrides it either way — `UpdatePlayoutDelays()` clamps
//    `minimum_delay` down to the frame's maximum (research/06 §1.2).
// 2. **`requestVideoFrameCallback` to observe, never `requestAnimationFrame`.**
//    plan.md D17 and spike 0.1 §4.5: rAF's `timestamp` went 16.1 ms *negative*
//    relative to a draw that preceded the callback, and an rAF-scheduled
//    sampler adds mean 8.35 ms of pure quantisation to whatever it samples.
//    rVFC fires per presented frame and carries `receiveTime`,
//    `processingDuration` and `rtpTimestamp`, which is what makes an RTP track
//    measurable at all.
// 3. **The data channel is opened by the browser**, because the browser is the
//    offerer (plan.md D8) and an RTP track has nowhere to carry the host's
//    stamps. The join key is `rtpTimestamp`, which the host writes as the low
//    32 bits of the same 90 kHz media time it hands to str0m.

import { FrameJoiner, ReadbackProbe, registerReceiver } from './receiver.js';

class RtpTrackReceiver {
  constructor() {
    this.arm = 'b';
    this.video = null;
    this.probe = null;
    this.joiner = null;
    this.metaChannel = null;
    this.onFrameCallback = null;
    this.running = false;
    this.framesObserved = 0;
    this.metaRecords = 0;
    this.metaParseErrors = 0;
    this.trackSettled = null;
    this.jitterBufferTargetApplied = null;
    this.rvfcSupported = typeof HTMLVideoElement !== 'undefined'
      && 'requestVideoFrameCallback' in HTMLVideoElement.prototype;
  }

  /** Called before `createOffer`. */
  prepare(pc, config) {
    pc.addTransceiver('video', { direction: 'recvonly' });
    // Reliable and ordered (the defaults). The stamps are only a join key, so
    // their own delivery latency never enters a measured figure — but losing
    // one loses a whole sample, so reliability is worth more here than speed.
    this.metaChannel = pc.createDataChannel(config.metaChannel ?? 'swoop-meta');
    this.metaChannel.onmessage = (event) => this.#onMeta(event.data);

    const settled = { resolve: null };
    this.trackSettled = new Promise((resolve) => {
      settled.resolve = resolve;
    });
    pc.ontrack = (event) => {
      this.stream = event.streams[0] ?? new MediaStream([event.track]);
      this.receiver = event.receiver;
      settled.resolve(event);
    };
  }

  /** Called once the answer has been applied. */
  async start(pc, { video, canvas, onFrame }) {
    this.video = video;
    // One readback in thirty. Per frame it costs a GPU→CPU download of a
    // hardware-decoded texture, which throttled Chrome to ~22 presented frames
    // a second against a 60 fps source — the instrument changing the
    // measurement. See the FrameObservation note in receiver.js.
    this.probe = new ReadbackProbe(canvas, 30);
    this.onFrameCallback = onFrame;
    this.joiner = new FrameJoiner((frame) => {
      this.framesObserved += 1;
      this.onFrameCallback?.(frame);
    });
    this.running = true;

    await this.trackSettled;
    try {
      // See the module doc: a floor, not a target, and the host's max wins.
      this.receiver.jitterBufferTarget = 0;
      this.jitterBufferTargetApplied = this.receiver.jitterBufferTarget;
    } catch (err) {
      this.jitterBufferTargetApplied = `unsupported: ${err.message}`;
    }
    this.video.srcObject = this.stream;
    await this.video.play();

    if (!this.rvfcSupported) {
      throw new Error(
        'requestVideoFrameCallback is missing; arm B cannot be measured in this browser',
      );
    }
    this.video.requestVideoFrameCallback((now, metadata) => this.#onPresented(now, metadata));
  }

  onFrame(cb) {
    this.onFrameCallback = cb;
  }

  stop() {
    this.running = false;
    if (this.video) this.video.srcObject = null;
  }

  diagnostics() {
    return {
      arm: this.arm,
      present: 'video',
      framesObserved: this.framesObserved,
      metaRecords: this.metaRecords,
      metaParseErrors: this.metaParseErrors,
      metaChannelState: this.metaChannel?.readyState ?? 'none',
      jitterBufferTargetApplied: this.jitterBufferTargetApplied,
      requestVideoFrameCallback: this.rvfcSupported,
      readback: this.probe?.diagnostics() ?? null,
      join: this.joiner?.diagnostics() ?? null,
    };
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

  #onPresented(callbackMs, metadata) {
    if (!this.running) return;
    const sampled = this.probe.due() ? this.probe.observe(this.video) : null;
    this.joiner.addClient(metadata.rtpTimestamp >>> 0, {
      // `receiveTime` is the time the last packet of this frame arrived. It is
      // the only arrival timestamp a `<video>` element exposes, and it is why
      // this arm can be split into stages at all.
      arrivalMs: metadata.receiveTime ?? null,
      // Seconds per the spec, unlike every other field here.
      decodeMs:
        typeof metadata.processingDuration === 'number'
          ? metadata.processingDuration * 1000
          : null,
      presentedMs: metadata.presentationTime ?? null,
      expectedDisplayMs: metadata.expectedDisplayTime ?? null,
      presentedFrames: metadata.presentedFrames ?? null,
      width: metadata.width ?? null,
      height: metadata.height ?? null,
      callbackMs,
      // Renderer-visible for a `<video>`: the user agent's own "submitted for
      // composition" timestamp, which is the boundary spike 0.1 §2.1 defines
      // and the one a per-frame pixel readback would have moved.
      rvMs: metadata.presentationTime ?? null,
      readbackMs: sampled ? sampled.rvMs : null,
      readbackCostMs: sampled ? sampled.rvMs - sampled.startMs : null,
    });
    this.video.requestVideoFrameCallback((now, meta) => this.#onPresented(now, meta));
  }
}

registerReceiver('b', () => new RtpTrackReceiver());
