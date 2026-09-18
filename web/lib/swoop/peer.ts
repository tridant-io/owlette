/**
 * the viewer's `RTCPeerConnection`: certificate, offer, five data channels, one
 * recvonly video track, and the one check that makes the relay untrusted.
 *
 * the shape follows PROTOCOL.md sections 3 and 9 and the order matters:
 *
 * 1. **the certificate comes first, before the session exists.** a viewer token
 *    carries `fp`, so the api needs the browser's dtls fingerprint in the
 *    session-create body — before any peer traffic and before any offer.
 *    `createSwoopIdentity()` is therefore its own call, and it never touches
 *    signaling. `getFingerprints()` returns lowercase hex while an sdp
 *    `a=fingerprint:` line is uppercase, so everything here goes through
 *    `canonicalizeFingerprint` and every comparison is case-insensitive by
 *    construction (measured in spike 2.12).
 * 2. **the browser offers, the host answers, and a renegotiation is a fresh
 *    browser offer.** the host never initiates one.
 * 3. **the viewer's own token reaches the host on `swoop-control`,** as the
 *    first frame that channel carries, because the `offer` message has no field
 *    to put it in. see `leaseToken` — it is a workaround for a gap in section 8,
 *    not the design.
 * 4. **the host's answer is not believed until its mac verifies.** the relay
 *    can substitute an sdp; it cannot forge `HMAC(k, … ‖ host fingerprint)`
 *    because it never sees `k`. an absent or wrong mac aborts —
 *    `setRemoteDescription` is never reached.
 *
 * gate g1 closed on arm B: the video is an rtp track rendered into a `<video>`,
 * so the playout-delay extension is the whole latency story on this side. the
 * hint itself is a sender-side header extension — the host stamps `min`/`max`
 * per frame — so what this module can do about it is negotiate the extension,
 * refuse to accept an answer that dropped it, and validate the hint the rest of
 * the app runs on. `max = 0` is forbidden (it makes chrome fast-forward and spam
 * PLI), so the config refuses it rather than passing it on. the receive-side
 * jitter floor is `video/presenter.ts`'s knob, and this module does not also
 * write it.
 */

import {
  PLAYOUT_DELAY_URI,
  PLAYOUT_DELAY_MAX_MS,
  PLAYOUT_DELAY_MIN_MS,
  SWOOP_CHANNELS,
  SWOOP_SUBPROTOCOL,
  canonicalizeFingerprint,
  encodeControlMessage,
  extractSdpFingerprint,
  verifyHostFingerprintMac,
  type SignalingMessage,
  type SwoopChannel,
} from './protocol';

/** section 3's ceiling: `max ∈ (0, 500]` ms. */
export const PLAYOUT_DELAY_MAX_CEILING_MS = 500;

/** how long a relay-selected pair may persist before one ice restart. */
export const RELAY_PROBE_MS = 3000;

export interface PlayoutDelay {
  minMs: number;
  maxMs: number;
}

export const DEFAULT_PLAYOUT_DELAY: Readonly<PlayoutDelay> = Object.freeze({
  minMs: PLAYOUT_DELAY_MIN_MS,
  maxMs: PLAYOUT_DELAY_MAX_MS,
});

/**
 * every way this peer gives up. each one closes the connection; none of them
 * proceeds and warns.
 */
export type SwoopPeerError =
  | 'host_mac_mismatch'
  | 'host_fingerprint_missing'
  | 'playout_delay_not_negotiated'
  | 'ice_failed';

export interface SwoopIdentity {
  certificate: RTCCertificate;
  /** canonical `sha-256 AA:BB:…` — hash token lowercase, hex uppercase. */
  fingerprint: string;
}

/** `RTCPeerConnection` plus its static, so tests can supply both halves. */
export interface RtcPeerConnectionFactory {
  new (configuration: RTCConfiguration): RTCPeerConnection;
  generateCertificate(algorithm: AlgorithmIdentifier): Promise<RTCCertificate>;
}

const DEFAULT_CERTIFICATE_ALGORITHM: AlgorithmIdentifier = {
  name: 'ECDSA',
  namedCurve: 'P-256',
} as unknown as AlgorithmIdentifier;

function defaultFactory(): RtcPeerConnectionFactory {
  return RTCPeerConnection as unknown as RtcPeerConnectionFactory;
}

/**
 * generate the dtls certificate and read its fingerprint, before anything else
 * exists. the `createOffer` fallback is for a browser without
 * `getFingerprints()`; it needs no `setLocalDescription`, so it starts no ice
 * and leaves no state behind.
 */
export async function createSwoopIdentity(
  factory: RtcPeerConnectionFactory = defaultFactory(),
): Promise<SwoopIdentity> {
  const certificate = await factory.generateCertificate(DEFAULT_CERTIFICATE_ALGORITHM);

  const direct = readCertificateFingerprint(certificate);
  if (direct) return { certificate, fingerprint: direct };

  const probe = new factory({ certificates: [certificate] });
  try {
    probe.addTransceiver('video', { direction: 'recvonly' });
    const offer = await probe.createOffer();
    const fingerprint = extractSdpFingerprint(offer.sdp ?? '');
    if (!fingerprint) throw new Error('swoop peer: certificate has no sha-256 fingerprint');
    return { certificate, fingerprint };
  } finally {
    probe.close();
  }
}

function readCertificateFingerprint(certificate: RTCCertificate): string | null {
  const getFingerprints = (certificate as Partial<RTCCertificate>).getFingerprints;
  if (typeof getFingerprints !== 'function') return null;
  for (const entry of getFingerprints.call(certificate)) {
    if (!entry.algorithm || !entry.value) continue;
    if (entry.algorithm.toLowerCase() !== 'sha-256') continue;
    // lowercase from the api, uppercase on the wire (spike 2.12).
    const canonical = canonicalizeFingerprint(`${entry.algorithm} ${entry.value}`);
    if (canonical) return canonical;
  }
  return null;
}

export interface SwoopPeerOptions {
  identity: SwoopIdentity;
  sid: string;
  viewerId: string;
  /** `k` from the session-create route. never logged, never in a url. */
  viewerKey: Uint8Array;
  iceServers: RTCIceServer[];
  /** the signaling socket's `send`; this module owns no socket. */
  send: (message: SignalingMessage) => void;
  /**
   * re-mint before a renegotiation. an ice restart is an offer, and an offer on
   * a spent token buys `token_expired` + close 4401 (PROTOCOL.md section 10).
   */
  refreshToken?: () => Promise<void>;
  /**
   * a viewer jwt for the host. section 8 says the token is presented to the
   * streamer "inside the offer exchange", but `offer` carries only `sdp` and
   * the streamer's decoder rejects unknown fields, so there is no field to put
   * it in. the only path the contract actually provides is section 10's lease
   * message, so the first thing `swoop-control` carries is the connect token
   * rather than only a renewal. **this is a workaround for a spec gap, agreed
   * with task 3.9; the fix belongs in PROTOCOL.md.**
   */
  leaseToken?: () => Promise<string>;
  playoutDelay?: PlayoutDelay;
  relayProbeMs?: number;
  onTrack?: (stream: MediaStream, receiver: RTCRtpReceiver) => void;
  onChannelOpen?: (label: SwoopChannel, channel: RTCDataChannel) => void;
  onError?: (code: SwoopPeerError) => void;
  onClosed?: (reason: string) => void;
  factory?: RtcPeerConnectionFactory;
}

function assertPlayoutDelay(delay: PlayoutDelay): void {
  if (!Number.isFinite(delay.minMs) || delay.minMs < 0) {
    throw new RangeError('swoop peer: playout-delay min must be >= 0');
  }
  if (delay.maxMs <= 0) {
    // the named landmine: chrome fast-forwards and spams PLI on max = 0.
    throw new RangeError('swoop peer: playout-delay max = 0 is forbidden');
  }
  if (delay.maxMs > PLAYOUT_DELAY_MAX_CEILING_MS) {
    throw new RangeError(`swoop peer: playout-delay max must be <= ${PLAYOUT_DELAY_MAX_CEILING_MS} ms`);
  }
  if (delay.minMs > delay.maxMs) throw new RangeError('swoop peer: playout-delay min exceeds max');
}

/** is the extension on the answer's video m-line? section 3 says it MUST be. */
export function playoutDelayNegotiated(sdp: string): boolean {
  let inVideo = false;
  for (const line of sdp.split(/\r\n|\n/)) {
    if (line.startsWith('m=')) {
      inVideo = line.startsWith('m=video');
      continue;
    }
    if (inVideo && line.startsWith('a=extmap:') && line.includes(PLAYOUT_DELAY_URI)) return true;
  }
  return false;
}

export class SwoopPeer {
  private readonly options: SwoopPeerOptions;
  private readonly playoutDelay: PlayoutDelay;
  private readonly relayProbeMs: number;
  private readonly pc: RTCPeerConnection;
  private readonly channels = new Map<SwoopChannel, RTCDataChannel>();

  private offerSdp: string | null = null;
  private answered = false;
  private iceRestarted = false;
  private closed = false;
  private pendingCandidates: RTCIceCandidateInit[] = [];
  private relayTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(options: SwoopPeerOptions) {
    this.options = options;
    this.playoutDelay = options.playoutDelay ?? DEFAULT_PLAYOUT_DELAY;
    assertPlayoutDelay(this.playoutDelay);
    this.relayProbeMs = options.relayProbeMs ?? RELAY_PROBE_MS;

    const factory = options.factory ?? defaultFactory();
    this.pc = new factory({
      certificates: [options.identity.certificate],
      iceServers: options.iceServers,
      // one pool entry is enough to have a candidate ready at offer time
      // without holding a pile of relay allocations open.
      iceCandidatePoolSize: 1,
      bundlePolicy: 'max-bundle',
      rtcpMuxPolicy: 'require',
    });

    this.pc.onicecandidate = (event) => this.onLocalCandidate(event.candidate);
    this.pc.ontrack = (event) => this.onRemoteTrack(event);
    this.pc.oniceconnectionstatechange = () => {
      if (this.pc.iceConnectionState === 'failed') this.abort('ice_failed');
    };
  }

  get connection(): RTCPeerConnection {
    return this.pc;
  }

  get identity(): SwoopIdentity {
    return this.options.identity;
  }

  channel(label: SwoopChannel): RTCDataChannel | null {
    return this.channels.get(label) ?? null;
  }

  /** build the transceiver and the five channels, then offer. */
  async start(): Promise<void> {
    this.pc.addTransceiver('video', { direction: 'recvonly' });

    for (const config of SWOOP_CHANNELS) {
      const init: RTCDataChannelInit = { ordered: config.ordered, protocol: SWOOP_SUBPROTOCOL };
      if (config.maxRetransmits !== undefined) init.maxRetransmits = config.maxRetransmits;
      if (config.maxPacketLifeTime !== undefined) init.maxPacketLifeTime = config.maxPacketLifeTime;
      const channel = this.pc.createDataChannel(config.label, init);
      if (config.binary) channel.binaryType = 'arraybuffer';
      channel.onopen = () => {
        // the channel is ordered and reliable, so the lease leads and every
        // later control message arrives behind an already-verified viewer.
        if (config.label === 'swoop-control') void this.presentLease();
        this.options.onChannelOpen?.(config.label, channel);
      };
      this.channels.set(config.label, channel);
    }

    await this.offer();
  }

  /**
   * route one signaling frame. anything addressed elsewhere, or belonging to
   * another session, is ignored rather than acted on.
   */
  async handleSignal(message: SignalingMessage): Promise<void> {
    if (this.closed) return;
    switch (message.type) {
      case 'host-ready':
        // the host may have booted after we offered, and an offer sent into an
        // empty room was dropped by the relay. re-send the one we have.
        if (message.sid === this.options.sid && !this.answered && this.offerSdp) {
          this.options.send({ type: 'offer', sdp: this.offerSdp });
        }
        return;
      case 'answer':
        await this.acceptAnswer(message.sdp, message.mac);
        return;
      case 'candidate':
        await this.addRemoteCandidate({
          candidate: message.candidate,
          sdpMid: message.sdpMid,
          sdpMLineIndex: message.sdpMLineIndex,
        });
        return;
      case 'kill':
        this.shutdown('kill');
        return;
      case 'bye':
        if (message.fromRole === 'host') this.shutdown(message.reason ?? 'bye');
        return;
      default:
        return;
    }
  }

  /**
   * hand the host a viewer jwt on `swoop-control`. it is how the streamer
   * verifies the viewer at connect (see `leaseToken`) and how section 10's
   * renewal keeps the session authorised afterwards — one code path, because
   * the host has one.
   */
  async presentLease(): Promise<void> {
    const mint = this.options.leaseToken;
    const channel = this.channels.get('swoop-control');
    if (!mint || !channel) return;
    const token = await mint();
    if (this.closed || channel.readyState !== 'open') return;
    channel.send(encodeControlMessage({ t: 'lease', token }));
  }

  close(): void {
    this.shutdown('closed');
  }

  diagnostics(): {
    answered: boolean;
    iceRestarted: boolean;
    channels: SwoopChannel[];
    playoutDelay: PlayoutDelay;
  } {
    return {
      answered: this.answered,
      iceRestarted: this.iceRestarted,
      channels: [...this.channels.keys()],
      playoutDelay: this.playoutDelay,
    };
  }

  private async offer(iceRestart = false): Promise<void> {
    // a renegotiation is a send, so the token has to be good before it leaves.
    if (this.offerSdp !== null) await this.options.refreshToken?.();
    const offer = await this.pc.createOffer(iceRestart ? { iceRestart: true } : undefined);
    await this.pc.setLocalDescription(offer);
    const sdp = offer.sdp ?? this.pc.localDescription?.sdp ?? '';
    this.offerSdp = sdp;
    this.options.send({ type: 'offer', sdp });
  }

  private onLocalCandidate(candidate: RTCIceCandidate | null): void {
    // the null candidate is end-of-gathering; there is no wire form for it.
    if (this.closed || !candidate || !candidate.candidate) return;
    this.options.send({
      type: 'candidate',
      candidate: candidate.candidate,
      sdpMid: candidate.sdpMid ?? '0',
      sdpMLineIndex: candidate.sdpMLineIndex ?? 0,
    });
  }

  private onRemoteTrack(event: RTCTrackEvent): void {
    // the receiver goes out with the stream because `jitterBufferTarget` is the
    // presentation layer's knob, not this module's: `video/presenter.ts` bounds
    // it with the playout-delay max. one writer, or the value is whoever ran
    // last.
    const stream = event.streams[0] ?? new MediaStream([event.track]);
    this.options.onTrack?.(stream, event.receiver);
  }

  private async acceptAnswer(sdp: string, mac: string): Promise<void> {
    if (this.answered) return;

    // an absent mac is a mismatch, not a lesser case.
    if (!mac) return this.abort('host_mac_mismatch');

    const hostFingerprint = extractSdpFingerprint(sdp);
    if (!hostFingerprint) return this.abort('host_fingerprint_missing');

    const verified = await verifyHostFingerprintMac(
      this.options.viewerKey,
      this.options.sid,
      this.options.viewerId,
      hostFingerprint,
      mac,
    );
    if (!verified) return this.abort('host_mac_mismatch');

    if (!playoutDelayNegotiated(sdp)) return this.abort('playout_delay_not_negotiated');

    await this.pc.setRemoteDescription({ type: 'answer', sdp });
    this.answered = true;

    const pending = this.pendingCandidates;
    this.pendingCandidates = [];
    for (const candidate of pending) await this.pc.addIceCandidate(candidate);

    this.armRelayProbe();
  }

  private async addRemoteCandidate(candidate: RTCIceCandidateInit): Promise<void> {
    if (!this.answered) {
      this.pendingCandidates.push(candidate);
      return;
    }
    await this.pc.addIceCandidate(candidate);
  }

  /**
   * a relayed pair still selected at T+3 s is usually a p2p path that gathered
   * late rather than a network that cannot do p2p, so one ice restart is worth
   * the renegotiation. exactly one: a restart loop on a genuinely relay-only
   * network would cost the session a reconnect every three seconds.
   */
  private armRelayProbe(): void {
    if (this.iceRestarted || this.relayTimer !== null) return;
    this.relayTimer = setTimeout(() => {
      this.relayTimer = null;
      void this.promoteFromRelay();
    }, this.relayProbeMs);
  }

  private async promoteFromRelay(): Promise<void> {
    if (this.closed || this.iceRestarted) return;
    if (!(await this.onRelay())) return;
    this.iceRestarted = true;
    this.pc.restartIce();
    await this.offer(true);
  }

  private async onRelay(): Promise<boolean> {
    let report: RTCStatsReport;
    try {
      report = await this.pc.getStats();
    } catch {
      return false;
    }
    let relayed = false;
    report.forEach((entry) => {
      const stat = entry as { type?: string; state?: string; nominated?: boolean; localCandidateId?: string };
      if (stat.type !== 'candidate-pair' || stat.state !== 'succeeded' || stat.nominated === false) return;
      const local = stat.localCandidateId ? report.get(stat.localCandidateId) : undefined;
      if ((local as { candidateType?: string } | undefined)?.candidateType === 'relay') relayed = true;
    });
    return relayed;
  }

  private abort(code: SwoopPeerError): void {
    if (this.closed) return;
    this.shutdown(code);
    this.options.onError?.(code);
  }

  private shutdown(reason: string): void {
    if (this.closed) return;
    this.closed = true;
    if (this.relayTimer !== null) {
      clearTimeout(this.relayTimer);
      this.relayTimer = null;
    }
    try {
      this.pc.close();
    } catch {
      // already closed.
    }
    this.options.onClosed?.(reason);
  }
}

export function createSwoopPeer(options: SwoopPeerOptions): SwoopPeer {
  return new SwoopPeer(options);
}
