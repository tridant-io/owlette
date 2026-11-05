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
  /** set when the peer said bye, was evicted or was killed: its close may never complete, and the flag takes it out of the count. */
  departed?: boolean;
}

/** the one knob the test worker turns down, so a stale viewer is a second old rather than a minute. */
export interface RoomEnv {
  SWOOP_VIEWER_STALE_MS?: string;
}

const JTI_PREFIX = 'jti:';
const RING_WINDOW_KEY = 'ring:window';
/** `announced:<viewer id>` -> the sid whose host has been told that viewer joined. */
const ANNOUNCED_PREFIX = 'announced:';
/** `offered:<viewer id>` -> the sid whose host has had an offer from that viewer, and so may hold its peer. */
const OFFERED_PREFIX = 'offered:';
/** what the room remembers of a viewer on the agent side: pruned together and forgotten together. */
const VIEWER_NOTES = [ANNOUNCED_PREFIX, OFFERED_PREFIX] as const;

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
   * freed, and the host is told on the same rule as a close. the socket's own close
   * may never complete — that is why the flag, not the close, is what takes it out
   * of the count.
   */
  private async evictStaleViewers(nowMs: number): Promise<void> {
    const gone: string[] = [];
    for (const [socket, self] of this.admittedViewers()) {
      if (nowMs - this.lastSeenMs(socket, self) < this.viewerStaleMs) continue;
      socket.serializeAttachment({ ...self, departed: true });
      socket.close(1000, 'stale');
      if (!(await this.hostShouldHearOf(self))) continue;
      this.toAgentSide(
        JSON.stringify({ type: 'bye', from: self.id, fromRole: 'viewer', reason: 'stale', serverTimeMs: nowMs })
      );
      gone.push(self.id);
    }
    await this.forget(gone);
  }

  /**
   * whether the host is to hear that this socket's viewer left. not while another
   * live socket carries its id, and not once one of its offers reached its host:
   * that host watches the peer itself, and a re-dial or a blip is no departure. a
   * viewer that never offered has no peer to lose, and its next join is announced
   * afresh; unsaid, a 4.0.1 host keeps that admission for good.
   */
  private async hostShouldHearOf(self: Identity): Promise<boolean> {
    return !this.hasLiveTwin(self) && !(await this.noted(OFFERED_PREFIX, self));
  }

  /** whether another live socket carries this viewer's id. by jti: a woken room hands out new socket objects. */
  private hasLiveTwin(self: Identity): boolean {
    return this.ctx.getWebSockets(`id:${self.id}`).some((socket) => {
      const other = socket.deserializeAttachment() as Identity | null;
      return other !== null && other.jti !== self.jti && !other.departed;
    });
  }

  /** whether a host of this session is in the room: the one whose view of a viewer the notes follow. */
  private hostOf(sid: string): boolean {
    return this.socketsByRole('host').some((host) => (host.deserializeAttachment() as Identity | null)?.sid === sid);
  }

  /**
   * whether this viewer's note names its own session. `announced` is the one a
   * re-dial reads: it is not a join, and a 4.0.1 host takes a repeated `viewer-join`
   * for a new viewer, wiping the fingerprint it bound and counting the viewer twice
   * against its admission cap (agent/swoop/src/signal/client.rs, `on_viewer_join`).
   */
  private async noted(prefix: string, viewer: Identity): Promise<boolean> {
    return (await this.ctx.storage.get<string>(`${prefix}${viewer.id}`)) === viewer.sid;
  }

  /** note these viewers under `prefix` for `sid`; any other session's notes go, which keeps the keyspace one session wide. */
  private async note(prefix: string, viewerIds: string[], sid: string): Promise<void> {
    if (viewerIds.length === 0) return;
    const stale: string[] = [];
    for (const kind of VIEWER_NOTES) {
      for (const [key, notedSid] of await this.ctx.storage.list<string>({ prefix: kind })) {
        if (notedSid !== sid) stale.push(key);
      }
    }
    if (stale.length > 0) await this.ctx.storage.delete(stale);
    await this.ctx.storage.put(Object.fromEntries(viewerIds.map((id) => [`${prefix}${id}`, sid])));
  }

  /** the host no longer holds these viewers, so a later join of theirs is news to it again. */
  private async forget(viewerIds: string[]): Promise<void> {
    if (viewerIds.length === 0) return;
    await this.ctx.storage.delete(viewerIds.flatMap((id) => VIEWER_NOTES.map((kind) => `${kind}${id}`)));
  }

  /** a live `viewer-join` to the agent side, noted once a host of the viewer's own session has had it. */
  private async announce(viewer: Identity): Promise<void> {
    this.toAgentSide(
      JSON.stringify({
        type: 'viewer-join',
        viewer: viewer.id,
        sid: viewer.sid,
        ctl: viewer.ctl,
        serverTimeMs: Date.now(),
      })
    );
    if (viewer.sid !== null && this.hostOf(viewer.sid)) await this.note(ANNOUNCED_PREFIX, [viewer.id], viewer.sid);
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
      await this.evictStaleViewers(nowMs);
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
      if (!(await this.noted(ANNOUNCED_PREFIX, identity))) await this.announce(identity);
    } else if (role === 'host') {
      // a host is spawned by the ring, so every viewer waiting for it announced
      // itself before this socket existed and that `viewer-join` is gone. the
      // host would then refuse their offers as `unknown_viewer` -- replay the
      // joins it missed, to this socket alone so a second host cannot see them
      // twice. same shape as the live announcement; the host needs no new type.
      // one join per viewer id: a re-dial whose old socket has not closed is still
      // one viewer, and a 4.0.1 host on its first dial refuses the second join as
      // `join_too_soon`.
      const seen = new Set<string>();
      const replayed: string[] = [];
      for (const waiting of this.socketsByRole('viewer')) {
        const viewer = waiting.deserializeAttachment() as Identity | null;
        if (!viewer || viewer.departed || seen.has(viewer.id)) continue;
        seen.add(viewer.id);
        server.send(
          JSON.stringify({
            type: 'viewer-join',
            viewer: viewer.id,
            sid: viewer.sid,
            ctl: viewer.ctl,
            serverTimeMs: Date.now(),
          })
        );
        if (viewer.sid === identity.sid) replayed.push(viewer.id);
      }
      if (identity.sid !== null) await this.note(ANNOUNCED_PREFIX, replayed, identity.sid);
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
    let closed = 0;
    for (const socket of this.ctx.getWebSockets()) {
      const self = socket.deserializeAttachment() as Identity | null;
      // a kill that names a session is that session's host and viewers alone: the
      // doorbell names none, and the page that ends one session may already have the
      // next one in this room.
      if (body.sid !== null && self?.sid !== body.sid) continue;
      // a killed viewer's close may never complete either; the flag frees the slot now.
      if (self?.role === 'viewer') socket.serializeAttachment({ ...self, departed: true });
      socket.send(payload);
      socket.close(1000, 'kill');
      closed += 1;
    }
    return Response.json({ ok: true, closed });
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

  async webSocketMessage(socket: WebSocket, message: string | ArrayBuffer): Promise<void> {
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
        await this.forget([self.id]);
      } else if (to !== undefined) {
        // the host has let that viewer go, so its re-join is news to the host again.
        await this.forget([to]);
      }
      return;
    }
    this.fanOut(self.role, forwarded, to);
    // an offer that reached the viewer's own host may have given it a peer there, and
    // from then on only the host can tell that the viewer is gone.
    if (msg.type === 'offer' && self.sid !== null && this.hostOf(self.sid) && !(await this.noted(OFFERED_PREFIX, self))) {
      await this.note(OFFERED_PREFIX, [self.id], self.sid);
    }
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

  async webSocketClose(socket: WebSocket, code: number, _reason: string, wasClean: boolean): Promise<void> {
    const self = socket.deserializeAttachment() as Identity | null;
    if (!self || self.role !== 'viewer' || self.departed) return;
    if (!(await this.hostShouldHearOf(self))) return;
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
    await this.forget([self.id]);
  }

  webSocketError(socket: WebSocket): void {
    socket.close(1011, 'socket error');
  }
}
