#!/usr/bin/env node
// swoop-clarity task 2.5: the smooth-probe page server.
//
// serves the probe page and the renderer it measures, and takes each run as
// json so the numbers land on disk. the renderer is the shipped
// web/lib/swoop/video/smooth.ts, stripped of its types on every request by
// node's own stripTypeScriptTypes, never a copy: what the probe measures is
// what ships (plan C16). no dependencies and no package.json, like spike
// 2.12's browser-matrix, so it runs from a plain checkout on the MBA and the
// kiosk VM. needs node 22.13 or later.
//
//   cd agent/swoop/spikes/smooth-probe
//   node server.mjs                        # http://127.0.0.1:17460/
//   node server.mjs --port 17460 --host 0.0.0.0
//
// routes:
//   GET  /                     the probe page (its query parameters: public/probe.js)
//   GET  /probe.js             the harness
//   GET  /clock.html           a millisecond clock and barcode, for glass-to-glass checks
//   GET  /smooth.js            web/lib/swoop/video/smooth.ts, types stripped
//   GET  /health               {"ok":true}
//   GET  /progress?m=...       the page's own log, echoed to this server's stdout
//   POST /result               a run, written to runs/<label>-<stamp>.json

import { createServer } from 'node:http';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import * as nodeModule from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

if (typeof nodeModule.stripTypeScriptTypes !== 'function') {
  console.error(`server.mjs: needs node 22.13 or later for stripTypeScriptTypes; this is ${process.version}`);
  process.exit(1);
}

const here = dirname(fileURLToPath(import.meta.url));
const SMOOTH = resolve(here, '..', '..', '..', '..', 'web', 'lib', 'swoop', 'video', 'smooth.ts');
const runsDir = join(here, 'runs');

function parseArgs(argv) {
  const args = { port: 17460, host: '127.0.0.1' };
  for (let i = 0; i < argv.length; i += 2) {
    const value = argv[i + 1];
    if (argv[i] === '--port') args.port = Number(value) || args.port;
    else if (argv[i] === '--host') args.host = value || args.host;
    else {
      console.error(`server.mjs: unknown flag ${argv[i]}`);
      process.exit(64);
    }
  }
  return args;
}

// whitelisted, so no request can reach outside public/.
const STATIC = new Map([
  ['/', ['public/index.html', 'text/html; charset=utf-8']],
  ['/index.html', ['public/index.html', 'text/html; charset=utf-8']],
  ['/probe.js', ['public/probe.js', 'text/javascript; charset=utf-8']],
  ['/clock.html', ['public/clock.html', 'text/html; charset=utf-8']],
]);

function safeName(part) {
  return String(part ?? 'run').replace(/[^a-z0-9._-]/gi, '-').slice(0, 64) || 'run';
}

async function readBody(req, limit = 4 * 1024 * 1024) {
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

const server = createServer(async (req, res) => {
  const url = new URL(req.url, `http://${args.host}`);
  const path = url.pathname;

  if (req.method === 'GET' && path === '/health') {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok: true, runs: runsDir }));
    return;
  }

  // a module that fails to evaluate says so here, not in a devtools console
  // nobody has open (spike 0.2 lost a run to that).
  if (req.method === 'GET' && path === '/progress') {
    console.log(`page: ${url.searchParams.get('m') ?? ''}`);
    res.writeHead(204);
    res.end();
    return;
  }

  if (req.method === 'GET' && path === '/smooth.js') {
    try {
      const body = nodeModule.stripTypeScriptTypes(await readFile(SMOOTH, 'utf8'));
      res.writeHead(200, { 'content-type': 'text/javascript; charset=utf-8', 'cache-control': 'no-store' });
      res.end(body);
    } catch (err) {
      console.error(`smooth.js: ${err.message}`);
      res.writeHead(500, { 'content-type': 'text/plain' });
      res.end(String(err.message));
    }
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
      await mkdir(runsDir, { recursive: true });
      const target = join(runsDir, `${safeName(parsed.label)}-${stamp}.json`);
      await writeFile(target, JSON.stringify(parsed, null, 2), 'utf8');
      console.log(`result: ${target}`);
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
  console.log(`page:        http://${args.host === '0.0.0.0' ? '127.0.0.1' : args.host}:${args.port}/`);
  console.log(`renderer:    ${SMOOTH}`);
  console.log(`results dir: ${runsDir}`);
});
