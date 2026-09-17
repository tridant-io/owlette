// One Durable Object per machine — the signaling room. Every socket is accepted
// through the WebSocket hibernation API (ctx.acceptWebSocket), so an idle room
// holds no isolate in memory and incurs no duration charge, and protocol pings
// are auto-ponged without waking this handler.

const ATTACHMENT_LIMIT_BYTES = 16384; // serializeAttachment() hard limit
const MAX_MESSAGE_BYTES = 65536;

// Per-machine ring cap (review-2-security.md M5). A ring wakes the agent, which
// spawns a SYSTEM streamer holding an encoder session, so the room refuses to be
// a free doorbell-flood amplifier even if the API's own rate limit fails open.
const RING_CAP = 10;
const RING_WINDOW_MS = 60000;

// Overridable so the latency pass can take n=200 ring samples without the cap
// truncating the run; unset everywhere else, including in every test.
function ringCap(env) {
  const configured = Number(env.SWOOP_RING_CAP);
  return Number.isFinite(configured) && configured > 0 ? configured : RING_CAP;
}

const CLIENT_TYPES = new Set(['offer', 'answer', 'candidate', 'host-ready', 'bye']);
const SERVER_ONLY_TYPES = new Set(['hello', 'ring', 'viewer-join', 'kill', 'error']);

export class SignalRoom {
  constructor(ctx, env) {
    this.ctx = ctx;
    this.env = env;
    // Rings are rare by design and a flood keeps the room awake, so the window
    // lives in memory; see the memo for why the product Worker should persist it.
    this.ringWindow = [];
    // App-level keepalive answered by the runtime without waking the handler.
    this.ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair('ping', 'pong'));
  }

  async fetch(request) {
    const url = new URL(request.url);
    if (url.pathname === '/join') return this.join(request);
    if (url.pathname === '/ring') return this.ring(request);
    if (url.pathname === '/kill') return this.kill(request);
    if (url.pathname === '/stats') return this.stats();
    return new Response('not found', { status: 404 });
  }

  socketsByRole(role) {
    return this.ctx.getWebSockets(`role:${role}`);
  }

  join(request) {
    const identity = {
      role: request.headers.get('x-swoop-role'),
      id: request.headers.get('x-swoop-id'),
      sid: request.headers.get('x-swoop-sid') || null,
      ctl: request.headers.get('x-swoop-ctl') === '1',
      joinedAtMs: Date.now(),
    };

    const attachment = JSON.stringify(identity);
    if (attachment.length > ATTACHMENT_LIMIT_BYTES) {
      return new Response('attachment too large', { status: 400 });
    }

    const pair = new WebSocketPair();
    const client = pair[0];
    const server = pair[1];
    this.ctx.acceptWebSocket(server, [`role:${identity.role}`, `id:${identity.id}`]);
    server.serializeAttachment(identity);

    server.send(
      JSON.stringify({
        type: 'hello',
        role: identity.role,
        id: identity.id,
        sid: identity.sid,
        ctl: identity.ctl,
        peers: this.peerCounts(),
        serverTimeMs: Date.now(),
      })
    );

    if (identity.role === 'viewer') {
      const announcement = JSON.stringify({
        type: 'viewer-join',
        viewer: identity.id,
        sid: identity.sid,
        ctl: identity.ctl,
        serverTimeMs: Date.now(),
      });
      for (const socket of [...this.socketsByRole('host'), ...this.socketsByRole('doorbell')]) {
        socket.send(announcement);
      }
    }

    const headers = {};
    const offered = request.headers.get('x-swoop-subprotocol');
    if (offered) headers['Sec-WebSocket-Protocol'] = offered;
    return new Response(null, { status: 101, webSocket: client, headers });
  }

  peerCounts() {
    return {
      doorbell: this.socketsByRole('doorbell').length,
      host: this.socketsByRole('host').length,
      viewer: this.socketsByRole('viewer').length,
    };
  }

  async ring(request) {
    const body = await request.json();
    const now = Date.now();
    const cap = ringCap(this.env);
    this.ringWindow = this.ringWindow.filter((at) => now - at < RING_WINDOW_MS);
    if (this.ringWindow.length >= cap) {
      const retryAfterMs = RING_WINDOW_MS - (now - this.ringWindow[0]);
      return Response.json(
        { ok: false, code: 'ring_capped', delivered: 0, cap, windowMs: RING_WINDOW_MS, retryAfterMs },
        { status: 429 }
      );
    }
    this.ringWindow.push(now);

    const sockets = this.socketsByRole('doorbell');
    const payload = JSON.stringify({
      type: 'ring',
      sid: body.sid,
      sentAtMs: Number.isFinite(body.sentAtMs) ? body.sentAtMs : null,
      serverTimeMs: now,
    });
    for (const socket of sockets) socket.send(payload);

    return Response.json({
      ok: true,
      delivered: sockets.length,
      cap,
      windowMs: RING_WINDOW_MS,
      remaining: cap - this.ringWindow.length,
    });
  }

  async kill(request) {
    const body = await request.json();
    const payload = JSON.stringify({ type: 'kill', sid: body.sid ?? null, serverTimeMs: Date.now() });
    const sockets = this.ctx.getWebSockets();
    for (const socket of sockets) {
      socket.send(payload);
      socket.close(1000, 'kill');
    }
    return Response.json({ ok: true, closed: sockets.length });
  }

  stats() {
    const now = Date.now();
    return Response.json({
      peers: this.peerCounts(),
      ringsInWindow: this.ringWindow.filter((at) => now - at < RING_WINDOW_MS).length,
      ringCap: ringCap(this.env),
      ringWindowMs: RING_WINDOW_MS,
    });
  }

  sendError(socket, code) {
    socket.send(JSON.stringify({ type: 'error', code, serverTimeMs: Date.now() }));
  }

  webSocketMessage(socket, message) {
    if (typeof message !== 'string') return this.sendError(socket, 'binary_unsupported');
    if (message.length > MAX_MESSAGE_BYTES) return this.sendError(socket, 'message_too_large');

    let msg;
    try {
      msg = JSON.parse(message);
    } catch {
      return this.sendError(socket, 'malformed_message');
    }

    const self = socket.deserializeAttachment();
    if (SERVER_ONLY_TYPES.has(msg.type)) return this.sendError(socket, 'forbidden_type');
    if (!CLIENT_TYPES.has(msg.type)) return this.sendError(socket, 'unknown_type');

    const forwarded = { ...msg, from: self.id, fromRole: self.role, serverTimeMs: Date.now() };

    if (msg.type === 'bye') {
      this.fanOut(self, forwarded, msg.to);
      // Recorded so webSocketClose does not announce the same departure twice.
      socket.serializeAttachment({ ...self, departed: true });
      socket.close(1000, 'bye');
      return undefined;
    }

    if (msg.type === 'offer' && self.role !== 'viewer') return this.sendError(socket, 'wrong_role');
    if ((msg.type === 'answer' || msg.type === 'host-ready') && self.role !== 'host') {
      return this.sendError(socket, 'wrong_role');
    }

    return this.fanOut(self, forwarded, msg.to);
  }

  // A viewer only ever reaches the agent side; the agent side reaches the named
  // viewer, or every viewer when it names none. Viewers never see each other.
  fanOut(self, forwarded, to) {
    const payload = JSON.stringify(forwarded);
    const targets =
      self.role === 'viewer'
        ? [...this.socketsByRole('host'), ...this.socketsByRole('doorbell')]
        : typeof to === 'string'
          ? this.ctx.getWebSockets(`id:${to}`)
          : this.socketsByRole('viewer');
    for (const socket of targets) socket.send(payload);
    return undefined;
  }

  webSocketClose(socket, code, reason, wasClean) {
    const self = socket.deserializeAttachment();
    if (self && self.role === 'viewer' && !self.departed) {
      const payload = JSON.stringify({
        type: 'bye',
        from: self.id,
        fromRole: 'viewer',
        code,
        wasClean,
        serverTimeMs: Date.now(),
      });
      for (const peer of [...this.socketsByRole('host'), ...this.socketsByRole('doorbell')]) {
        peer.send(payload);
      }
    }
  }

  webSocketError(socket) {
    socket.close(1011, 'socket error');
  }
}
