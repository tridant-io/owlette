/** @jest-environment node */

import { webcrypto } from 'crypto';

// Web Crypto is a browser global; the `node` runner does not expose it by
// default. Polyfill before importing the module under test, exactly as
// __tests__/lib/swoop/protocol.test.ts does.
if (!('crypto' in globalThis)) {
  (globalThis as unknown as { crypto: typeof webcrypto }).crypto = webcrypto;
}

import { PLAYOUT_DELAY_URI, base64UrlDecode, type SignalingMessage } from '@/lib/swoop/protocol';
import {
  RELAY_PROBE_MS,
  SwoopPeer,
  createSwoopIdentity,
  playoutDelayNegotiated,
  type RtcPeerConnectionFactory,
  type SwoopIdentity,
  type SwoopPeerError,
} from '@/lib/swoop/peer';

// ---------------------------------------------------------------------------
// the golden vector — agent/swoop/testdata/protocol/crypto/hkdf-and-host-mac.json
// ---------------------------------------------------------------------------

const VIEWER_KEY = base64UrlDecode('aC3vYYwlNHnvNFH-5IiZXUay4W1QnqLmMtmod6Hy-LU')!;
const SID = 'sid_0000000000000001';
const VIEWER_ID = 'viewer_0000000001';
const HOST_FINGERPRINT =
  'A0:A1:A2:A3:A4:A5:A6:A7:A8:A9:AA:AB:AC:AD:AE:AF:B0:B1:B2:B3:B4:B5:B6:B7:B8:B9:BA:BB:BC:BD:BE:BF';
const HOST_MAC = '978r-6XwmS2AgAfC9QnpRr8zuwaMc7ickNeZyBbcaAQ';

function answerSdp(fingerprint = HOST_FINGERPRINT, withPlayoutDelay = true): string {
  return [
    'v=0',
    'o=- 0 0 IN IP4 127.0.0.1',
    's=-',
    't=0 0',
    'm=video 9 UDP/TLS/RTP/SAVPF 96',
    `a=fingerprint:sha-256 ${fingerprint}`,
    ...(withPlayoutDelay ? [`a=extmap:5 ${PLAYOUT_DELAY_URI}`] : []),
    'a=sendonly',
    '',
  ].join('\r\n');
}

// ---------------------------------------------------------------------------
// fakes
// ---------------------------------------------------------------------------

class FakeDataChannel {
  binaryType = 'blob';
  readyState = 'open';
  readonly sent: string[] = [];
  onopen: (() => void) | null = null;
  constructor(
    readonly label: string,
    readonly init: RTCDataChannelInit,
  ) {}

  send(data: string): void {
    this.sent.push(data);
  }
}

interface FakePeerState {
  created: number;
  offers: RTCOfferOptions[];
  localDescriptions: unknown[];
  remoteDescriptions: unknown[];
  channels: FakeDataChannel[];
  restarts: number;
  closed: number;
  stats: Map<string, unknown>;
}

class FakePeerConnection {
  onicecandidate: ((event: { candidate: RTCIceCandidate | null }) => void) | null = null;
  ontrack: ((event: unknown) => void) | null = null;
  oniceconnectionstatechange: (() => void) | null = null;
  iceConnectionState = 'new';
  localDescription: { sdp: string } | null = null;
  transceivers: { kind: string; init: unknown }[] = [];

  constructor(
    readonly configuration: RTCConfiguration,
    private readonly state: FakePeerState,
  ) {
    state.created += 1;
  }

  addTransceiver(kind: string, init: unknown): void {
    this.transceivers.push({ kind, init });
  }

  createDataChannel(label: string, init: RTCDataChannelInit): FakeDataChannel {
    const channel = new FakeDataChannel(label, init);
    this.state.channels.push(channel);
    return channel;
  }

  async createOffer(options?: RTCOfferOptions): Promise<{ type: 'offer'; sdp: string }> {
    this.state.offers.push(options ?? {});
    return { type: 'offer', sdp: `v=0\r\noffer-${this.state.offers.length}\r\n` };
  }

  async setLocalDescription(description: unknown): Promise<void> {
    this.state.localDescriptions.push(description);
    this.localDescription = description as { sdp: string };
  }

  async setRemoteDescription(description: unknown): Promise<void> {
    this.state.remoteDescriptions.push(description);
  }

  async addIceCandidate(): Promise<void> {}

  async getStats(): Promise<Map<string, unknown>> {
    return this.state.stats;
  }

  restartIce(): void {
    this.state.restarts += 1;
  }

  close(): void {
    this.state.closed += 1;
  }
}

function relayStats(candidateType: 'relay' | 'srflx'): Map<string, unknown> {
  return new Map<string, unknown>([
    ['pair', { type: 'candidate-pair', state: 'succeeded', nominated: true, localCandidateId: 'local' }],
    ['local', { type: 'local-candidate', candidateType }],
  ]);
}

function factoryFor(state: FakePeerState, certificate: RTCCertificate): RtcPeerConnectionFactory {
  const ctor = function (this: unknown, configuration: RTCConfiguration) {
    return new FakePeerConnection(configuration, state);
  } as unknown as RtcPeerConnectionFactory;
  ctor.generateCertificate = async () => certificate;
  return ctor;
}

function newState(): FakePeerState {
  return {
    created: 0,
    offers: [],
    localDescriptions: [],
    remoteDescriptions: [],
    channels: [],
    restarts: 0,
    closed: 0,
    stats: relayStats('srflx'),
  };
}

/** a certificate that answers `getFingerprints()` the way a browser does: lowercase. */
function lowercaseCertificate(): RTCCertificate {
  return {
    getFingerprints: () => [{ algorithm: 'sha-256', value: HOST_FINGERPRINT.toLowerCase() }],
  } as unknown as RTCCertificate;
}

const IDENTITY: SwoopIdentity = {
  certificate: {} as RTCCertificate,
  fingerprint: `sha-256 ${HOST_FINGERPRINT}`,
};

interface PeerHarness {
  peer: SwoopPeer;
  state: FakePeerState;
  sent: SignalingMessage[];
  errors: SwoopPeerError[];
  refreshes: number;
}

/** every peer a test built, so none leaves its relay probe timer running. */
const openPeers: SwoopPeer[] = [];

afterEach(() => {
  for (const peer of openPeers.splice(0)) peer.close();
  jest.useRealTimers();
});

function peerHarness(state = newState()): PeerHarness {
  const sent: SignalingMessage[] = [];
  const errors: SwoopPeerError[] = [];
  const counters = { refreshes: 0, leases: 0 };

  const peer = new SwoopPeer({
    identity: IDENTITY,
    sid: SID,
    viewerId: VIEWER_ID,
    viewerKey: VIEWER_KEY,
    iceServers: [{ urls: ['stun:stun.cloudflare.com:3478'] }],
    send: (message) => sent.push(message),
    refreshToken: async () => {
      counters.refreshes += 1;
    },
    onError: (code) => errors.push(code),
    leaseToken: async () => `viewer.jwt.${(counters.leases += 1)}`,
    factory: factoryFor(state, IDENTITY.certificate),
  });
  openPeers.push(peer);

  return {
    peer,
    state,
    sent,
    errors,
    get refreshes() {
      return counters.refreshes;
    },
  } as PeerHarness;
}

/** let the lease mint settle. */
async function settlePeer(): Promise<void> {
  for (let i = 0; i < 4; i += 1) await Promise.resolve();
}

// ---------------------------------------------------------------------------

describe('swoop peer — identity', () => {
  it('the fingerprint is available before any offer is created', async () => {
    const state = newState();
    const identity = await createSwoopIdentity(factoryFor(state, lowercaseCertificate()));

    // section 9's canonical form: hash token lowercase, hex uppercase. the
    // browser's getFingerprints() gives lowercase hex, so this is the uppercase
    // spike 2.12 says has to happen before the token is minted.
    expect(identity.fingerprint).toBe(`sha-256 ${HOST_FINGERPRINT}`);
    // no peer connection was built and no offer was created to learn it.
    expect(state.created).toBe(0);
    expect(state.offers).toHaveLength(0);
  });

  it('falls back to its own offer sdp when getFingerprints is unavailable', async () => {
    const state = newState();
    const certificate = {} as RTCCertificate;
    const ctor = function (this: unknown, configuration: RTCConfiguration) {
      const pc = new FakePeerConnection(configuration, state);
      pc.createOffer = async () => ({ type: 'offer' as const, sdp: answerSdp() });
      return pc;
    } as unknown as RtcPeerConnectionFactory;
    ctor.generateCertificate = async () => certificate;

    const identity = await createSwoopIdentity(ctor);

    expect(identity.fingerprint).toBe(`sha-256 ${HOST_FINGERPRINT}`);
    expect(state.offers).toHaveLength(0);
    // the fallback never starts ice: no setLocalDescription, and the probe closes.
    expect(state.localDescriptions).toHaveLength(0);
    expect(state.closed).toBe(1);
  });
});

describe('swoop peer — offer', () => {
  it('opens the five channels the protocol names, and no sixth', async () => {
    const h = peerHarness();
    await h.peer.start();

    expect(h.state.channels.map((c) => c.label)).toEqual([
      'swoop-input',
      'swoop-cursor',
      'swoop-control',
      'swoop-feedback',
      'swoop-meta',
    ]);
    // clipboard rides swoop-control; there is no swoop-clipboard.
    expect(h.state.channels.every((c) => c.init.protocol === 'owlette.swoop.v1')).toBe(true);
    expect(h.state.channels.find((c) => c.label === 'swoop-meta')?.binaryType).toBe('arraybuffer');
  });

  it('adds a recvonly video and a recvonly audio transceiver and offers first', async () => {
    const h = peerHarness();
    await h.peer.start();

    const pc = (h.peer.connection as unknown as FakePeerConnection);
    // the audio m-line is the whole of the host's opus path on this side: the
    // host answers what the browser offered and can add nothing of its own.
    expect(pc.transceivers).toEqual([
      { kind: 'video', init: { direction: 'recvonly' } },
      { kind: 'audio', init: { direction: 'recvonly' } },
    ]);
    expect(pc.configuration.bundlePolicy).toBe('max-bundle');
    expect(pc.configuration.rtcpMuxPolicy).toBe('require');
    expect(pc.configuration.iceCandidatePoolSize).toBe(1);
    expect(h.sent.map((m) => m.type)).toEqual(['offer']);
  });

  it('hands the track out with its receiver and writes no jitter target of its own', async () => {
    const h = peerHarness();
    await h.peer.start();
    const pc = h.peer.connection as unknown as FakePeerConnection;

    const receiver = {} as RTCRtpReceiver & { jitterBufferTarget?: number | null };
    const stream = { id: 'remote' } as MediaStream;
    const handed: { stream: MediaStream; receiver: RTCRtpReceiver }[] = [];
    (
      h.peer as unknown as { options: { onTrack: (s: MediaStream, r: RTCRtpReceiver) => void } }
    ).options.onTrack = (s, r) => handed.push({ stream: s, receiver: r });

    pc.ontrack?.({ receiver, streams: [stream], track: {} as MediaStreamTrack });

    expect(handed).toEqual([{ stream, receiver }]);
    // video/presenter.ts bounds the jitter buffer with the playout-delay max;
    // a second writer here would make the value depend on which ran last.
    expect(receiver.jitterBufferTarget).toBeUndefined();
  });

  it('refuses a playout-delay max of 0 rather than passing it on', () => {
    expect(() => peerHarnessWithDelay({ minMs: 0, maxMs: 0 })).toThrow(/max = 0 is forbidden/);
    expect(() => peerHarnessWithDelay({ minMs: 0, maxMs: 501 })).toThrow(/<= 500 ms/);
    expect(() => peerHarnessWithDelay({ minMs: 0, maxMs: 250 })).not.toThrow();
  });

  it('re-sends the standing offer when the host announces itself late', async () => {
    const h = peerHarness();
    await h.peer.start();
    await h.peer.handleSignal({ type: 'host-ready', sid: SID, to: VIEWER_ID });

    expect(h.sent.map((m) => m.type)).toEqual(['offer', 'offer']);
    // the same offer, not a second negotiation.
    expect(h.state.offers).toHaveLength(1);
  });

  it('presents the viewer token as the first frame on swoop-control', async () => {
    const h = peerHarness();
    await h.peer.start();
    const control = h.state.channels.find((c) => c.label === 'swoop-control')!;

    control.onopen?.();
    await settlePeer();

    // section 8 says the token is presented "inside the offer exchange", but
    // `offer` has no field for it — the lease message is the only path the
    // contract provides, so the connect token rides it too (agreed with 3.9).
    expect(JSON.parse(control.sent[0])).toEqual({ t: 'lease', token: 'viewer.jwt.1' });
    expect(h.state.channels.filter((c) => c.sent.length > 0)).toEqual([control]);
  });

  it('renews the lease down the same path it connected on', async () => {
    const h = peerHarness();
    await h.peer.start();
    const control = h.state.channels.find((c) => c.label === 'swoop-control')!;

    control.onopen?.();
    await settlePeer();
    await h.peer.presentLease();

    expect(control.sent.map((frame) => JSON.parse(frame).token)).toEqual(['viewer.jwt.1', 'viewer.jwt.2']);
  });

  it('ignores a host-ready for another session', async () => {
    const h = peerHarness();
    await h.peer.start();
    await h.peer.handleSignal({ type: 'host-ready', sid: 'sid_someone_else' });

    expect(h.sent.map((m) => m.type)).toEqual(['offer']);
  });
});

describe('swoop peer — the host fingerprint mac', () => {
  it('a wrong mac aborts and setRemoteDescription is never called', async () => {
    const h = peerHarness();
    await h.peer.start();

    await h.peer.handleSignal({
      type: 'answer',
      to: VIEWER_ID,
      sdp: answerSdp(),
      mac: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
    });

    expect(h.state.remoteDescriptions).toHaveLength(0);
    expect(h.errors).toEqual(['host_mac_mismatch']);
    expect(h.state.closed).toBe(1);
  });

  it('an absent mac aborts — it is a mismatch, not a lesser case', async () => {
    const h = peerHarness();
    await h.peer.start();

    await h.peer.handleSignal({ type: 'answer', to: VIEWER_ID, sdp: answerSdp(), mac: '' });

    expect(h.state.remoteDescriptions).toHaveLength(0);
    expect(h.errors).toEqual(['host_mac_mismatch']);
  });

  it('a substituted fingerprint aborts even though the mac is well formed', async () => {
    const h = peerHarness();
    await h.peer.start();

    const attacker = HOST_FINGERPRINT.replace('A0:', 'FF:');
    await h.peer.handleSignal({ type: 'answer', to: VIEWER_ID, sdp: answerSdp(attacker), mac: HOST_MAC });

    expect(h.state.remoteDescriptions).toHaveLength(0);
    expect(h.errors).toEqual(['host_mac_mismatch']);
  });

  it('an answer with no fingerprint at all aborts', async () => {
    const h = peerHarness();
    await h.peer.start();

    await h.peer.handleSignal({ type: 'answer', to: VIEWER_ID, sdp: 'v=0\r\nm=video 9 RTP 96\r\n', mac: HOST_MAC });

    expect(h.state.remoteDescriptions).toHaveLength(0);
    expect(h.errors).toEqual(['host_fingerprint_missing']);
  });

  it('the correct mac proceeds', async () => {
    const h = peerHarness();
    await h.peer.start();

    await h.peer.handleSignal({ type: 'answer', to: VIEWER_ID, sdp: answerSdp(), mac: HOST_MAC });

    expect(h.state.remoteDescriptions).toEqual([{ type: 'answer', sdp: answerSdp() }]);
    expect(h.errors).toEqual([]);
    expect(h.peer.diagnostics().answered).toBe(true);
  });

  it('compares the fingerprint case-insensitively', async () => {
    const h = peerHarness();
    await h.peer.start();

    await h.peer.handleSignal({
      type: 'answer',
      to: VIEWER_ID,
      sdp: answerSdp(HOST_FINGERPRINT.toLowerCase()),
      mac: HOST_MAC,
    });

    expect(h.state.remoteDescriptions).toHaveLength(1);
    expect(h.errors).toEqual([]);
  });

  it('aborts an answer that dropped the playout-delay extension', async () => {
    const h = peerHarness();
    await h.peer.start();

    await h.peer.handleSignal({
      type: 'answer',
      to: VIEWER_ID,
      sdp: answerSdp(HOST_FINGERPRINT, false),
      mac: HOST_MAC,
    });

    expect(h.state.remoteDescriptions).toHaveLength(0);
    expect(h.errors).toEqual(['playout_delay_not_negotiated']);
  });

  it('reads the extension only off the video m-line', () => {
    expect(playoutDelayNegotiated(answerSdp())).toBe(true);
    expect(playoutDelayNegotiated(answerSdp(HOST_FINGERPRINT, false))).toBe(false);
    expect(playoutDelayNegotiated(`m=audio 9 RTP 111\r\na=extmap:5 ${PLAYOUT_DELAY_URI}\r\nm=video 9 RTP 96\r\n`)).toBe(
      false,
    );
  });
});

describe('swoop peer — relay promotion', () => {
  async function connected(candidateType: 'relay' | 'srflx'): Promise<PeerHarness> {
    const state = newState();
    state.stats = relayStats(candidateType);
    const h = peerHarness(state);
    await h.peer.start();
    await h.peer.handleSignal({ type: 'answer', to: VIEWER_ID, sdp: answerSdp(), mac: HOST_MAC });
    return h;
  }

  it('one and only one restartIce fires for a persistent relay pair', async () => {
    jest.useFakeTimers();
    const h = await connected('relay');

    await jest.advanceTimersByTimeAsync(RELAY_PROBE_MS);
    expect(h.state.restarts).toBe(1);
    // the restart is a fresh browser offer, and a fresh offer needs a fresh token.
    expect(h.refreshes).toBe(1);
    expect(h.sent.map((m) => m.type)).toEqual(['offer', 'offer']);
    expect(h.state.offers[1]).toEqual({ iceRestart: true });

    // a relay pair that survives the restart never earns a second one.
    await jest.advanceTimersByTimeAsync(RELAY_PROBE_MS * 10);
    expect(h.state.restarts).toBe(1);
    expect(h.peer.diagnostics().iceRestarted).toBe(true);
  });

  it('leaves a direct pair alone', async () => {
    jest.useFakeTimers();
    const h = await connected('srflx');

    await jest.advanceTimersByTimeAsync(RELAY_PROBE_MS * 10);
    expect(h.state.restarts).toBe(0);
    expect(h.sent.map((m) => m.type)).toEqual(['offer']);
  });

  it('does not probe after the peer is closed', async () => {
    jest.useFakeTimers();
    const h = await connected('relay');
    h.peer.close();

    await jest.advanceTimersByTimeAsync(RELAY_PROBE_MS * 10);
    expect(h.state.restarts).toBe(0);
  });
});

describe('swoop peer — trickle', () => {
  it('sends a local candidate and swallows end-of-gathering', async () => {
    const h = peerHarness();
    await h.peer.start();
    const pc = h.peer.connection as unknown as FakePeerConnection;

    pc.onicecandidate?.({
      candidate: { candidate: 'candidate:1 1 udp 1 1.2.3.4 1 typ host', sdpMid: '0', sdpMLineIndex: 0 },
    } as unknown as { candidate: RTCIceCandidate | null });
    pc.onicecandidate?.({ candidate: null });

    expect(h.sent.filter((m) => m.type === 'candidate')).toHaveLength(1);
  });

  it('closes on a host bye and stops acting on signals', async () => {
    const h = peerHarness();
    await h.peer.start();

    await h.peer.handleSignal({ type: 'bye', fromRole: 'host', reason: 'idle' });
    expect(h.state.closed).toBe(1);

    await h.peer.handleSignal({ type: 'answer', to: VIEWER_ID, sdp: answerSdp(), mac: HOST_MAC });
    expect(h.state.remoteDescriptions).toHaveLength(0);
  });
});

/** a peer built only to exercise the playout-delay guard in its constructor. */
function peerHarnessWithDelay(playoutDelay: { minMs: number; maxMs: number }): SwoopPeer {
  return new SwoopPeer({
    identity: IDENTITY,
    sid: SID,
    viewerId: VIEWER_ID,
    viewerKey: VIEWER_KEY,
    iceServers: [],
    send: () => undefined,
    playoutDelay,
    factory: factoryFor(newState(), IDENTITY.certificate),
  });
}
