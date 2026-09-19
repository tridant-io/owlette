#!/usr/bin/env node
// swoop spike 2.12 - fold the soak windows of one run back into one row.
//
//   cd agent/swoop/spikes/browser-matrix
//   node summarize.mjs                 # every soak group in runs/
//   node summarize.mjs --group win-4   # one of them
//
// A soak is N browser windows each decoding 1080p60, launched from a shell
// because no browser will let one page open eight of them. `group` ties them
// together; this prints the row the memo carries.

import { readdir, readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const runsDir = join(here, 'runs');
const only = process.argv.includes('--group') ? process.argv[process.argv.indexOf('--group') + 1] : null;

const files = (await readdir(runsDir)).filter((f) => f.startsWith('soak-') && f.endsWith('.json'));
const groups = new Map();
for (const file of files) {
  const run = JSON.parse(await readFile(join(runsDir, file), 'utf8'));
  const key = run.group || '(no group)';
  if (only && key !== only) continue;
  // A window that reran keeps only its latest result: the launcher script reuses
  // idx values, and two rows for one window would inflate the ceiling.
  const group = groups.get(key) ?? new Map();
  const prev = group.get(run.idx);
  if (!prev || prev.meta.startedAt < run.meta.startedAt) group.set(run.idx, run);
  groups.set(key, group);
}

const pad = (s, n) => String(s).padEnd(n);
console.log(pad('group', 16), pad('win', 4), pad('stream', 12), pad('in fps', 8), pad('out fps', 8), pad('p50 ms', 8), pad('p95 ms', 8), pad('nonblack', 9), 'error');
for (const [key, group] of [...groups.entries()].sort()) {
  const rows = [...group.values()].sort((a, b) => a.idx - b.idx);
  let totalOut = 0;
  for (const r of rows) {
    totalOut += r.outputFps ?? 0;
    console.log(
      pad(key, 16), pad(r.idx, 4), pad(r.stream, 12),
      pad((r.submittedFps ?? 0).toFixed(2), 8), pad((r.outputFps ?? 0).toFixed(2), 8),
      pad((r.submitToOutputMs?.p50 ?? 0).toFixed(2), 8), pad((r.submitToOutputMs?.p95 ?? 0).toFixed(2), 8),
      pad(`${r.pixelsNonBlack ?? 0}/${r.pixelsChecked ?? 0}`, 9),
      [r.everHidden ? 'WINDOW WAS HIDDEN - void' : '', r.decoderError ?? r.error ?? ''].filter(Boolean).join(' '),
    );
  }
  console.log(`${pad(key, 16)} ${rows.length} window(s), ${totalOut.toFixed(1)} decoded fps in aggregate, ${rows.filter((r) => r.decoderError || r.error).length} with errors`);
  console.log('');
}
