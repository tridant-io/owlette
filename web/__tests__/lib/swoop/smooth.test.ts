/**
 * @jest-environment jsdom
 */

import { areaTaps, createSmoothRenderer } from '@/lib/swoop/video/smooth';

const UNMASKED_RENDERER_WEBGL = 0x9246;
const RENDERER = 0x1f01;

const NVIDIA = 'ANGLE (NVIDIA, NVIDIA GeForce RTX 2080 Ti (0x00001E07) Direct3D11 vs_5_0 ps_5_0, D3D11)';
const SWIFTSHADER = 'ANGLE (Google, Vulkan 1.3.0 (SwiftShader Device (Subzero) (0x0000C0DE)), SwiftShader driver)';

/** the part of a webgl2 context the availability probe reads. */
function probeGl(renderer: string, debugInfo = true) {
  const loseContext = jest.fn();
  return {
    RENDERER,
    loseContext,
    getExtension: (name: string) => {
      if (name === 'WEBGL_debug_renderer_info') return debugInfo ? { UNMASKED_RENDERER_WEBGL } : null;
      if (name === 'WEBGL_lose_context') return { loseContext };
      return null;
    },
    getParameter: (pname: number) => {
      if (pname === UNMASKED_RENDERER_WEBGL) return renderer;
      if (pname === RENDERER) return debugInfo ? 'WebKit WebGL' : renderer;
      return null;
    },
  };
}

function webgl2(make: (attributes?: WebGLContextAttributes) => unknown) {
  return jest
    .spyOn(HTMLCanvasElement.prototype, 'getContext')
    .mockImplementation(((type: string, attributes?: WebGLContextAttributes) =>
      type === 'webgl2' ? make(attributes) : null) as never);
}

function withRvfc() {
  Object.defineProperty(HTMLVideoElement.prototype, 'requestVideoFrameCallback', {
    configurable: true,
    value: () => 0,
  });
}

// a fresh module each time: availability is cached at module level.
async function fresh() {
  jest.resetModules();
  return import('@/lib/swoop/video/smooth');
}

afterEach(() => {
  delete (HTMLVideoElement.prototype as unknown as Record<string, unknown>).requestVideoFrameCallback;
  jest.restoreAllMocks();
});

describe('areaTaps', () => {
  it('averages two texels at 2:1', () => {
    expect(areaTaps(5, 640, 1280)).toEqual([
      { texel: 10, weight: 0.5 },
      { texel: 11, weight: 0.5 },
    ]);
  });

  it('averages three texels at 3:1', () => {
    const taps = areaTaps(2, 100, 300);
    expect(taps.map((tap) => tap.texel)).toEqual([6, 7, 8]);
    for (const tap of taps) expect(tap.weight).toBeCloseTo(1 / 3, 12);
  });

  it('weighs the texels a 4:3 footprint overlaps by how much of each it covers', () => {
    expect(areaTaps(0, 3, 4)).toEqual([
      { texel: 0, weight: 0.75 },
      { texel: 1, weight: 0.25 },
    ]);
    expect(areaTaps(1, 3, 4)).toEqual([
      { texel: 1, weight: 0.5 },
      { texel: 2, weight: 0.5 },
    ]);
    expect(areaTaps(2, 3, 4)).toEqual([
      { texel: 2, weight: 0.25 },
      { texel: 3, weight: 0.75 },
    ]);
  });

  it.each([
    [1000, 1920],
    [1300, 3840],
    [731, 2160],
    [562, 1080],
    [300, 2099],
    [640, 1280],
    [100, 3840],
    [7, 50],
    [1, 8000],
    [3, 4],
  ])('weighs to 1 with at most 8 texels from the footprint, at %i from %i', (destSize, srcSize) => {
    // one expect per size: an expect per pixel makes the 4k cases take seconds.
    const wrong: number[] = [];
    for (let index = 0; index < destSize; index++) {
      const taps = areaTaps(index, destSize, srcSize);
      const weight = taps.reduce((sum, tap) => sum + tap.weight, 0);
      const first = Math.floor((index * srcSize) / destSize);
      const last = Math.min(Math.floor(((index + 1) * srcSize - 1) / destSize), srcSize - 1);
      const outside = taps.some((tap) => tap.texel < first || tap.texel > last);
      if (taps.length === 0 || taps.length > 8 || Math.abs(weight - 1) > 1e-9 || outside) wrong.push(index);
    }
    expect(wrong).toEqual([]);
  });

  it('is exact down to 1/7, and samples 8 evenly spaced texels below it', () => {
    expect(areaTaps(3, 100, 700)).toEqual([21, 22, 23, 24, 25, 26, 27].map((texel) => ({ texel, weight: 1 / 7 })));
    // 38.4 texels per pixel: the centres of eight 4.8-texel slices of [38.4, 76.8).
    expect(areaTaps(1, 100, 3840)).toEqual([40, 45, 50, 55, 60, 64, 69, 74].map((texel) => ({ texel, weight: 1 / 8 })));
  });
});

describe('smoothAvailable', () => {
  it('is false in jsdom, which has neither rvfc nor webgl2', async () => {
    const { smoothAvailable } = await fresh();
    expect(smoothAvailable()).toBe(false);
    expect(smoothAvailable({ allowSoftware: true })).toBe(false);
  });

  it('is false without rvfc, even on a hardware renderer', async () => {
    webgl2(() => probeGl(NVIDIA));
    const { smoothAvailable } = await fresh();
    expect(smoothAvailable()).toBe(false);
  });

  it('is false without webgl2', async () => {
    withRvfc();
    webgl2(() => null);
    const { smoothAvailable, smoothRenderer } = await fresh();
    expect(smoothAvailable()).toBe(false);
    expect(smoothAvailable({ allowSoftware: true })).toBe(false);
    expect(smoothRenderer()).toBeNull();
  });

  it('is true on a hardware renderer, asking for no performance caveat, and releases its context once', async () => {
    withRvfc();
    const gl = probeGl(NVIDIA);
    const getContext = webgl2(() => gl);
    const { smoothAvailable, smoothRenderer } = await fresh();
    expect(smoothAvailable()).toBe(true);
    expect(smoothAvailable()).toBe(true);
    expect(getContext).toHaveBeenCalledTimes(1);
    expect(getContext).toHaveBeenCalledWith('webgl2', { failIfMajorPerformanceCaveat: true });
    expect(gl.loseContext).toHaveBeenCalledTimes(1);
    expect(smoothRenderer()).toBe(NVIDIA);
  });

  it('refuses swiftshader unless software is allowed, which drops the caveat', async () => {
    withRvfc();
    const getContext = webgl2(() => probeGl(SWIFTSHADER));
    const { smoothAvailable } = await fresh();
    expect(smoothAvailable()).toBe(false);
    expect(smoothAvailable({ allowSoftware: true })).toBe(true);
    expect(getContext).toHaveBeenLastCalledWith('webgl2', { failIfMajorPerformanceCaveat: false });
  });

  it.each([
    'ANGLE (Microsoft, Microsoft Basic Render Driver (0x0000008C) Direct3D11 vs_5_0 ps_5_0, D3D11)',
    'llvmpipe (LLVM 15.0.7, 256 bits)',
    'softpipe',
    'Google SwiftShader',
  ])('refuses the software renderer %s', async (renderer) => {
    withRvfc();
    webgl2(() => probeGl(renderer));
    const { smoothAvailable } = await fresh();
    expect(smoothAvailable()).toBe(false);
  });

  it('reads the context renderer where the debug renderer info is not offered', async () => {
    withRvfc();
    webgl2(() => probeGl('NVIDIA GeForce GTX 980, or similar', false));
    const { smoothAvailable, smoothRenderer } = await fresh();
    expect(smoothRenderer()).toBe('NVIDIA GeForce GTX 980, or similar');
    expect(smoothAvailable()).toBe(true);
  });
});

/** a webgl2 context that records its calls; constants read as their own names. */
function recordingGl(linked = true) {
  const calls: { name: string; args: unknown[] }[] = [];
  const fields: Record<string, unknown> = { drawingBufferWidth: 1300, drawingBufferHeight: 800 };
  const gl = new Proxy(fields, {
    get(target, key) {
      if (typeof key !== 'string') return undefined;
      if (key in target) return target[key];
      if (/^[A-Z0-9_]+$/.test(key)) return key;
      return (...args: unknown[]) => {
        calls.push({ name: key, args });
        return key === 'getProgramParameter' ? linked : {};
      };
    },
  });
  return { gl, calls, count: (name: string) => calls.filter((call) => call.name === name).length };
}

function frame(width: number, height: number) {
  return { videoWidth: width, videoHeight: height, style: { opacity: '' } } as unknown as HTMLVideoElement;
}

describe('createSmoothRenderer', () => {
  it('asks for a transparent context with nothing it does not use, and starts hidden', () => {
    const { gl } = recordingGl();
    const getContext = webgl2(() => gl);
    const canvas = document.createElement('canvas');
    expect(createSmoothRenderer(canvas)).not.toBeNull();
    expect(getContext).toHaveBeenCalledWith('webgl2', {
      alpha: true,
      premultipliedAlpha: true,
      antialias: false,
      depth: false,
      stencil: false,
      preserveDrawingBuffer: false,
    });
    expect(canvas.style.visibility).toBe('hidden');
  });

  it('is null without webgl2, or when its program does not link', () => {
    webgl2(() => null);
    expect(createSmoothRenderer(document.createElement('canvas'))).toBeNull();
    webgl2(() => recordingGl(false).gl);
    expect(createSmoothRenderer(document.createElement('canvas'))).toBeNull();
  });

  it('uploads the frame and draws one full-canvas pass with the picture counted from the bottom edge', () => {
    const { gl, calls } = recordingGl();
    webgl2(() => gl);
    const canvas = document.createElement('canvas');
    const renderer = createSmoothRenderer(canvas)!;
    const video = frame(3840, 2160);
    renderer.draw(video, { x: 10, y: 20, width: 1280, height: 720 });
    const drawn = calls.slice(calls.findIndex((call) => call.name === 'viewport'));
    expect(drawn.map((call) => [call.name, ...call.args.filter((arg) => typeof arg !== 'object')])).toEqual([
      ['viewport', 0, 0, 1300, 800],
      ['texImage2D', 'TEXTURE_2D', 0, 'RGBA8', 'RGBA', 'UNSIGNED_BYTE'],
      ['uniform2i', 3840, 2160],
      ['uniform4i', 10, 60, 1280, 720],
      ['drawArrays', 'TRIANGLES', 0, 3],
    ]);
    expect(drawn[1].args[5]).toBe(video);
    expect(canvas.style.visibility).toBe('');
    renderer.hide();
    expect(canvas.style.visibility).toBe('hidden');
  });

  // composited under the canvas, the video's own tick races the draw and rvfc callbacks coalesce
  it('takes the video out of the composite while the canvas shows, and gives it back on hide', () => {
    webgl2(() => recordingGl().gl);
    const canvas = document.createElement('canvas');
    const renderer = createSmoothRenderer(canvas)!;
    const video = frame(3840, 2160);
    expect(video.style.opacity).toBe('');
    renderer.draw(video, { x: 0, y: 0, width: 1000, height: 562 });
    expect(video.style.opacity).toBe('0');
    renderer.draw(video, { x: 0, y: 0, width: 1000, height: 562 });
    expect(video.style.opacity).toBe('0');
    renderer.hide();
    expect(video.style.opacity).toBe('');
    renderer.draw(video, { x: 0, y: 0, width: 1000, height: 562 });
    renderer.dispose();
    expect(video.style.opacity).toBe('');
  });

  it('draws nothing before the first frame', () => {
    const { gl, count } = recordingGl();
    webgl2(() => gl);
    const canvas = document.createElement('canvas');
    const video = frame(0, 0);
    createSmoothRenderer(canvas)!.draw(video, { x: 0, y: 0, width: 100, height: 100 });
    expect(count('drawArrays')).toBe(0);
    expect(canvas.style.visibility).toBe('hidden');
    expect(video.style.opacity).toBe('');
  });

  it('is lost and hidden when the context goes, and draws again once it is restored', () => {
    const { gl, count } = recordingGl();
    webgl2(() => gl);
    const canvas = document.createElement('canvas');
    const renderer = createSmoothRenderer(canvas)!;
    const dest = { x: 0, y: 0, width: 640, height: 360 };
    const video = frame(1280, 720);
    renderer.draw(video, dest);

    const lost = new Event('webglcontextlost', { cancelable: true });
    canvas.dispatchEvent(lost);
    expect(lost.defaultPrevented).toBe(true);
    expect(renderer.lost).toBe(true);
    expect(canvas.style.visibility).toBe('hidden');
    expect(video.style.opacity).toBe('');
    renderer.draw(frame(1280, 720), dest);
    expect(count('drawArrays')).toBe(1);

    canvas.dispatchEvent(new Event('webglcontextrestored'));
    expect(renderer.lost).toBe(false);
    expect(count('linkProgram')).toBe(2);
    renderer.draw(frame(1280, 720), dest);
    expect(count('drawArrays')).toBe(2);
  });

  it('frees its resources on dispose and ignores a later restore', () => {
    const { gl, count } = recordingGl();
    webgl2(() => gl);
    const canvas = document.createElement('canvas');
    const renderer = createSmoothRenderer(canvas)!;
    renderer.draw(frame(1280, 720), { x: 0, y: 0, width: 640, height: 360 });
    renderer.dispose();
    expect(renderer.lost).toBe(true);
    expect(canvas.style.visibility).toBe('hidden');
    expect(count('deleteProgram')).toBe(1);
    expect(count('deleteTexture')).toBe(1);
    canvas.dispatchEvent(new Event('webglcontextrestored'));
    expect(renderer.lost).toBe(true);
  });

  it('resizes the canvas only when its size changes, since any assignment clears it', () => {
    webgl2(() => recordingGl().gl);
    const canvas = document.createElement('canvas');
    const renderer = createSmoothRenderer(canvas)!;
    const width = jest.spyOn(canvas, 'width', 'set');
    renderer.resize(1300, 800);
    renderer.resize(1300, 800);
    expect(width).toHaveBeenCalledTimes(1);
    expect([canvas.width, canvas.height]).toEqual([1300, 800]);
  });
});
