// **Arm A** — encoded access units over an `RTCDataChannel`, into WebCodecs.
//
// The browser is the offerer (plan.md D8), so the browser opens the channel —
// which means the **reliability mode is set here**, and review-1 F2's matrix is
// a one-line change per row:
//
// | `?dcmode=` | `createDataChannel` options | why it is in the matrix |
// |---|---|---|
// | `ordered-lifetime` (default) | `{ordered: true, maxPacketLifeTime: 50}` | F2's recommendation: one intra-deadline retransmit on a short path, abandoned cleanly on a long one. 50 ms is three frame intervals at 60 fps — not moonlight-web's 500 ms, whose host is behind a GameStream hop and ours is not. |
// | `unordered-nortx` | `{ordered: false, maxRetransmits: 0}` | What the draft plan specified. F2(a): a 200 KB access unit is ~170 chunks, so P(frame survives) at 1% loss is 0.99^170 ≈ 18%. |
// | `unordered-lifetime` | `{ordered: false, maxPacketLifeTime: 50}` | The third corner: partial reliability without head-of-line blocking. |
// | `reliable` | `{ordered: true}` | The control row. Not in F2's matrix; it is here so "what did partial reliability cost on a clean path" has an answer. |
//
// Reassembly is keyed on `frameId` and tolerates both reordering and loss,
// because two of the four modes deliver fragments out of order and two of them
// can lose one outright. A frame that never completes is counted, never guessed
// at: review-1 F2(c) records that moonlight-web tried a frontend reorder buffer
// and **removed** it because it caused IDR floods and latency.
//
// On a `frameId` gap this receiver asks the host for an IDR, which is arm A's
// entire loss-recovery story: there is no RTP here, so there is no NACK, no RTX
// and no PLI.

import { ReadbackProbe, registerReceiver } from './receiver.js';
import { WebCodecsPresenter, codecStringFromAccessUnit } from './webcodecs.js';

const KIND_CONTROL = 0;
const KIND_FRAGMENT = 1;
// Synthetic load from the host's `--dc-load`, counted and discarded. It exists
// because NVENC would not produce 50 Mbps on this box's desktop content and
// review-1 F1's criterion is written at 50 Mbps; see the host's `data_channel.rs`.
const KIND_PADDING = 2;
const FLAG_IRAP = 1 << 0;
const COMMON_HEADER_BYTES = 10;
const FRAME_HEADER_BYTES = 58;

/** Two seconds at 60 fps. A frame still incomplete after that never will be. */
const MAX_FRAMES_IN_FLIGHT = 120;

/** Don't turn one lossy second into an IDR flood — F2(c)'s warning. */
const IDR_REQUEST_COOLDOWN_MS = 200;

/** The modes review-1 F2 asks to be measured, plus a fully reliable control. */
export const DC_MODES = {
  'ordered-lifetime': { ordered: true, maxPacketLifeTime: 50 },
  'unordered-nortx': { ordered: false, maxRetransmits: 0 },
  'unordered-lifetime': { ordered: false, maxPacketLifeTime: 50 },
  reliable: { ordered: true },
};

class DataChannelReceiver {
  constructor() {
    this.arm = 'a';
    this.channel = null;
    this.mode = null;
    this.modeOptions = null;
    this.presenter = null;
    this.probe = null;
    this.onFrameCallback = null;
    this.running = false;

    this.assembly = new Map();
    this.hostConfig = null;
    this.codecStringFromStream = null;
    this.framesComplete = 0;
    this.framesIncomplete = 0;
    this.framesBeforeConfig = 0;
    this.fragmentsReceived = 0;
    this.bytesReceived = 0;
    this.outOfOrderFragments = 0;
    this.duplicateFragments = 0;
    this.headerErrors = 0;
    this.paddingMessages = 0;
    this.paddingBytes = 0;
    this.gapsSeen = 0;
    this.idrRequestsSent = 0;
    this.lastIdrRequestMs = -Infinity;
    this.highestFrameId = -1;
    this.firstMessageMs = null;
    this.lastMessageMs = null;
  }

  /** Called before `createOffer`. Arm A negotiates no media at all. */
  prepare(pc, config) {
    this.mode = DC_MODES[config.dcMode] ? config.dcMode : 'ordered-lifetime';
    this.modeOptions = DC_MODES[this.mode];
    this.channel = pc.createDataChannel(config.videoChannel ?? 'swoop-video', this.modeOptions);
    this.channel.binaryType = 'arraybuffer';
    this.channel.onmessage = (event) => this.#onMessage(event.data);
  }

  /** Called once the answer has been applied. */
  async start(pc, { present, canvas, onFrame }) {
    this.onFrameCallback = onFrame;
    // Per frame, not sampled: this arm owns the surface, so the readback is
    // canvas-to-canvas rather than a GPU→CPU download of a decoded video
    // texture. `receiver.js` documents the split.
    this.probe = new ReadbackProbe(canvas, 1);
    this.presenter = new WebCodecsPresenter({
      canvas: present,
      probe: this.probe,
      onObservation: (record, observation) => this.#emit(record, observation),
    });
    this.running = true;
    await this.#channelOpen();
  }

  onFrame(cb) {
    this.onFrameCallback = cb;
  }

  stop() {
    this.running = false;
    this.presenter?.close();
  }

  diagnostics() {
    return {
      arm: this.arm,
      present: 'canvas',
      dcMode: this.mode,
      dcOptions: this.modeOptions,
      // What the channel actually negotiated, which is not always what was
      // asked for: `maxRetransmits` and `maxPacketLifeTime` are mutually
      // exclusive and the UA may null one out.
      dcNegotiated: this.channel
        ? {
            readyState: this.channel.readyState,
            ordered: this.channel.ordered,
            maxPacketLifeTime: this.channel.maxPacketLifeTime,
            maxRetransmits: this.channel.maxRetransmits,
            protocol: this.channel.protocol,
            id: this.channel.id,
            bufferedAmount: this.channel.bufferedAmount,
          }
        : null,
      hostConfig: this.hostConfig,
      codecStringFromStream: this.codecStringFromStream,
      framesComplete: this.framesComplete,
      framesIncomplete: this.framesIncomplete,
      framesDroppedBeforeConfig: this.framesBeforeConfig,
      fragmentsReceived: this.fragmentsReceived,
      bytesReceived: this.bytesReceived,
      outOfOrderFragments: this.outOfOrderFragments,
      duplicateFragments: this.duplicateFragments,
      frameHeaderErrors: this.headerErrors,
      paddingMessages: this.paddingMessages,
      paddingBytes: this.paddingBytes,
      frameIdGaps: this.gapsSeen,
      idrRequestsSent: this.idrRequestsSent,
      // Goodput over the channel's own lifetime, which is what review-1 F1
      // asks to be reported as a number.
      channelBytesPerSecond:
        this.firstMessageMs !== null && this.lastMessageMs > this.firstMessageMs
          ? Math.round((this.bytesReceived * 1000) / (this.lastMessageMs - this.firstMessageMs))
          : null,
      // Video only. `channelBytesPerSecond` above is everything the channel
      // carried, synthetic load included; this is the half that was a picture.
      videoBytesPerSecond:
        this.firstMessageMs !== null && this.lastMessageMs > this.firstMessageMs
          ? Math.round(
              ((this.bytesReceived - this.paddingBytes) * 1000) /
                (this.lastMessageMs - this.firstMessageMs),
            )
          : null,
      decoder: this.presenter?.diagnostics() ?? null,
    };
  }

  #channelOpen() {
    if (this.channel.readyState === 'open') return Promise.resolve();
    return new Promise((resolve, reject) => {
      this.channel.onopen = () => resolve();
      this.channel.onerror = (e) => reject(new Error(`data channel error: ${e.message ?? e}`));
      setTimeout(() => reject(new Error('data channel never opened in 15 s')), 15000);
    });
  }

  #emit(record, observation) {
    if (!this.running) return;
    this.onFrameCallback?.({ ...record, ...observation });
  }

  #onMessage(buffer) {
    const atMs = performance.now();
    if (this.firstMessageMs === null) this.firstMessageMs = atMs;
    this.lastMessageMs = atMs;
    const bytes = new Uint8Array(buffer);
    this.bytesReceived += bytes.length;
    if (bytes.length === 0) return;
    if (bytes[0] === KIND_CONTROL) {
      try {
        this.hostConfig = JSON.parse(new TextDecoder().decode(bytes.subarray(1)));
      } catch (err) {
        this.headerErrors += 1;
        beaconOnce(`arm A: control record did not parse: ${err.message}`);
      }
      return;
    }
    if (bytes[0] === KIND_PADDING) {
      this.paddingMessages += 1;
      this.paddingBytes += bytes.length;
      return;
    }
    if (bytes[0] !== KIND_FRAGMENT || bytes.length <= COMMON_HEADER_BYTES) {
      this.headerErrors += 1;
      return;
    }
    this.fragmentsReceived += 1;

    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const flags = bytes[1];
    const index = view.getUint16(2, true);
    const count = view.getUint16(4, true);
    const frameId = view.getUint32(6, true);
    const payload = bytes.subarray(COMMON_HEADER_BYTES);

    let entry = this.assembly.get(frameId);
    if (!entry) {
      entry = {
        count,
        parts: new Array(count),
        have: 0,
        bytes: 0,
        irap: (flags & FLAG_IRAP) !== 0,
        nextExpected: 0,
        lastMs: atMs,
      };
      this.assembly.set(frameId, entry);
      this.#trim();
    }
    if (entry.parts[index] !== undefined) {
      this.duplicateFragments += 1;
      return;
    }
    if (index !== entry.nextExpected) this.outOfOrderFragments += 1;
    entry.nextExpected = index + 1;
    entry.parts[index] = payload;
    entry.have += 1;
    entry.bytes += payload.length;
    entry.lastMs = atMs;
    if (entry.have === entry.count) {
      this.assembly.delete(frameId);
      this.#onComplete(frameId, entry, atMs);
    }
  }

  /**
   * Bounded on purpose. A mode that loses a fragment leaves an entry that will
   * never complete, and an unbounded map would turn that into a slow leak and
   * a misleading `framesComplete`.
   */
  #trim() {
    while (this.assembly.size > MAX_FRAMES_IN_FLIGHT) {
      const oldest = this.assembly.keys().next().value;
      this.assembly.delete(oldest);
      this.framesIncomplete += 1;
      this.#requestIdr();
    }
  }

  #requestIdr() {
    const now = performance.now();
    if (now - this.lastIdrRequestMs < IDR_REQUEST_COOLDOWN_MS) return;
    if (this.channel?.readyState !== 'open') return;
    this.lastIdrRequestMs = now;
    this.idrRequestsSent += 1;
    this.channel.send('idr');
  }

  #onComplete(frameId, entry, atMs) {
    const body = new Uint8Array(entry.bytes);
    let offset = 0;
    for (const part of entry.parts) {
      body.set(part, offset);
      offset += part.length;
    }
    if (body.length < FRAME_HEADER_BYTES) {
      this.headerErrors += 1;
      return;
    }
    const head = new DataView(body.buffer, body.byteOffset, FRAME_HEADER_BYTES);
    const rtp = head.getUint32(0, true);
    const auBytes = head.getUint32(4, true);
    const codec = head.getUint8(8) === 1 ? 'hevc' : 'h264';
    const irap = head.getUint8(9) === 1;
    const stamps = {
      desktopPresent: Number(head.getBigInt64(10, true)),
      acquired: Number(head.getBigInt64(18, true)),
      encodeSubmit: Number(head.getBigInt64(26, true)),
      encodeDone: Number(head.getBigInt64(34, true)),
      enqueued: Number(head.getBigInt64(42, true)),
      pushed: Number(head.getBigInt64(50, true)),
    };
    const au = body.subarray(FRAME_HEADER_BYTES, FRAME_HEADER_BYTES + auBytes);
    if (au.length !== auBytes) {
      this.headerErrors += 1;
      return;
    }
    this.framesComplete += 1;

    if (this.highestFrameId >= 0 && frameId > this.highestFrameId + 1) {
      this.gapsSeen += frameId - this.highestFrameId - 1;
      this.#requestIdr();
    }
    if (frameId > this.highestFrameId) this.highestFrameId = frameId;

    if (!this.presenter.configured) {
      if (!irap) {
        this.framesBeforeConfig += 1;
        return;
      }
      this.codecStringFromStream = codecStringFromAccessUnit(au, codec);
      // The host parsed the same SPS and sent its answer in the control
      // record. Preferring the host's keeps one source of truth; the local
      // parse is kept so the two can be compared in the run's JSON.
      const codecString = this.hostConfig?.codecString || this.codecStringFromStream;
      if (!codecString) {
        this.framesBeforeConfig += 1;
        return;
      }
      this.presenter
        .configure(codecString)
        .then(() => this.#decode({ au, rtp, irap, codec, frameId, stamps, auBytes, atMs }))
        .catch((err) => beaconOnce(`arm A: decoder configure failed: ${err.message}`));
      return;
    }
    this.#decode({ au, rtp, irap, codec, frameId, stamps, auBytes, atMs });
  }

  #decode({ au, rtp, irap, codec, frameId, stamps, auBytes, atMs }) {
    this.presenter.decode({
      // Copied out of the assembly buffer: `EncodedVideoChunk` does not take a
      // view's lifetime, and the buffer is reused for the next frame.
      data: au.slice(),
      type: irap ? 'key' : 'delta',
      // The RTP timestamp in microseconds. Unique per frame and monotonic
      // within a run, which is what the decoder wants and what lets the output
      // callback find its way back to this record.
      timestampUs: Math.round((rtp * 1000) / 90),
      // Arm A carries the host's stamps in its own frame header, so there is
      // nothing to join: the record is complete before the decoder is called.
      key: { frameId, rtp, irap, bytes: auBytes, codec, stamps },
      // The moment the last fragment of this frame arrived — the same instant
      // arm B reads out of `requestVideoFrameCallback`'s `receiveTime`.
      arrivalMs: atMs,
    });
  }
}

let beaconed = new Set();
function beaconOnce(message) {
  if (beaconed.has(message)) return;
  beaconed.add(message);
  globalThis.beacon?.(message);
}

registerReceiver('a', () => new DataChannelReceiver());
