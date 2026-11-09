// swoop-clarity: the smooth-probe's cover=webgpu, a candidate, not what ships.
// the same area average as web/lib/swoop/video/smooth.ts (areaTaps, line for
// line, in wgsl), drawn from importExternalTexture: the decoded frame is read
// in place, with no copy into an rgba texture first. opaque (alphaMode
// 'opaque', black outside the picture), or premultiplied and transparent
// outside it, as smooth.ts draws.

const MAX_TAPS = 8;

const shader = (outside) => /* wgsl */ `
const MAX_TAPS: i32 = ${MAX_TAPS};

struct Params {
  // the picture's rect in device pixels, from the canvas's top-left corner: x, y, width, height.
  dest: vec4<i32>,
  source: vec2<i32>,
}

@group(0) @binding(0) var frame: texture_external;
@group(0) @binding(1) var<uniform> params: Params;

@vertex
fn vs(@builtin(vertex_index) i: u32) -> @builtin(position) vec4<f32> {
  let v = i32(i);
  return vec4<f32>(f32((v & 1) << 2) - 1.0, f32((v & 2) << 1) - 1.0, 0.0, 1.0);
}

struct Taps {
  texel: array<i32, MAX_TAPS>,
  weight: array<f32, MAX_TAPS>,
  n: i32,
}

// areaTaps() in smooth.ts, line for line.
fn areaTaps(index: i32, destSize: i32, srcSize: i32) -> Taps {
  var t: Taps;
  let start = index * srcSize;
  let end = start + srcSize;
  let first = start / destSize;
  let last = (end - 1) / destSize;
  if (last - first < MAX_TAPS) {
    for (var s = first; s <= last; s++) {
      t.texel[s - first] = s;
      t.weight[s - first] = f32(min(end, (s + 1) * destSize) - max(start, s * destSize)) / f32(srcSize);
    }
    t.n = last - first + 1;
    return t;
  }
  for (var k = 0; k < MAX_TAPS; k++) {
    t.texel[k] = (start * 2 * MAX_TAPS + (2 * k + 1) * srcSize) / (2 * MAX_TAPS * destSize);
    t.weight[k] = 1.0 / f32(MAX_TAPS);
  }
  t.n = MAX_TAPS;
  return t;
}

@fragment
fn fs(@builtin(position) position: vec4<f32>) -> @location(0) vec4<f32> {
  let p = vec2<i32>(position.xy) - params.dest.xy;
  if (any(p < vec2<i32>(0)) || any(p >= params.dest.zw)) {
    return ${outside};
  }
  let tx = areaTaps(p.x, params.dest.z, params.source.x);
  let ty = areaTaps(p.y, params.dest.w, params.source.y);
  var sum = vec4<f32>(0.0);
  for (var j = 0; j < ty.n; j++) {
    var row = vec4<f32>(0.0);
    for (var i = 0; i < tx.n; i++) {
      row += tx.weight[i] * textureLoad(frame, vec2<i32>(tx.texel[i], ty.texel[j]));
    }
    sum += ty.weight[j] * row;
  }
  return vec4<f32>(sum.rgb, 1.0);
}
`;

/** a webgpu canvas of `width`x`height` device pixels that area-averages a video's current frame into it. */
export async function createGpuSmoothRenderer(canvas, width, height, { opaque = true } = {}) {
  if (!navigator.gpu) throw new Error('no navigator.gpu here');
  const adapter = await navigator.gpu.requestAdapter({ powerPreference: 'high-performance' });
  if (!adapter) throw new Error('no webgpu adapter');
  const device = await adapter.requestDevice();
  const info = adapter.info ?? {};
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext('webgpu');
  const format = navigator.gpu.getPreferredCanvasFormat();
  context.configure({ device, format, alphaMode: opaque ? 'opaque' : 'premultiplied' });
  const module = device.createShaderModule({ code: shader(opaque ? 'vec4<f32>(0.0, 0.0, 0.0, 1.0)' : 'vec4<f32>(0.0)') });
  const pipeline = device.createRenderPipeline({
    layout: 'auto',
    vertex: { module, entryPoint: 'vs' },
    fragment: { module, entryPoint: 'fs', targets: [{ format }] },
    primitive: { topology: 'triangle-list' },
  });
  const layout = pipeline.getBindGroupLayout(0);
  const uniforms = device.createBuffer({ size: 32, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
  const params = new Int32Array(8);
  let lost = false;
  device.lost.then(() => {
    lost = true;
  });
  return {
    adapter: `${info.vendor ?? ''} ${info.architecture ?? ''} ${info.description ?? ''}`.trim() || null,
    get lost() {
      return lost;
    },
    draw(video) {
      if (params[4] !== video.videoWidth || params[5] !== video.videoHeight || params[2] !== width) {
        params.set([0, 0, width, height, video.videoWidth, video.videoHeight, 0, 0]);
        device.queue.writeBuffer(uniforms, 0, params);
      }
      // an external texture lives until the task ends, so its bind group is made per frame.
      const bindGroup = device.createBindGroup({
        layout,
        entries: [
          { binding: 0, resource: device.importExternalTexture({ source: video }) },
          { binding: 1, resource: { buffer: uniforms } },
        ],
      });
      const encoder = device.createCommandEncoder();
      const pass = encoder.beginRenderPass({
        colorAttachments: [{ view: context.getCurrentTexture().createView(), loadOp: 'clear', storeOp: 'store', clearValue: { r: 0, g: 0, b: 0, a: opaque ? 1 : 0 } }],
      });
      pass.setPipeline(pipeline);
      pass.setBindGroup(0, bindGroup);
      pass.draw(3);
      pass.end();
      device.queue.submit([encoder.finish()]);
    },
  };
}
