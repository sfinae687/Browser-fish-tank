/**
 * 渲染编排。
 *
 * Pass 图：
 *
 *   scene ──────────────────────────┐
 *     │                             │
 *     └─ brightpass ─ blurH ─ blurV ┤
 *                                   ↓
 *                                composite ─→ 画布（含玻璃层）
 *
 * 场景以 `renderScale` 的低分辨率渲染（省电），
 * 但合成始终在完整的画布分辨率上进行 —— 玻璃边缘与颗粒必须锐利。
 */

import {
  createContext,
  Program,
  createRenderTarget,
  resizeRenderTarget,
  createFullscreenVao,
  bindTarget,
  drawFullscreen,
  detectPerformanceTier,
  type GL,
  type RenderTarget,
  type RendererContext,
} from './gl.js';
import { SCENE_FS } from './shaders/scene.js';
import { BRIGHT_FS, BLUR_FS, COMPOSITE_FS } from './shaders/post.js';
import type { Palette } from '../core/theme.js';
import type { BackgroundMode, Framing, LayerToggles } from '../core/config.js';
import type { RenderBudget } from '../core/quality.js';
import type { BakedFlora } from './flora-bake.js';
import { FLORA_BAKED_ASPECT } from './flora-bake.js';
import { FishRenderer } from './fish.js';
import type { Genome } from '../core/genome.js';
import type { SchoolPose } from '../core/school.js';
import type { RenderableFish } from './fish.js';
import { sceneResolution, canvasResolution } from '../core/quality.js';

// 与 scene.ts 里的位掩码保持一致
const L_BACKMURK = 1 << 0;
const L_HARDSCAPE = 1 << 1;
const L_SUBSTRATE = 1 << 2;
const L_FLORA = 1 << 3;
const L_FAUNA = 1 << 4;
const L_PARTICULATE = 1 << 5;
const L_CAUSTICS = 1 << 6;
const L_GODRAYS = 1 << 7;

const BACKGROUND_CODE: Record<BackgroundMode, number> = {
  tank: 0,
  generative: 1,
  transparent: 2,
  page: 3,
};

export interface TankFrame {
  /** 动画时间（秒）。受 motion 模式与 timeScale 影响，可被冻结。 */
  time: number;
  /** 开场生长进度 0..1 */
  intro: number;
  /** 日照强度 0..1 */
  daylight: number;
  /** 冷暖轴 -1..1 */
  warmth: number;
  /** 藻类生物量 0..1（来自世界状态）。让模拟真的影响画面。 */
  algae: number;
  /** 开场生长进度 0..1。0 = 还没长，1 = 长成。 */
  growth: number;
  /** 鱼群。为 null 时这一帧不画鱼。 */
  school: {
    genomes: readonly Genome[];
    seeds: readonly RenderableFish[];
    pose: SchoolPose;
  } | null;
  /** 归一化水温 0..1 */
  heat: number;
  lightDir: readonly [number, number];
  palette: Palette;
  layers: LayerToggles;
  framing: Framing;
  background: BackgroundMode;
  opacity: number;
  zoom: number;
  anchor: 'top' | 'center' | 'bottom';
  seed: number;
  budget: RenderBudget;
}

/**
 * 计算缸体在屏幕 uv 中的矩形。
 *
 * 注意 uv 是 y 向下的。所有构图模式最终都归结为「一个矩形」，
 * 圆窗只是换了个遮罩 —— 这样着色器里只有一条代码路径。
 */
export function computeTankRect(
  framing: Framing,
  zoom: number,
  anchor: 'top' | 'center' | 'bottom',
  aspect: number,
): [number, number, number, number] {
  let w = 1;
  let h = 1;

  switch (framing) {
    case 'fill':
      break;

    case 'letterbox': {
      // 目标缸体像素宽高比 1.7 —— 真实鱼缸的常见比例
      w = 0.94;
      h = (w * aspect) / 1.7;
      if (h > 0.94) {
        h = 0.94;
        w = (h * 1.7) / aspect;
      }
      break;
    }

    case 'bottom':
      w = 1;
      h = 0.62;
      break;

    case 'porthole': {
      // 像素空间画正圆：h*H == w*W
      h = 0.82;
      w = Math.min(0.94, h / Math.max(0.0001, aspect));
      break;
    }
  }

  // zoom 统一理解为放大倍率：矩形变小 = 看进去更近
  w /= zoom;
  h /= zoom;

  let x = (1 - w) / 2;
  let y = (1 - h) / 2;

  if (framing === 'bottom') {
    // 贴底构图放大时应该保持贴底，而不是往中间缩
    y = 1 - h;
  } else if (anchor === 'top') {
    y = 0;
  } else if (anchor === 'bottom') {
    y = 1 - h;
  }

  return [x, y, w, h];
}

function layersToBits(l: LayerToggles): number {
  return (
    (l.backMurk ? L_BACKMURK : 0) |
    (l.hardscape ? L_HARDSCAPE : 0) |
    (l.substrate ? L_SUBSTRATE : 0) |
    (l.flora ? L_FLORA : 0) |
    (l.fauna ? L_FAUNA : 0) |
    (l.particulates ? L_PARTICULATE : 0) |
    (l.caustics ? L_CAUSTICS : 0) |
    (l.godRays ? L_GODRAYS : 0)
  );
}

export class TankRenderer {
  private ctx: RendererContext;
  private gl: GL;
  private readonly canvas: HTMLCanvasElement;

  private sceneProgram: Program;
  private brightProgram: Program;
  private blurProgram: Program;
  private compositeProgram: Program;
  private vao: WebGLVertexArrayObject;

  private sceneRT: RenderTarget | null = null;
  private brightRT: RenderTarget | null = null;
  private blurRT: RenderTarget | null = null;

  private lastSceneW = 0;
  private lastSceneH = 0;

  /** 植物骨架纹理。种子换了才重新上传，不是每帧的事。 */
  private floraTexture: WebGLTexture | null = null;
  /** 没有植物时用它占位，省得着色器里到处判空 */
  private blankTexture: WebGLTexture | null = null;

  /** 鱼（P3 引入的顶点管线）。 */
  private fishRenderer: FishRenderer | null = null;

  private contextLost = false;
  private disposed = false;

  /** 供诊断面板读取 */
  readonly info: {
    renderer: string;
    software: boolean;
    floatTargets: boolean;
    deviceTier: 'low' | 'medium' | 'high';
    drawCalls: number;
  };

  constructor(canvas: HTMLCanvasElement) {
    this.canvas = canvas;
    this.ctx = createContext(canvas, { preferFloatTargets: true, alpha: true });
    this.gl = this.ctx.gl;

    const gl = this.gl;

    // 长寿命的标签页里上下文丢失是会发生的事（驱动更新、GPU 挂起、系统休眠）。
    // 不处理的话画面就永久黑了，而用户只会觉得「扩展坏了」。
    canvas.addEventListener('webglcontextlost', this.onContextLost, false);
    canvas.addEventListener('webglcontextrestored', this.onContextRestored, false);

    this.vao = createFullscreenVao(gl);
    gl.bindVertexArray(this.vao);

    this.sceneProgram = new Program(gl, SCENE_FS);
    this.brightProgram = new Program(gl, BRIGHT_FS);
    this.blurProgram = new Program(gl, BLUR_FS);
    this.compositeProgram = new Program(gl, COMPOSITE_FS);

    this.info = {
      renderer: this.ctx.renderer,
      software: this.ctx.software,
      floatTargets: this.ctx.floatTargets,
      deviceTier: detectPerformanceTier(this.ctx.software),
      drawCalls: 0,
    };

    this.blankTexture = this.makeBlankTexture();
    this.fishRenderer = new FishRenderer(gl);

    // 混合模式必须在合成阶段关闭：我们的着色器自己算 alpha，
    // 打开混合会让半透明的覆盖层把水叠两遍。
    gl.disable(gl.BLEND);
    gl.disable(gl.DEPTH_TEST);
    gl.disable(gl.CULL_FACE);
  }

  /** 1×1 全透明纹理。用于「这个图层没有数据」时的占位。 */
  private makeBlankTexture(): WebGLTexture | null {
    const gl = this.gl;
    const tex = gl.createTexture();
    if (!tex) return null;
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE,
      new Uint8Array([0, 0, 0, 0]));
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.bindTexture(gl.TEXTURE_2D, null);
    return tex;
  }

  /**
   * 上传植物骨架纹理。
   *
   * 只在种子变化时调用 —— 光栅化要跑几十毫秒，绝不能放进每帧的路径里。
   */
  setFlora(baked: BakedFlora | null): void {
    if (this.disposed || this.isLost) return;
    const gl = this.gl;

    if (!baked) {
      if (this.floraTexture) {
        gl.deleteTexture(this.floraTexture);
        this.floraTexture = null;
      }
      return;
    }

    if (!this.floraTexture) this.floraTexture = gl.createTexture();
    if (!this.floraTexture) return;

    gl.bindTexture(gl.TEXTURE_2D, this.floraTexture);
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
    gl.texImage2D(
      gl.TEXTURE_2D, 0, gl.RGBA, baked.width, baked.height, 0,
      gl.RGBA, gl.UNSIGNED_BYTE, baked.pixels,
    );
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.bindTexture(gl.TEXTURE_2D, null);
  }

  private onContextLost = (e: Event): void => {
    // 必须 preventDefault，否则浏览器不会尝试恢复上下文
    e.preventDefault();
    this.contextLost = true;
    this.sceneRT = null;
    this.brightRT = null;
    this.blurRT = null;
    // 纹理随上下文一起没了，引用必须清掉，否则恢复后会拿着一个失效对象
    this.floraTexture = null;
    this.blankTexture = null;
    this.lastSceneW = 0;
    this.lastSceneH = 0;
  };

  private onContextRestored = (): void => {
    try {
      const gl = this.gl;
      this.vao = createFullscreenVao(gl);
      gl.bindVertexArray(this.vao);
      this.sceneProgram = new Program(gl, SCENE_FS);
      this.brightProgram = new Program(gl, BRIGHT_FS);
      this.blurProgram = new Program(gl, BLUR_FS);
      this.compositeProgram = new Program(gl, COMPOSITE_FS);
      this.blankTexture = this.makeBlankTexture();
    this.fishRenderer = new FishRenderer(gl);
      // floraTexture 留空 —— 调用方会重新 setFlora
      this.contextLost = false;
    } catch (err) {
      console.error('[计算水族箱] 上下文恢复失败', err);
      this.contextLost = true;
    }
  };

  get isLost(): boolean {
    return this.contextLost || this.gl.isContextLost();
  }

  /** 按当前 CSS 尺寸与画质预算调整所有渲染目标。返回是否发生了变化。 */
  private syncSize(budget: RenderBudget): { cssW: number; cssH: number; changed: boolean } {
    const cssW = Math.max(1, this.canvas.clientWidth);
    const cssH = Math.max(1, this.canvas.clientHeight);

    const canvasSize = canvasResolution(cssW, cssH, budget);
    const sceneSize = sceneResolution(cssW, cssH, budget);

    let changed = false;

    if (this.canvas.width !== canvasSize.width || this.canvas.height !== canvasSize.height) {
      this.canvas.width = canvasSize.width;
      this.canvas.height = canvasSize.height;
      changed = true;
    }

    const gl = this.gl;
    const wantFloat = this.ctx.floatTargets;

    if (!this.sceneRT || this.lastSceneW !== sceneSize.width || this.lastSceneH !== sceneSize.height) {
      this.sceneRT = resizeRenderTarget(gl, this.sceneRT ?? createRenderTarget(gl, 1, 1, wantFloat), sceneSize.width, sceneSize.height, wantFloat);
      this.lastSceneW = sceneSize.width;
      this.lastSceneH = sceneSize.height;

      const halfW = Math.max(1, sceneSize.width >> 1);
      const halfH = Math.max(1, sceneSize.height >> 1);
      this.brightRT = resizeRenderTarget(gl, this.brightRT ?? createRenderTarget(gl, 1, 1, wantFloat), halfW, halfH, wantFloat);
      this.blurRT = resizeRenderTarget(gl, this.blurRT ?? createRenderTarget(gl, 1, 1, wantFloat), halfW, halfH, wantFloat);
      changed = true;
    }

    return { cssW, cssH, changed };
  }

  render(frame: TankFrame): void {
    if (this.disposed || this.isLost) return;

    const gl = this.gl;
    const budget = frame.budget;

    const { cssW, cssH } = this.syncSize(budget);
    const sceneRT = this.sceneRT;
    const brightRT = this.brightRT;
    const blurRT = this.blurRT;
    if (!sceneRT || !brightRT || !blurRT) return;

    const drawCalls = { n: 0 };
    const seedFloat = (frame.seed % 100000) / 1000;
    const layerBits = layersToBits(frame.layers);
    const shape = frame.framing === 'porthole' ? 1 : 0;
    const aspect = cssW / Math.max(1, cssH);
    const rect = computeTankRect(frame.framing, frame.zoom, frame.anchor, aspect);

    // ——————— 1. 场景 ———————
    gl.bindVertexArray(this.vao);
    bindTarget(gl, sceneRT, cssW, cssH);
    {
      const p = this.sceneProgram.use();
      p.vec2('uRes', sceneRT.width, sceneRT.height);
      p.float('uTime', frame.time);
      p.float('uSeed', seedFloat);
      p.vec4('uTankRect', rect[0], rect[1], rect[2], rect[3]);
      p.float('uWaterLine', 0.055);
      p.int('uShape', shape);
      p.int('uBackground', BACKGROUND_CODE[frame.background] ?? 0);
      p.int('uDetail', budget.detail);
      p.int('uLayers', layerBits);

      const pal = frame.palette;
      p.vec3a('uWaterTop', pal.waterTop);
      p.vec3a('uWaterBottom', pal.waterBottom);
      p.vec3a('uFog', pal.fog);
      p.vec3a('uLight', pal.light);
      p.vec3a('uCaustic', pal.caustic);
      p.vec3a('uSubstrate', pal.substrate);
      p.vec3a('uSubstrateDark', pal.substrateDark);
      p.vec3a('uAccent', pal.accent);
      p.float('uAmbient', pal.ambient);
      p.float('uTurbidity', pal.turbidity);
      p.float('uDaylight', frame.daylight);
      p.float('uWarmth', frame.warmth);
      p.vec2('uLightDir', frame.lightDir[0], frame.lightDir[1]);
      p.float('uIntro', frame.intro);
      p.float('uAlgae', frame.algae);
      p.float('uHeat', frame.heat);
      p.float('uGrowth', frame.growth);
      p.float('uFloraAspect', FLORA_BAKED_ASPECT);
      p.texture('uFlora', 2, this.floraTexture ?? this.blankTexture ?? sceneRT.texture);

      drawFullscreen(gl);
      drawCalls.n++;
    }

    // ——————— 1.5 鱼 ———————
    //
    // 画进**同一个**场景 FBO，紧跟在全屏场景着色器之后，并打开混合。
    // 顺序上鱼会盖住水体、底砂、植物与几何块 —— 这是对的，
    // 因为鱼本来就在它们前面游。
    //
    // 唯一牺牲的是「前景 bokeh 应该盖在鱼之上」：它在场景 pass 里已经画完了。
    // 把 bokeh 挪到合成 pass 就能修好，留给下一轮。
    if (frame.school && frame.layers.fauna && this.fishRenderer) {
      // 每帧同步网格：繁殖会产生新基因组，而池子上限只有 56，
      // 一次 Map 查找的量级完全可以忽略。这样就不需要一套失效通知机制。
      this.fishRenderer.sync(frame.school.genomes);
      bindTarget(gl, sceneRT, cssW, cssH);
      this.fishRenderer.render({
        tankRect: rect,
        genomes: frame.school.genomes,
        seeds: frame.school.seeds,
        pose: frame.school.pose,
        palette: frame.palette,
        timeSeconds: frame.time,
        daylight: frame.daylight,
        waterLine: 0.055,
        sandLine: 0.80,
        turbidity: frame.palette.turbidity,
        opacity: 1,
      });
      gl.disable(gl.BLEND);
      drawCalls.n++;
    }

    // ——————— 2. 辉光 ———————
    if (budget.bloom) {
      bindTarget(gl, brightRT, cssW, cssH);
      {
        const p = this.brightProgram.use();
        p.texture('uSource', 0, sceneRT.texture);
        p.vec2('uTexel', 1 / sceneRT.width, 1 / sceneRT.height);
        p.float('uThreshold', 0.76);
        p.float('uKnee', 0.22);
        drawFullscreen(gl);
        drawCalls.n++;
      }

      // 两轮分离模糊 ≈ 等效 18 tap 的高斯，但只有 4 次采样/pass
      const rounds = budget.tier === 'high' ? 2 : 1;
      for (let r = 0; r < rounds; r++) {
        bindTarget(gl, blurRT, cssW, cssH);
        this.blurProgram
          .use()
          .texture('uSource', 0, brightRT.texture)
          .vec2('uTexel', 1 / brightRT.width, 1 / brightRT.height)
          .vec2('uDirection', 1, 0);
        drawFullscreen(gl);
        drawCalls.n++;

        bindTarget(gl, brightRT, cssW, cssH);
        this.blurProgram
          .use()
          .texture('uSource', 0, blurRT.texture)
          .vec2('uTexel', 1 / blurRT.width, 1 / blurRT.height)
          .vec2('uDirection', 0, 1);
        drawFullscreen(gl);
        drawCalls.n++;
      }
    } else {
      // 关掉辉光时仍然要清空 brightRT，否则合成会读到上一帧的残留
      bindTarget(gl, brightRT, cssW, cssH);
      gl.clearColor(0, 0, 0, 0);
      gl.clear(gl.COLOR_BUFFER_BIT);
      drawCalls.n++;
    }

    // ——————— 3. 合成 ———————
    bindTarget(gl, null, cssW, cssH);
    {
      const p = this.compositeProgram.use();
      p.texture('uScene', 0, sceneRT.texture);
      p.texture('uBloom', 1, brightRT.texture);
      p.vec2('uRes', this.canvas.width, this.canvas.height);
      p.vec4('uTankRect', rect[0], rect[1], rect[2], rect[3]);
      p.float('uWaterLine', 0.055);
      p.int('uShape', shape);
      p.int('uGlass', frame.layers.glass ? 1 : 0);
      // 'fill' 时缸体就是屏幕，再画一圈黑边会像贴了个相框
      p.int('uFrame', frame.framing === 'fill' ? 0 : 1);
      p.int('uDetail', budget.detail);
      p.float('uOpacity', frame.opacity);
      p.float('uTime', frame.time);
      p.float('uSeed', seedFloat);
      p.float('uDaylight', frame.daylight);
      p.float('uBloomStrength', budget.bloomStrength);
      p.float('uExposure', 1.0);
      p.vec3a('uLight', frame.palette.light);
      p.vec3a('uGlassTint', frame.palette.glassTint);
      p.vec3a('uAccent', frame.palette.accent);
      p.vec3a('uFog', frame.palette.fog);
      p.vec3a('uCausticCol', frame.palette.caustic);
      // 前景失焦光斑跟着「悬浮物」图层走 —— 它和微粒是同一类东西，
      // 只是一个合焦一个失焦
      p.float('uBokeh', frame.layers.particulates ? 1 : 0);

      drawFullscreen(gl);
      drawCalls.n++;
    }

    gl.bindVertexArray(null);
    (this.info as { drawCalls: number }).drawCalls = drawCalls.n;
  }

  /** 清空画布。隐藏或暂停时调用，避免残留上一帧。 */
  clear(): void {
    if (this.disposed || this.isLost) return;
    const gl = this.gl;
    bindTarget(gl, null, this.canvas.width, this.canvas.height);
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;

    this.canvas.removeEventListener('webglcontextlost', this.onContextLost);
    this.canvas.removeEventListener('webglcontextrestored', this.onContextRestored);

    this.sceneRT?.dispose();
    this.brightRT?.dispose();
    this.blurRT?.dispose();
    this.sceneRT = null;
    this.brightRT = null;
    this.blurRT = null;

    this.fishRenderer?.dispose();
    this.fishRenderer = null;

    if (this.floraTexture) this.gl.deleteTexture(this.floraTexture);
    if (this.blankTexture) this.gl.deleteTexture(this.blankTexture);
    this.floraTexture = null;
    this.blankTexture = null;

    this.sceneProgram.dispose();
    this.brightProgram.dispose();
    this.blurProgram.dispose();
    this.compositeProgram.dispose();

    this.gl.deleteVertexArray(this.vao);

    // 主动释放上下文。不这么做的话，反复重建渲染器会把
    // 浏览器的 WebGL 上下文配额耗尽（Chrome 上限约 16 个）。
    this.gl.getExtension('WEBGL_lose_context')?.loseContext();
  }
}
