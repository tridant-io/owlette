/**
 * a fake machine for swoop's media path: the signal room and the host
 * streamer, stood in for so the viewer page reaches a picture without a
 * windows host.
 *
 * the room is the viewer page's own websocket, routed (`page.routeWebSocket`)
 * at the unreachable `SWOOP_SIGNAL_URL` the e2e server writes into every
 * grant. it does for a viewer what `infra/swoop-signal`'s room does: verifies
 * the token on the second subprotocol, says `hello`, stamps and fans frames
 * out, drops an offer while no host is in the room, and replays the joins to a
 * host that arrives later.
 *
 * the host is a real `RTCPeerConnection` in a page of its own context, sending
 * a canvas track, driven from here the way `agent/swoop` drives its peer. it
 * starts for a sid when the machine's queued `swoop_session_requested` lands
 * (the emulator's only notification: the ring has no worker to reach), admits
 * viewers of that sid, sends `host-ready`, answers an offer with PROTOCOL.md
 * section 9's mac over its own dtls fingerprint, verifies the viewer jwt that
 * `swoop-control` carries in section 11's order with `fp` against the offer,
 * and on a queued `swoop_kill` says `bye` with reason `kill` and stops.
 *
 * the picture is 640x360 unless a spec passes `start` another `size`. above
 * that the sender may spend 8 Mbps and keeps its resolution, so chrome's
 * encoder never shrinks the frame a spec measures (`waitForFrameSize`). `detail` adds a
 * static band of 1-px stripes and 10 px text in the lower-left quarter, clear
 * of the moving block, the centre and `presentedPicture`'s sample point, so a
 * screenshot shows what a filter does to thin strokes.
 *
 * what it is not: capture, the encoder's tuning, audio, the rate governor or
 * `swoop-meta` records, and its pointer is whatever a spec has it send on
 * `swoop-cursor` (`cursor`), its roster only what a spec has it publish
 * (`roster`). input it keeps rather than injects: every
 * `swoop-input` message a viewer sends lands in `inputs`. the picture is h.264 because the real
 * host's is, and because playwright's bundled chrome encodes and decodes it
 * headless (spike 2.12 section 8b); never hevc, which headless cannot decode.
 */

import crypto from 'crypto';
import { expect, type Browser, type BrowserContext, type Page, type WebSocketRoute } from '@playwright/test';
import { getAdminDb } from './emulator';

/** the e2e server's `SWOOP_SIGNAL_URL`: nothing answers there, so every room is this file's. */
export const E2E_SWOOP_SIGNAL_URL = 'https://swoop-signal.e2e.invalid';
export const E2E_SWOOP_KID = 'e2e-swoop-kid';
export const E2E_SWOOP_MASTER_KEY = 'e2e-swoop-session-master-key-for-playwright-only';

/** the colour the host paints, so a spec can tell its picture from a black frame. */
export const HOST_COLOUR: readonly [number, number, number] = [32, 160, 96];

const SUBPROTOCOL = 'owlette.swoop.v1';
const PROTOCOL_VERSION = 1;
const LEASE_MS = 5 * 60 * 1000;

/** the size of the picture the fake host paints and sends. */
interface FrameSize {
  width: number;
  height: number;
}

const DEFAULT_SIZE: FrameSize = { width: 640, height: 360 };

/**
 * an ed25519 pair for the e2e server's swoop tokens: raw 32-byte halves,
 * base64url, the shape the bundle carries. generated once per run in the
 * runner and inherited by the workers through the environment, so the fake
 * host verifies the tokens the server signs. nothing is committed.
 */
export function swoopE2eKeys(): { priv: string; pub: string } {
  const { E2E_SWOOP_JWT_PRIVATE_KEY: priv, E2E_SWOOP_JWT_PUBLIC_KEY: pub } = process.env;
  if (priv && pub) return { priv, pub };
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
  const keys = {
    priv: privateKey.export({ format: 'der', type: 'pkcs8' }).subarray(16).toString('base64url'),
    pub: publicKey.export({ format: 'der', type: 'spki' }).subarray(12).toString('base64url'),
  };
  process.env.E2E_SWOOP_JWT_PRIVATE_KEY = keys.priv;
  process.env.E2E_SWOOP_JWT_PUBLIC_KEY = keys.pub;
  return keys;
}

interface ViewerClaims {
  iss: string;
  aud: string;
  role: string;
  site: string;
  machine: string;
  sid: string;
  viewer: string;
  uid: string;
  ctl: boolean;
  fp: string;
  exp: number;
}

type Verdict = { ok: true; claims: ViewerClaims } | { ok: false; reason: string };

/** what a verifier is checking the token against: `fp` and `sid` only where it knows them. */
interface Expected {
  site: string;
  machine: string;
  sid?: string;
  viewer?: string;
  fp?: string;
}

/** section 11's order: kid, signature, iss/aud/role, exp, fp, site/machine/sid. */
function verifyViewerToken(token: string, expected: Expected): Verdict {
  const [header, payload, signature] = token.split('.');
  if (!header || !payload || !signature) return { ok: false, reason: 'malformed' };
  const head = JSON.parse(Buffer.from(header, 'base64url').toString('utf8')) as { alg?: string; kid?: string };
  if (head.kid !== E2E_SWOOP_KID) return { ok: false, reason: 'unknown_kid' };
  if (head.alg !== 'EdDSA') return { ok: false, reason: 'alg' };
  const key = crypto.createPublicKey({ key: { kty: 'OKP', crv: 'Ed25519', x: swoopE2eKeys().pub }, format: 'jwk' });
  const signed = Buffer.from(`${header}.${payload}`, 'utf8');
  if (!crypto.verify(null, signed, key, Buffer.from(signature, 'base64url'))) return { ok: false, reason: 'signature' };
  const claims = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as ViewerClaims;
  if (claims.iss !== 'owlette-api') return { ok: false, reason: 'iss_mismatch' };
  if (claims.aud !== 'swoop-host') return { ok: false, reason: 'aud_mismatch' };
  if (claims.role !== 'viewer') return { ok: false, reason: 'role_not_permitted' };
  if (!(claims.exp * 1000 > Date.now())) return { ok: false, reason: 'expired' };
  if (!claims.fp) return { ok: false, reason: 'fp_missing' };
  if (expected.fp !== undefined && claims.fp.toUpperCase() !== expected.fp.toUpperCase()) {
    return { ok: false, reason: 'fp_mismatch' };
  }
  if (claims.site !== expected.site || claims.machine !== expected.machine) return { ok: false, reason: 'room_mismatch' };
  if (expected.sid !== undefined && claims.sid !== expected.sid) return { ok: false, reason: 'sid_mismatch' };
  if (expected.viewer !== undefined && claims.viewer !== expected.viewer) return { ok: false, reason: 'viewer_mismatch' };
  return { ok: true, claims };
}

/** the sdp's `a=fingerprint:` value, canonical: hash token lowercase, hex uppercase. */
function sdpFingerprint(sdp: string): string | null {
  const match = /^a=fingerprint:(\S+) (\S+)\s*$/m.exec(sdp);
  return match ? `${match[1].toLowerCase()} ${match[2].toUpperCase()}` : null;
}

/** PROTOCOL.md section 9, with `k` derived from the master key as section 11 lays out. */
function hostFingerprintMac(sid: string, viewerId: string, hostFingerprint: string): string {
  const hkdf = (ikm: Buffer, salt: string, info: string) =>
    Buffer.from(crypto.hkdfSync('sha256', ikm, Buffer.from(salt), Buffer.from(info), 32));
  const session = hkdf(Buffer.from(E2E_SWOOP_MASTER_KEY), 'owlette-swoop/session/v1', sid);
  const k = hkdf(session, 'owlette-swoop/viewer/v1', viewerId);
  const input = Buffer.concat(
    ['owlette-swoop/host-fp/v1', sid, viewerId, hostFingerprint].flatMap((part, i) =>
      i === 0 ? [Buffer.from(part)] : [Buffer.from([0]), Buffer.from(part)],
    ),
  );
  return crypto.createHmac('sha256', k).update(input).digest('base64url');
}

/** one viewer socket in the room, as its verified token names it. */
interface RoomSocket {
  ws: WebSocketRoute;
  id: string;
  sid: string;
  ctl: boolean;
}

/** what the host verified off a viewer's `lease` frame. */
export interface VerifiedLease {
  viewer: string;
  sid: string;
  uid: string;
  ctl: boolean;
}

type HostOut =
  | { kind: 'lease'; viewer: string; token: string }
  | { kind: 'input'; viewer: string; message: string }
  | { kind: 'refused'; viewer: string; reason: string };

/** one `swoop-input` message as the host received it (PROTOCOL.md section 5). */
export type ReceivedInput = { t: string; seq: number } & Record<string, unknown>;

interface HostPageApi {
  answer(viewer: string, sdp: string): Promise<string>;
  candidate(viewer: string, candidate: RTCIceCandidateInit): Promise<void>;
  control(viewer: string, message: string): void;
  cursor(viewer: string, message: string): void;
  close(): void;
  codecs(): Promise<string[]>;
}

interface HostWindow {
  swoopHost: HostPageApi;
}

/**
 * the host page's half, run in that page: a canvas of `size` painted in
 * `HOST_COLOUR` with a block moving across its top, so the encoder always has a
 * fresh frame, the detail band under it when asked for, and one sendonly peer
 * per viewer. the answer goes out with its candidates in it once gathering
 * ends, as the real host's does, so nothing trickles behind it.
 */
function installHostPage([colour, out, { width, height }, detail]: [readonly number[], string, FrameSize, boolean]): void {
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  document.body.append(canvas);
  const paint = canvas.getContext('2d')!;
  let band: HTMLCanvasElement | null = null;
  if (detail) {
    // drawn once at whole pixels, so each stripe is one pixel of the source.
    band = document.createElement('canvas');
    band.width = Math.round(width * 0.34);
    band.height = Math.round(height * 0.4);
    const ink = band.getContext('2d')!;
    ink.fillStyle = '#ffffff';
    ink.fillRect(0, 0, band.width, band.height);
    ink.fillStyle = '#000000';
    const lines = [
      'the quick brown fox jumps over the lazy dog',
      'il1| o0 rn m 0123456789',
      'pack my box with five dozen liquor jugs',
    ];
    const stripes = band.height - lines.length * 12 - 8;
    const half = Math.floor(band.width / 2);
    for (let x = 0; x < half; x += 2) ink.fillRect(x, 0, 1, stripes);
    for (let y = 0; y < stripes; y += 2) ink.fillRect(half, y, band.width - half, 1);
    ink.font = '10px sans-serif';
    ink.textBaseline = 'top';
    lines.forEach((line, i) => ink.fillText(line, 2, stripes + 4 + i * 12));
  }
  let tick = 0;
  setInterval(() => {
    paint.fillStyle = `rgb(${colour.join(',')})`;
    paint.fillRect(0, 0, width, height);
    if (band) paint.drawImage(band, Math.round(width / 16), Math.round(height * 0.55));
    // the 640x360 block and step, scaled with the picture.
    paint.fillStyle = '#ffffff';
    paint.fillRect((((tick++ * 8) % 600) * width) / 640, (10 * height) / 360, (40 * width) / 640, (40 * height) / 360);
  }, 33);
  const track = canvas.captureStream(30).getVideoTracks()[0];
  const peers = new Map<string, RTCPeerConnection>();
  const controls = new Map<string, RTCDataChannel>();
  const cursors = new Map<string, RTCDataChannel>();
  const send = (window as unknown as Record<string, (message: unknown) => void>)[out];

  const api: HostPageApi = {
    async answer(viewer, sdp) {
      peers.get(viewer)?.close();
      const pc = new RTCPeerConnection();
      peers.set(viewer, pc);
      pc.ondatachannel = ({ channel }) => {
        if (channel.protocol !== 'owlette.swoop.v1') {
          send({ kind: 'refused', viewer, reason: `channel_protocol ${channel.label}` });
          return;
        }
        if (channel.label === 'swoop-cursor') cursors.set(viewer, channel);
        if (channel.label === 'swoop-input') {
          channel.onmessage = ({ data }) => send({ kind: 'input', viewer, message: String(data) });
          return;
        }
        if (channel.label !== 'swoop-control') return;
        controls.set(viewer, channel);
        channel.onmessage = ({ data }) => {
          const message = JSON.parse(String(data)) as { t?: string; token?: string };
          if (message.t === 'lease' && message.token) send({ kind: 'lease', viewer, token: message.token });
        };
      };
      await pc.setRemoteDescription({ type: 'offer', sdp });
      const video = pc.getTransceivers().find((t) => t.receiver.track.kind === 'video');
      if (!video) throw new Error('the offer has no video m-line');
      video.direction = 'sendonly';
      await video.sender.replaceTrack(track);
      const h264 = RTCRtpSender.getCapabilities('video')!.codecs.filter((c) => /^video\/(h264|rtx)$/i.test(c.mimeType));
      video.setCodecPreferences(h264);
      const gathered = new Promise<void>((resolve) => {
        pc.onicegatheringstatechange = () => {
          if (pc.iceGatheringState === 'complete') resolve();
        };
      });
      await pc.setLocalDescription(await pc.createAnswer());
      // chrome sends in the offer's codec order whatever its own answer lists,
      // so the encoding is pointed at h.264 the way the real host picks it.
      const parameters = video.sender.getParameters();
      const sendable = parameters.codecs.find(
        (c) => c.mimeType.toLowerCase() === 'video/h264' && /packetization-mode=1/.test(c.sdpFmtpLine ?? ''),
      );
      if (!sendable) throw new Error('the offer has no h.264 this browser can send');
      // `codec` on an encoding is newer than typescript's dom lib.
      (parameters.encodings[0] as RTCRtpEncodingParameters & { codec?: RTCRtpCodec }).codec = sendable;
      // chrome's encoder starts low and scales a big picture down to fit its
      // bitrate; a spec measuring the frame needs it at the size it asked for.
      if (width * height > 640 * 360) {
        parameters.encodings[0].maxBitrate = 8_000_000;
        parameters.degradationPreference = 'maintain-resolution';
      }
      await video.sender.setParameters(parameters);
      if (pc.iceGatheringState !== 'complete') await gathered;
      return pc.localDescription!.sdp;
    },
    async candidate(viewer, candidate) {
      await peers.get(viewer)?.addIceCandidate(candidate);
    },
    control(viewer, message) {
      const channel = controls.get(viewer);
      if (channel?.readyState === 'open') channel.send(message);
    },
    cursor(viewer, message) {
      const channel = cursors.get(viewer);
      if (channel?.readyState === 'open') channel.send(message);
    },
    close() {
      for (const pc of peers.values()) pc.close();
      peers.clear();
      controls.clear();
      cursors.clear();
    },
    async codecs() {
      const seen: string[] = [];
      for (const pc of peers.values()) {
        const report = await pc.getStats();
        report.forEach((stat: { type?: string; kind?: string; codecId?: string; framesEncoded?: number }) => {
          if (stat.type !== 'outbound-rtp' || stat.kind !== 'video' || !stat.codecId || !stat.framesEncoded) return;
          const codec = report.get(stat.codecId) as { mimeType?: string } | undefined;
          if (codec?.mimeType) seen.push(codec.mimeType);
        });
      }
      return seen;
    },
  };
  (window as unknown as HostWindow).swoopHost = api;
}

export class FakeSwoopHost {
  /** every refusal and fault on the room or the host; a clean session leaves it empty. */
  readonly problems: string[] = [];
  /** the viewer tokens the host verified on `swoop-control`. */
  readonly leases: VerifiedLease[] = [];
  /** every `swoop-input` message, in arrival order; the channel is unordered, so sort by `seq`. */
  readonly inputs: ReceivedInput[] = [];

  private readonly sockets = new Set<RoomSocket>();
  /** the session the host is streaming, once its command landed; null when none is. */
  private hostSid: string | null = null;
  private readonly admitted = new Set<string>();
  /** each viewer's last offer and its answer: the host answers every copy of an offer. */
  private readonly answers = new Map<string, { offer: string; fingerprint: string; answer: Record<string, unknown> }>();
  private readonly handledCommands = new Set<string>();
  /** host work in arrival order: an offer's answer before the candidates behind it. */
  private queue: Promise<void> = Promise.resolve();
  private unsubscribe: () => void = () => {};

  private constructor(
    private readonly siteId: string,
    private readonly machineId: string,
    private readonly context: BrowserContext,
    private readonly hostPage: Page,
  ) {}

  /** a host for one machine, streaming at `size` (640x360 if none), and its room on the viewer page's socket. */
  static async start(args: {
    browser: Browser;
    viewer: Page;
    siteId: string;
    machineId: string;
    size?: FrameSize;
    detail?: boolean;
  }): Promise<FakeSwoopHost> {
    const context = await args.browser.newContext();
    const hostPage = await context.newPage();
    const host = new FakeSwoopHost(args.siteId, args.machineId, context, hostPage);
    await hostPage.exposeFunction('swoopHostOut', (message: HostOut) => host.fromHostPage(message));
    const setup: Parameters<typeof installHostPage>[0] = [HOST_COLOUR, 'swoopHostOut', args.size ?? DEFAULT_SIZE, !!args.detail];
    await hostPage.evaluate(installHostPage, setup);

    await host.addViewer(args.viewer);

    const commands = getAdminDb().doc(`sites/${args.siteId}/machines/${args.machineId}/commands/pending`);
    host.unsubscribe = commands.onSnapshot(
      (snap) => host.onCommands(snap.data() ?? {}),
      (err) => host.problems.push(`commands: ${err.message}`),
    );
    return host;
  }

  /** another viewer page into the same room: every viewer of the machine shares its one host. */
  async addViewer(viewer: Page): Promise<void> {
    const room = `${E2E_SWOOP_SIGNAL_URL.replace(/^https/, 'wss')}/v1/room/`;
    await viewer.routeWebSocket((url) => url.href.startsWith(room), (ws) => this.join(ws));
  }

  /**
   * the roster on `swoop-control` to each viewer whose lease it checked for the
   * session it serves, each named by its token's uid as the streamer names it.
   * a lease checked for an earlier sid is not in the room: a streamer knows its
   * own viewers alone, and after a kill the next one starts with none.
   */
  async roster(): Promise<void> {
    const seated = this.leases.filter((lease) => lease.sid === this.hostSid);
    const lines = new Map(seated.map(({ viewer, uid, ctl }) => [viewer, { id: viewer, name: uid, ctl }]));
    const message = JSON.stringify({ t: 'roster', viewers: [...lines.values()], tsUs: Date.now() * 1000 });
    for (const viewer of lines.keys()) {
      await this.hostPage.evaluate(([v, m]) => (window as unknown as HostWindow).swoopHost.control(v, m), [viewer, message] as const);
    }
  }

  /** a `swoop-cursor` message to one viewer; dropped while its channel is not open, as on the wire. */
  async cursor(viewer: string, message: string): Promise<void> {
    await this.hostPage.evaluate(
      ([v, m]) => (window as unknown as HostWindow).swoopHost.cursor(v, m),
      [viewer, message] as const,
    );
  }

  /** the video codecs the host is encoding, by mime type. */
  async sentCodecs(): Promise<string[]> {
    return this.hostPage.evaluate(() => (window as unknown as HostWindow).swoopHost.codecs());
  }

  async stop(): Promise<void> {
    this.unsubscribe();
    await this.context.close();
  }

  private enqueue(work: () => Promise<void> | void): void {
    this.queue = this.queue.then(work).catch((err: unknown) => {
      this.problems.push(`fault: ${err instanceof Error ? err.message : String(err)}`);
    });
  }

  // ---------------------------------------------------------------- room ---

  private join(ws: WebSocketRoute): void {
    const prefix = 'jwt.';
    const protocols = ws.protocols();
    const token = protocols.find((p) => p.startsWith(prefix))?.slice(prefix.length);
    const [site, machine] = new URL(ws.url()).pathname.split('/').slice(3).map(decodeURIComponent);
    const verdict =
      protocols.includes(SUBPROTOCOL) && token
        ? verifyViewerToken(token, { site, machine })
        : ({ ok: false, reason: 'subprotocol' } as const);
    if (!verdict.ok || site !== this.siteId || machine !== this.machineId) {
      this.problems.push(`room refused a viewer: ${verdict.ok ? 'another machine' : verdict.reason}`);
      void ws.close({ code: 4401, reason: 'auth' });
      return;
    }
    const socket: RoomSocket = { ws, id: verdict.claims.viewer, sid: verdict.claims.sid, ctl: verdict.claims.ctl };
    this.sockets.add(socket);
    ws.send(
      JSON.stringify({
        type: 'hello',
        protocolVersion: PROTOCOL_VERSION,
        role: 'viewer',
        id: socket.id,
        sid: socket.sid,
        ctl: socket.ctl,
        peers: { doorbell: 0, host: this.hostSid ? 1 : 0, viewer: this.sockets.size },
        serverTimeMs: Date.now(),
      }),
    );
    ws.onMessage((raw) => this.fromViewer(socket, String(raw)));
    ws.onClose(() => this.sockets.delete(socket));
    if (this.hostSid) this.enqueue(() => this.onViewerJoin(socket));
  }

  private fromViewer(socket: RoomSocket, raw: string): void {
    // the runtime's auto-response, which never wakes the room.
    if (raw === 'ping') {
      socket.ws.send('pong');
      return;
    }
    const message = JSON.parse(raw) as { type?: string; sdp?: string } & RTCIceCandidateInit;
    if (message.type === 'offer' || message.type === 'candidate' || message.type === 'bye') {
      // an offer into a room with no host is dropped; `host-ready` asks for it again.
      if (!this.hostSid) return;
      if (message.type === 'offer') this.enqueue(() => this.onOffer(socket.id, message.sdp ?? ''));
      if (message.type === 'candidate') {
        const { candidate, sdpMid, sdpMLineIndex } = message;
        const init: RTCIceCandidateInit = { candidate, sdpMid, sdpMLineIndex };
        this.enqueue(() =>
          this.hostPage.evaluate(([v, c]) => (window as unknown as HostWindow).swoopHost.candidate(v, c), [socket.id, init] as const),
        );
      }
      return;
    }
    this.problems.push(`room refused a ${message.type ?? 'typeless'} frame from a viewer`);
    socket.ws.send(JSON.stringify({ type: 'error', code: 'wrong_role', serverTimeMs: Date.now() }));
  }

  /** a host frame through the room: to one viewer, or to all of them. */
  private toViewers(message: Record<string, unknown>): void {
    const frame = JSON.stringify({ ...message, from: 'host', fromRole: 'host', serverTimeMs: Date.now() });
    for (const socket of this.sockets) {
      if (message.to === undefined || message.to === socket.id) socket.ws.send(frame);
    }
  }

  // ---------------------------------------------------------------- host ---

  private onCommands(pending: Record<string, unknown>): void {
    for (const [id, value] of Object.entries(pending)) {
      if (this.handledCommands.has(id)) continue;
      this.handledCommands.add(id);
      const command = value as { type?: string; sid?: string };
      if (command.type === 'swoop_session_requested' && command.sid) {
        const sid = command.sid;
        this.enqueue(() => this.startSession(sid));
      } else if (command.type === 'swoop_kill') {
        const sid = command.sid;
        this.enqueue(() => this.kill(sid));
      }
    }
  }

  /**
   * the streamer for `sid` dials in, and the room replays the joins it missed.
   * a request for the sid it is already serving is a viewer joining it, which
   * the agent answers with nothing at all.
   */
  private async startSession(sid: string): Promise<void> {
    if (sid === this.hostSid) return;
    if (this.hostSid) await this.endSession('restart');
    this.hostSid = sid;
    for (const socket of this.sockets) this.onViewerJoin(socket);
  }

  private onViewerJoin(socket: RoomSocket): void {
    if (socket.sid !== this.hostSid) {
      this.problems.push(`host refused viewer ${socket.id}: room_mismatch`);
      return;
    }
    if (this.admitted.has(socket.id)) return;
    this.admitted.add(socket.id);
    this.toViewers({ type: 'host-ready', sid: this.hostSid, to: socket.id });
  }

  private async onOffer(viewer: string, sdp: string): Promise<void> {
    if (!this.admitted.has(viewer)) {
      this.problems.push(`host refused an offer from ${viewer}: unknown_viewer`);
      return;
    }
    const fingerprint = sdpFingerprint(sdp);
    if (!fingerprint) {
      this.problems.push(`host refused an offer from ${viewer}: offer_fingerprint_missing`);
      this.toViewers({ type: 'bye', to: viewer, reason: 'offer_fingerprint_missing' });
      return;
    }
    const cached = this.answers.get(viewer);
    if (cached?.offer === sdp) {
      this.toViewers(cached.answer);
      return;
    }
    const answerSdp = await this.hostPage.evaluate(
      ([v, s]) => (window as unknown as HostWindow).swoopHost.answer(v, s),
      [viewer, sdp] as const,
    );
    const hostFingerprint = sdpFingerprint(answerSdp);
    if (!hostFingerprint) throw new Error('the host answer has no fingerprint');
    const answer = {
      type: 'answer',
      to: viewer,
      sdp: answerSdp,
      mac: hostFingerprintMac(this.hostSid!, viewer, hostFingerprint),
    };
    this.answers.set(viewer, { offer: sdp, fingerprint, answer });
    this.toViewers(answer);
  }

  private fromHostPage(message: HostOut): void {
    if (message.kind === 'refused') {
      this.problems.push(`host refused viewer ${message.viewer}: ${message.reason}`);
      return;
    }
    if (message.kind === 'input') {
      this.inputs.push(JSON.parse(message.message) as ReceivedInput);
      return;
    }
    const verdict = verifyViewerToken(message.token, {
      site: this.siteId,
      machine: this.machineId,
      sid: this.hostSid ?? undefined,
      viewer: message.viewer,
      fp: this.answers.get(message.viewer)?.fingerprint,
    });
    if (!verdict.ok) {
      this.problems.push(`host refused the lease of ${message.viewer}: ${verdict.reason}`);
      this.toViewers({ type: 'bye', to: message.viewer, reason: verdict.reason });
      return;
    }
    const { viewer, sid, uid, ctl } = verdict.claims;
    this.leases.push({ viewer, sid, uid, ctl });
    const ok = JSON.stringify({ t: 'lease-ok', expiresAt: Date.now() + LEASE_MS });
    this.enqueue(() =>
      this.hostPage.evaluate(([v, m]) => (window as unknown as HostWindow).swoopHost.control(v, m), [viewer, ok] as const),
    );
  }

  /**
   * a service kill: every viewer is told `kill`, a decision the page does not
   * retry. one naming another session is ignored, as the streamer ignores it.
   */
  private async kill(sid: string | undefined): Promise<void> {
    if (this.hostSid && (!sid || sid === this.hostSid)) await this.endSession('kill');
  }

  /** a service going away to come back: its viewers are told `restart`, and may ask again. */
  async restart(): Promise<void> {
    await this.endSession('restart');
  }

  private async endSession(reason: string): Promise<void> {
    for (const viewer of this.admitted) this.toViewers({ type: 'bye', to: viewer, reason });
    await this.hostPage.evaluate(() => (window as unknown as HostWindow).swoopHost.close());
    this.admitted.clear();
    this.answers.clear();
    this.hostSid = null;
  }
}

/** what the viewer page's `<video>` is presenting: its state, size, frame count and a pixel off the moving block. */
export async function presentedPicture(page: Page): Promise<{
  playing: boolean;
  width: number;
  height: number;
  frames: number;
  pixel: [number, number, number];
}> {
  return page.locator('video[aria-label="remote screen"]').evaluate((node) => {
    const video = node as HTMLVideoElement;
    const canvas = document.createElement('canvas');
    canvas.width = video.videoWidth || 1;
    canvas.height = video.videoHeight || 1;
    const paint = canvas.getContext('2d')!;
    paint.drawImage(video, 0, 0);
    const [r, g, b] = paint.getImageData(Math.floor(canvas.width / 2), Math.floor((canvas.height * 3) / 4), 1, 1).data;
    return {
      playing: !video.paused && video.readyState >= 2,
      width: video.videoWidth,
      height: video.videoHeight,
      frames: video.getVideoPlaybackQuality().totalVideoFrames,
      pixel: [r, g, b] as [number, number, number],
    };
  });
}

/** waits until the viewer page's `<video>` decodes the host's picture at `width`x`height`. */
export async function waitForFrameSize(page: Page, width: number, height: number): Promise<void> {
  await expect
    .poll(
      async () => {
        const { width: shownWidth, height: shownHeight } = await presentedPicture(page);
        return `${shownWidth}x${shownHeight}`;
      },
      { timeout: 30_000 },
    )
    .toBe(`${width}x${height}`);
}
