/**
 * 鱼类基因组。
 *
 * 一条鱼的一切都由它决定：**长什么样**（脊柱长度、体型曲线、各鳍的位置与大小）
 * 和**什么脾气**（巡游速度、胆量、合群程度、偏好水深、食性）。
 *
 * 全部数值都是定点整数，全部只由种子和无偏置的算术产生 ——
 * 于是「同一个种子 → 同一条鱼」，而且可以做交叉与变异（P5）。
 *
 * ## 为什么形态也要可复现
 *
 * 这里有个容易漏的点：基因组不只是给模拟用的参数，它还**决定了几何形状**。
 * 如果形态生成里混进了 GPU 浮点或者 `Math.sin`，两条机器上看到的鱼就会
 * 长得不一样 —— 而「把种子发给别人，他能复现你这一缸」正是这个项目的承诺。
 *
 * @see DESIGN.md §4、§3.3
 */

import { FX, fx, unfx, clampFx } from './fixed.js';
import { Rng, hashCombine, hashString } from './rng.js';

export interface GenomeMorphology {
  /** 脊柱段数。段数越多身体越柔软，但网格也越大。 */
  spineSegments: number;
  /** 体长（缸内 uv） */
  length: number;
  /** 身体最大半高 */
  heightFront: number;
  /** 尾柄处的半高 */
  heightBack: number;
  /** 体型曲线的幂次：小则头尾粗细分界靠后，大则前端更饱满 */
  taper: number;
  /** 背鳍高度 */
  dorsalHeight: number;
  /** 背鳍起点（沿脊柱 0..1） */
  dorsalStart: number;
  /** 尾鳍跨度 */
  caudalSpan: number;
  /** 尾鳍分叉深度 0..1 */
  caudalFork: number;
  /** 眼睛半径 */
  eyeRadius: number;
  /** 眼睛位置（沿脊柱 0..1） */
  eyePos: number;
}

export interface GenomePattern {
  /** 主色相 0..1（着色器里再转成具体颜色） */
  hue: number;
  /** 腹部色相 0..1 */
  hueBelly: number;
  /** 条纹频率：沿体长的条数 */
  stripeFreq: number;
  /** 条纹锐度 0..1 */
  stripeSharp: number;
  /** 鳍的透明度 0..1 */
  finAlpha: number;
}

export interface GenomeBehavior {
  /** 巡游速度（缸内 uv / 秒） */
  cruiseSpeed: number;
  /** 胆量：影响它离群独游的倾向与离底高度 */
  boldness: number;
  /** 合群程度 */
  sociability: number;
  /** 偏好水深 0..1（0 = 水面，1 = 缸底） */
  depthPref: number;
  /** 食性 0..2：0 草食，1 杂食，2 肉食。P4 用。 */
  diet: number;
}

export interface GenomeMetabolism {
  /** 基础代谢（能量 / 秒） */
  basal: number;
  /** 能量上限 */
  maxEnergy: number;
  /**
   * 寿命（秒）。
   *
   * ⚠️ 这里做了**刻意的压缩**：真实观赏鱼活几年，而一个陪伴型鱼缸
   * 需要在一天之内让人看出世代更替。整套生态的时间尺度都是压缩过的
   * （藻类 1.6 小时翻倍、水温时间常数 2 小时），鱼也必须跟着压缩，
   * 否则「种群动态」在一周内什么都看不到。
   */
  lifespan: number;
  /** 性成熟年龄（秒） */
  maturity: number;
}

export interface Genome {
  id: number;
  /**
   * 亲本 id。
   *
   * **可能是 1 个也可能是 2 个**：
   *   - 无性繁殖（P4 的自然繁殖）→ 1 个
   *   - 杂交（P5 的玩家操作）→ 2 个
   *   - 野生个体 → null
   *
   * 第一版写死成二元组，于是无性繁殖的后代只能记 `null`，
   * 谱系画出来是**平的** —— 看起来像「谱系功能没做」，其实只是
   * 类型不允许记录单亲。
   */
  parents: readonly number[] | null;
  /** 世代数 */
  generation: number;
  morphology: GenomeMorphology;
  pattern: GenomePattern;
  behavior: GenomeBehavior;
  metabolism: GenomeMetabolism;
}

// ————————————————————————————————————————————————————————————
// 生成
// ————————————————————————————————————————————————————————————

/**
 * 从一个子流生成一条鱼的全部参数。
 *
 * 每一条鱼用**独立的命名子流**（`fauna.genome/<id>`）：之后往基因组里加字段，
 * 不会让已有的鱼全部变形。这条纪律在 rng.ts 里解释过，这里是它的第二个实际应用
 * （第一个是植物）。
 */
function fromStream(rng: Rng, id: number, parents: readonly [number, number] | null, generation: number): Genome {
  const m = rng.stream('morphology');
  const p = rng.stream('pattern');
  const b = rng.stream('behavior');
  const k = rng.stream('metabolism');

  // ——— 体型 ———
  const spineSegments = 9 + m.int(0, 6); // 9..14
  const length = fx(m.range(0.062, 0.125));
  // 高长比是「鱼的轮廓」最直接的来源：0.18 是细长的鳗形，0.45 是圆扁的神仙鱼
  const aspect = m.range(0.18, 0.42);
  const heightFront = fx(unfx(length) * aspect * 0.5);
  const heightBack = fx(unfx(length) * aspect * 0.5 * m.range(0.16, 0.40));
  const taper = fx(m.range(0.65, 1.75));

  // 鳍的尺寸以**体长**为基准。第一版给了 0.12~0.46 倍的背鳍和
  // 0.25~0.72 倍的尾鳍，结果每条鱼都像一只风筝 —— 鳍把身体淹没了。
  // 真实鱼的鳍高大约在体长的 0.1~0.3 倍之间。
  const dorsalHeight = fx(unfx(length) * m.range(0.08, 0.27));
  const dorsalStart = fx(m.range(0.22, 0.58));
  const caudalSpan = fx(unfx(length) * m.range(0.16, 0.40));
  const caudalFork = fx(m.range(0.0, 0.62));

  // ——— 花纹 ———
  const hue = fx(m.range(0, 1));
  const hueBelly = fx(fract01(unfx(hue) + p.range(0.35, 0.6)));
  const stripeFreq = fx(p.range(0, 5.5));
  const stripeSharp = fx(p.range(0.35, 0.95));
  const finAlpha = fx(p.range(0.35, 0.85));

  // ——— 脾气 ———
  const lenFactor = unfx(length) / 0.115; // 相对「标准体长」
  const cruiseSpeed = fx(0.055 * b.range(0.55, 1.5) * (1.25 - lenFactor * 0.35));
  const boldness = fx(b.range(0.15, 0.95));
  const sociability = fx(b.range(0.25, 1.0));
  const depthPref = fx(b.range(0.12, 0.82));
  const diet = fx(b.range(0, 2));

  // ——— 代谢 ———
  // 代谢与体长挂钩：大鱼耗能多。指数 2 是「表面积/体积」的粗略代理。
  const massProxy = lenFactor * lenFactor;
  // ⚠️ 基础代谢的量级必须和「能量池」以及「饿死的时间尺度」对上。
  //
  // 第一版写的是 0.0016/s —— 意味着一条满能量的鱼 **10 分钟**就烧光了，
  // 而藻类要 16 小时才爆得起来（新缸综合征）。结果 9 条鱼在第一天全部饿死，
  // 一次繁殖都没发生，整个生态一次都没转起来。
  //
  // 正确的算法是倒推：希望一条鱼在完全没有食物时能撑大约 12 小时，
  // 能量池是 1.0，那么 basal = 1.0 / 43200 ≈ 2.3e-5。
  const basal = fx(2.2e-5 * massProxy * k.range(0.8, 1.25));
  const maxEnergy = fx(k.range(0.85, 1.15));
  // 大鱼活得久。8~30 小时，配上 1~3 小时的性成熟期，
  // 于是一天之内能看到一代更替。
  const lifespan = Math.round(8 * 3600 + 22 * 3600 * Math.min(1, lenFactor));
  const maturity = Math.round(lifespan * k.range(0.08, 0.18));

  return {
    id,
    parents,
    generation,
    morphology: {
      spineSegments,
      length,
      heightFront,
      heightBack,
      taper,
      dorsalHeight,
      dorsalStart,
      caudalSpan,
      caudalFork,
      eyeRadius: fx(unfx(length) * m.range(0.045, 0.085)),
      eyePos: fx(m.range(0.10, 0.26)),
    },
    pattern: { hue, hueBelly, stripeFreq, stripeSharp, finAlpha },
    behavior: { cruiseSpeed, boldness, sociability, depthPref, diet },
    metabolism: { basal, maxEnergy, lifespan, maturity },
  };
}

const fract01 = (v: number): number => v - Math.floor(v);

/**
 * 从种子生成一个基因组池。
 *
 * P3 里鱼群是「野生」的，池子完全由种子派生、不进世界状态。
 * P5 引入育种之后，池子会变成世界状态的一部分（因为新基因组会被创造出来）。
 */
export function generateGenomePool(seed: string, count: number): Genome[] {
  const root = Rng.fromSeed(seed);
  const genomes: Genome[] = [];
  for (let i = 0; i < count; i++) {
    genomes.push(fromStream(root.stream(`fauna.genome/${i}`), i, null, 0));
  }
  return genomes;
}

// ————————————————————————————————————————————————————————————
// 指纹
// ————————————————————————————————————————————————————————————

/**
 * 基因组的精确指纹。
 *
 * 「同种子 → 同一条鱼」必须可验证，不能靠肉眼比两条鱼像不像。
 * 测试用它来断言，P5 的谱系也会用它做去重。
 */
export function genomeFingerprint(g: Genome): string {
  const m = g.morphology;
  const p = g.pattern;
  const b = g.behavior;
  const k = g.metabolism;
  return [
    g.id,
    g.generation,
    g.parents ? g.parents.join(',') : '-',
    m.spineSegments, m.length, m.heightFront, m.heightBack, m.taper,
    m.dorsalHeight, m.dorsalStart, m.caudalSpan, m.caudalFork, m.eyeRadius, m.eyePos,
    p.hue, p.hueBelly, p.stripeFreq, p.stripeSharp, p.finAlpha,
    b.cruiseSpeed, b.boldness, b.sociability, b.depthPref, b.diet,
    k.basal, k.maxEnergy, k.lifespan, k.maturity,
  ].join('|');
}

/**
 * 校验从存储里读回来的基因组。
 *
 * 快照里现在带着整个基因组池，任何一个字段被写坏都会污染整个模拟。
 * 宁可整份快照作废，也不要让一个 NaN 进入世界 —— 存储层的指纹校验
 * 会在 sanitize 之后发现不一致并丢弃它。
 */
export function sanitizeGenome(raw: unknown): Genome | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const r = raw as Record<string, unknown>;
  const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

  const id = r['id'];
  const generation = r['generation'];
  if (!isNum(id) || !isNum(generation)) return null;

  const m = r['morphology'];
  const pt = r['pattern'];
  const b = r['behavior'];
  const k = r['metabolism'];
  if (![m, pt, b, k].every((v) => typeof v === 'object' && v !== null)) return null;

  const mm = m as Record<string, unknown>;
  const mid = mm['spineSegments'];
  if (!isNum(mid) || mid < 4 || mid > 32) return null;

  const numFields: Array<[Record<string, unknown>, string[]]> = [
    [mm, ['length', 'heightFront', 'heightBack', 'taper', 'dorsalHeight', 'dorsalStart',
          'caudalSpan', 'caudalFork', 'eyeRadius', 'eyePos']],
    [pt as Record<string, unknown>, ['hue', 'hueBelly', 'stripeFreq', 'stripeSharp', 'finAlpha']],
    [b as Record<string, unknown>, ['cruiseSpeed', 'boldness', 'sociability', 'depthPref', 'diet']],
    [k as Record<string, unknown>, ['basal', 'maxEnergy', 'lifespan', 'maturity']],
  ];
  for (const [obj, keys] of numFields) {
    for (const key of keys) if (!isNum(obj[key])) return null;
  }

  const parentsRaw = r['parents'];
  let parents: readonly number[] | null = null;
  if (Array.isArray(parentsRaw) && parentsRaw.length >= 1 && parentsRaw.length <= 2) {
    const ids: number[] = [];
    for (const v of parentsRaw) if (isNum(v)) ids.push(Math.round(v));
    if (ids.length === parentsRaw.length) parents = ids;
  }

  return {
    id,
    parents,
    generation,
    morphology: {
      spineSegments: Math.round(mid),
      length: Math.round(mm['length'] as number),
      heightFront: Math.round(mm['heightFront'] as number),
      heightBack: Math.round(mm['heightBack'] as number),
      taper: Math.round(mm['taper'] as number),
      dorsalHeight: Math.round(mm['dorsalHeight'] as number),
      dorsalStart: Math.round(mm['dorsalStart'] as number),
      caudalSpan: Math.round(mm['caudalSpan'] as number),
      caudalFork: Math.round(mm['caudalFork'] as number),
      eyeRadius: Math.round(mm['eyeRadius'] as number),
      eyePos: Math.round(mm['eyePos'] as number),
    },
    pattern: {
      hue: Math.round((pt as Record<string, number>)['hue'] as number),
      hueBelly: Math.round((pt as Record<string, number>)['hueBelly'] as number),
      stripeFreq: Math.round((pt as Record<string, number>)['stripeFreq'] as number),
      stripeSharp: Math.round((pt as Record<string, number>)['stripeSharp'] as number),
      finAlpha: Math.round((pt as Record<string, number>)['finAlpha'] as number),
    },
    behavior: {
      cruiseSpeed: Math.round((b as Record<string, number>)['cruiseSpeed'] as number),
      boldness: Math.round((b as Record<string, number>)['boldness'] as number),
      sociability: Math.round((b as Record<string, number>)['sociability'] as number),
      depthPref: Math.round((b as Record<string, number>)['depthPref'] as number),
      diet: Math.round((b as Record<string, number>)['diet'] as number),
    },
    metabolism: {
      basal: Math.round((k as Record<string, number>)['basal'] as number),
      maxEnergy: Math.round((k as Record<string, number>)['maxEnergy'] as number),
      lifespan: Math.round((k as Record<string, number>)['lifespan'] as number),
      maturity: Math.round((k as Record<string, number>)['maturity'] as number),
    },
  };
}

/** 紧凑的数值指纹，用于把「这批鱼」折成一个数（自检用）。 */
export function genomePoolHash(genomes: readonly Genome[]): number {
  let h = genomes.length;
  for (const g of genomes) h = hashCombine(h, hashString(genomeFingerprint(g)));
  return h;
}

// ————————————————————————————————————————————————————————————
// 育种算子（P5 会用，P3 先把它们写好并测好）
// ————————————————————————————————————————————————————————————

/** 逐字段在父母之间取值：t=0 全取 a，t=1 全取 b。 */
function blend(a: number, b: number, t: number): number {
  return Math.round(a + (b - a) * t);
}

/**
 * 交叉。
 *
 * 每个字段独立地在父母之间插值，而不是整段继承 —— 后者会让后代
 * 看起来就是父母之一的复制品，进化会变得很无趣。
 * 但**脊柱段数**是结构基因，必须整段继承：它是整数，插值会得到
 * 一个两边都不像的中间值。
 */
export function crossover(
  a: Genome,
  b: Genome,
  rng: Rng,
  id: number,
): Genome {
  const t = () => rng.range(0.15, 0.85);
  const pick = () => (rng.next() < 0.5 ? a : b);

  const ma = a.morphology;
  const mb = b.morphology;
  const structure = pick(); // 结构基因整段继承

  return {
    id,
    parents: [a.id, b.id],
    generation: Math.max(a.generation, b.generation) + 1,
    morphology: {
      // 结构：整段继承，不插值
      spineSegments: structure.morphology.spineSegments,
      taper: blend(ma.taper, mb.taper, t()),
      // 其余按权重混合
      length: blend(ma.length, mb.length, t()),
      heightFront: blend(ma.heightFront, mb.heightFront, t()),
      heightBack: blend(ma.heightBack, mb.heightBack, t()),
      dorsalHeight: blend(ma.dorsalHeight, mb.dorsalHeight, t()),
      dorsalStart: blend(ma.dorsalStart, mb.dorsalStart, t()),
      caudalSpan: blend(ma.caudalSpan, mb.caudalSpan, t()),
      caudalFork: blend(ma.caudalFork, mb.caudalFork, t()),
      eyeRadius: blend(ma.eyeRadius, mb.eyeRadius, t()),
      eyePos: blend(ma.eyePos, mb.eyePos, t()),
    },
    pattern: {
      hue: blend(a.pattern.hue, b.pattern.hue, t()),
      hueBelly: blend(a.pattern.hueBelly, b.pattern.hueBelly, t()),
      stripeFreq: blend(a.pattern.stripeFreq, b.pattern.stripeFreq, t()),
      stripeSharp: blend(a.pattern.stripeSharp, b.pattern.stripeSharp, t()),
      finAlpha: blend(a.pattern.finAlpha, b.pattern.finAlpha, t()),
    },
    behavior: {
      cruiseSpeed: blend(a.behavior.cruiseSpeed, b.behavior.cruiseSpeed, t()),
      boldness: blend(a.behavior.boldness, b.behavior.boldness, t()),
      sociability: blend(a.behavior.sociability, b.behavior.sociability, t()),
      depthPref: blend(a.behavior.depthPref, b.behavior.depthPref, t()),
      diet: blend(a.behavior.diet, b.behavior.diet, t()),
    },
    metabolism: {
      basal: blend(a.metabolism.basal, b.metabolism.basal, t()),
      maxEnergy: blend(a.metabolism.maxEnergy, b.metabolism.maxEnergy, t()),
      lifespan: blend(a.metabolism.lifespan, b.metabolism.lifespan, t()),
      maturity: blend(a.metabolism.maturity, b.metabolism.maturity, t()),
    },
  };
}

/**
 * 变异。
 *
 * 幅度按**相对比例**施加（jitter），而不是绝对加减 —— 否则
 * 「体长 0.08」和「条纹频率 7」会被同样的绝对量扰动，前者没感觉、后者被打乱。
 */
/**
 * 无性繁殖产生一个后代。
 *
 * 与 `mutate` 的区别只有一处：它会**把亲本记上**。
 * 少了这一步谱系就是平的（见 `Genome.parents` 的说明）。
 */
export function asexual(parent: Genome, rng: Rng, rate: number): Genome {
  return { ...mutate(parent, rng, rate), parents: [parent.id] };
}

export function mutate(g: Genome, rng: Rng, rate: number): Genome {
  // ⚠️ 用均匀扰动而不是正态：Rng.gaussian 走 Box-Muller，
  // 也就是 Math.log + Math.cos，而那两个是不可复现的。
  // 变异幅度用哪种分布对结果影响很小，确定性却是硬要求。
  const j = (v: number, amount: number): number => {
    if (rng.next() >= rate) return v;
    return Math.round(v * (1 + rng.range(-amount, amount)));
  };
  const jAbs = (v: number, amount: number, lo: number, hi: number): number => {
    if (rng.next() >= rate) return v;
    return clampFx(Math.round(v + rng.range(-amount, amount)), lo, hi);
  };

  return {
    ...g,
    id: g.id,
    generation: g.generation + 1,
    morphology: {
      ...g.morphology,
      length: j(g.morphology.length, 0.09),
      heightFront: j(g.morphology.heightFront, 0.11),
      heightBack: j(g.morphology.heightBack, 0.11),
      dorsalHeight: j(g.morphology.dorsalHeight, 0.15),
      caudalSpan: j(g.morphology.caudalSpan, 0.13),
      caudalFork: jAbs(g.morphology.caudalFork, 0.05, 0, FX),
      eyeRadius: j(g.morphology.eyeRadius, 0.08),
      // 结构基因的变异是**离散**的：脊柱段数只能整段增减
      spineSegments:
        rng.next() < rate * 0.4
          ? Math.max(8, Math.min(18, g.morphology.spineSegments + (rng.next() < 0.5 ? -1 : 1)))
          : g.morphology.spineSegments,
    },
    pattern: {
      hue: jAbs(g.pattern.hue, 0.06, 0, FX),
      hueBelly: jAbs(g.pattern.hueBelly, 0.06, 0, FX),
      stripeFreq: jAbs(g.pattern.stripeFreq, 0.6, 0, fx(12)),
      stripeSharp: jAbs(g.pattern.stripeSharp, 0.06, 0, FX),
      finAlpha: jAbs(g.pattern.finAlpha, 0.06, 0, FX),
    },
    behavior: {
      cruiseSpeed: j(g.behavior.cruiseSpeed, 0.10),
      boldness: jAbs(g.behavior.boldness, 0.07, 0, FX),
      sociability: jAbs(g.behavior.sociability, 0.07, 0, FX),
      depthPref: jAbs(g.behavior.depthPref, 0.07, 0, FX),
      diet: jAbs(g.behavior.diet, 0.12, 0, fx(2)),
    },
    metabolism: {
      basal: j(g.metabolism.basal, 0.07),
      maxEnergy: j(g.metabolism.maxEnergy, 0.05),
      lifespan: j(g.metabolism.lifespan, 0.08),
      maturity: j(g.metabolism.maturity, 0.10),
    },
  };
}
