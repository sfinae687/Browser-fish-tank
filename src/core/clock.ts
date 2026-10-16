/**
 * 世界时间与昼夜。
 *
 * ⚠️ 这个文件里的每一个函数都**只使用 + − × ÷ 和比较**。
 * 不用 Math.cos/exp/sin —— ECMAScript 规范说它们是 implementation-approximated，
 * 而世界状态要从这个世界时间推导出来，所以它必须跨机器逐位一致。
 * 原来的版本用余弦和指数做昼夜曲线，是在 P1 引入确定性模拟时被换掉的。
 *
 * 所有函数都以「一天之内的毫秒数」为输入，而不是绝对时间戳 ——
 * 这样调用方可以先做整数取模，避免大数相减带来的精度损失。
 *
 * @see core/fixed.ts 顶部的说明
 * @see DESIGN.md §3.1
 */

export const SIM_HZ = 30;
export const SIM_DT_MS = 1000 / SIM_HZ;
export const DAY_MS = 86400000;

/** 默认最多追赶 24 小时。超出部分直接跳帧。 */
export const DEFAULT_MAX_CATCHUP_MS = 24 * 60 * 60 * 1000;

const HOUR = 3600000;
const MIN = 60000;

/**
 * 由「世界纪元 + 已推进步数」求出这一天内的毫秒数。
 *
 * 昼夜必须跟着**真实时间**走，而不是跟着步数走 ——
 * 否则关掉标签页五小时再打开，缸里还是你离开时的天色。
 * 纪元本身存在世界状态里，所以这个推导仍然是可复现的。
 */
export function msOfDay(epochMs: number, tick: number): number {
  const abs = epochMs + tick * SIM_DT_MS;
  const m = abs % DAY_MS;
  return m < 0 ? m + DAY_MS : m;
}

/** 0 → 1 的平滑过渡（smoothstep）。只用 + − ×，跨机器一致。 */
export function ramp(ms: number, start: number, end: number): number {
  if (ms <= start) return 0;
  if (ms >= end) return 1;
  const t = (ms - start) / (end - start);
  return t * t * (3 - 2 * t);
}

/** 中间高、两边为 0 的平滑钟形。用来做「黄昏最暖」这类单峰。 */
export function bell(ms: number, start: number, end: number): number {
  const mid = (start + end) / 2;
  const half = (end - start) / 2;
  if (half <= 0) return 0;
  const d = Math.abs(ms - mid) / half;
  if (d >= 1) return 0;
  const x = 1 - d;
  return x * x * (3 - 2 * x);
}

// ————————————————————————————————————————————————————————————
// 灯与太阳
// ————————————————————————————————————————————————————————————

const SUNRISE = 6 * HOUR + 20 * MIN;
const SUNSET = 19 * HOUR + 40 * MIN;
const SUN_RAMP = 80 * MIN;

const LAMP_ON = 8 * HOUR;
const LAMP_OFF = 22 * HOUR + 30 * MIN;
const LAMP_RAMP = 20 * MIN;

/**
 * 灯带单独亮着时的强度。
 *
 * 夜里**不为零** —— 这是放在室内的鱼缸，不是野外。完全黑掉的鱼缸
 * 既不好看也不真实，而且会让「跟随昼夜」这个特性变成纯粹的惩罚。
 */
const LAMP_POWER = 0.24;

/**
 * 夜光。灯带关掉之后的残余环境光（房间里的其它光源、缸体自身的微光）。
 *
 * 没有它，缸在深夜是**纯黑**的 —— 既不好看，也让「跟随昼夜」变成纯粹的
 * 惩罚。梦幻方向要的是「幽蓝的夜」而不是「什么都看不见」。
 */
const NIGHT_GLOW = 0.075;

/** 自然日照 0..1。 */
export function daylightAt(ms: number): number {
  const rise = ramp(ms, SUNRISE, SUNRISE + SUN_RAMP);
  const fall = 1 - ramp(ms, SUNSET - SUN_RAMP, SUNSET);
  return rise * fall;
}

/** 人工灯带 0..1。 */
export function lampAt(ms: number): number {
  const on = ramp(ms, LAMP_ON, LAMP_ON + LAMP_RAMP);
  const off = 1 - ramp(ms, LAMP_OFF - LAMP_RAMP, LAMP_OFF);
  return on * off;
}

/** 缸内总光照 0..1。世界的光照就是它，渲染也复用它。 */
export function lightAt(ms: number): number {
  const v = NIGHT_GLOW + daylightAt(ms) * (1 - NIGHT_GLOW) + lampAt(ms) * LAMP_POWER;
  return v > 1 ? 1 : v;
}

/** 冷暖轴 −1..1。黄昏最暖，日出次之且偏冷。 */
export function warmthAt(ms: number): number {
  const dusk = bell(ms, SUNSET - 100 * MIN, SUNSET + 30 * MIN);
  const dawn = bell(ms, SUNRISE - 30 * MIN, SUNRISE + 100 * MIN);
  return dusk - dawn * 0.55 + 0.10;
}

/**
 * 光照方向。正午接近垂直，日出日落时低角度斜射。
 * 返回的 y 分量是「高度」，渲染端用它做光柱的方向。
 */
export function lightDirectionAt(ms: number): { x: number; y: number } {
  const span = SUNSET - SUNRISE;
  let t = span > 0 ? (ms - SUNRISE) / span : 0.5;
  if (t < 0) t = 0;
  if (t > 1) t = 1;
  return { x: (t - 0.5) * 1.5, y: 0.28 + 0.72 * daylightAt(ms) };
}

/** 便于人类阅读的时刻（调试与 HUD 用，不参与模拟）。 */
export function formatClock(epochMs: number, tick: number): string {
  const ms = msOfDay(epochMs, tick);
  const h = Math.floor(ms / HOUR);
  const m = Math.floor((ms % HOUR) / MIN);
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
}
