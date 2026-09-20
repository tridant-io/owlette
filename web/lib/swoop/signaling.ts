/**
 * the viewer's signaling socket to the swoop worker.
 *
 * one job: keep a websocket to the room url the api handed us open, decode
 * every frame through `protocol.ts` and hand it up. it owns no peer connection,
 * no media and no react state — `peer.ts` and the page do. it does not build
 * the url either: that shape belongs to the deployment, not to the bundle.
 *
 * three things here are not obvious:
 *
 * 1. **the token rides as a second subprotocol, never a query parameter.** a
 *    browser cannot set handshake headers, and a url is logged by every hop in
 *    between. the worker strips it before the room ever sees it.
 * 2. **a viewer token lives 60 s, so one is minted per dial, never reused.**
 *    the worker checks `exp` lazily, on any frame a socket SENDS, and answers
 *    an expired one with `token_expired` + close 4401. so a socket that has sat
 *    idle past its token's expiry is still open but no longer able to speak:
 *    `send()` re-dials with a fresh token first rather than discovering that
 *    with an ice restart's offer. this is what PROTOCOL.md section 10's lease
 *    renewal exists for on the peer side.
 * 3. **the browser cannot read a refused handshake.** `x-swoop-error` and the
 *    401 body reach a `fetch`, not a `WebSocket` — a refused upgrade surfaces
 *    as close 1006 with nothing in it. the three auth words are therefore only
 *    actionable mid-socket (error frame, then close 4401); a 1006 gets the
 *    backoff ladder, and since every dial mints anyway, a stale token can never
 *    be the thing the ladder is waiting out.
 */

import {
  MAX_SIGNALING_BYTES,
  SWOOP_SUBPROTOCOL,
  checkProtocolVersion,
  checkSendRights,
  decodeJwt,
  decodeSignalingMessage,
  encodeSignalingMessage,
  type SignalHello,
  type SignalingMessage,
} from './protocol';

/** PROTOCOL.md section 1: `jwt.<token>` beside the version subprotocol. */
const TOKEN_SUBPROTOCOL_PREFIX = 'jwt.';

/** the worker's close code for "this socket's token stopped being acceptable". */
export const CLOSE_AUTH = 4401;

/** the worker's close code for a flood limit. */
export const CLOSE_FLOOD = 4008;

/** the auth-signal vocabulary, and it is exactly three words. */
const AUTH_SIGNALS: ReadonlySet<string> = new Set(['auth', 'token_expired', 'unknown_kid']);

const BACKOFF_BASE_MS = 500;
const BACKOFF_MAX_MS = 15000;
const BACKOFF_MAX_ATTEMPTS = 8;

/** how early a token counts as spent. the worker compares against its own clock. */
const TOKEN_SKEW_MS = 2000;

/** a bare `ping` the runtime auto-answers without waking the room. */
const KEEPALIVE_MS = 25000;

/** frames held while a dial is in flight. an offer plus a burst of trickle. */
const MAX_QUEUED = 32;

export type SwoopSignalStatus = 'idle' | 'connecting' | 'open' | 'reconnecting' | 'closed';

/**
 * a refusal no reconnect can fix. the page surfaces it; this module stops.
 */
export type SwoopSignalFatal =
  | 'version_mismatch'
  | 'mint_failed'
  | 'exhausted';

/** the browser's `WebSocket`, narrowed to what this module uses. */
export interface SwoopSocket {
  readyState: number;
  send(data: string): void;
  close(code?: number, reason?: string): void;
  onopen: ((event: unknown) => void) | null;
  onclose: ((event: { code: number; reason?: string }) => void) | null;
  onerror: ((event: unknown) => void) | null;
  onmessage: ((event: { data: unknown }) => void) | null;
}

export type SwoopSocketFactory = (url: string, protocols: string[]) => SwoopSocket;

export interface SwoopSignalingOptions {
  /**
   * the full room url to dial, `wss://…/v1/room/{site}/{machine}`, exactly as
   * the session-create route returned it. it is used as given: the server is
   * the only party that knows its own deployment, so a path prefix or a moved
   * room route must not need a browser release. `/api/agent/swoop/doorbell-token`
   * already hands the agent a full url, and two meanings of `signalUrl` would
   * be worse than either.
   */
  roomUrl: string;
  /** mints a fresh viewer jwt. called once per dial — never cached here. */
  mintToken: () => Promise<string>;
  onMessage: (message: SignalingMessage) => void;
  onStatus?: (status: SwoopSignalStatus) => void;
  onFatal?: (code: SwoopSignalFatal) => void;
  /** a frame the decoder refused. never carries the frame itself. */
  onRejected?: (reason: string) => void;
  socketFactory?: SwoopSocketFactory;
  now?: () => number;
}

const OPEN = 1;

function defaultSocketFactory(url: string, protocols: string[]): SwoopSocket {
  return new WebSocket(url, protocols) as unknown as SwoopSocket;
}

/**
 * `https://host` → `wss://host/v1/room/site/machine`. the shape the api builds,
 * kept here because it documents the route and is what the server-side tests
 * assert against. **this module does not call it** — it dials what it is given.
 */
export function roomUrl(base: string, siteId: string, machineId: string): string {
  const origin = base.replace(/\/+$/, '').replace(/^http/, 'ws');
  return `${origin}/v1/room/${encodeURIComponent(siteId)}/${encodeURIComponent(machineId)}`;
}

/**
 * a room url is validated, never trusted. `ws:` is the specific failure worth
 * naming: `SWOOP_SIGNAL_URL` pointed at a local wrangler yields one, and the
 * viewer token would then cross the wire in plaintext. the python doorbell
 * refuses the same thing.
 */
function assertRoomUrl(value: string): string {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new RangeError('swoop signaling: room url does not parse');
  }
  if (parsed.protocol !== 'wss:') {
    throw new RangeError(`swoop signaling: room url must be wss:, got ${parsed.protocol}`);
  }
  return value;
}

export class SwoopSignaling {
  private readonly options: SwoopSignalingOptions;
  private readonly url: string;
  private readonly socketFactory: SwoopSocketFactory;
  private readonly now: () => number;

  private socket: SwoopSocket | null = null;
  private status: SwoopSignalStatus = 'idle';
  private hello: SignalHello | null = null;
  private tokenExpiresAtMs = 0;
  private attempt = 0;
  private authRetried = false;
  private stopped = false;
  private dialing: Promise<void> | null = null;
  private queued: string[] = [];
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private keepaliveTimer: ReturnType<typeof setInterval> | null = null;

  constructor(options: SwoopSignalingOptions) {
    this.options = options;
    this.url = assertRoomUrl(options.roomUrl);
    this.socketFactory = options.socketFactory ?? defaultSocketFactory;
    this.now = options.now ?? (() => Date.now());
  }

  /** the room's `hello`, once it has been accepted. `id` is our viewer id. */
  get identity(): SignalHello | null {
    return this.hello;
  }

  get connectionStatus(): SwoopSignalStatus {
    return this.status;
  }

  /** when the token this socket was dialled with stops being acceptable. */
  get tokenExpiry(): number {
    return this.tokenExpiresAtMs;
  }

  connect(): Promise<void> {
    this.stopped = false;
    return this.dial();
  }

  /**
   * send one viewer frame. a frame the viewer may not send is a caller bug and
   * throws; a socket whose token is spent is re-dialled first, because the
   * worker would answer it with `token_expired` and close.
   */
  send(message: SignalingMessage): void {
    const rights = checkSendRights('viewer', message.type);
    if (!rights.ok) throw new RangeError(`swoop signaling: viewer may not send ${message.type}`);

    const frame = encodeSignalingMessage(message);
    if (frame.length > MAX_SIGNALING_BYTES) {
      throw new RangeError(`swoop signaling: ${message.type} exceeds ${MAX_SIGNALING_BYTES} bytes`);
    }

    if (this.socket && this.status === 'open' && !this.tokenSpent()) {
      this.socket.send(frame);
      return;
    }
    this.enqueue(frame);
    if (this.stopped) return;
    if (this.status === 'open') {
      // the socket is fine, the token is not. a re-dial mints a new one.
      void this.redial();
      return;
    }
    if (this.status === 'idle' || this.status === 'closed') void this.dial();
  }

  /**
   * re-dial now with a fresh token. `peer.ts` calls this before an ice restart
   * or any renegotiation: the offer that follows is a send, and a send on an
   * expired token costs the socket.
   */
  async refresh(): Promise<void> {
    if (this.stopped) return;
    if (!this.tokenSpent() && this.status === 'open') return;
    await this.redial();
  }

  close(code = 1000, reason = 'bye'): void {
    this.stopped = true;
    this.clearRetry();
    this.stopKeepalive();
    this.queued = [];
    const socket = this.socket;
    this.socket = null;
    if (socket) {
      this.detach(socket);
      try {
        socket.close(code, reason);
      } catch {
        // already gone; nothing to unwind.
      }
    }
    this.setStatus('closed');
  }

  private tokenSpent(): boolean {
    return this.tokenExpiresAtMs !== 0 && this.now() >= this.tokenExpiresAtMs - TOKEN_SKEW_MS;
  }

  private enqueue(frame: string): void {
    if (this.queued.length >= MAX_QUEUED) this.queued.shift();
    this.queued.push(frame);
  }

  private setStatus(status: SwoopSignalStatus): void {
    if (this.status === status) return;
    this.status = status;
    this.options.onStatus?.(status);
  }

  private clearRetry(): void {
    if (this.retryTimer !== null) {
      clearTimeout(this.retryTimer);
      this.retryTimer = null;
    }
  }

  private stopKeepalive(): void {
    if (this.keepaliveTimer !== null) {
      clearInterval(this.keepaliveTimer);
      this.keepaliveTimer = null;
    }
  }

  private detach(socket: SwoopSocket): void {
    socket.onopen = null;
    socket.onclose = null;
    socket.onerror = null;
    socket.onmessage = null;
  }

  private async redial(): Promise<void> {
    const socket = this.socket;
    this.socket = null;
    this.stopKeepalive();
    if (socket) {
      this.detach(socket);
      try {
        socket.close(1000, 'token refresh');
      } catch {
        // already gone.
      }
    }
    await this.dial();
  }

  private dial(): Promise<void> {
    if (this.dialing) return this.dialing;
    const run = this.openSocket().finally(() => {
      this.dialing = null;
    });
    this.dialing = run;
    return run;
  }

  private async openSocket(): Promise<void> {
    if (this.stopped) return;
    this.clearRetry();
    this.setStatus(this.attempt === 0 ? 'connecting' : 'reconnecting');

    let token: string;
    try {
      token = await this.options.mintToken();
    } catch {
      // the api refused to mint. a retry ladder against an authorisation
      // decision is a mint storm, not resilience.
      this.stopped = true;
      this.setStatus('closed');
      this.options.onFatal?.('mint_failed');
      return;
    }
    if (this.stopped) return;

    const decoded = decodeJwt(token);
    this.tokenExpiresAtMs = decoded.ok ? decoded.value.claims.exp * 1000 : 0;

    const socket = this.socketFactory(this.url, [SWOOP_SUBPROTOCOL, `${TOKEN_SUBPROTOCOL_PREFIX}${token}`]);
    this.socket = socket;

    socket.onopen = () => {
      if (this.socket !== socket) return;
      this.attempt = 0;
      this.setStatus('open');
      this.startKeepalive(socket);
      this.flush(socket);
    };
    socket.onmessage = (event) => {
      if (this.socket === socket) this.receive(event.data);
    };
    socket.onerror = () => {
      // close always follows; the ladder lives there so it runs exactly once.
    };
    socket.onclose = (event) => {
      if (this.socket !== socket) return;
      this.socket = null;
      this.stopKeepalive();
      this.onClosed(event.code);
    };
  }

  private startKeepalive(socket: SwoopSocket): void {
    this.stopKeepalive();
    // the runtime answers this without waking the durable object, so it costs
    // nothing and does not touch the room's rate window or the expiry check.
    this.keepaliveTimer = setInterval(() => {
      if (this.socket === socket && socket.readyState === OPEN) socket.send('ping');
    }, KEEPALIVE_MS);
  }

  private flush(socket: SwoopSocket): void {
    const pending = this.queued;
    this.queued = [];
    for (const frame of pending) socket.send(frame);
  }

  private receive(data: unknown): void {
    if (data === 'pong') return;
    const decoded = decodeSignalingMessage(data);
    if (!decoded.ok) {
      this.options.onRejected?.(decoded.reason);
      return;
    }
    const message = decoded.value;

    if (message.type === 'hello') {
      const version = checkProtocolVersion(message);
      if (!version.ok) {
        // never negotiated, never downgraded: say bye and stop.
        this.stopped = true;
        this.socket?.send(encodeSignalingMessage({ type: 'bye', reason: 'version_mismatch' }));
        this.close(1000, 'version_mismatch');
        this.options.onFatal?.('version_mismatch');
        return;
      }
      this.hello = message;
      this.authRetried = false;
    }

    if (message.type === 'error' && AUTH_SIGNALS.has(message.code)) {
      // close 4401 follows this frame; the redial happens there, once.
      this.options.onMessage(message);
      return;
    }

    this.options.onMessage(message);
  }

  private onClosed(code: number): void {
    if (this.stopped) {
      this.setStatus('closed');
      return;
    }
    // 1000 is the room saying it is done with us — a kill, or our own bye.
    if (code === 1000) {
      this.stopped = true;
      this.setStatus('closed');
      return;
    }
    if (code === CLOSE_AUTH && !this.authRetried) {
      // one free re-mint and an immediate redial: a kid rotation must not cost
      // a full backoff ladder. a second 4401 in a row joins the ladder.
      this.authRetried = true;
      this.setStatus('reconnecting');
      void this.dial();
      return;
    }
    this.scheduleRetry();
  }

  private scheduleRetry(): void {
    this.attempt += 1;
    if (this.attempt > BACKOFF_MAX_ATTEMPTS) {
      this.stopped = true;
      this.setStatus('closed');
      this.options.onFatal?.('exhausted');
      return;
    }
    this.setStatus('reconnecting');
    const ceiling = Math.min(BACKOFF_BASE_MS * 2 ** (this.attempt - 1), BACKOFF_MAX_MS);
    // full jitter: a fleet that reconnects together must not re-dial together.
    const delay = Math.round(ceiling * (0.5 + Math.random() * 0.5));
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      void this.dial();
    }, delay);
  }
}

export function createSwoopSignaling(options: SwoopSignalingOptions): SwoopSignaling {
  return new SwoopSignaling(options);
}
