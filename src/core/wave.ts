/**
 * 确定性的周期函数。
 *
 * 鱼的游动是一条沿脊柱传播的行波：`sin(k·i − ω·t)`。第一反应当然是 `Math.sin`，
 * 但 ECMAScript 规范明说它是 *implementation-approximated* —— 而摆尾幅度是
 * 「同种子 → 同一缸」的一部分（同一个种子长出的鱼必须摆出同样的波形）。
 * 所以它和 `clock.ts` 的昼夜曲线、`flora.ts` 的形态一样，不能用三角函数。
 *
 * 这里用**只用 + − × ÷ 构造的平滑周期函数**：三角波再用 smoothstep 抹圆。
 * 它不是正弦，但对摆尾完全够用 —— 需要的性质是「平滑、周期为 1、
 * 取值 −1..1、拐点处导数为零」，而不是某个特定的解析形状。
 */

/** 平滑三角波。phase 取任意实数，返回 −1..1。 */
export function wave01(phase: number): number {
  const t = phase - Math.floor(phase); // 归约到 [0,1)
  // 三段：0 → 1 → −1 → 0。折点用 smoothstep 抹圆，
  // smoothstep 在两端导数为零，所以拼接处天然 C1 连续，不会出现折角。
  if (t < 0.25) return smoothstep01(t / 0.25);
  if (t < 0.75) return 1 - 2 * smoothstep01((t - 0.25) / 0.5);
  return -1 + smoothstep01((t - 0.75) / 0.25);
}

/** 同上，但输入输出都是定点。 */
export function waveFx(phaseFx: number, fxScale: number): number {
  return Math.round(wave01(phaseFx / fxScale) * fxScale);
}

/** 0..1 的平滑过渡。 */
export function smoothstep01(t: number): number {
  const x = t < 0 ? 0 : t > 1 ? 1 : t;
  return x * x * (3 - 2 * x);
}

/**
 * 平滑的「钟形」脉冲，中心在 center、半宽 width。
 * 用于沿脊柱定位背鳍、眼睛这类局部特征。
 */
export function pulse(t: number, center: number, width: number): number {
  const d = Math.abs(t - center) / width;
  if (d >= 1) return 0;
  return smoothstep01(1 - d);
}
