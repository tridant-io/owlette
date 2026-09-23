#!/usr/bin/env node
// swoop spike 2.12 - regenerate the canned encoded chunks the matrix decodes.
//
//   cd agent/swoop/spikes/browser-matrix
//   node make-streams.mjs                 # needs ffmpeg + ffprobe on PATH
//
// The streams are checked in so a human on a mac or a windows box can run the
// matrix without a toolchain. This script exists so they can be reproduced, and
// so what is in them is written down rather than inferred from the bytes.
//
// Shape of each stream, and why:
//   1920x1080 60 fps, 60 frames - the product's target picture, one second of it.
//   one IDR at frame 0, no B-frames, one reference, one slice per frame, closed
//   gop - the same constraints plan.md D5 puts on the real encoder, so a decode
//   failure here is a decoder finding and not an artefact of an exotic bitstream.
//   annex-b with in-band parameter sets on the IDR, because that is what
//   PROTOCOL.md section 4 says travels on the wire, and because a `description`
//   less VideoDecoder config is the only form all four browsers accept alike.
//
// The index next to each stream gives access-unit lengths, so the page can cut
// the file into EncodedVideoChunks without parsing start codes in javascript.

import { spawn } from 'node:child_process';
import { readFile, writeFile, stat, mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const outDir = join(here, 'public', 'streams');

const WIDTH = 1920;
const HEIGHT = 1080;
const FPS = 60;
const FRAMES = 60;

// A moving pattern with a hard edge and a counter: a static source would encode
// to almost nothing and would not exercise a decoder at all.
const SOURCE = [
  '-f', 'lavfi',
  '-i', `testsrc2=size=${WIDTH}x${HEIGHT}:rate=${FPS}:duration=${(FRAMES / FPS).toFixed(4)}`,
  '-pix_fmt', 'yuv420p',
  '-frames:v', String(FRAMES),
];

const TARGETS = [
  {
    name: 'h264-1080p',
    // The level is whatever the encoder picks for 1080p60 and the codec string
    // is read back out of the bitstream: a hand-written level that undersells
    // the stream is exactly the kind of thing a strict decoder refuses.
    file: 'h264-1080p.h264',
    args: [
      '-c:v', 'libx264',
      '-profile:v', 'high',
      '-x264-params',
      `keyint=${FRAMES * 4}:min-keyint=${FRAMES * 4}:scenecut=0:bframes=0:ref=1:slices=1:repeat-headers=1:aud=0`,
      '-crf', '30',
      '-f', 'h264',
    ],
  },
  {
    name: 'hevc-1080p',
    file: 'hevc-1080p.h265',
    args: [
      '-c:v', 'libx265',
      '-profile:v', 'main',
      '-x265-params',
      `keyint=${FRAMES * 4}:min-keyint=${FRAMES * 4}:scenecut=0:bframes=0:ref=1:repeat-headers=1:log-level=error`,
      '-crf', '30',
      '-f', 'hevc',
    ],
  },
];

function run(cmd, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => { stdout += d; });
    child.stderr.on('data', (d) => { stderr += d; });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) resolve(stdout);
      else reject(new Error(`${cmd} exited ${code}\n${stderr.slice(-4000)}`));
    });
  });
}

/// The codec string every browser is asked about is built from the bitstream
/// that was actually produced, never from the flags that were asked for.
/// `hev1`/`avc1` with no `description` is the annex-b form; `hvc1`/`avc3` are
/// the mp4 forms and are not what travels here.
async function codecString(path) {
  const csv = await run('ffprobe', [
    '-v', 'error',
    '-select_streams', 'v:0',
    '-show_entries', 'stream=codec_name,profile,level',
    '-of', 'csv=p=0',
    path,
  ]);
  const [codecName, profile, level] = csv.trim().split(',');
  if (codecName === 'h264') {
    const profileIdc = { Baseline: 66, Main: 77, High: 100, 'High 10': 110 }[profile];
    if (!profileIdc) throw new Error(`unmapped h264 profile ${profile}`);
    const hex = (n) => n.toString(16).padStart(2, '0');
    return { codec: `avc1.${hex(profileIdc)}00${hex(Number(level))}`, profile, level: Number(level) };
  }
  if (codecName === 'hevc') {
    if (profile !== 'Main') throw new Error(`unmapped hevc profile ${profile}`);
    // hev1.<general_profile_space+idc>.<compat flags>.<tier><level_idc>.<constraints>
    return { codec: `hev1.1.6.L${Number(level)}.B0`, profile, level: Number(level) };
  }
  throw new Error(`unmapped codec ${codecName}`);
}

async function index(path) {
  const csv = await run('ffprobe', [
    '-v', 'error',
    '-select_streams', 'v:0',
    '-show_entries', 'packet=size,flags',
    '-of', 'csv=p=0',
    path,
  ]);
  const frames = csv
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const [size, flags] = line.split(',');
      return { len: Number(size), key: (flags ?? '').includes('K') };
    });
  return frames;
}

await mkdir(outDir, { recursive: true });

const manifest = [];
for (const target of TARGETS) {
  const path = join(outDir, target.file);
  await run('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', ...SOURCE, ...target.args, path]);
  const frames = await index(path);
  const { codec, profile, level } = await codecString(path);
  const bytes = (await stat(path)).size;
  const summed = frames.reduce((a, f) => a + f.len, 0);
  // If the demuxer's packets do not tile the file exactly, the page's offsets
  // would silently slide and every decode result after the first would be a lie.
  if (summed !== bytes) {
    throw new Error(`${target.file}: packets sum to ${summed} but the file is ${bytes} bytes`);
  }
  if (!frames[0]?.key) throw new Error(`${target.file}: first access unit is not a keyframe`);

  const meta = {
    name: target.name,
    file: target.file,
    codec,
    profile,
    level,
    width: WIDTH,
    height: HEIGHT,
    fps: FPS,
    bytes,
    keyframes: frames.filter((f) => f.key).length,
    frames,
  };
  await writeFile(join(outDir, `${target.name}.json`), JSON.stringify(meta, null, 2), 'utf8');
  manifest.push({ name: target.name, file: target.file, codec, frames: frames.length, bytes });
  console.log(`${target.file}: ${frames.length} access units, ${bytes} bytes, codec ${codec} (${profile} level ${level})`);
}

await writeFile(
  join(outDir, 'manifest.json'),
  JSON.stringify({ generatedAt: new Date().toISOString(), streams: manifest }, null, 2),
  'utf8',
);
console.log(`manifest: ${join(outDir, 'manifest.json')}`);
const raw = await readFile(join(outDir, 'manifest.json'), 'utf8');
console.log(raw);
