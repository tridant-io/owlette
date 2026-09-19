// a minimal room client for the integration tests: node's built-in WebSocket, no
// client dependency. the two token carriages of PROTOCOL.md section 1 are both
// exercised — a browser cannot set handshake headers, an agent can.

import { randomBytes } from 'node:crypto';
import { request as httpRequest } from 'node:http';

export interface Frame {
  type: string;
  [field: string]: unknown;
}

export class RoomClient {
  readonly frames: Frame[] = [];
  closed: { code: number; reason: string } | null = null;
  private waiters: Array<{ type: string; resolve: (frame: Frame) => void }> = [];
  private readonly resolveClosed: (value: { code: number; reason: string }) => void;
  readonly whenClosed: Promise<{ code: number; reason: string }>;

  constructor(private readonly socket: WebSocket) {
    let resolve!: (value: { code: number; reason: string }) => void;
    this.whenClosed = new Promise((r) => {
      resolve = r;
    });
    this.resolveClosed = resolve;

    socket.addEventListener('message', (event) => {
      const data = event.data as string;
      // the hibernation auto-response is a bare string, not a framed message.
      const frame: Frame = data.startsWith('{') ? (JSON.parse(data) as Frame) : { type: data };
      this.frames.push(frame);
      this.waiters = this.waiters.filter((waiter) => {
        if (waiter.type !== frame.type) return true;
        waiter.resolve(frame);
        return false;
      });
    });
    socket.addEventListener('close', (event) => {
      this.closed = { code: event.code, reason: event.reason };
      this.resolveClosed(this.closed);
    });
  }

  waitFor(type: string, timeoutMs = 10000): Promise<Frame> {
    const existing = this.frames.find((frame) => frame.type === type);
    if (existing) return Promise.resolve(existing);
    return new Promise((resolve, reject) => {
      const waiter = { type, resolve };
      this.waiters.push(waiter);
      setTimeout(() => {
        this.waiters = this.waiters.filter((candidate) => candidate !== waiter);
        reject(new Error(`timed out waiting for "${type}"`));
      }, timeoutMs).unref();
    });
  }

  send(message: unknown): void {
    this.socket.send(JSON.stringify(message));
  }

  sendRaw(message: string): void {
    this.socket.send(message);
  }

  close(): void {
    this.socket.close();
  }
}

export interface ConnectOptions {
  site?: string;
  machine?: string;
  /** true dials like the agent (Authorization header), false like a browser (subprotocol). */
  viaHeader?: boolean;
}

export function connect(
  wsUrl: string,
  token: string,
  { site = 'site_goldenvector', machine = 'machine_goldenvector', viaHeader = false }: ConnectOptions = {}
): Promise<RoomClient> {
  const url = `${wsUrl}/v1/room/${site}/${machine}`;
  // node's global WebSocket accepts undici's options bag; its type does not say so.
  const socket = viaHeader
    ? new WebSocket(url, { headers: { Authorization: `Bearer ${token}` } } as unknown as string[])
    : new WebSocket(url, ['owlette.swoop.v1', `jwt.${token}`]);
  const client = new RoomClient(socket);
  return new Promise((resolve, reject) => {
    socket.addEventListener('open', () => resolve(client));
    socket.addEventListener('error', () => reject(new Error('websocket handshake failed')));
  });
}

export interface UpgradeResult {
  status: number;
  headers: Record<string, string | string[] | undefined>;
  body: Record<string, unknown> | null;
}

/**
 * a refused upgrade answers with an ordinary json body carrying the error code.
 * node's fetch will not send an Upgrade header, so the handshake is issued raw.
 */
export function upgradeStatus(
  port: number,
  token: string | null,
  {
    site = 'site_goldenvector',
    machine = 'machine_goldenvector',
    subprotocol,
  }: ConnectOptions & { subprotocol?: string } = {}
): Promise<UpgradeResult> {
  return new Promise((resolve, reject) => {
    const req = httpRequest(
      {
        host: '127.0.0.1',
        port,
        path: `/v1/room/${site}/${machine}`,
        headers: {
          Connection: 'Upgrade',
          Upgrade: 'websocket',
          'Sec-WebSocket-Version': '13',
          'Sec-WebSocket-Key': randomBytes(16).toString('base64'),
          ...(token === null ? {} : { Authorization: `Bearer ${token}` }),
          ...(subprotocol === undefined ? {} : { 'Sec-WebSocket-Protocol': subprotocol }),
        },
      },
      (response) => {
        let body = '';
        response.on('data', (chunk) => {
          body += chunk;
        });
        response.on('end', () =>
          resolve({
            status: response.statusCode ?? 0,
            headers: response.headers,
            body: body ? (JSON.parse(body) as Record<string, unknown>) : null,
          })
        );
      }
    );
    req.on('upgrade', (response, socket) => {
      socket.destroy();
      resolve({ status: response.statusCode ?? 0, headers: response.headers, body: null });
    });
    req.on('error', reject);
    req.end();
  });
}

export async function serverCall(
  baseUrl: string,
  path: string,
  secret: string | null,
  body: unknown
): Promise<{ status: number; body: Record<string, unknown> }> {
  const response = await fetch(`${baseUrl}${path}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(secret === null ? {} : { 'x-swoop-ring-secret': secret }),
    },
    body: JSON.stringify(body),
  });
  return { status: response.status, body: (await response.json()) as Record<string, unknown> };
}
