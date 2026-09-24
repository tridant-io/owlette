/**
 * the viewer's `RTCPeerConnection`: certificate, offer, five data channels, a
 * recvonly video track and a recvonly audio track, and the one check that makes
 * the relay untrusted.
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
 * ## the ice half (task 7.5)
 *
 * the host's policy lives in `agent/swoop/src/transport/ice_policy.rs`; this is
 * the browser's side of the same decisions.
 *
 * 1. **`iceTransportPolicy: "all"`, `bundlePolicy: "max-bundle"`,
 *    `rtcpMuxPolicy: "require"`, `iceCandidatePoolSize: 1`** — one ice
 *    component, one consent-freshness stream, one turn allocation, and the
 *    first candidate already gathered when the offer is built.
 * 2. **relay is stage 2, and the host's own allocation comes first.**
 *    cloudflare bills only server→client egress, so an allocation the *host*
 *    holds carries the video direction unbilled (plan.md D13) — a browser-side
 *    allocation pays for the same bytes. so the relay servers in `iceServers`
 *    are withheld from the first attempt and added only when the host reports
 *    it holds no allocation of its own. today it never does: the host's `turn`
 *    cargo feature has no client behind it yet (task 7.4), so the report is
 *    always "no allocation" and stage 2 always runs. when 7.4 lands, the host
 *    trickles a `typ relay` candidate of its own and this side stands down.
 * 3. **one promotion attempt.** a relayed pair still selected at
 *    `RELAY_PROBE_MS` is usually a direct path that gathered late; one restart
 *    is worth it and a second never is.
 * 4. **`disconnected` is acted on before `failed`.** consent freshness (rfc
 *    7675) stops transmission 30 s after the path goes quiet, so a link still
 *    down `DISCONNECTED_GRACE_MS` later is restarted rather than waited on.
 * 5. **a restart is an offer, and its answer is what completes it.** so an
 *    answer is accepted per *offer* and not once per session — with the whole
 *    of §4 above re-verified on every one of them. a `host-ready` after the
 *    answer is the host asking for that restart: it answers and never offers,
 *    so it has no other way to ask.
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

/**
 * how long `disconnected` may stand before an ice restart. consent freshness
 * kills media at 30 s, so this is deliberately early.
 */
export const DISCONNECTED_GRACE_MS = 2000;

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
  | 'answer_not_applied'
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
  /**
   * stun and turn together, as the session-create route minted them. the turn
   * entries are held back for stage 2 — see the module doc.
   */
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
  /**
   * does the host hold a turn allocation of its own?
   *
   * the default reads the only report that exists before media flows: a host
   * that holds an allocation surfaces it as a `typ relay` candidate (task 7.4),
   * and one that does not never sends one. an override is here for 7.4 to hang
   * a better report on — nothing else should set it.
   */
  hostRelayAllocation?: () => boolean;
  playoutDelay?: PlayoutDelay;
  relayProbeMs?: number;
  disconnectedGraceMs?: number;
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

/** a relay url is a turn or turns one; everything else is stun. */
function isRelayUrl(url: string): boolean {
  return /^turns?:/i.test(url);
}

/**
 * split the granted list into what the first attempt uses and what stage 2
 * adds. an entry that mixes stun and turn urls is split by url rather than
 * dropped whole — cloudflare sends one, and stage 1 still wants its stun.
 */
export function partitionIceServers(servers: RTCIceServer[]): {
  direct: RTCIceServer[];
  relay: RTCIceServer[];
} {
  const direct: RTCIceServer[] = [];
  const relay: RTCIceServer[] = [];
  for (const server of servers) {
    const urls = typeof server.urls === 'string' ? [server.urls] : server.urls;
    const relayUrls = urls.filter(isRelayUrl);
    const directUrls = urls.filter((url) => !isRelayUrl(url));
    if (directUrls.length > 0) direct.push({ ...server, urls: directUrls });
    if (relayUrls.length > 0) relay.push({ ...server, urls: relayUrls });
  }
  return { direct, relay };
}

/** the `typ` of an sdp candidate attribute, or null when it has none. */
export function candidateType(candidate: string): string | null {
  const fields = candidate.trim().split(/\s+/);
  const typ = fields.indexOf('typ');
  return typ >= 0 ? (fields[typ + 1] ?? null) : null;
}

/**
 * the first `a=ice-ufrag:` in an sdp, which is the credential half that has to
 * change for an ice restart to be a restart. bundled sessions repeat the same
 * one per m-line, so the first is the session's.
 */
export function extractIceUfrag(sdp: string): string | null {
  for (const line of sdp.split(/\r\n|\n/)) {
    if (!line.startsWith('a=ice-ufrag:')) continue;
    return line.slice('a=ice-ufrag:'.length).trim() || null;
  }
  return null;
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
  private readonly disconnectedGraceMs: number;
  private readonly directServers: RTCIceServer[];
  private readonly relayServers: RTCIceServer[];
  private readonly pc: RTCPeerConnection;
  private readonly channels = new Map<SwoopChannel, RTCDataChannel>();

  private offerSdp: string | null = null;
  /** an offer is out and exactly one answer may be applied against it. */
  private awaitingAnswer = false;
  /** an answer has been applied at least once, on this offer or an earlier. */
  private answered = false;
  /** the ice credentials in force, which a restart's answer has to change. */
  private iceUfrag: string | null = null;
  private iceRestarted = false;
  private promotionUsed = false;
  private browserRelayAdded = false;
  /** spent on the restart for one down-link episode; cleared on reconnect. */
  private recoveryUsed = false;
  /** the host trickled a `typ relay` candidate: it holds an allocation. */
  private hostRelay = false;
  private closed = false;
  private pendingCandidates: RTCIceCandidateInit[] = [];
  private relayTimer: ReturnType<typeof setTimeout> | null = null;
  private linkTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(options: SwoopPeerOptions) {
    this.options = options;
    this.playoutDelay = options.playoutDelay ?? DEFAULT_PLAYOUT_DELAY;
    assertPlayoutDelay(this.playoutDelay);
    this.relayProbeMs = options.relayProbeMs ?? RELAY_PROBE_MS;
    this.disconnectedGraceMs = options.disconnectedGraceMs ?? DISCONNECTED_GRACE_MS;

    const { direct, relay } = partitionIceServers(options.iceServers);
    this.directServers = direct;
    this.relayServers = relay;

    const factory = options.factory ?? defaultFactory();
    this.pc = new factory({
      certificates: [options.identity.certificate],
      // stage 1 is peer-to-peer plus whatever relay the host itself holds; the
      // browser's own allocation is stage 2 and costs egress we are billed for.
      iceServers: this.directServers,
      // one pool entry is enough to have a candidate ready at offer time
      // without holding a pile of relay allocations open.
      iceCandidatePoolSize: 1,
      // named rather than left to the default, because it is a decision: a
      // relay-only session is the fallback and never the policy.
      iceTransportPolicy: 'all',
      bundlePolicy: 'max-bundle',
      rtcpMuxPolicy: 'require',
    });

    this.pc.onicecandidate = (event) => this.onLocalCandidate(event.candidate);
    this.pc.ontrack = (event) => this.onRemoteTrack(event);
    this.pc.oniceconnectionstatechange = () => this.onIceState(this.pc.iceConnectionState);
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

  /** build the two transceivers and the five channels, then offer. */
  async start(): Promise<void> {
    this.pc.addTransceiver('video', { direction: 'recvonly' });
    // the browser offers and the host answers, so an m-line the offer does not
    // carry is one the host can never add: without this, a streamer with a
    // working opus encoder has nowhere to put it. the track is taken off the
    // connection by `lib/swoop/audio.ts`, which listens for it separately —
    // `onTrack` below is the video receiver's path and only the video's.
    //
    // **unconditional, deliberately.** this side cannot know before offering
    // whether the host has opus — `audio-opus` is not a default cargo feature —
    // and the only alternative, a host signal saying so, would add a message to
    // a frozen vocabulary to pre-empt a case the host must get right anyway. so
    // the guarantee lives there instead: a host with no opus rejects the m-line
    // and `agent/swoop/src/transport/rtc.rs` keeps that rejection well formed
    // (rfc 4566 wants a format list even on `port 0`; str0m 0.23.1 writes none,
    // which chrome refuses outright and which killed a real session). `audio.ts`
    // then simply never sees a track and reports `unavailable`.
    this.pc.addTransceiver('audio', { direction: 'recvonly' });

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
        if (message.sid !== this.options.sid) return;
        if (!this.answered) {
          // the host may have booted after we offered, and an offer sent into
          // an empty room was dropped by the relay. re-send the one we have —
          // unless its answer is already here and being applied, in which case
          // a re-send only earns a second answer.
          if (this.awaitingAnswer && this.offerSdp) this.options.send({ type: 'offer', sdp: this.offerSdp });
          return;
        }
        // after the answer it is the host's ice policy asking for a restart:
        // it answers and never offers (plan.md D8), so `host-ready` is the only
        // ask the frozen signalling vocabulary gives it. an offer already out
        // is that restart, so a second one would only replace it.
        await this.restart();
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
  async presentLease(token?: string): Promise<void> {
    const channel = this.channels.get('swoop-control');
    if (!channel) return;
    // a token the renewer just minted is presented as it is; with none given
    // this mints one, which at connect is the grant's own.
    const mint = this.options.leaseToken;
    const presented = token ?? (mint ? await mint() : null);
    if (presented === null || this.closed || channel.readyState !== 'open') return;
    channel.send(encodeControlMessage({ t: 'lease', token: presented }));
  }

  close(): void {
    this.shutdown('closed');
  }

  diagnostics(): {
    answered: boolean;
    iceRestarted: boolean;
    promotionUsed: boolean;
    browserRelayAdded: boolean;
    hostHoldsRelay: boolean;
    channels: SwoopChannel[];
    playoutDelay: PlayoutDelay;
  } {
    return {
      answered: this.answered,
      iceRestarted: this.iceRestarted,
      promotionUsed: this.promotionUsed,
      browserRelayAdded: this.browserRelayAdded,
      hostHoldsRelay: this.hostHoldsRelay(),
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
    this.awaitingAnswer = true;
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
    // one answer per offer, not one per session: an ice restart is a fresh
    // offer and its answer is what puts the new credentials in force. with no
    // offer outstanding there is nothing for an answer to answer, which is what
    // makes a duplicate or a replayed one inert.
    if (!this.awaitingAnswer) return;

    const ufrag = extractIceUfrag(sdp);
    if (this.answered && (ufrag === null || ufrag === this.iceUfrag)) {
      // an answered ice restart carries new ice credentials (rfc 8445 §9), so
      // an answer offering the ones already in force is the previous answer
      // replayed — its mac verifies and applying it would put the session back
      // on the dead pair. ignored rather than aborted: the real answer to the
      // outstanding offer may still be in flight.
      return;
    }
    // this offer is answered from here on. the host answers every copy of an
    // offer it receives, and the `host-ready` it sends on our join re-sends
    // ours when it lands before the answer does, so a second copy of this
    // answer arrives while the mac below is still being verified. taken before
    // the first await, so that copy is inert; applying it too is what the
    // browser refuses, and that refusal read as the connection failing
    // (b4a, 2026-09-24).
    this.awaitingAnswer = false;

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

    try {
      await this.pc.setRemoteDescription({ type: 'answer', sdp });
    } catch {
      // `handleSignal`'s caller drops what it rejects with, so an answer the
      // browser refuses outright used to leave the session sitting at
      // `connecting` with nothing said — that is how a malformed m-line from
      // the host presented. named, so it ends the session instead.
      return this.abort('answer_not_applied');
    }
    this.answered = true;
    this.iceUfrag = ufrag;

    const pending = this.pendingCandidates;
    this.pendingCandidates = [];
    for (const candidate of pending) await this.pc.addIceCandidate(candidate);

    this.armRelayProbe();
  }

  private async addRemoteCandidate(candidate: RTCIceCandidateInit): Promise<void> {
    // the host's own turn allocation announces itself here and nowhere else
    // before media flows — noted whether or not the candidate can be added yet.
    if (candidate.candidate && candidateType(candidate.candidate) === 'relay') this.hostRelay = true;
    if (this.awaitingAnswer) {
      // held for the answer this candidate belongs with, on the first
      // negotiation and on every restart after it: added against the previous
      // answer's credentials it would be attached to the generation being
      // replaced.
      this.pendingCandidates.push(candidate);
      return;
    }
    await this.pc.addIceCandidate(candidate);
  }

  /**
   * one look at the path T+3 s after the answer, which settles both of the ice
   * decisions this side owns. they are mutually exclusive by construction: a
   * pair is selected or it is not.
   */
  private armRelayProbe(): void {
    if (this.relayTimer !== null) return;
    this.relayTimer = setTimeout(() => {
      this.relayTimer = null;
      void this.probePath();
    }, this.relayProbeMs);
  }

  private async probePath(): Promise<void> {
    if (this.closed) return;
    const selected = await this.selectedPath();
    if (selected === 'relay') return this.promoteFromRelay();
    if (selected === null) return this.addBrowserRelay();
  }

  /**
   * a relayed pair still selected at T+3 s is usually a p2p path that gathered
   * late rather than a network that cannot do p2p, so one ice restart is worth
   * the renegotiation. exactly one: a restart loop on a genuinely relay-only
   * network would cost the session a reconnect every three seconds.
   */
  private async promoteFromRelay(): Promise<void> {
    if (this.promotionUsed) return;
    // spent only if it actually went out: a restart refused because one is
    // already in flight has cost the attempt nothing, and the probe re-arms on
    // the answer to that one.
    this.promotionUsed = await this.restart();
  }

  /**
   * stage 2: nothing is connected and the host holds no allocation of its own,
   * so the browser's turn servers go in and ice restarts with them. one
   * attempt — if relay does not connect the session either, a second identical
   * gathering will not change that.
   */
  private async addBrowserRelay(): Promise<void> {
    if (this.browserRelayAdded || this.relayServers.length === 0) return;
    // the host's relay candidate means the video direction is already unbilled
    // through its allocation (plan.md D13); a second one here pays twice.
    if (this.hostHoldsRelay()) return;
    this.pc.setConfiguration({
      ...this.pc.getConfiguration(),
      iceServers: [...this.directServers, ...this.relayServers],
    });
    // the servers are configured, but nothing gathers against them until an
    // offer does, so stage 2 counts as taken only once the restart is away.
    this.browserRelayAdded = await this.restart();
    // the promotion attempt is still owed: this restart was about connecting at
    // all, and the pair it connects on may well be a relayed one.
    if (this.browserRelayAdded && !this.promotionUsed && !this.closed) this.armRelayProbe();
  }

  private hostHoldsRelay(): boolean {
    return this.options.hostRelayAllocation?.() ?? this.hostRelay;
  }

  /** `'relay' | 'direct'` for the selected pair, `null` when there is none. */
  private async selectedPath(): Promise<'relay' | 'direct' | null> {
    let report: RTCStatsReport;
    try {
      report = await this.pc.getStats();
    } catch {
      return null;
    }
    let path: 'relay' | 'direct' | null = null;
    report.forEach((entry) => {
      const stat = entry as { type?: string; state?: string; nominated?: boolean; localCandidateId?: string };
      if (stat.type !== 'candidate-pair' || stat.state !== 'succeeded' || stat.nominated === false) return;
      const local = stat.localCandidateId ? report.get(stat.localCandidateId) : undefined;
      const relayed = (local as { candidateType?: string } | undefined)?.candidateType === 'relay';
      // a relayed pair wins the read: on a session with both, relay is the one
      // worth acting on.
      if (relayed || path === null) path = relayed ? 'relay' : 'direct';
    });
    return path;
  }

  /**
   * ice state is the only place a dead path shows up in time. `disconnected` is
   * given `DISCONNECTED_GRACE_MS` to come back on its own — checks do recover —
   * and then restarted, because consent freshness stops media 30 s in and
   * waiting for `failed` spends every one of those seconds black.
   */
  private onIceState(state: RTCIceConnectionState): void {
    if (this.closed) return;
    switch (state) {
      case 'connected':
      case 'completed':
        this.clearLinkTimer();
        // a new episode earns its own restart.
        this.recoveryUsed = false;
        return;
      case 'disconnected':
        if (this.linkTimer !== null) return;
        this.linkTimer = setTimeout(() => {
          this.linkTimer = null;
          if (this.pc.iceConnectionState === 'disconnected') void this.recover('disconnected');
        }, this.disconnectedGraceMs);
        return;
      case 'failed':
        this.clearLinkTimer();
        void this.recover('failed');
        return;
      default:
        return;
    }
  }

  private async recover(from: 'disconnected' | 'failed'): Promise<void> {
    if (this.closed) return;
    if (this.recoveryUsed) {
      // a second failure with no connection in between is a path that is gone,
      // not one that is flapping.
      if (from === 'failed') this.abort('ice_failed');
      return;
    }
    this.recoveryUsed = await this.restart();
  }

  /** true when a restart offer went out; false when one was already in flight. */
  private async restart(): Promise<boolean> {
    // an offer already outstanding is a renegotiation in flight, which is what
    // this one would ask for; replacing it would leave an answer nothing
    // expects.
    if (this.closed || this.awaitingAnswer) return false;
    this.iceRestarted = true;
    this.pc.restartIce();
    await this.offer(true);
    return true;
  }

  private clearLinkTimer(): void {
    if (this.linkTimer === null) return;
    clearTimeout(this.linkTimer);
    this.linkTimer = null;
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
    this.clearLinkTimer();
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
