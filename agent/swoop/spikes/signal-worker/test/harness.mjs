// Shared test/measurement plumbing: boot `wrangler dev`, mint spike tokens, and
// drive the room with node's built-in WebSocket (no client dependency).

import { spawn, spawnSync } from 'node:child_process';
import { createPrivateKey, randomBytes, sign } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { request as httpRequest } from 'node:http';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

export function loadKeys() {
  const path = join(ROOT, 'testdata', 'keys.json');
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    throw new Error('testdata/keys.json missing — run `npm run keys` first');
  }
}

function base64url(value) {
  return Buffer.from(value).toString('base64url');
}

export function signToken(claims, { kid, privateKeyPem }) {
  const header = base64url(JSON.stringify({ alg: 'EdDSA', typ: 'JWT', kid }));
  const payload = base64url(JSON.stringify(claims));
  const signed = `${header}.${payload}`;
  const signature = sign(null, Buffer.from(signed), createPrivateKey(privateKeyPem));
  return `${signed}.${base64url(signature)}`;
}

export function claimsFor(role, overrides = {}) {
  const now = Math.floor(Date.now() / 1000);
  return {
    iss: 'owlette-api',
    aud: 'swoop-signal',
    role,
    site: 'spikesite',
    machine: 'spikemachine',
    sid: role === 'doorbell' ? undefined : 'spikesid',
    iat: now,
    exp: now + 60,
    ...overrides,
  };
}

export async function startWorker({ port, vars = {} }) {
  // The bin script is run through node directly: since the CVE-2024-27980 fix,
  // spawning a .cmd shim on Windows without a shell fails with EINVAL.
  const child = spawn(
    process.execPath,
    [
      join(ROOT, 'node_modules', 'wrangler', 'bin', 'wrangler.js'),
      'dev',
      '--ip',
      '127.0.0.1',
      '--port',
      String(port),
      '--log-level',
      'warn',
      ...Object.entries(vars).flatMap(([name, value]) => ['--var', `${name}:${value}`]),
    ],
    { cwd: ROOT, env: { ...process.env, CI: '1', WRANGLER_SEND_METRICS: 'false' }, stdio: 'ignore' }
  );

  const baseUrl = `http://127.0.0.1:${port}`;
  const deadline = Date.now() + 60000;
  for (;;) {
    if (Date.now() > deadline) {
      await stopWorker(child);
      throw new Error('wrangler dev did not become ready within 60s');
    }
    try {
      const response = await fetch(`${baseUrl}/health`, { signal: AbortSignal.timeout(2000) });
      const body = await response.json();
      if (body.ok) {
        return { port, baseUrl, wsUrl: `ws://127.0.0.1:${port}`, health: body, stop: () => stopWorker(child) };
      }
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
  }
}

// wrangler's node process is only the front end: workerd and esbuild are separate
// binaries under this project's node_modules, and killing the tree still leaves one
// behind often enough to matter over a run that boots the worker twice. The sweep
// is scoped to command lines under THIS directory — other projects on the machine
// run their own wrangler and must not be touched.
function sweepStrays() {
  if (process.platform !== 'win32') return;
  spawnSync(
    'powershell',
    [
      '-NoProfile',
      '-Command',
      `Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -and $_.CommandLine -like '*${ROOT}\\node_modules\\*' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }`,
    ],
    { stdio: 'ignore' }
  );
}

async function stopWorker(child) {
  await new Promise((resolve) => {
    child.once('exit', () => resolve());
    if (process.platform === 'win32') {
      spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
    } else {
      child.kill('SIGTERM');
    }
    setTimeout(resolve, 5000).unref();
  });
  sweepStrays();
}

// A viewer is a browser and cannot set handshake headers, so its token rides in a
// second subprotocol. The agent is not a browser and uses the Authorization header.
export class Client {
  constructor(socket) {
    this.socket = socket;
    this.messages = [];
    this.waiters = [];
    this.closed = null;
    this.whenClosed = new Promise((resolve) => {
      this.resolveClosed = resolve;
    });
    socket.addEventListener('message', (event) => {
      // The hibernation auto-response is a bare string, not a framed message.
      const message = event.data.startsWith('{') ? JSON.parse(event.data) : { type: event.data };
      this.messages.push(message);
      this.waiters = this.waiters.filter((waiter) => {
        if (!waiter.match(message)) return true;
        waiter.resolve(message);
        return false;
      });
    });
    socket.addEventListener('close', (event) => {
      this.closed = { code: event.code, reason: event.reason };
      this.resolveClosed(this.closed);
    });
  }

  waitFor(type, timeoutMs = 10000) {
    const match = (message) => message.type === type;
    const existing = this.messages.find(match);
    if (existing) return Promise.resolve(existing);
    return new Promise((resolve, reject) => {
      const waiter = { match, resolve };
      this.waiters.push(waiter);
      setTimeout(() => {
        this.waiters = this.waiters.filter((candidate) => candidate !== waiter);
        reject(new Error(`timed out waiting for "${type}"`));
      }, timeoutMs).unref();
    });
  }

  send(message) {
    this.socket.send(JSON.stringify(message));
  }

  close() {
    this.socket.close();
  }
}

export function connect(wsUrl, token, { site = 'spikesite', machine = 'spikemachine', viaHeader = false } = {}) {
  const url = `${wsUrl}/v1/room/${site}/${machine}`;
  const socket = viaHeader
    ? new WebSocket(url, { headers: { Authorization: `Bearer ${token}` } })
    : new WebSocket(url, ['owlette.swoop.v1', `jwt.${token}`]);
  const client = new Client(socket);
  return new Promise((resolve, reject) => {
    socket.addEventListener('open', () => resolve(client));
    socket.addEventListener('error', () => reject(new Error('websocket handshake failed')));
  });
}

// A refused upgrade answers with an ordinary JSON body carrying the error code.
// node's fetch will not send an Upgrade header, so the handshake is issued raw.
export function upgradeStatus(port, token, { site = 'spikesite', machine = 'spikemachine' } = {}) {
  return new Promise((resolve, reject) => {
    const request = httpRequest(
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
        },
      },
      (response) => {
        let body = '';
        response.on('data', (chunk) => {
          body += chunk;
        });
        response.on('end', () => resolve({ status: response.statusCode, body: JSON.parse(body) }));
      }
    );
    request.on('upgrade', (response, socket) => {
      socket.destroy();
      resolve({ status: response.statusCode, body: null });
    });
    request.on('error', reject);
    request.end();
  });
}

export async function serverCall(baseUrl, path, secret, body) {
  const response = await fetch(`${baseUrl}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-swoop-ring-secret': secret },
    body: JSON.stringify(body),
  });
  return { status: response.status, body: await response.json() };
}
