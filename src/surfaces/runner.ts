/**
 * 表面运行器 —— 新标签页与覆盖层共用的那一半。
 *
 * 两个表面的差别只在「配置用哪一份、画布怎么摆」；
 * 渲染循环、世界推进、可见性、动效模式、画质解析完全一样。
 *
 * ## 谁在推进世界
 *
 * 每个表面**各自**持有并推进自己的一份世界，彼此之间不做任何通信。
 * 这看起来像是会打架，其实不会 —— 因为 `WorldState` 是自足状态、
 * `advanceWorld` 是纯函数，所以从同一个快照出发的两个表面必然算出
 * 逐位一致的结果。这就是 DESIGN.md §3.1 说的「确定性 ⇒ 不需要仲裁者」。
 *
 * 唯一需要协调的是**写回**：两边都会周期性存快照，用「步号更大者胜」
 * 让它们自然收敛，不需要锁。
 */

import type { Config, SurfaceId } from '../core/config.js';
import { effectiveSeed } from '../core/config.js';
import {
  loadConfig,
  onConfigChanged,
  storageBackend,
  loadWorldSnapshot,
  saveWorldSnapshot,
  loadJournal,
  appendAction,
  onJournalChanged,
} from '../core/storage.js';
import { makeFeedAction, makeBreedAction, describeAction, type Action } from '../core/actions.js';
import { findFishIndex, type FishRecord } from '../core/world.js';
import {
  msOfDay,
  warmthAt,
  lightDirectionAt,
  SIM_HZ,
  DEFAULT_MAX_CATCHUP_MS,
} from '../core/clock.js';
import {
  ENV_INTERVAL_TICKS,
  advanceWorld,
  advanceWorldTo,
  cloneWorld,
  createWorld,
  envView,
  stepWorld,
  worldEquals,
  worldHash,
  type EnvView,
  type WorldState,
} from '../core/world.js';
import { paletteFor } from '../core/theme.js';
import type { Genome } from '../core/genome.js';
import { generateFlora, floraStats } from '../core/flora.js';
import { allocatePose, computeSchool, type SchoolPose } from '../core/school.js';
import type { RenderableFish } from '../render/fish.js';
import { isqrt } from '../core/fixed.js';
import { bakeFlora } from '../render/flora-bake.js';
import { hashString } from '../core/rng.js';
import { resolveQuality, type RenderBudget } from '../core/quality.js';
import { AdaptiveQuality } from '../core/adaptive.js';
import { TankRenderer, computeTankRect, type TankFrame } from '../render/tank.js';
import type { Palette } from '../core/theme.js';

/** 开场生长动画的时长。与 DESIGN.md §0.1 的时间表对应。 */
const INTRO_MS = 9000;

/** 世界快照的写回间隔。 */
const SNAPSHOT_INTERVAL_MS = 20_000;

/** 启动自检最多回放多长的世界时间。 */
const SELF_CHECK_MAX_MS = 2 * 60 * 60 * 1000;

export interface RunnerStatus {
  fps: number;
  renderer: string;
  software: boolean;
  tier: RenderBudget['tier'];
  backend: string;
  seed: string;
  theme: string;
  paused: boolean;
  motion: string;
  error: string | null;
  /** 世界状态。渲染器没起来时为 null。 */
  env: EnvView | null;
  /** 确定性自检是否发现分叉 */
  diverged: boolean;
  /** 自适应画质的当前缩放（非自动档时恒为 1） */
  adaptiveScale: number;
  /** 平滑后的每帧成本（ms） */
  costMs: number;
}

export interface RunnerOptions {
  surface: SurfaceId;
  canvas: HTMLCanvasElement;
  onStatus?: (status: RunnerStatus) => void;
  /**
   * 每次拿到配置后套一层变换。
   *
   * 用于 URL 参数覆盖。做成回调而不是「传一个初始配置」，是因为配置随时
   * 可能从存储里变更 —— 覆盖必须在每一次变更后重新应用。
   */
  transformConfig?: (config: Config) => Config;
}

export class AquariumRunner {
  private readonly opts: RunnerOptions;
  private readonly canvas: HTMLCanvasElement;

  private config: Config | null = null;
  private renderer: TankRenderer | null = null;
  private palette: Palette | null = null;
  private paletteKey = '';

  private world: WorldState | null = null;
  /** 当前已生成植物的种子。换了种子才重新生成。 */
  private floraSeed: string | null = null;

  /**
   * 鱼群每帧求值用的位置缓冲。
   *
   * 基因组池与鱼群本身**住在世界状态里**（P4 起）—— 因为繁殖会创造
   * 新的基因组，它们不再是「由种子派生的常量」了。
   * 这里只留一个可复用的缓冲区，避免每帧分配。
   */
  private pose: SchoolPose | null = null;

  /**
   * 玩家意图日志。
   *
   * 运行器**不直接改世界**，而是把操作交给日志，再让世界在推进时
   * 按正确的时刻重放。这是「两个表面各持一份世界」这个架构下
   * 唯一能让玩家输入保持一致的办法。
   */
  private journal: Action[] = [];
  private unsubscribeJournal: (() => void) | null = null;

  private rafId = 0;
  private running = false;
  private disposed = false;

  private lastFrameMs = 0;
  private frameAccum = 0;
  private frameCount = 0;
  private fps = 0;

  private startedAt = performance.now();
  private animTime = 0;

  private paused = false;
  private error: string | null = null;
  private diverged = false;
  private unsubscribe: (() => void) | null = null;

  /**
   * 自适应画质。只在 `quality === 'auto'` 时生效 ——
   * 用户明确选了档位就不要再替他改。
   */
  private adaptive = new AdaptiveQuality(1);

  private lastSnapshotMs = 0;
  private lastSavedTick = -1;
  private renderedFrames = 0;

  private readonly reducedMotionQuery: MediaQueryList | null;

  constructor(opts: RunnerOptions) {
    this.opts = opts;
    this.canvas = opts.canvas;
    this.reducedMotionQuery =
      typeof matchMedia === 'function' ? matchMedia('(prefers-reduced-motion: reduce)') : null;
  }

  async start(): Promise<void> {
    this.config = this.transform(await loadConfig());

    try {
      this.renderer = new TankRenderer(this.canvas);
    } catch (err) {
      this.error = err instanceof Error ? err.message : String(err);
      this.applyFallback();
      this.publishDebug();
      this.emitStatus();
      return;
    }

    if (this.renderer.info.software) {
      console.warn(
        '[计算水族箱] 检测到软件光栅化（' +
          this.renderer.info.renderer +
          '），已自动降到低画质。',
      );
    }

    this.rebuildPalette();
    this.rebuildFlora();
    await this.initWorld(Date.now());

    this.unsubscribe = onConfigChanged((next) => {
      const previous = this.config;
      this.config = this.transform(next);
      this.rebuildPalette();
      // 换了种子就是一个新世界
      if (
        previous &&
        effectiveSeed(previous, this.opts.surface) !==
          effectiveSeed(this.config, this.opts.surface)
      ) {
        this.rebuildFlora();
        void this.initWorld(Date.now());
      }
    });

    this.journal = await loadJournal();
    this.unsubscribeJournal = onJournalChanged((actions) => {
      this.journal = actions;
    });

    this.reducedMotionQuery?.addEventListener('change', this.onMotionPreferenceChange);
    document.addEventListener('visibilitychange', this.onVisibilityChange);

    this.applyCanvasCss();
    this.running = true;
    this.lastFrameMs = performance.now();
    this.rafId = requestAnimationFrame(this.loop);

    this.publishDebug();
    this.emitStatus();
  }

  // ————————————————————————————————————————————————————————————
  // 世界
  // ————————————————————————————————————————————————————————————

  private async initWorld(nowMs: number): Promise<void> {
    const cfg = this.config;
    if (!cfg) return;

    const seed = effectiveSeed(cfg, this.opts.surface);
    const snapshot = await loadWorldSnapshot(seed);

    if (snapshot) {
      this.world = snapshot;
      // 从快照那一刻快进到现在的真实时间
      const before = cloneWorld(this.world);
      advanceWorldTo(this.world, nowMs, DEFAULT_MAX_CATCHUP_MS, this.journal);
      this.selfCheck(before, this.world.tick - before.tick);
    } else {
      this.world = createWorld(seed, nowMs);
    }

    this.lastSnapshotMs = nowMs;
    this.lastSavedTick = -1;
    this.publishDebug();
  }

  /**
   * 启动时的一次性自检：**批量快进**与**逐帧推进**必须得到完全一致的世界。
   *
   * 这两条路径在生产里都会走到 —— 刚打开时批量追赶，之后逐帧单步。
   * 它们一旦不一致，症状是「世界偶尔会跳变」，极难在事后复现。
   * 与其等到那时，不如每次启动花几毫秒验一遍。
   *
   * 回放长度有上限（默认 2 小时世界时间），否则一个 24 小时的追赶
   * 会让启动卡顿。
   */
  private selfCheck(reference: WorldState, catchupTicks: number): void {
    const limit = Math.floor((SELF_CHECK_MAX_MS / 1000) * SIM_HZ);
    const ticks = Math.min(catchupTicks, limit);
    // 至少要跨过两个环境步进，否则两条路径根本不会分岔，验了等于没验
    if (ticks < ENV_INTERVAL_TICKS * 2) return;

    const bulk = cloneWorld(reference);
    advanceWorld(bulk, reference.tick + ticks);

    const slow = cloneWorld(reference);
    for (let t = slow.tick + 1; t <= reference.tick + ticks; t++) stepWorld(slow, t);

    if (!worldEquals(bulk, slow)) {
      this.diverged = true;
      console.error(
        '[计算水族箱] 确定性自检失败：批量快进与逐帧推进的结果不一致。\n' +
          `  回放了 ${ticks} 步（约 ${(ticks / SIM_HZ / 60).toFixed(0)} 分钟世界时间）\n` +
          `  批量 hash=${worldHash(bulk)}  逐帧 hash=${worldHash(slow)}\n` +
          '  这意味着世界状态不可复现 —— 请检查 world.ts 里是否引入了实现相关的运算。',
      );
    }
  }

  /** 把世界推进到当前真实时间，并定期写回快照。 */
  private tickWorld(nowMs: number): EnvView | null {
    const world = this.world;
    if (!world) return null;

    advanceWorldTo(world, nowMs, DEFAULT_MAX_CATCHUP_MS, this.journal);

    // 定期写回。两个表面都会写，用「步号更大者胜」自然收敛，不需要锁。
    if (nowMs - this.lastSnapshotMs >= SNAPSHOT_INTERVAL_MS && world.tick > this.lastSavedTick) {
      this.lastSnapshotMs = nowMs;
      this.lastSavedTick = world.tick;
      void saveWorldSnapshot(world, nowMs);
    }

    return envView(world);
  }

  private onMotionPreferenceChange = (): void => {
    // 偏好变化可能意味着「现在必须停下来」，下一帧就会按新设置走
  };

  private onVisibilityChange = (): void => {
    const hidden = document.hidden;
    const shouldPause = hidden && (this.config?.pauseWhenHidden ?? true);

    if (shouldPause && !this.paused) {
      this.pause();
    } else if (!shouldPause && this.paused) {
      this.resume();
    }
  };

  pause(): void {
    if (this.paused) return;
    this.paused = true;
    cancelAnimationFrame(this.rafId);
    this.rafId = 0;
    this.emitStatus();
  }

  resume(): void {
    if (!this.paused || this.disposed) return;
    this.paused = false;
    // 重置渲染计时的基准。世界**不需要**这样处理 ——
    // 它的时间来自真实时钟，恢复时由 advanceWorldTo 正确追赶。
    this.lastFrameMs = performance.now();
    this.rafId = requestAnimationFrame(this.loop);
    this.publishDebug();
    this.emitStatus();
  }

  private applyCanvasCss(): void {
    const cfg = this.config;
    if (!cfg) return;
    const sc = cfg.surfaces[this.opts.surface];

    this.canvas.style.opacity = String(sc.opacity);
    this.canvas.style.mixBlendMode = sc.blendMode === 'normal' ? 'normal' : sc.blendMode;
    this.canvas.style.pointerEvents =
      sc.interaction.pointer === 'none' || sc.interaction.clickThrough ? 'none' : 'auto';
  }

  private applyFallback(): void {
    // WebGL2 起不来时不能让用户看到一片黑。给一个静态渐变，
    // 至少页面上有个像水的东西，而且错误信息会显示在 HUD 上。
    this.canvas.style.display = 'none';
    const parent = this.canvas.parentElement;
    if (parent) {
      parent.style.background = 'linear-gradient(180deg, #2a6f8c 0%, #123a52 55%, #060f18 100%)';
    }
  }

  private rebuildPalette(): void {
    const cfg = this.config;
    if (!cfg) return;
    const sc = cfg.surfaces[this.opts.surface];
    const seed = effectiveSeed(cfg, this.opts.surface);
    const key = `${sc.theme}:${seed}`;
    if (key === this.paletteKey) return;
    this.paletteKey = key;
    this.palette = paletteFor(sc.theme, seed);
  }

  /**
   * 从种子生成植物骨架并烘焙成纹理。
   *
   * **不在每帧路径上**。空间殖民要跑几十轮迭代，光栅化要遍历几十万个像素，
   * 加起来是几十毫秒量级 —— 放进渲染循环会直接掉帧。只有种子变了才重来，
   * 而种子变了通常意味着用户刚刚动了设置，一次几十毫秒是可以接受的。
   */
  private rebuildFlora(): void {
    const cfg = this.config;
    const renderer = this.renderer;
    if (!cfg || !renderer) return;

    const seed = effectiveSeed(cfg, this.opts.surface);
    if (seed === this.floraSeed) return;
    this.floraSeed = seed;

    const t0 = performance.now();
    try {
      const skeleton = generateFlora(seed);
      const baked = bakeFlora(skeleton, isqrt);
      renderer.setFlora(baked);
      const ms = performance.now() - t0;
      if (ms > 50 || cfg.debug) {
        const st = floraStats(skeleton);
        console.info(
          `[计算水族箱] 植物骨架：${st.plants} 株 / ${st.nodes} 节点，生成+烘焙 ${ms.toFixed(0)} ms`,
        );
      }
    } catch (err) {
      // 植物生成失败不该让整个鱼缸停摆 —— 没有植物也是一种画面
      console.warn('[计算水族箱] 植物生成失败，这一缸暂时没有植物', err);
    }
  }

  /** 动效模式 -> 时间流速。'still' 是完全冻结。 */
  private timeScale(): number {
    const cfg = this.config;
    if (!cfg) return 1;
    const sc = cfg.surfaces[this.opts.surface];

    if (cfg.respectReducedMotion && this.reducedMotionQuery?.matches) return 0;

    switch (sc.motion) {
      case 'still':
        return 0;
      case 'reduced':
        return 0.25;
      case 'calm':
        return 0.55;
      case 'full':
      default:
        return 1;
    }
  }

  private loop = (now: number): void => {
    if (this.disposed || this.paused) return;

    this.rafId = requestAnimationFrame(this.loop);
    const cpuStart = performance.now();

    const cfg = this.config;
    const renderer = this.renderer;
    const palette = this.palette;
    if (!cfg || !renderer || !palette) return;

    const sc = cfg.surfaces[this.opts.surface];

    // —— FPS 上限 ——
    // 高刷屏上把 60 fps 的动画跑到 144 fps 纯粹是烧电。
    const dtMs = now - this.lastFrameMs;
    const frameInterval = 1000 / sc.fpsCap;
    if (dtMs < frameInterval - 0.5) return;

    // 补偿掉被跳过的那些帧的时间，避免限帧后动画变慢
    this.lastFrameMs = now - (dtMs % frameInterval);

    const dt = Math.min(dtMs, 100) * 0.001;
    this.animTime += dt * this.timeScale() * cfg.world.timeScale;

    // —— 世界 ——
    // 用的是**真实时间**，不是动画时间。世界不该被「动效模式」冻住：
    // 把动效调成静帧的人只是不想看画面在动，不是想让自己的一缸水停止演化。
    const env = this.tickWorld(Date.now());

    // —— 开场生长 ——
    const intro = sc.intro ? Math.min(1, (now - this.startedAt) / INTRO_MS) : 1;
    // 植物在开场的中段长出来。对应 DESIGN §0.1 的时间表：
    // 水位注入之后（20% ≈ 1.8s）开始抽枝，到 60%（≈5.4s）长成。
    const growth = sc.intro ? Math.min(1, Math.max(0, (intro - 0.2) / 0.4)) : 1;

    // —— 光照：单一真相来源是世界 ——
    // 灯与太阳的状态从世界状态派生。渲染不再自己算一份，否则两边会分叉
    // （比如「昼夜跟随」关掉时，画面上是正午、世界里却是深夜）。
    const worldMs = this.world
      ? msOfDay(this.world.epochMs, this.world.tick)
      : msOfDay(Date.now(), 0);
    const light = sc.followClock
      ? {
          daylight: env?.light ?? 0.9,
          warmth: warmthAt(worldMs),
          dir: lightDirectionAt(worldMs),
        }
      : { daylight: 0.94, warmth: 0.1, dir: lightDirectionAt(12 * 3600000) };

    // —— 鱼群 ——
    //
    // 位置由 (种子, 世界时间) 纯函数求出，**不做积分也不进世界状态**：
    // 这样就没有快进问题（跳到任意时刻只是重新求值一次），
    // 而且两个表面各算各的也必然一致。
    let school: {
      genomes: readonly Genome[];
      seeds: readonly RenderableFish[];
      pose: SchoolPose;
    } | null = null;
    const world = this.world;
    if (world && world.fish.length > 0) {
      // 鱼数会随繁殖增长，缓冲区不够就换一个更大的
      if (!this.pose || this.pose.count < world.fish.length) {
        this.pose = allocatePose(Math.max(16, world.fish.length + 8));
      }
      this.pose.count = world.fish.length;
      computeSchool(world.fish, world.genomes, this.animTime, this.pose);
      school = { genomes: world.genomes, seeds: world.fish, pose: this.pose };
    }

    const budget = resolveQuality(sc.quality, renderer.info.deviceTier, sc);
    // 自动档时叠加自适应缩放
    if (sc.quality === 'auto') budget.renderScale *= this.adaptive.value;

    const frame: TankFrame = {
      time: this.animTime,
      intro,
      daylight: light.daylight,
      warmth: light.warmth,
      lightDir: [light.dir.x, light.dir.y],
      algae: env?.algae ?? 0,
      heat: env?.heat ?? 0.4,
      growth,
      school,
      palette,
      layers: sc.layers,
      framing: sc.framing,
      background: sc.background,
      opacity: sc.opacity,
      zoom: sc.zoom,
      anchor: sc.anchor,
      seed: hashString(effectiveSeed(cfg, this.opts.surface)),
      budget,
    };

    renderer.render(frame);
    const cpuMs = performance.now() - cpuStart;
    this.renderedFrames++;
    this.publishDebug();

    // —— 自适应画质 ——
    //
    // ⚠️ 必须把「超出帧预算的那部分等待」也算进成本。只测循环体的 CPU 时间
    // 是不够的：在 SwiftShader 或集显上 render() 会很快返回，
    // 真正的开销发生在 GPU 进程里，表现为**下一帧来得更晚**。
    if (sc.quality === 'auto') {
      this.adaptive.observe(cpuMs, dtMs, frameInterval);
    }

    // —— 状态统计 ——
    this.frameAccum += dtMs;
    this.frameCount++;
    if (this.frameAccum >= 500) {
      this.fps = Math.round((this.frameCount * 1000) / this.frameAccum);
      this.frameAccum = 0;
      this.frameCount = 0;
      this.emitStatus();
    }
  };

  /**
   * 把内部状态挂到 window 上，供 tools/ 下的自动化脚本读取。
   *
   * 存在的理由很具体：无头 Chromium 的 --virtual-time-budget 只推进定时器，
   * **不会等 GPU 真正把画面画出来**。固定延时截图会间歇性截到一张空白页 ——
   * 这个钩子让脚本能轮询真正的就绪状态，而不是碰运气。
   */
  private publishDebug(): void {
    if (typeof window === 'undefined') return;
    const w = window as unknown as { __aqua?: Record<string, unknown> };
    if (!w.__aqua) w.__aqua = {};
    w.__aqua['frames'] = this.renderedFrames;
    w.__aqua['ready'] = this.renderedFrames >= 3;
    w.__aqua['error'] = this.error;
    w.__aqua['diverged'] = this.diverged;
    w.__aqua['renderer'] = this.renderer?.info.renderer ?? null;
    w.__aqua['tick'] = this.world?.tick ?? null;
    w.__aqua['hash'] = this.world ? worldHash(this.world) : null;
    // 供验收脚本确认「点击真的接通了」
    w.__aqua['actionSeq'] = this.world?.lastActionSeq ?? 0;
    w.__aqua['journal'] = this.journal.length;
    w.__aqua['nutrients'] = this.world ? this.world.nutrients / 1048576 : null;
    w.__aqua['adaptiveScale'] = this.adaptive.value;
  }

  private emitStatus(): void {
    if (!this.opts.onStatus) return;
    const cfg = this.config;
    const renderer = this.renderer;

    this.opts.onStatus({
      fps: this.fps,
      renderer: renderer?.info.renderer ?? '（未初始化）',
      software: renderer?.info.software ?? false,
      tier: renderer
        ? resolveQuality(
            cfg?.surfaces[this.opts.surface].quality ?? 'auto',
            renderer.info.deviceTier,
            cfg?.surfaces[this.opts.surface] ?? { fpsCap: 60, pixelRatioCap: 2 },
          ).tier
        : 'low',
      backend: storageBackend(),
      seed: cfg ? effectiveSeed(cfg, this.opts.surface) : '—',
      theme: cfg?.surfaces[this.opts.surface].theme ?? '—',
      paused: this.paused,
      motion: cfg?.surfaces[this.opts.surface].motion ?? '—',
      error: this.error,
      env: this.world ? envView(this.world) : null,
      diverged: this.diverged,
      adaptiveScale: this.adaptive.value,
      costMs: this.adaptive.snapshot(1000 / (cfg?.surfaces[this.opts.surface].fpsCap ?? 60)).costMs,
    });
  }

  /** 供设置页「即时预览」使用：不重新加载就能生效。 */
  updateConfig(config: Config): void {
    this.config = this.transform(config);
    this.rebuildPalette();
    this.applyCanvasCss();
  }

  /** 统一入口：所有进入 runner 的配置都必须过这里。 */
  private transform(config: Config): Config {
    const fn = this.opts.transformConfig;
    if (!fn) return config;
    try {
      return fn(config);
    } catch (err) {
      // 覆盖函数坏掉不该让整个鱼缸停摆
      console.warn('[计算水族箱] transformConfig 抛异常，已忽略', err);
      return config;
    }
  }

  get currentError(): string | null {
    return this.error;
  }

  // ————————————————————————————————————————————————————————————
  // 玩家操作
  // ————————————————————————————————————————————————————————————

  /**
   * 提交一条玩家操作。
   *
   * 流程刻意是「先写日志、再推进」：于是本地世界和别的表面走的是**同一条
   * 路径**，不存在「本地特判」这种会在两边行为不一致的地方。
   */
  private async submit(action: Omit<Action, 'seq'>): Promise<void> {
    try {
      const full = await appendAction(action);
      this.journal = await loadJournal();
      // 立刻推进一次，让本地世界马上反应，而不是等下一帧
      if (this.world) {
        advanceWorldTo(this.world, Date.now(), DEFAULT_MAX_CATCHUP_MS, this.journal);
      }
      void full;
    } catch (err) {
      console.warn('[计算水族箱] 操作提交失败', err);
    }
  }

  /** 投食。坐标是缸内 uv。 */
  feed(tankX: number, tankY: number): void {
    void this.submit(
      makeFeedAction(0, Date.now(), Math.round(tankX * 1048576), Math.round(tankY * 1048576)),
    );
  }

  /** 让两条鱼杂交。参数是稳定的鱼 id。 */
  breed(parentA: number, parentB: number): void {
    void this.submit(makeBreedAction(0, Date.now(), parentA, parentB));
  }

  /**
   * 屏幕坐标（缸内 uv）→ 命中的鱼 id。
   *
   * 用当前位置缓冲来判定，所以点到的就是**画面上看到的那条**。
   * 判定半径按体型走，大鱼更好点。
   */
  pickFish(tankX: number, tankY: number): number {
    const world = this.world;
    const pose = this.pose;
    if (!world || !pose) return -1;

    let best = -1;
    let bestD = Infinity;
    for (let i = 0; i < pose.count && i < world.fish.length; i++) {
      const f = world.fish[i] as FishRecord;
      if (f.decay > 0) continue;
      const dx = (pose.pos[i * 2] as number) - tankX;
      const dy = (pose.pos[i * 2 + 1] as number) - tankY;
      const d2 = dx * dx + dy * dy;
      // 判定半径至少 0.05，否则小鱼根本点不中
      const r = Math.max(0.05, f.radius / 1048576);
      if (d2 < r * r && d2 < bestD) {
        bestD = d2;
        best = f.id;
      }
    }
    return best;
  }

  /** 取一条鱼的可读信息，供检视面板使用。 */
  inspectFish(id: number): {
    id: number;
    genome: Genome;
    energy: number;
    maxEnergy: number;
    ageSeconds: number;
    lifespanSeconds: number;
    generation: number;
    parents: readonly number[] | null;
    diet: number;
    cruiseSpeed: number;
  } | null {
    const world = this.world;
    if (!world) return null;
    const idx = findFishIndex(world, id);
    if (idx < 0) return null;
    const f = world.fish[idx] as FishRecord;
    const g = world.genomes[f.genome];
    if (!g) return null;
    return {
      id: f.id,
      genome: g,
      energy: f.energy / 1048576,
      maxEnergy: g.metabolism.maxEnergy / 1048576,
      ageSeconds: f.age,
      lifespanSeconds: g.metabolism.lifespan,
      generation: g.generation,
      parents: g.parents,
      diet: g.behavior.diet / 1048576,
      cruiseSpeed: g.behavior.cruiseSpeed / 1048576,
    };
  }

  /**
   * 屏幕坐标 → 缸内 uv。
   *
   * 必须和渲染器用**同一个** `computeTankRect`，否则点击落点和画面对不上 ——
   * 而且错位量会随构图（铺满 / 居中 / 圆窗）和缩放而变，
   * 是那种「在默认配置下看着没问题」的坑。
   */
  screenToTank(clientX: number, clientY: number): { x: number; y: number } | null {
    const cfg = this.config;
    if (!cfg) return null;
    const sc = cfg.surfaces[this.opts.surface];

    const w = this.canvas.clientWidth;
    const h = this.canvas.clientHeight;
    if (w <= 0 || h <= 0) return null;
    const rect = this.canvas.getBoundingClientRect();

    // 屏幕 uv（y 向下）
    const uvx = (clientX - rect.left) / w;
    const uvy = (clientY - rect.top) / h;

    const aspect = w / Math.max(1, h);
    const r = computeTankRect(sc.framing, sc.zoom, sc.anchor, aspect);

    return {
      x: (uvx - r[0]) / Math.max(1e-4, r[2]),
      y: (uvy - r[1]) / Math.max(1e-4, r[3]),
    };
  }

  /** 当前日志的最后一条操作，供 HUD 显示。 */
  get lastActionDescription(): string | null {
    const last = this.journal[this.journal.length - 1];
    return last ? describeAction(last) : null;
  }

  /** 供诊断。 */
  get journalSize(): number {
    return this.journal.length;
  }

  /** 供验收脚本判断确定性自检是否通过。 */
  get hasDiverged(): boolean {
    return this.diverged;
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.running = false;
    cancelAnimationFrame(this.rafId);

    // 退出前存一次，把这一段时间的演化留住
    if (this.world && this.world.tick > this.lastSavedTick) {
      this.lastSavedTick = this.world.tick;
      void saveWorldSnapshot(this.world, Date.now());
    }

    this.unsubscribe?.();
    this.unsubscribeJournal?.();
    this.reducedMotionQuery?.removeEventListener('change', this.onMotionPreferenceChange);
    document.removeEventListener('visibilitychange', this.onVisibilityChange);
    this.renderer?.dispose();
    this.renderer = null;
  }

  get isRunning(): boolean {
    return this.running && !this.paused;
  }
}
