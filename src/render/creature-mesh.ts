/**
 * 发光生物的网格。
 *
 * ## 形状是**设计**出来的，不是随机生成的
 *
 * 每个体型是一条**手写的剖面控制点曲线**。好看的东西是设计出来的，
 * 不是采样出来的 —— 参数在区间里随机采样的结果，是每条鱼的比例都
 * 「差一点」，而且放在一起互相打架。
 *
 * ## 发光的构造
 *
 * 深海生物的发光器长在**体侧和腹部**。画面上的「发光感」由三件事叠加：
 *
 *   1. **暗色剪影** —— 身体本身几乎是黑的，只留一点背腹渐变
 *   2. **发光器** —— 沿腹部排一列亮点，用与身体分开的顶点画
 *   3. **光晕** —— 一组以身体轮廓为中心的**同心环**，向外衰减
 *
 * 第 3 条的做法值得说明：光晕不是把网格整体放大（那样只会得到一层飘在
 * 外面的硬壳，衰减早就归零了），而是**在网格里显式地排出一圈圈半径递增的
 * 环**，每个顶点带着自己的归一化半径 `aEdge`。片元据此做平滑衰减，
 * 于是才有真正的梯度。
 *
 * 顶点布局（8 个 float）：
 *   aSpine   脊柱参数 t ∈ [0, 段数]
 *   aLocal   相对脊柱点的偏移（法向, 切向）
 *   aBody    体坐标 (u 沿体长 0..1, v 横向 +1 上 / −1 下)
 *   aFlags   (是否发光器, 发光强度)
 *   aEdge    归一化半径：0 = 体轴，1 = 体表轮廓，> 1 = 在体表之外
 */

export const CREATURE_VERTEX_LAYOUT = [
  { name: 'aSpine', size: 1 },
  { name: 'aLocal', size: 2 },
  { name: 'aBody', size: 2 },
  { name: 'aFlags', size: 2 },
  { name: 'aEdge', size: 1 },
] as const;

export const CREATURE_FLOATS_PER_VERTEX = 8;

export const MAX_SPINE_POINTS = 24;

/**
 * 身体 + 鳍 + 发光器 + 光晕环的容量上限。
 *
 * ⚠️ 这两个数**必须真的够大**。超出时索引会被截断，然后 GPU 去读一段
 * 不存在的顶点 —— 表现是控制台刷 "too many errors"，画面却「看起来还行」，
 * 非常容易漏掉。最长的体型（深海带鱼，20 段）需要约 450 顶点 / 1450 索引。
 */
export const MAX_CREATURE_VERTICES = 768;
export const MAX_CREATURE_INDICES = 2048;

/**
 * 身体横截面上的采样行（归一化半高，从背缘到腹缘）。
 *
 * 两头密、中间疏：边缘光只发生在最外那一条窄带上，所以需要在外缘附近
 * 有足够的采样来让它「落」下来。
 */
const BODY_ROWS = [1.0, 0.86, 0.58, 0.2, -0.2, -0.58, -0.86, -1.0] as const;

/** 光晕的半径层级（归一化）。0..1 是身体，这里全部 > 1。 */
const HALO_RINGS = [1.0, 1.22, 1.52, 1.95, 2.6] as const;

/** 剖面控制点：[沿体长 0..1, 半高倍率 0..1] */
type ProfilePoint = readonly [number, number];

export type ShapeName = 'lantern' | 'angler' | 'hatchet' | 'ribbon';

export interface CreatureShape {
  name: ShapeName;
  label: string;
  /** 体长（缸内 uv） */
  length: number;
  /**
   * **半高**的最大值（缸内 uv）。
   *
   * ⚠️ 这是半高不是全高 —— 体高是它的两倍。
   * 把半高当全高给的后果是每条鱼的体高都到体长的 45%，一缸全是圆球。
   * 鱼雷形的体高应当在体长的 22~30% 之间。
   */
  height: number;
  /** 剖面控制点。**这是每个体型的灵魂。** */
  profile: readonly ProfilePoint[];
  /** 脊柱分几段 */
  segments: number;
  /** 尾鳍跨度（相对体高） */
  tailSpan: number;
  /** 尾鳍分叉 0 = 圆尾，1 = 深叉 */
  tailFork: number;
  /** 背鳍高度（相对体高） */
  dorsal: number;
  /** 背鳍起点（沿体长） */
  dorsalStart: number;
  /** 胸鳍大小（相对体高） */
  pectoral: number;
  /** 沿腹部排几个发光器 */
  photophores: number;
  /** 体型权重：越大越常见 */
  weight: number;
}

/**
 * 四个手写体型。
 *
 * 剖面数值是对着参考图一点点调的，改动前请先渲染看看 ——
 * 这些数字之间是有关系的（最宽处的位置、收尾的斜率、尾柄的粗细），
 * 单独动一个通常会让轮廓变别扭。
 *
 * 特别注意**最后一个控制点**（尾柄）。它决定尾鳍和身体是「连着」还是
 * 「飘着」：给得太细（0.15 以下）在暗背景下一根两像素的连接几乎看不见，
 * 看起来就像尾鳍脱落了。0.3 左右才稳。
 */
export const SHAPES: Record<ShapeName, CreatureShape> = {
  // 灯笼鱼：细长的鱼雷形，最宽处在 30% 左右。深海最常见的小型发光鱼。
  lantern: {
    name: 'lantern',
    label: '灯笼鱼',
    length: 0.115,
    height: 0.0135,
    profile: [
      [0.0, 0.30], [0.07, 0.74], [0.17, 0.95], [0.30, 1.0],
      [0.48, 0.90], [0.66, 0.68], [0.84, 0.48], [1.0, 0.31],
    ],
    segments: 16,
    tailSpan: 1.7,
    tailFork: 0.5,
    dorsal: 0.5,
    dorsalStart: 0.36,
    pectoral: 0.45,
    photophores: 7,
    weight: 1.0,
  },

  // 鮟鱇：圆胖、头大、尾细。
  angler: {
    name: 'angler',
    label: '鮟鱇',
    length: 0.150,
    height: 0.028,
    profile: [
      [0.0, 0.44], [0.09, 0.86], [0.22, 1.0], [0.40, 0.97],
      [0.58, 0.74], [0.76, 0.50], [0.90, 0.36], [1.0, 0.28],
    ],
    segments: 18,
    tailSpan: 1.2,
    tailFork: 0.1,
    dorsal: 0.26,
    dorsalStart: 0.42,
    pectoral: 0.6,
    photophores: 0,
    weight: 0.35,
  },

  // 斧头鱼：短、极高，侧面看像一把斧头。轮廓极其独特。
  hatchet: {
    name: 'hatchet',
    label: '斧头鱼',
    length: 0.080,
    height: 0.019,
    profile: [
      [0.0, 0.34], [0.08, 0.82], [0.20, 1.0], [0.36, 0.98],
      [0.56, 0.72], [0.76, 0.46], [1.0, 0.30],
    ],
    segments: 14,
    tailSpan: 1.5,
    tailFork: 0.4,
    dorsal: 0.32,
    dorsalStart: 0.30,
    pectoral: 0.75,
    photophores: 5,
    weight: 0.6,
  },

  // 带鱼：长条，体高几乎不变。游起来像一条飘动的光带。
  ribbon: {
    name: 'ribbon',
    label: '深海带鱼',
    length: 0.235,
    height: 0.0105,
    profile: [
      [0.0, 0.36], [0.08, 0.76], [0.22, 0.90], [0.45, 0.94],
      [0.68, 0.88], [0.86, 0.76], [1.0, 0.52],
    ],
    segments: 20,
    tailSpan: 1.0,
    tailFork: 0.2,
    dorsal: 0.8,
    dorsalStart: 0.14,
    pectoral: 0.28,
    photophores: 11,
    weight: 0.45,
  },
};

export const SHAPE_NAMES: ShapeName[] = ['lantern', 'angler', 'hatchet', 'ribbon'];

export interface CreatureMeshData {
  vertices: Float32Array;
  indices: Uint16Array;
  vertexCount: number;
  /**
   * 身体部分的索引数。索引缓冲是「身体在前、光晕在后」，
   * 所以两个 pass 用偏移区分：身体画 [0, bodyIndexCount)，
   * 光晕画 [bodyIndexCount, bodyIndexCount + haloIndexCount)。
   */
  bodyIndexCount: number;
  haloIndexCount: number;
}

// ————————————————————————————————————————————————————————————
// 剖面插值
// ————————————————————————————————————————————————————————————

/**
 * 单调三次 Hermite 插值（Fritsch–Carlson）。
 *
 * ⚠️ 这里**不能**用「逐段 smoothstep」那种最省事的写法。
 * smoothstep 在每个控制点处导数都为 0，于是曲线在每个控制点都会「平一下」——
 * 一串控制点插出来是一条带台阶的折线，鱼身看起来一节一节的。
 *
 * 单调三次插值保证不过冲（半高不会跑到负数或冒出去），同时是 C1 连续的。
 * 对一条「体高剖面」来说这是最合适的选择。
 */
function makeProfileSampler(points: readonly ProfilePoint[]): (u: number) => number {
  const n = points.length;
  const xs = new Float64Array(n);
  const ys = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    xs[i] = (points[i] as ProfilePoint)[0];
    ys[i] = (points[i] as ProfilePoint)[1];
  }

  // 割线斜率
  const d = new Float64Array(n - 1);
  for (let i = 0; i < n - 1; i++) {
    const dx = (xs[i + 1] as number) - (xs[i] as number);
    d[i] = dx > 1e-9 ? ((ys[i + 1] as number) - (ys[i] as number)) / dx : 0;
  }

  // 端点与内部切线的初值
  const m = new Float64Array(n);
  m[0] = d[0] as number;
  m[n - 1] = d[n - 2] as number;
  for (let i = 1; i < n - 1; i++) m[i] = ((d[i - 1] as number) + (d[i] as number)) * 0.5;

  // Fritsch–Carlson 限幅：保证单调、不过冲
  for (let i = 0; i < n - 1; i++) {
    const di = d[i] as number;
    if (di === 0) {
      m[i] = 0;
      m[i + 1] = 0;
      continue;
    }
    const a = (m[i] as number) / di;
    const b = (m[i + 1] as number) / di;
    const s = a * a + b * b;
    if (s > 9) {
      const t = 3 / Math.sqrt(s);
      m[i] = t * a * di;
      m[i + 1] = t * b * di;
    }
  }

  return (u: number): number => {
    const x = u < 0 ? 0 : u > 1 ? 1 : u;
    // 找到所在区间
    let i = n - 2;
    for (let k = 0; k < n - 1; k++) {
      if (x <= (xs[k + 1] as number)) {
        i = k;
        break;
      }
    }
    const x0 = xs[i] as number;
    const x1 = xs[i + 1] as number;
    const h = x1 - x0;
    if (h <= 1e-9) return ys[i] as number;

    const t = (x - x0) / h;
    const t2 = t * t;
    const t3 = t2 * t;
    // Hermite 基函数
    const h00 = 2 * t3 - 3 * t2 + 1;
    const h10 = t3 - 2 * t2 + t;
    const h01 = -2 * t3 + 3 * t2;
    const h11 = t3 - t2;

    return (
      h00 * (ys[i] as number) +
      h10 * h * (m[i] as number) +
      h01 * (ys[i + 1] as number) +
      h11 * h * (m[i + 1] as number)
    );
  };
}

const samplers = new Map<ShapeName, (u: number) => number>();

function profileAt(shape: CreatureShape, u: number): number {
  let f = samplers.get(shape.name);
  if (!f) {
    f = makeProfileSampler(shape.profile);
    samplers.set(shape.name, f);
  }
  return f(u);
}

/** u 处的半高（缸内 uv）。 */
export function halfHeight(shape: CreatureShape, u: number): number {
  return shape.height * profileAt(shape, u);
}

// ————————————————————————————————————————————————————————————
// 网格
// ————————————————————————————————————————————————————————————

export function buildCreatureMesh(shape: CreatureShape): CreatureMeshData {
  const vertices: number[] = [];
  const bodyIndices: number[] = [];
  const haloIndices: number[] = [];

  const segs = shape.segments;
  const H = shape.height;

  const push = (
    spine: number,
    lx: number,
    ly: number,
    bu: number,
    bv: number,
    isGlow: number,
    glowAmt: number,
    edge: number,
  ): number => {
    const i = vertices.length / CREATURE_FLOATS_PER_VERTEX;
    vertices.push(spine, lx, ly, bu, bv, isGlow, glowAmt, edge);
    return i;
  };

  // ——————— 尾鳍 ———————
  // 先画，身体后画 —— 后画的盖在上面，尾根与身体的接缝被藏住。
  {
    const base = 0;
    const span = H * shape.tailSpan;
    const back = H * 1.15;
    const fork = shape.tailFork;
    // 五个点：上尖 / 上内 / 中 / 下内 / 下尖。
    // 中间的缺口由 2/3 两点向尾根方向收进来形成 —— 这就是「分叉」。
    // ly 从 −0.35 起：让尾鳍**向前压住**尾柄，而不是从尾柄末端才开始，
    // 这是修掉「尾鳍看起来脱落」的第二个关键（第一个是加粗尾柄）。
    push(segs, 0, -H * 0.35, 1.0, 0.0, 0, 0.12, 0.0);
    push(segs, span * 0.55, back, 1.0, 1.0, 0, 0.55, 1.0);
    push(segs, span * 0.34, back * (1.0 - fork * 0.6), 1.0, 0.6, 0, 0.38, 0.72);
    push(segs, -span * 0.34, back * (1.0 - fork * 0.6), 1.0, -0.6, 0, 0.38, 0.72);
    push(segs, -span * 0.55, back, 1.0, -1.0, 0, 0.55, 1.0);

    bodyIndices.push(base, base + 1, base + 2);
    bodyIndices.push(base, base + 2, base + 3);
    bodyIndices.push(base, base + 3, base + 4);
  }

  // ——————— 背鳍 ———————
  {
    const u0 = shape.dorsalStart;
    const u1 = Math.min(u0 + 0.5, 0.94);
    const rows = 7;
    const base = vertices.length / CREATURE_FLOATS_PER_VERTEX;
    for (let k = 0; k <= rows; k++) {
      const t = k / rows;
      const u = u0 + (u1 - u0) * t;
      const h = halfHeight(shape, u);
      const bell = Math.sin(Math.PI * t);
      const spine = u * segs;
      push(spine, h * 0.55, 0, u, 1.0, 0, 0.05, 0.6);
      push(spine, h + H * shape.dorsal * bell, 0, u, 1.4, 0, 0.42, 1.0);
    }
    for (let k = 0; k < rows; k++) {
      const a = base + k * 2;
      const b = a + 2;
      bodyIndices.push(a, b, a + 1, a + 1, b, b + 1);
    }
  }

  // ——————— 胸鳍 ———————
  {
    const u = 0.30;
    const h = halfHeight(shape, u);
    const size = H * shape.pectoral;
    for (const side of [1, -1]) {
      const base = vertices.length / CREATURE_FLOATS_PER_VERTEX;
      const spine = u * segs;
      push(spine, side * h * 0.5, 0, u, side, 0, 0.05, 0.5);
      push(spine + 0.9, side * (h * 0.5 + size), size * 1.1, u + 0.10, side, 0, 0.36, 1.0);
      push(spine + 0.5, side * (h * 0.25 + size * 0.6), size * 1.7, u + 0.05, side, 0, 0.36, 1.0);
      bodyIndices.push(base, base + 1, base + 2);
    }
  }

  // ——————— 身体 ———————
  //
  // ⚠️ 身体必须做成**多行截面**，不能只有背腹两条边。
  //
  // 只有两行时，每个片元的 aEdge 都恒等于 1.0 —— 于是「边缘光」会糊满
  // 整个身体，把暗剪影变成一块过曝的色斑。这不是调系数能解决的，
  // 是网格拓扑的问题：**要给片元一个能变化的量，得先在几何上有变化。**
  //
  // ROWS 是每一行在横截面上的位置，从背缘到腹缘。两头密、中间疏 ——
  // 边缘光只发生在最外那一条窄带上，所以需要在外缘附近有足够的采样。
  {
    const base = vertices.length / CREATURE_FLOATS_PER_VERTEX;
    for (let i = 0; i <= segs; i++) {
      const u = i / segs;
      const h = halfHeight(shape, u);
      for (const k of BODY_ROWS) {
        push(i, h * k, 0, u, k, 0, 0, Math.abs(k));
      }
    }
    const rows = BODY_ROWS.length;
    for (let i = 0; i < segs; i++) {
      for (let r = 0; r < rows - 1; r++) {
        const a = base + i * rows + r;
        const b = a + rows;
        bodyIndices.push(a, b, a + 1, a + 1, b, b + 1);
      }
    }
  }

  // ——————— 发光器 ———————
  // 画在身体之后，所以叠在身体上不会被吃掉。
  // 每个点是一个小菱形而不是点图元 —— 点图元的大小各驱动不一致，
  // 而这是画面里最关键的一批像素。
  if (shape.photophores > 0) {
    const n = shape.photophores;
    const r = H * 0.11;
    for (let k = 0; k < n; k++) {
      const u = 0.14 + (k / Math.max(1, n - 1)) * 0.70;
      const h = halfHeight(shape, u);
      const spine = u * segs;
      const y = -h * 0.82;
      const base = vertices.length / CREATURE_FLOATS_PER_VERTEX;
      const bell = Math.sin((Math.PI * (k + 0.5)) / n);
      const amt = 0.55 + bell * 0.45;
      push(spine, y + r, 0, u, -1.0, 1, amt, 0.0);
      push(spine + 0.1, y, r * 0.85, u, -1.0, 1, amt, 0.0);
      push(spine, y - r, 0, u, -1.0, 1, amt, 0.0);
      push(spine - 0.1, y, r * 0.85, u, -1.0, 1, amt, 0.0);
      bodyIndices.push(base, base + 1, base + 2, base, base + 2, base + 3);
    }
  }

  const bodyIndexCount = bodyIndices.length;

  // ——————— 光晕环 ———————
  //
  // 见文件头第 3 条：光晕是**一圈圈半径递增的环**，不是把网格整体放大。
  // 每个环上的顶点带着自己的归一化半径，片元据此做平滑衰减。
  //
  // 这些环只属于光晕 pass，所以索引单独放在 bodyIndices 之后。
  {
    const rings = HALO_RINGS.length;
    const base = vertices.length / CREATURE_FLOATS_PER_VERTEX;
    for (let r = 0; r < rings; r++) {
      const R = HALO_RINGS[r] as number;
      for (let i = 0; i <= segs; i++) {
        const u = i / segs;
        const h = halfHeight(shape, u);
        // 两端收一点，避免光晕在头尾形成突兀的方形端面
        const cap = 0.55 + 0.45 * Math.sin(Math.PI * Math.min(1, Math.max(0, u)));
        push(i, h * R * cap, 0, u, 1.0, 0, 0, R * cap);
        push(i, -h * R * cap, 0, u, -1.0, 0, 0, R * cap);
      }
    }
    for (let r = 0; r < rings - 1; r++) {
      for (let i = 0; i < segs; i++) {
        const a = base + (r * (segs + 1) + i) * 2;
        const b = a + 2;
        const c = a + (segs + 1) * 2;
        const d = c + 2;
        haloIndices.push(a, c, a + 1, a + 1, c, c + 1);
        haloIndices.push(a + 1, c + 1, b, b, c + 1, d + 1);
      }
    }
  }

  const vertexCount = vertices.length / CREATURE_FLOATS_PER_VERTEX;
  const totalIndices = bodyIndices.length + haloIndices.length;
  if (vertexCount > MAX_CREATURE_VERTICES || totalIndices > MAX_CREATURE_INDICES) {
    // 截断会让 GPU 去读不存在的顶点。宁可吵一点也要报出来 ——
    // 静默截断的症状只是控制台刷错误，画面「看起来还行」。
    console.error(
      `[计算水族箱] 体型 ${shape.name} 超出网格容量：` +
        `${vertexCount}/${MAX_CREATURE_VERTICES} 顶点，` +
        `${totalIndices}/${MAX_CREATURE_INDICES} 索引`,
    );
  }
  return {
    vertices: new Float32Array(vertices),
    indices: new Uint16Array([...bodyIndices, ...haloIndices]),
    vertexCount: Math.min(vertexCount, MAX_CREATURE_VERTICES),
    bodyIndexCount: Math.min(bodyIndexCount, MAX_CREATURE_INDICES),
    haloIndexCount: Math.min(haloIndices.length, MAX_CREATURE_INDICES),
  };
}
