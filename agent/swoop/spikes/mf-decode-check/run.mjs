#!/usr/bin/env node
// swoop spike 6.7 - does installed google chrome decode what the media
// foundation rungs emit?
//
// The ignored hardware tests in src/encode/mf write their annex-b streams when
// MF_ANNEXB_DIR is set. This serves page.html and those files on 127.0.0.1 (a
// secure context, so WebCodecs exists), opens installed chrome on it with a
// throwaway profile, and prints what the page decoded: every *.h264 in the
// directory, through VideoDecoder at each hardwareAcceleration setting. Exit 0
// only when every stream decoded every access unit at every setting.
//
//   cd agent/swoop
//   set MF_ANNEXB_DIR=C:\mf-annexb        (an existing, empty directory)
//   cargo test --release --lib -- --ignored encode::mf --test-threads=1
//   node spikes/mf-decode-check/run.mjs C:\mf-annexb [--headed]
//
// No dependencies and no package.json, like the browser-matrix spike.
import { createServer } from 'node:http';
import { readFile, readdir, mkdtemp } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const dir = process.argv[2];
const headed = process.argv.includes('--headed');
const chrome = process.env.CHROME ?? 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
if (!dir) {
  console.error('usage: node run.mjs <annex-b dir> [--headed]');
  process.exit(64);
}
const streams = (await readdir(dir)).filter((name) => name.endsWith('.h264')).sort();

let finish;
const done = new Promise((resolve) => { finish = resolve; });
const server = createServer(async (req, res) => {
  if (req.method === 'POST' && req.url === '/result') {
    let body = '';
    for await (const chunk of req) body += chunk;
    res.end('ok');
    finish(JSON.parse(body));
    return;
  }
  if (req.url === '/streams') {
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify(streams));
    return;
  }
  // the page, or one of the listed streams, and nothing else
  const name = req.url === '/' ? null : decodeURIComponent(req.url.slice(1));
  if (name !== null && !streams.includes(name)) {
    res.statusCode = 404;
    res.end();
    return;
  }
  res.setHeader('content-type', name ? 'application/octet-stream' : 'text/html; charset=utf-8');
  res.end(await readFile(name ? join(dir, name) : join(here, 'page.html')));
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const url = `http://127.0.0.1:${server.address().port}/`;
const profile = await mkdtemp(join(tmpdir(), 'mf-decode-'));
const args = [`--user-data-dir=${profile}`, '--no-first-run', '--no-default-browser-check', url];
if (!headed) args.unshift('--headless=new');
const browser = spawn(chrome, args, { stdio: 'ignore' });
const timer = setTimeout(() => finish({ error: 'timed out' }), 120000);
const result = await done;
clearTimeout(timer);
browser.kill();
server.close();
console.log(result.userAgent ?? result.error);
for (const run of result.runs ?? []) {
  console.log(
    `${run.name} ${run.accel}: ${run.codec} supported=${run.supported} ` +
    `decoded ${run.framesOut}/${run.units} (${run.keys} key) ${run.size ?? ''} ` +
    `nonblack ${run.nonblack} panel ${JSON.stringify(run.firstPanelRgb)} ${run.decodeMs ?? '-'} ms ${run.error ?? ''}`,
  );
}
process.exit(result.runs?.length && result.runs.every((run) => run.framesOut === run.units && !run.error) ? 0 : 1);
