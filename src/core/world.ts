/**
 * 世界状态与推进。
 *
 * ## 纯函数性质
 *
 * `WorldState` 是一份**完整自足**的世界描述。给定同一个状态，
 * `stepWorld` / `advanceWorld` 永远产出同一个结果 —— 没有隐藏输入，
 * 没有 `Date.now()`，没有 `Math.random()`，没有实现相关的数学函数。
 *
 * 这条性质是整个项目的地基（DESIGN.md §0）：
 *
 *   - 任一表面各自算，都能得到逐位一致的世界 ⇒ **不需要仲裁者**
 *   - 关掉标签页一小时再回来，快进的结果和一直开着完全一样
 *   - 一个种子字符串就是这一缸，发给别人能复现
 *
 * ## P1 模拟了什么
 *
 * P1 是**非生物的环境**，外加一个藻类标量。它看起来不多，但这是一个
 * 真正闭合的循环：光照 → 藻类 → 消耗无机盐 → 死亡成碎屑 → 矿化回无机盐，
 * 同时产氧/耗氧、并让水温随光照变化。
 *
 * 这不是占位符 —— 它是 P4 生态的底床。鱼和草在 P3 会读写这里的同一批场，
 * 藻华事件会直接复用这里的 `algae`。之所以 P1 就把它做出来，是因为
 * 一个没有东西可算的内核无法验证，而「确定性」恰恰只能靠算出来验证。
 *
 * @see DESIGN.md §9 P1、§12.6
 */

import { FX, fx, unfx, clampFx } from './fixed.js';
import { SIM_DT_MS, msOfDay, lightAt } from './clock.js';
import { Rng, hashString, hashCombine } from './rng.js';
import { generateSchool, SWIM_BOUNDS, type MotionSeed } from './school.js';
import { FEED_DETRITUS, type Action } from './actions.js';
import {
  crossover,
  generateGenomePool,
  asexual,
  genomeFingerprint,
  sanitizeGenome,
  type Genome,
} from './genome.js';

export const WORLD_VERSION = 1;

/**
 * 环境步进的间隔：每 60 秒世界时间推进一次化学过程。
 *
 * 为什么不每个 tick 都算：水化学的时间尺度是分钟到小时，30 Hz 去算它
 * 既浪费又会因为增量过小被定点量化抹掉（见 SEED_RATE 的说明）。
 * 60 秒是个刚好的粒度 —— 既让所有变化率都远高于量化噪声，又足够快。
 */
export const ENV_INTERVAL_TICKS = 30 * 60;
const ENV_DT = 60; // 秒

/**
 * 一条鱼的完整记录：**运动参数 + 生态状态**。
 *
 * 两层刻意分开：
 *   - 运动参数（home / phase / speedScale…）是**常量**，位置由它们和
 *     世界时间纯函数求出，不做积分（见 school.ts）
 *   - 生态量（能量 / 年龄 / 死后经过的时间）**随世界时间累积**，
 *     跑在分钟级的慢节奏上
 *
 * 这样鱼的位置没有快进问题（重新求值即可），而它们「饿了多久、多大了、
 * 死了多久」这些**真正有意义**的量又确实被记着。P3 那个「不做积分」的
 * 判断，省下来的正是这里的位置状态。
 */
export interface FishRecord extends MotionSeed {
  /**
   * 稳定的个体 id。
   *
   * ⚠️ 不能用数组下标：鱼会出生、会死亡、会被清理，下标随时在变。
   * 玩家的操作（「让这两条杂交」）必须指向一个**不会漂移**的身份。
   */
  id: number;
  /** 能量，0..maxEnergy 的定点 */
  energy: number;
  /** 年龄（秒） */
  age: number;
}

export interface WorldState {
  version: number;
  seed: string;
  /**
   * 纪元：tick 0 对应的真实时间戳（ms）。
   *
   * 它**必须在状态里**。昼夜要跟着真实时间走，而真实时间 = 纪元 + 步数，
   * 所以纪元是状态的必要组成部分。跳帧时它会被平移（见 advanceWorldTo），
   * 于是这个平移也成为可复现状态的一部分。
   */
  epochMs: number;
  tick: number;

  // ——— 以下全部是定点整数，标度 FX ———

  /** 水温，摄氏度 */
  temperature: number;
  /** 溶解无机盐，mg/L */
  nutrients: number;
  /** 藻类生物量 0..1（1 = 满载） */
  algae: number;
  /** 有机碎屑 0..1 */
  detritus: number;
  /** 溶解氧饱和度 0..2 */
  oxygen: number;

  // ——— 生态（P4）———

  /**
   * 基因组池。**它现在是世界状态的一部分** —— 因为繁殖会创造新的基因组。
   * P3 时它是从种子派生的常量，加繁殖之后就不行了。
   */
  genomes: Genome[];
  /** 鱼群。含尸体 —— 尸体要一直留到分解完毕。 */
  fish: FishRecord[];
  /** 累计出生 / 死亡数。种群动态的观测窗口。 */
  births: number;
  deaths: number;
  /** 下一个鱼 id。单调递增，永不复用。 */
  nextFishId: number;
  /**
   * 已应用的最后一条意图记录序号。
   *
   * 它是「玩家操作」与「世界状态」之间的接缝：各表面按这个序号去重，
   * 于是同一条投食不会被应用两次，也不会被漏掉。
   */
  lastActionSeq: number;
}

// ————————————————————————————————————————————————————————————
// 过程参数（全部是「每秒」的速率）
// ————————————————————————————————————————————————————————————

const AMBIENT_C = 21.5;
/** 满光照下的增温。真实家用缸的日摆幅在 1~2°C，不是 7°C。 */
const HEAT_GAIN_C = 2.6;
/**
 * 温度弛豫。时间常数约 2.1 小时。
 *
 * ⚠️ 这个值不能大。第一版用了 18 分钟的时间常数，结果水温跟着灯光
 * 一天摆动 7°C —— 那种缸里什么都活不了。**热惯性是鱼缸最重要的性质之一**：
 * 水比空气难热得多，正是它把昼夜的剧烈变化磨成了缓慢的漂移。
 */
const K_TEMP = 0.00013;

/**
 * 藻类生长。最优条件下约 1.6 小时翻倍 —— 这不是拍脑袋：
 * 真实水体里的藻华就是几小时到一天量级的爆发，慢吞吞地长根本不成华。
 * 第一版用了 17 小时翻倍，7 天里藻类只是缓慢爬升，没有任何涨落。
 */
const GROWTH_MAX = 1.2e-4;
const DIE_MAX = 2.0e-5;
/** 光与营养的半饱和常数（Michaelis–Menten） */
const LIGHT_HALF = 0.22;
const NUT_HALF = 0.12;

/** 单位藻类生物量消耗的无机盐。满载藻华会抽干这几 mg/L。 */
/** 单位藻类生物量消耗的无机盐。满载藻华会抽干这几 mg/L。 */
const N_PER_ALGAE = 2.5;
/**
 * 碎屑矿化。时间常数约 18 小时。
 *
 * 这个值决定了振荡**能不能持续**：矿化太快，无机盐立刻回到水里被仍然
 * 庞大的藻群重新吃掉，藻类就永远不会崩；太慢则营养锁死在碎屑里，
 * 缸会长期贫营养。振荡的机制正是「营养在藻和水之间来回搬运，且搬运有延迟」。
 */
const MINERAL_RATE = 1.5e-5;
/**
 * 底床缓慢释放的无机盐。
 *
 * P1 里这是唯一的营养**来源**（P4 会由投食与鱼的代谢接管）。
 * 它的量级决定了藻华的周期：供给太弱，第一次藻华之后就再也起不来 ——
 * 第一版就是这样，7 天里藻类只涨了一次然后单调衰减。
 */
const N_INPUT = 8.0e-6;
/** 换水与反硝化造成的流失 */
const N_LOSS = 2.0e-6;

/**
 * 「孢子雨」：藻类永远有一个不受自身密度影响的最小补充速率。
 *
 * 这一项不是装饰，是**必需的**。定点量化会把极小的增量抹成 0，
 * 藻类一旦掉到低位就再也长不回来 —— 经典的「取整导致灭绝」。
 * 有它兜底，藻华才能在一次崩溃之后重新起来。
 */
const SEED_RATE = 2.0e-7;

const O2_PER_GROWTH = 1.6;
const O2_RESP = 2.0e-5;
const O2_DECAY = 0.9;

/**
 * 水面与空气的气体交换。
 *
 * ⚠️ 这一项是**必需的**，不是润色。第一版漏了它，把溶氧做成了封闭系统，
 * 于是耗氧项把溶氧从 0.9 单调拖到 0.06 再也回不来 —— 一个 7 天后必然
 * 窒息的缸。真实鱼缸里水面复氧才是溶氧的主导项，生物过程只是扰动它。
 *
 * 时间常数约 12.6 小时。
 */
const O2_SAT = 1.0;
const K_GAS_EXCHANGE = 2.2e-5;

// ————————————————————————————————————————————————————————————
// 生态参数（P4）
// ————————————————————————————————————————————————————————————

/**
 * 藻类中**不可被摄食**的部分（长在石头缝里、附着在玻璃上）。
 *
 * ⚠️ 这一项是必需的，不是润色。没有它，鱼会把藻类吃到零，
 * 然后整个系统在一次崩溃之后再也没法恢复 —— 生产者被彻底消灭了。
 * 有这块避难所，藻类永远能重新长起来，振荡才能持续。
 */
const ALGAE_REFUGE = 0.040;

/** 每条鱼每秒摄食藻类的上限（相对单位/秒），再乘食性系数。 */
/**
 * 摄食速率。
 *
 * ⚠️ 这个量级要和**藻类的增长率**对上，而不是和「鱼能吃多快」对上。
 *
 * 第一版给了 8e-5：9 条鱼的总需求是藻类增长率的 150 倍，于是藻类被死死
 * 压在避难所线上（读数恰好等于 ALGAE_REFUGE），永远攒不起种群 ——
 * 没有「藻类恢复 → 鱼吃饱 → 鱼繁殖 → 藻类被吃光」这个循环，
 * 种群动态就只剩老死的同步崩塌。
 *
 * 现在取的值让总需求略高于藻类的满速增长，于是能形成十几小时一轮的
 * 丰歉节律。
 */
const GRAZE_MAX = 1.5e-6;

/**
 * 摄食的半饱和常数：可摄食藻类降到这个量级时，摄食速率减半。
 * 越小则鱼越能「刮干净」藻类，越不容易形成振荡。
 */
const GRAZE_HALF_SAT = 0.035;

/**
 * 摄入单位藻类获得的能量。
 *
 * 倒推出来的：可摄食的藻类大约 0.2 个单位，如果全被 9 条鱼分掉，
 * 每条约 0.022。要让这点藻类够一条鱼撑小半天，ENERGY_PER_ALGAE 得在 50 上下。
 */
const ENERGY_PER_ALGAE = 58;

/**
 * 代谢的温度系数：以 22°C 为基准，每升高 6°C 代谢翻一倍。
 *
 * 鱼是变温动物，这条关系是它们生活史里最基本的一条 ——
 * 水温高就吃得多、也饿得快。
 */
const METABOLIC_Q10_SPAN = 6;

/** 摄入能量中随排泄回到水体的比例。这是鱼缸里无机盐的**主要来源**。 */
const WASTE_FRACTION = 0.34;
/** 单位排泄能量折算成多少 mg/L 的无机盐。 */
const NUTRIENT_PER_WASTE = 0.0009;

/** 能量高于上限的这个比例才会繁殖；生育消耗掉当前能量的这个比例。 */
const REPRO_ENERGY_RATIO = 0.72;
const REPRO_COST_RATIO = 0.38;

/**
 * 承载上限。
 *
 * 这不是「性能保护」而已 —— 它同时是**生态学上的承载力**：
 * 缸就那么大，空间和氧气都是有限的，种群不可能无限增长。
 * 到顶之后鱼仍然会饿死、会老死，只是不再有新个体。
 */
const MAX_FISH = 34;
const MAX_GENOMES = 56;

/** 尸体从死亡到完全分解的时长（秒）。 */
const DECAY_SECONDS = 22 * 60;
/** 尸体分解每秒释放的碎屑量。 */
const DECAY_DETRITUS = 6.0e-6;

// ————————————————————————————————————————————————————————————
// 建立与推进
// ————————————————————————————————————————————————————————————

/**
 * 建立一个新世界。
 *
 * 初值来自 `world.init` 子流 —— 不同种子会从不同的水温、营养水平和
 * 初始藻量起步，于是同一套参数会长出脾气不同的缸。
 */
export function createWorld(seed: string, epochMs: number): WorldState {
  const rng = Rng.fromSeed(seed).stream('world.init');

  // 初始种群：几个基因组、一小群鱼。
  // 数量刻意留有余量 —— 开缸时不该是满载的，要留给繁殖。
  const genomes = generateGenomePool(seed, 5);
  const motion = generateSchool(seed, genomes, 9);
  const fish: FishRecord[] = motion.map((m, i) => ({
    ...m,
    id: i,
    energy: fx(0.55 + 0.25 * ((i * 7) % 5) / 5),
    age: Math.round(3600 * (0.2 + 0.5 * ((i * 3) % 7) / 7)),
  }));

  return {
    version: WORLD_VERSION,
    seed,
    epochMs,
    tick: 0,
    temperature: fx(rng.range(23.0, 25.5)),
    nutrients: fx(rng.range(0.30, 1.10)),
    // 起始藻量给得高一些：一个已经养熟的缸本来就有藻，
    // 而不是一个光秃秃的新缸。给 0.06 以下的话，鱼一开始就没有东西可吃。
    algae: fx(rng.range(0.10, 0.22)),
    detritus: fx(rng.range(0.02, 0.09)),
    oxygen: fx(rng.range(0.85, 1.05)),
    genomes,
    fish,
    births: 0,
    deaths: 0,
    nextFishId: fish.length,
    lastActionSeq: 0,
  };
}

/**
 * 推进一格。
 *
 * 逐 tick 调用（渲染循环走这条路径），但只有一个 tick 上真正会做事。
 */
export function stepWorld(state: WorldState, tick: number): void {
  state.tick = tick;
  if (tick > 0 && tick % ENV_INTERVAL_TICKS === 0) {
    stepEnvironment(state, ENV_DT);
    stepEcology(state, ENV_DT);
  }
}

/**
 * 批量推进到指定的步数。
 *
 * 存在的理由是性能：关掉标签页一天再回来差着 260 万个 tick，
 * 逐个调用 `stepWorld` 会卡住整个渲染帧。这里直接算出中间应该发生
 * 多少次环境步进，把复杂度从 O(tick) 降到 O(分钟)。
 *
 * 它和逐 tick 推进**必须得到完全一致的结果** —— 两条路径在生产里都会走到
 * （刚打开时批量追赶，之后逐帧单步），一旦不一致就会表现为
 * 「世界偶尔会跳变」这种极难复现的 bug。runner 在启动时会做一次自检，
 * `tools/test.mjs` 里有更严格的断言。
 *
 * @returns 实际执行的环境步数
 */
export function advanceWorld(
  state: WorldState,
  toTick: number,
  actions: readonly Action[] = [],
): number {
  if (toTick <= state.tick) return 0;

  const fromStep = Math.floor(state.tick / ENV_INTERVAL_TICKS);
  const toStep = Math.floor(toTick / ENV_INTERVAL_TICKS);

  let steps = 0;
  for (let s = fromStep + 1; s <= toStep; s++) {
    const tick = s * ENV_INTERVAL_TICKS;
    // 动作要在**它发生的那个时刻**生效，而不是「读到它的那个时刻」。
    // 否则关掉标签页三天再回来，这三天里的投食会全部挤在恢复的那一瞬间。
    applyDueActions(state, actions, tick);
    state.tick = tick;
    stepEnvironment(state, ENV_DT);
    stepEcology(state, ENV_DT);
    steps++;
  }

  state.tick = toTick;
  // 最后一个环境步之后的动作也要处理（它们在 toTick 之前发生了）
  applyDueActions(state, actions, toTick);
  return steps;
}

/**
 * 应用所有「到这一步为止应该已经发生」的玩家操作。
 *
 * 按时间顺序遍历，遇到第一个尚未到时的就停下 —— 日志已按 (atMs, seq) 排序，
 * 后面的只会更晚。**不能 continue**：那样会让一条晚到的记录抢在
 * 一条早到的记录之前生效，玩家的操作顺序就被打乱了。
 */
function applyDueActions(state: WorldState, actions: readonly Action[], tick: number): void {
  if (actions.length === 0) return;

  let applied = 0;
  for (const a of actions) {
    if (a.seq <= state.lastActionSeq) continue;
    const atTick = Math.floor((a.atMs - state.epochMs) / SIM_DT_MS);
    if (atTick > tick) break;

    applyAction(state, a);
    state.lastActionSeq = a.seq;
    applied++;
    // 一次涌入太多操作（比如日志积压）不该把这一帧卡死；
    // 剩下的会在下一步继续被处理，因为它们仍然满足 seq > lastActionSeq。
    if (applied >= 8) break;
  }
}

/**
 * 把世界推进到「真实时间 `nowMs` 对应的步数」。
 *
 * 超过追赶上限时**不是简单地少跑几步** —— 那会让世界凭空倒退。
 * 而是把纪元向前平移，让步号保持连续，只是中间少发生了一些事。
 * 语义上等同于「这段时间没人看，世界快速演化过去了」，而且因为纪元
 * 在状态里，两个表面做同样的平移会得到同样的结果。
 *
 * @returns 实际推进的步数
 */
export function advanceWorldTo(
  state: WorldState,
  nowMs: number,
  maxCatchupMs: number,
  actions: readonly Action[] = [],
): number {
  const targetTick = Math.floor((nowMs - state.epochMs) / SIM_DT_MS);
  let due = targetTick - state.tick;
  if (due <= 0) return 0;

  const maxTicks = Math.max(1, Math.floor(maxCatchupMs / SIM_DT_MS));
  if (due > maxTicks) {
    const skipped = due - maxTicks;
    // 取整是为了让纪元始终是整数，哈希与比较因此保持干净
    state.epochMs = Math.round(state.epochMs + skipped * SIM_DT_MS);
    due = maxTicks;
  }

  advanceWorld(state, state.tick + due, actions);
  return due;
}

// ————————————————————————————————————————————————————————————
// 环境动力学
// ————————————————————————————————————————————————————————————

/**
 * 一步环境演化。
 *
 * 全程用浮点做中间计算（+ − × ÷ 在 IEEE-754 下是正确舍入的，跨机器一致），
 * 最后量化回定点整数。这样极小的变化率不会因为精度不足被抹掉。
 */
function stepEnvironment(state: WorldState, dt: number): void {
  const light = lightAt(msOfDay(state.epochMs, state.tick));

  const temp = unfx(state.temperature);
  const nut = unfx(state.nutrients);
  const algae = unfx(state.algae);
  const det = unfx(state.detritus);
  const oxy = unfx(state.oxygen);

  // ——— 温度：向「环境温度 + 光照增温」一阶逼近 ———
  const target = AMBIENT_C + light * HEAT_GAIN_C;
  const nextTemp = temp + (target - temp) * K_TEMP * dt;

  // ——— 光照与营养的双重限制（Liebig 最小律）：谁少就以谁为准 ———
  const lightLim = light / (light + LIGHT_HALF);
  const nutLim = nut / (nut + NUT_HALF);
  const limit = Math.min(lightLim, nutLim);

  // ——— 藻类：受空间限制的逻辑斯蒂增长 + 本底播种 ———
  const growth = (GROWTH_MAX * algae * (1 - algae) * limit + SEED_RATE * (1 - algae)) * dt;
  const death = DIE_MAX * algae * dt;

  // ——— 营养循环 ———
  const consumed = growth * N_PER_ALGAE;
  const mineralized = det * MINERAL_RATE * dt;
  const input = N_INPUT * dt;
  const loss = nut * N_LOSS * dt;

  // ——— 溶解氧：光合产氧 − 藻类呼吸 − 分解耗氧 + 水面复氧 ———
  const dO2 =
    growth * O2_PER_GROWTH -
    algae * O2_RESP * dt -
    mineralized * O2_DECAY +
    (O2_SAT - oxy) * K_GAS_EXCHANGE * dt;

  state.temperature = fx(nextTemp);
  state.algae = clampFx(fx(algae + growth - death), 0, FX);
  state.nutrients = clampFx(fx(nut - consumed + mineralized + input - loss), 0, fx(20));
  state.detritus = clampFx(fx(det + death - mineralized), 0, FX);
  state.oxygen = clampFx(fx(oxy + dO2), 0, fx(2.4));
}

// ————————————————————————————————————————————————————————————
// 生态（P4）
// ————————————————————————————————————————————————————————————

/**
 * 一步生态演化。跑在和环境一样的分钟级节奏上。
 *
 * 这一步把藻类、无机盐、碎屑与鱼串成一个闭环：
 *
 *     光 → 藻类 ──被吃──→ 鱼 ──排泄──→ 无机盐
 *            ↑                 │              │
 *            └──── 矿化 ←── 碎屑 ←── 死亡/分解 ┘
 *
 * 顺序很重要：**先算摄食需求、再按供给分配**。逐条鱼独立地「能吃到多少就吃多少」
 * 会让先遍历到的鱼占尽便宜，鱼群变成按数组下标排序的等级制。
 */
function stepEcology(state: WorldState, dt: number): void {
  const tempC = unfx(state.temperature);
  // 变温动物：水温越高代谢越快。22°C 为 1，每高出 METABOLIC_Q10_SPAN 度翻一倍。
  const tempFactor = Math.max(0.25, 1 + (tempC - 22) / METABOLIC_Q10_SPAN);

  const algae = unfx(state.algae);
  const grazable = Math.max(0, algae - ALGAE_REFUGE);

  const living = state.fish.length;

  // ——— 1. 总需求 ———
  //
  // ⚠️ 摄食效率要随藻类密度下降 —— 也就是「搜寻时间」。
  //
  // 没有这一项时，藻类会被死死压在避难所线上：鱼永远能把每一分增长
  // 立刻吃光，因为「吃」的速率与藻类有多少无关。读数上表现为藻类
  // 恰好等于 ALGAE_REFUGE，而且纹丝不动。
  //
  // 加上之后就有了 Holling II 型功能反应：藻类稀疏 → 鱼花更多时间找 →
  // 摄食速率下降 → 藻类得以恢复 → 鱼吃饱繁殖 → 藻类被吃光。
  // **这正是振荡的来源**，也是捕食者-猎物模型里最关键的一项。
  const searchFactor = grazable / (grazable + GRAZE_HALF_SAT);

  let demand = 0;
  for (const f of state.fish) {
    if (f.decay > 0) continue;
    const g = state.genomes[f.genome];
    if (!g) continue;
    demand += GRAZE_MAX * herbivory(g) * tempFactor * searchFactor;
  }

  // ——— 2. 按供给分配 ———
  // 藻类不够时所有鱼等比例地少吃，而不是先到先得
  const supply = Math.min(demand * dt, grazable);
  const share = demand * dt > 0 ? supply / (demand * dt) : 0;

  let eatenTotal = 0;
  const newborns: FishRecord[] = [];

  // ——— 3. 逐条鱼 ———
  for (let i = 0; i < state.fish.length; i++) {
    const f = state.fish[i] as FishRecord;
    const g = state.genomes[f.genome];
    if (!g) continue;

    if (f.decay > 0) continue; // 尸体在这一步的末尾统一处理

    const eaten = GRAZE_MAX * herbivory(g) * tempFactor * share * dt;
    eatenTotal += eaten;

    f.age += dt;
    // ⚠️ 定点与实数的边界必须一次划清楚。
    //
    // `g.metabolism.basal` **已经是定点整数**了，所以
    //   basal(FX) × tempFactor(无量纲) × dt(秒) → 仍然是 FX
    // 再套一层 fx() 就等于把消耗放大了 10^6 倍 —— 鱼在一步之内饿死。
    // 第一版就是这么写的，症状是「9 条鱼第一天全部死光、一次繁殖都没有」。
    //
    // 规则：**从实数进入定点用 fx()，定点与定点相乘不要用**。
    const drain = Math.round(g.metabolism.basal * tempFactor * dt);
    f.energy = f.energy + fx(eaten * ENERGY_PER_ALGAE) - drain;
    // 能量必须封顶。不封顶的话一条吃到饱的鱼能攒到上限的好几倍，
    // 一次繁殖就能把所有后代喂饱，种群会炸。上限也是「饱了就不吃」的实现。
    if (f.energy > g.metabolism.maxEnergy) f.energy = g.metabolism.maxEnergy;

    // ——— 繁殖 ———
    if (
      f.energy > g.metabolism.maxEnergy * REPRO_ENERGY_RATIO &&
      f.age > g.metabolism.maturity &&
      living + newborns.length < MAX_FISH &&
      state.genomes.length < MAX_GENOMES
    ) {
      const cost = Math.round(f.energy * REPRO_COST_RATIO);
      f.energy -= cost;
      const child = spawnJuvenile(state, i, cost * 0.45);
      if (child) {
        newborns.push(child);
        state.births++;
      }
    }

    // ——— 死亡 ———
    // 饿死或寿终。两者都走同一条路：变成一具会下沉、会分解的尸体。
    if (f.energy <= 0 || f.age > g.metabolism.lifespan) {
      f.energy = 0;
      f.decay = 1;
      f.deathAt = state.tick / 30;
      state.deaths++;
    }
  }

  // ——— 4. 摄食从藻类里扣掉 ———
  state.algae = clampFx(state.algae - fx(eatenTotal), 0, FX);

  // ——— 5. 排泄把能量还给水体 ———
  // 这是鱼缸里无机盐的主要来源 —— 少了它，鱼只是单向的消费者，
  // 营养循环走不通，系统会慢慢贫瘠下去。
  state.nutrients = clampFx(
    state.nutrients + fx(eatenTotal * ENERGY_PER_ALGAE * WASTE_FRACTION * NUTRIENT_PER_WASTE),
    0,
    fx(20),
  );

  // ——— 6. 尸体分解 ———
  let decayDetritus = 0;
  for (const f of state.fish) {
    if (f.decay <= 0) continue;
    f.decay += dt;
    if (f.decay <= DECAY_SECONDS) decayDetritus += DECAY_DETRITUS * dt;
  }
  if (decayDetritus > 0) {
    state.detritus = clampFx(state.detritus + fx(decayDetritus), 0, FX);
  }

  // ——— 7. 清理与新生的加进来 ———
  // 清理放在最后、且是一次性的 filter：在遍历中删元素会让下标错位，
  // 那是这类模拟里最容易出的隐蔽 bug。
  if (state.fish.some((f) => f.decay > DECAY_SECONDS)) {
    state.fish = state.fish.filter((f) => f.decay <= DECAY_SECONDS);
  }
  for (const c of newborns) state.fish.push(c);

  // ——— 8. 回收基因池 ———
  sweepGenomes(state);
}

/**
 * 回收没有任何鱼在用的基因组。
 *
 * ⚠️ 没有这一步，基因池会**单向增长直到撞上上限，然后繁殖被永久阻断**。
 * 第一版就是这样：池子在第 7 天填满 56，之后一条新鱼都生不出来，
 * 剩下的鱼老死之后整个种群灭绝 —— 而且看起来像「生态崩溃」，
 * 完全不像是一个数组清理的疏漏。
 *
 * 只在池子偏满时才做（避免每步都重建），但**阈值不影响结果的可复现性**：
 * 是否触发只取决于世界状态本身。
 */
function sweepGenomes(state: WorldState): void {
  if (state.genomes.length < MAX_GENOMES * 0.7) return;

  const used = new Uint8Array(state.genomes.length);
  for (const f of state.fish) {
    if (f.genome >= 0 && f.genome < used.length) used[f.genome] = 1;
  }

  let liveCount = 0;
  for (let i = 0; i < used.length; i++) liveCount += used[i] as number;
  if (liveCount === state.genomes.length) return; // 全都还在用，没什么可回收

  // 压缩并建立「旧下标 → 新下标」的映射
  const remap = new Int32Array(state.genomes.length).fill(-1);
  const kept: Genome[] = [];
  for (let i = 0; i < state.genomes.length; i++) {
    if (!used[i]) continue;
    remap[i] = kept.length;
    kept.push(state.genomes[i] as Genome);
  }
  // id 跟随新下标：它是基因组在这个池子里的身份，池子压缩了它就该跟着变。
  // （P5 的谱系需要稳定的 id，那时会换成不回收的方案。）
  state.genomes = kept.map((g, i) => ({ ...g, id: i }));
  for (const f of state.fish) f.genome = remap[f.genome] as number;
  state.fish = state.fish.filter((f) => f.genome >= 0);
}

/** 食性 → 摄食藻类的效率。草食的高，肉食的低。 */
function herbivory(g: Genome): number {
  return 1 - Math.min(0.85, unfx(g.behavior.diet) * 0.42);
}

/**
 * 生一条幼鱼。
 *
 * 随机性来自 `(种子, 步号, 父本下标)` 派生的子流 —— **不需要把 RNG 状态
 * 存进世界**，同时又完全可复现。两个同种子同历史的世界会在同一时刻
 * 生出同样的幼鱼。
 *
 * P4 先做无性繁殖 + 变异。P5 会换成两条鱼的交叉，那时 `parents`
 * 才会真正被填上。
 */
function spawnJuvenile(
  state: WorldState,
  parentIndex: number,
  /** 幼鱼带走的能量，**已经是定点**（父本能量的一个比例） */
  energyFx: number,
): FishRecord | null {
  const parent = state.fish[parentIndex] as FishRecord;
  const parentGenome = state.genomes[parent.genome];
  if (!parentGenome) return null;

  const rng = Rng.fromSeed(state.seed).stream(`fauna.birth/${state.tick}/${parentIndex}`);

  const genomeIndex = state.genomes.length;
  const childGenome: Genome = {
    ...asexual(parentGenome, rng.stream('genome'), 0.5),
    id: genomeIndex,
  };
  state.genomes.push(childGenome);

  // ⚠️ 定点与实数的边界：`parent.homeX` 是定点，`rng.range` 返回实数，
  // 直接相加会得到非整数的 homeX，于是内存态与「序列化→sanitize→恢复」
  // 之后的世界指纹不一致。快照往返测试正是被这个抓住的。
  // 规则：**实数进定点要 fx()，定点之间运算不要**。
  return makeFishRecord(state, childGenome, rng, parent.homeX, parent.homeY, energyFx);
}

// ————————————————————————————————————————————————————————————
// 玩家操作
// ————————————————————————————————————————————————————————————

/** 按 id 找一条活着的鱼。返回下标，找不到返回 -1。 */
export function findFishIndex(state: WorldState, id: number): number {
  for (let i = 0; i < state.fish.length; i++) {
    const f = state.fish[i] as FishRecord;
    if (f.id === id && f.decay <= 0) return i;
  }
  return -1;
}

/**
 * 应用一条玩家操作。
 *
 * ⚠️ 这里**只依赖世界状态**，不读时钟、不读界面。
 * 因为同一条记录会在不同时间、不同表面上被重放 —— 只要世界状态一样，
 * 结果就必须一样。
 */
function applyAction(state: WorldState, a: Action): void {
  if (a.kind === 'feed') {
    // 投食：把能量以外源的形式倒进系统。
    //
    // P4 的生态会收敛到稳定平衡，**真正的藻华需要外部扰动** ——
    // 这一行就是那个扰动源。投下去的营养会先喂藻类，藻类再喂鱼。
    state.nutrients = clampFx(state.nutrients + (a.amount ?? 0), 0, fx(20));
    state.detritus = clampFx(state.detritus + FEED_DETRITUS, 0, FX);
    return;
  }

  if (a.kind === 'breed') {
    const ia = findFishIndex(state, a.parentA ?? -1);
    const ib = findFishIndex(state, a.parentB ?? -1);
    // 亲本可能在这条记录被重放之前就已经死了。静默失败是**正确**的行为：
    // 一次排队的繁殖请求遇到亲本死亡，本来就该失败。
    if (ia < 0 || ib < 0 || ia === ib) return;
    if (state.fish.length >= MAX_FISH) return;

    const pa = state.fish[ia] as FishRecord;
    const pb = state.fish[ib] as FishRecord;
    const ga = state.genomes[pa.genome];
    const gb = state.genomes[pb.genome];
    if (!ga || !gb) return;
    if (state.genomes.length >= MAX_GENOMES) return;

    // 随机性来自记录序号 —— 同一条记录在任何机器上重放都得到同一个后代
    const rng = Rng.fromSeed(state.seed).stream(`fauna.cross/${state.tick}/${a.seq}`);
    const genomeIndex = state.genomes.length;
    const child: Genome = { ...crossover(ga, gb, rng.stream('genome'), genomeIndex), id: genomeIndex };
    state.genomes.push(child);

    const childRecord = makeFishRecord(
      state,
      child,
      rng,
      (pa.homeX + pb.homeX) * 0.5,
      (pa.homeY + pb.homeY) * 0.5,
      // 玩家亲手繁育的后代给一份不错的起始能量 —— 这是「精心照料」的回报
      Math.round(child.metabolism.maxEnergy * 0.5),
    );
    state.fish.push(childRecord);
    state.births++;
  }
}

/**
 * 造一条新鱼的记录。出生、繁殖、杂交都走这里，避免三处各写一遍
 * 而漏掉某个字段（比如 radius —— 漏了它鱼会互相穿插）。
 */
function makeFishRecord(
  state: WorldState,
  childGenome: Genome,
  rng: Rng,
  nearX: number,
  nearY: number,
  energyFx: number,
): FishRecord {
  const record: FishRecord = {
    id: state.nextFishId++,
    genome: childGenome.id,
    homeX: clampFx(
      Math.round(nearX + fx(rng.range(-0.06, 0.06))),
      fx(SWIM_BOUNDS.minX),
      fx(SWIM_BOUNDS.maxX),
    ),
    homeY: clampFx(
      Math.round(nearY + fx(rng.range(-0.05, 0.05))),
      fx(SWIM_BOUNDS.minY),
      fx(SWIM_BOUNDS.maxY),
    ),
    phase: fx(rng.range(0, 1)),
    speedScale: fx(rng.range(0.75, 1.3)),
    wanderAmp: fx(rng.range(0.035, 0.1)),
    spacing: fx(rng.range(0.7, 1.3)),
    radius: Math.round(childGenome.morphology.length * 0.42),
    decay: 0,
    deathAt: -1,
    energy: Math.round(energyFx),
    age: 0,
  };
  return record;
}

// ————————————————————————————————————————————————————————————
// 指纹与视图
// ————————————————————————————————————————————————————————————

/**
 * 状态的数值指纹。用于运行时的分叉自检。
 *
 * 32 位，理论上会碰撞，所以测试脚本用 worldFingerprint（精确字符串）。
 * 运行时自检只需要「大概率」发现分叉，用一个整数更省。
 */
export function worldHash(s: WorldState): number {
  return hashCombine(
    s.tick | 0,
    Math.floor(s.tick / 4294967296) | 0,
    s.epochMs | 0,
    Math.floor(s.epochMs / 4294967296) | 0,
    s.temperature,
    s.nutrients,
    s.algae,
    s.detritus,
    s.oxygen,
    s.version,
    hashString(s.seed),
  ) ^ fishHash(s);
}

/**
 * 鱼与基因组的哈希。
 *
 * 鱼是**变长数组**，所以逐条折叠；每条只取真正影响未来的量。
 * 位置不在里面 —— 它是世界时间的纯函数，由运动参数决定，不随历史累积。
 */
function fishHash(s: WorldState): number {
  let h = hashCombine(s.fish.length, s.genomes.length);
  for (const f of s.fish) {
    h = hashCombine(h, f.id, f.genome, f.energy, f.age, Math.round(f.decay), f.homeX, f.homeY);
  }
  for (const g of s.genomes) h = hashCombine(h, hashString(genomeFingerprint(g)));
  return h;
}

/** 精确指纹。逐字段拼接，不存在碰撞。测试与快照完整性校验用。 */
export function worldFingerprint(s: WorldState): string {
  const parts = [
    s.version,
    s.seed,
    s.epochMs,
    s.tick,
    s.temperature,
    s.nutrients,
    s.algae,
    s.detritus,
    s.oxygen,
    `fish:${s.fish.length}`,
    `genomes:${s.genomes.length}`,
    `nextFishId:${s.nextFishId}`,
    `lastActionSeq:${s.lastActionSeq}`,
  ];
  for (const f of s.fish) {
    parts.push(`${f.id}:${f.genome}:${f.energy}:${f.age}:${f.decay}:${f.homeX}:${f.homeY}:${f.phase}`);
  }
  for (const g of s.genomes) parts.push(genomeFingerprint(g));
  return parts.join('|');
}

export function worldEquals(a: WorldState, b: WorldState): boolean {
  return worldFingerprint(a) === worldFingerprint(b);
}

/** 深拷贝。自检要在副本上跑，不能污染真身。 */
export function cloneWorld(s: WorldState): WorldState {
  // 浅拷贝不够了：鱼和基因组都是变长数组，自检要在副本上推进，
  // 共享数组会让「副本」和「真身」一起变，自检就失去意义。
  return {
    ...s,
    fish: s.fish.map((f) => ({ ...f })),
    genomes: s.genomes.map((g) => ({
      ...g,
      morphology: { ...g.morphology },
      pattern: { ...g.pattern },
      behavior: { ...g.behavior },
      metabolism: { ...g.metabolism },
    })),
  };
}

/** 渲染与 HUD 用的只读视图。 */
export interface EnvView {
  tick: number;
  elapsedSeconds: number;
  /** 世界内的时刻 HH:MM */
  clock: string;
  /** 0..1 */
  light: number;
  /** 摄氏度 */
  temperatureC: number;
  /** mg/L */
  nutrients: number;
  /** 0..1 */
  algae: number;
  /** 0..1 */
  detritus: number;
  /** 溶解氧饱和度 0..2 */
  oxygen: number;
  /** 归一化水温 0..1，供着色器做冷暖偏移 */
  heat: number;

  // ——— 生态（P4）———
  /** 活着的鱼数 */
  population: number;
  /** 正在分解的尸体数 */
  corpses: number;
  /** 平均能量 0..1 */
  meanEnergy: number;
  /** 基因组池大小 */
  genePool: number;
  /** 累计出生与死亡（用于 HUD 与观察种群动态） */
  births: number;
  deaths: number;
}

export function envView(s: WorldState): EnvView {
  const tempC = unfx(s.temperature);
  let alive = 0;
  let corpses = 0;
  let energySum = 0;
  for (const f of s.fish) {
    if (f.decay > 0) {
      corpses++;
      continue;
    }
    alive++;
    const g = s.genomes[f.genome];
    const max = g ? g.metabolism.maxEnergy : FX;
    energySum += max > 0 ? f.energy / max : 0;
  }
  return {
    tick: s.tick,
    elapsedSeconds: s.tick / 30,
    clock: formatWorldClock(s),
    light: lightAt(msOfDay(s.epochMs, s.tick)),
    temperatureC: tempC,
    nutrients: unfx(s.nutrients),
    algae: unfx(s.algae),
    detritus: unfx(s.detritus),
    oxygen: unfx(s.oxygen),
    // 22°C 映射到 0，28°C 映射到 1 —— 家用鱼缸的实际区间
    heat: Math.min(1, Math.max(0, (tempC - 22) / 6)),
    population: alive,
    corpses,
    meanEnergy: alive > 0 ? energySum / alive : 0,
    genePool: s.genomes.length,
    births: s.births,
    deaths: s.deaths,
  };
}

function formatWorldClock(s: WorldState): string {
  const ms = msOfDay(s.epochMs, s.tick);
  const h = Math.floor(ms / 3600000);
  const m = Math.floor((ms % 3600000) / 60000);
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
}

/**
 * 校验从存储里读回来的东西是不是一个合法的世界。
 *
 * 存储里的数据可能是旧版本、被手改过、或者写到一半被打断的。
 * 宁可退回一个全新的世界，也不要让一个 NaN 污染整个模拟。
 */
export function sanitizeWorld(raw: unknown): WorldState | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const r = raw as Record<string, unknown>;

  // 逐个字段取成局部变量。TS 的类型守卫对「循环里检查索引签名」不会
  // 产生收窄效果，写成循环既过不了类型检查，可读性也更差。
  const version = r['version'];
  const seed = r['seed'];
  const epochMs = r['epochMs'];
  const tick = r['tick'];
  const temperature = r['temperature'];
  const nutrients = r['nutrients'];
  const algae = r['algae'];
  const detritus = r['detritus'];
  const oxygen = r['oxygen'];
  const nextFishId = r['nextFishId'];
  const lastActionSeq = r['lastActionSeq'];

  const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

  if (version !== WORLD_VERSION) return null;
  if (typeof seed !== 'string' || seed.length === 0) return null;
  if (!isNum(epochMs) || !isNum(tick) || tick < 0) return null;
  if (
    !isNum(temperature) ||
    !isNum(nutrients) ||
    !isNum(algae) ||
    !isNum(detritus) ||
    !isNum(oxygen)
  ) {
    return null;
  }

  // ——— 基因组池 ———
  const rawGenomes = r['genomes'];
  if (!Array.isArray(rawGenomes) || rawGenomes.length === 0 || rawGenomes.length > MAX_GENOMES) {
    return null;
  }
  const genomes: Genome[] = [];
  for (const raw of rawGenomes) {
    const g = sanitizeGenome(raw);
    if (!g) return null; // 任何一个基因组坏掉，整份快照作废
    genomes.push(g);
  }

  // ——— 鱼群 ———
  const rawFish = r['fish'];
  if (!Array.isArray(rawFish) || rawFish.length > MAX_FISH) return null;
  const fish: FishRecord[] = [];
  const motionKeys = [
    'id', 'homeX', 'homeY', 'phase', 'speedScale', 'wanderAmp', 'spacing', 'radius',
    'decay', 'deathAt', 'energy', 'age',
  ] as const;
  for (const raw of rawFish) {
    if (typeof raw !== 'object' || raw === null) return null;
    const fr = raw as Record<string, unknown>;
    const gi = fr['genome'];
    if (!isNum(gi) || gi < 0 || gi >= genomes.length) return null;
    let ok = true;
    for (const key of motionKeys) if (!isNum(fr[key])) ok = false;
    if (!ok) return null;
    const at = (key: string): number => Math.round(fr[key] as number);
    fish.push({
      id: at('id'),
      genome: Math.round(gi),
      homeX: at('homeX'), homeY: at('homeY'), phase: at('phase'),
      speedScale: at('speedScale'), wanderAmp: at('wanderAmp'), spacing: at('spacing'),
      radius: at('radius'), decay: at('decay'), deathAt: at('deathAt'),
      energy: at('energy'), age: at('age'),
    });
  }

  return {
    version: WORLD_VERSION,
    seed,
    epochMs: Math.round(epochMs),
    tick: Math.round(tick),
    temperature: Math.round(temperature),
    nutrients: Math.round(nutrients),
    algae: Math.round(algae),
    detritus: Math.round(detritus),
    oxygen: Math.round(oxygen),
    genomes,
    fish,
    births: 0,
    deaths: 0,
    nextFishId: isNum(nextFishId) ? Math.round(nextFishId) : fish.length,
    lastActionSeq: isNum(lastActionSeq) ? Math.round(lastActionSeq) : 0,
  };
}
