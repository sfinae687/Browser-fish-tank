/**
 * 定点算术。
 *
 * ## 为什么模拟状态要用整数
 *
 * 项目的地基是「同种子 + 同一段时间 ⇒ 逐位一致的世界」。要守住这条，
 * 必须搞清楚 JS 里哪些运算是**可复现**的：
 *
 *   可复现   + − × ÷、Math.floor/round/min/max、比较
 *           —— IEEE-754 双精度要求这些是「正确舍入」的，跨机器跨版本必然一致
 *
 *   不可复现 Math.sin/cos/exp/pow/log/…
 *           —— ECMAScript 规范明说它们是 *implementation-approximated*。
 *              不同 V8 版本理论上可以在最后一位上不同。**模拟里一个都不能用。**
 *
 * 于是策略是：
 *   - **状态**全部是定点整数。哈希和比较因此变成精确的整数运算，
 *     不存在「差 1e-17 算不算相等」这种问题。
 *   - **中间计算**可以用浮点（+ − × ÷ 是安全的），最后量化回整数。
 *     这样极小的变化率不会因为精度不足而被抹掉。
 *
 * 标度取 2 的幂，缩放是精确的。
 */

/** 定点标度的位数。1 << 20 ≈ 104 万分之一的分辨率。 */
export const FX_BITS = 20;
export const FX = 1 << FX_BITS;

/** 浮点 → 定点。 */
export function fx(v: number): number {
  return Math.round(v * FX);
}

/** 定点 → 浮点。中间计算用。 */
export function unfx(v: number): number {
  return v / FX;
}

/**
 * 定点乘法。
 *
 * 安全性：状态量都归一化在 [0, ~20]，即存储值 ≤ 2×10^7。
 * 两者相乘 ≤ 4×10^14，远小于 Number.MAX_SAFE_INTEGER（9×10^15），
 * 所以中间积是精确的。**不要**用它去乘两个未归一化的大数。
 */
export function fxMul(a: number, b: number): number {
  return Math.round((a * b) / FX);
}

/** 定点除法。除零返回 0 而不是 NaN —— 模拟里出现 NaN 会污染整个状态。 */
export function fxDiv(a: number, b: number): number {
  if (b === 0) return 0;
  return Math.round((a * FX) / b);
}

export function clampFx(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

/** 定点 0..FX 的线性插值。 */
export function fxLerp(a: number, b: number, t: number): number {
  return a + fxMul(b - a, t);
}

export function isqrt(n: number): number {
  if (n <= 0) return 0;
  if (n < 4) return 1;

  // ⚠️ 全程**不用位运算**。
  //
  // JS 的 >> 和 << 是 32 位的，而这里的 n 可以到 1e12 量级
  // （方向向量的平方和放大 FX² 之后）。用位运算求初值会被静默截断成
  // 一个垃圾数，牛顿迭代再收敛也回不到正确的分支。
  //
  // 第一版就是这么写的，症状是：**有的珊瑚长到 60 多个节点，
  // 有的一根都不长**。因为坏掉只在「累积方向向量的量级超过 2^31」时发生，
  // 而这取决于一个节点被多少吸引点选中 —— 完全看运气。
  // 这种「时好时坏、不报错」的 bug 是最贵的。
  let shift = 0;
  let probe = n;
  while (probe > 1) {
    probe = Math.floor(probe / 4);
    shift += 2;
  }
  let x = 1;
  for (let k = 0; k < (shift >> 1) + 1; k++) x *= 2;

  // 整数牛顿迭代
  for (let guard = 0; guard < 80; guard++) {
    const next = Math.floor((x + Math.floor(n / x)) / 2);
    if (next >= x) break;
    x = next;
  }

  // 收尾：整数牛顿会停在 floor 或 floor+1，修正掉最后一位
  while (x > 0 && x * x > n) x--;
  while ((x + 1) * (x + 1) <= n) x++;
  return x;
}
