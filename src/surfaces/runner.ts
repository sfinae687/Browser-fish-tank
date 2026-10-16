/**
 * 运行器。把一个表面（新标签页 / 覆盖层）跑起来。
 *
 * 它把四样东西串在一起：
 *
 *   配置 ──→ 渲染器
 *     │        ↑
 *     └──→ 标签页数据源 ──→ 生物群
 *
 * 外加三件交互：悬停显示标题、点击切换标签页、可见性暂停。
 *
 * ## 帧率上限不是可选项
 *
 * 一个美化插件最容易犯的错是「反正是动画，跑满吧」。深海的场景是缓慢的，
 * 30fps 完全够看，而省下来的电和风扇噪音用户能直接感受到。
 * 所以 `fpsCap` 是配置里的第一等公民，循环里真的会跳过帧。
 *
 * ## 非扩展环境也要能跑
 *
 * `createTabSource()` 在没有 chrome.tabs 时退回演示数据。于是同一个运行器
 * 在扩展里、设置页预览里、本地预览页里跑的是**同一条代码路径** ——
 * 「环境不同行为就不同」的分叉是 bug 的温床。
 */

import { TankRenderer, computeTankRect, type TankFrame } from '../render/tank.js';
import { paletteFor } from '../core/theme.js';
import {
  resolveQuality,
  type Config,
  type SurfaceConfig,
  type SurfaceId,
} from '../core/config.js';
import { loadConfig, onConfigChanged, storageBackend } from '../core/storage.js';
import { Flock, type Creature } from '../core/creatures.js';
import { createTabSource, type TabSource, type TabInfo } from '../core/tabs.js';

export interface RunnerStatus {
  fps: number;
  quality: string;
  renderScale: number;
  software: boolean;
  paused: boolean;
  error: string | null;
  creatures: number;
  tabs: number;
  hasTitles: boolean;
  demo: boolean;
  storage: string;
}

export interface RunnerOptions {
  surface: SurfaceId;
  canvas: HTMLCanvasElement;
  onStatus?: (status: RunnerStatus) => void;
}

/** 开场的点亮时长（秒）。深海不需要「生长」，只需要「亮起来」。 */
const INTRO_SECONDS = 1.6;

export class AquariumRunner {
  readonly surface: SurfaceId;
  readonly canvas: HTMLCanvasElement;

  private readonly onStatus?: (status: RunnerStatus) => void;

  private renderer: TankRenderer | null = null;
  private config: Config | null = null;
  private tabSource: TabSource | null = null;
  private flock: Flock | null = null;
  private tabs: TabInfo[] = [];

  private rafId = 0;
  private running = false;
  private disposed = false;
  private paused = false;
  private error: string | null = null;

  private lastFrameMs = 0;
  private frameAccum = 0;
  private frameCount = 0;
  private fps = 0;
  private lastStatusMs = 0;

  private startedAt = performance.now();
  private animTime = 0;

  private unsubscribeConfig: (() => void) | null = null;
  private unsubscribeTabs: (() => void) | null = null;
  private reducedMotionQuery: MediaQueryList | null = null;

  private pointer: { x: number; y: number } | null = null;
  private hovered: Creature | null = null;

  /**
   * 累计「因为点击而切换标签页」的次数，以及最后一次切的 id。
   *
   * 存在的理由：这一版最核心的能力是「点一只生物切过去」，
   * 而无头环境里没法用眼睛确认。有了这个计数，验收脚本就能
   * 真的点一下然后断言它发生了 —— 而不是只验到「生物画出来了」。
   */
  private activations = 0;
  private lastActivatedTabId = -1;

  /** 标签页列表需要重查。事件可能短时间连发，所以配一个节流。 */
  private tabsDirty = true;
  private lastTabsRefresh = 0;

  constructor(opts: RunnerOptions) {
    this.surface = opts.surface;
    this.canvas = opts.canvas;
    this.onStatus = opts.onStatus;
    this.reducedMotionQuery =
      typeof matchMedia === 'function' ? matchMedia('(prefers-reduced-motion: reduce)') : null;
  }

  get conf(): SurfaceConfig | null {
    return this.config ? this.config.surfaces[this.surface] : null;
  }

  get currentError(): string | null {
    return this.error;
  }

  async start(): Promise<void> {
    try {
      this.config = await loadConfig();

      this.renderer = new TankRenderer(this.canvas, { alpha: this.surface === 'overlay' });
      this.tabSource = createTabSource();
      this.flock = new Flock({ maxCreatures: this.conf?.maxCreatures ?? 18 });

      this.unsubscribeConfig = onConfigChanged((c) => {
        this.config = c;
        this.tabsDirty = true;
        // 生物数量上限可能变了
        if (this.flock && this.conf) this.flock.setMax(this.conf.maxCreatures);
      });

      this.unsubscribeTabs = this.tabSource.subscribe(() => {
        this.tabsDirty = true;
      });

      await this.refreshTabs(true);
      this.reducedMotionQuery?.addEventListener('change', this.onVisibilityChange);
      document.addEventListener('visibilitychange', this.onVisibilityChange);

      this.running = true;
      this.lastFrameMs = performance.now();
      this.rafId = requestAnimationFrame(this.loop);
      this.publishDebug();
      this.emitStatus(true);
    } catch (err) {
      this.error = err instanceof Error ? err.message : String(err);
      this.emitStatus(true);
      throw err;
    }
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.running = false;
    cancelAnimationFrame(this.rafId);
    this.unsubscribeConfig?.();
    this.unsubscribeTabs?.();
    this.reducedMotionQuery?.removeEventListener('change', this.onVisibilityChange);
    document.removeEventListener('visibilitychange', this.onVisibilityChange);
    this.renderer?.dispose();
    this.renderer = null;
  }

  // ————————————————————————————————————————————————————————————
  // 标签页
  // ————————————————————————————————————————————————————————————

  private async refreshTabs(force: boolean): Promise<void> {
    if (!this.tabSource) return;
    const now = performance.now();
    // 节流：标签页事件的爆发式触发不该让我们每次都查一遍全部标签页
    if (!force && now - this.lastTabsRefresh < 120) return;
    this.lastTabsRefresh = now;
    try {
      this.tabs = await this.tabSource.list();
      this.tabsDirty = false;
    } catch {
      /* 查询失败就沿用上一批 */
    }
  }

  get tabCount(): number {
    return this.tabs.length;
  }

  get hasTitles(): boolean {
    return this.tabSource?.hasTitles ?? false;
  }

  get isDemo(): boolean {
    return !this.hasTitles && this.tabs.length > 0;
  }

  /** 请求可选的 `tabs` 权限（读标题用）。必须在用户手势里调用。 */
  async requestTitles(): Promise<boolean> {
    if (!this.tabSource?.requestTitles) return false;
    const granted = await this.tabSource.requestTitles();
    if (granted) {
      this.tabsDirty = true;
      await this.refreshTabs(true);
    }
    return granted;
  }

  // ————————————————————————————————————————————————————————————
  // 交互
  // ————————————————————————————————————————————————————————————

  /**
   * 屏幕坐标 → 缸内坐标。落在缸外返回 null。
   *
   * 必须和渲染器用**同一个** `computeTankRect`，否则点击落点和画面对不上，
   * 而且错位量会随构图与缩放变化 —— 是那种「默认配置下看着没问题」的坑。
   */
  toTank(clientX: number, clientY: number): { x: number; y: number } | null {
    const conf = this.conf;
    if (!conf) return null;
    const w = this.canvas.clientWidth;
    const h = this.canvas.clientHeight;
    if (w <= 0 || h <= 0) return null;

    const rect = this.canvas.getBoundingClientRect();
    const uvx = (clientX - rect.left) / w;
    const uvy = (clientY - rect.top) / h;
    const r = computeTankRect(conf.framing, conf.zoom, conf.anchorY, w / Math.max(1, h));

    const x = (uvx - r[0]) / Math.max(1e-4, r[2]);
    const y = (uvy - r[1]) / Math.max(1e-4, r[3]);
    if (x < 0 || x > 1 || y < 0 || y > 1) return null;
    return { x, y };
  }

  setPointer(clientX: number, clientY: number): void {
    this.pointer = { x: clientX, y: clientY };
  }

  clearPointer(): void {
    this.pointer = null;
    this.hovered = null;
  }

  private pickAt(x: number, y: number): Creature | null {
    if (!this.renderer || !this.flock) return null;
    return this.renderer.pick(x, y, this.flock.list);
  }

  /**
   * 处理一次点击，返回命中的生物。
   *
   * 切换标签页在这里做，因为「点中了什么」和「点了之后干什么」
   * 必须由同一处决定 —— 拆开的话，将来加第三种点击行为时
   * 一定会出现两处判断不一致。
   */
  handleClick(clientX: number, clientY: number): Creature | null {
    const coord = this.toTank(clientX, clientY);
    if (!coord) return null;
    const hit = this.pickAt(coord.x, coord.y);
    const conf = this.conf;
    if (hit && conf?.clickToSwitch && hit.tabId >= 0 && this.tabSource) {
      this.activations++;
      this.lastActivatedTabId = hit.tabId;
      void this.tabSource.activate(hit.tabId).catch(() => {
        /* 标签页可能刚被关掉 */
      });
    }
    return hit;
  }

  get hoveredCreature(): Creature | null {
    return this.hovered;
  }

  /**
   * 立即算出 (clientX, clientY) 命中哪只生物。
   *
   * ⚠️ 悬停提示必须用这个，不能用 `hoveredCreature` ——
   * 后者是在**下一帧的循环里**才算出来的。指针事件处理函数里读它，
   * 拿到的是上一帧的结果：鼠标快速划过时提示会慢一拍，
   * 而第一次移动时干脆是空的（那时循环还没跑过）。
   *
   * 位置本身有一帧的延迟是无所谓的（鱼移动得很慢），
   * 但「有没有命中」必须是即时的。
   */
  hoverAt(clientX: number, clientY: number): Creature | null {
    const coord = this.toTank(clientX, clientY);
    return coord ? this.pickAt(coord.x, coord.y) : null;
  }

  // ————————————————————————————————————————————————————————————
  // 主循环
  // ————————————————————————————————————————————————————————————

  private onVisibilityChange = (): void => {
    // 页面不可见时不跑循环 —— 一个后台标签页不该占着 GPU
    if (document.hidden) {
      this.paused = true;
    } else {
      this.paused = false;
      this.lastFrameMs = performance.now();
      if (this.running && !this.disposed) this.rafId = requestAnimationFrame(this.loop);
    }
  };

  private loop = (now: number): void => {
    if (this.disposed || this.paused) return;
    this.rafId = requestAnimationFrame(this.loop);

    const conf = this.conf;
    const renderer = this.renderer;
    if (!conf || !renderer) return;

    const dtMs = now - this.lastFrameMs;
    const frameInterval = 1000 / Math.max(5, conf.fpsCap);
    // 帧率上限：还没到点就跳过这一帧（但时间基准不推进）
    if (dtMs < frameInterval * 0.92) return;

    this.lastFrameMs = now;
    const dt = Math.min(dtMs, 100) / 1000;

    // 尊重系统的「减少动态效果」。这个场景没有「静止」可言，
    // 所以做法是**把时间冻结**，画面变成一张静止的深海照片。
    const reduceMotion = this.reducedMotionQuery?.matches ?? false;
    if (!reduceMotion) this.animTime += dt;

    if (this.tabsDirty) void this.refreshTabs(false);
    this.flock?.sync(this.tabs, dt);

    if (this.pointer && conf.hoverTitles) {
      const coord = this.toTank(this.pointer.x, this.pointer.y);
      this.hovered = coord ? this.pickAt(coord.x, coord.y) : null;
    } else {
      this.hovered = null;
    }

    const quality = resolveQuality(conf.quality, renderer.info.software);
    renderer.resizeToDisplay(quality.renderScale);

    const intro = Math.min(1, (performance.now() - this.startedAt) / (INTRO_SECONDS * 1000));

    const frame: TankFrame = {
      time: this.animTime,
      intro,
      palette: paletteFor(conf.theme),
      layers: conf.layers,
      quality,
      framing: conf.framing,
      zoom: conf.zoom,
      anchorY: conf.anchorY,
      opacity: conf.opacity,
      bloom: conf.bloom,
      creatures: this.flock?.list ?? [],
      creatureScale: conf.creatureScale,
      backdrop: conf.backdrop,
    };

    renderer.render(frame);

    this.frameAccum += dtMs;
    this.frameCount++;
    if (this.frameAccum >= 500) {
      this.fps = Math.round((this.frameCount * 1000) / this.frameAccum);
      this.frameAccum = 0;
      this.frameCount = 0;
      this.emitStatus(false);
    }

    this.publishDebug();
  };

  // ————————————————————————————————————————————————————————————
  // 诊断
  // ————————————————————————————————————————————————————————————

  private publishDebug(): void {
    const w = window as unknown as Record<string, unknown>;
    const prev = (w['__aqua'] as Record<string, unknown> | undefined) ?? {};
    w['__aqua'] = {
      ...prev,
      ready: true,
      frames: ((prev['frames'] as number) ?? 0) + 1,
      surface: this.surface,
      tabs: this.tabs.length,
      creatures: this.flock?.count ?? 0,
      hasTitles: this.hasTitles,
      theme: this.conf?.theme ?? null,
      // 验收脚本靠这几项算出该点哪里、以及点击有没有生效
      tankRect: this.renderer ? [...this.renderer.tankRect] : null,
      creaturePoses: this.renderer
        ? this.renderer.poses.map((p, i) => {
            const c = this.flock?.list[i];
            return {
              x: Number(p.x.toFixed(4)),
              y: Number(p.y.toFixed(4)),
              tabId: c?.tabId ?? -1,
              fade: Number((c?.fade ?? 0).toFixed(3)),
              hasTitle: !!(c?.title && c.title.length > 0),
            };
          })
        : [],
      activations: this.activations,
      lastActivatedTabId: this.lastActivatedTabId,
      renderer: this.renderer?.info.renderer ?? null,
      software: this.renderer?.info.software ?? false,
      fps: this.fps,
      error: this.error,
    };
  }

  private emitStatus(force: boolean): void {
    if (!this.onStatus) return;
    const now = performance.now();
    if (!force && now - this.lastStatusMs < 400) return;
    this.lastStatusMs = now;

    const conf = this.conf;
    this.onStatus({
      fps: this.fps,
      quality: conf?.quality ?? 'auto',
      renderScale:
        conf && this.renderer
          ? resolveQuality(conf.quality, this.renderer.info.software).renderScale
          : 1,
      software: this.renderer?.info.software ?? false,
      paused: this.paused,
      error: this.error,
      creatures: this.flock?.count ?? 0,
      tabs: this.tabs.length,
      hasTitles: this.hasTitles,
      demo: this.isDemo,
      storage: storageBackend(),
    });
  }
}
