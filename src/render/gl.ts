/**
 * WebGL2 基础设施。
 *
 * 刻意不引入 Three.js：2.5D 分层 + 全屏着色器 pass 用原生 API 更瘦、更可控，
 * 也更符合「计算生成」的调性。整个渲染器需要的只有——
 * 全屏三角形、几个 framebuffer、以及把 uniform 塞进去。
 *
 * @see DESIGN.md §3.3
 */

export type GL = WebGL2RenderingContext;

export interface RenderTarget {
  texture: WebGLTexture;
  framebuffer: WebGLFramebuffer;
  width: number;
  height: number;
  dispose(): void;
}

/** 全屏三角形的顶点着色器。用 gl_VertexID 生成，不需要任何顶点缓冲。 */
export const FULLSCREEN_VS = `#version 300 es
precision highp float;
out vec2 vUv;
void main() {
  vec2 p = vec2(float((gl_VertexID << 1) & 2), float(gl_VertexID & 2));
  vUv = p;
  gl_Position = vec4(p * 2.0 - 1.0, 0.0, 1.0);
}
`;

/**
 * 把 GLSL 编译错误翻译成人能看的东西。
 *
 * 驱动给的原始信息是形如 `ERROR: 0:37: 'foo' : undeclared identifier`，
 * 光看这行没法定位。这里把行号对应到源码，并把出错行连同上下文打出来。
 * 迭代着色器时这是省时间最多的一段代码。
 */
function formatShaderError(source: string, rawLog: string, stage: string): string {
  const lines = source.split('\n');
  const decorated = rawLog
    .split('\n')
    .filter((l) => l.trim().length > 0)
    .map((line) => {
      const m = /^\s*(?:ERROR|WARNING):\s*\d+:(\d+):\s*(.*)$/.exec(line);
      if (!m) return `  ${line}`;
      const lineNo = Number(m[1]);
      const message = m[2];
      const idx = lineNo - 1;
      const ctx: string[] = [];
      for (let i = Math.max(0, idx - 2); i <= Math.min(lines.length - 1, idx + 2); i++) {
        const mark = i === idx ? '>' : ' ';
        ctx.push(`    ${mark} ${String(i + 1).padStart(4)} | ${lines[i] ?? ''}`);
      }
      return `  ${message}\n${ctx.join('\n')}`;
    })
    .join('\n');

  return `[${stage}] 着色器编译失败：\n${decorated}\n\n--- 完整源码 ---\n${lines
    .map((l, i) => `${String(i + 1).padStart(4)} | ${l}`)
    .join('\n')}`;
}

function compileShader(gl: GL, type: number, source: string): WebGLShader {
  const shader = gl.createShader(type);
  if (!shader) throw new Error('无法创建着色器对象（上下文可能已丢失）');
  gl.shaderSource(shader, source);
  gl.compileShader(shader);
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    const log = gl.getShaderInfoLog(shader) ?? '(无日志)';
    gl.deleteShader(shader);
    throw new Error(
      formatShaderError(source, log, type === gl.VERTEX_SHADER ? '顶点' : '片元'),
    );
  }
  return shader;
}

export interface UniformInfo {
  location: WebGLUniformLocation;
  type: number;
  size: number;
}

/**
 * 着色器程序的公共部分：编译、链接、以及按名字缓存并派发 uniform。
 *
 * 抽成基类是因为 P3 引入了顶点管线 —— 网格程序（鱼）和全屏程序
 * （水与光）在 uniform 这块完全一样，只差顶点输入。复制一份 90 行的
 * setter 迟早会两边不一致。
 */
abstract class ProgramBase {
  readonly program: WebGLProgram;
  protected readonly gl: GL;
  private readonly uniforms = new Map<string, UniformInfo>();

  constructor(gl: GL, program: WebGLProgram) {
    this.gl = gl;
    this.program = program;

    const count = gl.getProgramParameter(program, gl.ACTIVE_UNIFORMS) as number;
    for (let i = 0; i < count; i++) {
      const info = gl.getActiveUniform(program, i);
      if (!info) continue;
      const location = gl.getUniformLocation(program, info.name);
      if (!location) continue;
      // 数组 uniform 的名字形如 uFoo[0]，同时按两种键缓存
      this.uniforms.set(info.name, { location, type: info.type, size: info.size });
      const base = info.name.replace(/\[0\]$/, '');
      if (!this.uniforms.has(base)) {
        this.uniforms.set(base, { location, type: info.type, size: info.size });
      }
    }
  }

  use(): this {
    this.gl.useProgram(this.program);
    return this;
  }

  protected loc(name: string): WebGLUniformLocation | null {
    return this.uniforms.get(name)?.location ?? null;
  }

  // —— uniform 写入。名字不存在时静默跳过：着色器里被优化掉的
  //    未使用 uniform 不该让渲染循环抛异常 ——

  float(name: string, v: number): this {
    const l = this.loc(name);
    if (l) this.gl.uniform1f(l, v);
    return this;
  }

  int(name: string, v: number): this {
    const l = this.loc(name);
    if (l) this.gl.uniform1i(l, v | 0);
    return this;
  }

  vec2(name: string, x: number, y: number): this {
    const l = this.loc(name);
    if (l) this.gl.uniform2f(l, x, y);
    return this;
  }

  vec3(name: string, x: number, y: number, z: number): this {
    const l = this.loc(name);
    if (l) this.gl.uniform3f(l, x, y, z);
    return this;
  }

  vec3a(name: string, v: readonly [number, number, number]): this {
    return this.vec3(name, v[0], v[1], v[2]);
  }

  vec4(name: string, x: number, y: number, z: number, w: number): this {
    const l = this.loc(name);
    if (l) this.gl.uniform4f(l, x, y, z, w);
    return this;
  }

  /** 上传一个 vec2 数组（鱼的脊柱点就是用它传的）。 */
  vec2Array(name: string, data: Float32Array): this {
    const l = this.loc(name);
    if (l) this.gl.uniform2fv(l, data);
    return this;
  }

  /** 上传一个 float 数组（每个网格实例的逐顶点参数）。 */
  floatArray(name: string, data: Float32Array): this {
    const l = this.loc(name);
    if (l) this.gl.uniform1fv(l, data);
    return this;
  }

  texture(name: string, unit: number, tex: WebGLTexture): this {
    const l = this.loc(name);
    if (!l) return this;
    const gl = this.gl;
    gl.activeTexture(gl.TEXTURE0 + unit);
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.uniform1i(l, unit);
    return this;
  }

  dispose(): void {
    this.gl.deleteProgram(this.program);
    this.uniforms.clear();
  }
}

/** 全屏三角形的程序。P0 起就在用，P3 只是把它挪到了基类之上。 */
export class Program extends ProgramBase {
  private readonly source: { vs: string; fs: string };

  constructor(gl: GL, fragmentSource: string, vertexSource = FULLSCREEN_VS) {
    const vs = compileShader(gl, gl.VERTEX_SHADER, vertexSource);
    const fs = compileShader(gl, gl.FRAGMENT_SHADER, fragmentSource);
    const program = linkProgram(gl, vs, fs);
    super(gl, program);
    this.source = { vs: vertexSource, fs: fragmentSource };
  }

  get debugSource(): { vs: string; fs: string } {
    return this.source;
  }
}

/**
 * 带顶点属性的程序。P3 引入 —— 鱼是**每帧都在变形**的几何体，
 * 烘焙成纹理那条路（植物用的）对它不成立。
 */
export class MeshProgram extends ProgramBase {
  private readonly attribs = new Map<string, number>();

  constructor(gl: GL, vertexSource: string, fragmentSource: string, attributes: readonly string[]) {
    const vs = compileShader(gl, gl.VERTEX_SHADER, vertexSource);
    const fs = compileShader(gl, gl.FRAGMENT_SHADER, fragmentSource);
    const program = linkProgram(gl, vs, fs);
    super(gl, program);

    for (const name of attributes) {
      const loc = gl.getAttribLocation(program, name);
      // 被优化掉的属性返回 -1 —— 那不是错误，只是这个程序没用到它
      this.attribs.set(name, loc);
    }
  }

  attrib(name: string): number {
    return this.attribs.get(name) ?? -1;
  }
}

function linkProgram(gl: GL, vs: WebGLShader, fs: WebGLShader): WebGLProgram {
  const program = gl.createProgram();
  if (!program) throw new Error('无法创建 program 对象');
  gl.attachShader(program, vs);
  gl.attachShader(program, fs);
  gl.linkProgram(program);

  // 链接完成后 shader 对象就可以删了，program 会持有引用
  gl.deleteShader(vs);
  gl.deleteShader(fs);

  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
    const log = gl.getProgramInfoLog(program) ?? '(无日志)';
    gl.deleteProgram(program);
    throw new Error(`[链接] 失败：${log}`);
  }
  return program;
}

export interface ContextOptions {
  /** 需要浮点渲染目标（HDR bloom）。不可用时退回 8 位，画面会稍平但不会崩。 */
  preferFloatTargets?: boolean;
  /** 覆盖层需要与页面合成，所以要 alpha 而不是不透明黑底 */
  alpha?: boolean;
  powerPreference?: WebGLPowerPreference;
}

export interface RendererContext {
  gl: GL;
  canvas: HTMLCanvasElement;
  /** 是否支持浮点渲染目标 */
  floatTargets: boolean;
  /** 显卡型号字符串，用于软件渲染探测 */
  renderer: string;
  /** 是否在用软件光栅化（SwiftShader / llvmpipe）。是的话必须降画质。 */
  software: boolean;
}

/**
 * 建立 WebGL2 上下文。
 *
 * 失败时抛出带可读原因的异常 —— 上层据此决定是否退到 Canvas2D 静帧。
 */
export function createContext(
  canvas: HTMLCanvasElement,
  opts: ContextOptions = {},
): RendererContext {
  const attributes: WebGLContextAttributes = {
    alpha: opts.alpha ?? false,
    antialias: false, // 我们自己做后期，MSAA 没意义还费带宽
    depth: false,
    stencil: false,
    premultipliedAlpha: true,
    preserveDrawingBuffer: false,
    powerPreference: opts.powerPreference ?? 'default',
    desynchronized: true,
    failIfMajorPerformanceCaveat: false,
  };

  const gl = canvas.getContext('webgl2', attributes) as GL | null;
  if (!gl) {
    throw new Error('WebGL2 不可用。请检查 chrome://gpu 的硬件加速状态。');
  }

  // 浮点渲染目标是 HDR bloom 的前提。拿不到就退回 8 位，不能因此不渲染。
  let floatTargets = false;
  if (opts.preferFloatTargets !== false) {
    floatTargets =
      gl.getExtension('EXT_color_buffer_float') !== null ||
      gl.getExtension('EXT_color_buffer_half_float') !== null;
  }

  const renderer = describeRenderer(gl);

  return {
    gl,
    canvas,
    floatTargets,
    renderer,
    software: /swiftshader|llvmpipe|software|basic render/i.test(renderer),
  };
}

/**
 * 读取显卡型号。
 *
 * `WEBGL_debug_renderer_info` 在新版 Chrome 里被收紧，可能返回空字符串，
 * 所以拿不到时不能报错，只能退回「未知」并保守处理。
 */
export function describeRenderer(gl: GL): string {
  try {
    const ext = gl.getExtension('WEBGL_debug_renderer_info');
    if (ext) {
      const r = gl.getParameter(ext.UNMASKED_RENDERER_WEBGL);
      if (typeof r === 'string' && r.length > 0) return r;
    }
    const fallback = gl.getParameter(gl.RENDERER);
    return typeof fallback === 'string' ? fallback : '未知渲染器';
  } catch {
    return '未知渲染器';
  }
}

/**
 * 建一个渲染目标。
 *
 * 用线性过滤 + CLAMP_TO_EDGE：辉光模糊要在上面采样，
 * 边缘必须夹住，否则会从对边漏出亮边。
 */
export function createRenderTarget(
  gl: GL,
  width: number,
  height: number,
  float: boolean,
): RenderTarget {
  const texture = gl.createTexture();
  if (!texture) throw new Error('无法创建纹理');
  gl.bindTexture(gl.TEXTURE_2D, texture);
  gl.texImage2D(
    gl.TEXTURE_2D,
    0,
    float ? gl.RGBA16F : gl.RGBA8,
    width,
    height,
    0,
    gl.RGBA,
    float ? gl.HALF_FLOAT : gl.UNSIGNED_BYTE,
    null,
  );
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);

  const framebuffer = gl.createFramebuffer();
  if (!framebuffer) throw new Error('无法创建 framebuffer');
  gl.bindFramebuffer(gl.FRAMEBUFFER, framebuffer);
  gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, texture, 0);

  const status = gl.checkFramebufferStatus(gl.FRAMEBUFFER);
  if (status !== gl.FRAMEBUFFER_COMPLETE) {
    gl.deleteFramebuffer(framebuffer);
    gl.deleteTexture(texture);
    throw new Error(`framebuffer 不完整：0x${status.toString(16)}`);
  }

  gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  gl.bindTexture(gl.TEXTURE_2D, null);

  return {
    texture,
    framebuffer,
    width,
    height,
    dispose() {
      gl.deleteFramebuffer(framebuffer);
      gl.deleteTexture(texture);
    },
  };
}

export function resizeRenderTarget(gl: GL, rt: RenderTarget, width: number, height: number, float: boolean): RenderTarget {
  if (rt.width === width && rt.height === height) return rt;
  rt.dispose();
  return createRenderTarget(gl, width, height, float);
}

/**
 * 一个可反复上传、可绘制三角形带的网格。
 *
 * 顶点数据每帧重建（鱼的脊柱在变），所以缓冲区按最大容量一次性分配，
 * 之后只用 `bufferSubData` 覆盖 —— 避免每帧 `bufferData` 造成的
 * 缓冲区反复创建与 GPU 同步。
 */
export class DynamicMesh {
  private readonly gl: GL;
  private readonly vao: WebGLVertexArrayObject;
  private readonly vbo: WebGLBuffer;
  private readonly ibo: WebGLBuffer;
  readonly vertexCount: number;
  readonly indexCount: number;

  private readonly stride: number;

  constructor(
    gl: GL,
    layout: ReadonlyArray<{ name: string; size: number }>,
    program: MeshProgram,
    maxVertices: number,
    maxIndices: number,
  ) {
    this.gl = gl;
    this.vertexCount = maxVertices;
    this.indexCount = maxIndices;
    this.stride = layout.reduce((sum, a) => sum + a.size, 0);

    const vao = gl.createVertexArray();
    const vbo = gl.createBuffer();
    const ibo = gl.createBuffer();
    if (!vao || !vbo || !ibo) throw new Error('无法创建网格缓冲');

    this.vao = vao;
    this.vbo = vbo;
    this.ibo = ibo;

    gl.bindVertexArray(vao);

    gl.bindBuffer(gl.ARRAY_BUFFER, vbo);
    gl.bufferData(gl.ARRAY_BUFFER, maxVertices * this.stride * 4, gl.DYNAMIC_DRAW);

    let offset = 0;
    for (const attr of layout) {
      const loc = program.attrib(attr.name);
      if (loc >= 0) {
        gl.enableVertexAttribArray(loc);
        gl.vertexAttribPointer(loc, attr.size, gl.FLOAT, false, this.stride * 4, offset * 4);
      }
      offset += attr.size;
    }

    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, ibo);
    gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, maxIndices * 2, gl.DYNAMIC_DRAW);

    gl.bindVertexArray(null);
    gl.bindBuffer(gl.ARRAY_BUFFER, null);
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, null);
  }

  /** 覆盖式上传。数据超出容量时截断并告警一次，而不是让 GPU 读越界。 */
  update(vertices: Float32Array, indices: Uint16Array): void {
    const gl = this.gl;
    const vCount = Math.min(vertices.length, this.vertexCount * this.stride);
    const iCount = Math.min(indices.length, this.indexCount);

    gl.bindBuffer(gl.ARRAY_BUFFER, this.vbo);
    gl.bufferSubData(gl.ARRAY_BUFFER, 0, vertices, 0, vCount);

    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, this.ibo);
    gl.bufferSubData(gl.ELEMENT_ARRAY_BUFFER, 0, indices, 0, iCount);
  }

  /**
   * 画一段索引。
   *
   * `indexOffset` 让一个网格里可以放**多段用途不同的几何** ——
   * 生物用的就是这条：身体在前、光晕环在后，两个 pass 各画各的那一段。
   */
  draw(indexCount = this.indexCount, indexOffset = 0): void {
    const gl = this.gl;
    gl.bindVertexArray(this.vao);
    gl.drawElements(gl.TRIANGLES, indexCount, gl.UNSIGNED_SHORT, indexOffset * 2);
  }

  dispose(): void {
    const gl = this.gl;
    gl.deleteVertexArray(this.vao);
    gl.deleteBuffer(this.vbo);
    gl.deleteBuffer(this.ibo);
  }
}

/** 绑定一个空 VAO。WebGL2 画无属性三角形时仍需要一个 VAO。 */
export function createFullscreenVao(gl: GL): WebGLVertexArrayObject {
  const vao = gl.createVertexArray();
  if (!vao) throw new Error('无法创建 VAO');
  return vao;
}

/** 一帧渲染的通用包装：设置视口、绑定目标、清理。 */
export function bindTarget(gl: GL, rt: RenderTarget | null, width: number, height: number): void {
  gl.bindFramebuffer(gl.FRAMEBUFFER, rt ? rt.framebuffer : null);
  gl.viewport(0, 0, rt ? rt.width : width, rt ? rt.height : height);
}

export function drawFullscreen(gl: GL): void {
  gl.drawArrays(gl.TRIANGLES, 0, 3);
}

/**
 * 把 `prefers-reduced-motion` 与设备性能一起考虑，给出实际画质档位。
 *
 * 用户的 `quality: 'auto'` 在这里被解析成具体档位。
 */
export function detectPerformanceTier(software: boolean): 'low' | 'medium' | 'high' {
  if (software) return 'low';

  const cores = navigator.hardwareConcurrency ?? 4;
  // deviceMemory 是 Chrome 专有 API，拿不到就当作未知（不降级）
  const memory = (navigator as Navigator & { deviceMemory?: number }).deviceMemory ?? 8;

  if (cores <= 4 || memory <= 4) return 'low';
  if (cores <= 8 || memory <= 8) return 'medium';
  return 'high';
}
