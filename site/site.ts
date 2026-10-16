/**
 * 展示页。
 *
 * ## 为什么画廊里的画布要「滚进视野才启动」
 *
 * 浏览器对同时存在的 WebGL 上下文有上限（Chrome 通常 16 个），
 * 而且每个上下文都占一份显存和一条 GPU 队列。这个页面有十几个画布，
 * 全部一起跑的结果是掉帧、发热，甚至后面几个直接拿不到上下文。
 *
 * 所以用一个 IntersectionObserver：**进入视野才建渲染器，离开就销毁**。
 * 于是任意时刻活着的上下文只有首屏那一个加当前看得见的那几个。
 *
 * ## 数据来自假标签页
 *
 * 这里没有 `chrome.tabs`，`createTabSource()` 会自动退回演示数据 ——
 * 也就是说这一页跑的是**和扩展里完全相同的渲染与运动代码**，
 * 只是生物的状态来自一批固定数据而不是你真实的标签页。
 */

import { TankRenderer } from '../src/render/tank.js';
import { Flock, makeCreature, type Creature } from '../src/core/creatures.js';
import { createMockTabSource, type TabInfo } from '../src/core/tabs.js';
import { paletteFor, type ThemeName } from '../src/core/theme.js';
import {
  OVERLAY_DEFAULTS,
  resolveQuality,
  type Backdrop,
  type Framing,
  type LayerToggles,
} from '../src/core/config.js';
import { SHAPES, SHAPE_NAMES, type ShapeName } from '../src/render/creature-mesh.js';

const ALL_LAYERS: LayerToggles = {
  surface: true,
  caustics: true,
  rays: true,
  snow: true,
  vignette: true,
  creatures: true,
  bloom: true,
};

interface ViewOptions {
  theme?: ThemeName;
  backdrop?: Backdrop;
  framing?: Framing;
  zoom?: number;
  maxCreatures?: number;
  creatureScale?: number;
  /** 只显示这一个体型（用于「六种生物」那一节） */
  onlyShape?: ShapeName;
  /** 这一节用几只 */
  count?: number;
  /**
   * 环境光与辉光的提亮倍率。
   *
   * ⚠️ 这是**展示页专用的补偿**，不是美术调整。
   *
   * 这套美术是为整屏设计的：画面里 90% 是近黑，靠大面积的暗去衬托
   * 少数亮点。缩到四五百像素的卡片里之后，那个「大面积」不存在了，
   * 只剩下黑 —— 卡片看起来就像坏了。
   *
   * 所以小尺寸的预览需要适度提亮，让它**在缩略尺寸下的观感**
   * 接近全屏时的观感。默认 1（不提亮）。
   */
  boost?: number;
  onRenderer?: (name: string) => void;
}

/**
 * 一块画布 + 一个渲染循环。
 *
 * 生命周期刻意做成 start/stop 而不是一次性的：画廊要在滚出视野时停掉，
 * 而重建渲染器的代价（编译着色器、分配渲染目标）比继续跑还大 ——
 * 所以是「保留实例、停掉循环」，只有真的离得很远才销毁。
 */
class TankView {
  private renderer: TankRenderer | null = null;
  private flock = new Flock({ maxCreatures: 18 });
  private tabs: TabInfo[] = [];
  private forced: Creature[] = [];
  private t = 0;
  private last = 0;
  private raf = 0;
  private running = false;
  private disposed = false;

  constructor(
    private readonly canvas: HTMLCanvasElement,
    private readonly opts: ViewOptions = {},
  ) {}

  async start(): Promise<void> {
    if (this.disposed || this.running) return;

    if (!this.renderer) {
      try {
        this.renderer = new TankRenderer(this.canvas, { alpha: false });
      } catch (err) {
        // 拿不到 WebGL 上下文时安静地留一块黑 —— 展示页不该因此报错弹窗
        console.warn('[深海] 无法创建渲染器', err);
        this.disposed = true;
        return;
      }
      this.opts.onRenderer?.(this.renderer.info.renderer);

      if (this.opts.onlyShape) {
        this.forced = this.buildForced();
      } else {
        const all = await createMockTabSource().list();
        this.tabs = all.slice(0, this.opts.count ?? all.length);
      }
    }

    this.running = true;
    this.last = performance.now();
    this.raf = requestAnimationFrame(this.loop);
  }

  stop(): void {
    this.running = false;
    cancelAnimationFrame(this.raf);
  }

  dispose(): void {
    this.stop();
    this.disposed = true;
    this.renderer?.dispose();
    this.renderer = null;
  }

  /** 「六种生物」那一节：只放这个体型的两只，放大看清楚。 */
  private buildForced(): Creature[] {
    const shape = this.opts.onlyShape as ShapeName;
    const out: Creature[] = [];
    for (let i = 0; i < (this.opts.count ?? 2); i++) {
      const c = makeCreature({
        id: 8000 + i * 977,
        tabId: -1,
        title: '',
        pinned: false,
        audible: false,
        discarded: false,
        active: i === 0,
      });
      // 体型是按 id 派生的，这里为了展示强行指定
      c.shape = shape;
      c.schooling = 0;
      c.homeX = 0.32 + i * 0.36;
      c.homeY = 0.42 + (i % 2) * 0.14;
      c.fade = 1;
      c.energy = 1;
      out.push(c);
    }
    return out;
  }

  private loop = (now: number): void => {
    if (!this.running) return;
    this.raf = requestAnimationFrame(this.loop);
    const r = this.renderer;
    if (!r) return;

    const dt = Math.min(0.1, (now - this.last) / 1000);
    this.last = now;
    this.t += dt;

    // 展示页一律用中档：首屏要好看，但十几个画布不能都按高画质跑
    const quality = resolveQuality('medium', r.info.software);
    r.resizeToDisplay(quality.renderScale);

    // 小尺寸预览的补偿：见 boost 的说明
    const boost = this.opts.boost ?? 1;
    const base = paletteFor(this.opts.theme ?? 'abyss');
    const palette = boost === 1 ? base : {
      ...base,
      ambient: base.ambient * boost,
      bloom: base.bloom * (1 + (boost - 1) * 0.6),
      waterTop: [
        base.waterTop[0] * (1 + (boost - 1) * 0.8),
        base.waterTop[1] * (1 + (boost - 1) * 0.8),
        base.waterTop[2] * (1 + (boost - 1) * 0.8),
      ] as const,
    };

    let creatures: readonly Creature[];
    if (this.opts.onlyShape) {
      creatures = this.forced;
    } else {
      this.flock.setMax(this.opts.maxCreatures ?? 18);
      this.flock.sync(this.tabs, dt);
      creatures = this.flock.list;
    }

    markReady(this);
    r.render({
      time: this.t,
      intro: Math.min(1, this.t / 1.4),
      palette,
      layers: ALL_LAYERS,
      quality,
      framing: this.opts.framing ?? 'letterbox',
      zoom: this.opts.zoom ?? 1,
      anchorY: 'center',
      opacity: 1,
      bloom: 1,
      creatures,
      creatureScale: this.opts.creatureScale ?? 0.62,
      backdrop: this.opts.backdrop ?? 'open',
    });
  };
}

// ————————————————————————————————————————————————————————————
// 建页面
// ————————————————————————————————————————————————————————————

/** 进入视野就启动，离开就停 —— 见文件头。 */
function attachVisibility(view: TankView, el: Element, margin = '220px'): void {
  const io = new IntersectionObserver(
    (entries) => {
      for (const e of entries) {
        if (e.isIntersecting) void view.start();
        else view.stop();
      }
    },
    { rootMargin: margin },
  );
  io.observe(el);
}

function pickRenderer(): void {
  const el = document.getElementById('foot-renderer');
  if (el) el.textContent = '';
  return;
}

/** 造一张卡片：标题 + 画布 + 说明。 */
function makeCard(
  host: HTMLElement,
  opts: {
    title: string;
    note: string;
    theme?: ThemeName;
    backdrop?: Backdrop;
    onlyShape?: ShapeName;
    count?: number;
    creatureScale?: number;
    framing?: Framing;
    boost?: number;
  },
): void {
  const card = document.createElement('div');
  card.className = 'card';

  const head = document.createElement('div');
  head.className = 'card__title';
  const b = document.createElement('b');
  b.textContent = opts.title;
  const note = document.createElement('span');
  note.textContent = opts.note;
  head.append(b, note);

  const canvas = document.createElement('canvas');
  canvas.className = 'frame__canvas';
  canvas.style.aspectRatio = opts.onlyShape ? '4 / 3' : '16 / 10';

  card.append(head, canvas);
  host.appendChild(card);

  const view = new TankView(canvas, {
    theme: opts.theme,
    backdrop: opts.backdrop,
    onlyShape: opts.onlyShape,
    count: opts.count,
    creatureScale: opts.creatureScale ?? 1.0,
    boost: opts.boost ?? 1.45,
    // ⚠️ 小画布要用**铺满**而不是居中构图。
    //
    // 居中构图会把缸缩成卡片中间的一小块，于是画面的亮部（水面附近）
    // 只占很小一片，整张卡片读起来就是一片黑。卡片自己有边框，
    // 不需要再靠留白来「装裱」。
    framing: opts.framing ?? 'fill',
    zoom: opts.onlyShape ? 1.35 : 1,
    maxCreatures: 8,
    onRenderer: pickRenderer,
  });
  attachVisibility(view, card);
}

const THEME_CARDS: Array<{ theme: ThemeName; title: string; note: string }> = [
  { theme: 'abyss', title: '深渊', note: '近黑水体 · 青色辉光' },
  { theme: 'vent', title: '热泉', note: '黑水 · 琥珀色' },
  { theme: 'aurora', title: '极光', note: '黑水 · 绿与紫' },
  { theme: 'moonlit', title: '月夜', note: '银蓝 · 最亮的一档' },
];

const BACKDROP_CARDS: Array<{ backdrop: Backdrop; title: string; note: string }> = [
  { backdrop: 'open', title: '开阔水域', note: '什么都不画，最安静' },
  { backdrop: 'trench', title: '海沟', note: '远处一道黑压压的崖壁' },
  { backdrop: 'snowfield', title: '沉降雪原', note: '密集的有机碎屑缓缓落下' },
  { backdrop: 'vent', title: '热泉喷口', note: '几缕上升的黑烟' },
  { backdrop: 'ruins', title: '遗迹', note: '几根倾颓的柱子' },
];

const SPECIES_CARDS: Array<{ shape: ShapeName; title: string; note: string }> = [
  { shape: 'lantern', title: '灯笼鱼', note: '细长鱼雷形 · 成群巡航' },
  { shape: 'hatchet', title: '斧头鱼', note: '短而高 · 悬停' },
  { shape: 'angler', title: '鮟鱇', note: '圆胖 · 守株待兔' },
  { shape: 'ribbon', title: '深海带鱼', note: '长条 · 随水漂移' },
  { shape: 'moonjelly', title: '海月水母', note: '扁伞 · 触手细而多' },
  { shape: 'lighthouse', title: '灯塔水母', note: '钟形伞 · 触手少而粗' },
];

function buildGallery(): void {
  const themes = document.getElementById('themes');
  if (themes) {
    for (const t of THEME_CARDS) {
      // 生物尺寸给大一档：卡片只有四百来像素宽，
      // 按全屏的尺寸放进去就成了一点点影子
      makeCard(themes, {
        theme: t.theme,
        title: t.title,
        note: t.note,
        count: 7,
        creatureScale: 1.05,
      });
    }
  }

  const backdrops = document.getElementById('backdrops');
  if (backdrops) {
    for (const b of BACKDROP_CARDS) {
      makeCard(backdrops, {
        theme: 'abyss',
        backdrop: b.backdrop,
        title: b.title,
        note: b.note,
        count: 6,
        creatureScale: 1.05,
      });
    }
  }

  const species = document.getElementById('species');
  if (species) {
    for (const s of SPECIES_CARDS) {
      makeCard(species, {
        onlyShape: s.shape,
        title: s.title,
        note: s.note,
        count: 2,
        creatureScale: 0.95,
      });
    }
  }
}

/** 首屏。它一直跑，而且给足画质 —— 第一印象只有一次。 */
async function startHero(): Promise<void> {
  const canvas = document.getElementById('hero-tank') as HTMLCanvasElement | null;
  if (!canvas) return;

  const view = new TankView(canvas, {
    theme: 'abyss',
    backdrop: 'trench',
    framing: 'fill',
    maxCreatures: 20,
    creatureScale: 0.66,
    onRenderer: (name) => {
      const el = document.getElementById('foot-renderer');
      if (el) el.textContent = name;
    },
  });

  // 首屏不进 IntersectionObserver：它一开始就在视野里
  await view.start();

  // 滚过首屏就停掉它 —— 后面还有十几个画布要抢 GPU
  const io = new IntersectionObserver(
    (entries) => {
      for (const e of entries) {
        if (e.isIntersecting) void view.start();
        else view.stop();
      }
    },
    { threshold: 0.05 },
  );
  io.observe(canvas);
}

/**
 * 就绪标记。
 *
 * 展示页在一个没有 chrome.* API 的环境里跑，和扩展里是两条不同的路径 ——
 * 所以它需要自己的端到端检查，不能靠「扩展能跑」推断。
 * 这里往 window 上写一个统一的标记，截图工具据此判断「画布真的出图了」。
 */
function markReady(view: TankView): void {
  void view;
  const w = window as unknown as Record<string, unknown>;
  // 和扩展页用**同一个**诊断对象名。展示页是另一条代码路径，
  // 但它不该有自己的一套就绪约定 —— 「不同页面等不同的标记」
  // 是那种加一个页面就要改一次工具链的设计。
  const prev = (w['__aqua'] as Record<string, unknown> | undefined) ?? {};
  const frames = ((prev['frames'] as number) ?? 0) + 1;
  w['__aqua'] = { ...prev, frames, ready: frames >= 3, surface: 'site' };
}

function main(): void {
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', run, { once: true });
  } else {
    run();
  }
}

function run(): void {
  buildGallery();
  void startHero();

  // 仓库地址从 meta 里取不到就留占位 —— 免得写死一个假链接
  const link = document.getElementById('repo-link') as HTMLAnchorElement | null;
  if (link) {
    const url = document.querySelector('meta[name="repo-url"]')?.getAttribute('content');
    if (url) link.href = url;
  }

  void OVERLAY_DEFAULTS;
  void SHAPE_NAMES;
  void SHAPES;
}

main();
