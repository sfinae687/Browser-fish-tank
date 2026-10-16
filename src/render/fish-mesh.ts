/**
 * 由基因组构建鱼的网格。
 *
 * 网格是**身体局部形状**：体高剖面、背鳍/尾鳍/胸鳍的轮廓，全部在
 * 身体坐标系里（沿脊柱的位置 + 相对脊柱的横向偏移）。
 * 具体这条鱼此刻在世界哪里、身体弯成什么样，由顶点着色器根据脊柱点现算。
 *
 * 所以网格**每个基因组只建一次**，之后一直复用 —— 这是让 CPU 每帧成本
 * 与顶点数无关的关键。
 */

import { unfx } from '../core/fixed.js';
import { smoothstep01 } from '../core/wave.js';
import type { Genome } from '../core/genome.js';

/** 每个顶点 7 个 float：[脊柱参数, 偏移x, 偏移y, 体坐标u, 体坐标v, 是否鳍, 色调] */
export const FISH_FLOATS_PER_VERTEX = 7;

/** 单个基因组的网格容量上限。超出会被截断（并告警），不会让 GPU 读越界。 */
export const FISH_MAX_VERTICES = 160;
export const FISH_MAX_INDICES = 512;

export interface FishMeshData {
  vertices: Float32Array;
  indices: Uint16Array;
  vertexCount: number;
  indexCount: number;
}

/**
 * 体高剖面：沿体长 0..1 处的半高，相对 heightFront 的倍率。
 *
 * 不做成对称的椭圆是对的：鱼的**最宽处在偏前的位置**（约 30%），
 * 之后一路收细到尾柄。对称会让它看起来像一片叶子。
 */
function bodyProfile(u: number, tailRatio: number): number {
  // 头部：从 0.62 平滑涨到 1（在 u = 0.30 处达到最宽）
  const rise = 0.62 + 0.38 * smoothstep01(u / 0.3);
  // 尾部：从 1 收到 tailRatio
  const fall = 1 - (1 - tailRatio) * smoothstep01((u - 0.3) / 0.7);
  return rise * fall;
}

/** 沿脊柱 u 处的半高（缸内 uv）。 */
function halfHeight(g: Genome, u: number): number {
  const hf = unfx(g.morphology.heightFront);
  const hb = unfx(g.morphology.heightBack);
  const tailRatio = hf > 0 ? hb / hf : 0.3;
  return hf * bodyProfile(u, tailRatio);
}

export function buildFishMesh(g: Genome): FishMeshData {
  const vertices: number[] = [];
  const indices: number[] = [];

  const segs = g.morphology.spineSegments;
  const dorsalHeight = unfx(g.morphology.dorsalHeight);
  const dorsalStart = unfx(g.morphology.dorsalStart);
  const caudalSpan = unfx(g.morphology.caudalSpan);
  const caudalFork = unfx(g.morphology.caudalFork);
  const eyePos = unfx(g.morphology.eyePos);

  const push = (
    spine: number,
    lx: number,
    ly: number,
    bu: number,
    bv: number,
    isFin: number,
    tint: number,
  ): number => {
    const i = vertices.length / FISH_FLOATS_PER_VERTEX;
    vertices.push(spine, lx, ly, bu, bv, isFin, tint);
    return i;
  };

  // ——————— 身体 ———————
  // 两条边（背 / 腹）各一串顶点，之间连成三角带。
  // 背面先画，因为后画的会盖在上面 —— 鳍要压在身体之上。
  const bodyBase = 0;
  for (let i = 0; i <= segs; i++) {
    const u = i / segs;
    const h = halfHeight(g, u);
    push(i, h, 0, u, 1, 0, 0); // 背
    push(i, -h, 0, u, -1, 0, 0); // 腹
  }
  for (let i = 0; i < segs; i++) {
    const a = bodyBase + i * 2;
    const b = a + 2;
    // 两个三角形，绕序无关紧要（我们关掉了背面剔除）
    indices.push(a, b, a + 1);
    indices.push(a + 1, b, b + 1);
  }

  // ——————— 背鳍 ———————
  {
    const u0 = dorsalStart;
    const u1 = Math.min(u0 + 0.40, 0.90);
    const rows = 8;
    const base = vertices.length / FISH_FLOATS_PER_VERTEX;
    for (let k = 0; k <= rows; k++) {
      const t = k / rows;
      const u = u0 + (u1 - u0) * t;
      const h = halfHeight(g, u);
      // 鳍高用钟形：中间最高，两端贴合身体
      const bell = smoothstep01(Math.min(t, 1 - t) / 0.42);
      const spine = u * segs;
      push(spine, h, 0, u, 1, 1, 0);
      push(spine, h + dorsalHeight * bell, 0, u, 1, 1, 0.35);
    }
    for (let k = 0; k < rows; k++) {
      const a = base + k * 2;
      const b = a + 2;
      indices.push(a, b, a + 1);
      indices.push(a + 1, b, b + 1);
    }
  }

  // ——————— 尾鳍 ———————
  // 从最后一个脊柱点向后展开。用 6 个顶点做出分叉：
  // 根 → 上叶 → 上缺口 → 下缺口 → 下叶。
  {
    const base = vertices.length / FISH_FLOATS_PER_VERTEX;
    const span = caudalSpan;
    const notch = span * (0.45 - caudalFork * 0.34);
    const back = span * 0.46;
    push(segs, 0, 0, 1, 0, 1, 0); // 根
    push(segs, span * 0.42, back * 0.55, 1, 1, 1, 0.45); // 上叶内侧
    push(segs, span * 0.58, back, 1, 1, 1, 0.6); // 上叶尖
    push(segs, 0, notch, 1, 0, 1, 0.2); // 中央缺口
    push(segs, -span * 0.42, back * 0.55, 1, -1, 1, 0.45); // 下叶内侧
    push(segs, -span * 0.58, back, 1, -1, 1, 0.6); // 下叶尖

    const r = base;
    const ui = base + 1;
    const ut = base + 2;
    const n = base + 3;
    const li = base + 4;
    const lt = base + 5;
    indices.push(r, ut, ui);
    indices.push(r, n, ut);
    indices.push(r, li, n);
    indices.push(r, lt, li);
  }

  // ——————— 胸鳍 ———————
  // 两侧各一片。这里是**俯视化的二维处理**：两片都画在身体之上，
  // 靠色调区分远近，比真的做前后遮挡便宜得多。
  {
    const u = Math.min(0.92, eyePos + 0.16);
    const h = halfHeight(g, u);
    const size = g.morphology.length * 0.16 / 1048576;
    for (const side of [1, -1]) {
      const base = vertices.length / FISH_FLOATS_PER_VERTEX;
      const spine = u * segs;
      push(spine, side * h * 0.55, 0, u, side, 1, 0);
      push(spine + 0.6, side * (h * 0.55 + size), size * 1.15, u + 0.12, side, 1, 0.5);
      push(spine + 0.35, side * (h * 0.2 + size * 0.7), size * 1.7, u + 0.06, side, 1, 0.5);
      indices.push(base, base + 1, base + 2);
    }
  }

  const vertexCount = vertices.length / FISH_FLOATS_PER_VERTEX;
  if (vertexCount > FISH_MAX_VERTICES) {
    console.warn(
      `[计算水族箱] 鱼网格顶点数 ${vertexCount} 超出上限 ${FISH_MAX_VERTICES}，已截断`,
    );
  }

  return {
    vertices: new Float32Array(vertices.slice(0, FISH_MAX_VERTICES * FISH_FLOATS_PER_VERTEX)),
    indices: new Uint16Array(indices.slice(0, FISH_MAX_INDICES)),
    vertexCount: Math.min(vertexCount, FISH_MAX_VERTICES),
    indexCount: Math.min(indices.length, FISH_MAX_INDICES),
  };
}

/**
 * 由基因组算出体色。
 *
 * 色相直接进 HSL 再转 RGB，全部只用 + − × ÷ —— 渲染用色差一点点无所谓，
 * 但两条机器上出现明显不同的颜色就不好了，所以连这里也不碰三角函数。
 */
export function genomeColors(g: Genome): {
  back: [number, number, number];
  belly: [number, number, number];
  fin: [number, number, number];
} {
  const hue = unfx(g.pattern.hue);
  const hueBelly = unfx(g.pattern.hueBelly);
  // 背：饱和、稍暗；腹：去饱和、发亮（几乎所有鱼都是这样）
  const back = hslToRgb(hue, 0.62, 0.30);
  const belly = hslToRgb(hueBelly, 0.22, 0.78);
  const fin = hslToRgb(hue, 0.42, 0.58);
  return { back, belly, fin };
}

/** HSL → RGB。h/s/l 都在 0..1。只使用 + − × ÷。 */
function hslToRgb(h: number, s: number, l: number): [number, number, number] {
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
  const p = 2 * l - q;
  return [hueChannel(p, q, h + 1 / 3), hueChannel(p, q, h), hueChannel(p, q, h - 1 / 3)];
}

function hueChannel(p: number, q: number, tRaw: number): number {
  let t = tRaw;
  if (t < 0) t += 1;
  if (t > 1) t -= 1;
  if (t < 1 / 6) return p + (q - p) * 6 * t;
  if (t < 1 / 2) return q;
  if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6;
  return p;
}
