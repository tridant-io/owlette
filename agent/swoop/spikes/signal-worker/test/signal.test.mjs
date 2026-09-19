import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';

import { claimsFor, connect, loadKeys, serverCall, signToken, startWorker, upgradeStatus } from './harness.mjs';

const PORT = 8788;
const { keys, ringSecret } = loadKeys();
const [k1, k2] = keys;

let worker;

function viewerToken(overrides = {}, key = k1) {
  return signToken(claimsFor('viewer', { viewer: 'viewer1', ctl: true, ...overrides }), {
    kid: key.kid,
    privateKeyPem: key.privateKeyPem,
  });
}

before(async () => {
  worker = await startWorker({ port: PORT });
}, { timeout: 90000 });

after(async () => {
  await worker.stop();
});

describe('health + keyset', () => {
  it('reports the algorithm identifier workerd accepted for Ed25519', () => {
    assert.equal(worker.health.ok, true);
    assert.equal(worker.health.ed25519Algorithm, 'Ed25519');
  });

  it('holds two active kids so a rotation is not a flag day', () => {
    assert.deepEqual(worker.health.kids, [k1.kid, k2.kid]);
  });
});

describe('token verification', () => {
  it('accepts either active key', async () => {
    for (const key of [k1, k2]) {
      const client = await connect(worker.wsUrl, viewerToken({ viewer: `viewer-${key.kid}` }, key));
      const hello = await client.waitFor('hello');
      assert.equal(hello.role, 'viewer');
      client.close();
    }
  });

  it('refuses a missing, malformed, unknown-kid, expired or wrong-audience token', async () => {
    const now = Math.floor(Date.now() / 1000);
    const cases = [
      [null, 401, 'missing_token'],
      ['not-a-jwt', 403, 'malformed_token'],
      [signToken(claimsFor('viewer', { viewer: 'v' }), { kid: 'retired-k0', privateKeyPem: k1.privateKeyPem }), 403, 'unknown_kid'],
      [viewerToken({ exp: now - 120, iat: now - 180 }), 403, 'expired'],
      [viewerToken({ aud: 'swoop-host' }), 403, 'bad_audience'],
      [viewerToken({ iss: 'someone-else' }), 403, 'bad_issuer'],
      [viewerToken({ exp: now + 86400 }), 403, 'ttl_too_long'],
    ];
    for (const [token, status, code] of cases) {
      const result = await upgradeStatus(worker.port, token);
      assert.equal(result.status, status, `status for ${code}`);
      assert.equal(result.body.code, code);
    }
  });

  it('refuses a token signed by a key the keyset does not hold', async () => {
    const forged = signToken(claimsFor('viewer', { viewer: 'v' }), {
      kid: k1.kid,
      privateKeyPem: k2.privateKeyPem,
    });
    const result = await upgradeStatus(worker.port, forged);
    assert.equal(result.body.code, 'bad_signature');
  });
});

describe('room addressing', () => {
  it('refuses a path that disagrees with the token claims', async () => {
    const result = await upgradeStatus(worker.port, viewerToken(), { machine: 'someone-elses-machine' });
    assert.equal(result.status, 403);
    assert.equal(result.body.code, 'room_mismatch');
  });

  // The room is named from the claims, so a viewer holding a token for machine A
  // lands in A's room whatever it asks for — proven by the doorbell for A hearing it.
  it('lands a viewer in the room its claims name', async () => {
    const doorbell = await connect(worker.wsUrl, signToken(claimsFor('doorbell'), k1Signer()), {
      viaHeader: true,
    });
    await doorbell.waitFor('hello');
    const viewer = await connect(worker.wsUrl, viewerToken({ viewer: 'viewer-addr' }));
    const announcement = await doorbell.waitFor('viewer-join');
    assert.equal(announcement.viewer, 'viewer-addr');
    viewer.close();
    doorbell.close();
  });
});

function k1Signer() {
  return { kid: k1.kid, privateKeyPem: k1.privateKeyPem };
}

function hostToken(overrides = {}) {
  return signToken(claimsFor('host', overrides), k1Signer());
}

describe('room fan-out', () => {
  it('routes viewer traffic to the agent side and never to another viewer', async () => {
    const host = await connect(worker.wsUrl, hostToken(), { viaHeader: true });
    await host.waitFor('hello');
    const viewerA = await connect(worker.wsUrl, viewerToken({ viewer: 'viewerA' }));
    const viewerB = await connect(worker.wsUrl, viewerToken({ viewer: 'viewerB' }));
    await Promise.all([viewerA.waitFor('hello'), viewerB.waitFor('hello')]);

    viewerA.send({ type: 'offer', sdp: 'spike-offer' });
    const offer = await host.waitFor('offer');
    assert.equal(offer.from, 'viewerA');
    assert.equal(viewerB.messages.some((message) => message.type === 'offer'), false);

    host.send({ type: 'host-ready' });
    await Promise.all([viewerA.waitFor('host-ready'), viewerB.waitFor('host-ready')]);

    host.send({ type: 'answer', to: 'viewerA', sdp: 'spike-answer' });
    const answer = await viewerA.waitFor('answer');
    assert.equal(answer.sdp, 'spike-answer');
    assert.equal(viewerB.messages.some((message) => message.type === 'answer'), false);

    viewerA.close();
    viewerB.close();
    host.close();
  });

  // A bare "ping" is not JSON, so had it reached webSocketMessage the answer
  // would have been an error frame. "pong" proves the runtime answered it without
  // waking the object — the property the whole idle-cost model rests on.
  it('answers an app-level keepalive without waking the room', async () => {
    const viewer = await connect(worker.wsUrl, viewerToken({ viewer: 'viewer-ping' }));
    await viewer.waitFor('hello');
    viewer.socket.send('ping');
    assert.equal((await viewer.waitFor('pong')).type, 'pong');
    viewer.close();
  });

  it('refuses server-only message types and wrong-role messages from a client', async () => {
    const viewer = await connect(worker.wsUrl, viewerToken({ viewer: 'viewer-guard' }));
    await viewer.waitFor('hello');
    viewer.send({ type: 'ring', sid: 'spikesid' });
    assert.equal((await viewer.waitFor('error')).code, 'forbidden_type');
    viewer.messages.length = 0;
    viewer.send({ type: 'answer', sdp: 'x' });
    assert.equal((await viewer.waitFor('error')).code, 'wrong_role');
    viewer.close();
  });
});

describe('ring and kill', () => {
  it('refuses a ring without the shared secret', async () => {
    const result = await serverCall(worker.baseUrl, '/v1/ring', 'wrong-secret', {
      site: 'spikesite',
      machine: 'spikemachine',
      sid: 'spikesid',
    });
    assert.equal(result.status, 401);
    assert.equal(result.body.code, 'bad_ring_secret');
  });

  it('wakes an idle doorbell socket', async () => {
    const doorbell = await connect(worker.wsUrl, signToken(claimsFor('doorbell'), k1Signer()), {
      viaHeader: true,
    });
    await doorbell.waitFor('hello');
    const result = await serverCall(worker.baseUrl, '/v1/ring', ringSecret, {
      site: 'spikesite',
      machine: 'spikemachine',
      sid: 'ring-test-sid',
    });
    assert.equal(result.body.delivered, 1);
    const ring = await doorbell.waitFor('ring');
    assert.equal(ring.sid, 'ring-test-sid');
    doorbell.close();
  });

  it('caps a ring flood per machine', async () => {
    const machine = 'floodmachine';
    const results = [];
    for (let i = 0; i < 25; i += 1) {
      results.push(await serverCall(worker.baseUrl, '/v1/ring', ringSecret, { site: 'spikesite', machine, sid: `s${i}` }));
    }
    const accepted = results.filter((result) => result.status === 200).length;
    const capped = results.filter((result) => result.status === 429).length;
    assert.equal(accepted, results[0].body.cap);
    assert.equal(capped, 25 - accepted);
    assert.equal(results.at(-1).body.code, 'ring_capped');
  });

  it('closes every socket in the room on kill', async () => {
    const machine = 'killmachine';
    const options = { machine };
    const host = await connect(
      worker.wsUrl,
      signToken(claimsFor('host', { machine }), k1Signer()),
      { ...options, viaHeader: true }
    );
    const viewer = await connect(
      worker.wsUrl,
      signToken(claimsFor('viewer', { machine, viewer: 'viewer-kill', ctl: true }), k1Signer()),
      options
    );
    await Promise.all([host.waitFor('hello'), viewer.waitFor('hello')]);

    const result = await serverCall(worker.baseUrl, '/v1/kill', ringSecret, {
      site: 'spikesite',
      machine,
      sid: 'spikesid',
    });
    assert.equal(result.body.closed, 2);
    await Promise.all([host.waitFor('kill'), viewer.waitFor('kill')]);
    const closes = await Promise.all([host.whenClosed, viewer.whenClosed]);
    assert.deepEqual(closes.map((close) => close.code), [1000, 1000]);
  });
});
