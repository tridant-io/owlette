/**
 * swoop smooth scaling — a webgl2 area average for a picture shown below 1:1.
 *
 * chromium and webkit draw a `<video>` with a bilinear filter and no mipmaps.
 * at 1:1 that is a copy and at 1:2 on whole device pixels a clean 2x2 average,
 * so the element draws those sizes itself. at any other size below 1:1 each
 * screen pixel blends the nearest machine pixels and skips the rest: below
 * half size thin strokes drop out, and between half and full size their
 * weights go uneven, which is the stair-stepped text of a window smaller than
 * the machine's screen. this renderer draws such a frame on a canvas over the
 * video instead, averaging every machine pixel under each screen pixel,
 * weighted by how much of it the screen pixel covers. that is the exact box
 * filter at any ratio, with no mip chain to build per frame and no blur
 * between levels. it averages in the encoded colour space, as the browser and
 * both systems' scalers do.
 *
 * it reverses plan D17's "no canvas in the shipping path"
 * (dev/active/swoop/plan.md) for minification only: see
 * dev/active/swoop-clarity/plan.md, C2 and C5. the `<video>` stays the
 * decoder and the fallback; this file draws only the frame it is handed, from
 * the one rvfc chain the receiver owns.
 *
 * it imports nothing and uses erasable typescript only, because the probe
 * (agent/swoop/spikes/smooth-probe) serves this very file to browsers through
 * node's `stripTypeScriptTypes`, so what the probe measures is what ships
 * (plan C16).
 *
 * measurements: tasks 4.1 (chromium, edge) and 3.4 (safari) record their
 * rows here. the webkitgtk check (task 5.2) is logged in
 * dev/active/swoop-clarity/tasks.md.
 *
 * the cover is the video at opacity 0 under the canvas (`under`; the owner's
 * ruling of 2026-11-10). a canvas over a video that is still composited makes
 * chromium's rendering step race the video compositor's own tick, and rvfc
 * callbacks coalesce whatever draws the frame: a canvas, rAF, a worker, a
 * `VideoFrame`, webgpu's zero-copy import and `desynchronized` all did it in
 * the probe (commit 400a7702), while the draw itself costs about 0.2 ms of
 * cpu and 0.1 ms of gpu. a video at opacity 0 is not composited, so the race
 * goes and the callbacks hold. chromium then counts every frame of it as
 * dropped (an uncomposited video submits nothing), so the freeze watchdog
 * counts this renderer's draws as shown (`video/stall.ts`). `draw` fades the
 * video in the same task as the canvas's first frame, and `hide` gives it
 * back, which context loss and `dispose` go through too.
 *
 * task 2.5's matrix (2026-11-07), before that cause was known: the probe
 * streamed a 1920x1080 source into a 1000x562 css box at dpr 1, three 20 s
 * runs per engine, both engines on this box's rtx 2080 ti through d3d11 (not
 * swiftshader), while other tasks' builds and tests loaded the box. each cell
 * is rvfc callbacks / totalVideoFrames / droppedVideoFrames:
 *
 *   engine                   none            canvas          under
 *   edge 157, headed         1174/1200/24    1171/1199/25    1156/1198/1198
 *                            909/1107/58 *   1121/1200/35    1140/1198/1199
 *                            1188/1200/11    1080/1129/49 *  1142/1198/1198
 *   chromium 156, headless   1187/1200/13    1119/1199/36    1146/1200/1199
 *                            1171/1200/22    1099/1199/24    1180/1200/1199
 *                            529/883/25 *    1147/1199/10    1184/1201/1199
 *
 *   * the box's load starved that run: its frames fell short of the source's 1200.
 *
 * under that matrix's rule (callbacks and frames within 5% of the bare video,
 * drops up by no more than 1% of frames) the canvas missed in headless
 * chromium and, rerun on a quiet box, in edge too; under kept its callbacks
 * and frames and failed only on the drops, which are the artifact above. the
 * rule is now: callbacks and totalVideoFrames within 5% of none's, and the
 * canvas's draws within 5% of none's frames less its drops. task 4.1's matrix
 * measures it.
 *
 * task 4.1 (2026-11-11): the probe's remote sender (a separate headless
 * chromium 156.0.8078.4 page streams the source, so the measured browser only
 * receives, decodes and draws) with `--receiver idle`, on the same rtx 2080
 * ti (driver 610.88) through d3d11 in both engines. `canvas` is the shipped
 * renderer, which hides the video, so it is `under`, and `under` was not run
 * again. each cell is rvfc callbacks / totalVideoFrames / droppedVideoFrames,
 * then the canvas's draws against none's frames less its drops.
 *
 *   1920x1080 into 1000x562, two 20 s runs per engine on a quiet box (cpu
 *   max 6-24% across each run, so the probe counts all four clean)
 *   engine                    none            canvas          draws / shown   rule
 *   edge 157.0.4341.42,       1189/1200/11    1173/1200/1199  1173 / 1189     holds: -1.3%, 0.0%, -1.3%
 *   headed                    1189/1200/9     1193/1201/1200  1193 / 1191     holds: +0.3%, +0.1%, +0.2%
 *   chromium 156.0.8078.4,    1176/1200/21    1179/1200/1200  1179 / 1179     holds: +0.3%, 0.0%, 0.0%
 *   headless                  1192/1200/4     1178/1200/1200  1178 / 1196     holds: -1.2%, 0.0%, -1.5%
 *
 *   the same, three runs each earlier, while another app's 4k ffmpeg exports
 *   held the cpu at 89-100% (none of them clean):
 *   engine                    none            canvas          draws / shown   rule
 *   edge 157.0.4341.42,       1025/1199/51    1084/1200/1200  1084 / 1148     fails: callbacks +5.8%, draws -5.6%
 *   headed                    1064/1199/118   1073/1197/1197  1073 / 1081     holds
 *                             1110/1201/67    1084/1201/1199  1084 / 1134     holds
 *   chromium 156.0.8078.4,    1083/1201/103   1092/1200/1200  1092 / 1098     holds
 *   headless                  1130/1200/34    1057/1202/1201  1057 / 1166     fails: callbacks -6.5%, draws -9.3%
 *                             1074/1196/84    1119/1193/1194  1119 / 1112     holds
 *
 *   the canvas's draw, cpu ms p50/p95/max: quiet, 0.2/0.3/0.4-1.1 in both
 *   engines; loaded, edge 0.3/0.4-0.6/1.5-3.9 and chromium 0.2-0.3/0.4-0.7/3.5-6.8.
 *   gpu (timer query): quiet, edge 0.20/0.21-0.22/1.8-2.7 and chromium
 *   0.22-0.23/0.40-1.79/2.9-3.3; loaded, 0.08-0.10/0.10-0.20/0.21-1.54.
 *
 *   3840x2160 into 1300x731, provisional: one 20 s run per engine, loaded (three tries
 *   each, as the loopback sender never held 60 fps: 600-1110 frames of
 *   1200), so only the draw counts. edge, over its three canvas tries and the
 *   latency run: cpu p50 0.3, p95 0.5-0.7, max 1.3-3.3 ms; gpu p50 0.20, p95
 *   0.20-0.25 ms. chromium: cpu 0.3/0.4-0.6/1.5-5.8 ms, gpu 0.19/0.19-0.20 ms.
 *
 *   latency in edge, 30 shots per cover, live - shown, median / p95. each
 *   pair is two fresh sessions, and none's own median moved 13-46 ms between
 *   them, so one pair cannot resolve a refresh; the pairs' median can:
 *   1920x1080 into 1000x562, quiet   none 13 / 15    canvas 33 / 34    +20 ms
 *                                    none 38 / 58    canvas 42 / 43    +4 ms
 *                                    none 46 / 49    canvas 35 / 36    -11 ms
 *   1920x1080 into 1000x562, loaded  none 39 / 58    canvas 44 / 60    +5 ms
 *   3840x2160 into 1300x731, loaded  none 403 / 436  canvas 391 / 424  -12 ms (the loopback's
 *                                    encoder holds about 400 ms, so 4k keeps only the draw gate)
 *
 * plan c15's gates: the 4k draw p95 in edge is 0.5-0.7 ms (gate 4 ms), and
 * the canvas adds 4 ms to the 1080p median, the median of the quiet pairs
 * (gate 16.7 ms), so both pass and smooth scaling stays on by default in
 * chromium desktop engines. one quiet pair read +20 ms against the lowest
 * none of all; glass to glass (task 8.1) is the check on it.
 */

/** the most source texels averaged per axis: exact down to 1/7, evenly sampled below that. */
const MAX_TAPS = 8;

/** warp over rdp or in a vm, llvmpipe on a linux vm, swiftshader in headless ci. */
const SOFTWARE_RENDERER = /swiftshader|llvmpipe|softpipe|warp|basic render|software/i;

// no `desynchronized`: it trades tearing for latency, and only the probe's
// measurements may argue for it (plan, backlog).
const CONTEXT: WebGLContextAttributes = {
  alpha: true,
  premultipliedAlpha: true,
  antialias: false,
  depth: false,
  stencil: false,
  preserveDrawingBuffer: false,
};

// one triangle over the whole canvas, from gl_VertexID alone.
const VERTEX_SHADER = `#version 300 es
void main() {
  gl_Position = vec4(float((gl_VertexID & 1) << 2) - 1.0, float((gl_VertexID & 2) << 1) - 1.0, 0.0, 1.0);
}
`;

const FRAGMENT_SHADER = `#version 300 es
precision highp float;
precision highp int;
precision highp sampler2D;

const int MAX_TAPS = ${MAX_TAPS};

uniform sampler2D frame;
// the picture's rect in device pixels: x and y from the canvas's bottom-left corner, then width and height.
uniform ivec4 dest;
uniform ivec2 source;

out vec4 colour;

// areaTaps() in smooth.ts, line for line.
int areaTaps(int index, int destSize, int srcSize, out int texel[MAX_TAPS], out float weight[MAX_TAPS]) {
  int start = index * srcSize;
  int end = start + srcSize;
  int first = start / destSize;
  int last = (end - 1) / destSize;
  if (last - first < MAX_TAPS) {
    for (int t = first; t <= last; t++) {
      texel[t - first] = t;
      weight[t - first] = float(min(end, (t + 1) * destSize) - max(start, t * destSize)) / float(srcSize);
    }
    return last - first + 1;
  }
  for (int k = 0; k < MAX_TAPS; k++) {
    texel[k] = (start * 2 * MAX_TAPS + (2 * k + 1) * srcSize) / (2 * MAX_TAPS * destSize);
    weight[k] = 1.0 / float(MAX_TAPS);
  }
  return MAX_TAPS;
}

void main() {
  ivec2 p = ivec2(gl_FragCoord.xy) - dest.xy;
  if (any(lessThan(p, ivec2(0))) || any(greaterThanEqual(p, dest.zw))) {
    colour = vec4(0.0);
    return;
  }
  int tx[MAX_TAPS];
  float wx[MAX_TAPS];
  int ty[MAX_TAPS];
  float wy[MAX_TAPS];
  int nx = areaTaps(p.x, dest.z, source.x, tx, wx);
  // gl_FragCoord counts rows up from the bottom; the frame's row 0 is its top.
  int ny = areaTaps(dest.w - 1 - p.y, dest.w, source.y, ty, wy);
  vec4 sum = vec4(0.0);
  for (int j = 0; j < ny; j++) {
    vec4 row = vec4(0.0);
    for (int i = 0; i < nx; i++) {
      row += wx[i] * texelFetch(frame, ivec2(tx[i], ty[j]), 0);
    }
    sum += wy[j] * row;
  }
  colour = sum;
}
`;

export interface SmoothTap {
  texel: number;
  weight: number;
}

/**
 * the source texels one output pixel averages on one axis, and their weights,
 * for whole sizes. the fragment shader's `areaTaps`, line for line, in
 * integers: positions are in units of 1/destSize of a texel, so texel t spans
 * [t·destSize, (t+1)·destSize) and output pixel `index` covers
 * [index·srcSize, (index+1)·srcSize). up to MAX_TAPS texels each get the
 * share of that footprint they cover; a wider footprint is sampled at the
 * centres of MAX_TAPS equal slices.
 */
export function areaTaps(index: number, destSize: number, srcSize: number): SmoothTap[] {
  const start = index * srcSize;
  const end = start + srcSize;
  const first = Math.floor(start / destSize);
  const last = Math.floor((end - 1) / destSize);
  const taps: SmoothTap[] = [];
  if (last - first < MAX_TAPS) {
    for (let t = first; t <= last; t++) {
      taps.push({ texel: t, weight: (Math.min(end, (t + 1) * destSize) - Math.max(start, t * destSize)) / srcSize });
    }
    return taps;
  }
  for (let k = 0; k < MAX_TAPS; k++) {
    taps.push({ texel: Math.floor((start * 2 * MAX_TAPS + (2 * k + 1) * srcSize) / (2 * MAX_TAPS * destSize)), weight: 1 / MAX_TAPS });
  }
  return taps;
}

/** the renderer a throwaway context reports, per caveat setting; null without webgl2. */
const probed = new Map<boolean, string | null>();

function probeRenderer(allowSoftware: boolean): string | null {
  const cached = probed.get(allowSoftware);
  if (cached !== undefined) return cached;
  let renderer: string | null = null;
  if (typeof document !== 'undefined') {
    const gl = document.createElement('canvas').getContext('webgl2', { failIfMajorPerformanceCaveat: !allowSoftware });
    if (gl) {
      const info = gl.getExtension('WEBGL_debug_renderer_info');
      renderer = String(gl.getParameter(info ? info.UNMASKED_RENDERER_WEBGL : gl.RENDERER));
      // browsers cap the live contexts on a page; free this one now, not at gc.
      gl.getExtension('WEBGL_lose_context')?.loseContext();
    }
  }
  probed.set(allowSoftware, renderer);
  return renderer;
}

/**
 * whether this browser may draw swoop's picture through the canvas: it has
 * rvfc, a webgl2 context that is not a major-performance-caveat one, and,
 * unless `allowSoftware`, a renderer that is not software. cached per value.
 */
export function smoothAvailable({ allowSoftware = false }: { allowSoftware?: boolean } = {}): boolean {
  // without rvfc the receiver plays with no frame chain (receiver.ts), so the
  // canvas would redraw only on a view change and leave a stale frame over a
  // live video.
  if (typeof HTMLVideoElement === 'undefined' || !('requestVideoFrameCallback' in HTMLVideoElement.prototype)) {
    return false;
  }
  const renderer = probeRenderer(allowSoftware);
  return renderer !== null && (allowSoftware || !SOFTWARE_RENDERER.test(renderer));
}

/** the renderer a webgl2 context gets here, software or not (for the probe and reports); null without webgl2. */
export function smoothRenderer(): string | null {
  return probeRenderer(true);
}

/** a rect in the canvas's device pixels, from its top-left corner; a DOMRect is one. */
export interface SmoothRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface SmoothRenderer {
  /** the canvas's size in device pixels. */
  resize(width: number, height: number): void;
  /**
   * averages the video's current frame into `dest`, the picture's rect,
   * transparent around it, and shows the canvas over the video, which it sets
   * to opacity 0.
   */
  draw(video: HTMLVideoElement, dest: SmoothRect): void;
  /** hides the canvas and gives the video its opacity back; the next draw shows it again. */
  hide(): void;
  dispose(): void;
  /** the context is lost (until the browser restores it) or the renderer disposed: callers show the video. */
  readonly lost: boolean;
}

interface Pipeline {
  program: WebGLProgram;
  texture: WebGLTexture;
  dest: WebGLUniformLocation | null;
  source: WebGLUniformLocation | null;
}

function compile(gl: WebGL2RenderingContext, type: number, text: string): WebGLShader | null {
  const shader = gl.createShader(type);
  if (shader) {
    gl.shaderSource(shader, text);
    gl.compileShader(shader);
  }
  return shader;
}

function build(gl: WebGL2RenderingContext): Pipeline | null {
  const program = gl.createProgram();
  const vertex = compile(gl, gl.VERTEX_SHADER, VERTEX_SHADER);
  const fragment = compile(gl, gl.FRAGMENT_SHADER, FRAGMENT_SHADER);
  const texture = gl.createTexture();
  if (program && vertex && fragment) {
    gl.attachShader(program, vertex);
    gl.attachShader(program, fragment);
    gl.linkProgram(program);
  }
  gl.deleteShader(vertex);
  gl.deleteShader(fragment);
  if (!program || !texture || !gl.getProgramParameter(program, gl.LINK_STATUS)) {
    gl.deleteProgram(program);
    gl.deleteTexture(texture);
    return null;
  }
  gl.useProgram(program);
  gl.uniform1i(gl.getUniformLocation(program, 'frame'), 0);
  gl.bindTexture(gl.TEXTURE_2D, texture);
  // texelFetch ignores filtering, but the default mipmapped min filter leaves a
  // one-level texture incomplete, and an incomplete texture reads black.
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  return {
    program,
    texture,
    dest: gl.getUniformLocation(program, 'dest'),
    source: gl.getUniformLocation(program, 'source'),
  };
}

/** a renderer on `canvas`, hidden until its first draw; null without webgl2 or when the shaders do not build. */
export function createSmoothRenderer(canvas: HTMLCanvasElement): SmoothRenderer | null {
  const gl = canvas.getContext('webgl2', CONTEXT);
  let pipeline = gl && build(gl);
  if (!gl || !pipeline) return null;

  let shown = true;
  // the video under the canvas, at opacity 0 while the canvas shows
  let covered: HTMLVideoElement | null = null;
  const hide = () => {
    if (!shown) return;
    canvas.style.visibility = 'hidden';
    if (covered) covered.style.opacity = '';
    covered = null;
    shown = false;
  };
  const onLost = (event: Event) => {
    // without preventDefault the browser never restores the context.
    event.preventDefault();
    pipeline = null;
    hide();
  };
  const onRestored = () => {
    pipeline = build(gl);
  };
  canvas.addEventListener('webglcontextlost', onLost);
  canvas.addEventListener('webglcontextrestored', onRestored);
  hide();

  return {
    resize(width, height) {
      // assigning a canvas size clears it, even an unchanged one.
      if (canvas.width !== width) canvas.width = width;
      if (canvas.height !== height) canvas.height = height;
    },
    draw(video, dest) {
      if (!pipeline || !video.videoWidth || !video.videoHeight) return;
      const x = Math.round(dest.x);
      const y = Math.round(dest.y);
      const width = Math.round(dest.width);
      const height = Math.round(dest.height);
      gl.viewport(0, 0, gl.drawingBufferWidth, gl.drawingBufferHeight);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, gl.RGBA, gl.UNSIGNED_BYTE, video);
      gl.uniform2i(pipeline.source, video.videoWidth, video.videoHeight);
      gl.uniform4i(pipeline.dest, x, gl.drawingBufferHeight - y - height, width, height);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
      if (!shown) {
        canvas.style.visibility = '';
        // in the same task as the canvas's first frame, so no frame shows both or neither
        video.style.opacity = '0';
        covered = video;
        shown = true;
      }
    },
    hide,
    dispose() {
      canvas.removeEventListener('webglcontextlost', onLost);
      canvas.removeEventListener('webglcontextrestored', onRestored);
      hide();
      if (pipeline) {
        gl.deleteProgram(pipeline.program);
        gl.deleteTexture(pipeline.texture);
        pipeline = null;
      }
    },
    get lost() {
      return !pipeline;
    },
  };
}
