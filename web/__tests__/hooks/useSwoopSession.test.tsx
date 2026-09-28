/**
 * @jest-environment jsdom
 *
 * how a swoop session ends, seen from the page: which ends start the next
 * session on the ladder, which stop for good, and which tell the server.
 * everything below the hook is faked; the fakes keep the callbacks the hook
 * wires, so each test ends a session the way the real part would.
 */

import { useEffect } from 'react';
import { act, render } from '@testing-library/react';
import type { SwoopSession } from '@/lib/swoop/features';
import type { SwoopPeerOptions } from '@/lib/swoop/peer';
import type { SwoopSignalingOptions } from '@/lib/swoop/signaling';

const wired: {
  peer: SwoopPeerOptions | null;
  signaling: SwoopSignalingOptions | null;
  session: SwoopSession | null;
  /** what the hook told the peer about the signalling socket, in order. */
  signalOpen: boolean[];
} = { peer: null, signaling: null, session: null, signalOpen: [] };

jest.mock('@/contexts/AuthContext', () => ({
  useAuth: () => ({ mfaFactors: { totp: true, passkeys: 0 } }),
}));

jest.mock('@/lib/swoop/clientCaps', () => ({
  probeClientCaps: async () => ({ codecs: ['h264'], hardware: [], playoutDelay: true, webCodecsHevc: false }),
}));

jest.mock('@/lib/swoop/peer', () => ({
  createSwoopIdentity: async () => ({ certificate: {}, fingerprint: 'sha-256 AA:BB' }),
  createSwoopPeer: (options: SwoopPeerOptions) => {
    wired.peer = options;
    return {
      start: async () => undefined,
      close: () => undefined,
      handleSignal: async () => undefined,
      channel: () => null,
      signalOpen: (open: boolean) => wired.signalOpen.push(open),
    };
  },
}));

jest.mock('@/lib/swoop/signaling', () => ({
  createSwoopSignaling: (options: SwoopSignalingOptions) => {
    wired.signaling = options;
    return { connect: async () => undefined, close: () => undefined, send: () => undefined, refresh: async () => undefined };
  },
}));

jest.mock('@/lib/swoop/video/receiver', () => ({
  SwoopReceiver: class {
    attachTrack() {}
    async start() {}
    stop() {}
    handleMeta() {}
    diagnostics() {
      return {};
    }
  },
}));

jest.mock('@/lib/swoop/video/presenter', () => ({
  createPresenter: () => ({ detach: () => undefined, observe: () => undefined, stats: () => ({}) }),
}));

jest.mock('@/lib/swoop/features', () => ({
  SWOOP_FEATURES: [
    {
      name: 'probe',
      attach: (session: SwoopSession) => {
        wired.session = session;
        return () => undefined;
      },
    },
  ],
  swoopFeedback: () => null,
}));

import { useSwoopSession, type UseSwoopSession } from '@/hooks/useSwoopSession';

const SITE = 'site-1';
const MACHINE = 'machine-1';
const SESSIONS = `/api/sites/${SITE}/machines/${MACHINE}/swoop/sessions`;

const GRANT = {
  sid: 'sid-1',
  viewerId: 'viewer-1',
  ctl: true,
  viewerJwt: 'header.payload.signature',
  k: 'aC3vYYwlNHnvNFH-5IiZXUay4W1QnqLmMtmod6Hy-LU',
  iceServers: [],
  signalUrl: 'wss://signal.example/v1/room/site-1/machine-1',
  expiresAt: 0,
};

interface Reply {
  status: number;
  body?: unknown;
}

let mint: Reply;
let lease: Reply;

const fetchMock = jest.fn(async (url: string, init?: RequestInit) => {
  const reply = init?.method === 'DELETE' ? { status: 200 } : url.endsWith('/lease') ? lease : mint;
  return { ok: reply.status < 400, status: reply.status, json: async () => reply.body ?? {} } as Response;
});

const deletes = () => fetchMock.mock.calls.filter(([, init]) => init?.method === 'DELETE');
const mints = () => fetchMock.mock.calls.filter(([url]) => url === SESSIONS);

let swoop: UseSwoopSession;

function Page({ onCommit }: { onCommit: (session: UseSwoopSession) => void }) {
  const session = useSwoopSession(SITE, MACHINE);
  const { stageRef, videoRef } = session;
  useEffect(() => onCommit(session));
  return (
    <div ref={stageRef}>
      <video ref={videoRef} />
    </div>
  );
}

async function flush(): Promise<void> {
  await act(async () => {
    for (let i = 0; i < 20; i += 1) await Promise.resolve();
  });
}

async function advance(ms: number): Promise<void> {
  await act(async () => {
    await jest.advanceTimersByTimeAsync(ms);
  });
  await flush();
}

/** mount the page and let the run get as far as a live session. */
async function open() {
  const view = render(
    <Page
      onCommit={(session) => {
        swoop = session;
      }}
    />,
  );
  await flush();
  return view;
}

beforeEach(() => {
  jest.useFakeTimers();
  mint = { status: 201, body: { data: GRANT } };
  lease = { status: 200, body: { data: { viewerJwt: 'renewed.jwt', expiresAt: Date.now() + 300_000 } } };
  wired.peer = null;
  wired.signaling = null;
  wired.session = null;
  wired.signalOpen = [];
  (globalThis as unknown as { fetch: typeof fetch }).fetch = fetchMock as unknown as typeof fetch;
});

afterEach(() => jest.useRealTimers());

describe('useSwoopSession — how a session ends', () => {
  it.each([
    ['the feedback watchdog', () => wired.session!.end('peer_failed')],
    ['a host that let this viewer go', () => wired.peer!.onClosed!('timeout')],
  ])('%s ends it without a DELETE, and the next session starts on the ladder', async (_what, endIt) => {
    await open();
    expect(wired.session).not.toBeNull();

    act(() => endIt());
    expect(swoop.state).toBe('ended');
    expect(swoop.retryIn).not.toBeNull();

    await advance(30_000);
    expect(mints()).toHaveLength(2);
    expect(deletes()).toHaveLength(0);
  });

  it('a kill is final, and the silence it leaves behind does not bring it back', async () => {
    await open();
    const killed = wired.session!;

    act(() => wired.peer!.onClosed!('kill'));
    expect(swoop.state).toBe('ended');
    expect(swoop.error).toBe('this session was ended from elsewhere.');
    expect(swoop.retryIn).toBeNull();

    // the killed run's feedback watchdog noticing the channel it lost.
    act(() => killed.end('peer_failed'));
    await advance(60_000);
    expect(mints()).toHaveLength(1);
    expect(deletes()).toHaveLength(0);
  });

  it('the operator’s end sends exactly one DELETE, saying closed', async () => {
    const view = await open();

    act(() => swoop.end());
    expect(swoop.state).toBe('ended');
    expect(swoop.retryIn).toBeNull();
    view.unmount();
    await advance(60_000);

    expect(deletes()).toHaveLength(1);
    const [url, init] = deletes()[0];
    expect(url).toBe(`${SESSIONS}/${GRANT.sid}`);
    expect(JSON.parse(String(init?.body))).toEqual({ endReason: 'closed', viewerReason: 'closed' });
    expect(mints()).toHaveLength(1);
  });

  it.each([
    [
      'a machine that is offline',
      { status: 409, body: { code: 'machine_offline', detail: 'this machine is offline; swoop cannot reach it until it reconnects.' } },
      'this machine is offline; swoop cannot reach it until it reconnects.',
    ],
    ['a lapsed login', { status: 401, body: { code: 'unauthorized', detail: 'Unauthorized: Session expired' } }, 'sign in again to resume.'],
    ['an edge in front of the app', { status: 403 }, 'this swoop session could not be started.'],
  ])('%s on the mint is retried on the ladder', async (_what, refusal, error) => {
    mint = refusal;
    await open();
    expect(swoop.state).toBe('error');
    expect(swoop.error).toBe(error);
    expect(swoop.retryIn).not.toBeNull();

    mint = { status: 201, body: { data: GRANT } };
    await advance(30_000);
    expect(mints()).toHaveLength(2);
    expect(wired.session).not.toBeNull();
  });

  it('a policy refusal on the mint is final', async () => {
    mint = { status: 403, body: { code: 'swoop_disabled', detail: 'swoop is not enabled for this site.' } };
    await open();
    expect(swoop.state).toBe('error');
    expect(swoop.error).toBe('swoop is not enabled for this site.');
    expect(swoop.retryIn).toBeNull();

    await advance(60_000);
    expect(mints()).toHaveLength(1);
  });

  it('a withdrawal met while re-minting ends the session with its reason', async () => {
    await open();
    const mintToken = wired.signaling!.mintToken;
    // the first dial spends the jwt the create route already minted.
    await act(async () => {
      await mintToken();
    });

    lease = { status: 403, body: { code: 'machine_excluded', detail: 'swoop is excluded on this machine.' } };
    await act(async () => {
      await expect(mintToken()).rejects.toThrow('swoop is excluded on this machine.');
    });
    expect(swoop.state).toBe('ended');
    expect(swoop.error).toBe('swoop is excluded on this machine.');
    expect(swoop.retryIn).toBeNull();
    expect(deletes()).toHaveLength(0);
  });

  it('tells the peer when an answer can come back over signalling', async () => {
    await open();

    act(() => wired.signaling!.onStatus!('reconnecting'));
    act(() => wired.signaling!.onStatus!('open'));
    expect(wired.signalOpen).toEqual([false, true]);
  });
});
