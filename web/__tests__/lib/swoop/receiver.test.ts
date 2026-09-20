/**
 * the arm-B receive path. g1 closed on an rtp media track into a `<video>`
 * element, so what is under test here is the metadata stream and the join to
 * the frames the user agent presented — not access-unit reassembly, which
 * belongs to the datachannel path that lost the bake-off.
 */

import { readFileSync } from 'fs';
import path from 'path';

import { SwoopReceiver } from '@/lib/swoop/video/receiver';
import { encodeFrameHeader } from '@/lib/swoop/protocol';
import type { FrameObservation } from '@/lib/swoop/video/receiver';
import type { SwoopFrameHeader } from '@/lib/swoop/protocol';

// ---------------------------------------------------------------------------
// the shared oracle (same vectors the rust protocol core iterates)
// ---------------------------------------------------------------------------

const VECTOR_DIR = path.resolve(__dirname, '../../../../agent/swoop/testdata/protocol');
const readVector = (file: string): Uint8Array =>
  new Uint8Array(readFileSync(path.join(VECTOR_DIR, file)));

interface Vector {
  file: string;
  kind: string;
  expected?: Record<string, unknown>;
}
const manifest = JSON.parse(
  readFileSync(path.join(VECTOR_DIR, 'index.json'), 'utf8'),
) as { vectors: Vector[] };
const vector = (file: string): Vector => {
  const found = manifest.vectors.find((v) => v.file === file);
  if (!found) throw new Error(`vector ${file} is not in the manifest`);
  return found;
};

const KEY_VECTOR = 'frame/frame-key-1080p.bin';
const DELTA_VECTOR = 'frame/frame-delta-fragmented.bin';
const GAP_VECTOR = 'frame/frame-dangling-reference.bin';

// ---------------------------------------------------------------------------
// fakes
// ---------------------------------------------------------------------------

const record = (over: Partial<SwoopFrameHeader>): Uint8Array =>
  encodeFrameHeader({
    kind: 1,
    headerVersion: 1,
    codec: 'hevc',
    irap: false,
    resolutionChanged: false,
    parameterSets: false,
    reservedFlags: 0,
    fragmentIndex: 0,
    fragmentCount: 1,
    frameId: 0,
    rtpTimestamp90k: 0,
    width: 1920,
    height: 1080,
    payloadBytes: 0,
    tCaptureUs: 0,
    tEncodeUs: 0,
    tSendUs: 0,
    ...over,
  });

function fakeVideo() {
  let pending: VideoFrameRequestCallback | null = null;
  const raw = {
    srcObject: null as MediaStream | null,
    play: jest.fn(async () => undefined),
    requestVideoFrameCallback: jest.fn((cb: VideoFrameRequestCallback) => {
      pending = cb;
      return 1;
    }),
  };
  return {
    video: raw as unknown as HTMLVideoElement,
    raw,
    armed: () => pending !== null,
    present(metadata: Partial<VideoFrameCallbackMetadata>) {
      const cb = pending;
      pending = null;
      if (!cb) throw new Error('no frame callback armed');
      cb(1, {
        presentationTime: 10,
        expectedDisplayTime: 26,
        presentedFrames: 1,
        width: 1920,
        height: 1080,
        mediaTime: 0,
        ...metadata,
      } as VideoFrameCallbackMetadata);
    },
  };
}

const fakeStream = () => ({ id: 'swoop' }) as unknown as MediaStream;

function fakeTrackEvent(stream: MediaStream, receiver: { jitterBufferTarget: number | null }) {
  return { streams: [stream], receiver } as unknown as RTCTrackEvent;
}

interface Harness {
  receiver: SwoopReceiver;
  frames: FrameObservation[];
  idrRequests: number;
}

async function started(): Promise<Harness & ReturnType<typeof fakeVideo> & {
  stream: MediaStream;
  rtpReceiver: { jitterBufferTarget: number | null };
}> {
  const v = fakeVideo();
  const stream = fakeStream();
  const rtpReceiver = { jitterBufferTarget: null as number | null };
  const frames: FrameObservation[] = [];
  const state = { idrRequests: 0 };
  const receiver = new SwoopReceiver({
    video: v.video,
    onFrame: (o) => frames.push(o),
    onIdrRequest: () => {
      state.idrRequests += 1;
    },
  });
  receiver.attachTrack(fakeTrackEvent(stream, rtpReceiver));
  await receiver.start();
  return {
    ...v,
    receiver,
    frames,
    stream,
    rtpReceiver,
    get idrRequests() {
      return state.idrRequests;
    },
  };
}

beforeAll(() => {
  // jsdom has no rvfc; the receiver feature-detects on the prototype.
  (HTMLVideoElement.prototype as unknown as Record<string, unknown>).requestVideoFrameCallback =
    () => 0;
});

// ---------------------------------------------------------------------------

describe('swoop receiver — track lifecycle', () => {
  it('attaches the stream itself and drops the browser jitter floor to zero', async () => {
    const h = await started();
    expect(h.raw.srcObject).toBe(h.stream);
    expect(h.raw.play).toHaveBeenCalledTimes(1);
    expect(h.rtpReceiver.jitterBufferTarget).toBe(0);
    expect(h.receiver.diagnostics().jitterBufferTargetApplied).toBe(0);
  });

  it('observes with requestVideoFrameCallback and never schedules with rAF', async () => {
    const rAF = jest.spyOn(window, 'requestAnimationFrame');
    const h = await started();
    h.receiver.handleMeta(readVector(KEY_VECTOR));
    h.present({ rtpTimestamp: 123456789 });
    expect(h.raw.requestVideoFrameCallback).toHaveBeenCalledTimes(2); // armed, re-armed
    expect(rAF).not.toHaveBeenCalled();
    rAF.mockRestore();
  });

  it('stops observing and releases the element', async () => {
    const h = await started();
    h.receiver.stop();
    h.receiver.handleMeta(readVector(KEY_VECTOR));
    h.present({ rtpTimestamp: 123456789 });
    expect(h.raw.srcObject).toBeNull();
    expect(h.frames).toHaveLength(0);
    expect(h.armed()).toBe(false);
  });
});

describe('swoop receiver — metadata join', () => {
  it('joins a golden-vector record to the presented frame field for field', async () => {
    const h = await started();
    h.receiver.handleMeta(readVector(KEY_VECTOR));
    h.present({
      rtpTimestamp: 123456789,
      receiveTime: 5,
      processingDuration: 0.004,
      presentationTime: 10,
      expectedDisplayTime: 26,
      presentedFrames: 7,
    });

    const expected = vector(KEY_VECTOR).expected as Record<string, number | boolean | string>;
    expect(h.frames).toHaveLength(1);
    expect(h.frames[0]).toEqual({
      frameId: expected.frameId,
      rtpTimestamp90k: expected.rtpTimestamp90k,
      irap: expected.irap,
      codec: expected.codec,
      width: expected.width,
      height: expected.height,
      tCaptureUs: expected.tCaptureUs,
      tEncodeUs: expected.tEncodeUs,
      tSendUs: expected.tSendUs,
      arrivalMs: 5,
      decodeMs: 4, // the spec reports seconds; everything else here is ms
      presentedMs: 10,
      expectedDisplayMs: 26,
      presentedFrames: 7,
    });
  });

  it('joins in either arrival order — sctp and rtp race', async () => {
    const h = await started();
    h.present({ rtpTimestamp: 123456789 });
    expect(h.frames).toHaveLength(0);
    h.receiver.handleMeta(readVector(KEY_VECTOR));
    expect(h.frames.map((f) => f.frameId)).toEqual([41]);
  });

  it('drops a record that is not binary rather than awaiting it out of order', async () => {
    const h = await started();
    h.receiver.handleMeta('{"t":"meta"}');
    expect(h.receiver.diagnostics().metaDropped).toEqual({ binary_unsupported: 1 });
    expect(h.idrRequests).toBe(0);
  });

  it('bounds both sides of the join', async () => {
    const h = await started();
    h.receiver.handleMeta(record({ irap: true, frameId: 0, rtpTimestamp90k: 1 }));
    for (let i = 1; i <= 300; i += 1) {
      h.receiver.handleMeta(record({ frameId: i, rtpTimestamp90k: i + 1 }));
    }
    const d = h.receiver.diagnostics();
    expect(d.metaRecords).toBe(301);
    expect(d.unmatchedHostRecordsDropped).toBe(61);
    expect(h.frames).toHaveLength(0);
  });
});

describe('swoop receiver — recovery points', () => {
  it('emits nothing across a frameId gap and asks for exactly one idr', async () => {
    const h = await started();
    h.receiver.handleMeta(readVector(KEY_VECTOR)); // 41, irap
    h.receiver.handleMeta(readVector(DELTA_VECTOR)); // 42
    h.receiver.handleMeta(readVector(GAP_VECTOR)); // 45, irap clear
    h.receiver.handleMeta(record({ frameId: 46, rtpTimestamp90k: 123465289 }));

    h.present({ rtpTimestamp: 123463789 });
    h.present({ rtpTimestamp: 123465289 });

    expect(h.frames.map((f) => f.frameId)).toEqual([]);
    expect(h.idrRequests).toBe(1);
    const d = h.receiver.diagnostics();
    expect(d.metaDropped).toEqual({ dangling_reference: 2 });
    expect(d.awaitingIrap).toBe(true);
  });

  it('resumes only on the next irap', async () => {
    const h = await started();
    h.receiver.handleMeta(readVector(KEY_VECTOR));
    h.receiver.handleMeta(readVector(GAP_VECTOR));
    h.receiver.handleMeta(record({ irap: true, frameId: 60, rtpTimestamp90k: 900 }));
    h.present({ rtpTimestamp: 900 });

    expect(h.frames.map((f) => f.frameId)).toEqual([60]);
    expect(h.receiver.diagnostics().awaitingIrap).toBe(false);
    expect(h.idrRequests).toBe(1);
  });

  it('treats a resolution change without an irap as a break, and an irap as the reconfigure', async () => {
    const h = await started();
    h.receiver.handleMeta(record({ irap: true, frameId: 10, rtpTimestamp90k: 100 }));
    h.receiver.handleMeta(
      record({ frameId: 11, rtpTimestamp90k: 200, resolutionChanged: true, width: 1280, height: 720 }),
    );
    expect(h.idrRequests).toBe(1);

    h.receiver.handleMeta(
      record({
        irap: true,
        parameterSets: true,
        frameId: 12,
        rtpTimestamp90k: 300,
        resolutionChanged: true,
        width: 1280,
        height: 720,
      }),
    );
    h.present({ rtpTimestamp: 300 });
    expect(h.frames.map((f) => [f.frameId, f.width, f.height])).toEqual([[12, 1280, 720]]);
  });
});
