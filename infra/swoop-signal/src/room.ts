// one durable object per machine: the signaling room.
//
// every socket is accepted through the websocket hibernation api
// (ctx.acceptWebSocket), so an idle room holds no isolate and incurs no duration
// charge. THERE MUST BE NO ALARM, NO TIMER AND NO HELD OUTBOUND FETCH IN THIS
// CLASS: any one of them makes the object non-hibernatable, which turns the GB-s
// line from $0 into roughly $41,500/month at 10,000 rooms (spike 0.4 section 5.3).
// `answers a bare ping without waking the room` in test/signal.test.ts is the
// regression guard for exactly that.

import {
  type AuthSignal,
  CLOSE_CODES,
  classifyFrame,
  fansToAgentSide,
  isRole,
  LIMITS,
  SUBPROTOCOL,
  SWOOP_PROTOCOL_VERSION,
  type Role,
} from './messages';

interface Identity {
  role: Role;
  id: string;
  sid: string | null;
  ctl: boolean;
  jti: string;
  /** the token's own expiry, so an admitted socket cannot outlive it forever. */
  expMs: number;
  joinedAtMs: number;
  /** per-connection flood window, carried in the attachment so no timer is needed. */
  rateStartMs: number;
  /** the window's two budgets: small `candidate` frames, and everything else. */
  trickleCount: number;
  controlCount: number;
  /** so a window that is dropping trickle says `rate_limited` once, not 600 times. */
  trickleWarned?: boolean;
  /** the last frame this socket sent; keepalive pings are answered by the runtime and stamped separately. */
  lastSeenMs?: number;
  /** set when the peer said bye or was evicted, so webSocketClose does not announce it twice. */
  departed?: boolean;
}

/** the one knob the test worker turns down, so a stale viewer is a second old rather than a minute. */
export interface RoomEnv {
  SWOOP_VIEWER_STALE_MS?: string;
}

const JTI_PREFIX = 'jti:';
const RING_WINDOW_KEY = 'ring:window';

export class SignalRoom implements DurableObject {
  private readonly ctx: DurableObjectState;
  private readonly viewerStaleMs: number;

  constructor(ctx: DurableObjectState, env: RoomEnv = {}) {
    this.ctx = ctx;
    this.viewerStaleMs = Number(env.SWOOP_VIEWER_STALE_MS) || LIMITS.viewerStaleMs;
    // answered by the runtime without waking this handler, and therefore free. a
    // browser cannot send a websocket protocol ping from javascript; the agent's
    // doorbell uses protocol pings instead and never an application heartbeat.
    this.ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair('ping', 'pong'));
  }

  async fetch(request: Request): Promise<Response> {
    const path = new URL(request.url).pathname;
    if (path === '/join') return this.join(request);
    if (path === '/ring') return this.ring(request);
    if (path === '/kill') return this.kill(request);
    return new Response('not found', { status: 404 });
  }

  private socketsByRole(role: Role): WebSocket[] {
    return this.ctx.getWebSockets(`role:${role}`);
  }

  private peerCounts() {
    return {
      doorbell: this.socketsByRole('doorbell').length,
      host: this.socketsByRole('host').length,
      viewer: this.admittedViewers().length,
    };
  }

  /** the viewers that count toward the cap: admitted, and neither departed nor evicted. */
  private admittedViewers(): Array<[WebSocket, Identity]> {
    const admitted: Array<[WebSocket, Identity]> = [];
    for (const socket of this.socketsByRole('viewer')) {
      const self = socket.deserializeAttachment() as Identity | null;
      if (self && !self.departed) admitted.push([socket, self]);
    }
    return admitted;
  }

  /** when the room last heard from a viewer: its join, its last frame, or its last answered keepalive. */
  private lastSeenMs(socket: WebSocket, self: Identity): number {
    const pinged = this.ctx.getWebSocketAutoResponseTimestamp(socket)?.getTime() ?? 0;
    return Math.max(self.joinedAtMs, self.lastSeenMs ?? 0, pinged);
  }

  /**
   * a viewer that stopped pinging is gone, whatever the socket says: its slot is
   * freed and the host is told, exactly as if the peer had dropped. the socket's
   * own close may never complete — that is why the flag, not the close, is what
   * takes it out of the count.
   */
  private evictStaleViewers(nowMs: number): void {
    for (const [socket, self] of this.admittedViewers()) {
      if (nowMs - this.lastSeenMs(socket, self) < this.viewerStaleMs) continue;
      socket.serializeAttachment({ ...self, departed: true });
      this.toAgentSide(
        JSON.stringify({ type: 'bye', from: self.id, fromRole: 'viewer', reason: 'stale', serverTimeMs: nowMs })
      );
      socket.close(1000, 'stale');
    }
  }

  private static refuse(code: string, status: number, reason: string): Response {
    return Response.json({ type: 'error', reason, code }, { status, headers: { 'x-swoop-error': code } });
  }

  // jti single use, PROTOCOL.md section 11: belt-and-braces, enforced here because
  // this is the only verifier with durable state. entries expire with the token, so
  // the pass below keeps the keyspace bounded without an alarm.
  private async claimJti(jti: string, expMs: number, nowMs: number): Promise<boolean> {
    const seen = await this.ctx.storage.list<number>({ prefix: JTI_PREFIX });
    const stale: string[] = [];
    for (const [key, expiresAtMs] of seen) {
      if (expiresAtMs <= nowMs) stale.push(key);
    }
    if (stale.length > 0) await this.ctx.storage.delete(stale);

    const key = `${JTI_PREFIX}${jti}`;
    if (seen.has(key) && !stale.includes(key)) return false;
    await this.ctx.storage.put(key, expMs);
    return true;
  }

  private async join(request: Request): Promise<Response> {
    const role = request.headers.get('x-swoop-role');
    const id = request.headers.get('x-swoop-id');
    const jti = request.headers.get('x-swoop-jti');
    const expMs = Number(request.headers.get('x-swoop-exp-ms'));
    if (!isRole(role) || !id || !jti || !Number.isFinite(expMs)) return SignalRoom.refuse('bad_join', 400, 'protocol');

    const nowMs = Date.now();
    if (role === 'viewer' && this.admittedViewers().length >= LIMITS.viewersPerRoom) {
      // full of the living, or full of the dead: only the first is a refusal.
      this.evictStaleViewers(nowMs);
      if (this.admittedViewers().length >= LIMITS.viewersPerRoom) {
        return SignalRoom.refuse('room_full', 429, 'room');
      }
    }
    // a replayed jti is an auth failure the caller can fix: a fresh token carries a
    // fresh jti, so it gets the generic signal and re-mints rather than backing off.
    if (!(await this.claimJti(jti, expMs, nowMs))) return SignalRoom.refuse('auth', 401, 'auth');

    const identity: Identity = {
      role,
      id,
      sid: request.headers.get('x-swoop-sid') || null,
      ctl: request.headers.get('x-swoop-ctl') === '1',
      jti,
      expMs,
      joinedAtMs: nowMs,
      rateStartMs: nowMs,
      trickleCount: 0,
      controlCount: 0,
    };
    if (JSON.stringify(identity).length > LIMITS.attachmentBytes) {
      return SignalRoom.refuse('attachment_too_large', 400, 'protocol');
    }

    const pair = new WebSocketPair();
    const [client, server] = [pair[0], pair[1]];
    // the tags are how a hibernated room finds a socket again without any state of
    // its own: role: for fan-out, id: for a `to`-addressed reply.
    this.ctx.acceptWebSocket(server, [`role:${role}`, `id:${id}`]);
    server.serializeAttachment(identity);

    server.send(
      JSON.stringify({
        type: 'hello',
        protocolVersion: SWOOP_PROTOCOL_VERSION,
        role: identity.role,
        id: identity.id,
        sid: identity.sid,
        ctl: identity.ctl,
        peers: this.peerCounts(),
        serverTimeMs: Date.now(),
      })
    );

    if (role === 'viewer') {
      this.toAgentSide(
        JSON.stringify({
          type: 'viewer-join',
          viewer: identity.id,
          sid: identity.sid,
          ctl: identity.ctl,
          serverTimeMs: Date.now(),
        })
      );
    } else if (role === 'host') {
      // a host is spawned by the ring, so every viewer waiting for it announced
      // itself before this socket existed and that `viewer-join` is gone. the
      // host would then refuse their offers as `unknown_viewer` -- replay the
      // joins it missed, to this socket alone so a second host cannot see them
      // twice. same shape as the live announcement; the host needs no new type.
      for (const waiting of this.socketsByRole('viewer')) {
        const viewer = waiting.deserializeAttachment() as Identity | null;
        if (!viewer || viewer.departed) continue;
        server.send(
          JSON.stringify({
            type: 'viewer-join',
            viewer: viewer.id,
            sid: viewer.sid,
            ctl: viewer.ctl,
            serverTimeMs: Date.now(),
          })
        );
      }
    }

    const headers: Record<string, string> = {};
    if (request.headers.get('x-swoop-subprotocol') === SUBPROTOCOL) headers['Sec-WebSocket-Protocol'] = SUBPROTOCOL;
    return new Response(null, { status: 101, webSocket: client, headers });
  }

  private async ring(request: Request): Promise<Response> {
    const body = (await request.json()) as { sid: string; sentAtMs: number };

    // a ring to a machine whose doorbell is not attached is refused, not absorbed:
    // a silent no-op would let the api believe the agent was notified. the check is
    // first because it needs no storage, so ringing an offline machine cannot burn
    // the cap of the machine that comes back online.
    const doorbells = this.socketsByRole('doorbell');
    if (doorbells.length === 0) {
      return Response.json({ ok: false, code: 'no_doorbell', delivered: 0 }, { status: 409 });
    }

    // the window is persisted so the ceiling survives eviction; rings are rare by
    // design, and the read path of an idle room still touches no storage at all.
    const nowMs = Date.now();
    const stored = (await this.ctx.storage.get<number[]>(RING_WINDOW_KEY)) ?? [];
    const window = stored.filter((at) => nowMs - at < LIMITS.ringWindowMs);
    if (window.length >= LIMITS.ringsPerWindow) {
      return Response.json(
        {
          ok: false,
          code: 'ring_capped',
          delivered: 0,
          cap: LIMITS.ringsPerWindow,
          windowMs: LIMITS.ringWindowMs,
          retryAfterMs: LIMITS.ringWindowMs - (nowMs - window[0]),
        },
        { status: 429 }
      );
    }
    window.push(nowMs);
    await this.ctx.storage.put(RING_WINDOW_KEY, window);

    const payload = JSON.stringify({
      type: 'ring',
      sid: body.sid,
      sentAtMs: body.sentAtMs,
      serverTimeMs: nowMs,
    });
    for (const socket of doorbells) socket.send(payload);

    return Response.json({
      ok: true,
      delivered: doorbells.length,
      cap: LIMITS.ringsPerWindow,
      windowMs: LIMITS.ringWindowMs,
      remaining: LIMITS.ringsPerWindow - window.length,
    });
  }

  private async kill(request: Request): Promise<Response> {
    const body = (await request.json()) as { sid: string | null };
    const payload = JSON.stringify({ type: 'kill', sid: body.sid, serverTimeMs: Date.now() });
    const sockets = this.ctx.getWebSockets();
    for (const socket of sockets) {
      // a killed viewer's close may never complete either; the flag frees the slot now.
      const self = socket.deserializeAttachment() as Identity | null;
      if (self?.role === 'viewer') socket.serializeAttachment({ ...self, departed: true });
      socket.send(payload);
      socket.close(1000, 'kill');
    }
    return Response.json({ ok: true, closed: sockets.length });
  }

  private sendError(socket: WebSocket, code: string): void {
    socket.send(JSON.stringify({ type: 'error', code, serverTimeMs: Date.now() }));
  }

  // the mid-socket half of the auth signal: an error frame carrying one of the
  // three auth words, then close 4401. a client that reads either one re-mints and
  // redials at once instead of walking its backoff ladder.
  private closeForAuth(socket: WebSocket, code: AuthSignal): void {
    this.sendError(socket, code);
    socket.close(CLOSE_CODES.auth, code);
  }

  webSocketMessage(socket: WebSocket, message: string | ArrayBuffer): void {
    const self = socket.deserializeAttachment() as Identity | null;
    if (!self) return this.closeForAuth(socket, 'auth');

    const nowMs = Date.now();
    // a token authorises the upgrade, and it does not stop mattering once the socket
    // is open: PROTOCOL.md section 11 rests a session's security on fp + exp, and an
    // unbounded socket bought with a 60 s token would retire exp entirely. the check
    // is lazy — only a socket that SENDS is tested — so an idle doorbell is never
    // kicked and the fleet never re-dials on a timer. no clock skew here: the skew at
    // join tolerates the api's minting clock, but by now the worker is measuring
    // elapsed time against its own.
    if (self.expMs <= nowMs) return this.closeForAuth(socket, 'token_expired');

    // what a frame is decides what it costs, so the frame is read before it is
    // charged. a burst of `candidate` is the whole point of trickle ice and its
    // size belongs to the machine's interface count; a burst of anything else is
    // not, so the two get separate budgets over the one window.
    const frame = classifyFrame(message, self.role);
    if (nowMs - self.rateStartMs >= LIMITS.messageWindowMs) {
      self.rateStartMs = nowMs;
      self.trickleCount = 0;
      self.controlCount = 0;
      self.trickleWarned = false;
    }
    const trickle = frame.ok && frame.trickle;
    if (trickle) self.trickleCount += 1;
    else self.controlCount += 1;
    const dropping = trickle && self.trickleCount > LIMITS.trickleFramesPerWindow;
    const warn = dropping && !self.trickleWarned;
    if (warn) self.trickleWarned = true;
    self.lastSeenMs = nowMs;
    socket.serializeAttachment(self);

    if (self.controlCount > LIMITS.controlFramesPerWindow) {
      this.sendError(socket, 'rate_limited');
      return socket.close(CLOSE_CODES.flood, 'rate limited');
    }
    if (dropping) {
      // over the trickle budget the frame goes, not the socket: ice survives a
      // lost candidate and the session does not survive a lost host. the peer is
      // told once per window, so saying so cannot itself become the flood.
      if (warn) this.sendError(socket, 'rate_limited');
      return;
    }
    if (!frame.ok) return this.sendError(socket, frame.refusal);

    const msg = frame.msg;
    const to = typeof msg.to === 'string' ? msg.to : undefined;
    const forwarded = JSON.stringify({ ...msg, from: self.id, fromRole: self.role, serverTimeMs: nowMs });

    if (msg.type === 'bye') {
      this.fanOut(self.role, forwarded, to);
      // a viewer's bye is its own departure, so its socket goes with it. a host's
      // is "this viewer is done" — PROTOCOL.md section 2 gives `bye` a `to` for
      // exactly that — and closing the host on one ends every other viewer's
      // session with it.
      if (self.role === 'viewer') {
        socket.serializeAttachment({ ...self, departed: true });
        socket.close(1000, 'bye');
      }
      return;
    }
    this.fanOut(self.role, forwarded, to);
  }

  private toAgentSide(payload: string): void {
    // the host, and only the host. the doorbell is a notification socket that
    // speaks `ring` and `error`: an sdp offer sent to it is over its frame
    // limit, and it drops the socket the next ring has to arrive on.
    for (const socket of this.socketsByRole('host')) socket.send(payload);
  }

  private fanOut(role: Role, payload: string, to: string | undefined): void {
    if (fansToAgentSide(role)) return this.toAgentSide(payload);
    const targets = to === undefined ? this.socketsByRole('viewer') : this.ctx.getWebSockets(`id:${to}`);
    for (const socket of targets) socket.send(payload);
  }

  webSocketClose(socket: WebSocket, code: number, _reason: string, wasClean: boolean): void {
    const self = socket.deserializeAttachment() as Identity | null;
    // a viewer that vanishes without a bye still has to free the host's slot.
    if (self && self.role === 'viewer' && !self.departed) {
      this.toAgentSide(
        JSON.stringify({
          type: 'bye',
          from: self.id,
          fromRole: 'viewer',
          reason: wasClean ? 'closed' : 'dropped',
          code,
          serverTimeMs: Date.now(),
        })
      );
    }
  }

  webSocketError(socket: WebSocket): void {
    socket.close(1011, 'socket error');
  }
}
