#!/usr/bin/env node
// swoop-clarity task 2.5: drives the smooth-probe page in playwright's chromium
// and in edge. the page measures the shipped web/lib/swoop/video/smooth.ts,
// which server.mjs serves with its types stripped, never a copy.
//
//   cd agent/swoop/spikes/smooth-probe
//   node server.mjs                                       # in another terminal
//   node drive.mjs matrix --seconds 5 --source 1920x1080 --box 1000x562
//   node drive.mjs latency --shots 30 --source 3840x2160 --box 1300x731
//
// matrix   each cover (none, canvas, under) for --seconds, in playwright's
//          chromium (headless, on d3d11) and in edge (headed); prints each run
//          and whether a cover keeps the video's rvfc callbacks and
//          totalVideoFrames within 5% of cover=none, with droppedVideoFrames
//          rising by no more than 1% of frames.
// latency  --shots screenshots each with cover=none and cover=canvas, in edge
//          unless --engines says otherwise. each shot holds the barcode the
//          picture shows and the page's live one; live - shown is the time the
//          picture is behind, and the difference of the two covers' medians is
//          what the canvas adds.
//
// --engines chromium,edge picks the browsers; PROBE_URL points at another
// server (default http://127.0.0.1:17460). every page run lands in runs/
// through server.mjs, and latency posts its summary there too. playwright
// comes from web/node_modules: this probe installs nothing.

import { inflateSync } from 'node:zlib';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const repo = resolve(here, '..', '..', '..', '..');
const PAGE = process.env.PROBE_URL ?? 'http://127.0.0.1:17460';

// playwright-core is commonjs, so a dynamic import puts it on `default`;
// the named export only exists when the lexer finds it, and here it does not.
const pw = await import(pathToFileURL(join(repo, 'web', 'node_modules', 'playwright-core', 'index.js')).href);
const chromium = pw.chromium ?? pw.default.chromium;

const ENGINES = {
  // headless chromium falls back to swiftshader unless told to use the gpu.
  chromium: { headless: true, args: ['--use-angle=d3d11'] },
  edge: { headless: false, channel: 'msedge' },
};
const COVERS = ['none', 'canvas', 'under'];
const BITS = 16;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function usage(problem) {
  console.error(`drive.mjs: ${problem}`);
  console.error('usage: node drive.mjs matrix|latency [--seconds 5] [--source 1920x1080] [--box 1000x562] [--shots 30] [--engines chromium,edge]');
  process.exit(64);
}

function parseSize(text, name) {
  const match = /^(\d+)x(\d+)$/.exec(text ?? '');
  if (!match) usage(`${name} ${text}: expected WxH`);
  return [Number(match[1]), Number(match[2])];
}

function parseArgs(argv) {
  const mode = argv[0];
  if (mode !== 'matrix' && mode !== 'latency') usage('the first argument is matrix or latency');
  const args = {
    mode,
    seconds: 5,
    source: '1920x1080',
    box: '1000x562',
    shots: 30,
    engines: mode === 'latency' ? ['edge'] : ['chromium', 'edge'],
  };
  for (let i = 1; i < argv.length; i += 2) {
    const value = argv[i + 1];
    if (argv[i] === '--seconds') args.seconds = Number(value) || args.seconds;
    else if (argv[i] === '--source') args.source = value;
    else if (argv[i] === '--box') args.box = value;
    else if (argv[i] === '--shots') args.shots = Number(value) || args.shots;
    else if (argv[i] === '--engines') args.engines = String(value).split(',');
    else usage(`unknown flag ${argv[i]}`);
  }
  parseSize(args.source, '--source');
  parseSize(args.box, '--box');
  for (const engine of args.engines) if (!ENGINES[engine]) usage(`unknown engine ${engine}`);
  return args;
}

const args = parseArgs(process.argv.slice(2));
const [boxW, boxH] = parseSize(args.box, '--box');

/** one page run; `during` runs while the page is measuring. */
async function runPage(browser, { cover, seconds, label }, during) {
  // the picture, the strip under it and the state line, with room to spare.
  const context = await browser.newContext({ viewport: { width: boxW + 16, height: boxH + 140 } });
  try {
    const page = await context.newPage();
    page.on('console', (m) => {
      if (m.type() === 'error') console.error(`  console: ${m.text()}`);
    });
    const query = new URLSearchParams({ source: args.source, box: args.box, cover, seconds: String(seconds), label });
    await page.goto(`${PAGE}/?${query}`, { waitUntil: 'load' });
    const state = () => page.evaluate(() => document.getElementById('state')?.textContent ?? '');
    if (during) {
      await page.waitForFunction(() => /^(measuring|done|error)/.test(document.getElementById('state')?.textContent ?? ''), null, { timeout: 60000 });
      if ((await state()) === 'measuring') {
        await during(page);
        if ((await state()) !== 'measuring') throw new Error(`${label}: the page stopped measuring before the shots were done; raise --seconds`);
      }
    }
    await page.waitForFunction(() => /^(done|error)/.test(document.getElementById('state')?.textContent ?? ''), null, { timeout: (seconds + 90) * 1000 });
    const result = await page.evaluate(() => window.probeResult);
    if (!result || result.error) throw new Error(`${label}: ${result?.error ?? (await state())}`);
    return result;
  } finally {
    await context.close();
  }
}

const fmt = (s) => (s ? `p50 ${s.p50.toFixed(2)} p95 ${s.p95.toFixed(2)} max ${s.max.toFixed(2)} (n ${s.n})` : '--');

function printRun(engine, r) {
  console.log(
    `${engine} ${r.cover}: renderer ${r.smoothRenderer} | smoothAvailable ${r.smoothAvailable} | drew ${r.drew} | ` +
      `${r.frame} ${r.codec ?? '?'} ${r.decoder ?? ''} | callbacks ${r.rvfcCallbacks} frames ${r.totalVideoFrames} ` +
      `dropped ${r.droppedVideoFrames} | draw ms ${fmt(r.drawMs)} | gpu ms ${r.gpuTimer ? fmt(r.gpuMs) : 'no timer'}` +
      `${r.notes.length ? ` | ${r.notes.join('; ')}` : ''}`,
  );
}

/** the cover rule (task 2.5): within 5% of the bare video's callbacks and frames, dropped up by at most 1% of frames. */
function holds(bare, covered) {
  const near = (a, b) => b > 0 && Math.abs(a - b) <= 0.05 * b;
  return (
    covered.drew &&
    near(covered.rvfcCallbacks, bare.rvfcCallbacks) &&
    near(covered.totalVideoFrames, bare.totalVideoFrames) &&
    covered.droppedVideoFrames - bare.droppedVideoFrames <= 0.01 * covered.totalVideoFrames
  );
}

async function matrix(browser, engine) {
  const runs = {};
  for (const cover of COVERS) {
    runs[cover] = await runPage(browser, { cover, seconds: args.seconds, label: `${engine}-${cover}-${args.source}-${args.box}` });
    printRun(engine, runs[cover]);
  }
  const verdict = (cover) => (runs[cover].drew ? (holds(runs.none, runs[cover]) ? 'holds' : 'does not hold') : 'never drew');
  const chosen = holds(runs.none, runs.canvas) ? 'canvas' : holds(runs.none, runs.under) ? 'under' : null;
  console.log(`${engine}: canvas ${verdict('canvas')}, under ${verdict('under')}: cover ${chosen ?? 'none holds, so the canvas path cannot ship'}`);
}

// ------------------------------------------------------------ the two clocks

/** an 8-bit rgb or rgba, non-interlaced png (what playwright's screenshots are). */
function decodePng(buffer) {
  let pos = 8;
  let header = null;
  const idat = [];
  while (pos < buffer.length) {
    const length = buffer.readUInt32BE(pos);
    const kind = buffer.toString('latin1', pos + 4, pos + 8);
    const data = buffer.subarray(pos + 8, pos + 8 + length);
    if (kind === 'IHDR') header = { width: data.readUInt32BE(0), height: data.readUInt32BE(4), depth: data[8], type: data[9], interlace: data[12] };
    else if (kind === 'IDAT') idat.push(data);
    else if (kind === 'IEND') break;
    pos += 12 + length;
  }
  if (!header || header.depth !== 8 || (header.type !== 2 && header.type !== 6) || header.interlace) {
    throw new Error(`unsupported png ${JSON.stringify(header)}`);
  }
  const { width, height } = header;
  const bpp = header.type === 6 ? 4 : 3;
  const stride = width * bpp;
  const raw = inflateSync(Buffer.concat(idat));
  const data = new Uint8Array(height * stride);
  for (let y = 0; y < height; y += 1) {
    const filter = raw[y * (stride + 1)];
    const line = y * (stride + 1) + 1;
    const row = y * stride;
    for (let x = 0; x < stride; x += 1) {
      const a = x >= bpp ? data[row + x - bpp] : 0;
      const b = y ? data[row - stride + x] : 0;
      const c = x >= bpp && y ? data[row - stride + x - bpp] : 0;
      let predicted = 0;
      if (filter === 1) predicted = a;
      else if (filter === 2) predicted = b;
      else if (filter === 3) predicted = (a + b) >> 1;
      else if (filter === 4) {
        const p = a + b - c;
        const pa = Math.abs(p - a);
        const pb = Math.abs(p - b);
        const pc = Math.abs(p - c);
        predicted = pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
      }
      data[row + x] = (raw[line + x] + predicted) & 0xff;
    }
  }
  return { width, height, bpp, data };
}

/** the red start blocks about one cell wide, top first. */
function redBlocks(img, cell) {
  const { width, height, bpp, data } = img;
  const red = (i) => data[i * bpp] >= 160 && data[i * bpp + 1] <= 96 && data[i * bpp + 2] <= 96;
  const seen = new Uint8Array(width * height);
  const blocks = [];
  for (let start = 0; start < width * height; start += 1) {
    if (seen[start] || !red(start)) continue;
    const stack = [start];
    seen[start] = 1;
    const box = { x0: width, y0: height, x1: 0, y1: 0 };
    while (stack.length) {
      const i = stack.pop();
      const x = i % width;
      const y = (i - x) / width;
      box.x0 = Math.min(box.x0, x);
      box.x1 = Math.max(box.x1, x);
      box.y0 = Math.min(box.y0, y);
      box.y1 = Math.max(box.y1, y);
      for (const n of [x > 0 && i - 1, x < width - 1 && i + 1, y > 0 && i - width, y < height - 1 && i + width]) {
        if (n !== false && !seen[n] && red(n)) {
          seen[n] = 1;
          stack.push(n);
        }
      }
    }
    const w = box.x1 - box.x0 + 1;
    if (w >= cell * 0.6 && w <= cell * 1.4 && box.y1 - box.y0 + 1 >= cell * 0.3) blocks.push(box);
  }
  return blocks.sort((p, q) => p.y0 - q.y0);
}

/** the 16-bit value after a start block; null when a cell is neither black nor white. */
function readBarcode(img, block, cell) {
  const y = Math.round((block.y0 + block.y1) / 2);
  let value = 0;
  for (let i = 0; i < BITS; i += 1) {
    const x = Math.round(block.x0 + cell * (i + 1.5));
    if (x >= img.width) return null;
    const at = (y * img.width + x) * img.bpp;
    const luma = 0.299 * img.data[at] + 0.587 * img.data[at + 1] + 0.114 * img.data[at + 2];
    if (luma > 64 && luma < 192) return null;
    value = (value << 1) | (luma >= 128 ? 1 : 0);
  }
  return value;
}

/** live - shown in ms, or null when the shot does not hold both barcodes cleanly. */
function readClocks(img, cell) {
  const blocks = redBlocks(img, cell);
  if (blocks.length !== 2) return null;
  const [shown, live] = blocks.map((block) => readBarcode(img, block, cell));
  if (shown === null || live === null) return null;
  const delta = (live - shown) & 0xffff;
  return delta >= 0x8000 ? delta - 0x10000 : delta;
}

function percentile(values, p) {
  const v = values.slice().sort((a, b) => a - b);
  return v.length ? v[Math.min(v.length, Math.max(1, Math.ceil((p / 100) * v.length))) - 1] : null;
}

async function latency(browser, engine) {
  const covers = {};
  for (const cover of ['none', 'canvas']) {
    const samples = [];
    let unreadable = 0;
    // about a second a shot, so the page is still measuring at the last one.
    const seconds = Math.max(args.seconds, args.shots + 5);
    const run = await runPage(browser, { cover, seconds, label: `latency-${engine}-${cover}-${args.source}-${args.box}` }, async (page) => {
      // the page owns the barcode's geometry: its strip's cell, in screenshot pixels.
      const cell = await page.evaluate(() => document.getElementById('strip').firstElementChild.getBoundingClientRect().width * devicePixelRatio);
      for (let i = 0; i < args.shots; i += 1) {
        const delta = readClocks(decodePng(await page.screenshot()), cell);
        if (delta === null) unreadable += 1;
        else samples.push(delta);
        // off the frame cadence, so the shots do not all land on one phase.
        await sleep(50 + Math.random() * 100);
      }
    });
    printRun(engine, run);
    covers[cover] = { shots: args.shots, unreadable, median: percentile(samples, 50), p95: percentile(samples, 95), samples };
    console.log(`${engine} ${cover}: live - shown median ${covers[cover].median} ms, p95 ${covers[cover].p95} ms (${samples.length} of ${args.shots} shots read)`);
  }
  const difference = covers.none.median !== null && covers.canvas.median !== null ? covers.canvas.median - covers.none.median : null;
  console.log(`${engine}: canvas - none, medians: ${difference ?? '--'} ms`);
  const summary = {
    label: `latency-${engine}-${args.source}-${args.box}`,
    mode: 'latency',
    engine,
    version: browser.version(),
    source: args.source,
    box: args.box,
    covers,
    medianDifferenceMs: difference,
  };
  const res = await fetch(`${PAGE}/result`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(summary) });
  console.log(`${engine}: summary ${(await res.json()).written}`);
}

const health = await fetch(`${PAGE}/health`).catch(() => null);
if (!health?.ok) usage(`no probe server at ${PAGE}; start node server.mjs first`);

for (const engine of args.engines) {
  const browser = await chromium.launch(ENGINES[engine]);
  try {
    console.log(`${engine}: ${browser.version()}`);
    if (args.mode === 'matrix') await matrix(browser, engine);
    else await latency(browser, engine);
  } finally {
    await browser.close();
  }
}
