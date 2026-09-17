#!/usr/bin/env node
// swoop spike 0.1 - latency harness, browser half: the local server.
//
// Serves the probe page and takes its results as JSON so the numbers land on
// disk instead of on a screen a human has to read. No dependencies and no
// package.json on purpose: this is a measurement fixture, and anything between
// the request and the response is unmeasured latency in a latency harness.
//
//   cd agent/swoop/spikes/latency-probe-web
//   node server.mjs                      # http://127.0.0.1:17430/
//   node server.mjs --port 17430 --out runs
//
// Routes:
//   GET  /            the probe page
//   GET  /probe.js    the probe
//   GET  /health      {"ok":true}
//   POST /result      a probe run; written to <out>/<mode>-<timestamp>.json
//
// The QPC endpoint the page talks to for the clock offset is NOT here - it is
// `latency-target.exe clock` on 127.0.0.1:17431, because the offset has to be
// measured against the process that owns QueryPerformanceCounter, not against a
// node process with a third clock of its own.

import { createServer } from 'node:http';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));

function parseArgs(argv) {
  const args = { port: 17430, out: 'runs' };
  for (let i = 0; i < argv.length; i += 2) {
    const value = argv[i + 1];
    if (argv[i] === '--port') args.port = Number(value) || args.port;
    else if (argv[i] === '--out') args.out = value || args.out;
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
  ['/probe.js', ['public/probe.js', 'text/javascript; charset=utf-8']],
]);

function safeName(mode) {
  return String(mode ?? 'run').replace(/[^a-z0-9._-]/gi, '-').slice(0, 40) || 'run';
}

async function readBody(req, limit = 8 * 1024 * 1024) {
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
      const text = await readBody(req);
      const parsed = JSON.parse(text);
      const stamp = new Date().toISOString().replace(/[:.]/g, '-');
      const name = `${safeName(parsed.mode)}-${stamp}.json`;
      await mkdir(outDir, { recursive: true });
      const target = join(outDir, name);
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

server.listen(args.port, '127.0.0.1', () => {
  console.log(`probe page:  http://127.0.0.1:${args.port}/`);
  console.log(`results dir: ${outDir}`);
});
