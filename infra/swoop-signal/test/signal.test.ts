// the worker end to end, against a real `wrangler dev`. every room here is named
// from a token claim, so tests that must not disturb each other simply use a
// different machine id.

import { describe, expect, inject, it } from 'vitest';

import { connect, serverCall, upgradeStatus, type Frame, type RoomClient } from './client';
import { claimsFor, currentKey, machineId, previousKey, readVector, signToken, unknownKid } from './vectors';

const baseUrl = inject('baseUrl');
const wsUrl = inject('wsUrl');
const port = inject('port');
const ringSecret = inject('ringSecret');

const SITE = 'site_goldenvector';

function hostToken(machine: string) {
  return signToken(claimsFor('host', { machine }));
}
function doorbellToken(machine: string) {
  return signToken(claimsFor('doorbell', { machine }));
}
function viewerToken(machine: string, viewer = 'viewer_0000000001') {
  return signToken(claimsFor('viewer', { machine, viewer }));
}

function dialAgent(token: string, machine: string) {
  return connect(wsUrl, token, { machine, viaHeader: true });
}
function dialBrowser(token: string, machine: string) {
  return connect(wsUrl, token, { machine });
}

async function settle(ms = 250) {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

function stripTime(frame: Frame): Record<string, unknown> {
  const { serverTimeMs, ...rest } = frame;
  expect(typeof serverTimeMs).toBe('number');
  return rest;
}

describe('/health', () => {
  it('answers 200 with a fixed body and no auth', async () => {
    const response = await fetch(`${baseUrl}/health`);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true, service: 'swoop-signal', protocolVersion: 1 });
  });

  it('reports the active kids and the algorithm to a caller holding the ring secret', async () => {
    // without this a rotation is unverifiable from outside: one cannot tell whether
    // the worker learned the new key before the api started minting with it.
    const response = await fetch(`${baseUrl}/health`, { headers: { 'x-swoop-ring-secret': ringSecret } });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      ok: true,
      service: 'swoop-signal',
      protocolVersion: 1,
      kids: [currentKey.kid, previousKey.kid],
      algorithm: 'Ed25519',
    });
  });

  it('refuses a wrong ring secret on /health rather than falling back to the fixed body', async () => {
    const response = await fetch(`${baseUrl}/health`, { headers: { 'x-swoop-ring-secret': 'x'.repeat(64) } });
    expect(response.status).toBe(401);
    expect(await response.json()).toMatchObject({ code: 'bad_ring_secret' });
  });
});

describe('admission', () => {
  it('accepts a host, a viewer and a doorbell token', async () => {
    const machine = machineId('admit');
    const doorbell = await dialAgent(doorbellToken(machine), machine);
    const host = await dialAgent(hostToken(machine), machine);
    const viewer = await dialBrowser(viewerToken(machine), machine);

    for (const [client, role] of [
      [doorbell, 'doorbell'],
      [host, 'host'],
      [viewer, 'viewer'],
    ] as Array<[RoomClient, string]>) {
      const hello = await client.waitFor('hello');
      expect(hello.role).toBe(role);
      expect(hello.protocolVersion).toBe(1);
    }

    doorbell.close();
    host.close();
    viewer.close();
  });

  it('accepts a token signed with the previous key during a rotation overlap', async () => {
    const machine = machineId('rotate');
    const token = signToken(claimsFor('doorbell', { machine }), previousKey);
    const client = await dialAgent(token, machine);
    expect((await client.waitFor('hello')).role).toBe('doorbell');
    client.close();
  });

  it('refuses an unknown kid, distinguishably from any other failure', async () => {
    const machine = machineId('unknownkid');
    const token = signToken(claimsFor('doorbell', { machine }), currentKey, unknownKid);
    const result = await upgradeStatus(port, token, { machine });
    // 401 is the doorbell's signal to re-mint and redial at once rather than walk
    // the backoff ladder — a kid rotation must not cost the fleet a full ladder.
    expect(result.status).toBe(401);
    expect(result.body).toEqual({ type: 'error', reason: 'auth', code: 'unknown_kid' });
    expect(result.headers['x-swoop-error']).toBe('unknown_kid');
  });

  it('refuses a missing token', async () => {
    const result = await upgradeStatus(port, null, { machine: machineId('notoken') });
    expect(result.status).toBe(401);
    expect(result.body).toMatchObject({ reason: 'auth', code: 'auth' });
    expect(result.headers['x-swoop-error']).toBe('auth');
  });

  it('refuses an expired token', async () => {
    const machine = machineId('expired');
    const claims = claimsFor('doorbell', { machine });
    const iat = Math.floor(Date.now() / 1000) - 600;
    const result = await upgradeStatus(port, signToken({ ...claims, iat, exp: iat + 300 }), { machine });
    expect(result.status).toBe(401);
    expect(result.body).toMatchObject({ reason: 'auth', code: 'token_expired' });
    expect(result.headers['x-swoop-error']).toBe('token_expired');
  });

  it('cannot reach another machine’s room even when the url names that machine', async () => {
    // a correctly signed, unexpired token for machine B, presented at machine A.
    const token = doorbellToken(machineId('b'));
    const result = await upgradeStatus(port, token, { machine: machineId('a') });
    expect(result.status).toBe(403);
    expect(result.body).toEqual({ type: 'error', reason: 'room', code: 'room_mismatch' });
  });

  it('cannot reach another site’s room either', async () => {
    const token = signToken(claimsFor('doorbell', { machine: machineId('site') }));
    const result = await upgradeStatus(port, token, { site: 'site_other', machine: machineId('site') });
    expect(result.status).toBe(403);
    expect(result.body).toMatchObject({ code: 'room_mismatch' });
  });

  it('refuses a replayed jti', async () => {
    const machine = machineId('replay');
    const token = doorbellToken(machine);
    const client = await dialAgent(token, machine);
    await client.waitFor('hello');
    const replay = await upgradeStatus(port, token, { machine });
    expect(replay.status).toBe(401);
    // a fresh token carries a fresh jti, so this is a re-mint case, not a backoff one.
    expect(replay.body).toMatchObject({ reason: 'auth', code: 'auth' });
    client.close();
  });

  it('refuses an upgrade offering an unknown subprotocol', async () => {
    // the version handshake starts here: a worker that does not recognise the
    // subprotocol refuses the upgrade rather than negotiating.
    const machine = machineId('subproto');
    const result = await upgradeStatus(port, doorbellToken(machine), {
      machine,
      subprotocol: 'owlette.swoop.v2',
    });
    expect(result.status).toBe(400);
    expect(result.body).toMatchObject({ reason: 'protocol', code: 'bad_subprotocol' });
  });

  it('refuses more than four concurrent viewers', async () => {
    const machine = machineId('viewers');
    const clients: RoomClient[] = [];
    for (let i = 1; i <= 4; i += 1) {
      clients.push(await dialBrowser(viewerToken(machine, `viewer_000000000${i}`), machine));
    }
    await settle();
    const fifth = await upgradeStatus(port, viewerToken(machine, 'viewer_0000000005'), { machine });
    expect(fifth.status).toBe(429);
    expect(fifth.body).toMatchObject({ code: 'room_full' });
    for (const client of clients) client.close();
  });
});

describe('the auth signal', () => {
  it('refuses a handshake with exactly one of the three auth words', async () => {
    // the doorbell does one free re-mint on any of these and walks the full backoff
    // ladder on anything else, so the vocabulary is contract, not cosmetics.
    const machine = machineId('authwords');
    const iat = Math.floor(Date.now() / 1000) - 600;

    const cases: Array<[string, string]> = [
      ['auth', signToken({ ...claimsFor('doorbell', { machine }), iss: 'not-owlette' })],
      ['token_expired', signToken({ ...claimsFor('doorbell', { machine }), iat, exp: iat + 300 })],
      ['unknown_kid', signToken(claimsFor('doorbell', { machine }), currentKey, unknownKid)],
    ];

    for (const [word, token] of cases) {
      const result = await upgradeStatus(port, token, { machine });
      expect(result.status).toBe(401);
      expect(result.headers['x-swoop-error']).toBe(word);
      expect(result.body).toEqual({ type: 'error', reason: 'auth', code: word });
    }
  });

  it('closes an open socket 4401 with a matching error frame when its token expires', async () => {
    const machine = machineId('midexpiry');
    const iat = Math.floor(Date.now() / 1000) - 59;
    const token = signToken({ ...claimsFor('viewer', { machine }), iat, exp: iat + 60 });
    const viewer = await dialBrowser(token, machine);
    await viewer.waitFor('hello');

    await settle(2500);
    viewer.send({ type: 'candidate', candidate: 'candidate:1', sdpMid: '0', sdpMLineIndex: 0 });

    const closed = await viewer.whenClosed;
    expect(closed.code).toBe(4401);
    expect(viewer.frames.filter((frame) => frame.type === 'error').pop()?.code).toBe('token_expired');
  });

  it('never kicks an idle socket whose token has expired', async () => {
    // the expiry check is lazy on purpose: a doorbell sends nothing for months, and
    // re-dialling the fleet on a token timer would be a self-inflicted ddos.
    const machine = machineId('idleexpiry');
    const iat = Math.floor(Date.now() / 1000) - 299;
    const token = signToken({ ...claimsFor('doorbell', { machine }), iat, exp: iat + 300 });
    const doorbell = await dialBrowser(token, machine);
    await doorbell.waitFor('hello');

    await settle(2500);
    expect(doorbell.closed).toBe(null);
    doorbell.close();
  });
});

describe('hibernation', () => {
  it('answers a bare ping without waking the room', async () => {
    // THE regression guard. `ping` is not json: had it reached webSocketMessage the
    // answer would be an `error` frame. it answers `pong`, which is positive proof
    // the runtime handled it via setWebSocketAutoResponse without waking the
    // durable object — the property the whole idle-cost model rests on.
    const machine = machineId('hibernate');
    const client = await dialAgent(doorbellToken(machine), machine);
    await client.waitFor('hello');
    client.sendRaw('ping');
    const pong = await client.waitFor('pong');
    expect(pong).toEqual({ type: 'pong' });
    expect(client.frames.some((frame) => frame.type === 'error')).toBe(false);
    client.close();
  });
});

describe('ring and kill', () => {
  it('refuses a ring without the shared secret, before touching a room', async () => {
    const room = { site: SITE, machine: machineId('ringauth') };
    const result = await serverCall(baseUrl, '/v1/ring', null, { ...room, sid: 'sid_x' });
    expect(result.status).toBe(401);
    expect(result.body).toMatchObject({ reason: 'auth', code: 'bad_ring_secret' });

    const wrong = await serverCall(baseUrl, '/v1/ring', 'x'.repeat(64), { ...room, sid: 'sid_x' });
    expect(wrong.status).toBe(401);
  });

  it('refuses a ring carrying any extra field', async () => {
    const result = await serverCall(baseUrl, '/v1/ring', ringSecret, {
      site: SITE,
      machine: machineId('ringauth'),
      sid: 'sid_x',
      bundle: 'nope',
    });
    expect(result.status).toBe(400);
    expect(result.body).toMatchObject({ code: 'unexpected_field' });
  });

  it('refuses a ring naming a malformed room', async () => {
    const result = await serverCall(baseUrl, '/v1/ring', ringSecret, {
      site: SITE,
      machine: 'not a machine id',
      sid: 'sid_x',
    });
    expect(result.status).toBe(400);
    expect(result.body).toMatchObject({ code: 'bad_room' });
  });

  it('refuses a ring with no doorbell attached rather than silently dropping it', async () => {
    // a no-op would let the api believe the agent was notified; it would also mean
    // the room's home colo got pinned by the api rather than by the agent's dial.
    const result = await serverCall(baseUrl, '/v1/ring', ringSecret, {
      site: SITE,
      machine: machineId('silent'),
      sid: 'sid_x',
    });
    expect(result.status).toBe(409);
    expect(result.body).toMatchObject({ code: 'no_doorbell', delivered: 0 });
  });

  it('delivers a ring to the doorbell', async () => {
    const machine = machineId('ring');
    const doorbell = await dialAgent(doorbellToken(machine), machine);
    await doorbell.waitFor('hello');

    const result = await serverCall(baseUrl, '/v1/ring', ringSecret, {
      site: SITE,
      machine,
      sid: 'sid_0000000000000001',
    });
    expect(result.status).toBe(200);
    expect(result.body).toMatchObject({ ok: true, delivered: 1 });

    const ring = await doorbell.waitFor('ring');
    expect(ring.sid).toBe('sid_0000000000000001');
    expect(typeof ring.sentAtMs).toBe('number');
    doorbell.close();
  });

  it('caps rings at ten per minute per machine', async () => {
    const machine = machineId('ringcap');
    const doorbell = await dialAgent(doorbellToken(machine), machine);
    await doorbell.waitFor('hello');

    const statuses: number[] = [];
    for (let i = 0; i < 12; i += 1) {
      const result = await serverCall(baseUrl, '/v1/ring', ringSecret, { site: SITE, machine, sid: 'sid_x' });
      statuses.push(result.status);
      if (result.status === 429) expect(result.body).toMatchObject({ code: 'ring_capped', cap: 10 });
    }
    expect(statuses.filter((status) => status === 200).length).toBe(10);
    expect(statuses.filter((status) => status === 429).length).toBe(2);
    doorbell.close();
  });

  it('kills every socket in the room', async () => {
    const machine = machineId('kill');
    const doorbell = await dialAgent(doorbellToken(machine), machine);
    const host = await dialAgent(hostToken(machine), machine);
    await Promise.all([doorbell.waitFor('hello'), host.waitFor('hello')]);

    const result = await serverCall(baseUrl, '/v1/kill', ringSecret, { site: SITE, machine, sid: null });
    expect(result.status).toBe(200);
    expect(result.body).toMatchObject({ ok: true, closed: 2 });

    expect((await doorbell.waitFor('kill')).sid).toBe(null);
    expect((await host.waitFor('kill')).sid).toBe(null);
    expect((await doorbell.whenClosed).code).toBe(1000);
  });
});

describe('flood limits', () => {
  it('closes a socket that exceeds the per-connection message rate', async () => {
    const machine = machineId('flood');
    const viewer = await dialBrowser(viewerToken(machine), machine);
    await viewer.waitFor('hello');
    for (let i = 0; i < 130; i += 1) {
      viewer.send({ type: 'candidate', candidate: `candidate:${i}`, sdpMid: '0', sdpMLineIndex: 0 });
    }
    const closed = await viewer.whenClosed;
    expect(closed.code).toBe(4008);
    expect(viewer.frames.some((frame) => frame.code === 'rate_limited')).toBe(true);
  });

  it('refuses a frame over 64 KiB', async () => {
    const machine = machineId('oversize');
    const viewer = await dialBrowser(viewerToken(machine), machine);
    await viewer.waitFor('hello');
    viewer.send({ type: 'offer', sdp: 'x'.repeat(70000) });
    expect((await viewer.waitFor('error')).code).toBe('message_too_large');
    viewer.close();
  });

  it('refuses a binary frame', async () => {
    const machine = machineId('binary');
    const viewer = await dialBrowser(viewerToken(machine), machine);
    await viewer.waitFor('hello');
    // @ts-expect-error node's WebSocket accepts an ArrayBuffer; sendRaw is typed for strings
    viewer.sendRaw(new Uint8Array([1, 2, 3]));
    expect((await viewer.waitFor('error')).code).toBe('binary_unsupported');
    viewer.close();
  });
});

describe('golden signaling vectors, on the wire', () => {
  it('tells a host joining after a viewer who is already waiting', async () => {
    const machine = machineId('joinorder');
    // the real order: the viewer opens the page and waits, the api rings, and the
    // agent spawns a streamer that joins seconds later. the live `viewer-join`
    // fired before this host existed, and `hello` carries counts, not ids -- so
    // without a replay the host refuses the offer that follows as unknown_viewer.
    const doorbell = await dialAgent(doorbellToken(machine), machine);
    await doorbell.waitFor('hello');
    const viewer = await dialBrowser(viewerToken(machine), machine);
    const viewerHello = await viewer.waitFor('hello');

    const host = await dialAgent(hostToken(machine), machine);
    expect((await host.waitFor('hello')).role).toBe('host');
    const join = await host.waitFor('viewer-join');
    expect(join.viewer).toBe(viewerHello.id);

    // and only once: a replay must not double-announce a viewer that then joins
    // a second host, nor reach the doorbell.
    await settle();
    expect(host.frames.filter((frame) => frame.type === 'viewer-join')).toHaveLength(1);
    expect(doorbell.frames.some((frame) => frame.type === 'viewer-join')).toBe(false);

    host.close();
    viewer.close();
    doorbell.close();
  });

  it('round-trips every message type through a real room', async () => {
    const machine = machineId('goldenvector');
    // doorbell first, then host: the golden hello is the host’s, and its peer
    // counts say a doorbell was already attached.
    const doorbell = await dialAgent(doorbellToken(machine), machine);
    await doorbell.waitFor('hello');
    const host = await dialAgent(hostToken(machine), machine);

    // hello
    const helloVector = readVector<{ message: Frame }>('signaling/signal-hello.json');
    expect(stripTime(await host.waitFor('hello'))).toEqual(stripTime(helloVector.message));

    // viewer-join
    const viewer = await dialBrowser(viewerToken(machine), machine);
    await viewer.waitFor('hello');
    const joinVector = readVector<{ message: Frame }>('signaling/signal-viewer-join.json');
    expect(stripTime(await host.waitFor('viewer-join'))).toEqual(stripTime(joinVector.message));

    // offer: viewer -> host and doorbell
    const offerVector = readVector<{ message: Frame }>('signaling/signal-offer.json');
    viewer.send({ type: 'offer', sdp: offerVector.message.sdp });
    expect(stripTime(await host.waitFor('offer'))).toEqual(stripTime(offerVector.message));

    // candidate: viewer -> agent side
    const candidateVector = readVector<{ message: Frame }>('signaling/signal-candidate.json');
    const { from: _f, fromRole: _r, serverTimeMs: _t, ...candidateSent } = candidateVector.message;
    viewer.send(candidateSent);
    expect(stripTime(await host.waitFor('candidate'))).toEqual(stripTime(candidateVector.message));

    // the doorbell is a notification socket: `ring` and `error` only. session
    // traffic used to reach it, and an sdp offer is over its frame limit -- so
    // it dropped the socket the next ring had to arrive on.
    await settle();
    expect(doorbell.frames.some((frame) => frame.type === 'viewer-join')).toBe(false);
    expect(doorbell.frames.some((frame) => frame.type === 'offer')).toBe(false);
    expect(doorbell.frames.some((frame) => frame.type === 'candidate')).toBe(false);

    // answer: host -> the named viewer only
    const answerVector = readVector<{ message: Frame }>('signaling/signal-answer.json');
    const { from: _af, fromRole: _ar, serverTimeMs: _at, ...answerSent } = answerVector.message;
    host.send(answerSent);
    expect(stripTime(await viewer.waitFor('answer'))).toEqual(stripTime(answerVector.message));
    await settle();
    expect(doorbell.frames.some((frame) => frame.type === 'answer')).toBe(false);

    // host-ready: host -> the named viewer
    const readyVector = readVector<{ message: Frame }>('signaling/signal-host-ready.json');
    const { from: _hf, fromRole: _hr, serverTimeMs: _ht, ...readySent } = readyVector.message;
    host.send(readySent);
    expect(stripTime(await viewer.waitFor('host-ready'))).toEqual(stripTime(readyVector.message));

    // error: a client that sends a server-only type
    const killVector = readVector<{ message: Frame }>('signaling/signal-viewer-sends-kill.json');
    viewer.send(killVector.message);
    expect(stripTime(await viewer.waitFor('error'))).toEqual({ type: 'error', code: 'forbidden_type' });

    // wrong_role: a viewer that answers
    const wrongRole = readVector<{ message: Frame }>('signaling/signal-viewer-sends-answer.json');
    viewer.send(wrongRole.message);
    const errors = viewer.frames.filter((frame) => frame.type === 'error');
    await settle();
    expect(viewer.frames.filter((frame) => frame.type === 'error').length).toBe(errors.length + 1);
    expect(viewer.frames.filter((frame) => frame.type === 'error').pop()?.code).toBe('wrong_role');

    // bye: viewer -> agent side, then the socket closes
    const byeVector = readVector<{ message: Frame }>('signaling/signal-bye.json');
    viewer.send({ type: 'bye', reason: byeVector.message.reason });
    expect(stripTime(await host.waitFor('bye'))).toEqual(stripTime(byeVector.message));
    await viewer.whenClosed;

    // ring: server-originated, to doorbell sockets only
    const ringVector = readVector<{ message: Frame }>('signaling/signal-ring.json');
    await serverCall(baseUrl, '/v1/ring', ringSecret, { site: SITE, machine, sid: ringVector.message.sid });
    const ring = await doorbell.waitFor('ring');
    expect(ring.sid).toBe(ringVector.message.sid);
    expect(Object.keys(ring).sort()).toEqual(['sentAtMs', 'serverTimeMs', 'sid', 'type']);
    await settle();
    expect(host.frames.some((frame) => frame.type === 'ring')).toBe(false);

    // kill: server-originated, to every socket, then close(1000)
    const killFrameVector = readVector<{ message: Frame }>('signaling/signal-kill.json');
    await serverCall(baseUrl, '/v1/kill', ringSecret, { site: SITE, machine, sid: killFrameVector.message.sid });
    expect(stripTime(await doorbell.waitFor('kill'))).toEqual(stripTime(killFrameVector.message));
    expect(stripTime(await host.waitFor('kill'))).toEqual(stripTime(killFrameVector.message));
    expect((await host.whenClosed).code).toBe(1000);
  });
});
