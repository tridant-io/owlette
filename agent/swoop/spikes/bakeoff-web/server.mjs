#!/usr/bin/env node
// swoop spike 0.2 — video-path bake-off, browser half: the local server.
//
// Serves the page and takes its run as JSON so the numbers land on disk instead
// of on a screen a human has to read. No dependencies and no package.json, for
// the same reason spike 0.1's server has none: this is a measurement fixture,
// and anything between the request and the response is unmeasured latency in a
// latency harness.
//
//   cd agent/swoop/spikes/bakeoff-web
//   node server.mjs                        # http://127.0.0.1:17440/
//   node server.mjs --port 17440 --out runs --host 0.0.0.0
//
// Routes:
//   GET  /                     the page
//   GET  /bakeoff.js           the harness
//   GET  /receivers/*.js       the seam, its three arms and arm C's worker
//   GET  /health               {"ok":true}
//   GET  /progress?m=…         the page's own log, echoed to this server's stdout
//   POST /result               a run; written to <out>/<arm>-<placement>-<codec>-<stamp>.json
//
// The signalling and QPC endpoints are NOT here — they are `bakeoff-host.exe`
// on 127.0.0.1:17441, because the clock offset has to be measured against the
// process that owns QueryPerformanceCounter, not against a node process with a
// third clock of its own.

import { createServer } from 'node:http';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));

function parseArgs(argv) {
  const args = { port: 17440, out: 'runs', host: '127.0.0.1' };
  for (let i = 0; i < argv.length; i += 2) {
    const value = argv[i + 1];
    if (argv[i] === '--port') args.port = Number(value) || args.port;
    else if (argv[i] === '--out') args.out = value || args.out;
    else if (argv[i] === '--host') args.host = value || args.host;
    else {
      console.error(`server.mjs: unknown flag ${argv[i]}`);
      process.exit(64);
    }
  }
  return args;
}

// Whitelisted, so no request can reach outside public/.
const STATIC = new Map([
  ['/', ['public/index.html', 'text/html; charset=utf-8']],
  ['/index.html', ['public/index.html', 'text/html; charset=utf-8']],
  ['/bakeoff.js', ['public/bakeoff.js', 'text/javascript; charset=utf-8']],
  ['/receivers/receiver.js', ['public/receivers/receiver.js', 'text/javascript; charset=utf-8']],
  ['/receivers/rtp-track.js', ['public/receivers/rtp-track.js', 'text/javascript; charset=utf-8']],
  ['/receivers/data-channel.js', ['public/receivers/data-channel.js', 'text/javascript; charset=utf-8']],
  [
    '/receivers/script-transform.js',
    ['public/receivers/script-transform.js', 'text/javascript; charset=utf-8'],
  ],
  // Arm C's `RTCRtpScriptTransform` worker. Same origin as the page, which is
  // what `new Worker()` requires.
  [
    '/receivers/transform-worker.js',
    ['public/receivers/transform-worker.js', 'text/javascript; charset=utf-8'],
  ],
  ['/receivers/webcodecs.js', ['public/receivers/webcodecs.js', 'text/javascript; charset=utf-8']],
]);

function safeName(part, fallback) {
  return (
    String(part ?? fallback)
      .replace(/[^a-z0-9._-]/gi, '-')
      .slice(0, 40) || fallback
  );
}

async function readBody(req, limit = 64 * 1024 * 1024) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) throw new Error(`body over ${limit} bytes`);
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString('utf8');
}

const args = parseArgs(process.argv.slice(2));
const outDir = resolve(here, args.out);

const server = createServer(async (req, res) => {
  const url = new URL(req.url, 'http://127.0.0.1');
  const path = url.pathname;

  // The page beacons every line it prints here, so a run that stalls can be
  // told from one that is merely slow — and a run that fails leaves its reason
  // on the server's stdout instead of only in a browser window nobody is
  // watching. Spike 0.9 lost a run to exactly that.
  if (req.method === 'GET' && path === '/progress') {
    console.log(`[page] ${url.searchParams.get('m') ?? ''}`);
    res.writeHead(204);
    res.end();
    return;
  }

  if (req.method === 'GET' && path === '/health') {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok: true, out: outDir }));
    return;
  }

  if (req.method === 'GET' && STATIC.has(path)) {
    const [file, type] = STATIC.get(path);
    try {
      const body = await readFile(join(here, file));
      res.writeHead(200, { 'content-type': type, 'cache-control': 'no-store' });
      res.end(body);
    } catch (err) {
      res.writeHead(500, { 'content-type': 'text/plain' });
      res.end(String(err.message));
    }
    return;
  }

  if (req.method === 'POST' && path === '/result') {
    try {
      const parsed = JSON.parse(await readBody(req));
      const stamp = new Date().toISOString().replace(/[:.]/g, '-');
      const name = [
        `arm${safeName(parsed.arm, 'x')}`,
        safeName(parsed.placement, 'unknown'),
        safeName(parsed.host?.codec, 'codec'),
        // Arm A's reliability mode is part of the row's identity, so it is part
        // of the file name: three runs of arm A that differ only in mode would
        // otherwise be told apart only by their timestamps.
        ...(parsed.dcMode ? [safeName(parsed.dcMode, 'mode')] : []),
        safeName(parsed.label, 'run'),
        stamp,
      ].join('-');
      await mkdir(outDir, { recursive: true });
      const target = join(outDir, `${name}.json`);
      await writeFile(target, JSON.stringify(parsed, null, 2), 'utf8');
      console.log(`result: ${target}`);
      if (parsed.rankingOnly) {
        console.log('  placement "same-machine": ranking only, never a product latency (0.1 §2.2)');
      }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ written: target }));
    } catch (err) {
      console.error(`result rejected: ${err.message}`);
      res.writeHead(400, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: err.message }));
    }
    return;
  }

  res.writeHead(404, { 'content-type': 'text/plain' });
  res.end('not found');
});

server.listen(args.port, args.host, () => {
  console.log(`page:        http://${args.host}:${args.port}/`);
  console.log(`results dir: ${outDir}`);
});
