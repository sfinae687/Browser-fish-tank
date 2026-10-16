/**
 * 渲染器。
 *
 * ## 一帧的四个 pass
 *
 * ```
 *   1. scene        水体：渐变 + 光池 + 焦散 + 光柱 + 海雪 + 暗角
 *   2. creature     发光生物：光晕环 → 身体（各自独立的两遍绘制）
 *   3. bright/blur  提亮部 → 横竖两次模糊（在低分辨率上做）
 *   4. composite    场景 + 辉光 → 屏幕
 * ```
 *
 * ## 为什么生物在场景**之后**
 *
 * 水体和生物画进同一个 HDR 目标，顺序是「先水后生物」。
 * 深海没有地面，所以不存在「生物被地形遮挡」的问题 ——
 * 这一条省掉了整个深度排序。
 *
 * ## 缸内坐标
 *
 * 一切几何都用 [0,1]² 的「缸内坐标」描述，由 `computeTankRect` 映射到屏幕。
 * 于是构图（铺满 / 居中 / 信箱）和缩放只是改一个矩形，
 * 生物的位置、着色器里的比例都不用管。
 *
 *   t.x = 0 左，1 右
 *   t.y = 0 水面，1 画面底部
 */

import {
  Program,
  createContext,
  createRenderTarget,
  resizeRenderTarget,
  bindTarget,
  drawFullscreen,
  createFullscreenVao,
  type GL,
  type RenderTarget,
  type RendererContext,
} from './gl.js';
import {
  SCENE_FS,
  SCENE_VS,
  L_SURFACE,
  L_CAUSTICS,
  L_RAYS,
  L_SNOW,
  L_VIGNETTE,
} from './shaders/scene.js';
import { BRIGHT_FS, BLUR_FS, COMPOSITE_FS } from './shaders/post.js';
import { CreatureRenderer } from './creatures.js';
import type { Creature } from '../core/creatures.js';
import type { Palette } from '../core/theme.js';
import type { AnchorY, Backdrop, Framing, LayerToggles, ResolvedQuality } from '../core/config.js';

/**
 * 远景名 → 着色器里的编号。
 *
 * 用编号而不是字符串，因为这是一条逐像素走的热路径；
 * 而这个映射在编译期就固定了。
 */
export const BACKDROP_ID: Record<Backdrop, number> = {
  open: 0,
  trench: 1,
  snowfield: 2,
  vent: 3,
  ruins: 4,
};

/** 水面在缸内的 y。略大于 0 —— 留一条水面线。 */
const WATER_LINE = 0.035;

/**
 * 辉光的阈值。
 *
 * 深色场景里压得很低：亮是稀缺资源，漏出来的越多越像在发光。
 * 上一版是 0.76（几乎只有高光会漏），这一版 0.20。
 */
const BLOOM_THRESHOLD = 0.2;
const BLOOM_KNEE = 0.35;
/** 辉光在屏幕的 1/4 分辨率上模糊 —— 它本来就是低频的 */
const BLOOM_DIVISOR = 4;

export interface TankFrame {
  /** 秒 */
  time: number;
  /** 开场进度 0..1 */
  intro: number;
  palette: Palette;
  layers: LayerToggles;
  quality: ResolvedQuality;
  framing: Framing;
  zoom: number;
  anchorY: AnchorY;
  opacity: number;
  /** 辉光强度倍率 */
  bloom: number;
  creatures: readonly Creature[];
  /** 生物尺寸倍率 */
  creatureScale: number;
  /** 可选远景 */
  backdrop?: Backdrop;
}

/**
 * 算出缸在屏幕上的位置，返回 [x, y, w, h]（单位 uv，y 向下）。
 */
export function computeTankRect(
  framing: Framing,
  zoom: number,
  anchorY: AnchorY,
  aspect: number,
): [number, number, number, number] {
  const z = Math.max(0.1, zoom);

  if (framing === 'fill') {
    // 铺满：缸就是整个画面
    return [(1 - z) / 2, (1 - z) / 2, z, z];
  }

  // 后两种都保持 16:9 的内容比例
  const contentAspect = 16 / 9;
  let w: number;
  let h: number;
  if (framing === 'letterbox') {
    // 信箱：完整放进画面，比例不对就留边
    if (aspect > contentAspect) {
      h = 1;
      w = contentAspect / aspect;
    } else {
      w = 1;
      h = aspect / contentAspect;
    }
  } else {
    // 居中：一个居中的 16:9 矩形，默认小一圈
    const base = 0.82;
    if (aspect > contentAspect) {
      h = base;
      w = (contentAspect / aspect) * base;
    } else {
      w = base;
      h = (aspect / contentAspect) * base;
    }
  }

  w *= z;
  h *= z;

  const x = (1 - w) / 2;
  let y = (1 - h) / 2;
  if (anchorY === 'top') y = 0;
  else if (anchorY === 'bottom') y = 1 - h;

  return [x, y, w, h];
}

export class TankRenderer {
  readonly canvas: HTMLCanvasElement;
  readonly ctx: RendererContext;

  private readonly gl: GL;
  private readonly vao: WebGLVertexArrayObject;

  private sceneRT: RenderTarget;
  private bloomA: RenderTarget;
  private bloomB: RenderTarget;

  private readonly sceneProg: Program;
  private readonly brightProg: Program;
  private readonly blurProg: Program;
  private readonly compositeProg: Program;
  private readonly creatureRenderer: CreatureRenderer;

  private disposed = false;
  /** 最近一帧的缸矩形。验收脚本要用它把缸内坐标换算成屏幕坐标。 */
  private lastRect: [number, number, number, number] = [0, 0, 1, 1];

  constructor(canvas: HTMLCanvasElement, opts: { alpha?: boolean } = {}) {
    this.canvas = canvas;
    this.ctx = createContext(canvas, {
      preferFloatTargets: true,
      alpha: opts.alpha ?? false,
    });
    this.gl = this.ctx.gl;

    const gl = this.gl;
    this.vao = createFullscreenVao(gl);
    gl.bindVertexArray(this.vao);

    const w = Math.max(1, canvas.width);
    const h = Math.max(1, canvas.height);
    this.sceneRT = createRenderTarget(gl, w, h, this.ctx.floatTargets);
    const bw = Math.max(1, Math.floor(w / BLOOM_DIVISOR));
    const bh = Math.max(1, Math.floor(h / BLOOM_DIVISOR));
    this.bloomA = createRenderTarget(gl, bw, bh, this.ctx.floatTargets);
    this.bloomB = createRenderTarget(gl, bw, bh, this.ctx.floatTargets);

    this.sceneProg = new Program(gl, SCENE_FS, SCENE_VS);
    this.brightProg = new Program(gl, BRIGHT_FS, SCENE_VS);
    this.blurProg = new Program(gl, BLUR_FS, SCENE_VS);
    this.compositeProg = new Program(gl, COMPOSITE_FS, SCENE_VS);
    this.creatureRenderer = new CreatureRenderer(gl);
  }

  get info(): { renderer: string; software: boolean; floatTargets: boolean } {
    return {
      renderer: this.ctx.renderer,
      software: this.ctx.software,
      floatTargets: this.ctx.floatTargets,
    };
  }

  get drawStats(): { creatures: number; draws: number } {
    return this.creatureRenderer.stats;
  }

  /**
   * 缸内坐标命中了哪只生物。
   *
   * 转发给生物渲染器 —— 它才是持有「这一帧真正用过的姿态」的地方。
   * 运行器另算一遍姿态是不行的：那样点击命中的和画面上看到的可能差一帧。
   */
  pick(x: number, y: number, list: readonly Creature[]): Creature | null {
    return this.creatureRenderer.pick(x, y, list);
  }

  /** 最近一帧的生物姿态（缸内坐标），与传入顺序一致。 */
  get poses(): readonly { x: number; y: number }[] {
    return this.creatureRenderer.poses;
  }

  /** 最近一帧的缸矩形 [x, y, w, h]（uv）。 */
  get tankRect(): readonly [number, number, number, number] {
    return this.lastRect;
  }

  /** 画一帧。调用方负责先把 canvas 尺寸设好（见 `resizeToDisplay`）。 */
  render(frame: TankFrame): void {
    if (this.disposed) return;
    const gl = this.gl;
    const canvas = this.canvas;
    const w = Math.max(1, canvas.width);
    const h = Math.max(1, canvas.height);
    const aspect = w / h;

    this.ensureSize(w, h);
    const rect = computeTankRect(frame.framing, frame.zoom, frame.anchorY, aspect);
    this.lastRect = rect;

    // ——————— 1. 水体 ———————
    let mask = 0;
    if (frame.layers.surface) mask |= L_SURFACE;
    if (frame.layers.caustics) mask |= L_CAUSTICS;
    if (frame.layers.rays) mask |= L_RAYS;
    if (frame.layers.snow) mask |= L_SNOW;
    if (frame.layers.vignette) mask |= L_VIGNETTE;

    bindTarget(gl, this.sceneRT, w, h);
    gl.disable(gl.BLEND);
    const p = this.sceneProg.use();
    p.vec4('uTankRect', rect[0], rect[1], rect[2], rect[3]);
    p.vec2('uResolution', w, h);
    p.float('uAspect', aspect);
    p.float('uTime', frame.time);
    p.float('uSeed', 3.7);
    p.float('uIntro', frame.intro);
    p.vec3a('uWaterTop', frame.palette.waterTop);
    p.vec3a('uWaterDeep', frame.palette.waterDeep);
    p.vec3a('uLight', frame.palette.light);
    p.vec3a('uCaustic', frame.palette.caustic);
    p.float('uAmbient', frame.palette.ambient);
    p.float('uTurbidity', frame.palette.turbidity);
    p.int('uDetail', frame.quality.detail);
    p.int('uLayers', mask);
    p.int('uBackdrop', BACKDROP_ID[frame.backdrop ?? 'open'] ?? 0);
    drawFullscreen(gl);

    // ——————— 2. 发光生物（同一个目标，画在水体之上）———————
    // CreatureRenderer 在构造时就把 4 个体型的网格都建好了，
    // 运行时没有「同步网格」这一步 —— 体型是固定的，不随标签页变化。
    if (frame.layers.creatures && frame.creatures.length > 0) {
      this.creatureRenderer.render({
        tankRect: rect,
        creatures: frame.creatures,
        palette: frame.palette,
        time: frame.time,
        intro: frame.intro,
        opacity: 1,
        creatureScale: frame.creatureScale,
      });
      gl.disable(gl.BLEND);
    }

    // ——————— 3. 辉光 ———————
    const bw = this.bloomA.width;
    const bh = this.bloomA.height;
    let bloomTex = this.bloomA.texture;

    if (frame.layers.bloom && frame.bloom > 0.001) {
      bindTarget(gl, this.bloomA, bw, bh);
      gl.disable(gl.BLEND);
      const bp = this.brightProg.use();
      bp.texture('uScene', 0, this.sceneRT.texture);
      bp.float('uThreshold', BLOOM_THRESHOLD);
      bp.float('uKnee', BLOOM_KNEE);
      drawFullscreen(gl);

      // 横竖两次。方向按目标分辨率折算，所以缩放窗口不会改变观感。
      const blur = this.blurProg.use();
      bindTarget(gl, this.bloomB, bw, bh);
      blur.texture('uSource', 0, this.bloomA.texture);
      blur.vec2('uDir', 1 / bw, 0);
      drawFullscreen(gl);

      bindTarget(gl, this.bloomA, bw, bh);
      blur.texture('uSource', 0, this.bloomB.texture);
      blur.vec2('uDir', 0, 1 / bh);
      drawFullscreen(gl);

      bloomTex = this.bloomA.texture;
    }

    // ——————— 4. 合成 ———————
    bindTarget(gl, null, w, h);
    gl.disable(gl.BLEND);
    const cp = this.compositeProg.use();
    cp.texture('uScene', 0, this.sceneRT.texture);
    cp.texture('uBloom', 1, bloomTex);
    cp.vec4('uTankRect', rect[0], rect[1], rect[2], rect[3]);
    cp.float('uTime', frame.time);
    cp.float('uBloomStrength', frame.layers.bloom ? frame.bloom * frame.palette.bloom : 0);
    cp.float('uOpacity', frame.opacity);
    cp.float('uWaterLine', WATER_LINE);
    drawFullscreen(gl);

    // 全屏 pass 依赖这个 VAO 绑着，而生物绘制会把它换掉 —— 每帧恢复一次
    gl.bindVertexArray(this.vao);
  }

  private ensureSize(w: number, h: number): void {
    if (this.sceneRT.width === w && this.sceneRT.height === h) return;
    const gl = this.gl;
    this.sceneRT = resizeRenderTarget(gl, this.sceneRT, w, h, this.ctx.floatTargets);
    const bw = Math.max(1, Math.floor(w / BLOOM_DIVISOR));
    const bh = Math.max(1, Math.floor(h / BLOOM_DIVISOR));
    this.bloomA = resizeRenderTarget(gl, this.bloomA, bw, bh, this.ctx.floatTargets);
    this.bloomB = resizeRenderTarget(gl, this.bloomB, bw, bh, this.ctx.floatTargets);
  }

  /**
   * 把绘制缓冲对齐到显示尺寸，返回实际像素尺寸。
   *
   * 高分屏上不让 dpr 无上限地放大像素数 —— 4K 屏 × 2 会直接拖垮帧率。
   */
  resizeToDisplay(renderScale: number): { width: number; height: number } {
    const dpr = typeof devicePixelRatio === 'number' ? devicePixelRatio : 1;
    const capped = Math.min(dpr, 2);
    const scale = Math.max(0.3, renderScale) * capped;
    const w = Math.max(2, Math.floor(this.canvas.clientWidth * scale));
    const h = Math.max(2, Math.floor(this.canvas.clientHeight * scale));
    if (this.canvas.width !== w || this.canvas.height !== h) {
      this.canvas.width = w;
      this.canvas.height = h;
    }
    return { width: w, height: h };
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    const gl = this.gl;
    this.sceneRT.dispose();
    this.bloomA.dispose();
    this.bloomB.dispose();
    this.sceneProg.dispose();
    this.brightProg.dispose();
    this.blurProg.dispose();
    this.compositeProg.dispose();
    this.creatureRenderer.dispose();
    gl.deleteVertexArray(this.vao);
  }
}
