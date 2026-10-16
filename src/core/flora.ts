/**
 * 植物景观生成。
 *
 * ## 两种算法，按需要挑
 *
 * - **珊瑚**：空间殖民算法（Runions et al. 2007）。给一团「吸引点」，
 *   枝条朝最近的吸引点生长，长到哪就把周围的吸引点吃掉，直到吃光。
 *   它长出来的形态像真的珊瑚，而且完全由吸引点的分布决定 ——
 *   于是「同一个种子 → 同一株珊瑚」。
 *
 * - **水草 / 海带**：简单的链式生长 + 横向摆动。这种细长的东西用空间殖民
 *   反而不好看（会分叉成一丛），而且贵。
 *
 * ## 为什么留在 CPU 上
 *
 * 上一轮我提议 P2 就切 WebGPU compute。**分析之后改主意了**：
 *
 * 植物形态是「同种子 → 同一缸」的一部分，必须逐位可复现，
 * 而 GPU 上的浮点在不同显卡之间不保证一致 —— 那会直接毁掉整个项目的承诺。
 *
 * 而空间殖民是**生成期**算法：一株珊瑚只算一次，之后一直复用。
 * 几百个吸引点、几百个节点、几十轮迭代，在 CPU 上是毫秒级的。
 * 完全没有放到 GPU 的必要。
 *
 * WebGPU compute 该用在**逐帧的连续场**上 —— 鱼皮的反应-扩散、鱼群、粒子。
 * 那些才是真的热，而且它们算错了只是画面难看，不影响世界是否一致。
 *
 * ## 与 fixed.ts 的关系
 *
 * 位置用定点整数（输出要参与渲染与自检），中间几何用浮点但**只用 + − × ÷**。
 * 特别地：**不用三角函数**。椭圆内的均匀采样改用拒绝采样 ——
 * 极坐标采样需要 sin/cos，而拒绝采样只需要比较。多花几次随机数，
 * 换来的是「不必为几何单独开一个例外」。
 *
 * @see DESIGN.md §2、§6.2
 */

import { FX, fx, unfx, clampFx, isqrt } from './fixed.js';
import { Rng, hashCombine, hashString } from './rng.js';

export type FloraKind = 'coral' | 'kelp' | 'grass';

export interface FloraNode {
  /** 缸内 uv 坐标，定点 */
  x: number;
  y: number;
  /** 父节点索引，-1 表示根 */
  parent: number;
  /** 生长顺序 0..FX。渲染时 uGrowth 超过它才显示。 */
  order: number;
  /** 到根的归一化深度 0..FX，用于粗细 */
  depth: number;
}

export interface FloraPlant {
  kind: FloraKind;
  nodes: FloraNode[];
}

export interface FloraSkeleton {
  plants: FloraPlant[];
  /** 精确指纹，用于自检与「同种子必同缸」的验证 */
  fingerprint: string;
}

// ————————————————————————————————————————————————————————————
// 定点几何
// ————————————————————————————————————————————————————————————

/**
 * 精确的整数平方根（实现已挪到 core/fixed.ts，因为鱼的群集也要用）。
 *
 * 为什么要自己写而不用 Math.sqrt：IEEE-754 确实要求 sqrt 正确舍入，
 * 但那样就得给「模拟代码里禁止实现相关的数学函数」这条规矩开一个例外，
 * 而例外是会被滥用的。**整数版没有争议**：牛顿迭代 + 整数修正，
 * 初值随便取都能收敛到精确的 floor(sqrt(n))。
 */
// ————————————————————————————————————————————————————————————
// 底砂线（与着色器保持一致）
// ————————————————————————————————————————————————————————————

/**
 * 底砂表面的高度（缸内 uv 的 y，越小越高）。
 *
 * ⚠️ 必须和 `shaders/scene.ts` 里的 `substrateHeight` 保持一致 ——
 * 不然植物会浮在砂面上方或者陷进去。
 *
 * 这也是为什么这里**不用 fbm 也不用正弦**：fbm 是着色器里的 GPU 噪声，
 * CPU 复刻必然对不齐；正弦在 CPU 侧又踩「不可复现」那条线。
 * 换成固定位置的平滑隆起之后，两边用同一个公式，
 * 只差 GPU 是 f32、JS 是 f64 —— 亚像素级别，肉眼看不出来。
 */
export function substrateHeightAt(x: number, seed: number): number {
  const s = seed / 1000;
  let h = 0.815;
  h -= bump(x, 0.18, 0.3) * (0.02 + 0.018 * hash11(s + 1));
  h += bump(x, 0.52, 0.26) * (0.014 + 0.012 * hash11(s + 2));
  h -= bump(x, 0.83, 0.22) * (0.016 + 0.014 * hash11(s + 3));
  return h;
}

const frac = (v: number): number => v - Math.floor(v);

/** 与着色器里的 hash11 逐字对应。它只用 + − ×，所以两边算的是同一个东西。 */
function hash11(p: number): number {
  let v = frac(p * 0.1031);
  v *= v + 33.33;
  v *= v + v;
  return frac(v);
}

/** 固定位置的平滑隆起。与着色器里的 bump 对应。 */
function bump(x: number, c: number, w: number): number {
  const d = Math.abs(x - c) / w;
  if (d >= 1) return 0;
  const t = 1 - d;
  return t * t * (3 - 2 * t);
}

// ————————————————————————————————————————————————————————————
// 空间殖民
// ————————————————————————————————————————————————————————————

interface Envelope {
  cx: number;
  cy: number;
  rx: number;
  ry: number;
}

/** 椭圆内均匀采样。用**拒绝采样**而不是极坐标 —— 后者需要 sin/cos。 */
function sampleEnvelope(rng: Rng, e: Envelope): { x: number; y: number } {
  for (let tries = 0; tries < 24; tries++) {
    const dx = rng.range(-1, 1);
    const dy = rng.range(-1, 1);
    if (dx * dx + dy * dy <= 1) return { x: e.cx + dx * e.rx, y: e.cy + dy * e.ry };
  }
  // 24 次都没落到圆内几乎不可能（概率 1e-15），兜底给个中心点
  return { x: e.cx, y: e.cy };
}

interface ColonizeParams {
  attractorCount: number;
  /**
   * 主干长度：从根到包络底边的距离。
   *
   * 启动点会沿这一整段排开，所以它必须和几何上的空隙一致。
   */
  trunk: number;
  /**
   * 沿主干排布的「启动吸引点」数量。
   *
   * 这不是调参，是**正确性保证**，而且必须是**一条线**而不是根部一簇。
   *
   * 只撒在根部的话会被杀死半径一次性清掉：根的杀死半径（0.021）比主干
   * 空隙（0.018）还大，于是包络底部那圈吸引点也一并被吃掉，
   * 枝条刚出根就够不着任何东西 —— 表现为「有的珊瑚停在 8 个节点」。
   * 沿主干排开之后，每一个都负责把枝条往前送一段，逐段接力进入包络。
   */
  bootstrap: number;
  influence: number;
  kill: number;
  segment: number;
  maxNodes: number;
  maxIterations: number;
  /**
   * 向光性：给平均方向叠加一个朝上的偏置，单位是段长。
   *
   * 没有它的时候，吸引点稀疏处的枝条会朝下弯 —— 因为剩余吸引点的
   * 平均方向算出来就是向下的。看起来像根而不是枝。
   * 真实植物朝光生长，这一项本来就该有，不是装饰性的调参。
   */
  upwardBias: number;
}

/**
 * 空间殖民算法本体。
 *
 * 每一轮：
 *   1. 每个吸引点找到**影响半径内**最近的节点，把自己的方向贡献给它
 *   2. 每个有贡献的节点，朝平均方向长出一段
 *   3. 被任何节点靠近到**杀死半径**以内的吸引点出局
 *
 * 两个细节决定了它好不好看：
 *   - 新长出的节点**不参与本轮**的方向累积（`snapshot`）。不这么做的话，
 *     同一轮里新节点立刻继续生长，枝条会像鞭子一样抽出去。
 *   - 杀死半径必须小于影响半径，否则吸引点会在被「看见」之前就消失，
 *     枝条会原地打转。
 */
function colonize(
  rng: Rng,
  root: { x: number; y: number },
  envelope: Envelope,
  params: ColonizeParams,
): FloraNode[] {
  const attractors: { x: number; y: number; alive: boolean }[] = [];

  // 启动点沿主干排成一条线，一直排到略高于包络底边的地方。
  //
  // 横向抖动压得很小（±0.25 段长）：抖大了就变成一丛，根会在连续多轮里
  // 每轮都长一个子节点，直接从根部扇出一把「扫帚」。
  // 纵向一直排到 1.15 倍主干长度，是为了保证接力的最后一段能咬进包络。
  for (let i = 0; i < params.bootstrap; i++) {
    const t = (i + 1) / params.bootstrap;
    attractors.push({
      x: root.x + rng.range(-0.25, 0.25) * params.segment,
      y: root.y - t * params.trunk * 1.15,
      alive: true,
    });
  }

  for (let i = 0; i < params.attractorCount; i++) {
    const p = sampleEnvelope(rng, envelope);
    attractors.push({ x: p.x, y: p.y, alive: true });
  }

  const nodes: FloraNode[] = [
    { x: fx(root.x), y: fx(root.y), parent: -1, order: 0, depth: 0 },
  ];

  const influence2 = params.influence * params.influence;
  const kill2 = params.kill * params.kill;

  for (let iter = 0; iter < params.maxIterations; iter++) {
    if (nodes.length >= params.maxNodes) break;

    const sumX = new Float64Array(nodes.length);
    const sumY = new Float64Array(nodes.length);
    const hits = new Int32Array(nodes.length);

    for (const a of attractors) {
      if (!a.alive) continue;
      let best = -1;
      let bestD = influence2;
      for (let i = 0; i < nodes.length; i++) {
        const n = nodes[i] as FloraNode;
        const dx = a.x - unfx(n.x);
        const dy = a.y - unfx(n.y);
        const d2 = dx * dx + dy * dy;
        if (d2 < bestD) {
          bestD = d2;
          best = i;
        }
      }
      if (best >= 0) {
        const nb = nodes[best] as FloraNode;
        sumX[best] = (sumX[best] as number) + (a.x - unfx(nb.x));
        sumY[best] = (sumY[best] as number) + (a.y - unfx(nb.y));
        hits[best] = (hits[best] as number) + 1;
      }
    }

    // 本轮只让**已有**的节点生长
    const snapshot = nodes.length;
    const fresh: FloraNode[] = [];
    for (let i = 0; i < snapshot; i++) {
      if ((hits[i] as number) === 0) continue;
      // 长度：mag2 是浮点平方和（只用 × 和 +），放大到 FX² 之后交给整数开方。
      // magScaled ≈ |sum| × FX。
      const sx = sumX[i] as number;
      const sy = sumY[i] as number;
      // 向光性偏置。在归一化**之前**加，于是它的相对强度与吸引点数无关。
      const by = sy - params.upwardBias * (hits[i] as number) * params.segment;
      const mag2 = sx * sx + by * by;
      const magScaled = isqrt(Math.round(mag2 * FX * FX));
      if (magScaled <= 0) continue;
      // 单位方向 × 段长，结果仍是定点整数
      const stepX = Math.round((sx * FX * params.segment * FX) / magScaled);
      const stepY = Math.round((by * FX * params.segment * FX) / magScaled);
      const cur = nodes[i] as FloraNode;
      fresh.push({
        x: clampFx(cur.x + stepX, 0, FX),
        y: clampFx(cur.y + stepY, 0, FX),
        parent: i,
        order: 0,
        depth: cur.depth + 1,
      });
    }

    if (fresh.length === 0) break;
    for (const n of fresh) nodes.push(n);

    // 淘汰被吃掉的吸引点
    for (const a of attractors) {
      if (!a.alive) continue;
      for (const n of nodes) {
        const dx = a.x - unfx(n.x);
        const dy = a.y - unfx(n.y);
        if (dx * dx + dy * dy < kill2) {
          a.alive = false;
          break;
        }
      }
    }
  }

  // 生长顺序 = 插入顺序；深度归一化用于粗细
  let maxDepth = 0;
  for (const n of nodes) if (n.depth > maxDepth) maxDepth = n.depth;
  const last = Math.max(1, nodes.length - 1);
  const depthScale = maxDepth > 0 ? 1 / maxDepth : 0;

  return nodes.map((n, i) => ({
    x: n.x,
    y: n.y,
    parent: n.parent,
    order: Math.round((i / last) * FX),
    depth: Math.round(n.depth * depthScale * FX),
  }));
}

// ————————————————————————————————————————————————————————————
// 链式生长（水草 / 海带）
// ————————————————————————————————————————————————————————————

/**
 * 一条从根部往上摆动的链。
 *
 * `sway` 与环境无关，纯粹是形态 —— 真实的摆动由水流场驱动（P3）。
 * 这里长成什么样就一直是那样，只是整体在渲染时被流场吹动。
 */
function growChain(
  rng: Rng,
  root: { x: number; y: number },
  length: number,
  segments: number,
  /** 横向摆动的**实际幅度**（缸内 uv）。上一版这里还要再乘一个系数，
   *  结果水草单株横跨了 30% 的缸宽 —— 参数的含义必须就是它字面的意思。 */
  sway: number,
): FloraNode[] {
  const nodes: FloraNode[] = [
    { x: fx(root.x), y: fx(root.y), parent: -1, order: 0, depth: 0 },
  ];

  // 形态用**二次贝塞尔**而不是正弦叠加。
  //
  // 正弦很自然是第一反应，但 Math.sin 是 implementation-approximated ——
  // 用它就等于给「模拟代码只用可复现运算」那条规矩开了个口子，
  // 而植物形态是「同种子 → 同一缸」的一部分。
  // 贝塞尔只需要 + − ×，而且曲线更平滑、参数更直观：
  // 每株只要三个随机数（两个端点偏移 + 一个控制点），
  // 不像正弦那样得逐节点算。
  const endX = root.x + rng.range(-sway, sway);
  const endY = root.y - Math.abs(length);
  // 控制点偏得更远一些，得到向外拱起的弧度而不是直线
  const ctrlX = root.x + rng.range(-sway * 2.2, sway * 2.2);
  const ctrlY = root.y - Math.abs(length) * 0.5;

  for (let i = 1; i <= segments; i++) {
    const t = i / segments;
    const it = 1 - t;
    // 二次贝塞尔： (1-t)²·P0 + 2(1-t)t·C + t²·P1
    const x = it * it * root.x + 2 * it * t * ctrlX + t * t * endX;
    const y = it * it * root.y + 2 * it * t * ctrlY + t * t * endY;
    nodes.push({
      x: clampFx(fx(x), 0, FX),
      y: clampFx(fx(y), 0, FX),
      parent: i - 1,
      order: 0,
      depth: 0,
    });
  }

  const last = Math.max(1, nodes.length - 1);
  return nodes.map((n, i) => ({
    ...n,
    order: Math.round((i / last) * FX),
    depth: Math.round((i / last) * FX),
  }));
}

// ————————————————————————————————————————————————————————————
// 组装整个景观
// ————————————————————————————————————————————————————————————

export interface FloraOptions {
  /** 珊瑚株数 */
  corals?: number;
  /** 水草丛数 */
  grassTufts?: number;
  /** 海带株数 */
  kelps?: number;
}

/**
 * 从种子生成整套植物景观。
 *
 * 每种植物用**独立的命名子流**：之后往珊瑚里加代码，不会移动任何一株水草的形态。
 * 这是 DESIGN.md §6.2 那条纪律的实际应用。
 */
export function generateFlora(seed: string, options: FloraOptions = {}): FloraSkeleton {
  const corals = options.corals ?? 4;
  const grassTufts = options.grassTufts ?? 7;
  const kelps = options.kelps ?? 3;

  const root = Rng.fromSeed(seed);
  const seedNum = hashString(seed) % 100000;
  const plants: FloraPlant[] = [];

  // ——— 珊瑚 ———
  const coralRng = root.stream('flora.coral');
  for (let i = 0; i < corals; i++) {
    const cx = 0.08 + 0.84 * coralRng.next();
    const baseY = substrateHeightAt(cx, seedNum) + 0.012;

    // 珊瑚的形状由三个量决定。**它们之间的关系比各自的取值更重要** ——
    // 这一块前后返工了四轮，每一轮都是因为破坏了下面前三条之一：
    //
    //   w          包络半宽。必须**明显大于影响半径**。
    //              否则每个节点都能同时看到两侧的吸引点，方向互相抵消，
    //              长出来的是一根直杆，一个分叉都没有。
    //
    //   ry         包络半高。配 w 保证**高 > 宽**。
    //              宽扁的包络会让枝条老老实实地朝两侧横着长，
    //              结果是一摞平行的横条 —— 那是返工最多的一版。
    //
    //   trunkGap   从根到包络底边的距离，也就是主干长度。
    //              必须**小于影响半径**，否则根够不着任何吸引点，什么都不长。
    //              写成 h 的比例是个陷阱：高的珊瑚间隙也大，直接超过影响半径。
    //
    // 另外 segment 要明显小于粗细对应的像素尺度，否则每段胶囊接近圆形，
    // 枝条会看起来像一串珠子。
    const w = 0.045 + 0.045 * coralRng.next(); // 0.045 ~ 0.090
    const h = 0.24 + 0.22 * coralRng.next(); // 0.24 ~ 0.46
    const trunkGap = 0.018;
    const ry = h * 0.42;

    const nodes = colonize(
      coralRng,
      { x: cx, y: baseY },
      // 包络底边离根 trunkGap；整株的可视高度 = trunkGap + 2·ry
      { cx, cy: baseY - trunkGap - ry, rx: w, ry },
      {
        attractorCount: Math.round(140 + 110 * coralRng.next()),
        trunk: trunkGap,
        // 主干按段长切成若干段，每段一个接力点
        bootstrap: Math.max(6, Math.round(trunkGap / 0.008) + 3),
        // influence / segment ≈ 4.3，在标准的 4~6 区间内；
        // 同时 influence(0.034) < w(0.045 起) —— 这一条是分枝的前提
        influence: 0.034,
        // 杀死半径略大于两倍段长：把枝条走过的区域尽快清空，
        // 否则吸引点会在原地反复把同一根枝条往各个方向拽
        kill: 0.019,
        segment: 0.008,
        // 向光性：枝条整体朝上，梢部才不会垂下来
        upwardBias: 1.2,
        maxNodes: 520,
        maxIterations: 420,
      },
    );
    plants.push({ kind: 'coral', nodes });
  }

  // ——— 海带 ———
  const kelpRng = root.stream('flora.kelp');
  for (let i = 0; i < kelps; i++) {
    const cx = 0.06 + 0.88 * kelpRng.next();
    const baseY = substrateHeightAt(cx, seedNum) + 0.010;
    plants.push({
      kind: 'kelp',
      nodes: growChain(kelpRng, { x: cx, y: baseY }, 0.26 + 0.22 * kelpRng.next(), 16, 0.035),
    });
  }

  // ——— 水草 ———
  const grassRng = root.stream('flora.grass');
  for (let i = 0; i < grassTufts; i++) {
    const cx = 0.03 + 0.94 * grassRng.next();
    // 一丛里长几根，各自略有差异
    const blades = 2 + Math.floor(grassRng.next() * 3);
    for (let b = 0; b < blades; b++) {
      const ox = cx + (grassRng.next() - 0.5) * 0.028;
      const oy = substrateHeightAt(ox, seedNum) + 0.008;
      plants.push({
        kind: 'grass',
        nodes: growChain(
          grassRng,
          { x: ox, y: oy },
          0.055 + 0.095 * grassRng.next(),
          8,
          0.016,
        ),
      });
    }
  }

  return { plants, fingerprint: floraFingerprint({ plants, fingerprint: '' }) };
}

/**
 * 精确指纹。植物是**派生数据**（从种子重算），不进世界状态，
 * 但它必须可复现 —— 所以要有一个能精确比较的指纹，
 * 而不是靠肉眼看两株珊瑚像不像。
 */
export function floraFingerprint(skeleton: FloraSkeleton): string {
  const parts: number[] = [skeleton.plants.length];
  for (const plant of skeleton.plants) {
    parts.push(plant.nodes.length, hashString(plant.kind));
    let nodeHash = 0;
    for (const n of plant.nodes) {
      nodeHash = hashCombine(nodeHash, n.x, n.y, n.parent + 1, n.order, n.depth);
    }
    parts.push(nodeHash);
  }
  return parts.join(':');
}

/** 供渲染统计用。 */
export function floraStats(skeleton: FloraSkeleton): {
  plants: number;
  nodes: number;
  byKind: Record<string, number>;
} {
  const byKind: Record<string, number> = {};
  let nodes = 0;
  for (const p of skeleton.plants) {
    nodes += p.nodes.length;
    byKind[p.kind] = (byKind[p.kind] ?? 0) + 1;
  }
  return { plants: skeleton.plants.length, nodes, byKind };
}
