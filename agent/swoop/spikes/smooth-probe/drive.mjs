#!/usr/bin/env node
// swoop-clarity task 2.5: drives the smooth-probe page in playwright's chromium
// and in edge. the page measures the shipped web/lib/swoop/video/smooth.ts,
// which server.mjs serves with its types stripped, never a copy.
//
//   cd agent/swoop/spikes/smooth-probe
//   node server.mjs                                       # in another terminal
//   node drive.mjs matrix --seconds 5 --source 1920x1080 --box 1000x562
//   node drive.mjs latency --shots 30 --source 3840x2160 --box 1300x731
//   node drive.mjs matrix --seconds 20 --runs 3 --engines edge --sender chromium --covers canvas,canvas-worker --quiet 10
//
// matrix   cover=none, then each of --covers (default canvas,under), for
//          --seconds, --runs times, in playwright's chromium (headless, on
//          d3d11) and in edge (headed); prints each run and whether a cover
//          keeps the video's rvfc callbacks and totalVideoFrames within 5% of
//          that repetition's cover=none, with droppedVideoFrames rising by no
//          more than 1% of frames; then a table of every run.
// latency  --shots screenshots each with cover=none and each of --covers
//          (default canvas), in edge unless --engines says otherwise. each
//          shot holds the barcode the picture shows and the page's live one;
//          live - shown is the time the picture is behind, and the difference
//          of a cover's median and none's is what that cover adds.
//
// --engines chromium,edge picks the browsers. --sender chromium moves the
// source and its encoder into a page of a separate headless chromium, so the
// measured browser only receives, decodes and draws, as a viewer of a remote
// machine does (without it the source shares the measured page, task 2.5's
// setup). with a sender, --receiver says what else the measured page does
// every frame: idle (nothing, as swoop's viewer today), raf (an empty
// animation-frame loop, as task 3.1's measuring double rAF would add) or strip
// (a loop that repaints the dom strip; latency mode always paints it).
// --quiet N reads the cpu load before each run and waits, re-reading every two
// minutes, until it is at or under N percent; the load read is recorded in
// every run either way (windows only). each run also samples the
// machine's cpu every second while it runs: a run whose max passes
// --clean-max (default 30, which leaves room for the probe's own browsers) or
// whose source fell under 60 fps is not clean, and the closing summary
// counts clean runs only. --quiet-gpu N and --clean-gpu-max N (default 80) do
// the same for nvidia's gpu utilization, sampled every two seconds: another
// app's gpu work starves the source and the compositor as cpu load does.
// PROBE_URL points at another server (default http://127.0.0.1:17460). every
// page run lands in runs/ through server.mjs, and each mode posts its summary
// there too. playwright comes from web/node_modules: this probe installs nothing.

import { execFile, execFileSync } from 'node:child_process';
import { cpus } from 'node:os';
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
// the sender's host candidates as plain addresses, so the measured browser can
// reach them without resolving an mdns name.
const SENDER = { headless: true, args: ['--use-angle=d3d11', '--disable-features=WebRtcHideLocalIpsWithMdns'] };
const BITS = 16;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function usage(problem) {
  console.error(`drive.mjs: ${problem}`);
  console.error(
    'usage: node drive.mjs matrix|latency [--seconds 5] [--source 1920x1080] [--box 1000x562] [--shots 30] ' +
      '[--engines chromium,edge] [--covers canvas,under] [--runs 1] [--sender chromium] [--receiver idle|raf|strip] ' +
      '[--quiet 10] [--quiet-gpu 50] [--clean-max 30] [--clean-gpu-max 80]',
  );
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
    covers: mode === 'latency' ? ['canvas'] : ['canvas', 'under'],
    runs: 1,
    sender: null,
    receiver: 'idle',
    quiet: null,
    cleanMax: 30,
    quietGpu: null,
    cleanGpuMax: 80,
  };
  for (let i = 1; i < argv.length; i += 2) {
    const value = argv[i + 1];
    if (argv[i] === '--seconds') args.seconds = Number(value) || args.seconds;
    else if (argv[i] === '--source') args.source = value;
    else if (argv[i] === '--box') args.box = value;
    else if (argv[i] === '--shots') args.shots = Number(value) || args.shots;
    else if (argv[i] === '--engines') args.engines = String(value).split(',');
    else if (argv[i] === '--covers') args.covers = String(value).split(',').filter((c) => c !== 'none');
    else if (argv[i] === '--runs') args.runs = Number(value) || args.runs;
    else if (argv[i] === '--sender') args.sender = value;
    else if (argv[i] === '--receiver') args.receiver = value;
    else if (argv[i] === '--quiet') args.quiet = Number(value);
    else if (argv[i] === '--clean-max') args.cleanMax = Number(value);
    else if (argv[i] === '--quiet-gpu') args.quietGpu = Number(value);
    else if (argv[i] === '--clean-gpu-max') args.cleanGpuMax = Number(value);
    else usage(`unknown flag ${argv[i]}`);
  }
  parseSize(args.source, '--source');
  parseSize(args.box, '--box');
  for (const engine of args.engines) if (!ENGINES[engine]) usage(`unknown engine ${engine}`);
  if (args.sender && args.sender !== 'chromium') usage('--sender takes chromium');
  if (!['idle', 'raf', 'strip'].includes(args.receiver)) usage('--receiver takes idle, raf or strip');
  return args;
}

const args = parseArgs(process.argv.slice(2));
const [boxW, boxH] = parseSize(args.box, '--box');

/** the machine's cpu load in percent (windows), or null where it cannot be read. */
function cpuLoad() {
  try {
    const out = execFileSync(
      'powershell',
      ['-NoProfile', '-Command', '(Get-CimInstance Win32_Processor | Measure-Object -Property LoadPercentage -Average).Average'],
      { encoding: 'utf8', timeout: 30000 },
    );
    const load = Number(out.trim());
    return Number.isFinite(load) ? load : null;
  } catch {
    return null;
  }
}

/** nvidia's gpu utilization in percent, or null without nvidia-smi: other apps' gpu work is context for a run. */
function gpuLoad() {
  try {
    const out = execFileSync('nvidia-smi', ['--query-gpu=utilization.gpu', '--format=csv,noheader,nounits'], { encoding: 'utf8', timeout: 10000 });
    const load = Number(out.trim().split('\n')[0]);
    return Number.isFinite(load) ? load : null;
  } catch {
    return null;
  }
}

/** the cpu and gpu load before a run; with --quiet (and --quiet-gpu), waits for them to fall to that or under. */
async function quietLoad() {
  let load = cpuLoad();
  let gpu = gpuLoad();
  const busy = () =>
    (args.quiet !== null && load !== null && load > args.quiet) || (args.quietGpu !== null && gpu !== null && gpu > args.quietGpu);
  while (busy()) {
    console.log(`cpu load ${load}%, gpu ${gpu}%, over --quiet ${args.quiet}% / --quiet-gpu ${args.quietGpu ?? '-'}%: waiting two minutes`);
    await sleep(120000);
    load = cpuLoad();
    gpu = gpuLoad();
  }
  console.log(`cpu load ${load ?? '?'}%, gpu ${gpu ?? '?'}%`);
  return { cpu: load, gpu };
}

/** the gpu's utilization every two seconds across a run (nvidia-smi), as max percent; null without it. */
function gpuSampler() {
  let max = null;
  const timer = setInterval(() => {
    execFile('nvidia-smi', ['--query-gpu=utilization.gpu', '--format=csv,noheader,nounits'], { timeout: 5000 }, (err, out) => {
      const value = err ? NaN : Number(String(out).trim().split('\n')[0]);
      if (Number.isFinite(value)) max = Math.max(max ?? 0, value);
    });
  }, 2000);
  return () => {
    clearInterval(timer);
    return max;
  };
}

/**
 * the whole machine's cpu use across a run, from the kernel's per-core times
 * every second: mean and max percent. it includes the probe's own browsers, so
 * it is read against a clean run's level, not against zero.
 */
function cpuSampler() {
  const totals = () => cpus().reduce((acc, c) => {
    const busy = c.times.user + c.times.nice + c.times.sys + c.times.irq;
    return { busy: acc.busy + busy, all: acc.all + busy + c.times.idle };
  }, { busy: 0, all: 0 });
  const first = totals();
  let last = first;
  let max = 0;
  const timer = setInterval(() => {
    const now = totals();
    const all = now.all - last.all;
    if (all > 0) max = Math.max(max, ((now.busy - last.busy) / all) * 100);
    last = now;
  }, 1000);
  return () => {
    clearInterval(timer);
    const end = totals();
    return { mean: Math.round(((end.busy - first.busy) / Math.max(1, end.all - first.all)) * 100), max: Math.round(max) };
  };
}

/** a page in the sender browser streaming the source; drive.mjs hands its offer to the measured page. */
async function openSender(senderBrowser) {
  const context = await senderBrowser.newContext({ viewport: { width: 320, height: 240 } });
  const page = await context.newPage();
  page.on('console', (m) => {
    if (m.type() === 'error') console.error(`  sender console: ${m.text()}`);
  });
  await page.goto(`${PAGE}/?${new URLSearchParams({ role: 'send', source: args.source, label: 'sender' })}`, { waitUntil: 'load' });
  await page.waitForFunction(() => window.probeSignal, null, { timeout: 30000 });
  return { page, close: () => context.close() };
}

/** one page run; `during` runs while the page is measuring. */
async function runPage(browser, { cover, seconds, label, load, senderBrowser, strip }, during) {
  // the picture, the strip under it and the state line, with room to spare.
  const context = await browser.newContext({ viewport: { width: boxW + 16, height: boxH + 140 } });
  const sender = senderBrowser ? await openSender(senderBrowser) : null;
  try {
    const page = await context.newPage();
    page.on('console', (m) => {
      if (m.type() === 'error') console.error(`  console: ${m.text()}`);
    });
    const query = new URLSearchParams({ source: args.source, box: args.box, cover, seconds: String(seconds), label });
    if (load?.cpu !== null && load?.cpu !== undefined) query.set('load', String(load.cpu));
    if (load?.gpu !== null && load?.gpu !== undefined) query.set('gpu', String(load.gpu));
    if (sender) {
      query.set('role', 'receive');
      if (strip || args.receiver === 'strip') query.set('strip', '1');
      if (args.receiver === 'raf') query.set('raf', '1');
    }
    await page.goto(`${PAGE}/?${query}`, { waitUntil: 'load' });
    const state = () => page.evaluate(() => document.getElementById('state')?.textContent ?? '');
    if (sender) {
      await page.waitForFunction(() => window.probeSignal || /^error/.test(document.getElementById('state')?.textContent ?? ''), null, { timeout: 30000 });
      if (!(await page.evaluate(() => Boolean(window.probeSignal)))) throw new Error(`${label}: ${await state()}`);
      const offer = await sender.page.evaluate(() => window.probeSignal.offer());
      const answer = await page.evaluate((sdp) => window.probeSignal.answer(sdp), offer);
      await sender.page.evaluate((sdp) => window.probeSignal.accept(sdp), answer);
    }
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
    await sender?.close();
  }
}

const fmt = (s) => (s ? `p50 ${s.p50.toFixed(2)} p95 ${s.p95.toFixed(2)} max ${s.max.toFixed(2)} (n ${s.n})` : '--');

function printRun(engine, r) {
  const inbound = r.rtc?.inbound;
  console.log(
    `${engine} ${r.cover}: renderer ${r.smoothRenderer} | smoothAvailable ${r.smoothAvailable} | drew ${r.drew} | ` +
      `${r.frame} ${r.codec ?? '?'} ${r.decoder ?? ''} | callbacks ${r.rvfcCallbacks} frames ${r.totalVideoFrames} ` +
      `dropped ${r.droppedVideoFrames} | presented ${r.presentedFrames} coalesced ${r.coalescedCallbacks} ` +
      `| raf skipped ${r.rafCadence?.skipped ?? '-'} | received ${inbound?.framesReceived ?? '-'} decoded ${inbound?.framesDecoded ?? '-'} ` +
      `jitter ${inbound?.interFrameJitterMs?.toFixed(2) ?? '-'} ms | draw ms ${fmt(r.drawMs)} | gpu ms ${r.gpuTimer ? fmt(r.gpuMs) : 'no timer'}` +
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

/** what a run says against its repetition's cover=none: '' for none itself. */
function verdictOf(bare, run) {
  if (run.cover === 'none') return run.error ? `error: ${run.error}` : '';
  if (run.error) return `error: ${run.error}`;
  if (bare.error) return 'no baseline';
  if (!run.drew) return 'never drew';
  return holds(bare, run) ? 'holds' : 'fails';
}

const pct = (a, b) => (b ? `${(((a - b) / b) * 100).toFixed(1)}%` : '-');

/** per cover, the clean runs only, against the clean cover=none runs' median. */
function printCleanSummary(rows) {
  const median = (values) => {
    const v = values.slice().sort((a, b) => a - b);
    return v.length ? (v.length % 2 ? v[(v.length - 1) / 2] : (v[v.length / 2 - 1] + v[v.length / 2]) / 2) : null;
  };
  console.log('');
  console.log('clean runs only (cpu and gpu max during the run within --clean-max and --clean-gpu-max, source at 60 fps), medians:');
  for (const engine of [...new Set(rows.map((r) => r.engine))]) {
    const clean = rows.filter((r) => r.engine === engine && !r.run.error && r.run.clean);
    const bare = clean.filter((r) => r.run.cover === 'none').map((r) => r.run);
    const bareCallbacks = median(bare.map((r) => r.rvfcCallbacks));
    const bareShown = median(bare.map((r) => r.totalVideoFrames - r.droppedVideoFrames));
    for (const cover of [...new Set(clean.map((r) => r.run.cover))]) {
      const runs = clean.filter((r) => r.run.cover === cover).map((r) => r.run);
      const callbacks = median(runs.map((r) => r.rvfcCallbacks));
      console.log(
        `${engine} ${cover.padEnd(19)} n ${runs.length}  callbacks ${callbacks} (${pct(callbacks, bareCallbacks)} vs none)  ` +
          `coalesced ${median(runs.map((r) => r.coalescedCallbacks))}  dropped ${median(runs.map((r) => r.droppedVideoFrames))}  ` +
          `frames ${median(runs.map((r) => r.totalVideoFrames))}  ` +
          (cover === 'none' ? `shown ${bareShown}` : `drawn ${median(runs.map((r) => r.draws ?? 0))} (${pct(median(runs.map((r) => r.draws ?? 0)), bareShown)} vs none shown)`),
      );
    }
  }
}

/** one row per run, each cover against its own repetition's cover=none. */
function printTable(rows) {
  console.log('');
  console.log(
    'engine  rep cover               cpu s/mean/max gpu s/max  clean callbacks (vs none)   frames (vs none)   dropped (+%frames)  presented coalesced rafskip received  drawn (vs none shown)      draw p50/p95   verdict',
  );
  for (const { engine, rep, run, bare } of rows) {
    const verdict = verdictOf(bare, run);
    if (run.error || bare.error) {
      console.log([engine.padEnd(7), String(rep).padEnd(3), run.cover.padEnd(19), verdict].join(' '));
      continue;
    }
    const extra = run.droppedVideoFrames - bare.droppedVideoFrames;
    console.log(
      [
        engine.padEnd(7),
        String(rep).padEnd(3),
        run.cover.padEnd(19),
        `${run.cpuLoadAtStart ?? '?'}/${run.cpuDuring?.mean ?? '?'}/${run.cpuDuring?.max ?? '?'} ${run.gpuLoadAtStart ?? '?'}/${run.gpuMaxDuring ?? '?'}`.padEnd(23),
        (run.clean ? 'yes' : run.sourceShort ? 'src' : 'no').padEnd(5),
        `${run.rvfcCallbacks} (${run.cover === 'none' ? '-' : pct(run.rvfcCallbacks, bare.rvfcCallbacks)})`.padEnd(21),
        `${run.totalVideoFrames} (${run.cover === 'none' ? '-' : pct(run.totalVideoFrames, bare.totalVideoFrames)})`.padEnd(18),
        `${run.droppedVideoFrames} (${run.cover === 'none' ? '-' : `${((extra / run.totalVideoFrames) * 100).toFixed(1)}%`})`.padEnd(19),
        String(run.presentedFrames).padEnd(9),
        String(run.coalescedCallbacks).padEnd(9),
        String(run.rafCadence?.skipped ?? '-').padEnd(7),
        String(run.rtc?.inbound?.framesReceived ?? '-').padEnd(9),
        // the distinct frames the canvas drew, against the frames the bare video showed.
        (run.draws === null ? '-' : `${run.draws} (${pct(run.draws, bare.totalVideoFrames - bare.droppedVideoFrames)})`).padEnd(26),
        (run.drawMs ? `${run.drawMs.p50.toFixed(2)}/${run.drawMs.p95.toFixed(2)}` : '-').padEnd(14),
        verdict,
      ].join(' '),
    );
  }
}

/** a run is evidence only if nothing else loaded the box during it and the source kept its 60 fps. */
function judgeRun(run) {
  const expected = 60 * run.seconds;
  run.sourceShort = (run.rtc?.inbound?.framesReceived ?? run.totalVideoFrames) < 0.98 * expected;
  run.clean =
    !run.sourceShort && run.cpuDuring.max <= args.cleanMax && (run.gpuMaxDuring === null || run.gpuMaxDuring <= args.cleanGpuMax);
}

async function matrix(browser, engine, senderBrowser, rows) {
  for (let rep = 1; rep <= args.runs; rep += 1) {
    const runs = {};
    for (const cover of ['none', ...args.covers]) {
      const label = `${engine}-${cover}-${args.sender ? `remote-${args.receiver}-` : ''}${args.source}-${args.box}`;
      try {
        // every run waits for a quiet box, not just every repetition: other jobs come and go.
        // a headless sender can lose windows' fine timer and paint at ~47 fps for a
        // whole run; such a run measures the sender, so it runs again (twice at most).
        for (let attempt = 0; attempt < 3; attempt += 1) {
          const load = await quietLoad();
          const sampled = cpuSampler();
          const gpuSampled = gpuSampler();
          runs[cover] = await runPage(browser, { cover, seconds: args.seconds, label, load, senderBrowser });
          runs[cover].cpuDuring = sampled();
          runs[cover].gpuMaxDuring = gpuSampled();
          judgeRun(runs[cover]);
          printRun(engine, runs[cover]);
          if (!runs[cover].sourceShort) break;
          console.log(`${engine} ${cover}: the source sent ${runs[cover].rtc?.inbound?.framesReceived} frames, under 60 fps: again`);
        }
      } catch (err) {
        // one cover a browser cannot run (webgpu in the headless shell) does not end the matrix.
        runs[cover] = { cover, error: String(err.message).split('\n')[0] };
        console.log(`${engine} ${cover}: ${runs[cover].error}`);
      }
      rows.push({ engine, rep, run: runs[cover], bare: runs.none });
    }
    const verdicts = args.covers.map((cover) => `${cover} ${verdictOf(runs.none, runs[cover])}`);
    console.log(`${engine} rep ${rep}: ${verdicts.join(', ')}`);
  }
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

async function latency(browser, engine, senderBrowser) {
  const covers = {};
  const load = await quietLoad();
  for (const cover of ['none', ...args.covers]) {
    const samples = [];
    let unreadable = 0;
    // about a second a shot, so the page is still measuring at the last one.
    const seconds = Math.max(args.seconds, args.shots + 5);
    const label = `latency-${engine}-${cover}-${args.sender ? 'remote-' : ''}${args.source}-${args.box}`;
    const run = await runPage(browser, { cover, seconds, label, load, senderBrowser, strip: true }, async (page) => {
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
  const differences = {};
  for (const cover of args.covers) {
    differences[cover] = covers.none.median !== null && covers[cover].median !== null ? covers[cover].median - covers.none.median : null;
    console.log(`${engine}: ${cover} - none, medians: ${differences[cover] ?? '--'} ms`);
  }
  const summary = {
    label: `latency-${engine}-${args.sender ? 'remote-' : ''}${args.source}-${args.box}`,
    mode: 'latency',
    engine,
    version: browser.version(),
    source: args.source,
    box: args.box,
    sender: args.sender,
    cpuLoadAtStart: load.cpu,
    gpuLoadAtStart: load.gpu,
    covers,
    medianDifferenceMs: differences,
  };
  const res = await fetch(`${PAGE}/result`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(summary) });
  console.log(`${engine}: summary ${(await res.json()).written}`);
}

const health = await fetch(`${PAGE}/health`).catch(() => null);
if (!health?.ok) usage(`no probe server at ${PAGE}; start node server.mjs first`);

const senderBrowser = args.sender ? await chromium.launch(SENDER) : null;
const rows = [];
try {
  if (senderBrowser) console.log(`sender: playwright chromium ${senderBrowser.version()}, headless`);
  for (const engine of args.engines) {
    const browser = await chromium.launch(ENGINES[engine]);
    try {
      console.log(`${engine}: ${browser.version()}`);
      if (args.mode === 'matrix') await matrix(browser, engine, senderBrowser, rows);
      else await latency(browser, engine, senderBrowser);
    } finally {
      await browser.close();
    }
  }
} finally {
  await senderBrowser?.close();
}

if (args.mode === 'matrix') {
  printTable(rows);
  printCleanSummary(rows);
  const summary = {
    label: `matrix-${args.engines.join('+')}-${args.sender ? `remote-${args.receiver}-` : ''}${args.source}-${args.box}`,
    receiver: args.sender ? args.receiver : null,
    mode: 'matrix',
    seconds: args.seconds,
    sender: args.sender,
    rows: rows.map(({ engine, rep, run, bare }) => ({ engine, rep, verdict: verdictOf(bare, run), run })),
  };
  const res = await fetch(`${PAGE}/result`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(summary) });
  console.log(`summary ${(await res.json()).written}`);
}
