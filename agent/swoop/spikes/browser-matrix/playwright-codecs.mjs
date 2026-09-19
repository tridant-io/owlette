#!/usr/bin/env node
// swoop spike 2.12 - what can Playwright's bundled chromium actually decode?
//
// Task 8.7's e2e specs have to either feed real h.264 chunks or stub the
// decoder, and that choice is this file's output. It drives the same page the
// humans drive, so the playwright row in the memo is produced by the same probe
// as every other row rather than by a different script with different questions.
//
//   cd agent/swoop/spikes/browser-matrix
//   node server.mjs                       # in another terminal
//   node playwright-codecs.mjs            # both headless and headed
//
// playwright comes from web/node_modules - this spike installs nothing.

import { readFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const repo = resolve(here, '..', '..', '..', '..');
const PAGE = process.env.MATRIX_URL ?? 'http://127.0.0.1:17450';

// playwright-core is commonjs, so a dynamic import puts it on `default`;
// the named export only exists when the lexer finds it, and here it does not.
const pw = await import(pathToFileURL(join(repo, 'web', 'node_modules', 'playwright-core', 'index.js')).href);
const chromium = pw.chromium ?? pw.default.chromium;

async function probe({ headless }) {
  const label = `playwright-chromium-${headless ? 'headless' : 'headed'}`;
  const browser = await chromium.launch({ headless });
  try {
    const page = await browser.newPage();
    const done = page.waitForFunction(() => document.getElementById('state')?.textContent === 'done', null, { timeout: 180000 });
    page.on('console', (m) => { if (m.type() === 'error') console.error(`  console: ${m.text()}`); });
    await page.goto(`${PAGE}/?mode=caps,decode&label=${label}&autorun=1`, { waitUntil: 'load' });
    await done;
    console.log(`${label}: version ${browser.version()}`);
    return label;
  } finally {
    await browser.close();
  }
}

const labels = [];
for (const headless of [true, false]) labels.push(await probe({ headless }));

// Read back what the page posted, so this script's stdout is the finding and
// not a second, differently-worded opinion about it.
const runsDir = join(here, 'runs');
const { readdir } = await import('node:fs/promises');
const files = (await readdir(runsDir)).sort();
for (const label of labels) {
  for (const mode of ['caps', 'decode']) {
    const name = files.filter((f) => f.startsWith(`${mode}-${label}-`)).pop();
    if (!name) { console.log(`${label} ${mode}: NO RUN FILE`); continue; }
    const run = JSON.parse(await readFile(join(runsDir, name), 'utf8'));
    if (mode === 'caps') {
      const yes = run.webcodecs.filter((r) => r.hardwareAcceleration === 'no-preference' && r.supported).map((r) => r.codec);
      console.log(`${label} caps: VideoDecoder says yes to [${yes.join(', ') || 'nothing'}]`);
      console.log(`${label} caps: webrtc receiver video mimeTypes ${JSON.stringify([...new Set(run.webrtc.receiver_video)])}`);
    } else {
      for (const r of run.runs.filter((x) => x.hardwareAcceleration === 'no-preference')) {
        console.log(
          `${label} decode: ${r.stream} ${r.config.codec} claimed=${r.isConfigSupported} ` +
          `out=${r.framesOutAfterFlush ?? 0}/${r.framesIn} nonblack=${r.pixelsNonBlack ?? 0}/${r.pixelsChecked ?? 0} ` +
          `${r.configureError ?? r.decoderError ?? ''}`,
        );
      }
    }
  }
}
