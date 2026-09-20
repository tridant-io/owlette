// Spike 0.4 measurement pass: browser -> DO -> doorbell, end to end.
//
//   node scripts/measure.mjs                              # local wrangler dev
//   node scripts/measure.mjs --remote https://<worker-origin>
//
// The node half stands in for the browser (same WebSocket handshake, same
// subprotocol-carried token); the python half is the real websocket-client
// doorbell. One-way numbers subtract a python wall-clock stamp from a node one:
// on Windows both read GetSystemTimePreciseAsFileTime, so they share a clock.

import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { join } from 'node:path';

import { ROOT, claimsFor, connect, loadKeys, serverCall, signToken, startWorker } from '../test/harness.mjs';

const SITE = 'spikesite';
const MACHINE = 'spikemachine';
const LOCAL_PORT = 8789;
const HOP_SAMPLES = 200;
const HOP_INTERVAL_MS = 20;
const RING_INTERVAL_MS = 150;
const FLOOD_RINGS = 25;
const IDLE_BEFORE_COLD_RING_MS = 20000;

const remote = process.argv.includes('--remote')
  ? process.argv[process.argv.indexOf('--remote') + 1].replace(/\/$/, '')
  : null;

const { keys, ringSecret } = loadKeys();
const signer = { kid: keys[0].kid, privateKeyPem: keys[0].privateKeyPem };

function percentile(samples, fraction) {
  const sorted = [...samples].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.ceil(fraction * sorted.length) - 1)];
}

function summarize(samples) {
  return {
    n: samples.length,
    p50: Number(percentile(samples, 0.5).toFixed(2)),
    p95: Number(percentile(samples, 0.95).toFixed(2)),
    min: Number(Math.min(...samples).toFixed(2)),
    max: Number(Math.max(...samples).toFixed(2)),
  };
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function startPython(wsUrl) {
  const directory = join(ROOT, '..', 'doorbell-py');
  const executable =
    process.platform === 'win32' ? join(directory, '.venv', 'Scripts', 'python.exe') : join(directory, '.venv', 'bin', 'python');
  const child = spawn(executable, ['run_doorbell.py'], { cwd: directory, stdio: ['pipe', 'pipe', 'inherit'] });

  const events = [];
  let waiters = [];
  createInterface({ input: child.stdout }).on('line', (line) => {
    const event = JSON.parse(line);
    events.push(event);
    waiters = waiters.filter((waiter) => {
      if (waiter.name !== event.event) return true;
      waiter.resolve(event);
      return false;
    });
  });

  const waitFor = (name, timeoutMs = 20000) => {
    const existing = events.find((event) => event.event === name);
    if (existing) return Promise.resolve(existing);
    return new Promise((resolve, reject) => {
      const waiter = { name, resolve };
      waiters.push(waiter);
      setTimeout(() => {
        waiters = waiters.filter((candidate) => candidate !== waiter);
        reject(new Error(`python did not emit "${name}"`));
      }, timeoutMs).unref();
    });
  };

  child.stdin.write(
    `${JSON.stringify({
      url: `${wsUrl}/v1/room/${SITE}/${MACHINE}`,
      doorbellToken: signToken(claimsFor('doorbell'), signer),
      hostToken: signToken(claimsFor('host'), signer),
    })}\n`
  );

  return {
    events,
    waitFor,
    count: (name) => events.filter((event) => event.event === name).length,
    stop: async () => {
      child.stdin.write(`${JSON.stringify({ type: 'stop' })}\n`);
      child.stdin.end();
      await new Promise((resolve) => child.once('exit', resolve));
    },
  };
}

async function ringPass(baseUrl, python, samples) {
  const latencies = [];
  for (let i = 0; i < samples; i += 1) {
    const before = python.count('ring');
    const result = await serverCall(baseUrl, '/v1/ring', ringSecret, {
      site: SITE,
      machine: MACHINE,
      sid: `measure-${i}`,
      sentAtMs: Date.now(),
    });
    if (result.status !== 200) throw new Error(`ring ${i} refused: ${result.body.code}`);
    for (let waited = 0; python.count('ring') === before && waited < 5000; waited += 5) await sleep(5);
    const event = python.events.filter((candidate) => candidate.event === 'ring').at(-1);
    latencies.push(event.latencyMs);
    await sleep(RING_INTERVAL_MS);
  }
  return summarize(latencies);
}

async function roomPass(viewer, python) {
  const hopBefore = python.count('hop');
  for (let seq = 0; seq < HOP_SAMPLES; seq += 1) {
    viewer.send({ type: 'candidate', seq, sentAtMs: Date.now(), candidate: 'a=candidate:spike 1 udp 1 127.0.0.1 1 typ host' });
    await sleep(HOP_INTERVAL_MS);
  }
  for (let waited = 0; python.count('hop') < hopBefore + HOP_SAMPLES && waited < 10000; waited += 20) await sleep(20);
  const hops = python.events.filter((event) => event.event === 'hop').slice(-HOP_SAMPLES);

  const roundTrips = [];
  for (let seq = 0; seq < HOP_SAMPLES; seq += 1) {
    const startedAt = performance.now();
    viewer.messages.length = 0;
    viewer.send({ type: 'offer', seq, sdp: 'spike' });
    await viewer.waitFor('answer');
    roundTrips.push(performance.now() - startedAt);
    await sleep(HOP_INTERVAL_MS);
  }

  return { oneWay: summarize(hops.map((event) => event.latencyMs)), roundTrip: summarize(roundTrips) };
}

async function floodPass(baseUrl, python) {
  const before = python.count('ring');
  const results = [];
  for (let i = 0; i < FLOOD_RINGS; i += 1) {
    results.push(
      await serverCall(baseUrl, '/v1/ring', ringSecret, { site: SITE, machine: MACHINE, sid: `flood-${i}`, sentAtMs: Date.now() })
    );
  }
  await sleep(500);
  return {
    sent: FLOOD_RINGS,
    accepted: results.filter((result) => result.status === 200).length,
    capped: results.filter((result) => result.status === 429).length,
    cap: results[0].body.cap,
    windowMs: results[0].body.windowMs,
    deliveredToPython: python.count('ring') - before,
  };
}

async function main() {
  const worker = remote
    ? { baseUrl: remote, wsUrl: remote.replace(/^http/, 'ws'), health: await (await fetch(`${remote}/health`)).json(), stop: async () => {} }
    : await startWorker({ port: LOCAL_PORT, vars: { SWOOP_RING_CAP: 100000 } });

  const report = { target: remote ?? `local wrangler dev :${LOCAL_PORT}`, health: worker.health };

  try {
    const python = startPython(worker.wsUrl);
    await python.waitFor('ready');
    const viewer = await connect(worker.wsUrl, signToken(claimsFor('viewer', { viewer: 'measure1', ctl: true }), signer), {
      site: SITE,
      machine: MACHINE,
    });
    await viewer.waitFor('hello');

    // Remote runs against the shipped cap, so the flood goes first and the ring
    // pass waits out the window; the local run raises the cap and needs neither.
    if (remote) {
      report.ringFlood = await floodPass(worker.baseUrl, python);
      report.ringFloodNote = `waited ${report.ringFlood.windowMs} ms for the ring window to clear`;
      await sleep(report.ringFlood.windowMs + 1000);
    }

    report.ringLatencyMs = await ringPass(worker.baseUrl, python, remote ? report.ringFlood.cap : HOP_SAMPLES);
    const room = await roomPass(viewer, python);
    report.roomHopMs = room.oneWay;
    report.roomRoundTripMs = room.roundTrip;

    await sleep(IDLE_BEFORE_COLD_RING_MS);
    const coldBefore = python.count('ring');
    const coldSentAt = Date.now();
    await serverCall(worker.baseUrl, '/v1/ring', ringSecret, { site: SITE, machine: MACHINE, sid: 'cold', sentAtMs: coldSentAt });
    for (let waited = 0; python.count('ring') === coldBefore && waited < 10000; waited += 5) await sleep(5);
    report.idleRing = {
      idleMs: IDLE_BEFORE_COLD_RING_MS,
      latencyMs: Number(python.events.filter((event) => event.event === 'ring').at(-1).latencyMs.toFixed(2)),
    };

    viewer.close();
    await python.stop();
  } finally {
    await worker.stop();
  }

  if (!remote) {
    // Second boot at the shipped cap: the flood must be measured against the
    // default, not against the raised cap the latency pass needed.
    const capped = await startWorker({ port: LOCAL_PORT });
    try {
      const python = startPython(capped.wsUrl);
      await python.waitFor('ready');
      report.ringFlood = await floodPass(capped.baseUrl, python);
      await python.stop();
    } finally {
      await capped.stop();
    }
  }

  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
}

await main();
