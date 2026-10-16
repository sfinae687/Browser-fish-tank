/**
 * 自适应画质。
 *
 * 固定档位（低/中/高）解决不了真问题：同一台机器插着电源和用着电池时
 * 能跑的东西不一样，窗口大小一变渲染量能差三倍，别人的显卡更是无从预知。
 * 所以「自动」档必须**真的去测**，而不是按 CPU 核数猜。
 *
 * ## 测什么
 *
 * 只测 CPU 时间是不够的：在 SwiftShader 或者集显上，`render()` 会很快返回，
 * 真正的开销发生在 GPU 进程里，表现为**下一帧来得更晚**。
 * 所以每帧的实际成本是两者之和：
 *
 *     成本 = 循环体的 CPU 时间 + 超出帧预算的那部分等待
 *
 * 这样 CPU 瓶颈和 GPU 瓶颈都能被感知到。
 *
 * ## 迟滞
 *
 * 降档要快、升档要慢 —— 这个不对称是有意的：
 *   - 帧率一旦掉了，用户立刻能感觉到，所以降档要果断
 *   - 升档太快会来回抖动，而「画质在呼吸」比一直低一档更难受
 *
 * 所以降档的阈值低（超预算 15% 就降）、冷却短；升档的阈值高（只用了
 * 一半预算才升）、冷却长，而且升的步长是降的一半。
 *
 * @see DESIGN.md §7
 */

/** 渲染缩放的下限。再低画面就糊得不能看了。 */
export const MIN_SCALE = 0.45;

/** 每次调整的步长。 */
const DOWN_STEP = 0.12;
const UP_STEP = 0.06;

/** 调整后的冷却帧数。 */
const DOWN_COOLDOWN = 45;
const UP_COOLDOWN = 150;

/** 指数平滑系数。太小则反应迟钝，太大则被单帧尖刺带偏。 */
const SMOOTHING = 0.08;

export interface AdaptiveSnapshot {
  /** 当前的渲染缩放 0.45..1 */
  scale: number;
  /** 平滑后的每帧成本（ms） */
  costMs: number;
  /** 当前的帧预算（ms） */
  budgetMs: number;
  /** 累计降档 / 升档次数，用于诊断「画质在抖」 */
  downgrades: number;
  upgrades: number;
}

export class AdaptiveQuality {
  private scale: number;
  private costMs = 16.7;
  private cooldown = 0;
  private downgrades = 0;
  private upgrades = 0;
  /** 已平滑的帧数。前几帧还没有代表性，不做任何调整。 */
  private warmup = 0;

  constructor(initialScale = 1) {
    this.scale = Math.min(1, Math.max(MIN_SCALE, initialScale));
  }

  /**
   * 报告一帧的开销。
   *
   * @param cpuMs 循环体实际占用的 CPU 时间
   * @param dtMs 与上一帧的真实间隔
   * @param frameIntervalMs 由 fpsCap 决定的帧预算
   * @returns 这一帧应当使用的渲染缩放
   */
  observe(cpuMs: number, dtMs: number, frameIntervalMs: number): number {
    // 超出帧预算的那部分等待 —— 它是 GPU 跟不上的信号
    const overrun = Math.max(0, dtMs - frameIntervalMs);
    const cost = cpuMs + overrun;

    this.costMs += (cost - this.costMs) * SMOOTHING;
    this.warmup++;

    // 预热期内不调整：着色器编译、纹理上传、渲染目标分配都在前几帧发生，
    // 按它们做判断会把画质一次性打到最低。
    if (this.warmup < 30) return this.scale;

    if (this.cooldown > 0) {
      this.cooldown--;
      return this.scale;
    }

    if (this.costMs > frameIntervalMs * 1.15) {
      // 超预算：果断降
      if (this.scale > MIN_SCALE) {
        this.scale = Math.max(MIN_SCALE, this.scale - DOWN_STEP);
        this.downgrades++;
      }
      this.cooldown = DOWN_COOLDOWN;
    } else if (this.costMs < frameIntervalMs * 0.5) {
      // 只用了一半预算：可以谨慎升
      if (this.scale < 1) {
        this.scale = Math.min(1, this.scale + UP_STEP);
        this.upgrades++;
      }
      this.cooldown = UP_COOLDOWN;
    }

    return this.scale;
  }

  /** 当前的渲染缩放。 */
  get value(): number {
    return this.scale;
  }

  snapshot(frameIntervalMs: number): AdaptiveSnapshot {
    return {
      scale: this.scale,
      costMs: this.costMs,
      budgetMs: frameIntervalMs,
      downgrades: this.downgrades,
      upgrades: this.upgrades,
    };
  }

  /** 重置。画布尺寸剧烈变化（比如窗口从最小化恢复）时调用。 */
  reset(scale = 1): void {
    this.scale = Math.min(1, Math.max(MIN_SCALE, scale));
    this.costMs = 16.7;
    this.cooldown = 30;
    this.warmup = 0;
  }
}
