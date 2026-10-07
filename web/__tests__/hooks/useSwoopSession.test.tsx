/**
 * @jest-environment jsdom
 *
 * how a swoop session ends, seen from the page: which ends start the next
 * session on the ladder, which stop for good, and which tell the server.
 * everything below the hook is faked; the fakes keep the callbacks the hook
 * wires, so each test ends a session the way the real part would. the frozen
 * picture's tests drive the receiver's and the element's counters by hand.
 */

import { useEffect } from 'react';
import { act, render } from '@testing-library/react';
import type { SwoopSession } from '@/lib/swoop/features';
import type { SwoopPeerOptions } from '@/lib/swoop/peer';
import type { SwoopSignalingOptions } from '@/lib/swoop/signaling';
import { writeCodecChoice } from '@/lib/swoop/codecStore';

const wired: {
  peer: SwoopPeerOptions | null;
  signaling: SwoopSignalingOptions | null;
  session: SwoopSession | null;
  /** what the hook told the peer about the signalling socket, in order. */
  signalOpen: boolean[];
} = { peer: null, signaling: null, session: null, signalOpen: [] };

/**
 * what the faked receiver reports: the host's records, rvfc, and `getStats()`
 * answers in turn; the element's own state; and the frame callback the hook
 * handed the receiver.
 */
const picture = {
  metaRecords: 0,
  rvfcCallbacks: 0,
  codec: null as string | null,
  stats: [] as Record<string, unknown>[],
  reattach: jest.fn(async () => undefined),
  element: { paused: false, readyState: 4 },
  onFrame: null as ((observation: unknown) => void) | null,
};

jest.mock('@/contexts/AuthContext', () => ({
  useAuth: () => ({ mfaFactors: { totp: true, passkeys: 0 } }),
}));

jest.mock('@/lib/swoop/clientCaps', () => ({
  probeClientCaps: async () => ({ codecs: ['h264'], hardware: [], playoutDelay: true, webCodecsHevc: false }),
}));

jest.mock('@/lib/swoop/peer', () => ({
  createSwoopIdentity: async () => ({ certificate: {}, fingerprint: 'sha-256 AA:BB' }),
  createSwoopPeer: (options: SwoopPeerOptions) => {
    wired.peer = options;
    return {
      start: async () => undefined,
      close: () => undefined,
      handleSignal: async () => undefined,
      channel: () => null,
      signalOpen: (open: boolean) => wired.signalOpen.push(open),
      linkUp: () => true,
      connection: { addEventListener: () => undefined, removeEventListener: () => undefined },
    };
  },
}));

jest.mock('@/lib/swoop/signaling', () => ({
  createSwoopSignaling: (options: SwoopSignalingOptions) => {
    wired.signaling = options;
    return { connect: async () => undefined, close: () => undefined, send: () => undefined, refresh: async () => undefined };
  },
}));

jest.mock('@/lib/swoop/video/receiver', () => ({
  SwoopReceiver: class {
    constructor(options: { onFrame?: (observation: unknown) => void }) {
      picture.onFrame = options.onFrame ?? null;
    }
    attachTrack() {}
    async start() {}
    stop() {}
    handleMeta() {}
    diagnostics() {
      return {
        metaRecords: picture.metaRecords,
        rvfcCallbacks: picture.rvfcCallbacks,
        requestVideoFrameCallback: true,
        codec: picture.codec,
      };
    }
    async inboundStats() {
      return picture.stats.shift() ?? null;
    }
    reattach() {
      return picture.reattach();
    }
    rearmFrameCallback() {}
  },
}));

jest.mock('@/lib/swoop/video/presenter', () => ({
  createPresenter: () => ({ detach: () => undefined, observe: () => undefined, stats: () => ({}) }),
}));

jest.mock('@/lib/swoop/features', () => ({
  SWOOP_FEATURES: [
    {
      name: 'probe',
      attach: (session: SwoopSession) => {
        wired.session = session;
        return () => undefined;
      },
    },
  ],
  swoopFeedback: () => null,
}));

import { useSwoopSession, type UseSwoopSession } from '@/hooks/useSwoopSession';

const SITE = 'site-1';
const MACHINE = 'machine-1';
const SESSIONS = `/api/sites/${SITE}/machines/${MACHINE}/swoop/sessions`;

const GRANT = {
  sid: 'sid-1',
  viewerId: 'viewer-1',
  ctl: true,
  viewerJwt: 'header.payload.signature',
  k: 'aC3vYYwlNHnvNFH-5IiZXUay4W1QnqLmMtmod6Hy-LU',
  iceServers: [],
  signalUrl: 'wss://signal.example/v1/room/site-1/machine-1',
  expiresAt: 0,
};

interface Reply {
  status: number;
  body?: unknown;
}

let mint: Reply;
let lease: Reply;

const fetchMock = jest.fn(async (url: string, init?: RequestInit) => {
  const reply = init?.method === 'DELETE' ? { status: 200 } : url.endsWith('/lease') ? lease : mint;
  return { ok: reply.status < 400, status: reply.status, json: async () => reply.body ?? {} } as Response;
});

const deletes = () => fetchMock.mock.calls.filter(([, init]) => init?.method === 'DELETE');
const mints = () => fetchMock.mock.calls.filter(([url]) => url === SESSIONS);

let swoop: UseSwoopSession;

function Page({ onCommit }: { onCommit: (session: UseSwoopSession) => void }) {
  const session = useSwoopSession(SITE, MACHINE);
  const { stageRef, videoRef } = session;
  useEffect(() => onCommit(session));
  return (
    <div ref={stageRef}>
      <video ref={videoRef} />
    </div>
  );
}

async function flush(): Promise<void> {
  await act(async () => {
    for (let i = 0; i < 20; i += 1) await Promise.resolve();
  });
}

async function advance(ms: number): Promise<void> {
  await act(async () => {
    await jest.advanceTimersByTimeAsync(ms);
  });
  await flush();
}

/** mount the page and let the run get as far as a live session. */
async function open() {
  const view = render(
    <Page
      onCommit={(session) => {
        swoop = session;
      }}
    />,
  );
  await flush();
  return view;
}

beforeEach(() => {
  jest.useFakeTimers();
  mint = { status: 201, body: { data: GRANT } };
  lease = { status: 200, body: { data: { viewerJwt: 'renewed.jwt', expiresAt: Date.now() + 300_000 } } };
  wired.peer = null;
  wired.signaling = null;
  wired.session = null;
  wired.signalOpen = [];
  (globalThis as unknown as { fetch: typeof fetch }).fetch = fetchMock as unknown as typeof fetch;
});

afterEach(() => jest.useRealTimers());

describe('useSwoopSession — how a session ends', () => {
  it.each([
    ['the feedback watchdog', () => wired.session!.end('peer_failed')],
    ['a host that let this viewer go', () => wired.peer!.onClosed!('timeout')],
  ])('%s ends it without a DELETE, and the next session starts on the ladder', async (_what, endIt) => {
    await open();
    expect(wired.session).not.toBeNull();

    act(() => endIt());
    expect(swoop.state).toBe('ended');
    expect(swoop.retryIn).not.toBeNull();

    await advance(30_000);
    expect(mints()).toHaveLength(2);
    expect(deletes()).toHaveLength(0);
  });

  it('a kill is final, and the silence it leaves behind does not bring it back', async () => {
    await open();
    const killed = wired.session!;

    act(() => wired.peer!.onClosed!('kill'));
    expect(swoop.state).toBe('ended');
    expect(swoop.error).toBe('this session was ended from elsewhere.');
    expect(swoop.retryIn).toBeNull();

    // the killed run's feedback watchdog noticing the channel it lost.
    act(() => killed.end('peer_failed'));
    await advance(60_000);
    expect(mints()).toHaveLength(1);
    expect(deletes()).toHaveLength(0);
  });

  it('the operator’s end sends exactly one DELETE, saying closed', async () => {
    const view = await open();

    act(() => swoop.end());
    expect(swoop.state).toBe('ended');
    expect(swoop.retryIn).toBeNull();
    view.unmount();
    await advance(60_000);

    expect(deletes()).toHaveLength(1);
    const [url, init] = deletes()[0];
    expect(url).toBe(`${SESSIONS}/${GRANT.sid}`);
    expect(JSON.parse(String(init?.body))).toEqual({ endReason: 'closed', viewerReason: 'closed' });
    expect(mints()).toHaveLength(1);
  });

  it.each([
    [
      'a machine that is offline',
      { status: 409, body: { code: 'machine_offline', detail: 'this machine is offline; swoop cannot reach it until it reconnects.' } },
      'this machine is offline; swoop cannot reach it until it reconnects.',
    ],
    ['a lapsed login', { status: 401, body: { code: 'unauthorized', detail: 'Unauthorized: Session expired' } }, 'sign in again to resume.'],
    ['an edge in front of the app', { status: 403 }, 'this swoop session could not be started.'],
  ])('%s on the mint is retried on the ladder', async (_what, refusal, error) => {
    mint = refusal;
    await open();
    expect(swoop.state).toBe('error');
    expect(swoop.error).toBe(error);
    expect(swoop.retryIn).not.toBeNull();

    mint = { status: 201, body: { data: GRANT } };
    await advance(30_000);
    expect(mints()).toHaveLength(2);
    expect(wired.session).not.toBeNull();
  });

  it('a policy refusal on the mint is final', async () => {
    mint = { status: 403, body: { code: 'swoop_disabled', detail: 'swoop is not enabled for this site.' } };
    await open();
    expect(swoop.state).toBe('error');
    expect(swoop.error).toBe('swoop is not enabled for this site.');
    expect(swoop.retryIn).toBeNull();

    await advance(60_000);
    expect(mints()).toHaveLength(1);
  });

  it('a withdrawal met while re-minting ends the session with its reason', async () => {
    await open();
    const mintToken = wired.signaling!.mintToken;
    // the first dial spends the jwt the create route already minted.
    await act(async () => {
      await mintToken();
    });

    lease = { status: 403, body: { code: 'machine_excluded', detail: 'swoop is excluded on this machine.' } };
    await act(async () => {
      await expect(mintToken()).rejects.toThrow('swoop is excluded on this machine.');
    });
    expect(swoop.state).toBe('ended');
    expect(swoop.error).toBe('swoop is excluded on this machine.');
    expect(swoop.retryIn).toBeNull();
    expect(deletes()).toHaveLength(0);
  });

  it('tells the peer when an answer can come back over signalling', async () => {
    await open();

    act(() => wired.signaling!.onStatus!('reconnecting'));
    act(() => wired.signaling!.onStatus!('open'));
    expect(wired.signalOpen).toEqual([false, true]);
  });
});

describe('useSwoopSession — control across a reload of the tab', () => {
  const mintBody = (index: number) => JSON.parse(String(mints()[index][1]?.body)) as { continuity?: string };

  beforeEach(() => {
    sessionStorage.clear();
    mint = { status: 201, body: { data: { ...GRANT, continuity: 'continuity-1' } } };
  });

  it('a page loaded again in the same tab presents the last control session’s continuity', async () => {
    await open();
    expect(mintBody(0).continuity).toBeUndefined();

    // a reload runs no unmount: the next page simply mounts in the same tab.
    await open();
    expect(mintBody(1).continuity).toBe('continuity-1');
  });

  it('the operator’s end forgets it, so the next page asks again', async () => {
    await open();
    act(() => swoop.end());

    await open();
    expect(mintBody(1).continuity).toBeUndefined();
  });

  it('a kill forgets it', async () => {
    await open();
    act(() => wired.peer!.onClosed!('kill'));

    await open();
    expect(mintBody(1).continuity).toBeUndefined();
  });
});

describe('useSwoopSession — a picture that froze', () => {
  const STALL = `${SESSIONS}/${GRANT.sid}/stall`;
  const reports = () =>
    fetchMock.mock.calls
      .filter(([url]) => url === STALL)
      .map(([, init]) => JSON.parse(String(init?.body)) as Record<string, unknown>);
  const mintBody = (index: number) => JSON.parse(String(mints()[index][1]?.body)) as { continuity?: string };

  /** the element's own counters, which the watchdog reads as what was shown. */
  const quality = { totalVideoFrames: 0, droppedVideoFrames: 0 };
  /** a picture that had been showing before it froze. */
  const SHOWN = 100;
  const video = HTMLVideoElement.prototype as unknown as Record<string, unknown>;

  beforeEach(() => {
    sessionStorage.clear();
    Object.assign(picture, { metaRecords: 0, rvfcCallbacks: 0, codec: 'hevc', stats: [] });
    Object.assign(picture.element, { paused: false, readyState: 4 });
    picture.reattach.mockReset();
    picture.reattach.mockImplementation(async () => undefined);
    Object.assign(quality, { totalVideoFrames: SHOWN, droppedVideoFrames: 0 });
    // a playing element with a frame in hand and a box on screen, until a test
    // says otherwise; jsdom has none of it.
    Object.defineProperty(video, 'paused', { configurable: true, get: () => picture.element.paused });
    Object.defineProperty(video, 'readyState', { configurable: true, get: () => picture.element.readyState });
    video.getVideoPlaybackQuality = () => ({ ...quality });
    video.getBoundingClientRect = () => ({ x: 0, y: 0, width: 1280, height: 720 });
  });

  afterEach(() => {
    for (const key of ['paused', 'readyState', 'getVideoPlaybackQuality', 'getBoundingClientRect']) delete video[key];
    delete (document as unknown as Record<string, unknown>).visibilityState;
  });

  const setVisibility = (state: DocumentVisibilityState) =>
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => state });

  /** the picture shows every frame the host sends, one stats tick a second. */
  async function show(seconds: number) {
    for (let i = 0; i < seconds; i += 1) {
      picture.metaRecords += 60;
      quality.totalVideoFrames += 60;
      picture.rvfcCallbacks += 60;
      await advance(1000);
    }
  }

  /** a dead picture the reconnect ladder replaces: the stall, then the new session. */
  async function reconnectedOnce() {
    await freeze(5);
    expect(swoop.stats.stall.recovery).toBe('reconnecting');
    await advance(30_000);
    await connect();
  }

  const RENDER_STATS = [
    { framesReceived: 100, framesDecoded: 100 },
    { framesReceived: 280, framesDecoded: 280 },
  ];
  const HEVC_DECODE_STATS = [
    { framesReceived: 100, framesDecoded: 100, codecMimeType: 'video/H265' },
    { framesReceived: 280, framesDecoded: 100, codecMimeType: 'video/H265' },
  ];

  /** a reattach that leaves the element reloaded but dead: paused, no frame, counters at zero. */
  const reattachBreaksTheElement = () =>
    picture.reattach.mockImplementation(async () => {
      Object.assign(picture.element, { paused: true, readyState: 1 });
      quality.totalVideoFrames = 0;
    });

  /** the picture's first play: the peer hands the receiver its track. */
  async function connect() {
    act(() => wired.peer!.onTrack!({} as MediaStream, { track: { kind: 'video' } } as RTCRtpReceiver));
    await flush();
  }

  /** the host keeps sending and nothing is shown, one stats tick a second. */
  async function freeze(seconds: number) {
    for (let i = 0; i < seconds; i += 1) {
      picture.metaRecords += 60;
      await advance(1000);
    }
  }

  it('ends a dead hevc decoder with picture_stalled, reports it, and the next session offers h.264 alone', async () => {
    mint = { status: 201, body: { data: { ...GRANT, continuity: 'continuity-1' } } };
    picture.stats = [
      { framesReceived: 100, framesDecoded: 100, codecMimeType: 'video/H265' },
      { framesReceived: 280, framesDecoded: 100, codecMimeType: 'video/H265' },
    ];
    await open();
    await connect();
    expect(wired.peer!.codec).toBe('auto');

    await freeze(5);
    expect(swoop.state).toBe('ended');
    expect(swoop.retryIn).not.toBeNull();
    expect(swoop.stats.stall).toEqual({ recovery: 'reconnecting', episodes: 1, kind: 'decode' });
    expect(reports()).toEqual([
      {
        viewerId: GRANT.viewerId,
        kind: 'decode',
        action: 'reconnect',
        codec: 'hevc',
        stalledMs: 3000,
        hostFrames: 180,
        before: { framesReceived: 100, framesDecoded: 100, codecMimeType: 'video/H265' },
        after: { framesReceived: 280, framesDecoded: 100, codecMimeType: 'video/H265' },
      },
    ]);

    await advance(30_000);
    expect(mints()).toHaveLength(2);
    // a transient end: the record stays, so the continuity it names still counts.
    expect(deletes()).toHaveLength(0);
    expect(mintBody(1).continuity).toBe('continuity-1');
    expect(wired.peer!.codec).toBe('h264');
    expect(swoop.stats.stall.recovery).toBe('none');
  });

  it('stays unarmed in a browser that never counts a frame of the stream', async () => {
    quality.totalVideoFrames = 0;
    await open();
    await connect();
    await freeze(30);
    expect(swoop.state).toBe('connected');
    expect(reports()).toHaveLength(0);
  });

  it('never fires while the picture is shown, however still the desktop', async () => {
    await open();
    await connect();
    for (let i = 0; i < 30; i += 1) {
      picture.metaRecords += 2;
      quality.totalVideoFrames += 2;
      picture.rvfcCallbacks += 2;
      await advance(1000);
    }
    expect(swoop.state).toBe('connected');
    expect(reports()).toHaveLength(0);
  });

  it('reattaches a picture that decodes but never paints, and keeps the session once frames show', async () => {
    picture.stats = [
      { framesReceived: 100, framesDecoded: 100 },
      { framesReceived: 280, framesDecoded: 280 },
    ];
    picture.reattach.mockImplementation(async () => {
      quality.totalVideoFrames += 30;
      picture.rvfcCallbacks += 30;
    });
    await open();
    await connect();

    await freeze(5);
    expect(picture.reattach).toHaveBeenCalledTimes(1);
    expect(swoop.stats.stall.recovery).toBe('reattaching');
    expect(reports().map((report) => [report.kind, report.action])).toEqual([['render', 'reattach']]);

    await advance(2000);
    expect(swoop.state).toBe('connected');
    expect(swoop.stats.stall.recovery).toBe('none');
    expect(mints()).toHaveLength(1);
  });

  it('replaces the session when the reattached picture still shows nothing two seconds on', async () => {
    picture.stats = [
      { framesReceived: 100, framesDecoded: 100 },
      { framesReceived: 280, framesDecoded: 280 },
    ];
    await open();
    await connect();

    await freeze(5);
    await advance(2000);
    expect(swoop.state).toBe('ended');
    expect(swoop.stats.stall.recovery).toBe('reconnecting');

    await advance(30_000);
    expect(mints()).toHaveLength(2);
    // only a dead decoder changes the codec.
    expect(wired.peer!.codec).toBe('auto');
  });

  it('escalates a reattach that leaves the element paused with no frame, rather than giving up', async () => {
    picture.stats = [...RENDER_STATS];
    reattachBreaksTheElement();
    await open();
    await connect();

    await freeze(5);
    expect(swoop.stats.stall.recovery).toBe('reattaching');
    await advance(2000);
    expect(swoop.state).toBe('ended');
    expect(swoop.stats.stall.recovery).toBe('reconnecting');

    await advance(30_000);
    expect(mints()).toHaveLength(2);
  });

  it('waits out a hidden tab during the reattach check, then escalates a picture still dead', async () => {
    picture.stats = [...RENDER_STATS];
    reattachBreaksTheElement();
    await open();
    await connect();

    await freeze(5);
    setVisibility('hidden');
    await advance(4000);
    expect(swoop.state).toBe('connected');
    expect(swoop.stats.stall.recovery).toBe('reattaching');

    setVisibility('visible');
    await advance(2000);
    expect(swoop.state).toBe('ended');
    expect(swoop.stats.stall.recovery).toBe('reconnecting');
  });

  it.each([
    ['the operator’s end', () => swoop.end()],
    ['a kill', () => wired.peer!.onClosed!('kill')],
  ])('%s during the reattach check clears the stall notice', async (_what, endIt) => {
    picture.stats = [...RENDER_STATS];
    await open();
    await connect();

    await freeze(5);
    expect(swoop.stats.stall.recovery).toBe('reattaching');
    act(() => endIt());
    expect(swoop.state).toBe('ended');
    expect(swoop.stats.stall.recovery).toBe('none');
    await advance(5000);
    expect(swoop.stats.stall.recovery).toBe('none');
  });

  it('reconnects on its own twice in ten minutes, then keeps the session up and leaves it to the operator', async () => {
    await open();
    await connect();
    await reconnectedOnce();
    await reconnectedOnce();
    expect(mints()).toHaveLength(3);

    await freeze(5);
    // a session stays up: only the automatic recovery stops.
    expect(swoop.state).toBe('connected');
    expect(swoop.session).not.toBeNull();
    expect(swoop.retryIn).toBeNull();
    expect(swoop.stats.stall).toMatchObject({ recovery: 'frozen', episodes: 3, kind: 'nothing' });
    expect(reports().map((report) => report.action)).toEqual(['reconnect', 'reconnect', 'none']);

    await freeze(60);
    expect(mints()).toHaveLength(3);
    expect(deletes()).toHaveLength(0);

    // the picture coming back on its own takes the alert away.
    await show(2);
    expect(swoop.stats.stall.recovery).toBe('none');
  });

  it('does not count a reattach toward the cap', async () => {
    picture.stats = [...RENDER_STATS];
    picture.reattach.mockImplementation(async () => {
      quality.totalVideoFrames += 30;
      picture.rvfcCallbacks += 30;
    });
    await open();
    await connect();
    await freeze(5);
    await advance(2000);
    expect(swoop.stats.stall.recovery).toBe('none');

    // two dead pictures after it still get their two reconnects. the reattach
    // left a settled baseline, so the first is declared three seconds in.
    await freeze(3);
    expect(swoop.stats.stall.recovery).toBe('reconnecting');
    await advance(30_000);
    await connect();
    await reconnectedOnce();
    expect(mints()).toHaveLength(3);
    expect(reports().map((report) => report.action)).toEqual(['reattach', 'reconnect', 'reconnect']);
  });

  it('the operator’s reconnect from a frozen picture replaces the session without a DELETE, and starts the cap again', async () => {
    mint = { status: 201, body: { data: { ...GRANT, continuity: 'continuity-1' } } };
    await open();
    await connect();
    await reconnectedOnce();
    await reconnectedOnce();
    await freeze(5);
    expect(swoop.stats.stall.recovery).toBe('frozen');

    act(() => swoop.reconnect());
    await flush();
    expect(mints()).toHaveLength(4);
    expect(deletes()).toHaveLength(0);
    expect(mintBody(3).continuity).toBe('continuity-1');
    expect(swoop.stats.stall.recovery).toBe('none');

    await connect();
    await freeze(5);
    expect(swoop.stats.stall.recovery).toBe('reconnecting');
  });

  it('a dead hevc decoder met at the cap still moves the tab to h.264 for the reconnect', async () => {
    await open();
    await connect();
    await reconnectedOnce();
    await reconnectedOnce();

    picture.stats = [...HEVC_DECODE_STATS];
    await freeze(5);
    expect(swoop.stats.stall).toMatchObject({ recovery: 'frozen', kind: 'decode' });

    act(() => swoop.reconnect());
    await flush();
    expect(wired.peer!.codec).toBe('h264');
  });

  it('a codec choice restarts the session in place, without a DELETE, and the new offer carries it', async () => {
    mint = { status: 201, body: { data: { ...GRANT, continuity: 'continuity-1' } } };
    await open();
    await connect();

    writeCodecChoice(SITE, MACHINE, 'h264');
    act(() => wired.session!.restart());
    await flush();

    expect(mints()).toHaveLength(2);
    expect(deletes()).toHaveLength(0);
    expect(mintBody(1).continuity).toBe('continuity-1');
    expect(wired.peer!.codec).toBe('h264');
  });
});

describe('useSwoopSession — frames', () => {
  it('logs a frame subscriber that throws, and still hands the frame to the rest', async () => {
    await open();
    const seen: unknown[] = [];
    const logged = jest.spyOn(console, 'error').mockImplementation(() => undefined);
    wired.session!.onFrame(() => {
      throw new Error('a feature bug');
    });
    wired.session!.onFrame((frame) => seen.push(frame));

    act(() => picture.onFrame!({ frameId: 1 }));

    expect(seen).toEqual([{ frameId: 1 }]);
    expect(logged).toHaveBeenCalledWith(expect.stringContaining('[swoop]'), expect.any(Error));
    logged.mockRestore();
  });
});
