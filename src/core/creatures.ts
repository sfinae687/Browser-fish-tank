/**
 * 生物。
 *
 * ## 一只生物是什么
 *
 * 在浏览器里，**一只生物对应一个标签页**。这是整个插件的核心概念：
 * 它不只是屏保，它是一个可视化的标签页管理器。
 *
 * | 标签页状态 | 生物的表现 |
 * |---|---|
 * | 普通 | 正常游动 |
 * | 休眠 / 已丢弃 | 暗淡蛰伏，几乎不动 |
 * | 正在出声 | 辉光脉动，明显更亮 |
 * | 已固定 | 体型更大，活动范围更窄（有领地感） |
 * | 正在加载 | 从暗处渐显 |
 *
 * ## 为什么运动这么简单
 *
 * 上一版做了群集（分离、对齐、聚合）与生态驱动的位移。这一版全部去掉，
 * 每只生物只走一条自己的缓慢路径。理由：
 *
 *   - 深海的生物本来就**稀疏而缓慢**，群集行为反而显得躁
 *   - 没有累积状态，就没有快进问题、没有确定性约束、没有仲裁者
 *   - 画面要的是「安静」，而群集天生是「热闹」的
 *
 * 于是运动变成 `位置 = f(时间)` 的纯函数 —— 两个表面各算各的也必然一致，
 * 而且**不需要任何状态存储**。
 *
 * ## 随机性从哪来
 *
 * 每只生物的外观与路径参数由**标签页 id** 派生。同一个标签页永远是同一只
 * 生物 —— 换个位置、重开浏览器都不会变。这是「认得出来」的前提。
 */

import { SHAPES, type ShapeName } from '../render/creature-mesh.js';
import type { TabInfo } from './tabs.js';

/** 缸内水域范围。生物在这个矩形里活动。 */
export const SWIM_BOUNDS = {
  minX: 0.06,
  maxX: 0.94,
  minY: 0.14,
  maxY: 0.86,
} as const;

export interface Creature {
  /** 稳定 id（标签页 id，观赏模式用序号） */
  id: number;
  /** 对应的标签页 id。-1 = 观赏模式的野生生物，不可点击。 */
  tabId: number;
  shape: ShapeName;

  /** 巡游中心（缸内 uv） */
  homeX: number;
  homeY: number;
  /** 三组路径参数：两个横向频率 + 一个纵向频率，互不通约以免走成闭合环 */
  w1: number;
  w2: number;
  w3: number;
  p1: number;
  p2: number;
  p3: number;
  /** 游荡幅度 */
  wander: number;
  /** 速度倍率 */
  speed: number;
  /** 体型倍率（= baseScale × 固定标签页加成），每次同步重算 */
  scale: number;
  /** 体型的基础倍率，属于身份 */
  baseScale: number;

  /** 亮度倍率。休眠的标签页会很低。 */
  energy: number;
  /** 是否用点缀色 */
  alt: boolean;
  /**
   * 成群程度。0 = 独居，> 0 = 属于某个群。
   *
   * 它只影响**运动**，不影响外观 —— 同一个体型可能这一缸里成群、
   * 换一缸就独居，那会让人认不出是同一只。
   */
  schooling: number;
  /** 所属鱼群的编号。只有 schooling > 0 时有意义。 */
  schoolId: number;
  /** 0..1 的显隐。新开/关闭标签页时渐入渐出。 */
  fade: number;

  // ——— 标签页信息（供交互与悬停） ———
  title: string;
  pinned: boolean;
  audible: boolean;
  discarded: boolean;
  active: boolean;
}

// ————————————————————————————————————————————————————————————
// 确定性随机（按标签页 id 派生，不需要存）
// ————————————————————————————————————————————————————————————

/**
 * 由 id 派生一个 0..1 的稳定伪随机数。
 *
 * 用一个整数哈希而不是 Math.random：同一个标签页必须是同一只生物。
 * 这里**不需要**上一版那种「跨平台逐位一致」的严格要求 ——
 * 没有累积状态，两台机器上长得略有不同也无所谓。
 */
function hash01(id: number, salt: number): number {
  let h = (id * 0x9e3779b1 + salt * 0x85ebca6b) >>> 0;
  h ^= h >>> 15;
  h = Math.imul(h, 0x2545f491) >>> 0;
  h ^= h >>> 13;
  h = Math.imul(h, 0x27d4eb2f) >>> 0;
  h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
}

/** 在 [lo, hi) 里取一个由 id 决定的稳定随机数。 */
function pick(id: number, salt: number, lo: number, hi: number): number {
  return lo + hash01(id, salt) * (hi - lo);
}

/**
 * 按权重挑一个体型。
 *
 * 权重是有意的：灯笼鱼最常见，鮟鱇最少见。一缸里如果每种体型数量一样多，
 * 看起来就像选美比赛的名单而不是一片海。
 */
const SHAPE_POOL: ShapeName[] = (() => {
  const pool: ShapeName[] = [];
  const names = Object.keys(SHAPES) as ShapeName[];
  for (const name of names) {
    const w = SHAPES[name].weight;
    // 权重转成重复次数，取整但至少 1
    const n = Math.max(1, Math.round(w * 6));
    for (let i = 0; i < n; i++) pool.push(name);
  }
  return pool;
})();

function shapeForId(id: number): ShapeName {
  const idx = Math.floor(hash01(id, 991) * SHAPE_POOL.length) % SHAPE_POOL.length;
  return SHAPE_POOL[idx] as ShapeName;
}

export interface CreatureSeedInput {
  /** 稳定 id。标签页用 tabId，观赏模式用序号。 */
  id: number;
  tabId: number;
  title: string;
  pinned: boolean;
  audible: boolean;
  discarded: boolean;
  active: boolean;
}

/**
 * 由标签页信息造一只生物。
 *
 * ## 「身份」与「状态」的分界
 *
 * 这只生物**长什么样、在哪里、怎么游**，全部只取决于 id —— 是**身份**。
 * **亮度、体型加成**取决于标签页当前的状态 —— 是**状态**。
 *
 * 这条分界很重要：一个标签页从休眠被唤醒时，生物**不该换一个样子**，
 * 只该变亮。所以身份字段只在创建时算一次，状态字段每次同步都重算。
 */
export function makeCreature(input: CreatureSeedInput): Creature {
  const { id } = input;
  const shape = shapeForId(id);

  // 固定标签页有领地感：中心更靠下、游荡幅度更小、体型更大
  const pinnedBias = input.pinned ? 1 : 0;

  const homeX = pick(id, 1, SWIM_BOUNDS.minX, SWIM_BOUNDS.maxX);
  const homeY = pick(id, 2, SWIM_BOUNDS.minY, SWIM_BOUNDS.maxY) * (1 - pinnedBias * 0.3)
    + pinnedBias * 0.22;

  // 频率取得很低：深海生物的巡游是「漂」而不是「游」
  const w1 = pick(id, 3, 0.055, 0.110);
  const w2 = pick(id, 4, 0.021, 0.047);
  const w3 = pick(id, 5, 0.038, 0.082);

  const wander = pick(id, 6, 0.05, 0.16) * (1 - pinnedBias * 0.45);

  // 亮度：休眠的标签页非常暗，出声的明显更亮
  let energy = 1;
  if (input.discarded) energy = 0.22;
  else if (!input.active && hash01(id, 77) < 0.35) energy = 0.62; // 后台标签页有些偏暗
  if (input.audible) energy = 1.55;

  return {
    id,
    tabId: input.tabId,
    shape,
    // ——— 以下全部是「身份」，只取决于 id，创建后不再变 ———
    homeX,
    homeY,
    w1,
    w2,
    w3,
    p1: pick(id, 11, 0, Math.PI * 2),
    p2: pick(id, 12, 0, Math.PI * 2),
    p3: pick(id, 13, 0, Math.PI * 2),
    wander,
    speed: pick(id, 14, 0.75, 1.35),
    scale: pick(id, 15, 0.85, 1.15) * (1 + pinnedBias * 0.45), // 创建时先给一个值
    // 大约每 7 只里有 1 只带点缀色
    alt: hash01(id, 21) < 0.14,
    // 只有小型细长的种类成群；水母和鮟鱇独居
    schooling: SHAPES[shape].kind === 'fish' && SCHOOLING_SHAPES.has(shape) ? 1 : 0,
    schoolId: Math.floor(hash01(id, 907) * SCHOOL_COUNT) % SCHOOL_COUNT,

    // ——— 以下是「状态」，每次同步都重算 ———
    energy,
    fade: 0,
    baseScale: pick(id, 15, 0.85, 1.15),
    title: input.title,
    pinned: input.pinned,
    audible: input.audible,
    discarded: input.discarded,
    active: input.active,
  };
}

/**
 * 刷新一只生物的**状态**部分。
 *
 * 注意这里绝对不碰身份字段（shape / homeX / w1…）。
 * 碰了的话，标签页一出声生物就会换个位置重新出现，那看起来像 bug。
 */
export function applyTabState(c: Creature, tab: TabInfo): void {
  c.title = tab.title;
  c.pinned = tab.pinned;
  c.audible = tab.audible;
  c.discarded = tab.discarded;
  c.active = tab.active;

  // 固定标签页体型更大、活动范围更窄（有领地感）
  c.scale = c.baseScale * (tab.pinned ? 1.45 : 1);

  // 亮度：休眠的非常暗，出声的明显更亮
  let energy = 1;
  if (tab.discarded) energy = 0.22;
  else if (!tab.active && hash01(c.id, 77) < 0.35) energy = 0.62;
  if (tab.audible) energy = 1.55;
  c.energy = energy;
}

// ————————————————————————————————————————————————————————————
// 鱼群
// ————————————————————————————————————————————————————————————

/**
 * 会成群的体型。
 *
 * 哪些鱼成群是有讲究的：小型、细长的种类（灯笼鱼、斧头鱼、带鱼）
 * 在真实海里就是成群活动的，而鮟鱇和水母独居。**给所有生物都加上成群
 * 反而会失去「一群小鱼掠过」这个画面上最有效的对比。**
 *
 * ⚠️ 但**群的规模**比「有没有群」更重要。第一版只有 4/18 只在成群、
 * 分到两个群里每群两只 —— 那看起来只是碰巧挨在一起，不是一群鱼。
 * 要让「成群」读得出来，每群至少要有五六只。
 */
const SCHOOLING_SHAPES: ReadonlySet<string> = new Set(['lantern', 'hatchet', 'ribbon']);

/** 一缸里分成几个群。太多了看不出「群」，太少了满屏都是一坨。 */
const SCHOOL_COUNT = 2;

/**
 * 一个鱼群的**共享吸引子**。
 *
 * 这是「成群感」的全部来源：同一个群里的每只生物都围绕这个点在动，
 * 而这个点自己按一条缓慢的路径游过整缸。
 *
 * 关键在于它是**时间的纯函数** —— 不需要任何个体状态、不需要邻居查询、
 * 不需要积分。位置仍然是 `f(id, t)`，于是两个表面各算各的也必然一致。
 * 真正的 boids 需要每只记住自己的速度，那是这一版刻意避开的东西。
 */
function schoolCenter(schoolId: number, t: number): { x: number; y: number } {
  const a = hash01(schoolId, 811);
  const b = hash01(schoolId, 823);
  const c = hash01(schoolId, 829);

  // 每个群一片自己的巡游区域，尽量摊开、不要重叠
  const cx = 0.16 + a * 0.68;
  const cy = 0.26 + b * 0.38;
  const wx = 0.055 + c * 0.045;

  // 频率取互不通约的值，免得走出一个看得出循环的闭合路径
  // 群心要走得远一点，这样才看得出「一群鱼游过整缸」，
  // 而不是「几只鱼在原地打转」
  const x = cx + Math.sin(t * 0.043 + a * 6.28) * wx * 1.6 + Math.sin(t * 0.017 + b * 6.28) * wx;
  const y = cy + Math.sin(t * 0.029 + c * 6.28) * 0.075;
  return { x, y };
}

/** 位置与朝向。纯函数 —— 同样的 (creature, t) 永远得到同样的结果。 */
export interface Pose2D {
  x: number;
  y: number;
  /** 单位朝向 */
  dx: number;
  dy: number;
}

/**
 * 求一只生物在 t 时刻的位置与朝向。
 *
 * 两条横向波 + 一条纵向波。三个频率刻意取互不通约的值（不是整数倍），
 * 否则路径会很快走成一个闭合的环，一眼就看出来是循环的。
 *
 * 朝向由**有限差分**求，而不是解析求导 —— 差分天然和位置一致，
 * 而且以后改路径公式时不会忘记同步改朝向。
 */
export function poseAt(c: Creature, t: number, out: Pose2D): Pose2D {
  const s = t * c.speed;
  const step = 0.35;

  // ——————— 成群 ———————
  //
  // 群心 + 有相位差的环绕 + 一点个体抖动。
  // 朝向取**群心的运动方向**，而不是个体自身路径的方向 ——
  // 「所有鱼朝着同一个方向」是成群感里最关键的一条，
  // 少了它，一群鱼看起来只是碰巧挨在一起的散兵游勇。
  if (c.schooling > 0) {
    // ⚠️ 群心必须用**共享时间** t，不能用各自的 s = t * c.speed。
    //
    // 用各自的速度意味着每条鱼在追群心轨迹上的**不同位置** ——
    // 于是同一个群里会出现朝向差 88° 的情况，看起来根本不像一群鱼。
    // 速度差异只能作用在个体的环绕相位上，不能作用在群心上。
    const centre = schoolCenter(c.schoolId, t);
    const ang = c.p1 + s * (0.42 + c.w1 * 1.8);
    // 环绕半径决定这一群鱼是「一群」还是「一坨」。
    // 给大了散成散兵游勇，给小了糊成一团 —— 0.5 倍游荡幅度附近最像样。
    // 个体之间靠 c.wander 天然有差异，所以不会排成一个规则的圆。
    const rad = c.wander * 0.55;

    out.x = centre.x + Math.cos(ang) * rad + Math.sin(s * c.w2 * 2.4 + c.p2) * 0.010;
    out.y = centre.y + Math.sin(ang) * rad * 0.52 + Math.sin(s * c.w3 * 1.9 + c.p3) * 0.009;

    // 朝向：群心的运动方向 + 每条自己的小幅摆动（游动时身体本来就会偏）
    const ahead = schoolCenter(c.schoolId, t + step);
    let dx = ahead.x - centre.x;
    let dy = ahead.y - centre.y;
    const wob = Math.sin(s * 0.9 + c.p2) * 0.22;
    const cosW = Math.cos(wob);
    const sinW = Math.sin(wob);
    const rx = dx * cosW - dy * sinW;
    const ry = dx * sinW + dy * cosW;
    dx = rx;
    dy = ry;

    const len = Math.sqrt(dx * dx + dy * dy);
    if (len > 1e-7) {
      out.dx = dx / len;
      out.dy = dy / len;
    } else {
      out.dx = 1;
      out.dy = 0;
    }
    return out;
  }

  const posX = (tt: number): number =>
    c.homeX + c.wander * (Math.sin(tt * c.w1 + c.p1) * 0.68 + Math.sin(tt * c.w2 + c.p2) * 0.32);
  const posY = (tt: number): number =>
    c.homeY + c.wander * 0.62 * Math.sin(tt * c.w3 + c.p3);

  out.x = posX(s);
  out.y = posY(s);

  const nx = posX(s + step);
  const ny = posY(s + step);
  let dx = nx - out.x;
  let dy = ny - out.y;
  const len = Math.sqrt(dx * dx + dy * dy);
  if (len > 1e-7) {
    dx /= len;
    dy /= len;
  } else {
    dx = 1;
    dy = 0;
  }
  out.dx = dx;
  out.dy = dy;
  return out;
}

// ————————————————————————————————————————————————————————————
// 生物群
// ————————————————————————————————————————————————————————————

/**
 * 一缸里最多同时显示多少只。
 *
 * 标签页可以有几十个，但一片海里挤满生物就既不美、也看不清。
 * 超出的按优先级筛掉（固定 > 出声 > 当前 > 靠前）。
 */
export const DEFAULT_MAX_CREATURES = 18;

/** 渐入 / 渐出秒数。渐出比渐入慢 —— 消失应该是「飘散」而不是「闪没」。 */
const FADE_IN = 0.9;
const FADE_OUT = 1.6;

/** 标签页留下来的优先级：越大越该被显示。 */
function tabPriority(t: TabInfo): number {
  let p = 0;
  if (t.pinned) p += 1000;
  if (t.audible) p += 500;
  if (t.active) p += 250;
  // 靠前的标签页略占优（用户的注意力本来就在左边）
  p += Math.max(0, 60 - t.index);
  return p;
}

export interface FlockOptions {
  maxCreatures?: number;
  /**
   * 只显示当前窗口的标签页。默认 true ——
   * 把别的窗口的标签页也混进来，画面会变成一个无法解释的动物园。
   */
  currentWindowOnly?: boolean;
}

/**
 * 标签页 ↔ 生物的双向映射。
 *
 * 每帧调一次 `sync`。它做三件事：
 *
 *   1. 新标签页 → 造一只生物（fade 从 0 开始，渐入）
 *   2. 已有标签页 → 刷新状态（亮度、体型），**绝不碰身份**
 *   3. 消失的标签页 → 渐出，归零后移除
 *
 * 第 2 条里的「绝不碰身份」是这一层最容易写错的地方：一旦在刷新状态时
 * 顺手改动了位置或路径参数，标签页一出声生物就会跳一下，看起来像 bug。
 */
export class Flock {
  private readonly items: Creature[] = [];
  private readonly byTab = new Map<number, Creature>();
  private max: number;

  constructor(opts: FlockOptions = {}) {
    this.max = Math.max(1, opts.maxCreatures ?? DEFAULT_MAX_CREATURES);
  }

  get list(): readonly Creature[] {
    return this.items;
  }

  /** 配置改了生物数量上限时调用。 */
  setMax(n: number): void {
    this.max = Math.max(1, Math.round(n));
  }

  get count(): number {
    return this.items.length;
  }

  byTabId(tabId: number): Creature | undefined {
    return this.byTab.get(tabId);
  }

  /** 同步一次。`dt` 是距上一帧的秒数，用于渐入渐出。 */
  sync(tabs: readonly TabInfo[], dt: number): void {
    // ——— 挑出该显示的标签页 ———
    const ranked = [...tabs].sort((a, b) => tabPriority(b) - tabPriority(a));
    const shown = new Set<number>();
    for (const t of ranked) {
      if (shown.size >= this.max) break;
      shown.add(t.id);
    }

    // ——— 新建与刷新 ———
    for (const tab of tabs) {
      if (!shown.has(tab.id)) continue;
      let c = this.byTab.get(tab.id);
      if (!c) {
        c = makeCreature({
          id: tab.id,
          tabId: tab.id,
          title: tab.title,
          pinned: tab.pinned,
          audible: tab.audible,
          discarded: tab.discarded,
          active: tab.active,
        });
        this.byTab.set(tab.id, c);
        this.items.push(c);
      }
      applyTabState(c, tab);
    }

    // ——— 渐入 / 渐出 ———
    const step = Math.max(0, Math.min(dt, 0.25)); // 掉帧时不要让渐入跳过去
    for (let i = this.items.length - 1; i >= 0; i--) {
      const c = this.items[i] as Creature;
      if (shown.has(c.tabId)) {
        c.fade = Math.min(1, c.fade + step / FADE_IN);
      } else {
        c.fade -= step / FADE_OUT;
        if (c.fade <= 0) {
          c.fade = 0;
          this.byTab.delete(c.tabId);
          this.items.splice(i, 1);
        }
      }
    }
  }

  /** 清空。切换数据源时用。 */
  clear(): void {
    this.items.length = 0;
    this.byTab.clear();
  }
}
