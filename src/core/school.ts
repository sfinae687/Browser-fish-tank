/**
 * 鱼群运动。
 *
 * ## 核心判断：不做积分，而是「世界时间的纯函数」
 *
 * 最直觉的做法是给每条鱼存速度、每 tick 积分一次。但那样鱼的位置就成了
 * `WorldState` 的一部分，而 `WorldState` 必须支持**快进** ——
 * 关掉标签页一天再回来要补 260 万步。20 条鱼 × 20 个邻居 = 十亿级操作，
 * 快进会直接卡死。
 *
 * 而且它本来就不必要：一条鱼在没人看的 24 小时里游到哪里，**没有意义**。
 * 有意义的是它的生态状态（能量、年龄、是否还活着），那是 P4 的活，
 * 而且跑在分钟级的慢节奏上。
 *
 * 所以这里换成：
 *
 *   1. 每条鱼有一条**由时间参数化的基准路径**（home + 两个相位不同的波）
 *   2. 在此之上跑**固定轮数**的分离松弛，把靠得太近的鱼推开
 *
 * 结果是 `(种子, 世界时间) → 全体位置` 的纯函数：
 *
 *   - 没有状态，也就没有快进问题：跳到任意时刻只是重新求值一次
 *   - 任意帧率下都平滑（不依赖步长）
 *   - 严格可复现（只用 + − × ÷ 和 isqrt）
 *   - 两个表面各算各的，结果逐位一致
 *
 * 代价是鱼不能「记得」自己去过哪里 —— 对 P3 来说没有任何损失。
 * 等到 P4 需要鱼挨饿、追捕、繁殖时，那些**生态**量会进世界状态，
 * 但它们的更新跑在分钟级的慢节奏上，快进依然便宜。
 *
 * @see DESIGN.md §3.1、§5
 */

import { fx, unfx, isqrt } from './fixed.js';
import { wave01 } from './wave.js';
import { Rng } from './rng.js';
import type { Genome } from './genome.js';

/**
 * 运动层需要的字段。
 *
 * `world.ts` 里的 `FishRecord` 在结构上满足这个接口 —— 生态层直接
 * 就是运动层的超集，所以 `computeSchool(state.fish, ...)` 可以直接传。
 *
 * 划这条界线的意义：运动**只需要这些**，于是它可以是世界时间的纯函数，
 * 不必知道能量、年龄这些随时间累积的生态量。
 */
export interface MotionSeed {
  /** 基因组在池里的下标 */
  genome: number;
  /** 基准位置（缸内 uv），鱼绕着它游 */
  homeX: number;
  homeY: number;
  /** 路径相位，让每条鱼的轨迹错开 */
  phase: number;
  /** 个体游速倍率 */
  speedScale: number;
  /** 漫游幅度 */
  wanderAmp: number;
  /** 在群体里偏向靠前还是靠后（分离松弛的强度微调） */
  spacing: number;
  /**
   * 体半径（缸内 uv）。分离距离按它算，而不是用一个固定值 ——
   * 体长最大 0.155，用一个固定的小半径会让身体互相穿插。
   */
  radius: number;
  /** 0 = 活着；> 0 表示死后经过的秒数 */
  decay: number;
  /**
   * 死亡时刻（世界秒）。
   *
   * 死鱼的位置**冻结在那一刻**再叠加下沉，而不是继续沿基准路径漂。
   * 不这么做的话，一条死鱼还会继续「游」，看起来像诈尸。
   */
  deathAt: number;
}

/**
 * 鱼群的活动范围（缸内 uv）。
 *
 * 上界给水面留出空间，下界在底砂线之上 —— 鱼不该钻进砂里，
 * 也不该贴着水面游。
 */
export const SWIM_BOUNDS = {
  minX: 0.07,
  maxX: 0.93,
  minY: 0.16,
  maxY: 0.70,
} as const;

/**
 * 分离时两条鱼的半径之和要乘的系数。
 * 1.0 表示「刚好不重叠」，略大于 1 留一点余量。
 */
const SEPARATION_FACTOR = 1.15;
/** 兜底的最小分离距离，防止基因组异常小时鱼叠在一起 */
const MIN_SEPARATION = 0.030;
/** 分离松弛的轮数与强度。轮数固定 → 结果只依赖输入 */
const RELAX_ITERATIONS = 4;
const RELAX_STRENGTH = 0.55;

/** 基准路径的角频率。整条路径的周期约 40 秒，慢慢悠悠的。 */
const BASE_OMEGA = 0.155;

/** 求朝向时前后两次求值的时间差（秒） */
const HEADING_DT = 0.055;

/** 死鱼下沉的速度（缸内 uv / 秒）。 */
const SINK_RATE = 0.00042;
/** 缸内底砂线的近似高度。死鱼沉到这里就不再往下。 */
const SAND_LINE = 0.78;

// ————————————————————————————————————————————————————————————
// 生成
// ————————————————————————————————————————————————————————————

/**
 * 从种子派生一群鱼。
 *
 * 个体参数（家的位置、相位、速度倍率）用**独立的命名子流**，
 * 于是之后往移动逻辑里加代码，不会让所有鱼的位置整体错位。
 */
export function generateSchool(
  seed: string,
  genomes: readonly Genome[],
  size: number,
): MotionSeed[] {
  const root = Rng.fromSeed(seed);
  const count = Math.max(1, Math.min(size, 48));
  const out: MotionSeed[] = [];

  for (let i = 0; i < count; i++) {
    const rng = root.stream(`fauna.school/${i}`);
    const genomeIndex = i % Math.max(1, genomes.length);
    const g = genomes[genomeIndex];
    const depth = g ? unfx(g.behavior.depthPref) : 0.5;

    // 家的位置：x 随机铺开，y 围绕这条鱼偏好的水深
    const homeY = SWIM_BOUNDS.minY + (SWIM_BOUNDS.maxY - SWIM_BOUNDS.minY) * (0.18 + 0.64 * depth);
    out.push({
      genome: genomeIndex,
      homeX: fx(rng.range(SWIM_BOUNDS.minX, SWIM_BOUNDS.maxX)),
      homeY: fx(homeY + rng.range(-0.03, 0.03)),
      phase: fx(rng.range(0, 1)),
      speedScale: fx(rng.range(0.7, 1.35)),
      wanderAmp: fx(rng.range(0.035, 0.10)),
      spacing: fx(rng.range(0.7, 1.3)),
      radius: g ? Math.round(g.morphology.length * 0.42) : fx(0.05),
      decay: 0,
      deathAt: -1,
    });
  }
  return out;
}

// ————————————————————————————————————————————————————————————
// 求值
// ————————————————————————————————————————————————————————————

/** 求值结果。缓冲区由调用方复用，避免每帧分配。 */
export interface SchoolPose {
  /** 交错的位置 [x0,y0,x1,y1,…]，缸内 uv */
  pos: Float32Array;
  /** 交错的朝向单位向量 */
  dir: Float32Array;
  /** 每条鱼的游动相位（连续，供脊柱行波使用） */
  phase: Float32Array;
  count: number;
}

export function allocatePose(count: number): SchoolPose {
  return {
    pos: new Float32Array(count * 2),
    dir: new Float32Array(count * 2),
    phase: new Float32Array(count),
    count,
  };
}

/** 基准路径：吃进 (seed, t)，吐出缸内 uv。全部只用 + − × ÷。 */
function basePath(
  seed: MotionSeed,
  genome: Genome | undefined,
  t: number,
  out: { x: number; y: number },
): void {
  const hx = unfx(seed.homeX);
  const hy = unfx(seed.homeY);
  const amp = unfx(seed.wanderAmp);
  const ph = unfx(seed.phase);

  // 两个频率不成整数比的波，叠出一条不重复的漫游路径。
  // 用 wave01（平滑三角波）而不是 sin —— 见 core/wave.ts 的说明。
  const a = wave01(t + ph);
  const b = wave01(t * 0.63 + ph * 1.7 + 0.31);
  const c = wave01(t * 0.29 + ph * 2.3 + 0.67);

  out.x = hx + amp * (a * 0.75 + c * 0.45);
  // 垂直方向幅度小一些：鱼主要是横着游的
  out.y = hy + amp * 0.55 * (b * 0.8 + c * 0.35);

  // 群集倾向会把鱼往同伴附近拉；不合群的个体把家的位置权重放大
  const social = genome ? unfx(genome.behavior.sociability) : 0.5;
  out.x = hx + (out.x - hx) * (0.55 + 0.45 * social);
  out.y = hy + (out.y - hy) * (0.55 + 0.45 * social);
}

/**
 * 求出这一时刻全体鱼的位置与朝向。
 *
 * 纯函数：同样的 `(seeds, genomes, timeSeconds)` 永远得到同样的结果。
 * 可以在任意时刻独立求值，不需要从头推进。
 */
export function computeSchool(
  seeds: readonly MotionSeed[],
  genomes: readonly Genome[],
  timeSeconds: number,
  pose: SchoolPose,
): void {
  const n = Math.min(seeds.length, pose.count);
  if (n === 0) return;

  const now = pose.pos;
  const ahead = pose.dir; // 先借用朝向缓冲区当草稿，最后再被覆盖

  solvePositions(seeds, genomes, timeSeconds, now, n);
  // 朝向用**完整的**前后两次求值之差，而不是只对基准路径求导。
  // 只对基准路径求导会漏掉分离松弛带来的位移，鱼在互相推开时
  // 身体朝向会和实际移动方向不一致 —— 看起来像在横着漂。
  solvePositions(seeds, genomes, timeSeconds + HEADING_DT, ahead, n);

  for (let i = 0; i < n; i++) {
    const ix = i * 2;
    let dx = (ahead[ix] as number) - (now[ix] as number);
    let dy = (ahead[ix + 1] as number) - (now[ix + 1] as number);
    const len = vecLength(dx, dy);
    if (len < 1e-6) {
      dx = 1;
      dy = 0;
    } else {
      dx /= len;
      dy /= len;
    }
    (pose.dir as Float32Array)[ix] = dx;
    (pose.dir as Float32Array)[ix + 1] = dy;
    pose.phase[i] = timeSeconds;
  }
}

/**
 * 求出某一时刻的全体位置，写进 `out`。
 *
 * 拆成独立函数是为了让朝向能对两个时刻各求一次值 —— 见 computeSchool。
 */
function solvePositions(
  seeds: readonly MotionSeed[],
  genomes: readonly Genome[],
  timeSeconds: number,
  out: Float32Array,
  n: number,
): void {
  const tmp = { x: 0, y: 0 };

  // ——— 1. 基准路径 ———
  for (let i = 0; i < n; i++) {
    const seed = seeds[i] as MotionSeed;
    const genome = genomes[seed.genome];
    const speed = genome ? unfx(genome.behavior.cruiseSpeed) : 0.06;

    // 死鱼：位置冻结在死亡那一刻，再加上下沉。
    // 用 deathAt 而不是当前时刻，否则死鱼会继续沿着基准路径游 —— 看起来像诈尸。
    const evalAt = seed.decay > 0 && seed.deathAt >= 0 ? seed.deathAt : timeSeconds;
    const t = evalAt * BASE_OMEGA * unfx(seed.speedScale) * (speed / 0.06);
    basePath(seed, genome, t, tmp);

    if (seed.decay > 0) {
      // 下沉，到砂面为止
      tmp.y = Math.min(tmp.y + seed.decay * SINK_RATE, SAND_LINE);
    }

    out[i * 2] = tmp.x;
    out[i * 2 + 1] = tmp.y;
  }

  // ——— 2. 分离松弛 ———
  //
  // 固定轮数的 Gauss-Seidel 式松弛：把靠得太近的鱼沿连线推开。
  // **轮数与遍历顺序都是固定的**，所以结果只依赖输入 —— 这是它能
  // 保持纯函数性质的关键，不能改成「直到收敛」。
  //
  // ⚠️ 位移必须写成「单位方向 × 有上界的步长」，不能写成
  // `(SEP - d) / d * dx`。后者在两条鱼几乎重合时推力会炸掉：
  // d = 1e-4 时系数到 143，单帧位移冲到 0.013（1.3% 缸宽 / 帧），
  // 看起来就是鱼在瞬移。现在每一步最多走 SEPARATION * 0.35 * strength。
  for (let iter = 0; iter < RELAX_ITERATIONS; iter++) {
    for (let i = 0; i < n; i++) {
      const ix = i * 2;
      // 尸体不参与避让：活鱼会绕开尸体的效果反而更奇怪
      if ((seeds[i] as MotionSeed).decay > 0) continue;
      for (let j = i + 1; j < n; j++) {
        if ((seeds[j] as MotionSeed).decay > 0) continue;
        const jx = j * 2;
        const dx = (out[jx] as number) - (out[ix] as number);
        const dy = (out[jx + 1] as number) - (out[ix + 1] as number);
        const d = vecLength(dx, dy);
        // 分离距离按两条鱼的**体型之和**算：大鱼之间该离得更远
        const sep = Math.max(
          MIN_SEPARATION,
          (unfx((seeds[i] as MotionSeed).radius) + unfx((seeds[j] as MotionSeed).radius)) *
            SEPARATION_FACTOR,
        );
        const overlap = sep - d;
        if (overlap <= 0) continue;

        // 方向：正常情况就是连线方向；几乎重合时连线方向没有意义，
        // 换成一个由 (i, j) 决定的、确定的单位方向 —— 用黄金角散开，
        // 避免所有重合的鱼被推向同一个方向。
        let ux: number;
        let uy: number;
        if (d < sep * 0.08) {
          const a = i * 2.399963 + j * 0.785398;
          ux = wave01(a);
          uy = wave01(a + 0.37);
          const ul = vecLength(ux, uy);
          if (ul < 1e-6) {
            ux = 1;
            uy = 0;
          } else {
            ux /= ul;
            uy /= ul;
          }
        } else {
          ux = dx / d;
          uy = dy / d;
        }

        const step = Math.min(overlap, sep * 0.35) * RELAX_STRENGTH * 0.5;
        const si = unfx((seeds[i] as MotionSeed).spacing);
        const sj = unfx((seeds[j] as MotionSeed).spacing);
        out[jx] = (out[jx] as number) + ux * step * sj;
        out[jx + 1] = (out[jx + 1] as number) + uy * step * sj;
        out[ix] = (out[ix] as number) - ux * step * si;
        out[ix + 1] = (out[ix + 1] as number) - uy * step * si;
      }
    }
  }

  // ——— 3. 边界收束 ———
  for (let i = 0; i < n; i++) {
    const ix = i * 2;
    out[ix] = clampRange(out[ix] as number, SWIM_BOUNDS.minX, SWIM_BOUNDS.maxX);
    out[ix + 1] = clampRange(out[ix + 1] as number, SWIM_BOUNDS.minY, SWIM_BOUNDS.maxY);
  }
}

function clampRange(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

/**
 * 向量长度。
 *
 * ⚠️ 放大倍数必须给够。这里要归一化的向量非常短 —— 一帧的位移量级是 1e-3，
 * 于是 d² 是 1e-6。若只放大 2^20 倍，1e-6 × 2^20 ≈ 1.05，四舍五入到 1 之后
 * 相对误差高达 20%：归一化出来的「单位向量」长度会到 1.2，
 * 鱼的身体会被拉长、朝向也会偏。
 *
 * 放大 2^40 之后相对误差降到 1e-6 量级，而 d² 最多到 1，
 * 乘完是 1.1e12，远在 2^53 之内，中间量仍然精确。
 */
function vecLength(x: number, y: number): number {
  const scaled = Math.round((x * x + y * y) * 1099511627776); // × 2^40
  return isqrt(scaled) / 1048576; // ÷ 2^20
}

/** 全体位置的可复现指纹，供自检使用。 */
export function poseFingerprint(pose: SchoolPose): string {
  const parts: string[] = [];
  for (let i = 0; i < pose.count; i++) {
    parts.push(
      (pose.pos[i * 2] as number).toFixed(6),
      (pose.pos[i * 2 + 1] as number).toFixed(6),
    );
  }
  return parts.join(',');
}
