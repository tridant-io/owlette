/**
 * swoop video receive path — the browser half of plan.md D3's seam.
 *
 * **gate g1 closed on 2026-09-18 on arm B** (spike `0.2-video-path-bakeoff.md`
 * §14): the picture arrives on an rtp media track and the `<video>` element
 * decodes and buffers it. so this file is a thin adapter, not a decoder feed:
 * it owns the element's lifecycle, keeps the browser from raising the playout
 * floor the host set, and joins the host's per-frame stamps to the frames the
 * user agent actually presented.
 *
 * what it is NOT, and why:
 *
 * - **no `VideoDecoder`, no fragment reassembly, no `decodeQueueSize`
 *   backpressure.** those belong to the datachannel→webcodecs path, which lost
 *   g1: 20.15 ms p50 but 1067 ms p95 on a real lan. see `decoder.ts`.
 * - **no dejitter buffer.** arm B measured 32.18 ms p95 with sd 0.58 on the
 *   lan; the tail that nine same-machine runs showed was host and client
 *   contending for one cpu, not chrome's render scheduling (§14.3). there is
 *   no tail here to fix.
 * - **no per-frame pixel readback.** a `drawImage` + `getImageData` from a
 *   hardware-decoded `<video>` is a gpu→cpu download costing 10–15 ms p50 and
 *   24 ms max, which held chrome to ~22 fps against a 60 fps source and put
 *   the stream 14 s behind. timing comes from the user agent's own
 *   `presentationTime` instead.
 * - **`requestVideoFrameCallback` observes, it never schedules** (plan.md
 *   D17). nothing here presents; the element does.
 *
 * `swoop-meta` carries `PROTOCOL.md` §4 records header-only
 * (`payloadBytes = 0`) and they are joined to the track by `rtpTimestamp90k`.
 * the §4 recovery rule still applies to that stream: a `frameId` gap means the
 * stamps for the frames in between are gone, so we stop joining and ask the
 * host for an idr rather than attributing one frame's timings to another.
 */

import {
  advanceFrameSequence,
  decodeFrameHeader,
  initialFrameSequenceState,
  type FrameSequenceState,
  type RejectReason,
  type SwoopCodec,
  type SwoopFrameHeader,
} from '@/lib/swoop/protocol';

/**
 * unmatched records older than this are dropped from each side of the join.
 * four seconds at 60 fps: a record that has not matched by then never will,
 * and a session must not be able to grow the tab's memory.
 */
const JOIN_LIMIT = 240;

/** one presented frame, with the host stamps that produced it. */
export interface FrameObservation {
  /** host clock, from the `swoop-meta` record. */
  frameId: number;
  rtpTimestamp90k: number;
  irap: boolean;
  codec: SwoopCodec;
  width: number;
  height: number;
  /**
   * microseconds since `streamerEpoch`, passed through unconverted — the
   * caller applies the offset it measures on `swoop-feedback` ping/pong. no
   * end has to trust the other's clock, so this file never guesses at one.
   */
  tCaptureUs: number;
  tEncodeUs: number;
  tSendUs: number;
  /** `performance.now()`: last packet of this frame arrived. */
  arrivalMs: number | null;
  /** decoder processing duration in ms (the spec reports seconds). */
  decodeMs: number | null;
  /** `performance.now()`: the ua submitted the frame for composition. */
  presentedMs: number;
  expectedDisplayMs: number;
  /** the ua's running count, which is how drops and duplicates are counted. */
  presentedFrames: number;
}

export interface SwoopReceiverOptions {
  video: HTMLVideoElement;
  /** one call per presented frame that joined a host record. */
  onFrame?: (observation: FrameObservation) => void;
  /**
   * send `{"t":"idr"}` on `swoop-control`. called once per lost-sync episode —
   * the host coalesces requests behind a 250–500 ms cooldown anyway.
   */
  onIdrRequest?: () => void;
}

export interface SwoopReceiverDiagnostics {
  framesObserved: number;
  metaRecords: number;
  /** decode and sequence refusals, counted by `PROTOCOL.md` reason code. */
  metaDropped: Readonly<Partial<Record<RejectReason, number>>>;
  idrRequests: number;
  awaitingIrap: boolean;
  /** presented frames the ua gave no `rtpTimestamp` for, so nothing to join to. */
  unjoinableFrames: number;
  unmatchedHostRecordsDropped: number;
  unmatchedClientFramesDropped: number;
  /** what the browser accepted, or why it would not take it. */
  jitterBufferTargetApplied: number | string | null;
  requestVideoFrameCallback: boolean;
}

/** the client half of a join, held until its host record turns up. */
interface ClientObservation {
  arrivalMs: number | null;
  decodeMs: number | null;
  presentedMs: number;
  expectedDisplayMs: number;
  presentedFrames: number;
}

type HostRecord = Pick<
  FrameObservation,
  | 'frameId'
  | 'rtpTimestamp90k'
  | 'irap'
  | 'codec'
  | 'width'
  | 'height'
  | 'tCaptureUs'
  | 'tEncodeUs'
  | 'tSendUs'
>;

const toHostRecord = (header: SwoopFrameHeader): HostRecord => ({
  frameId: header.frameId,
  rtpTimestamp90k: header.rtpTimestamp90k,
  irap: header.irap,
  codec: header.codec,
  width: header.width,
  height: header.height,
  tCaptureUs: header.tCaptureUs,
  tEncodeUs: header.tEncodeUs,
  tSendUs: header.tSendUs,
});

/**
 * `swoop-meta` is binary. a channel left on the default `binaryType` of
 * `"blob"` delivers a `Blob`, which cannot be read synchronously — the caller
 * sets `binaryType = "arraybuffer"`, and anything else is counted and dropped
 * rather than silently awaited out of frame order.
 */
function asBytes(data: unknown): ArrayBuffer | ArrayBufferView | null {
  if (data instanceof ArrayBuffer) return data;
  if (ArrayBuffer.isView(data)) return data;
  return null;
}

export class SwoopReceiver {
  private readonly video: HTMLVideoElement;
  private readonly onFrame?: (observation: FrameObservation) => void;
  private readonly onIdrRequest?: () => void;

  private stream: MediaStream | null = null;
  private rtpReceiver: RTCRtpReceiver | null = null;
  private trackAttached: Promise<void>;
  private resolveTrack!: () => void;

  private sequence: FrameSequenceState = initialFrameSequenceState();
  private awaitingIrap = false;
  private readonly hostRecords = new Map<number, HostRecord>();
  private readonly clientRecords = new Map<number, ClientObservation>();

  private running = false;
  private framesObserved = 0;
  private metaRecords = 0;
  private readonly metaDropped: Partial<Record<RejectReason, number>> = {};
  private idrRequests = 0;
  private unjoinableFrames = 0;
  private unmatchedHost = 0;
  private unmatchedClient = 0;
  private jitterBufferTargetApplied: number | string | null = null;
  private readonly rvfcSupported: boolean;

  constructor(options: SwoopReceiverOptions) {
    this.video = options.video;
    this.onFrame = options.onFrame;
    this.onIdrRequest = options.onIdrRequest;
    this.rvfcSupported =
      typeof HTMLVideoElement !== 'undefined' &&
      'requestVideoFrameCallback' in HTMLVideoElement.prototype;
    this.trackAttached = new Promise<void>((resolve) => {
      this.resolveTrack = resolve;
    });
  }

  /** wire to `pc.ontrack`. the host sends one video track, `sendonly`. */
  attachTrack(event: RTCTrackEvent): void {
    this.stream = event.streams[0] ?? new MediaStream([event.track]);
    this.rtpReceiver = event.receiver;
    this.resolveTrack();
  }

  /** wire to the `swoop-meta` channel's `onmessage`. total: never throws. */
  handleMeta(data: unknown): void {
    const bytes = asBytes(data);
    if (bytes === null) {
      this.drop('binary_unsupported');
      return;
    }
    const decoded = decodeFrameHeader(bytes);
    if (!decoded.ok) {
      this.drop(decoded.reason);
      return;
    }
    this.metaRecords += 1;

    const header = decoded.value;
    const next = advanceFrameSequence(this.sequence, header);
    if (!next.ok) {
      this.drop(next.reason);
      // the stamps between here and the last good record are gone. drop back
      // to "no recovery point" so every later delta is refused too, and ask
      // once — repeated asks while waiting would only be coalesced anyway.
      this.sequence = initialFrameSequenceState();
      if (!this.awaitingIrap) {
        this.awaitingIrap = true;
        this.idrRequests += 1;
        this.onIdrRequest?.();
      }
      return;
    }
    this.sequence = next.value;
    this.awaitingIrap = false;
    // arm B writes `fragmentIndex = 0, fragmentCount = 1` on every record
    // (PROTOCOL.md §4), so the sequence advances exactly once per frame and
    // one rtp timestamp maps to one record.
    this.addHost(toHostRecord(header));
  }

  /** attach the track to the element and start observing presented frames. */
  async start(): Promise<void> {
    await this.trackAttached;
    if (this.rtpReceiver) {
      try {
        // belt and braces: in chrome this is a *minimum*, not a target, so it
        // can only raise the floor. zero makes sure the page is not the thing
        // undoing the host's `playout-delay` max.
        this.rtpReceiver.jitterBufferTarget = 0;
        this.jitterBufferTargetApplied = this.rtpReceiver.jitterBufferTarget;
      } catch (err) {
        this.jitterBufferTargetApplied = `unsupported: ${(err as Error).message}`;
      }
    }
    this.running = true;
    // never a blob url: the app's csp has no `media-src` (PROTOCOL.md §3).
    this.video.srcObject = this.stream;
    // autoplay policy: a muted element plays without a gesture, and ios only
    // plays inline when told to. the audio feature unmutes on a click of its own.
    this.video.muted = true;
    this.video.playsInline = true;
    await this.video.play();
    // firefox has no rvfc. the picture still plays — it is the per-frame join,
    // and so the stats overlay's per-stage breakdown, that degrades.
    if (this.rvfcSupported) this.armFrameCallback();
  }

  stop(): void {
    this.running = false;
    this.video.srcObject = null;
    this.hostRecords.clear();
    this.clientRecords.clear();
  }

  diagnostics(): SwoopReceiverDiagnostics {
    return {
      framesObserved: this.framesObserved,
      metaRecords: this.metaRecords,
      metaDropped: { ...this.metaDropped },
      idrRequests: this.idrRequests,
      awaitingIrap: this.awaitingIrap,
      unjoinableFrames: this.unjoinableFrames,
      unmatchedHostRecordsDropped: this.unmatchedHost,
      unmatchedClientFramesDropped: this.unmatchedClient,
      jitterBufferTargetApplied: this.jitterBufferTargetApplied,
      requestVideoFrameCallback: this.rvfcSupported,
    };
  }

  private armFrameCallback(): void {
    this.video.requestVideoFrameCallback((_now, metadata) => this.onPresented(metadata));
  }

  private onPresented(metadata: VideoFrameCallbackMetadata): void {
    if (!this.running) return;
    if (metadata.rtpTimestamp === undefined) {
      this.unjoinableFrames += 1;
    } else {
      this.addClient(metadata.rtpTimestamp >>> 0, {
        arrivalMs: metadata.receiveTime ?? null,
        // seconds per the spec, unlike every other field on this record.
        decodeMs:
          typeof metadata.processingDuration === 'number'
            ? metadata.processingDuration * 1000
            : null,
        presentedMs: metadata.presentationTime,
        expectedDisplayMs: metadata.expectedDisplayTime,
        presentedFrames: metadata.presentedFrames,
      });
    }
    this.armFrameCallback();
  }

  private addHost(record: HostRecord): void {
    const client = this.clientRecords.get(record.rtpTimestamp90k);
    if (client) {
      this.clientRecords.delete(record.rtpTimestamp90k);
      this.emit(record, client);
      return;
    }
    this.hostRecords.set(record.rtpTimestamp90k, record);
    this.trim(this.hostRecords, () => (this.unmatchedHost += 1));
  }

  private addClient(rtp: number, observation: ClientObservation): void {
    const host = this.hostRecords.get(rtp);
    if (host) {
      this.hostRecords.delete(rtp);
      this.emit(host, observation);
      return;
    }
    this.clientRecords.set(rtp, observation);
    this.trim(this.clientRecords, () => (this.unmatchedClient += 1));
  }

  // the stamps travel on sctp while the picture travels over rtp, so neither
  // side may assume the other arrived first.
  private emit(host: HostRecord, client: ClientObservation): void {
    this.framesObserved += 1;
    this.onFrame?.({ ...host, ...client });
  }

  private trim(map: Map<number, unknown>, onDrop: () => void): void {
    while (map.size > JOIN_LIMIT) {
      const oldest = map.keys().next().value as number;
      map.delete(oldest);
      onDrop();
    }
  }

  private drop(reason: RejectReason): void {
    this.metaDropped[reason] = (this.metaDropped[reason] ?? 0) + 1;
  }
}
