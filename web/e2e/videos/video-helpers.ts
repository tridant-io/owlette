/**
 * Video-capture helpers for the tutorial pipeline. Output: `<sceneName>.mp4` in
 * `dev/video-tutorials/footage/web/`.
 *
 * Playwright drives a HEADED chromeless window (`playwright.videos.config.ts`);
 * an external ffmpeg (`FfmpegRecorder`) captures the desktop via ddagrab +
 * h264_nvenc, falling back to gdigrab + libx264 on a box without DXGI/NVENC
 * (pin one path with `OWLETTE_VIDEO_CAPTURE_PATH=primary|fallback`). Playwright's
 * `recordVideo` is deliberately unused — ~25fps VP8 with opportunistic frame
 * grabs is fine for debugging, not for tutorials.
 *
 * Scenes draw a fake cursor (ffmpeg runs `draw_mouse=0`, so there is exactly one
 * pointer in frame) and `narrate()` dwells are sized to the rendered VO MP3s.
 *
 * Determinism: the clock is frozen BEFORE navigation. Never use `clock.install`
 * — it fakes rAF and freezes the scroll animation; `openForCapture` rAF-smokes
 * the setup so such a regression surfaces immediately, not 60s into a scene.
 */

import { mkdir } from 'node:fs/promises';
import { readFileSync, readdirSync, unlinkSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import type { Browser, Locator, Page } from '@playwright/test';
import { disableAnimations } from '../screenshots/docs-helpers';
import { FIXED_NOW_MS } from '../screenshots/fixtures';
import { FfmpegRecorder, planCapturePaths } from './ffmpeg-recorder';

/** Clean, named .mp4 output lands here. */
// Media lands in the production workspace, beside the scripts and audio it
// pairs with — not in e2e/.output, which holds only test diagnostics.
export const VIDEO_OUT_DIR = path.resolve(
  __dirname, '..', '..', '..', 'dev', 'video-tutorials', 'footage', 'web');

const VIEWPORT_WIDTH = 1920;
const VIEWPORT_HEIGHT = 1080;

/** Held on the start/end frame so every clip has stable bookends. */
const PRE_ROLL_MS = 150;
const POST_ROLL_MS = 150;

export interface RecordSceneOptions {
  /** App origin, e.g. http://127.0.0.1:3100. */
  baseURL: string;
  /** Path to a role storageState fixture (use `roleState('admin').storageState`). */
  storageState: string;
}

/**
 * Run `scene` in a fresh context with ffmpeg desktop capture, saving to
 * `dev/video-tutorials/footage/web/{sceneName}.mp4`. A throwing scene still stops the recorder
 * in `finally` — no orphaned ffmpeg, and the temp->final rename in
 * `FfmpegRecorder.stop` means a half-written file never poses as a valid clip.
 */
export async function recordScene(
  browser: Browser,
  sceneName: string,
  opts: RecordSceneOptions,
  scene: (page: Page) => Promise<void>,
): Promise<string> {
  await mkdir(VIDEO_OUT_DIR, { recursive: true });
  const outPath = path.join(VIDEO_OUT_DIR, `${sceneName}.mp4`);

  const context = await browser.newContext({
    baseURL: opts.baseURL,
    storageState: opts.storageState,
    // explicit, not inherited: footage must stay dark even if this runs outside a test's use block
    colorScheme: 'dark',
    // viewport + DPR come from the project use block in playwright.videos.config.ts
  });
  const page = await context.newPage();
  // Freeze Date only, so seeded "X minutes ago" labels are deterministic. NOT
  // `page.clock.setFixedTime`: on the installed version it routes rAF through
  // Playwright's ClockController and freezes the in-page scroll animation.
  await page.addInitScript((fixedTime: number) => {
    // Top frame ONLY. addInitScript runs in every frame, and a third-party
    // iframe that measures elapsed time via Date.now() deltas never finishes
    // against a frozen clock — Cloudflare Turnstile's auto-pass test widget
    // stalled exactly this way and kept ep02's create-account disabled. The
    // seeded relative-time labels all render in the top frame, so the freeze
    // loses nothing by skipping subframes.
    if (window.self !== window.top) return;
    const RealDate = Date;
    const FakeDate = class extends RealDate {
      constructor(...args: unknown[]) {
        if (args.length === 0) super(fixedTime);
        else super(...(args as ConstructorParameters<typeof RealDate>));
      }
      static now(): number { return fixedTime; }
    };
    FakeDate.UTC = RealDate.UTC;
    FakeDate.parse = RealDate.parse;
    (window as unknown as { Date: typeof Date }).Date = FakeDate as unknown as typeof Date;
  }, FIXED_NOW_MS);
  await installFakeCursor(page);

  // ddagrab captures desktop coordinates. Chrome-metric arithmetic has now
  // been measurably wrong twice (an 8px desktop L-shape, then a 6px titlebar
  // sliver): the visible chrome is NOT derivable from outer/inner sizes alone.
  // So remove the variable instead — true fullscreen has no chrome at all, the
  // renderer fills the display exactly, and the capture region is simply
  // (0,0) 1920x1080. Verified below, and again on pixels by assertEdgesClean.
  await page.goto('about:blank', { waitUntil: 'domcontentloaded' });
  try {
    const cdp = await context.newCDPSession(page);
    const { windowId } = (await cdp.send('Browser.getWindowForTarget')) as { windowId: number };
    await cdp.send('Browser.setWindowBounds', { windowId, bounds: { windowState: 'fullscreen' } });
  } catch (e) {
    await context.close();
    throw new Error(`[recordScene] could not fullscreen the window: ${e}`);
  }
  // Let the transition finish and Chromium's "to exit full screen" bubble
  // fade before any frame is captured.
  await page.waitForTimeout(4_500);
  const geom = await page.evaluate(() => ({
    x: window.screenX, y: window.screenY,
    outerW: window.outerWidth, outerH: window.outerHeight,
    innerW: window.innerWidth, innerH: window.innerHeight,
  }));
  if (geom.x !== 0 || geom.y !== 0 ||
      geom.outerW !== VIEWPORT_WIDTH || geom.outerH !== VIEWPORT_HEIGHT ||
      geom.innerW !== VIEWPORT_WIDTH || geom.innerH !== VIEWPORT_HEIGHT) {
    await context.close();
    throw new Error(
      `fullscreen geometry wrong: outer ${geom.outerW}×${geom.outerH} at (${geom.x},${geom.y}), ` +
      `inner ${geom.innerW}×${geom.innerH}; expected ${VIEWPORT_WIDTH}×${VIEWPORT_HEIGHT} at (0,0). ` +
      'Is the capture display 1920x1080 at 100% scale?',
    );
  }
  console.log(`[recordScene] fullscreen capture: ${VIEWPORT_WIDTH}×${VIEWPORT_HEIGHT} at (0,0)`);

  const recorder = new FfmpegRecorder({
    outPath,
    paths: planCapturePaths({
      offsetX: 0,
      offsetY: 0,
      width: VIEWPORT_WIDTH,
      height: VIEWPORT_HEIGHT,
    }),
    onStderr: (line) => {
      if (/error|fatal/i.test(line)) console.warn(`[ffmpeg] ${line}`);
    },
  });

  await recorder.start();
  beginTake(page, sceneName, outPath, recorder.videoEpochMs ?? undefined);
  await page.waitForTimeout(PRE_ROLL_MS);

  let sceneError: unknown = null;
  try {
    await scene(page);
    await finishTake(page);
    await page.waitForTimeout(POST_ROLL_MS);
  } catch (e) {
    sceneError = e;
  } finally {
    try { await recorder.stop(); } catch (stopErr) {
      console.warn(`[recordScene] recorder.stop error: ${stopErr}`);
    }
    try { await context.close(); } catch { /* best-effort */ }
  }

  if (sceneError) throw sceneError;
  // Vet the pixels before the take may pass — a green run with dirty frames is
  // exactly the failure mode that shipped a whole bordered batch.
  assertEdgesClean(outPath);
  return outPath;
}

/**
 * Visible cursor following Playwright's mouse events, plus a click ripple.
 * Re-injected on every navigation. ffmpeg runs `draw_mouse=0` so it can't double up.
 */
export async function installFakeCursor(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const CURSOR_ID = '__owl_cursor__';
    const mount = (): void => {
      if (!document.body || document.getElementById(CURSOR_ID)) return;
      const cursor = document.createElement('div');
      cursor.id = CURSOR_ID;
      cursor.style.cssText = [
        'position:fixed', 'left:0', 'top:0', 'z-index:2147483647',
        'width:20px', 'height:20px', 'margin:-2px 0 0 -2px', 'pointer-events:none',
        'filter:drop-shadow(0 1px 2px rgba(0,0,0,0.4))',
      ].join(';');
      cursor.innerHTML =
        '<svg width="20" height="20" viewBox="0 0 24 24" fill="white" stroke="black" stroke-width="1.2">' +
        '<path d="M5 3l14 7-6 1.5L10 18z"/></svg>';
      document.body.appendChild(cursor);

      window.addEventListener(
        'mousemove',
        (e) => {
          cursor.style.left = `${e.clientX}px`;
          cursor.style.top = `${e.clientY}px`;
        },
        true,
      );
      window.addEventListener(
        'mousedown',
        (e) => {
          const ripple = document.createElement('div');
          ripple.style.cssText = [
            'position:fixed', `left:${e.clientX - 14}px`, `top:${e.clientY - 14}px`,
            'width:28px', 'height:28px', 'border-radius:50%', 'pointer-events:none',
            'z-index:2147483646', 'border:2px solid rgba(99,102,241,0.95)',
          ].join(';');
          document.body.appendChild(ripple);
          ripple
            .animate(
              [
                { transform: 'scale(0.3)', opacity: 1 },
                { transform: 'scale(1.8)', opacity: 0 },
              ],
              { duration: 450, easing: 'ease-out' },
            )
            .addEventListener('finish', () => ripple.remove());
        },
        true,
      );
    };
    if (document.body) mount();
    else window.addEventListener('DOMContentLoaded', mount);
  });
}

/**
 * Open a path and quiet the page for capture. Asserts viewport + DPR (wrong
 * launch args = wrong capture region and blurry footage) and rAF-smokes 3 frames
 * in 500ms so a re-frozen rAF fails here, not 60s into the first scene.
 */
/** Pages that already carry the persistent animation-kill init script. */
const ANIM_KILL_PAGES = new WeakSet<Page>();

export async function openForCapture(page: Page, urlPath: string): Promise<void> {
  // No `page.clock.*` here — the fake clock is Date-only via addInitScript in
  // recordScene; page.clock would re-freeze rAF.
  // disableAnimations() below is an addStyleTag and dies on full navigations —
  // multi-identity scenes (02-day-zero signs out and back in via /login) then
  // run later documents with animations live, and an animating header never
  // reports "stable", so clicks time out. Re-install the same kill-style on
  // every future TOP-frame document; subframes (Turnstile) style themselves.
  if (!ANIM_KILL_PAGES.has(page)) {
    ANIM_KILL_PAGES.add(page);
    await page.addInitScript(() => {
      if (window.self !== window.top) return;
      const install = () => {
        const s = document.createElement('style');
        s.textContent =
          '*,*::before,*::after{animation-duration:0s!important;animation-delay:0s!important;' +
          'transition-duration:0s!important;transition-delay:0s!important}';
        (document.head ?? document.documentElement).appendChild(s);
      };
      if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', install);
      } else {
        install();
      }
    });
  }
  await page.goto(urlPath, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(1200);
  await disableAnimations(page);
  await settleAndStamp(page);
}

/**
 * Open a TITLE CARD — a standalone HTML file outside the app, loaded over
 * file:// — as the first shot of a take, with its reveal animation intact.
 *
 * Three things make this a separate function rather than a flag on
 * openForCapture:
 *
 * 1. The animation kill above is an INIT SCRIPT. Once installed it applies to
 *    every later document in the page, file:// included, and a card's reveal
 *    comes back `animation-duration: 0s` and already finished on frame one —
 *    silently, with every gate still green. Hence the hard guard: a title card
 *    must be the take's first navigation.
 * 2. The reveal must start AFTER the beat's in-point is stamped. Stamping takes
 *    ~1.5s (settle + assertions + the rAF probe), so an animation that ran on
 *    load would sit entirely before the conform's in-point and be cut off the
 *    front of the beat. The card keys its keyframes off `.owl-go`, which is
 *    added here, last.
 * 3. `waitUntil: 'load'` rather than domcontentloaded, so the webfont is in
 *    before the reveal — a FOUT mid-reveal bakes into the footage.
 */
export async function openTitleCard(page: Page, fileUrl: string): Promise<void> {
  if (ANIM_KILL_PAGES.has(page)) {
    throw new Error(
      'openTitleCard must be the FIRST navigation of a take: openForCapture has ' +
      'already installed the persistent animation kill, which would flatten the ' +
      "card's reveal to its end state without any error.",
    );
  }
  await page.goto(fileUrl, { waitUntil: 'load' });
  // Fonts before frames: document.fonts.ready also covers the @font-face above.
  await page.evaluate(() => document.fonts.ready.then(() => undefined));
  await settleAndStamp(page);
  await page.evaluate(() => document.documentElement.classList.add('owl-go'));
}

/**
 * Assert the capture geometry, prove rAF still ticks, and stamp the take's
 * first-content moment — the shared tail of every "the shot is ready now" path.
 */
async function settleAndStamp(page: Page): Promise<void> {
  const geom = await page.evaluate(() => ({
    w: window.innerWidth,
    h: window.innerHeight,
    dpr: window.devicePixelRatio,
  }));
  if (geom.w !== VIEWPORT_WIDTH || geom.h !== VIEWPORT_HEIGHT) {
    throw new Error(
      `capture geometry mismatch: viewport ${geom.w}x${geom.h} != ${VIEWPORT_WIDTH}x${VIEWPORT_HEIGHT}. ` +
      `Check the videos config's --window-size / --kiosk launch args and your monitor's Windows scaling (must be 100%).`,
    );
  }
  if (geom.dpr !== 1) {
    throw new Error(
      `capture DPR mismatch: devicePixelRatio ${geom.dpr} != 1. ` +
      `Set the primary monitor to 100% Windows scaling and re-launch.`,
    );
  }

  await page.evaluate(() => new Promise<void>((resolve, reject) => {
    let ticks = 0;
    const fail = setTimeout(
      () => reject(new Error('rAF smoke failed: < 3 callbacks within 500ms — clock setup has frozen requestAnimationFrame')),
      500,
    );
    function step(): void {
      ticks += 1;
      if (ticks >= 3) { clearTimeout(fail); resolve(); }
      else requestAnimationFrame(step);
    }
    requestAnimationFrame(step);
  }));

  // The scene's FIRST page is now ready: stamp it so the first beat's segment
  // starts on real content, not on the pre-roll + navigation lead-in (the
  // conform would otherwise open every episode on a loading flash).
  const take = TAKES.get(page);
  if (take && take.marks.length === 0 && take.firstContentSec === null) {
    take.firstContentSec = nowSec(take);
  }
}

/** Dwell long enough to lay this beat's narration MP3 underneath in the editor. */
// ── Beat-timing enforcement + sidecars ──────────────────────────────────────
// The first assembled timelines exposed two systemic failures: footage could
// run SHORTER than its narration (nothing enforced the relationship), and the
// timeline builder had no idea when each beat happened inside the footage.
// Both are fixed at the source: narrate() knows each beat's real MP3 duration
// (from assembly/manifests) and holds the picture at every beat boundary until
// the previous beat has earned its narration time; recordScene writes a
// `<scene>.beats.json` sidecar with the measured video timecode of every beat,
// which is what the Resolve builder cuts against.

const MANIFEST_DIR = path.resolve(
  __dirname, '..', '..', '..', 'dev', 'video-tutorials', 'assembly', 'manifests');
/** Extra picture per beat beyond its narration, so the editor has handles. */
const BEAT_MARGIN_S = 0.75;

interface BeatMark {
  beat: string;
  startSec: number;
  mp3Sec: number;
  enforcedWaitSec: number;
}
interface TakeState {
  sceneName: string;
  outPath: string;
  startMs: number;
  durations: Map<string, number>;
  marks: BeatMark[];
  /** When the scene's first page finished loading — the first beat's true start. */
  firstContentSec: number | null;
}

/**
 * Post-take pixel audit: sample the outermost left/bottom strips against inner
 * reference strips. The first batches shipped with 7-8px of desktop in frame
 * because the capture region trusted window math — this check makes that class
 * of bug fail the take instead of shipping. Both edges deviating = desktop in
 * frame = throw; one edge = warn (could be legitimate content).
 */
export function assertEdgesClean(outPath: string): void {
  const gray = (atSec: number, vf: string): Buffer => execFileSync('ffmpeg', [
    '-v', 'error', '-ss', String(atSec), '-i', outPath, '-frames:v', '1',
    '-vf', vf, '-f', 'rawvideo', '-pix_fmt', 'gray', '-',
  ], { maxBuffer: 4096 });
  const strip = (atSec: number, vf: string): number => {
    const buf = gray(atSec, vf);
    return buf.length ? buf[0] : 0;
  };
  let durationSec = 12;
  try {
    durationSec = Number.parseFloat(execFileSync('ffprobe', [
      '-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', outPath,
    ]).toString().trim()) || 12;
  } catch { /* judge on the fallback timestamps */ }

  // Contamination (window chrome / desktop inside the region) is constant, so
  // one dirty sample condemns the take. Sampling several timestamps guards the
  // other failure mode: a single early frame can predate navigation (black),
  // which proves nothing — hence the explicit content check on frame centers.
  let contentSeen = false;
  const details: string[] = [];
  let anyBoth = false;
  let anyOne = false;
  for (const frac of [0.25, 0.5, 0.8]) {
    const t = Math.max(1, Math.round(durationSec * frac));
    const left = strip(t, 'crop=6:ih:0:0,scale=1:1:flags=area');
    const leftRef = strip(t, 'crop=6:ih:24:0,scale=1:1:flags=area');
    const bottom = strip(t, 'crop=iw:6:0:ih-6,scale=1:1:flags=area');
    const bottomRef = strip(t, 'crop=iw:6:0:ih-36,scale=1:1:flags=area');
    // Content = the frame's PEAK luminance (signalstats YMAX). Averages and
    // even region grid-maxima fail on legitimately dim screens (the app's
    // unpaired state has only sidebar + footer text); any real UI frame has
    // bright text pixels somewhere (YMAX 180+), while a truly black capture
    // stays under ~25 even with compression noise.
    let peak = 0;
    try {
      const out = execFileSync('ffmpeg', [
        '-v', 'error', '-ss', String(t), '-i', outPath, '-frames:v', '1',
        '-vf', 'signalstats,metadata=print:key=lavfi.signalstats.YMAX:file=-',
        '-f', 'null', '-',
      ], { maxBuffer: 65536 }).toString();
      peak = Number.parseFloat(/YMAX=([\d.]+)/.exec(out)?.[1] ?? '0');
    } catch { /* leave peak at 0 — counts as no content at this sample */ }
    if (peak > 60) contentSeen = true;
    const leftBad = Math.abs(left - leftRef) > 20;
    const bottomBad = Math.abs(bottom - bottomRef) > 20;
    if (leftBad && bottomBad) anyBoth = true;
    else if (leftBad || bottomBad) anyOne = true;
    details.push(`@${t}s L${left}/${leftRef} B${bottom}/${bottomRef} peak${Math.round(peak)}`);
  }
  const detail = details.join('  ');
  if (anyBoth) {
    throw new Error(`capture-region contamination — desktop visible at the edges (${detail})`);
  }
  if (!contentSeen) {
    throw new Error(`take looks BLACK at every sampled frame — nothing was captured (${detail})`);
  }
  if (anyOne) {
    console.warn(`[edges] one edge deviates (${detail}) — eyeball this take`);
  } else {
    console.log(`[edges] clean (${detail})`);
  }
}
const TAKES = new WeakMap<Page, TakeState>();

function beatDurationsFor(sceneName: string): Map<string, number> {
  const out = new Map<string, number>();
  const ep = /^(\d{2})/.exec(sceneName)?.[1];
  if (!ep) return out;
  try {
    const file = readdirSync(MANIFEST_DIR).find((f) => f.startsWith(`${ep}-`) && f.endsWith('.json'));
    if (!file) return out;
    const manifest = JSON.parse(readFileSync(path.join(MANIFEST_DIR, file), 'utf-8')) as {
      beats?: Array<{ id?: string; duration_s?: number }>;
    };
    for (const b of manifest.beats ?? []) {
      if (b.id) out.set(b.id, typeof b.duration_s === 'number' ? b.duration_s : 0);
    }
  } catch (e) {
    console.warn(`[beats] no manifest durations for ${sceneName}: ${e}`);
  }
  return out;
}

export function beginTake(
  page: Page,
  sceneName: string,
  outPath: string,
  videoEpochMs?: number,
): void {
  // A sidecar must never outlive its take: delete the previous one NOW, so a
  // scene that throws mid-take leaves footage-without-sidecar (which the vet
  // flags as NO-SIDECAR) instead of new pixels silently paired with the old
  // take's timecodes — recorder.stop() replaces the .mp4 even on failure.
  try { unlinkSync(outPath.replace(/\.mp4$/, '.beats.json')); } catch { /* none yet */ }
  TAKES.set(page, {
    sceneName,
    outPath,
    // Timecodes must be measured on the VIDEO's clock: the recorder reports
    // when its t=0 frame was captured. Date.now() here runs ~a second late
    // (stderr progress lag), and every conform in-point would inherit it.
    startMs: videoEpochMs ?? Date.now(),
    durations: beatDurationsFor(sceneName),
    marks: [],
    firstContentSec: null,
  });
}

function nowSec(state: TakeState): number {
  return (Date.now() - state.startMs) / 1000;
}

/**
 * Hold the picture until this beat's on-screen time covers its narration +
 * margin. Called when the beat CLOSES (the next beat's first narrate, or
 * finishTake) — never mid-beat: an early hold freezes the frame before the
 * beat's remaining scripted motion, and the conform trim would then ship the
 * freeze and cut the motion (ep01's fleet pan sat frozen 24s that way).
 */
async function settleBeat(page: Page, state: TakeState, mark: BeatMark): Promise<void> {
  const required = mark.mp3Sec > 0 ? mark.mp3Sec + BEAT_MARGIN_S : 0;
  const shortfall = required - (nowSec(state) - mark.startSec);
  if (shortfall > 0.05) {
    mark.enforcedWaitSec += Math.round(shortfall * 100) / 100;
    console.log(`  [beats] holding ${mark.beat} +${shortfall.toFixed(1)}s to cover its narration`);
    await page.waitForTimeout(Math.round(shortfall * 1000));
  }
}

/** Settle the final beat, write the sidecar, and report per-beat coverage. */
export async function finishTake(page: Page): Promise<void> {
  const state = TAKES.get(page);
  if (!state) return;
  // A scene ending without a closing narrate still owes its last beat time.
  const last = state.marks[state.marks.length - 1];
  if (last) await settleBeat(page, state, last);
  const totalSec = nowSec(state);
  const beats = state.marks.map((m, i) => {
    const endSec = i + 1 < state.marks.length ? state.marks[i + 1].startSec : totalSec;
    return { ...m, startSec: Math.round(m.startSec * 100) / 100,
             videoSec: Math.round((endSec - m.startSec) * 100) / 100 };
  });
  const short = beats.filter((b) => b.mp3Sec > 0 && b.videoSec < b.mp3Sec - 0.05);
  for (const b of short) {
    console.warn(`[beats] ${state.sceneName} ${b.beat}: video ${b.videoSec}s < narration ${b.mp3Sec}s`);
  }
  const sidecar = state.outPath.replace(/\.mp4$/, '.beats.json');
  writeFileSync(sidecar, JSON.stringify(
    { scene: state.sceneName, totalSec: Math.round(totalSec * 100) / 100, beats }, null, 2));
  console.log(`[beats] ${beats.length} beat(s) → ${path.basename(sidecar)}` +
    (short.length ? `  !! ${short.length} SHORT` : '  (all cover narration)'));
  TAKES.delete(page);
}

export async function narrate(page: Page, beat: string, seconds: number): Promise<void> {
  const state = TAKES.get(page);
  const beatId = state ? /^b\d+/.exec(beat)?.[0] ?? null : null;
  if (state && beatId) {
    const last = state.marks[state.marks.length - 1];
    if (!last || last.beat !== beatId) {
      // Close the previous beat before opening this one — the enforcement hold
      // lands on ITS resting frame. The transition actions that ran between the
      // two beats sit in the previous beat's trimmed-off tail; this beat's
      // picture opens with its state already established.
      if (last) await settleBeat(page, state, last);
      if (!state.durations.has(beatId)) {
        // mp3Sec 0 disables the hold AND the conform can never match this id —
        // say so instead of silently recording an unenforced beat.
        console.warn(`[beats] ${state.sceneName}: ${beatId} is not in its manifest — no narration to enforce against`);
      }
      state.marks.push({
        beat: beatId,
        // The first beat starts when its page became ready (never on the
        // pre-roll/navigation lead-in); later beats start here, after the
        // previous beat settled.
        startSec: state.marks.length ? nowSec(state) : (state.firstContentSec ?? 0),
        mp3Sec: state.durations.get(beatId) ?? 0,
        enforcedWaitSec: 0,
      });
    }
  }
  console.log(`  [vo] ${beat} (~${seconds}s)`);
  await page.waitForTimeout(Math.round(seconds * 1000));
}

/** Glide, not teleport — the movement has to read on screen. */
export async function moveCursorTo(page: Page, locator: Locator): Promise<void> {
  await locator.scrollIntoViewIfNeeded();
  const box = await locator.boundingBox();
  if (!box) throw new Error('moveCursorTo: target has no bounding box (not visible?)');
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2, { steps: 24 });
}

/** Move to an element, pause a beat, then click it. */
export async function clickWithCursor(page: Page, locator: Locator): Promise<void> {
  await moveCursorTo(page, locator);
  await page.waitForTimeout(250);
  await locator.click();
}

/** Type into a field one character at a time so the keystrokes read on screen. */
export async function typewrite(
  page: Page,
  locator: Locator,
  text: string,
  perCharMs = 55,
): Promise<void> {
  await clickWithCursor(page, locator);
  await locator.pressSequentially(text, { delay: perCharMs });
}

/** Briefly outline an element to draw the eye (auto-clears). */
export async function highlight(page: Page, locator: Locator, ms = 1400): Promise<void> {
  await moveCursorTo(page, locator);
  await locator.evaluate((el: SVGElement | HTMLElement, dur: number) => {
    const prevOutline = el.style.outline;
    const prevOffset = el.style.outlineOffset;
    el.style.outline = '3px solid rgba(99,102,241,0.95)';
    el.style.outlineOffset = '3px';
    window.setTimeout(() => {
      el.style.outline = prevOutline;
      el.style.outlineOffset = prevOffset;
    }, dur);
  }, ms);
}

/**
 * Pan to the bottom over `seconds` from ONE in-page rAF loop, so the browser's
 * 60Hz paces every frame — a per-step CDP scrollBy staircases. Imperative
 * `scrollTo` because the harness globally disables CSS animation, which kills
 * `behavior: 'smooth'`. Dwells for `seconds` if the content already fits.
 *
 * CONSTANT SPEED, on purpose. This used easeInOutCubic, whose middle runs ~3x
 * the average velocity — over a long pan that reads as crawl → whoosh → crawl
 * ("speeds up, slows down"; flagged on the ep04 grid pan). Now the body of the
 * pan is linear with only an 8% ramp at each end so it does not jolt on
 * start/stop. Camera moves should be boring.
 */
export async function slowScrollToBottom(page: Page, seconds: number): Promise<void> {
  await page.evaluate(
    ({ duration }) => new Promise<void>((resolve) => {
      const startY = window.scrollY;
      const targetY = Math.max(
        0,
        document.documentElement.scrollHeight - window.innerHeight,
      );
      if (targetY - startY < 8) {
        setTimeout(resolve, duration);
        return;
      }
      const t0 = performance.now();
      // Linear with short smooth ramps: accelerate over the first `RAMP` of
      // progress, hold constant, decelerate over the last `RAMP`.
      const RAMP = 0.08;
      const ease = (t: number): number => {
        const flat = 1 - RAMP; // integral normalizer: ramps average half speed
        if (t < RAMP) return (t * t) / (2 * RAMP) / flat;
        if (t > 1 - RAMP) {
          const u = 1 - t;
          return (flat - (u * u) / (2 * RAMP)) / flat;
        }
        return (t - RAMP / 2) / flat;
      };
      function step(now: number): void {
        const p = Math.min(1, (now - t0) / duration);
        window.scrollTo(0, startY + (targetY - startY) * ease(p));
        if (p < 1) requestAnimationFrame(step);
        else {
          window.scrollTo(0, targetY);
          resolve();
        }
      }
      requestAnimationFrame(step);
    }),
    { duration: seconds * 1000 },
  );
}

/**
 * Slow camera push: animate a scale transform on <body> toward a focus point,
 * from ONE in-page rAF loop (CSS animations are disabled in the harness).
 * The "camera" language is real — a static dashboard hold reads dead on
 * camera, and a 1.00→1.06 drift over a beat is the difference between a
 * screenshot and a shot. Scale must stay >= 1 (pushing OUT would expose the
 * page edge to the recording). Playwright clicks remain accurate mid-push:
 * locator geometry is read post-transform. State survives navigations only
 * until the next load; push after the page you're framing is up.
 *
 * originXPct/originYPct place the push target as viewport percentages (50/50
 * = dead center). Successive calls animate from the current state, so a beat
 * can push in 1.06 toward a card and the next ease back to 1.0.
 */
export async function slowPush(
  page: Page,
  opts: { scale: number; originXPct?: number; originYPct?: number; seconds: number },
): Promise<void> {
  const { scale, originXPct = 50, originYPct = 50, seconds } = opts;
  await page.evaluate(
    ({ scale: target, ox, oy, duration }) =>
      new Promise<void>((resolve) => {
        // NEVER push while a portaled overlay is open. A transform on <body>
        // becomes the containing block for position:fixed descendants, so an
        // open Radix dialog/dropdown re-anchors to the document and JUMPS to
        // the top of the frame the instant the push starts (ep05 b04, on
        // camera). Skipping keeps such holds static, which is what they were
        // before motion existed. Dwell for the duration anyway so the beat's
        // time budget is unchanged.
        const overlayOpen = document.querySelector(
          '[role="dialog"][data-state="open"], [data-radix-popper-content-wrapper], [role="menu"][data-state="open"]',
        );
        const w = window as unknown as {
          __owlettePush?: { scale: number; ox: number; oy: number };
        };
        if (overlayOpen) {
          console.log('[slowPush] overlay open — skipping the move, dwelling instead');
          setTimeout(resolve, duration);
          return;
        }
        const from = w.__owlettePush ?? { scale: 1, ox: 50, oy: 50 };
        const t0 = performance.now();
        const RAMP = 0.2; // gentler ramps than the scroll: moves are tiny
        const flat = 1 - RAMP;
        const ease = (t: number): number => {
          if (t < RAMP) return (t * t) / (2 * RAMP) / flat;
          if (t > 1 - RAMP) {
            const u = 1 - t;
            return (flat - (u * u) / (2 * RAMP)) / flat;
          }
          return (t - RAMP / 2) / flat;
        };
        // Composited, or it steps: an un-promoted body layer re-rasters and
        // snaps to device pixels each frame — "walking down stairs instead of
        // gliding down a slide" (rosco, on every early take). will-change +
        // translateZ keep the layer on the GPU so each frame is a smooth
        // interpolation; at rest (scale exactly 1) everything is cleared so
        // the page re-rasters pixel-sharp.
        document.body.style.willChange = 'transform';
        function step(now: number): void {
          const p = Math.min(1, (now - t0) / duration);
          const k = ease(p);
          const s = from.scale + (target - from.scale) * k;
          const cx = from.ox + (ox - from.ox) * k;
          const cy = from.oy + (oy - from.oy) * k;
          document.body.style.transformOrigin = `${cx}% ${cy}%`;
          document.body.style.transform =
            p >= 1 && target === 1
              ? ''
              : `scale(${s.toFixed(6)}) translateZ(0)`;
          if (p < 1) requestAnimationFrame(step);
          else {
            if (target === 1) document.body.style.willChange = '';
            w.__owlettePush = { scale: target, ox, oy };
            resolve();
          }
        }
        requestAnimationFrame(step);
      }),
    { scale, ox: originXPct, oy: originYPct, duration: seconds * 1000 },
  );
}

/** Center an element in the viewport (for "zoom into one card" style framing). */
export async function centerInView(page: Page, locator: Locator): Promise<void> {
  await locator.scrollIntoViewIfNeeded();
  await locator.evaluate((el: Element) =>
    el.scrollIntoView({ block: 'center', behavior: 'instant' as ScrollBehavior }),
  );
}
