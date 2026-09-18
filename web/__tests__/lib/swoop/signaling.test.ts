/** @jest-environment node */

import { SWOOP_SUBPROTOCOL, type SignalHello, type SignalingMessage } from '@/lib/swoop/protocol';
import {
  CLOSE_AUTH,
  SwoopSignaling,
  roomUrl,
  type SwoopSignalFatal,
  type SwoopSignalStatus,
  type SwoopSocket,
} from '@/lib/swoop/signaling';

/** the module's ladder ceiling: one advance past it always fires a retry. */
const BACKOFF_CEILING_MS = 15_000;

// ---------------------------------------------------------------------------
// fakes
// ---------------------------------------------------------------------------

class FakeSocket implements SwoopSocket {
  readyState = 0;
  readonly sent: string[] = [];
  closedWith: { code?: number; reason?: string } | null = null;
  onopen: ((event: unknown) => void) | null = null;
  onclose: ((event: { code: number; reason?: string }) => void) | null = null;
  onerror: ((event: unknown) => void) | null = null;
  onmessage: ((event: { data: unknown }) => void) | null = null;

  constructor(
    readonly url: string,
    readonly protocols: string[],
  ) {}

  send(data: string): void {
    this.sent.push(data);
  }

  close(code?: number, reason?: string): void {
    this.readyState = 3;
    this.closedWith = { code, reason };
  }

  /** the worker accepted the upgrade. */
  open(): void {
    this.readyState = 1;
    this.onopen?.(null);
  }

  deliver(message: unknown): void {
    this.onmessage?.({ data: typeof message === 'string' ? message : JSON.stringify(message) });
  }

  drop(code: number): void {
    this.readyState = 3;
    this.onclose?.({ code });
  }
}

function b64url(value: string): string {
  return Buffer.from(value, 'utf8')
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

/** a structurally valid viewer token. nothing in this module verifies one. */
function mintFake(expSeconds: number, nonce: number): string {
  const header = b64url(JSON.stringify({ alg: 'EdDSA', kid: 'k1' }));
  const claims = b64url(
    JSON.stringify({
      iss: 'owlette-api',
      aud: 'swoop-host',
      role: 'viewer',
      site: 'site_1',
      machine: 'machine_1',
      sid: 'sid_1',
      viewer: 'viewer_1',
      iat: expSeconds - 60,
      exp: expSeconds,
      jti: `jti_${nonce}`,
    }),
  );
  return `${header}.${claims}.${b64url('signature')}`;
}

const HELLO: SignalHello = {
  type: 'hello',
  protocolVersion: 1,
  role: 'viewer',
  id: 'viewer_1',
  sid: 'sid_1',
  ctl: true,
  peers: { doorbell: 1, host: 1, viewer: 1 },
};

interface Harness {
  signaling: SwoopSignaling;
  sockets: FakeSocket[];
  messages: SignalingMessage[];
  statuses: SwoopSignalStatus[];
  fatals: SwoopSignalFatal[];
  rejections: string[];
  clock: { ms: number };
}

/** every instance a test built, so none leaves its keepalive interval running. */
const openSignalings: SwoopSignaling[] = [];

afterEach(() => {
  for (const signaling of openSignalings.splice(0)) signaling.close();
  jest.useRealTimers();
});

function harness(tokenLifetimeMs = 60_000): Harness {
  const sockets: FakeSocket[] = [];
  const messages: SignalingMessage[] = [];
  const statuses: SwoopSignalStatus[] = [];
  const fatals: SwoopSignalFatal[] = [];
  const rejections: string[] = [];
  const clock = { ms: 1_700_000_000_000 };
  let minted = 0;

  const signaling = new SwoopSignaling({
    url: 'https://swoop-signal.example.com/',
    siteId: 'site_1',
    machineId: 'machine_1',
    mintToken: async () => {
      minted += 1;
      return mintFake(Math.floor((clock.ms + tokenLifetimeMs) / 1000), minted);
    },
    onMessage: (message) => messages.push(message),
    onStatus: (status) => statuses.push(status),
    onFatal: (code) => fatals.push(code),
    onRejected: (reason) => rejections.push(reason),
    now: () => clock.ms,
    socketFactory: (url, protocols) => {
      const socket = new FakeSocket(url, protocols);
      sockets.push(socket);
      return socket;
    },
  });

  openSignalings.push(signaling);
  return { signaling, sockets, messages, statuses, fatals, rejections, clock };
}

/** let the mint promise and the dial chain settle. */
async function settle(): Promise<void> {
  for (let i = 0; i < 6; i += 1) await Promise.resolve();
}

// ---------------------------------------------------------------------------

describe('swoop signaling', () => {
  it('builds the room url from the ids and never puts the token in it', async () => {
    const h = harness();
    await h.signaling.connect();

    expect(roomUrl('https://worker.example.com/', 'site_1', 'machine_1')).toBe(
      'wss://worker.example.com/v1/room/site_1/machine_1',
    );
    expect(h.sockets).toHaveLength(1);
    expect(h.sockets[0].url).toBe('wss://swoop-signal.example.com/v1/room/site_1/machine_1');
    expect(h.sockets[0].url).not.toMatch(/jwt|token|eyJ/);
  });

  it('presents the token as a second subprotocol beside the version subprotocol', async () => {
    const h = harness();
    await h.signaling.connect();

    const [version, carrier] = h.sockets[0].protocols;
    expect(version).toBe(SWOOP_SUBPROTOCOL);
    expect(carrier.startsWith('jwt.')).toBe(true);
    expect(carrier.slice(4).split('.')).toHaveLength(3);
  });

  it('accepts a hello at the compiled protocol version', async () => {
    const h = harness();
    await h.signaling.connect();
    h.sockets[0].open();
    h.sockets[0].deliver(HELLO);

    expect(h.signaling.connectionStatus).toBe('open');
    expect(h.signaling.identity?.id).toBe('viewer_1');
    expect(h.messages.map((m) => m.type)).toEqual(['hello']);
    expect(h.statuses).toEqual(['connecting', 'open']);
  });

  it('refuses a hello from another protocol version, says bye and stops', async () => {
    const h = harness();
    await h.signaling.connect();
    h.sockets[0].open();
    h.sockets[0].deliver({ ...HELLO, protocolVersion: 2 });

    expect(h.fatals).toEqual(['version_mismatch']);
    expect(JSON.parse(h.sockets[0].sent[0])).toMatchObject({ type: 'bye', reason: 'version_mismatch' });
    expect(h.sockets[0].closedWith?.code).toBe(1000);
    expect(h.signaling.connectionStatus).toBe('closed');
  });

  it('re-mints and re-dials at once after close 4401, with no backoff delay', async () => {
    jest.useFakeTimers();
    const h = harness();
    await h.signaling.connect();
    h.sockets[0].open();
    h.sockets[0].deliver(HELLO);

    h.sockets[0].deliver({ type: 'error', code: 'token_expired' });
    h.sockets[0].drop(CLOSE_AUTH);
    await settle();

    // no timer had to fire for the second dial to exist.
    expect(h.sockets).toHaveLength(2);
    expect(h.sockets[1].protocols[1]).not.toBe(h.sockets[0].protocols[1]);
    expect(h.messages.some((m) => m.type === 'error' && m.code === 'token_expired')).toBe(true);
  });

  it('falls back to the backoff ladder on a second 4401 in a row', async () => {
    jest.useFakeTimers();
    const h = harness();
    await h.signaling.connect();
    h.sockets[0].open();
    h.sockets[0].deliver(HELLO);

    h.sockets[0].drop(CLOSE_AUTH);
    await settle();
    expect(h.sockets).toHaveLength(2);

    h.sockets[1].drop(CLOSE_AUTH);
    await settle();
    expect(h.sockets).toHaveLength(2);

    await jest.advanceTimersByTimeAsync(BACKOFF_CEILING_MS);
    expect(h.sockets).toHaveLength(3);
  });

  it('backs off within the bound after an unclean close and recovers', async () => {
    jest.useFakeTimers();
    const h = harness();
    await h.signaling.connect();
    h.sockets[0].open();
    h.sockets[0].deliver(HELLO);

    h.sockets[0].drop(1006);
    await settle();
    expect(h.signaling.connectionStatus).toBe('reconnecting');
    expect(h.sockets).toHaveLength(1);

    await jest.advanceTimersByTimeAsync(BACKOFF_CEILING_MS);
    expect(h.sockets).toHaveLength(2);
    h.sockets[1].open();
    h.sockets[1].deliver(HELLO);
    expect(h.signaling.connectionStatus).toBe('open');
  });

  it('does not reconnect after a clean close — a kill is not a hiccup', async () => {
    jest.useFakeTimers();
    const h = harness();
    await h.signaling.connect();
    h.sockets[0].open();
    h.sockets[0].deliver(HELLO);

    h.sockets[0].deliver({ type: 'kill', sid: 'sid_1' });
    h.sockets[0].drop(1000);
    await settle();
    await jest.advanceTimersByTimeAsync(60_000);

    expect(h.sockets).toHaveLength(1);
    expect(h.signaling.connectionStatus).toBe('closed');
  });

  it('re-mints before sending on a spent token instead of buying token_expired', async () => {
    const h = harness();
    await h.signaling.connect();
    h.sockets[0].open();
    h.sockets[0].deliver(HELLO);

    // the socket sat idle past its token's expiry. the worker's check is lazy,
    // so it would fire on this very frame and close 4401.
    h.clock.ms += 59_000;
    h.signaling.send({ type: 'offer', sdp: 'v=0\r\n' });
    await settle();

    expect(h.sockets[0].sent.some((frame) => frame.includes('"offer"'))).toBe(false);
    expect(h.sockets).toHaveLength(2);
    h.sockets[1].open();
    expect(JSON.parse(h.sockets[1].sent[0])).toMatchObject({ type: 'offer' });
  });

  it('sends straight through while the token is still good', async () => {
    const h = harness();
    await h.signaling.connect();
    h.sockets[0].open();
    h.sockets[0].deliver(HELLO);

    h.signaling.send({ type: 'offer', sdp: 'v=0\r\n' });
    expect(h.sockets).toHaveLength(1);
    expect(JSON.parse(h.sockets[0].sent[0])).toMatchObject({ type: 'offer' });
  });

  it('refuses to send a frame a viewer may not send', async () => {
    const h = harness();
    await h.signaling.connect();
    h.sockets[0].open();
    h.sockets[0].deliver(HELLO);

    expect(() => h.signaling.send({ type: 'answer', to: 'viewer_1', sdp: 'v=0\r\n', mac: 'x' })).toThrow(
      /may not send answer/,
    );
    expect(() => h.signaling.send({ type: 'kill', sid: 'sid_1' })).toThrow(/may not send kill/);
  });

  it('queues frames offered before the socket opens and flushes them in order', async () => {
    const h = harness();
    await h.signaling.connect();

    h.signaling.send({ type: 'candidate', candidate: 'a', sdpMid: '0', sdpMLineIndex: 0 });
    h.signaling.send({ type: 'candidate', candidate: 'b', sdpMid: '0', sdpMLineIndex: 0 });
    expect(h.sockets[0].sent).toHaveLength(0);

    h.sockets[0].open();
    expect(h.sockets[0].sent.map((frame) => JSON.parse(frame).candidate)).toEqual(['a', 'b']);
  });

  it('reports a frame the decoder refused without forwarding it', async () => {
    const h = harness();
    await h.signaling.connect();
    h.sockets[0].open();
    h.sockets[0].deliver('{"type":"not-a-swoop-type"}');

    expect(h.rejections).toEqual(['unknown_type']);
    expect(h.messages).toHaveLength(0);
  });

  it('answers the room keepalive without treating the pong as a message', async () => {
    jest.useFakeTimers();
    const h = harness();
    await h.signaling.connect();
    h.sockets[0].open();
    h.sockets[0].deliver(HELLO);

    await jest.advanceTimersByTimeAsync(25_000);
    expect(h.sockets[0].sent).toContain('ping');

    h.sockets[0].deliver('pong');
    expect(h.messages.map((m) => m.type)).toEqual(['hello']);
  });

  it('closes without reconnecting once the caller says so', async () => {
    jest.useFakeTimers();
    const h = harness();
    await h.signaling.connect();
    h.sockets[0].open();
    h.sockets[0].deliver(HELLO);

    h.signaling.close();
    expect(h.sockets[0].closedWith?.code).toBe(1000);
    h.sockets[0].drop(1006);
    await jest.advanceTimersByTimeAsync(60_000);
    expect(h.sockets).toHaveLength(1);
  });

  it('gives up rather than minting forever when the api refuses', async () => {
    const fatals: SwoopSignalFatal[] = [];
    const sockets: FakeSocket[] = [];
    const signaling = new SwoopSignaling({
      url: 'https://swoop-signal.example.com',
      siteId: 'site_1',
      machineId: 'machine_1',
      mintToken: async () => {
        throw new Error('403');
      },
      onMessage: () => undefined,
      onFatal: (code) => fatals.push(code),
      socketFactory: (url, protocols) => {
        const socket = new FakeSocket(url, protocols);
        sockets.push(socket);
        return socket;
      },
    });

    await signaling.connect();
    expect(fatals).toEqual(['mint_failed']);
    expect(sockets).toHaveLength(0);
  });
});
