/** @jest-environment node */

import { webcrypto } from 'crypto';

// Web Crypto is a browser global; the `node` runner does not expose it by
// default. Polyfill before importing the module under test, exactly as
// __tests__/lib/swoop/protocol.test.ts does.
if (!('crypto' in globalThis)) {
  (globalThis as unknown as { crypto: typeof webcrypto }).crypto = webcrypto;
}

import { PLAYOUT_DELAY_URI, base64UrlDecode, type SignalingMessage } from '@/lib/swoop/protocol';
import type { SwoopCodecChoice } from '@/lib/swoop/codecStore';
import {
  ANSWER_TIMEOUT_MS,
  DISCONNECTED_GRACE_MS,
  NO_PATH_MS,
  RELAY_PROBE_MS,
  RESTART_ANSWER_TIMEOUT_MS,
  SwoopPeer,
  candidateType,
  codecPreferences,
  createSwoopIdentity,
  extractIceUfrag,
  partitionIceServers,
  playoutDelayNegotiated,
  type RtcPeerConnectionFactory,
  type SwoopIdentity,
  type SwoopNoPath,
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

function answerSdp(
  fingerprint = HOST_FINGERPRINT,
  withPlayoutDelay = true,
  // str0m mints fresh credentials for an answered ice restart (rfc 8445 §9),
  // so the ufrag is what tells one generation's answer from another's.
  ufrag: string | null = null,
): string {
  return [
    'v=0',
    'o=- 0 0 IN IP4 127.0.0.1',
    's=-',
    't=0 0',
    'm=video 9 UDP/TLS/RTP/SAVPF 96',
    `a=fingerprint:sha-256 ${fingerprint}`,
    ...(ufrag === null ? [] : [`a=ice-ufrag:${ufrag}`]),
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
  configurations: RTCConfiguration[];
  candidates: RTCIceCandidateInit[];
}

class FakePeerConnection {
  onicecandidate: ((event: { candidate: RTCIceCandidate | null }) => void) | null = null;
  ontrack: ((event: unknown) => void) | null = null;
  oniceconnectionstatechange: (() => void) | null = null;
  iceConnectionState = 'new';
  localDescription: { sdp: string } | null = null;
  transceivers: { kind: string; init: unknown }[] = [];
  /** every `setCodecPreferences` call, by the kind of transceiver it was made on. */
  codecPreferences: { kind: string; codecs: RTCRtpCodec[] }[] = [];

  private active: RTCConfiguration;

  constructor(
    readonly configuration: RTCConfiguration,
    private readonly state: FakePeerState,
  ) {
    state.created += 1;
    this.active = configuration;
  }

  getConfiguration(): RTCConfiguration {
    return this.active;
  }

  setConfiguration(configuration: RTCConfiguration): void {
    this.active = configuration;
    this.state.configurations.push(configuration);
  }

  /** drive an ice state change the way the browser does. */
  iceState(state: string): void {
    this.iceConnectionState = state;
    this.oniceconnectionstatechange?.();
  }

  addTransceiver(kind: string, init: unknown): Pick<RTCRtpTransceiver, 'setCodecPreferences'> {
    this.transceivers.push({ kind, init });
    return { setCodecPreferences: (codecs) => void this.codecPreferences.push({ kind, codecs: [...codecs] }) };
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

  async addIceCandidate(candidate: RTCIceCandidateInit): Promise<void> {
    this.state.candidates.push(candidate);
  }

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
    configurations: [],
    candidates: [],
  };
}

/** no candidate pair has succeeded yet: nothing is connected. */
function noStats(): Map<string, unknown> {
  return new Map<string, unknown>();
}

const STUN: RTCIceServer = { urls: ['stun:stun.cloudflare.com:3478'] };
const TURN: RTCIceServer = {
  urls: ['turn:turn.cloudflare.com:3478?transport=udp', 'turns:turn.cloudflare.com:443?transport=tcp'],
  username: 'minted',
  credential: 'by-the-api',
};

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
  /** `error:<code>` and `closed:<reason>`, in the order the page is told. */
  endings: string[];
  /** every word the page got about the media path, in order. */
  noPaths: (SwoopNoPath | null)[];
  refreshes: number;
}

/** every peer a test built, so none leaves its relay probe timer running. */
const openPeers: SwoopPeer[] = [];

afterEach(() => {
  for (const peer of openPeers.splice(0)) peer.close();
  jest.useRealTimers();
});

function peerHarness(
  state = newState(),
  iceServers: RTCIceServer[] = [STUN],
  codec?: SwoopCodecChoice,
): PeerHarness {
  const sent: SignalingMessage[] = [];
  const errors: SwoopPeerError[] = [];
  const endings: string[] = [];
  const noPaths: (SwoopNoPath | null)[] = [];
  const counters = { refreshes: 0, leases: 0 };

  const peer = new SwoopPeer({
    identity: IDENTITY,
    sid: SID,
    viewerId: VIEWER_ID,
    viewerKey: VIEWER_KEY,
    iceServers,
    send: (message) => sent.push(message),
    refreshToken: async () => {
      counters.refreshes += 1;
    },
    onError: (code) => {
      errors.push(code);
      endings.push(`error:${code}`);
    },
    onClosed: (reason) => endings.push(`closed:${reason}`),
    onNoPath: (value) => noPaths.push(value),
    leaseToken: async () => `viewer.jwt.${(counters.leases += 1)}`,
    factory: factoryFor(state, IDENTITY.certificate),
    codec,
  });
  openPeers.push(peer);

  return {
    peer,
    state,
    sent,
    errors,
    endings,
    noPaths,
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
    // relay is the fallback and never the policy.
    expect(pc.configuration.iceTransportPolicy).toBe('all');
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

  it('does not re-send the offer on a host-ready that lands while the answer is being applied', async () => {
    const h = peerHarness();
    await h.peer.start();
    // the host answers the offer and, on our join, sends host-ready; the two
    // cross, and the answer is mid-verification when host-ready arrives.
    const applying = h.peer.handleSignal({ type: 'answer', to: VIEWER_ID, sdp: answerSdp(), mac: HOST_MAC });
    await h.peer.handleSignal({ type: 'host-ready', sid: SID, to: VIEWER_ID });
    await applying;

    expect(h.sent.map((m) => m.type)).toEqual(['offer']);
    expect(h.state.remoteDescriptions).toHaveLength(1);
    expect(h.errors).toEqual([]);
  });

  it('gives up on a host that never answers the first offer', async () => {
    jest.useFakeTimers();
    const h = peerHarness();
    await h.peer.start();

    await jest.advanceTimersByTimeAsync(ANSWER_TIMEOUT_MS - 1);
    expect(h.errors).toEqual([]);
    await jest.advanceTimersByTimeAsync(1);
    expect(h.errors).toEqual(['host_silent']);
  });

  it('counts the first offer’s wait from the moment the socket opens', async () => {
    jest.useFakeTimers();
    const h = peerHarness();
    // the page offers as soon as the dial is away, before the socket opens.
    h.peer.signalOpen(false);
    await h.peer.start();

    await jest.advanceTimersByTimeAsync(ANSWER_TIMEOUT_MS * 3);
    expect(h.errors).toEqual([]);
    h.peer.signalOpen(true);
    await jest.advanceTimersByTimeAsync(ANSWER_TIMEOUT_MS - 1);
    expect(h.errors).toEqual([]);
    await jest.advanceTimersByTimeAsync(1);
    expect(h.errors).toEqual(['host_silent']);
  });

  it('a host-ready re-arms the wait: that host is alive and has only now seen the offer', async () => {
    jest.useFakeTimers();
    const h = peerHarness();
    await h.peer.start();

    await jest.advanceTimersByTimeAsync(ANSWER_TIMEOUT_MS - 5_000);
    await h.peer.handleSignal({ type: 'host-ready', sid: SID, to: VIEWER_ID });
    expect(h.sent.map((m) => m.type)).toEqual(['offer', 'offer']);

    await jest.advanceTimersByTimeAsync(ANSWER_TIMEOUT_MS - 1);
    expect(h.errors).toEqual([]);
    await jest.advanceTimersByTimeAsync(1);
    expect(h.errors).toEqual(['host_silent']);
  });

  it('an answer clears the wait for good', async () => {
    jest.useFakeTimers();
    const h = peerHarness();
    await h.peer.start();
    await h.peer.handleSignal({ type: 'answer', to: VIEWER_ID, sdp: answerSdp(), mac: HOST_MAC });

    await jest.advanceTimersByTimeAsync(ANSWER_TIMEOUT_MS * 3);
    expect(h.errors).toEqual([]);
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

  it('presents a token the renewer hands it as it is, without minting another', async () => {
    const h = peerHarness();
    await h.peer.start();
    const control = h.state.channels.find((c) => c.label === 'swoop-control')!;

    control.onopen?.();
    await settlePeer();
    await h.peer.presentLease('renewed.jwt');

    expect(control.sent.map((frame) => JSON.parse(frame).token)).toEqual(['viewer.jwt.1', 'renewed.jwt']);
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

  it('a second copy of the answer, arriving while the first is still being verified, is inert', async () => {
    const h = peerHarness();
    await h.peer.start();

    // the host answered a re-sent copy of the offer too; the copies arrive a
    // couple of ms apart, while the browser is still applying the first.
    const pc = h.peer.connection as unknown as FakePeerConnection;
    const apply = pc.setRemoteDescription.bind(pc);
    pc.setRemoteDescription = async (description: unknown) => {
      await new Promise((resolve) => setTimeout(resolve, 10));
      await apply(description);
    };
    const answer = { type: 'answer' as const, to: VIEWER_ID, sdp: answerSdp(), mac: HOST_MAC };
    const first = h.peer.handleSignal(answer);
    await new Promise((resolve) => setTimeout(resolve, 2));
    await h.peer.handleSignal(answer);
    await first;

    expect(h.state.remoteDescriptions).toHaveLength(1);
    expect(h.errors).toEqual([]);
    expect(h.peer.diagnostics().answered).toBe(true);
  });

  it('ends the session when the browser refuses the answer outright', async () => {
    const h = peerHarness();
    await h.peer.start();

    const pc = h.peer.connection as unknown as FakePeerConnection;
    // word for word what chrome threw at a streamer built without opus: its
    // answer rejected the audio m-line with no format list at all, which is
    // not valid sdp, so the whole description was discarded.
    pc.setRemoteDescription = async () => {
      throw new Error('Failed to parse SessionDescription. m=audio 0 UDP/TLS/RTP/SAVPF  Invalid value: .');
    };

    // the caller drops what this rejects with, so it must not reject.
    await expect(
      h.peer.handleSignal({ type: 'answer', to: VIEWER_ID, sdp: answerSdp(), mac: HOST_MAC }),
    ).resolves.toBeUndefined();

    expect(h.errors).toEqual(['answer_not_applied']);
    expect(h.peer.diagnostics().answered).toBe(false);
    expect(h.state.closed).toBe(1);
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
    await h.peer.handleSignal({
      type: 'answer',
      to: VIEWER_ID,
      sdp: answerSdp(HOST_FINGERPRINT, true, 'promoted'),
      mac: HOST_MAC,
    });
    await jest.advanceTimersByTimeAsync(RELAY_PROBE_MS * 10);
    expect(h.state.restarts).toBe(1);
    expect(h.peer.diagnostics().iceRestarted).toBe(true);
    expect(h.errors).toEqual([]);
  });

  it('rolls back a promotion whose answer never comes, and keeps the relayed session', async () => {
    jest.useFakeTimers();
    const h = await connected('relay');
    (h.peer.connection as unknown as FakePeerConnection).iceState('connected');

    await jest.advanceTimersByTimeAsync(RELAY_PROBE_MS);
    expect(h.state.restarts).toBe(1);

    // a host whose accept failed answers nothing. ending here would reconnect
    // onto the same relay and promote again, every time the wait ran out.
    await jest.advanceTimersByTimeAsync(RESTART_ANSWER_TIMEOUT_MS);
    expect(h.state.localDescriptions.at(-1)).toEqual({ type: 'rollback' });
    expect(h.errors).toEqual([]);
    expect(h.state.closed).toBe(0);

    await jest.advanceTimersByTimeAsync(RELAY_PROBE_MS * 10);
    expect(h.state.restarts).toBe(1);
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

describe('swoop peer — stage-2 browser turn', () => {
  it('splits the granted list and offers on the stun half alone', async () => {
    const h = peerHarness(newState(), [STUN, TURN]);
    await h.peer.start();
    const pc = h.peer.connection as unknown as FakePeerConnection;

    // cloudflare bills server->client egress, so the host's own allocation is
    // the one that carries the video unbilled (plan.md D13). the browser's
    // relay servers are held back until the host says it has none.
    expect(pc.configuration.iceServers).toEqual([STUN]);
    expect(h.peer.diagnostics().browserRelayAdded).toBe(false);
  });

  it('splits an entry that mixes stun and turn urls rather than dropping it', () => {
    const mixed: RTCIceServer = {
      urls: ['stun:stun.cloudflare.com:3478', 'turn:turn.cloudflare.com:3478?transport=udp'],
      username: 'u',
      credential: 'c',
    };
    expect(partitionIceServers([mixed])).toEqual({
      direct: [{ ...mixed, urls: ['stun:stun.cloudflare.com:3478'] }],
      relay: [{ ...mixed, urls: ['turn:turn.cloudflare.com:3478?transport=udp'] }],
    });
    expect(partitionIceServers([])).toEqual({ direct: [], relay: [] });
  });

  it('reads the type off a candidate attribute', () => {
    expect(candidateType('candidate:1 1 udp 1 1.2.3.4 1 typ relay raddr 0.0.0.0')).toBe('relay');
    expect(candidateType('candidate:1 1 udp 1 1.2.3.4 1 typ host')).toBe('host');
    expect(candidateType('candidate:1 1 udp 1 1.2.3.4 1')).toBeNull();
  });

  it('adds the browser relay servers when nothing connected and the host holds no allocation', async () => {
    jest.useFakeTimers();
    const state = newState();
    state.stats = noStats();
    const h = peerHarness(state, [STUN, TURN]);
    await h.peer.start();
    await h.peer.handleSignal({ type: 'answer', to: VIEWER_ID, sdp: answerSdp(), mac: HOST_MAC });

    await jest.advanceTimersByTimeAsync(RELAY_PROBE_MS);

    expect(state.configurations).toHaveLength(1);
    expect(state.configurations[0].iceServers).toEqual([STUN, TURN]);
    expect(state.restarts).toBe(1);
    expect(h.state.offers[1]).toEqual({ iceRestart: true });
    expect(h.peer.diagnostics().browserRelayAdded).toBe(true);

    // and only once, however long it stays unconnected.
    await h.peer.handleSignal({
      type: 'answer',
      to: VIEWER_ID,
      sdp: answerSdp(HOST_FINGERPRINT, true, 'stage2'),
      mac: HOST_MAC,
    });
    await jest.advanceTimersByTimeAsync(RELAY_PROBE_MS * 10);
    expect(state.configurations).toHaveLength(1);
    expect(h.errors).toEqual([]);
  });

  it('still adds the browser relay when the host trickled a relay candidate of its own', async () => {
    jest.useFakeTimers();
    const state = newState();
    state.stats = noStats();
    const h = peerHarness(state, [STUN, TURN]);
    await h.peer.start();
    await h.peer.handleSignal({ type: 'answer', to: VIEWER_ID, sdp: answerSdp(), mac: HOST_MAC });
    // the host's allocation, announced the only way it can be before media
    // flows: as a candidate. nothing connected through it either, so on a
    // network that blocks udp the browser's turn over tcp is the last pair
    // left, and it goes in.
    await h.peer.handleSignal({
      type: 'candidate',
      candidate: 'candidate:4 1 udp 41885439 198.51.100.7 49203 typ relay raddr 0.0.0.0 rport 0',
      sdpMid: '0',
      sdpMLineIndex: 0,
    });

    await jest.advanceTimersByTimeAsync(RELAY_PROBE_MS);

    expect(h.peer.diagnostics().hostHoldsRelay).toBe(true);
    expect(state.configurations).toHaveLength(1);
    expect(state.restarts).toBe(1);
  });

  it('never restarts for a stage 2 it has no relay servers for', async () => {
    jest.useFakeTimers();
    const state = newState();
    state.stats = noStats();
    const h = peerHarness(state, [STUN]);
    await h.peer.start();
    await h.peer.handleSignal({ type: 'answer', to: VIEWER_ID, sdp: answerSdp(), mac: HOST_MAC });

    await jest.advanceTimersByTimeAsync(RELAY_PROBE_MS * 10);
    expect(state.restarts).toBe(0);
  });

  it('still owes the promotion attempt after a stage-2 restart', async () => {
    jest.useFakeTimers();
    const state = newState();
    state.stats = noStats();
    const h = peerHarness(state, [STUN, TURN]);
    await h.peer.start();
    await h.peer.handleSignal({ type: 'answer', to: VIEWER_ID, sdp: answerSdp(), mac: HOST_MAC });

    await jest.advanceTimersByTimeAsync(RELAY_PROBE_MS);
    expect(state.restarts).toBe(1);

    // the restart is not a restart until its answer lands: the promotion probe
    // re-arms off that answer, not off the offer.
    await h.peer.handleSignal({
      type: 'answer',
      to: VIEWER_ID,
      sdp: answerSdp(HOST_FINGERPRINT, true, 'stage2'),
      mac: HOST_MAC,
    });
    expect(state.remoteDescriptions).toHaveLength(2);

    // the stage-2 attempt connected, on relay — which is exactly the pair the
    // promotion attempt exists for.
    state.stats = relayStats('relay');
    await jest.advanceTimersByTimeAsync(RELAY_PROBE_MS);
    expect(state.restarts).toBe(2);
    expect(h.peer.diagnostics().promotionUsed).toBe(true);

    // and that is the end of it.
    await h.peer.handleSignal({
      type: 'answer',
      to: VIEWER_ID,
      sdp: answerSdp(HOST_FINGERPRINT, true, 'promoted'),
      mac: HOST_MAC,
    });
    await jest.advanceTimersByTimeAsync(RELAY_PROBE_MS * 10);
    expect(state.restarts).toBe(2);
    expect(h.errors).toEqual([]);
  });
});

describe('swoop peer — restart triggers', () => {
  async function live(): Promise<PeerHarness> {
    const h = peerHarness();
    await h.peer.start();
    await h.peer.handleSignal({ type: 'answer', to: VIEWER_ID, sdp: answerSdp(), mac: HOST_MAC });
    (h.peer.connection as unknown as FakePeerConnection).iceState('connected');
    return h;
  }

  it('restarts a link that is still disconnected after the grace window', async () => {
    jest.useFakeTimers();
    const h = await live();
    const pc = h.peer.connection as unknown as FakePeerConnection;

    pc.iceState('disconnected');
    // consent freshness has 30 s to run; the checks get 2 of them.
    await jest.advanceTimersByTimeAsync(DISCONNECTED_GRACE_MS - 1);
    expect(h.state.restarts).toBe(0);

    await jest.advanceTimersByTimeAsync(1);
    expect(h.state.restarts).toBe(1);
    expect(h.state.offers[1]).toEqual({ iceRestart: true });
    expect(h.errors).toEqual([]);
  });

  it('leaves a link that recovers inside the grace window alone', async () => {
    jest.useFakeTimers();
    const h = await live();
    const pc = h.peer.connection as unknown as FakePeerConnection;

    pc.iceState('disconnected');
    await jest.advanceTimersByTimeAsync(DISCONNECTED_GRACE_MS / 2);
    pc.iceState('connected');
    await jest.advanceTimersByTimeAsync(DISCONNECTED_GRACE_MS * 10);

    expect(h.state.restarts).toBe(0);
  });

  it('restarts on failed at once, and keeps restarting up a ladder rather than giving up', async () => {
    jest.useFakeTimers();
    const h = await live();
    const pc = h.peer.connection as unknown as FakePeerConnection;

    pc.iceState('failed');
    await jest.advanceTimersByTimeAsync(0);
    expect(h.state.restarts).toBe(1);
    expect(h.errors).toEqual([]);

    // the restart is answered and fails again: the second restart waits its
    // rung (≤ 1 s), the third ≤ 2 s, and none of them ends the session.
    await h.peer.handleSignal({
      type: 'answer',
      to: VIEWER_ID,
      sdp: answerSdp(HOST_FINGERPRINT, true, 'second'),
      mac: HOST_MAC,
    });
    pc.iceState('failed');
    await jest.advanceTimersByTimeAsync(1000);
    expect(h.state.restarts).toBe(2);
    await h.peer.handleSignal({
      type: 'answer',
      to: VIEWER_ID,
      sdp: answerSdp(HOST_FINGERPRINT, true, 'third'),
      mac: HOST_MAC,
    });
    pc.iceState('failed');
    await jest.advanceTimersByTimeAsync(2000);
    expect(h.state.restarts).toBe(3);
    expect(h.peer.restartAttempts()).toBe(3);
    expect(h.errors).toEqual([]);
    expect(h.state.closed).toBe(0);
  });

  it('earns a fresh restart once the link came back in between', async () => {
    jest.useFakeTimers();
    const h = await live();
    const pc = h.peer.connection as unknown as FakePeerConnection;

    pc.iceState('failed');
    await jest.advanceTimersByTimeAsync(0);
    // the restart completes — without its answer there is no new generation to
    // fail, and the next failure has nothing fresh to ask for.
    await h.peer.handleSignal({
      type: 'answer',
      to: VIEWER_ID,
      sdp: answerSdp(HOST_FINGERPRINT, true, 'second'),
      mac: HOST_MAC,
    });
    pc.iceState('connected');
    pc.iceState('failed');
    await jest.advanceTimersByTimeAsync(0);

    expect(h.state.restarts).toBe(2);
    expect(h.errors).toEqual([]);
  });

  it('does not restart after the peer is closed', async () => {
    jest.useFakeTimers();
    const h = await live();
    const pc = h.peer.connection as unknown as FakePeerConnection;

    pc.iceState('disconnected');
    h.peer.close();
    await jest.advanceTimersByTimeAsync(DISCONNECTED_GRACE_MS * 10);
    expect(h.state.restarts).toBe(0);
  });
});

describe('swoop peer — the restart answer', () => {
  /** connected on the first answer, with an ice restart offer outstanding. */
  async function restarting(): Promise<PeerHarness> {
    const h = peerHarness();
    await h.peer.start();
    await h.peer.handleSignal({
      type: 'answer',
      to: VIEWER_ID,
      sdp: answerSdp(HOST_FINGERPRINT, true, 'first'),
      mac: HOST_MAC,
    });
    const pc = h.peer.connection as unknown as FakePeerConnection;
    pc.iceState('connected');
    pc.iceState('failed');
    await jest.advanceTimersByTimeAsync(0);
    expect(h.state.restarts).toBe(1);
    expect(h.state.offers[1]).toEqual({ iceRestart: true });
    return h;
  }

  it('reads the ufrag the restart turns over', () => {
    expect(extractIceUfrag(answerSdp(HOST_FINGERPRINT, true, 'abc123'))).toBe('abc123');
    expect(extractIceUfrag(answerSdp())).toBeNull();
  });

  it('applies the answer to a restart offer, which is what puts it in force', async () => {
    jest.useFakeTimers();
    const h = await restarting();

    await h.peer.handleSignal({
      type: 'answer',
      to: VIEWER_ID,
      sdp: answerSdp(HOST_FINGERPRINT, true, 'second'),
      mac: HOST_MAC,
    });

    // restartIce() alone changes nothing: the new credentials arrive in the
    // answer, so a restart that never reaches setRemoteDescription is a
    // restart that never happened.
    expect(h.state.remoteDescriptions).toHaveLength(2);
    expect(h.state.remoteDescriptions[1]).toEqual({
      type: 'answer',
      sdp: answerSdp(HOST_FINGERPRINT, true, 'second'),
    });
    expect(h.errors).toEqual([]);
    expect(h.state.closed).toBe(0);
  });

  /** connected on the first answer and still up, with a host-asked restart outstanding. */
  async function restartingWhileUp(): Promise<PeerHarness> {
    const h = peerHarness();
    await h.peer.start();
    await h.peer.handleSignal({
      type: 'answer',
      to: VIEWER_ID,
      sdp: answerSdp(HOST_FINGERPRINT, true, 'first'),
      mac: HOST_MAC,
    });
    (h.peer.connection as unknown as FakePeerConnection).iceState('connected');
    await h.peer.handleSignal({ type: 'host-ready', sid: SID, to: VIEWER_ID });
    expect(h.state.restarts).toBe(1);
    return h;
  }

  it('ends as host_silent when a restart on a link that is down goes unanswered with the socket open', async () => {
    jest.useFakeTimers();
    const h = await restarting();

    // the offer reached the room and nothing came back: a host silent with
    // our socket open is dead or wedged, and there is no working session left
    // to keep. a new one is right.
    await jest.advanceTimersByTimeAsync(RESTART_ANSWER_TIMEOUT_MS - 1);
    expect(h.errors).toEqual([]);
    await jest.advanceTimersByTimeAsync(1);
    expect(h.errors).toEqual(['host_silent']);
    expect(h.state.closed).toBe(1);
  });

  it('waits on a restart only while its answer can come back', async () => {
    jest.useFakeTimers();
    const h = await restarting();

    // the viewer's own path is down: the offer sits queued in signalling, and
    // the host may well be holding this viewer the whole time.
    h.peer.signalOpen(false);
    await jest.advanceTimersByTimeAsync(RESTART_ANSWER_TIMEOUT_MS * 30);
    expect(h.errors).toEqual([]);

    // back online, the queued offer gets its whole wait from here.
    h.peer.signalOpen(true);
    await jest.advanceTimersByTimeAsync(RESTART_ANSWER_TIMEOUT_MS - 1);
    expect(h.errors).toEqual([]);
    await jest.advanceTimersByTimeAsync(1);
    expect(h.errors).toEqual(['host_silent']);
  });

  it('rolls back an unanswered restart on a link that is still up, and restarts again later', async () => {
    jest.useFakeTimers();
    const h = await restartingWhileUp();

    await jest.advanceTimersByTimeAsync(RESTART_ANSWER_TIMEOUT_MS);
    expect(h.state.localDescriptions.at(-1)).toEqual({ type: 'rollback' });
    expect(h.errors).toEqual([]);
    expect(h.state.closed).toBe(0);

    // nothing is outstanding now: a link that fails later restarts at once,
    // from the bottom of the ladder.
    (h.peer.connection as unknown as FakePeerConnection).iceState('failed');
    await jest.advanceTimersByTimeAsync(0);
    expect(h.state.restarts).toBe(2);
    expect(h.peer.restartAttempts()).toBe(1);
  });

  it('ends as host_silent when the browser refuses the rollback', async () => {
    jest.useFakeTimers();
    const h = await restartingWhileUp();
    (h.peer.connection as unknown as FakePeerConnection).setLocalDescription = async () => {
      throw new Error('rollback refused');
    };

    await jest.advanceTimersByTimeAsync(RESTART_ANSWER_TIMEOUT_MS);
    expect(h.errors).toEqual(['host_silent']);
    expect(h.state.closed).toBe(1);
  });

  it('never rolls back a first offer, whatever ice reports', async () => {
    jest.useFakeTimers();
    const h = peerHarness();
    await h.peer.start();
    (h.peer.connection as unknown as FakePeerConnection).iceState('connected');

    await jest.advanceTimersByTimeAsync(ANSWER_TIMEOUT_MS);
    expect(h.errors).toEqual(['host_silent']);
    expect(h.state.localDescriptions).toHaveLength(1);
  });

  it('an answered restart clears the wait, and nothing fires after it', async () => {
    jest.useFakeTimers();
    const h = await restarting();

    await h.peer.handleSignal({
      type: 'answer',
      to: VIEWER_ID,
      sdp: answerSdp(HOST_FINGERPRINT, true, 'second'),
      mac: HOST_MAC,
    });
    await jest.advanceTimersByTimeAsync(RESTART_ANSWER_TIMEOUT_MS * 2);
    expect(h.errors).toEqual([]);
    expect(h.state.closed).toBe(0);
  });

  it('ignores an answer with no offer outstanding, and a replay of the one in force', async () => {
    jest.useFakeTimers();
    const h = peerHarness();
    await h.peer.start();
    const first = answerSdp(HOST_FINGERPRINT, true, 'first');
    await h.peer.handleSignal({ type: 'answer', to: VIEWER_ID, sdp: first, mac: HOST_MAC });
    expect(h.state.remoteDescriptions).toHaveLength(1);

    // a duplicate with nothing outstanding has nothing to answer.
    await h.peer.handleSignal({ type: 'answer', to: VIEWER_ID, sdp: first, mac: HOST_MAC });
    expect(h.state.remoteDescriptions).toHaveLength(1);

    const pc = h.peer.connection as unknown as FakePeerConnection;
    pc.iceState('connected');
    pc.iceState('failed');
    await jest.advanceTimersByTimeAsync(0);

    // and replayed into the restart it still carries the credentials already in
    // force, so applying it would put the session back on the dead pair. its
    // mac verifies — this is the check that stops it.
    await h.peer.handleSignal({ type: 'answer', to: VIEWER_ID, sdp: first, mac: HOST_MAC });
    expect(h.state.remoteDescriptions).toHaveLength(1);
    expect(h.errors).toEqual([]);
    expect(h.state.closed).toBe(0);

    // the real one still lands.
    await h.peer.handleSignal({
      type: 'answer',
      to: VIEWER_ID,
      sdp: answerSdp(HOST_FINGERPRINT, true, 'second'),
      mac: HOST_MAC,
    });
    expect(h.state.remoteDescriptions).toHaveLength(2);
  });

  it('verifies the mac again on the restart answer', async () => {
    jest.useFakeTimers();
    const h = await restarting();

    const attacker = HOST_FINGERPRINT.replace('A0:', 'FF:');
    await h.peer.handleSignal({
      type: 'answer',
      to: VIEWER_ID,
      sdp: answerSdp(attacker, true, 'second'),
      mac: HOST_MAC,
    });

    // the relay gets a second bite at substituting an sdp at every restart, so
    // the mac is a per-answer check and never a first-answer one.
    expect(h.state.remoteDescriptions).toHaveLength(1);
    expect(h.errors).toEqual(['host_mac_mismatch']);
    expect(h.state.closed).toBe(1);
  });

  it('checks playout-delay again on the restart answer', async () => {
    jest.useFakeTimers();
    const h = await restarting();

    await h.peer.handleSignal({
      type: 'answer',
      to: VIEWER_ID,
      sdp: answerSdp(HOST_FINGERPRINT, false, 'second'),
      mac: HOST_MAC,
    });

    expect(h.state.remoteDescriptions).toHaveLength(1);
    expect(h.errors).toEqual(['playout_delay_not_negotiated']);
  });

  it('holds the candidates that arrive during a restart for its answer', async () => {
    jest.useFakeTimers();
    const h = await restarting();
    const candidate = 'candidate:9 1 udp 2122260223 192.0.2.8 51234 typ host';

    await h.peer.handleSignal({ type: 'candidate', candidate, sdpMid: '0', sdpMLineIndex: 0 });
    // added against the answer being replaced it would join the generation on
    // its way out.
    expect(h.state.candidates).toHaveLength(0);

    await h.peer.handleSignal({
      type: 'answer',
      to: VIEWER_ID,
      sdp: answerSdp(HOST_FINGERPRINT, true, 'second'),
      mac: HOST_MAC,
    });

    expect(h.state.candidates).toEqual([{ candidate, sdpMid: '0', sdpMLineIndex: 0 }]);
  });

  it('treats a host-ready after the answer as the host asking for a restart', async () => {
    jest.useFakeTimers();
    const h = peerHarness();
    await h.peer.start();
    await h.peer.handleSignal({
      type: 'answer',
      to: VIEWER_ID,
      sdp: answerSdp(HOST_FINGERPRINT, true, 'first'),
      mac: HOST_MAC,
    });

    // the host answers and never offers, so this is the only ask it has.
    await h.peer.handleSignal({ type: 'host-ready', sid: SID, to: VIEWER_ID });
    expect(h.state.restarts).toBe(1);
    expect(h.state.offers[1]).toEqual({ iceRestart: true });

    // a second ask while that offer is outstanding is the same ask.
    await h.peer.handleSignal({ type: 'host-ready', sid: SID, to: VIEWER_ID });
    expect(h.state.restarts).toBe(1);

    await h.peer.handleSignal({
      type: 'answer',
      to: VIEWER_ID,
      sdp: answerSdp(HOST_FINGERPRINT, true, 'second'),
      mac: HOST_MAC,
    });
    await h.peer.handleSignal({ type: 'host-ready', sid: SID, to: VIEWER_ID });
    expect(h.state.restarts).toBe(2);
  });

  it('ignores a host-ready for another session once connected', async () => {
    jest.useFakeTimers();
    const h = peerHarness();
    await h.peer.start();
    await h.peer.handleSignal({
      type: 'answer',
      to: VIEWER_ID,
      sdp: answerSdp(HOST_FINGERPRINT, true, 'first'),
      mac: HOST_MAC,
    });

    await h.peer.handleSignal({ type: 'host-ready', sid: 'sid_someone_else' });
    expect(h.state.restarts).toBe(0);
    expect(h.sent.map((m) => m.type)).toEqual(['offer']);
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

describe('swoop peer — endings', () => {
  it('ignores a kill naming another session', async () => {
    const h = peerHarness();
    await h.peer.start();

    await h.peer.handleSignal({ type: 'kill', sid: 'sid_someone_else' });
    expect(h.state.closed).toBe(0);
    expect(h.endings).toEqual([]);
  });

  it.each([
    ['this session', SID],
    ['no session, which means whatever is running', null],
  ])('ends on a kill naming %s', async (_what, sid) => {
    const h = peerHarness();
    await h.peer.start();

    await h.peer.handleSignal({ type: 'kill', sid });
    expect(h.state.closed).toBe(1);
    expect(h.endings).toEqual(['closed:kill']);
  });

  it('an abort reports its code before it closes', async () => {
    const h = peerHarness();
    await h.peer.start();

    await h.peer.handleSignal({
      type: 'answer',
      to: VIEWER_ID,
      sdp: answerSdp(),
      mac: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
    });
    expect(h.endings).toEqual(['error:host_mac_mismatch', 'closed:host_mac_mismatch']);
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

describe('swoop peer — no media path', () => {
  async function answered(iceServers: RTCIceServer[] = [STUN]): Promise<PeerHarness> {
    const h = peerHarness(newState(), iceServers);
    await h.peer.start();
    await h.peer.handleSignal({ type: 'answer', to: VIEWER_ID, sdp: answerSdp(), mac: HOST_MAC });
    return h;
  }

  it('says there is no path when none comes up within the deadline, and not before', async () => {
    jest.useFakeTimers();
    const h = await answered();

    await jest.advanceTimersByTimeAsync(NO_PATH_MS - 1);
    expect(h.noPaths).toEqual([]);
    await jest.advanceTimersByTimeAsync(1);
    // stun only: nothing was relayed, so the page can say a relay would help.
    expect(h.noPaths).toEqual([{ relayConfigured: false, hostRelay: false, browserRelay: null }]);
    // the session stays open; the restart ladder keeps trying underneath.
    expect(h.state.closed).toBe(0);
  });

  it('says nothing at all when a path comes up before the deadline', async () => {
    jest.useFakeTimers();
    const h = await answered();
    (h.peer.connection as unknown as FakePeerConnection).iceState('connected');

    await jest.advanceTimersByTimeAsync(NO_PATH_MS * 3);
    expect(h.noPaths).toEqual([]);
  });

  it('takes the word back when a path comes up after it', async () => {
    jest.useFakeTimers();
    const h = await answered();
    await jest.advanceTimersByTimeAsync(NO_PATH_MS);
    (h.peer.connection as unknown as FakePeerConnection).iceState('connected');

    expect(h.noPaths).toEqual([{ relayConfigured: false, hostRelay: false, browserRelay: null }, null]);
  });

  it('says a relay was there when the session had turn servers, and that neither end reached it', async () => {
    jest.useFakeTimers();
    const state = newState();
    state.stats = noStats();
    const h = peerHarness(state, [STUN, TURN]);
    await h.peer.start();
    await h.peer.handleSignal({ type: 'answer', to: VIEWER_ID, sdp: answerSdp(), mac: HOST_MAC });

    // stage 2 ran at T+3 s and the host answered its restart; nothing gathered
    // against the browser's relay: this browser tried and failed.
    await jest.advanceTimersByTimeAsync(RELAY_PROBE_MS);
    expect(h.peer.diagnostics().browserRelayAdded).toBe(true);
    await h.peer.handleSignal({
      type: 'answer',
      to: VIEWER_ID,
      sdp: answerSdp(HOST_FINGERPRINT, true, 'stage2'),
      mac: HOST_MAC,
    });
    await jest.advanceTimersByTimeAsync(NO_PATH_MS - RELAY_PROBE_MS);
    expect(h.noPaths).toEqual([{ relayConfigured: true, hostRelay: false, browserRelay: false }]);
  });

  it('does not blame this browser for a relay it never tried', async () => {
    jest.useFakeTimers();
    // a pair was up at T+3 s, so stage 2 never ran, and it dropped later.
    const h = await answered([STUN, TURN]);

    await jest.advanceTimersByTimeAsync(NO_PATH_MS);
    expect(h.peer.diagnostics().browserRelayAdded).toBe(false);
    expect(h.noPaths).toEqual([{ relayConfigured: true, hostRelay: false, browserRelay: null }]);
  });

  it('says which ends reached the relay: the host by its candidate, this browser by its own', async () => {
    jest.useFakeTimers();
    const h = await answered([STUN, TURN]);
    await h.peer.handleSignal({
      type: 'candidate',
      candidate: 'candidate:4 1 udp 41885439 198.51.100.7 49203 typ relay raddr 0.0.0.0 rport 0',
      sdpMid: '0',
      sdpMLineIndex: 0,
    });
    const pc = h.peer.connection as unknown as FakePeerConnection;
    pc.onicecandidate?.({
      candidate: {
        candidate: 'candidate:2 1 udp 25108223 203.0.113.9 61000 typ relay raddr 0.0.0.0 rport 0',
        sdpMid: '0',
        sdpMLineIndex: 0,
      },
    } as unknown as { candidate: RTCIceCandidate | null });

    await jest.advanceTimersByTimeAsync(NO_PATH_MS);
    expect(h.noPaths).toEqual([{ relayConfigured: true, hostRelay: true, browserRelay: true }]);
  });

  it('counts a host relay candidate as a relay even with no turn servers of its own', async () => {
    jest.useFakeTimers();
    const h = await answered([STUN]);
    await h.peer.handleSignal({
      type: 'candidate',
      candidate: 'candidate:4 1 udp 41885439 198.51.100.7 49203 typ relay raddr 0.0.0.0 rport 0',
      sdpMid: '0',
      sdpMLineIndex: 0,
    });

    await jest.advanceTimersByTimeAsync(NO_PATH_MS);
    expect(h.noPaths).toEqual([{ relayConfigured: true, hostRelay: true, browserRelay: null }]);
  });

  it('is quiet once the peer is closed', async () => {
    jest.useFakeTimers();
    const h = await answered();
    h.peer.close();

    await jest.advanceTimersByTimeAsync(NO_PATH_MS * 3);
    expect(h.noPaths).toEqual([]);
  });
});

describe('swoop peer — the codec the offer carries', () => {
  // what chrome lists for a receiver that decodes both: the primary codecs,
  // then the helpers that ride with them.
  const CAPS: RTCRtpCodec[] = [
    { mimeType: 'video/VP8', clockRate: 90000 },
    { mimeType: 'video/rtx', clockRate: 90000 },
    { mimeType: 'video/H264', clockRate: 90000, sdpFmtpLine: 'packetization-mode=1;profile-level-id=42e01f' },
    { mimeType: 'video/H264', clockRate: 90000, sdpFmtpLine: 'packetization-mode=1;profile-level-id=640034' },
    { mimeType: 'video/H265', clockRate: 90000 },
    { mimeType: 'video/AV1', clockRate: 90000 },
    { mimeType: 'video/red', clockRate: 90000 },
    { mimeType: 'video/ulpfec', clockRate: 90000 },
    { mimeType: 'video/flexfec-03', clockRate: 90000 },
  ];
  const mimes = (codecs: RTCRtpCodec[] | null | undefined) => codecs?.map((codec) => codec.mimeType) ?? null;

  beforeEach(() => {
    (globalThis as unknown as { RTCRtpReceiver: unknown }).RTCRtpReceiver = {
      getCapabilities: (kind: string) => (kind === 'video' ? { codecs: CAPS, headerExtensions: [] } : null),
    };
  });
  afterEach(() => {
    delete (globalThis as unknown as { RTCRtpReceiver?: unknown }).RTCRtpReceiver;
  });

  it('offers h.264 alone, with its rtx, red and fec, when the tab chose h264', async () => {
    const h = peerHarness(newState(), [STUN], 'h264');
    await h.peer.start();
    const pc = h.peer.connection as unknown as FakePeerConnection;

    // the host takes hevc whenever `h265` appears in the offer, so it must not.
    expect(pc.codecPreferences.map((call) => call.kind)).toEqual(['video']);
    expect(mimes(pc.codecPreferences[0].codecs)).toEqual([
      'video/H264',
      'video/H264',
      'video/rtx',
      'video/red',
      'video/ulpfec',
      'video/flexfec-03',
    ]);
    // the preference is in place before the offer that carries it.
    expect(h.sent.map((m) => m.type)).toEqual(['offer']);
  });

  it('leads with hevc for hevc but keeps the rest, so a machine without it still answers in h.264', () => {
    expect(mimes(codecPreferences(CAPS, 'hevc'))).toEqual([
      'video/H265',
      'video/VP8',
      'video/rtx',
      'video/H264',
      'video/H264',
      'video/AV1',
      'video/red',
      'video/ulpfec',
      'video/flexfec-03',
    ]);
  });

  it.each<[string, SwoopCodecChoice | undefined]>([
    ['auto', 'auto'],
    ['no choice', undefined],
  ])('leaves the browser’s own list alone for %s', async (_what, codec) => {
    const h = peerHarness(newState(), [STUN], codec);
    await h.peer.start();
    expect((h.peer.connection as unknown as FakePeerConnection).codecPreferences).toEqual([]);
  });

  it('leaves the list alone when the browser cannot receive the codec chosen', () => {
    expect(codecPreferences(CAPS.filter((codec) => codec.mimeType !== 'video/H265'), 'hevc')).toBeNull();
  });

  it('starts on a browser with no codec api at all', async () => {
    delete (globalThis as unknown as { RTCRtpReceiver?: unknown }).RTCRtpReceiver;
    const h = peerHarness(newState(), [STUN], 'h264');
    await expect(h.peer.start()).resolves.toBeUndefined();
    expect((h.peer.connection as unknown as FakePeerConnection).codecPreferences).toEqual([]);
  });
});
