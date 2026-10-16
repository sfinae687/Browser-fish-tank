/**
 * 把植物骨架光栅化进一张纹理。
 *
 * ## 为什么用烘焙而不是真实几何
 *
 * 渲染器现在只有「全屏三角形 + 片元着色器」这一条管线，没有顶点管线。
 * 要画真实的枝条几何，得引入 VBO、第二套 program、并且把场景 pass 拆成
 * 多次 draw call —— 而场景是**自下而上一次性构建**的，拆开就要重新安排
 * 整个分层顺序。
 *
 * 烘焙的代价和收益：
 *   - 生成一次、光栅化一次，之后每帧只花**一次纹理采样**
 *   - 生长动画免费：把「生长顺序」烘进 R 通道，着色器拿 uGrowth 一比就行
 *   - 颜色、粗细、逐株色相都能烘进另外三个通道
 *   - 代价是分辨率固定。1280×800 对目前这种细枝条足够，
 *     但如果 P3 要做会动的鱼，鱼必须走真实几何 —— 它们每帧都在变形。
 *
 * ## 通道约定
 *
 *   R = 生长顺序 0..1     （着色器用 uGrowth 卡出「长到哪了」）
 *   G = 深度 0..1         （根→梢，用于明暗）
 *   B = 逐株色相 0..1     （整组看起来是一个系列而不是复制品）
 *   A = 覆盖率 0..1       （边缘抗锯齿）
 *
 * B 存色相而不是「植物种类」是有意的：纹理是双线性过滤的，
 * 离散的种类编码会在交界处被插值成第三种值，而连续量不会。
 * 种类差异已经体现在烘焙时的粗细上了。
 */

import { unfx } from '../core/fixed.js';
import { hashCombine, hashString } from '../core/rng.js';
import type { FloraKind, FloraNode, FloraPlant, FloraSkeleton } from '../core/flora.js';

/** 烘焙时的参考宽高比。着色器据此把实际缸体的比例换回去。 */
export const FLORA_BAKED_ASPECT = 1.6;
export const FLORA_WIDTH = 1280;
export const FLORA_HEIGHT = 800;

export interface BakedFlora {
  width: number;
  height: number;
  /** RGBA8 */
  pixels: Uint8Array;
}

/** 各类植物的基准半宽（像素）。根部粗、梢部细由深度调制。 */
const BASE_HALF_WIDTH: Record<FloraKind, number> = {
  coral: 4.4,
  kelp: 4.2,
  grass: 2.3,
};

/** 梢部相对根部的粗细比例。 */
const TIP_SCALE: Record<FloraKind, number> = {
  coral: 0.30,
  kelp: 0.55,
  grass: 0.35,
};

/**
 * 点到线段的**精确**距离。
 *
 * 用平方距离比较是不够的：我需要一条真正的线性过渡来做抗锯齿宽度。
 * 而 isqrt 是精确的整数开方，所以这里把 d² 放大到 1/256 像素的精度再开方，
 * 既精确又不碰 Math.sqrt。
 */
function segDistance(
  px: number,
  py: number,
  ax: number,
  ay: number,
  bx: number,
  by: number,
  isqrt: (n: number) => number,
): number {
  const dx = bx - ax;
  const dy = by - ay;
  const len2 = dx * dx + dy * dy;
  let t = len2 > 0 ? ((px - ax) * dx + (py - ay) * dy) / len2 : 0;
  if (t < 0) t = 0;
  else if (t > 1) t = 1;
  const cx = ax + t * dx;
  const cy = ay + t * dy;
  const ox = px - cx;
  const oy = py - cy;
  const d2 = ox * ox + oy * oy;
  // 放大 65536 倍（=256²）后用整数开方，再除回 256，得到 1/256 像素的精度
  return isqrt(Math.round(d2 * 65536)) / 256;
}

function smoothstep(e0: number, e1: number, x: number): number {
  if (e0 === e1) return x < e0 ? 0 : 1;
  let t = (x - e0) / (e1 - e0);
  if (t < 0) t = 0;
  else if (t > 1) t = 1;
  return t * t * (3 - 2 * t);
}

/**
 * 光栅化。
 *
 * `isqrt` 由调用方注入，这样这个模块不必依赖 core/flora 的实现细节，
 * 测试时也能喂一个替身。实际使用时传 `core/flora.ts` 的那个精确版本。
 */
export function bakeFlora(
  skeleton: FloraSkeleton,
  isqrt: (n: number) => number,
  width = FLORA_WIDTH,
  height = FLORA_HEIGHT,
): BakedFlora {
  const pixels = new Uint8Array(width * height * 4);
  const coverage = new Float32Array(width * height);

  const sx = width; // uv → 像素
  const sy = height;

  for (let pi = 0; pi < skeleton.plants.length; pi++) {
    const plant = skeleton.plants[pi] as FloraPlant;
    const nodes = plant.nodes;
    if (nodes.length < 2) continue;

    // 逐株的色相。用哈希而不是 Rng：这里只是给整株取一个稳定的值，
    // 消耗一条随机流会平白增加「改动一处影响另一处」的风险。
    const h = hashCombine(hashString(plant.kind), pi, nodes.length);
    const hue = 0.18 + 0.72 * ((h % 10000) / 10000);

    const baseHw = BASE_HALF_WIDTH[plant.kind];
    const tipScale = TIP_SCALE[plant.kind];

    for (let i = 1; i < nodes.length; i++) {
      const b = nodes[i] as FloraNode;
      // ⚠️ 必须按 **node.parent** 连线，不能按下标 i-1 → i。
      //
      // 空间殖民每一轮把新节点**批量追加**到数组尾部，所以节点 i 的父节点
      // 是某个 j < i，但几乎不会是 i-1。按下标连线画出来的是横跨整株的
      // 乱连线 —— 症状是珊瑚变成「一摞平行的横条」。
      //
      // 这个 bug 特别隐蔽：骨架本身完全正确，着色器也没错，
      // 只有光栅化这一步把结构画错了。diagnostic 工具里我恰好用的是
      // parent 连线，所以骨架图一直是对的，反而更快定位到了这里。
      if (b.parent < 0) continue;
      const a = nodes[b.parent] as FloraNode;

      const ax = unfx(a.x) * sx;
      const ay = unfx(a.y) * sy;
      const bx = unfx(b.x) * sx;
      const by = unfx(b.y) * sy;

      // 粗细：从根部到梢部线性收细
      const t0 = unfx(a.depth);
      const t1 = unfx(b.depth);
      const hw0 = baseHw * (tipScale + (1 - tipScale) * (1 - t0));
      const hw1 = baseHw * (tipScale + (1 - tipScale) * (1 - t1));
      const hwMax = Math.max(hw0, hw1);

      // 生长顺序：用节点在整株里的归一化索引，与骨架里的 order 一致
      const order = unfx(b.order);

      const minX = Math.max(0, Math.floor(Math.min(ax, bx) - hwMax - 1));
      const maxX = Math.min(width - 1, Math.ceil(Math.max(ax, bx) + hwMax + 1));
      const minY = Math.max(0, Math.floor(Math.min(ay, by) - hwMax - 1));
      const maxY = Math.min(height - 1, Math.ceil(Math.max(ay, by) + hwMax + 1));

      for (let y = minY; y <= maxY; y++) {
        const py = y + 0.5;
        for (let x = minX; x <= maxX; x++) {
          const px = x + 0.5;
          const d = segDistance(px, py, ax, ay, bx, by, isqrt);

          // 沿线段插值出这一点的半宽，得到平滑的锥形
          const dxs = bx - ax;
          const dys = by - ay;
          const len2 = dxs * dxs + dys * dys;
          let u = len2 > 0 ? ((px - ax) * dxs + (py - ay) * dys) / len2 : 0;
          if (u < 0) u = 0;
          else if (u > 1) u = 1;
          const hw = hw0 + (hw1 - hw0) * u;

          // 半个像素的过渡带做抗锯齿
          const cov = 1 - smoothstep(hw - 0.75, hw + 0.75, d);
          if (cov <= 0) continue;

          const idx = y * width + x;
          const prevCov = coverage[idx] as number;
          if (cov <= prevCov) continue;

          coverage[idx] = cov;
          const o = idx * 4;
          pixels[o] = Math.round(order * 255);
          pixels[o + 1] = Math.round((t0 + (t1 - t0) * u) * 255);
          pixels[o + 2] = Math.round(hue * 255);
          pixels[o + 3] = Math.round(cov * 255);
        }
      }
    }
  }

  return { width, height, pixels };
}
