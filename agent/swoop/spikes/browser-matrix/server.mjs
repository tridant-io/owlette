#!/usr/bin/env node
// swoop spike 2.12 - browser support matrix: the local page server.
//
// Serves the matrix page and its canned streams, and takes each run as JSON so
// the numbers land on disk rather than on a screen a human has to read back.
// No dependencies and no package.json, like spikes 0.1 and 0.2: this must run
// from a plain checkout on a mac the moment someone unzips it.
//
//   cd agent/swoop/spikes/browser-matrix
//   node server.mjs                        # http://127.0.0.1:17450/
//   node server.mjs --port 17450 --out runs --host 0.0.0.0
//
// Routes:
//   GET  /                     the page
//   GET  /matrix.js            the harness
//   GET  /streams/*            the canned encoded chunks and their indexes
//   GET  /health               {"ok":true}
//   GET  /progress?m=...       the page's own log, echoed to this server's stdout
//   POST /result               a run; written to <out>/<mode>-<label>-<stamp>.json
//
// There is no host process and no clock exchange here. Everything this spike
// measures is a property of the browser in front of it, so nothing needs a
// second clock and nothing needs a second machine.

import { createServer } from 'node:http';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));

function parseArgs(argv) {
  const args = { port: 17450, out: 'runs', host: '127.0.0.1' };
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
  ['/matrix.js', ['public/matrix.js', 'text/javascript; charset=utf-8']],
]);

const STREAM_TYPES = new Map([
  ['.json', 'application/json'],
  ['.h264', 'application/octet-stream'],
  ['.h265', 'application/octet-stream'],
]);

function safeName(part) {
  return String(part ?? 'run').replace(/[^a-z0-9._-]/gi, '-').slice(0, 48) || 'run';
}

async function readBody(req, limit = 16 * 1024 * 1024) {
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
  const url = new URL(req.url, `http://${args.host}`);
  const path = url.pathname;

  if (req.method === 'GET' && path === '/health') {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok: true, out: outDir }));
    return;
  }

  // The page's own log. A module that fails to evaluate says so on this stdout
  // instead of in a devtools console nobody has open - spike 0.2 lost a run to
  // exactly that.
  if (req.method === 'GET' && path === '/progress') {
    console.log(`page: ${url.searchParams.get('m') ?? ''}`);
    res.writeHead(204);
    res.end();
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

  if (req.method === 'GET' && path.startsWith('/streams/')) {
    const name = safeName(path.slice('/streams/'.length));
    const ext = name.slice(name.lastIndexOf('.'));
    if (!STREAM_TYPES.has(ext)) {
      res.writeHead(404, { 'content-type': 'text/plain' });
      res.end('not found');
      return;
    }
    try {
      const body = await readFile(join(here, 'public', 'streams', name));
      res.writeHead(200, { 'content-type': STREAM_TYPES.get(ext), 'cache-control': 'no-store' });
      res.end(body);
    } catch {
      res.writeHead(404, { 'content-type': 'text/plain' });
      res.end('not found');
    }
    return;
  }

  if (req.method === 'POST' && path === '/result') {
    try {
      const parsed = JSON.parse(await readBody(req));
      const stamp = new Date().toISOString().replace(/[:.]/g, '-');
      const name = `${safeName(parsed.mode)}-${safeName(parsed.label)}-${stamp}.json`;
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

server.listen(args.port, args.host, () => {
  console.log(`page:        http://${args.host === '0.0.0.0' ? '127.0.0.1' : args.host}:${args.port}/`);
  console.log(`results dir: ${outDir}`);
});
