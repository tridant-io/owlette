/**
 * swoop wire protocol — the browser half of `agent/swoop/PROTOCOL.md`.
 *
 * dependency-free on purpose: no react, no firestore, no fetch, no logging.
 * `agent/swoop/testdata/protocol/index.json` is the shared oracle — the rust
 * protocol core iterates the same manifest, so anything decided here has to be
 * the spec's reading rather than a convenient one.
 *
 * decoders are total: they return a typed rejection carrying the manifest's
 * reason code and never throw, because the receive path runs per frame. only
 * the encoders throw, and only on a caller bug (a field outside its wire
 * width), which is never network input.
 */

// ---------------------------------------------------------------------------
// constants
// ---------------------------------------------------------------------------

/** section 1. one integer, no minor version, no negotiation. */
export const SWOOP_PROTOCOL_VERSION = 1;

/** the websocket subprotocol and every data channel's `protocol` field. */
export const SWOOP_SUBPROTOCOL = 'owlette.swoop.v1';

/** section 2: a signaling frame over this is refused `message_too_large`. */
export const MAX_SIGNALING_BYTES = 64 * 1024;

/** section 4: the binary frame record is a fixed 48-byte little-endian header. */
export const FRAME_HEADER_BYTES = 48;

export const FRAME_FLAG_IRAP = 0x01;
export const FRAME_FLAG_RESOLUTION_CHANGED = 0x02;
export const FRAME_FLAG_PARAMETER_SETS_IN_BAND = 0x04;

/** section 5 clipboard caps, checked before the first chunk is buffered. */
export const CLIPBOARD_MAX_TEXT_BYTES = 256 * 1024;
export const CLIPBOARD_MAX_IMAGE_BYTES = 2 * 1024 * 1024;
export const CLIPBOARD_MAX_CHUNK_BYTES = 16 * 1024;
/** transfers above this are reported to the audit trail by the host. */
export const CLIPBOARD_AUDIT_BYTES = 64 * 1024;

/** section 8 token lifetimes, in seconds. */
export const VIEWER_TOKEN_MAX_LIFETIME_S = 60;
export const HOST_TOKEN_MAX_LIFETIME_S = 300;

/** section 9 / 11 literals. a drift here is a silent interop failure. */
export const HKDF_SESSION_SALT = 'owlette-swoop/session/v1';
export const HKDF_VIEWER_SALT = 'owlette-swoop/viewer/v1';
export const HOST_FP_MAC_LABEL = 'owlette-swoop/host-fp/v1';

/**
 * section 3: the playout-delay extension is mandatory and `max = 0` is
 * forbidden — it makes chrome fast-forward and spam PLI.
 */
export const PLAYOUT_DELAY_URI =
  'http://www.webrtc.org/experiments/rtp-hdrext/playout-delay';
export const PLAYOUT_DELAY_MIN_MS = 0;
export const PLAYOUT_DELAY_MAX_MS = 250;

export type SwoopChannel =
  | 'swoop-input'
  | 'swoop-cursor'
  | 'swoop-control'
  | 'swoop-feedback'
  | 'swoop-meta';

export interface SwoopChannelConfig {
  readonly label: SwoopChannel;
  readonly ordered: boolean;
  readonly maxRetransmits?: number;
  readonly maxPacketLifeTime?: number;
  readonly binary: boolean;
}

/**
 * section 3: five channels, all opened by the browser (it is the offerer).
 * clipboard rides `swoop-control` rather than taking a sixth — the transport
 * caps buffering at 128 KiB across all channels, so fewer channels is one
 * pacing budget instead of five competing ones.
 */
export const SWOOP_CHANNELS: readonly SwoopChannelConfig[] = [
  { label: 'swoop-input', ordered: false, maxRetransmits: 0, binary: false },
  { label: 'swoop-cursor', ordered: false, maxRetransmits: 0, binary: false },
  { label: 'swoop-control', ordered: true, binary: false },
  { label: 'swoop-feedback', ordered: false, maxPacketLifeTime: 250, binary: false },
  { label: 'swoop-meta', ordered: false, maxPacketLifeTime: 250, binary: true },
];

export type SwoopCodec = 'h264' | 'hevc' | 'av1';

/** section 4: the codec byte. index is the wire value. */
const CODEC_BY_BYTE: readonly SwoopCodec[] = ['h264', 'hevc', 'av1'];

// ---------------------------------------------------------------------------
// result
// ---------------------------------------------------------------------------

/**
 * every reason code a decoder here can produce. the manifest's `reason` field
 * is drawn from this set.
 */
export type RejectReason =
  // transport-shaped refusals (section 2)
  | 'malformed_message'
  | 'binary_unsupported'
  | 'message_too_large'
  | 'unknown_type'
  | 'forbidden_type'
  | 'wrong_role'
  // version (section 1)
  | 'version_mismatch'
  // jwt (sections 8 and 11)
  | 'unknown_kid'
  | 'alg_not_permitted'
  | 'bad_signature'
  | 'iss_mismatch'
  | 'aud_mismatch'
  | 'role_mismatch'
  | 'expired'
  | 'lifetime_too_long'
  | 'fp_missing'
  | 'fp_mismatch'
  | 'site_mismatch'
  | 'machine_mismatch'
  | 'sid_mismatch'
  | 'jti_replayed'
  // frame records (section 4)
  | 'unknown_record'
  | 'dangling_reference'
  // channel messages (section 5)
  | 'not_permitted'
  | 'clipboard_too_large'
  // bundle (section 7)
  | 'bundle_invalid'
  | 'overrides_not_permitted';

export interface Accepted<T> {
  readonly ok: true;
  readonly value: T;
}

export interface Rejected {
  readonly ok: false;
  readonly reason: RejectReason;
  /** a non-sensitive hint for the stats overlay. never token or key material. */
  readonly detail?: string;
}

export type SwoopResult<T> = Accepted<T> | Rejected;

const accept = <T>(value: T): Accepted<T> => ({ ok: true, value });
const reject = (reason: RejectReason, detail?: string): Rejected =>
  detail === undefined ? { ok: false, reason } : { ok: false, reason, detail };

// ---------------------------------------------------------------------------
// small readers — absent or wrong-typed fields come back undefined
// ---------------------------------------------------------------------------

type JsonObject = Record<string, unknown>;

const asObject = (v: unknown): JsonObject | null =>
  typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as JsonObject) : null;

const str = (o: JsonObject, k: string): string | undefined =>
  typeof o[k] === 'string' ? (o[k] as string) : undefined;

const bool = (o: JsonObject, k: string): boolean | undefined =>
  typeof o[k] === 'boolean' ? (o[k] as boolean) : undefined;

const num = (o: JsonObject, k: string): number | undefined =>
  typeof o[k] === 'number' && Number.isFinite(o[k] as number) ? (o[k] as number) : undefined;

const int = (o: JsonObject, k: string): number | undefined =>
  typeof o[k] === 'number' && Number.isSafeInteger(o[k] as number) ? (o[k] as number) : undefined;

/** `undefined` when absent, `null` when explicitly null — the two differ on the wire. */
const nullableStr = (o: JsonObject, k: string): string | null | undefined => {
  if (!(k in o)) return undefined;
  if (o[k] === null) return null;
  return typeof o[k] === 'string' ? (o[k] as string) : undefined;
};

/** parse a wire string into an object, mapping both failure shapes to a reason. */
function parseJsonObject(raw: unknown, maxBytes?: number): SwoopResult<JsonObject> {
  if (typeof raw !== 'string') return reject('binary_unsupported');
  if (maxBytes !== undefined && utf8(raw).length > maxBytes) return reject('message_too_large');
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return reject('malformed_message');
  }
  const obj = asObject(parsed);
  return obj ? accept(obj) : reject('malformed_message');
}

// ---------------------------------------------------------------------------
// bytes and base64url
// ---------------------------------------------------------------------------

export function utf8(s: string): Uint8Array {
  return new TextEncoder().encode(s);
}

export function base64UrlEncode(bytes: Uint8Array): string {
  let binary = '';
  for (let i = 0; i < bytes.length; i += 1) binary += String.fromCharCode(bytes[i]);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** returns null rather than throwing: this runs on attacker-supplied input. */
export function base64UrlDecode(value: string): Uint8Array | null {
  if (!/^[A-Za-z0-9_-]*$/.test(value)) return null;
  const padded = value.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (value.length % 4)) % 4);
  let binary: string;
  try {
    binary = atob(padded);
  } catch {
    return null;
  }
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) out[i] = binary.charCodeAt(i);
  return out;
}

export function concatBytes(parts: readonly Uint8Array[]): Uint8Array {
  let total = 0;
  for (const p of parts) total += p.length;
  const out = new Uint8Array(total);
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

/** length-safe, data-independent comparison. used on every mac check. */
export function constantTimeEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) diff |= a[i] ^ b[i];
  return diff === 0;
}

// ---------------------------------------------------------------------------
// section 1 — protocol-version handshake
// ---------------------------------------------------------------------------

/**
 * the room's first frame carries `protocolVersion`. a mismatch closes with
 * `bye`/`version_mismatch`; it is never negotiated or downgraded.
 */
export function checkProtocolVersion(
  hello: SignalHello,
  supported: number = SWOOP_PROTOCOL_VERSION,
): SwoopResult<SignalHello> {
  return hello.protocolVersion === supported
    ? accept(hello)
    : reject('version_mismatch', `server speaks ${hello.protocolVersion}`);
}

// ---------------------------------------------------------------------------
// section 2 — signaling messages
// ---------------------------------------------------------------------------

export type SwoopRole = 'viewer' | 'host' | 'doorbell' | 'server';

export type SignalingType =
  | 'hello'
  | 'ring'
  | 'viewer-join'
  | 'error'
  | 'kill'
  | 'offer'
  | 'answer'
  | 'host-ready'
  | 'candidate'
  | 'bye';

/** the room stamps these on anything it forwards. */
interface Stamped {
  from?: string;
  fromRole?: SwoopRole;
  serverTimeMs?: number;
}

export interface SignalHello extends Stamped {
  type: 'hello';
  protocolVersion: number;
  role: SwoopRole;
  id: string;
  sid?: string | null;
  ctl: boolean;
  peers: { doorbell: number; host: number; viewer: number };
}

export interface SignalRing extends Stamped {
  type: 'ring';
  sid: string;
  sentAtMs: number;
}

export interface SignalViewerJoin extends Stamped {
  type: 'viewer-join';
  viewer: string;
  sid: string;
  ctl: boolean;
}

export interface SignalError extends Stamped {
  type: 'error';
  code: string;
}

export interface SignalKill extends Stamped {
  type: 'kill';
  /** null means "kill whatever is running". */
  sid?: string | null;
}

export interface SignalOffer extends Stamped {
  type: 'offer';
  sdp: string;
}

export interface SignalAnswer extends Stamped {
  type: 'answer';
  to: string;
  sdp: string;
  /** section 9, base64url. an absent mac aborts the connection. */
  mac: string;
}

export interface SignalHostReady extends Stamped {
  type: 'host-ready';
  sid: string;
  to?: string;
}

export interface SignalCandidate extends Stamped {
  type: 'candidate';
  candidate: string;
  sdpMid: string;
  sdpMLineIndex: number;
  to?: string;
}

export interface SignalBye extends Stamped {
  type: 'bye';
  reason?: string;
  to?: string;
}

export type SignalingMessage =
  | SignalHello
  | SignalRing
  | SignalViewerJoin
  | SignalError
  | SignalKill
  | SignalOffer
  | SignalAnswer
  | SignalHostReady
  | SignalCandidate
  | SignalBye;

/**
 * section 2's send-rights table. `server` here is the room itself; a client
 * that sends a server-only type is refused `forbidden_type`, and a client
 * sending someone else's type is refused `wrong_role`.
 */
export const SIGNALING_SENDERS: Readonly<Record<SignalingType, readonly SwoopRole[]>> = {
  hello: ['server'],
  ring: ['server'],
  'viewer-join': ['server'],
  error: ['server'],
  kill: ['server'],
  offer: ['viewer'],
  answer: ['host'],
  'host-ready': ['host'],
  candidate: ['viewer', 'host'],
  bye: ['viewer', 'host'],
};

export function checkSendRights(role: SwoopRole, type: string): SwoopResult<SignalingType> {
  const senders = SIGNALING_SENDERS[type as SignalingType];
  if (!senders) return reject('unknown_type', type);
  if (senders.includes(role)) return accept(type as SignalingType);
  // a client cannot forge a ring or a kill; that is a different refusal from
  // "right message, wrong side of the room".
  return reject(senders[0] === 'server' ? 'forbidden_type' : 'wrong_role', type);
}

function readStamp(o: JsonObject, into: Stamped): void {
  const from = str(o, 'from');
  if (from !== undefined) into.from = from;
  const fromRole = str(o, 'fromRole');
  if (fromRole !== undefined) into.fromRole = fromRole as SwoopRole;
  const serverTimeMs = int(o, 'serverTimeMs');
  if (serverTimeMs !== undefined) into.serverTimeMs = serverTimeMs;
}

/** decode one frame off the signaling socket. `raw` is the socket's `data`. */
export function decodeSignalingMessage(raw: unknown): SwoopResult<SignalingMessage> {
  const parsed = parseJsonObject(raw, MAX_SIGNALING_BYTES);
  if (!parsed.ok) return parsed;
  const o = parsed.value;
  const type = str(o, 'type');
  if (type === undefined) return reject('malformed_message', 'type');
  if (!(type in SIGNALING_SENDERS)) return reject('unknown_type', type);

  const stamp: Stamped = {};
  readStamp(o, stamp);

  switch (type as SignalingType) {
    case 'hello': {
      const protocolVersion = int(o, 'protocolVersion');
      const role = str(o, 'role');
      const id = str(o, 'id');
      const ctl = bool(o, 'ctl');
      const peers = asObject(o.peers);
      if (protocolVersion === undefined || role === undefined || id === undefined || ctl === undefined || !peers) {
        return reject('malformed_message', 'hello');
      }
      const doorbell = int(peers, 'doorbell');
      const host = int(peers, 'host');
      const viewer = int(peers, 'viewer');
      if (doorbell === undefined || host === undefined || viewer === undefined) {
        return reject('malformed_message', 'hello.peers');
      }
      const sid = nullableStr(o, 'sid');
      const msg: SignalHello = {
        type: 'hello',
        protocolVersion,
        role: role as SwoopRole,
        id,
        ctl,
        peers: { doorbell, host, viewer },
        ...stamp,
      };
      if ('sid' in o) msg.sid = sid ?? null;
      return accept(msg);
    }
    case 'ring': {
      const sid = str(o, 'sid');
      const sentAtMs = int(o, 'sentAtMs');
      if (sid === undefined || sentAtMs === undefined) return reject('malformed_message', 'ring');
      return accept({ type: 'ring', sid, sentAtMs, ...stamp });
    }
    case 'viewer-join': {
      const viewer = str(o, 'viewer');
      const sid = str(o, 'sid');
      const ctl = bool(o, 'ctl');
      if (viewer === undefined || sid === undefined || ctl === undefined) {
        return reject('malformed_message', 'viewer-join');
      }
      return accept({ type: 'viewer-join', viewer, sid, ctl, ...stamp });
    }
    case 'error': {
      const code = str(o, 'code');
      if (code === undefined) return reject('malformed_message', 'error');
      return accept({ type: 'error', code, ...stamp });
    }
    case 'kill': {
      const msg: SignalKill = { type: 'kill', ...stamp };
      if ('sid' in o) {
        const sid = nullableStr(o, 'sid');
        if (sid === undefined) return reject('malformed_message', 'kill.sid');
        msg.sid = sid;
      }
      return accept(msg);
    }
    case 'offer': {
      const sdp = str(o, 'sdp');
      if (sdp === undefined) return reject('malformed_message', 'offer');
      return accept({ type: 'offer', sdp, ...stamp });
    }
    case 'answer': {
      const sdp = str(o, 'sdp');
      const mac = str(o, 'mac');
      const to = str(o, 'to');
      if (sdp === undefined || mac === undefined || to === undefined) {
        return reject('malformed_message', 'answer');
      }
      return accept({ type: 'answer', to, sdp, mac, ...stamp });
    }
    case 'host-ready': {
      const sid = str(o, 'sid');
      if (sid === undefined) return reject('malformed_message', 'host-ready');
      const msg: SignalHostReady = { type: 'host-ready', sid, ...stamp };
      const to = str(o, 'to');
      if (to !== undefined) msg.to = to;
      return accept(msg);
    }
    case 'candidate': {
      const candidate = str(o, 'candidate');
      const sdpMid = str(o, 'sdpMid');
      const sdpMLineIndex = int(o, 'sdpMLineIndex');
      if (candidate === undefined || sdpMid === undefined || sdpMLineIndex === undefined) {
        return reject('malformed_message', 'candidate');
      }
      const msg: SignalCandidate = { type: 'candidate', candidate, sdpMid, sdpMLineIndex, ...stamp };
      const to = str(o, 'to');
      if (to !== undefined) msg.to = to;
      return accept(msg);
    }
    case 'bye': {
      const msg: SignalBye = { type: 'bye', ...stamp };
      const reason = str(o, 'reason');
      if (reason !== undefined) msg.reason = reason;
      const to = str(o, 'to');
      if (to !== undefined) msg.to = to;
      return accept(msg);
    }
  }
}

/** `JSON.stringify` drops undefined-valued keys, which is the omission rule. */
export function encodeSignalingMessage(message: SignalingMessage): string {
  return JSON.stringify(message);
}

// ---------------------------------------------------------------------------
// section 4 — the binary frame header
// ---------------------------------------------------------------------------

export interface SwoopFrameHeader {
  /** `0x01` = frame record. */
  kind: number;
  headerVersion: number;
  codec: SwoopCodec;
  irap: boolean;
  resolutionChanged: boolean;
  parameterSets: boolean;
  /**
   * flag bits 3-7, sent zero. kept so a re-encode is byte-identical rather
   * than quietly normalising a future sender's bits away.
   */
  reservedFlags: number;
  fragmentIndex: number;
  fragmentCount: number;
  frameId: number;
  /** the join key to the picture on the rtp video track. */
  rtpTimestamp90k: number;
  width: number;
  height: number;
  /** 0 for a header-only record, which is every record under the G1 winner. */
  payloadBytes: number;
  /** microseconds since `streamerEpoch` — never raw qpc ticks, never wall clock. */
  tCaptureUs: number;
  tEncodeUs: number;
  tSendUs: number;
}

const toBytes = (data: ArrayBufferView | ArrayBuffer): Uint8Array =>
  data instanceof ArrayBuffer
    ? new Uint8Array(data)
    : new Uint8Array(data.buffer, data.byteOffset, data.byteLength);

/** decode a `swoop-meta` record. total: a bad record is dropped, never thrown. */
export function decodeFrameHeader(data: ArrayBufferView | ArrayBuffer): SwoopResult<SwoopFrameHeader> {
  const bytes = toBytes(data);
  if (bytes.length < FRAME_HEADER_BYTES) return reject('malformed_message', 'short record');
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);

  const kind = view.getUint8(0);
  const headerVersion = view.getUint8(1);
  // an unknown kind or header version is dropped, not guessed at.
  if (kind !== 0x01) return reject('unknown_record', `kind ${kind}`);
  if (headerVersion !== 0x01) return reject('unknown_record', `headerVersion ${headerVersion}`);

  const codecByte = view.getUint8(2);
  const codec = CODEC_BY_BYTE[codecByte];
  // same treatment: a receiver cannot configure a decoder it does not know.
  if (codec === undefined) return reject('unknown_record', `codec ${codecByte}`);

  const flags = view.getUint8(3);
  const payloadBytes = view.getUint32(20, true);
  if (bytes.length !== FRAME_HEADER_BYTES + payloadBytes) {
    return reject('malformed_message', 'payload length');
  }

  const fragmentCount = view.getUint16(6, true);
  if (fragmentCount < 1) return reject('malformed_message', 'fragmentCount');
  const fragmentIndex = view.getUint16(4, true);
  if (fragmentIndex >= fragmentCount) return reject('malformed_message', 'fragmentIndex');

  const stamps = [24, 32, 40].map((at) => Number(view.getBigUint64(at, true)));
  if (stamps.some((v) => !Number.isSafeInteger(v))) {
    // 2^53 µs is ~285 years of streamer uptime relative to streamerEpoch.
    return reject('malformed_message', 'timestamp');
  }

  return accept({
    kind,
    headerVersion,
    codec,
    irap: (flags & FRAME_FLAG_IRAP) !== 0,
    resolutionChanged: (flags & FRAME_FLAG_RESOLUTION_CHANGED) !== 0,
    parameterSets: (flags & FRAME_FLAG_PARAMETER_SETS_IN_BAND) !== 0,
    reservedFlags: flags >> 3,
    fragmentIndex,
    fragmentCount,
    frameId: view.getUint32(8, true),
    rtpTimestamp90k: view.getUint32(12, true),
    width: view.getUint16(16, true),
    height: view.getUint16(18, true),
    payloadBytes,
    tCaptureUs: stamps[0],
    tEncodeUs: stamps[1],
    tSendUs: stamps[2],
  });
}

function requireRange(value: number, max: number, field: string): void {
  if (!Number.isSafeInteger(value) || value < 0 || value > max) {
    throw new RangeError(`swoop frame header: ${field} out of range`);
  }
}

/** encode a header-only record (or the header half of a payload record). */
export function encodeFrameHeader(header: SwoopFrameHeader): Uint8Array {
  requireRange(header.kind, 0xff, 'kind');
  requireRange(header.headerVersion, 0xff, 'headerVersion');
  requireRange(header.reservedFlags, 0x1f, 'reservedFlags');
  requireRange(header.fragmentIndex, 0xffff, 'fragmentIndex');
  requireRange(header.fragmentCount, 0xffff, 'fragmentCount');
  requireRange(header.frameId, 0xffffffff, 'frameId');
  requireRange(header.rtpTimestamp90k, 0xffffffff, 'rtpTimestamp90k');
  requireRange(header.width, 0xffff, 'width');
  requireRange(header.height, 0xffff, 'height');
  requireRange(header.payloadBytes, 0xffffffff, 'payloadBytes');
  requireRange(header.tCaptureUs, Number.MAX_SAFE_INTEGER, 'tCaptureUs');
  requireRange(header.tEncodeUs, Number.MAX_SAFE_INTEGER, 'tEncodeUs');
  requireRange(header.tSendUs, Number.MAX_SAFE_INTEGER, 'tSendUs');

  const codecByte = CODEC_BY_BYTE.indexOf(header.codec);
  if (codecByte < 0) throw new RangeError(`swoop frame header: codec ${header.codec}`);

  const bytes = new Uint8Array(FRAME_HEADER_BYTES);
  const view = new DataView(bytes.buffer);
  view.setUint8(0, header.kind);
  view.setUint8(1, header.headerVersion);
  view.setUint8(2, codecByte);
  view.setUint8(
    3,
    (header.irap ? FRAME_FLAG_IRAP : 0) |
      (header.resolutionChanged ? FRAME_FLAG_RESOLUTION_CHANGED : 0) |
      (header.parameterSets ? FRAME_FLAG_PARAMETER_SETS_IN_BAND : 0) |
      (header.reservedFlags << 3),
  );
  view.setUint16(4, header.fragmentIndex, true);
  view.setUint16(6, header.fragmentCount, true);
  view.setUint32(8, header.frameId, true);
  view.setUint32(12, header.rtpTimestamp90k, true);
  view.setUint16(16, header.width, true);
  view.setUint16(18, header.height, true);
  view.setUint32(20, header.payloadBytes, true);
  view.setBigUint64(24, BigInt(header.tCaptureUs), true);
  view.setBigUint64(32, BigInt(header.tEncodeUs), true);
  view.setBigUint64(40, BigInt(header.tSendUs), true);
  return bytes;
}

export interface FrameSequenceState {
  /** null before the first record of a track. */
  lastFrameId: number | null;
  /** false until a recovery point has been seen. */
  haveIrap: boolean;
}

export const initialFrameSequenceState = (): FrameSequenceState => ({
  lastFrameId: null,
  haveIrap: false,
});

/**
 * the "never a chunk with a dangling reference" rule. a rejection means drop
 * everything until the next IRAP and ask for an idr on `swoop-control` — never
 * submit the gap-crossing chunk to see if it decodes.
 */
export function advanceFrameSequence(
  state: FrameSequenceState,
  header: SwoopFrameHeader,
): SwoopResult<FrameSequenceState> {
  if (header.irap) {
    return accept({ lastFrameId: header.frameId, haveIrap: true });
  }
  if (!state.haveIrap) return reject('dangling_reference', 'no recovery point yet');
  // a resolution change is always a new idr plus a decoder reconfigure;
  // chromium rejects a non-irap h.265 config change outright.
  if (header.resolutionChanged) return reject('dangling_reference', 'resolution change without irap');
  if (state.lastFrameId !== null && header.frameId !== ((state.lastFrameId + 1) >>> 0)) {
    return reject('dangling_reference', 'frameId gap');
  }
  return accept({ lastFrameId: header.frameId, haveIrap: true });
}

// ---------------------------------------------------------------------------
// section 5 — input, cursor, clipboard, control, feedback
// ---------------------------------------------------------------------------

/** the viewer's verified grant. control is enforced from the jwt, never from
 *  anything the browser says about itself. */
export interface ViewerContext {
  ctl: boolean;
}

export type InputMessage =
  | { t: 'k'; code: string; down: boolean; seq: number; tsUs?: number }
  | { t: 'm'; x: number; y: number; seq: number; tsUs?: number }
  | { t: 'mr'; dx: number; dy: number; seq: number; tsUs?: number }
  | { t: 'b'; button: number; down: boolean; seq: number; tsUs?: number }
  | { t: 'w'; dx: number; dy: number; mode: 'pixel' | 'line' | 'page'; seq: number; tsUs?: number };

const WHEEL_MODES = ['pixel', 'line', 'page'];

/** every input message is gated; a watcher's attempt is dropped and reported. */
export function decodeInputMessage(raw: unknown, viewer?: ViewerContext): SwoopResult<InputMessage> {
  const parsed = parseJsonObject(raw);
  if (!parsed.ok) return parsed;
  const o = parsed.value;
  if (viewer && !viewer.ctl) return reject('not_permitted', 'input requires ctl');

  const seq = int(o, 'seq');
  if (seq === undefined) return reject('malformed_message', 'seq');
  const tsUs = int(o, 'tsUs');
  const tail = tsUs === undefined ? { seq } : { seq, tsUs };

  switch (str(o, 't')) {
    case 'k': {
      const code = str(o, 'code');
      const down = bool(o, 'down');
      if (code === undefined || down === undefined) return reject('malformed_message', 'k');
      return accept({ t: 'k', code, down, ...tail });
    }
    case 'm': {
      const x = num(o, 'x');
      const y = num(o, 'y');
      if (x === undefined || y === undefined) return reject('malformed_message', 'm');
      return accept({ t: 'm', x, y, ...tail });
    }
    case 'mr': {
      const dx = num(o, 'dx');
      const dy = num(o, 'dy');
      if (dx === undefined || dy === undefined) return reject('malformed_message', 'mr');
      return accept({ t: 'mr', dx, dy, ...tail });
    }
    case 'b': {
      const button = int(o, 'button');
      const down = bool(o, 'down');
      if (button === undefined || down === undefined || button < 0 || button > 4) {
        return reject('malformed_message', 'b');
      }
      return accept({ t: 'b', button, down, ...tail });
    }
    case 'w': {
      const dx = num(o, 'dx');
      const dy = num(o, 'dy');
      const mode = str(o, 'mode');
      if (dx === undefined || dy === undefined || mode === undefined || !WHEEL_MODES.includes(mode)) {
        return reject('malformed_message', 'w');
      }
      return accept({ t: 'w', dx, dy, mode: mode as 'pixel' | 'line' | 'page', ...tail });
    }
    default:
      return reject('unknown_type', 'input');
  }
}

export const encodeInputMessage = (message: InputMessage): string => JSON.stringify(message);

export type CursorMessage =
  | { t: 'cpos'; x: number; y: number; visible: boolean; tsUs: number }
  | { t: 'cshape'; id: number; hotX?: number; hotY?: number; w?: number; h?: number; png?: string };

export function decodeCursorMessage(raw: unknown): SwoopResult<CursorMessage> {
  const parsed = parseJsonObject(raw);
  if (!parsed.ok) return parsed;
  const o = parsed.value;

  if (str(o, 't') === 'cpos') {
    const x = num(o, 'x');
    const y = num(o, 'y');
    const visible = bool(o, 'visible');
    const tsUs = int(o, 'tsUs');
    if (x === undefined || y === undefined || visible === undefined || tsUs === undefined) {
      return reject('malformed_message', 'cpos');
    }
    return accept({ t: 'cpos', x, y, visible, tsUs });
  }
  if (str(o, 't') === 'cshape') {
    const id = int(o, 'id');
    if (id === undefined) return reject('malformed_message', 'cshape');
    // shapes are cached by id: a repeat is `{"t":"cshape","id":n}` alone, so
    // the upload fields are all-or-nothing rather than individually optional.
    const uploadKeys = ['hotX', 'hotY', 'w', 'h', 'png'];
    const present = uploadKeys.filter((k) => k in o);
    if (present.length === 0) return accept({ t: 'cshape', id });
    if (present.length !== uploadKeys.length) return reject('malformed_message', 'cshape upload');
    const hotX = int(o, 'hotX');
    const hotY = int(o, 'hotY');
    const w = int(o, 'w');
    const h = int(o, 'h');
    const png = str(o, 'png');
    if (hotX === undefined || hotY === undefined || w === undefined || h === undefined || png === undefined) {
      return reject('malformed_message', 'cshape upload');
    }
    return accept({ t: 'cshape', id, hotX, hotY, w, h, png });
  }
  return reject('unknown_type', 'cursor');
}

export const encodeCursorMessage = (message: CursorMessage): string => JSON.stringify(message);

export interface ClipboardMessage {
  t: 'clip';
  dir: 'to-host' | 'to-viewer';
  fmt: 'text' | 'png';
  seq: number;
  chunk: number;
  chunks: number;
  totalBytes: number;
  data: string;
}

export type ControlMessage =
  | { t: 'quality'; preset: string; maxBitrateKbps: number; maxFps: number }
  | { t: 'display'; index: number }
  | { t: 'idr' }
  | { t: 'sas' }
  | { t: 'mute'; on: boolean }
  | { t: 'lease'; token: string }
  | {
      t: 'hello-host';
      codec: SwoopCodec;
      width: number;
      height: number;
      displays: { index: number; width: number; height: number; primary: boolean }[];
      streamerEpoch: number;
      protocolVersion: number;
    }
  | { t: 'sas-result'; ok: boolean }
  | { t: 'lease-ok'; expiresAt: number }
  | { t: 'ended'; reason: string };

/** `swoop-control` carries control traffic and clipboard traffic both ways. */
export type ControlChannelMessage = ControlMessage | ClipboardMessage;

/** viewer→host control types the host gates on `ctl`. quality is per viewer
 *  and allowed for watchers; display is shared state and is not. */
const CTL_GATED_CONTROL = ['display', 'sas'];

function decodeClipboard(o: JsonObject, viewer?: ViewerContext): SwoopResult<ClipboardMessage> {
  const dir = str(o, 'dir');
  const fmt = str(o, 'fmt');
  const seq = int(o, 'seq');
  const chunk = int(o, 'chunk');
  const chunks = int(o, 'chunks');
  const totalBytes = int(o, 'totalBytes');
  const data = str(o, 'data');
  if (
    (dir !== 'to-host' && dir !== 'to-viewer') ||
    (fmt !== 'text' && fmt !== 'png') ||
    seq === undefined ||
    chunk === undefined ||
    chunks === undefined ||
    totalBytes === undefined ||
    data === undefined ||
    chunks < 1 ||
    chunk < 0 ||
    chunk >= chunks ||
    totalBytes < 0
  ) {
    return reject('malformed_message', 'clip');
  }
  // host→viewer is ungated; a paste into the machine is control.
  if (dir === 'to-host' && viewer && !viewer.ctl) return reject('not_permitted', 'clipboard to-host requires ctl');
  // checked before the first chunk is buffered — a receiver that waits until
  // reassembly to notice the size has already paid for it.
  const cap = fmt === 'text' ? CLIPBOARD_MAX_TEXT_BYTES : CLIPBOARD_MAX_IMAGE_BYTES;
  if (totalBytes > cap) return reject('clipboard_too_large', fmt);
  const decoded = base64UrlDecode(data.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, ''));
  if (decoded === null) return reject('malformed_message', 'clip.data');
  if (decoded.length > CLIPBOARD_MAX_CHUNK_BYTES) return reject('clipboard_too_large', 'chunk');
  return accept({ t: 'clip', dir, fmt, seq, chunk, chunks, totalBytes, data });
}

export function decodeControlMessage(
  raw: unknown,
  viewer?: ViewerContext,
): SwoopResult<ControlChannelMessage> {
  const parsed = parseJsonObject(raw);
  if (!parsed.ok) return parsed;
  const o = parsed.value;
  const t = str(o, 't');
  if (t === undefined) return reject('malformed_message', 't');
  if (t === 'clip') return decodeClipboard(o, viewer);
  if (viewer && !viewer.ctl && CTL_GATED_CONTROL.includes(t)) {
    return reject('not_permitted', `${t} requires ctl`);
  }

  switch (t) {
    case 'quality': {
      const preset = str(o, 'preset');
      const maxBitrateKbps = int(o, 'maxBitrateKbps');
      const maxFps = int(o, 'maxFps');
      if (preset === undefined || maxBitrateKbps === undefined || maxFps === undefined) {
        return reject('malformed_message', 'quality');
      }
      return accept({ t: 'quality', preset, maxBitrateKbps, maxFps });
    }
    case 'display': {
      const index = int(o, 'index');
      if (index === undefined || index < 0) return reject('malformed_message', 'display');
      return accept({ t: 'display', index });
    }
    case 'idr':
      return accept({ t: 'idr' });
    case 'sas':
      return accept({ t: 'sas' });
    case 'mute': {
      const on = bool(o, 'on');
      if (on === undefined) return reject('malformed_message', 'mute');
      return accept({ t: 'mute', on });
    }
    case 'lease': {
      const token = str(o, 'token');
      if (token === undefined) return reject('malformed_message', 'lease');
      return accept({ t: 'lease', token });
    }
    case 'hello-host': {
      const codec = str(o, 'codec');
      const width = int(o, 'width');
      const height = int(o, 'height');
      const streamerEpoch = int(o, 'streamerEpoch');
      const protocolVersion = int(o, 'protocolVersion');
      const rawDisplays = o.displays;
      if (
        codec === undefined ||
        !CODEC_BY_BYTE.includes(codec as SwoopCodec) ||
        width === undefined ||
        height === undefined ||
        streamerEpoch === undefined ||
        protocolVersion === undefined ||
        !Array.isArray(rawDisplays)
      ) {
        return reject('malformed_message', 'hello-host');
      }
      const displays: { index: number; width: number; height: number; primary: boolean }[] = [];
      for (const entry of rawDisplays) {
        const d = asObject(entry);
        const index = d ? int(d, 'index') : undefined;
        const dw = d ? int(d, 'width') : undefined;
        const dh = d ? int(d, 'height') : undefined;
        const primary = d ? bool(d, 'primary') : undefined;
        if (index === undefined || dw === undefined || dh === undefined || primary === undefined) {
          return reject('malformed_message', 'hello-host.displays');
        }
        displays.push({ index, width: dw, height: dh, primary });
      }
      return accept({
        t: 'hello-host',
        codec: codec as SwoopCodec,
        width,
        height,
        displays,
        streamerEpoch,
        protocolVersion,
      });
    }
    case 'sas-result': {
      const ok = bool(o, 'ok');
      if (ok === undefined) return reject('malformed_message', 'sas-result');
      return accept({ t: 'sas-result', ok });
    }
    case 'lease-ok': {
      const expiresAt = int(o, 'expiresAt');
      if (expiresAt === undefined) return reject('malformed_message', 'lease-ok');
      return accept({ t: 'lease-ok', expiresAt });
    }
    case 'ended': {
      const reason = str(o, 'reason');
      if (reason === undefined) return reject('malformed_message', 'ended');
      return accept({ t: 'ended', reason });
    }
    default:
      return reject('unknown_type', 'control');
  }
}

export const encodeControlMessage = (message: ControlChannelMessage): string => JSON.stringify(message);

export type FeedbackMessage =
  | { t: 'fb'; frameId: number; tArrivalUs: number; tDecodeUs: number; tPresentUs: number; clockOffsetUs: number }
  | {
      t: 'stats';
      decodeQueue: number;
      framesDropped: number;
      jitterMs: number;
      rttMs: number;
      widthCss: number;
      heightCss: number;
    }
  | { t: 'ping'; id: number; tUs: number }
  | { t: 'pong'; id: number; tUs: number; hostUs: number };

/** `int` for every field, named so the required-set is one line per message. */
function ints(o: JsonObject, keys: readonly string[]): number[] | null {
  const out: number[] = [];
  for (const k of keys) {
    const v = int(o, k);
    if (v === undefined) return null;
    out.push(v);
  }
  return out;
}

export function decodeFeedbackMessage(raw: unknown): SwoopResult<FeedbackMessage> {
  const parsed = parseJsonObject(raw);
  if (!parsed.ok) return parsed;
  const o = parsed.value;

  switch (str(o, 't')) {
    case 'fb': {
      const v = ints(o, ['frameId', 'tArrivalUs', 'tDecodeUs', 'tPresentUs', 'clockOffsetUs']);
      if (!v) return reject('malformed_message', 'fb');
      return accept({
        t: 'fb',
        frameId: v[0],
        tArrivalUs: v[1],
        tDecodeUs: v[2],
        tPresentUs: v[3],
        clockOffsetUs: v[4],
      });
    }
    case 'stats': {
      const v = ints(o, ['decodeQueue', 'framesDropped', 'jitterMs', 'rttMs', 'widthCss', 'heightCss']);
      if (!v) return reject('malformed_message', 'stats');
      return accept({
        t: 'stats',
        decodeQueue: v[0],
        framesDropped: v[1],
        jitterMs: v[2],
        rttMs: v[3],
        widthCss: v[4],
        heightCss: v[5],
      });
    }
    case 'ping': {
      const v = ints(o, ['id', 'tUs']);
      if (!v) return reject('malformed_message', 'ping');
      return accept({ t: 'ping', id: v[0], tUs: v[1] });
    }
    case 'pong': {
      const v = ints(o, ['id', 'tUs', 'hostUs']);
      if (!v) return reject('malformed_message', 'pong');
      return accept({ t: 'pong', id: v[0], tUs: v[1], hostUs: v[2] });
    }
    default:
      return reject('unknown_type', 'feedback');
  }
}

export const encodeFeedbackMessage = (message: FeedbackMessage): string => JSON.stringify(message);

// ---------------------------------------------------------------------------
// section 6 — the stdin/stdout pipe protocol
// ---------------------------------------------------------------------------

/**
 * the pipe runs between the python service and the rust streamer, so nothing
 * in the browser reads it. it lives here because `index.json` is one oracle
 * for both implementations and a vector nobody runs is worse than no vector.
 */
export type PipeEvent =
  | { type: 'ready'; sid: string; pid: number; version: string; protocolVersion: number; codecs: string[]; displays: number }
  | { type: 'viewer_joined'; sid: string; viewer: string; ctl: boolean; codec: string }
  | { type: 'viewer_left'; sid: string; viewer: string; reason: 'bye' | 'timeout' | 'lease_expired' | 'kill' }
  | { type: 'sas_request'; sid: string; viewer: string }
  | {
      type: 'status';
      sid: string;
      viewers: number;
      controllers: number;
      indicator: string;
      bitrateKbps: number;
      fps: number;
      path: 'direct' | 'relay';
      display: number;
      uptimeS: number;
    }
  | { type: 'exiting'; sid: string; code: number; reason: 'idle' | 'kill' | 'signal_lost' | 'session_cap' | 'error' };

const VIEWER_LEFT_REASONS = ['bye', 'timeout', 'lease_expired', 'kill'];
const EXIT_REASONS = ['idle', 'kill', 'signal_lost', 'session_cap', 'error'];

export function decodePipeEvent(line: string): SwoopResult<PipeEvent> {
  const parsed = parseJsonObject(line);
  if (!parsed.ok) return parsed;
  const o = parsed.value;
  const sid = str(o, 'sid');
  if (sid === undefined) return reject('malformed_message', 'sid');

  switch (str(o, 'type')) {
    case 'ready': {
      const pid = int(o, 'pid');
      const version = str(o, 'version');
      const protocolVersion = int(o, 'protocolVersion');
      const displays = int(o, 'displays');
      const codecs = Array.isArray(o.codecs) && o.codecs.every((c) => typeof c === 'string')
        ? (o.codecs as string[])
        : undefined;
      if (pid === undefined || version === undefined || protocolVersion === undefined || displays === undefined || !codecs) {
        return reject('malformed_message', 'ready');
      }
      return accept({ type: 'ready', sid, pid, version, protocolVersion, codecs, displays });
    }
    case 'viewer_joined': {
      const viewer = str(o, 'viewer');
      const ctl = bool(o, 'ctl');
      const codec = str(o, 'codec');
      if (viewer === undefined || ctl === undefined || codec === undefined) {
        return reject('malformed_message', 'viewer_joined');
      }
      return accept({ type: 'viewer_joined', sid, viewer, ctl, codec });
    }
    case 'viewer_left': {
      const viewer = str(o, 'viewer');
      const reason = str(o, 'reason');
      if (viewer === undefined || reason === undefined || !VIEWER_LEFT_REASONS.includes(reason)) {
        return reject('malformed_message', 'viewer_left');
      }
      return accept({ type: 'viewer_left', sid, viewer, reason: reason as 'bye' | 'timeout' | 'lease_expired' | 'kill' });
    }
    case 'sas_request': {
      const viewer = str(o, 'viewer');
      if (viewer === undefined) return reject('malformed_message', 'sas_request');
      return accept({ type: 'sas_request', sid, viewer });
    }
    case 'status': {
      const v = ints(o, ['viewers', 'controllers', 'bitrateKbps', 'fps', 'display', 'uptimeS']);
      const indicator = str(o, 'indicator');
      const path = str(o, 'path');
      if (!v || indicator === undefined || (path !== 'direct' && path !== 'relay')) {
        return reject('malformed_message', 'status');
      }
      return accept({
        type: 'status',
        sid,
        viewers: v[0],
        controllers: v[1],
        indicator,
        bitrateKbps: v[2],
        fps: v[3],
        path,
        display: v[4],
        uptimeS: v[5],
      });
    }
    case 'exiting': {
      const code = int(o, 'code');
      const reason = str(o, 'reason');
      if (code === undefined || reason === undefined || !EXIT_REASONS.includes(reason)) {
        return reject('malformed_message', 'exiting');
      }
      return accept({
        type: 'exiting',
        sid,
        code,
        reason: reason as 'idle' | 'kill' | 'signal_lost' | 'session_cap' | 'error',
      });
    }
    default:
      return reject('unknown_type', 'pipe event');
  }
}

/** stdin control lines, service → streamer. line 1 is the bundle, never this. */
export type PipeControl = { type: 'kill'; sid?: string } | { type: 'sas_result'; ok: boolean };

export function decodePipeControl(line: string): SwoopResult<PipeControl> {
  const parsed = parseJsonObject(line);
  if (!parsed.ok) return parsed;
  const o = parsed.value;
  switch (str(o, 'type')) {
    case 'kill': {
      // the golden vector carries `sid`; section 6 documents the bare form.
      // both are accepted, and a sid that names another session is the
      // streamer's business, not the parser's.
      const sid = str(o, 'sid');
      return accept(sid === undefined ? { type: 'kill' } : { type: 'kill', sid });
    }
    case 'sas_result': {
      const ok = bool(o, 'ok');
      if (ok === undefined) return reject('malformed_message', 'sas_result');
      return accept({ type: 'sas_result', ok });
    }
    default:
      return reject('unknown_type', 'pipe control');
  }
}

export const encodePipeEvent = (event: PipeEvent): string => JSON.stringify(event);
export const encodePipeControl = (control: PipeControl): string => JSON.stringify(control);

// ---------------------------------------------------------------------------
// section 7 — the bundle
// ---------------------------------------------------------------------------

export interface SwoopJwtKey {
  kid: string;
  alg: 'EdDSA';
  /** base64url raw 32-byte ed25519 public key. */
  key: string;
}

export interface SwoopBundle {
  protocolVersion: number;
  agentVersion: string;
  sid: string;
  site: string;
  machine: string;
  /** the time anchor: unix seconds, the api's own clock at mint. */
  now: number;
  /** unix microseconds; section 4's timestamps are relative to this. */
  streamerEpoch: number;
  signalUrl: string;
  hostToken: string;
  jwtKeys: SwoopJwtKey[];
  sessionKey: string;
  iceServers: { urls: string[]; username?: string; credential?: string }[];
  enablement: {
    membersMayWatch: boolean;
    maxViewers: number;
    leaseSeconds: number;
    sessionCapSeconds: number;
  };
  indicator: 'banner' | 'tray' | 'none';
  ctl: boolean;
  overrides?: Record<string, unknown>;
}

/** section 6's exit codes for the bundle-shaped refusals. */
export const BUNDLE_EXIT_CODES: Readonly<Record<'bundle_invalid' | 'overrides_not_permitted' | 'version_mismatch', number>> = {
  bundle_invalid: 10,
  overrides_not_permitted: 10,
  version_mismatch: 11,
};

export interface BundleExpectations {
  protocolVersion: number;
  agentVersion: string;
  /** only a `testhooks` build may carry `overrides`; never a release build. */
  allowOverrides?: boolean;
}

const INDICATORS = ['banner', 'tray', 'none'];

/**
 * the browser never sees a bundle — the api mints one and the agent hands it
 * to the streamer over stdin. the shape check lives here so the minting side
 * and the rust core are proven against the same vectors.
 *
 * nothing in here is logged: the caller gets a reason code, never a field.
 */
export function validateBundle(raw: unknown, expect: BundleExpectations): SwoopResult<SwoopBundle> {
  let obj: JsonObject | null;
  if (typeof raw === 'string') {
    const parsed = parseJsonObject(raw);
    if (!parsed.ok) return reject('bundle_invalid', 'unparseable');
    obj = parsed.value;
  } else {
    obj = asObject(raw);
  }
  if (!obj) return reject('bundle_invalid', 'not an object');

  const protocolVersion = int(obj, 'protocolVersion');
  const agentVersion = str(obj, 'agentVersion');
  const sid = str(obj, 'sid');
  const site = str(obj, 'site');
  const machine = str(obj, 'machine');
  const now = int(obj, 'now');
  const streamerEpoch = int(obj, 'streamerEpoch');
  const signalUrl = str(obj, 'signalUrl');
  const hostToken = str(obj, 'hostToken');
  const sessionKey = str(obj, 'sessionKey');
  const indicator = str(obj, 'indicator');
  const ctl = bool(obj, 'ctl');
  const enablement = asObject(obj.enablement);

  if (
    protocolVersion === undefined ||
    agentVersion === undefined ||
    sid === undefined ||
    site === undefined ||
    machine === undefined ||
    // a bundle without `now` leaves nothing to check exp against but the
    // kiosk's wall clock, so it is refused rather than given a leeway.
    now === undefined ||
    streamerEpoch === undefined ||
    signalUrl === undefined ||
    hostToken === undefined ||
    sessionKey === undefined ||
    indicator === undefined ||
    !INDICATORS.includes(indicator) ||
    ctl === undefined ||
    !enablement
  ) {
    return reject('bundle_invalid', 'missing field');
  }

  const membersMayWatch = bool(enablement, 'membersMayWatch');
  const limits = ints(enablement, ['maxViewers', 'leaseSeconds', 'sessionCapSeconds']);
  if (membersMayWatch === undefined || !limits) return reject('bundle_invalid', 'enablement');

  const jwtKeys: SwoopJwtKey[] = [];
  if (!Array.isArray(obj.jwtKeys) || obj.jwtKeys.length === 0) return reject('bundle_invalid', 'jwtKeys');
  for (const entry of obj.jwtKeys) {
    const k = asObject(entry);
    const kid = k ? str(k, 'kid') : undefined;
    const alg = k ? str(k, 'alg') : undefined;
    const key = k ? str(k, 'key') : undefined;
    if (kid === undefined || alg !== 'EdDSA' || key === undefined) return reject('bundle_invalid', 'jwtKeys');
    jwtKeys.push({ kid, alg: 'EdDSA', key });
  }

  const iceServers: SwoopBundle['iceServers'] = [];
  if (!Array.isArray(obj.iceServers)) return reject('bundle_invalid', 'iceServers');
  for (const entry of obj.iceServers) {
    const s = asObject(entry);
    const urls = s && Array.isArray(s.urls) && s.urls.every((u) => typeof u === 'string') ? (s.urls as string[]) : undefined;
    if (!s || !urls || urls.length === 0) return reject('bundle_invalid', 'iceServers');
    const server: SwoopBundle['iceServers'][number] = { urls };
    const username = str(s, 'username');
    if (username !== undefined) server.username = username;
    const credential = str(s, 'credential');
    if (credential !== undefined) server.credential = credential;
    iceServers.push(server);
  }

  const overrides = asObject(obj.overrides);
  if ('overrides' in obj && (!overrides || !expect.allowOverrides)) {
    // without the testhooks build `overrides` is an unknown field, exit 10.
    return reject('overrides_not_permitted');
  }

  if (protocolVersion !== expect.protocolVersion || agentVersion !== expect.agentVersion) {
    return reject('version_mismatch');
  }

  const bundle: SwoopBundle = {
    protocolVersion,
    agentVersion,
    sid,
    site,
    machine,
    now,
    streamerEpoch,
    signalUrl,
    hostToken,
    jwtKeys,
    sessionKey,
    iceServers,
    enablement: {
      membersMayWatch,
      maxViewers: limits[0],
      leaseSeconds: limits[1],
      sessionCapSeconds: limits[2],
    },
    indicator: indicator as 'banner' | 'tray' | 'none',
    ctl,
  };
  if (overrides && expect.allowOverrides) bundle.overrides = overrides;
  return accept(bundle);
}

// ---------------------------------------------------------------------------
// section 8 / 11 — jwt claims and verification
// ---------------------------------------------------------------------------

export interface SwoopJwtHeader {
  alg: string;
  typ?: string;
  kid: string;
}

export interface SwoopJwtClaims {
  iss: string;
  aud: 'swoop-host' | 'swoop-signal';
  role: 'viewer' | 'host' | 'doorbell';
  site: string;
  machine: string;
  sid?: string;
  viewer?: string;
  uid?: string;
  ctl?: boolean;
  /** `<hash-func> <HEX:WITH:COLONS>`, mandatory on a viewer token. */
  fp?: string;
  iat: number;
  exp: number;
  jti: string;
}

export const SWOOP_JWT_ISSUER = 'owlette-api';

const ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;
const ROLE_AUDIENCE: Readonly<Record<string, 'swoop-host' | 'swoop-signal'>> = {
  viewer: 'swoop-host',
  host: 'swoop-signal',
  doorbell: 'swoop-signal',
};

export interface DecodedJwt {
  header: SwoopJwtHeader;
  claims: SwoopJwtClaims;
  /** the signed `header.payload` bytes. */
  signingInput: Uint8Array;
  signature: Uint8Array;
}

/**
 * structural decode only — no signature, no expiry. this is what the page uses
 * to read its own `sid`, `exp` and `ctl` out of the token the api handed it;
 * it is never a substitute for `verifySwoopJwt`.
 */
export function decodeJwt(token: string): SwoopResult<DecodedJwt> {
  const parts = token.split('.');
  if (parts.length !== 3) return reject('malformed_message', 'jwt parts');
  const headerBytes = base64UrlDecode(parts[0]);
  const claimBytes = base64UrlDecode(parts[1]);
  const signature = base64UrlDecode(parts[2]);
  if (!headerBytes || !claimBytes || !signature) return reject('malformed_message', 'jwt base64url');

  let header: JsonObject | null;
  let claims: JsonObject | null;
  try {
    header = asObject(JSON.parse(new TextDecoder().decode(headerBytes)));
    claims = asObject(JSON.parse(new TextDecoder().decode(claimBytes)));
  } catch {
    return reject('malformed_message', 'jwt json');
  }
  if (!header || !claims) return reject('malformed_message', 'jwt json');

  const alg = str(header, 'alg');
  const kid = str(header, 'kid');
  if (alg === undefined || kid === undefined) return reject('malformed_message', 'jwt header');

  const iss = str(claims, 'iss');
  const aud = str(claims, 'aud');
  const role = str(claims, 'role');
  const site = str(claims, 'site');
  const machine = str(claims, 'machine');
  const iat = int(claims, 'iat');
  const exp = int(claims, 'exp');
  const jti = str(claims, 'jti');
  if (
    iss === undefined ||
    aud === undefined ||
    role === undefined ||
    site === undefined ||
    machine === undefined ||
    iat === undefined ||
    exp === undefined ||
    jti === undefined
  ) {
    return reject('malformed_message', 'jwt claims');
  }

  const out: SwoopJwtClaims = {
    iss,
    aud: aud as 'swoop-host' | 'swoop-signal',
    role: role as 'viewer' | 'host' | 'doorbell',
    site,
    machine,
    iat,
    exp,
    jti,
  };
  const sid = str(claims, 'sid');
  if (sid !== undefined) out.sid = sid;
  const viewer = str(claims, 'viewer');
  if (viewer !== undefined) out.viewer = viewer;
  const uid = str(claims, 'uid');
  if (uid !== undefined) out.uid = uid;
  const ctl = bool(claims, 'ctl');
  if (ctl !== undefined) out.ctl = ctl;
  const fp = str(claims, 'fp');
  if (fp !== undefined) out.fp = fp;

  const typ = str(header, 'typ');
  return accept({
    header: typ === undefined ? { alg, kid } : { alg, typ, kid },
    claims: out,
    signingInput: utf8(`${parts[0]}.${parts[1]}`),
    signature,
  });
}

export interface JwtVerifyOptions {
  /** the verifier's own audience: `swoop-host` for the streamer. */
  aud: 'swoop-host' | 'swoop-signal';
  site: string;
  machine: string;
  /** the live session, or null for a doorbell token which names none. */
  sid: string | null;
  /** the bundle's time anchor, unix seconds. never the kiosk wall clock. */
  anchorNow: number;
  /** monotonic seconds elapsed since the anchor was read. */
  elapsedSeconds: number;
  keys: readonly SwoopJwtKey[];
  /** the `a=fingerprint:` of the offer this token arrived with, canonicalised. */
  offerFingerprint?: string | null;
  /** single-use `jti`, where the verifier has durable state. */
  seenJti?: Set<string>;
}

/**
 * section 11's verification order, exactly: kid → signature → iss/aud/role →
 * exp → fp → site/machine/sid → jti. `kid` necessarily precedes the signature
 * because the key cannot be selected otherwise.
 */
export async function verifySwoopJwt(
  token: string,
  options: JwtVerifyOptions,
): Promise<SwoopResult<SwoopJwtClaims>> {
  const decoded = decodeJwt(token);
  if (!decoded.ok) return decoded;
  const { header, claims, signingInput, signature } = decoded.value;

  // 1. kid — select the key. never fall back to "try every key".
  const key = options.keys.find((k) => k.kid === header.kid);
  if (!key) return reject('unknown_kid', header.kid);

  // 2. signature. alg is pinned to EdDSA; `none` included.
  if (header.alg !== 'EdDSA' || key.alg !== 'EdDSA') return reject('alg_not_permitted', header.alg);
  const raw = base64UrlDecode(key.key);
  if (!raw || raw.length !== 32) return reject('unknown_kid', header.kid);
  let verified = false;
  try {
    const publicKey = await crypto.subtle.importKey('raw', raw as BufferSource, { name: 'Ed25519' }, false, ['verify']);
    verified = await crypto.subtle.verify(
      { name: 'Ed25519' },
      publicKey,
      signature as BufferSource,
      signingInput as BufferSource,
    );
  } catch {
    return reject('bad_signature', 'verify failed');
  }
  if (!verified) return reject('bad_signature');

  // 3. iss / aud / role.
  if (claims.iss !== SWOOP_JWT_ISSUER) return reject('iss_mismatch');
  const expectedAud = ROLE_AUDIENCE[claims.role];
  if (expectedAud === undefined) return reject('role_mismatch', claims.role);
  if (claims.aud !== options.aud || claims.aud !== expectedAud) return reject('aud_mismatch');

  // 4. exp, against the anchor plus monotonic elapsed.
  const nowS = options.anchorNow + options.elapsedSeconds;
  if (claims.exp <= nowS) return reject('expired');
  const maxLifetime = claims.role === 'viewer' ? VIEWER_TOKEN_MAX_LIFETIME_S : HOST_TOKEN_MAX_LIFETIME_S;
  if (claims.exp - claims.iat > maxLifetime) return reject('lifetime_too_long');

  // 5. fp. mandatory on a viewer token; host and doorbell tokens carry none.
  if (claims.role === 'viewer') {
    if (claims.fp === undefined) return reject('fp_missing');
    const canonical = canonicalizeFingerprint(claims.fp);
    if (canonical === null) return reject('fp_missing', 'not canonical');
    if (options.offerFingerprint) {
      const offer = canonicalizeFingerprint(options.offerFingerprint);
      if (offer === null || !constantTimeEqual(utf8(canonical), utf8(offer))) return reject('fp_mismatch');
    }
  }

  // 6. site / machine / sid — a token for another machine is refused even if
  // the room or url says otherwise.
  if (!ID_PATTERN.test(claims.site) || !ID_PATTERN.test(claims.machine)) return reject('malformed_message', 'id shape');
  if (claims.site !== options.site) return reject('site_mismatch');
  if (claims.machine !== options.machine) return reject('machine_mismatch');
  if (claims.role === 'doorbell') {
    if (claims.sid !== undefined) return reject('sid_mismatch', 'doorbell names no session');
  } else if (claims.sid === undefined || claims.sid !== options.sid) {
    return reject('sid_mismatch');
  }

  // 7. jti — single use where the verifier has durable state.
  if (options.seenJti) {
    if (options.seenJti.has(claims.jti)) return reject('jti_replayed');
    options.seenJti.add(claims.jti);
  }

  return accept(claims);
}

// ---------------------------------------------------------------------------
// section 9 — the host fingerprint mac
// ---------------------------------------------------------------------------

const FINGERPRINT_PATTERN = /^[A-Za-z0-9-]+ [0-9A-Fa-f]{2}(:[0-9A-Fa-f]{2})+$/;

/**
 * `<hash-func> <HEX:WITH:COLONS>` — hash token lowercase, hex uppercase,
 * exactly as an sdp `a=fingerprint:` attribute value. returns null when the
 * input is not a fingerprint at all.
 */
export function canonicalizeFingerprint(value: string): string | null {
  const trimmed = value.trim();
  const match = FINGERPRINT_PATTERN.exec(trimmed);
  if (!match) return null;
  const [hash, hex] = trimmed.split(/\s+/);
  return `${hash.toLowerCase()} ${hex.toUpperCase()}`;
}

/** pull `a=fingerprint:` out of an sdp — the fallback where
 *  `RTCCertificate.getFingerprints()` is unavailable. */
export function extractSdpFingerprint(sdp: string): string | null {
  for (const line of sdp.split(/\r\n|\n/)) {
    if (line.startsWith('a=fingerprint:')) {
      return canonicalizeFingerprint(line.slice('a=fingerprint:'.length));
    }
  }
  return null;
}

async function hkdfSha256(ikm: Uint8Array, salt: string, info: string, length = 32): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey('raw', ikm as BufferSource, 'HKDF', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits(
    { name: 'HKDF', hash: 'SHA-256', salt: utf8(salt) as BufferSource, info: utf8(info) as BufferSource },
    key,
    length * 8,
  );
  return new Uint8Array(bits);
}

/** `k = HKDF-SHA256(K_session, "owlette-swoop/viewer/v1", viewerId, 32)`. */
export function deriveViewerKey(sessionKey: Uint8Array, viewerId: string): Promise<Uint8Array> {
  return hkdfSha256(sessionKey, HKDF_VIEWER_SALT, viewerId);
}

/**
 * the mac input, laid out byte for byte. the `0x00` separators are why
 * `sid="ab", viewerId="c"` cannot collide with `sid="a", viewerId="bc"`.
 */
export function hostFingerprintMacInput(sid: string, viewerId: string, hostFingerprint: string): Uint8Array {
  const zero = new Uint8Array([0]);
  return concatBytes([
    utf8(HOST_FP_MAC_LABEL),
    zero,
    utf8(sid),
    zero,
    utf8(viewerId),
    zero,
    utf8(hostFingerprint),
  ]);
}

export async function computeHostFingerprintMac(
  viewerKey: Uint8Array,
  sid: string,
  viewerId: string,
  hostFingerprint: string,
): Promise<Uint8Array> {
  const canonical = canonicalizeFingerprint(hostFingerprint);
  if (canonical === null) throw new RangeError('swoop host mac: fingerprint is not canonical');
  const key = await crypto.subtle.importKey(
    'raw',
    viewerKey as BufferSource,
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const mac = await crypto.subtle.sign('HMAC', key, hostFingerprintMacInput(sid, viewerId, canonical) as BufferSource);
  return new Uint8Array(mac);
}

/**
 * the browser recomputes and compares in constant time before accepting the
 * answer. a mismatch or an absent mac aborts — it never proceeds and warns.
 */
export async function verifyHostFingerprintMac(
  viewerKey: Uint8Array,
  sid: string,
  viewerId: string,
  hostFingerprint: string,
  macBase64Url: string,
): Promise<boolean> {
  const presented = base64UrlDecode(macBase64Url);
  if (!presented) return false;
  const expected = await computeHostFingerprintMac(viewerKey, sid, viewerId, hostFingerprint);
  return constantTimeEqual(expected, presented);
}
