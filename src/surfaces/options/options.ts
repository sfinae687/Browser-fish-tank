/**
 * 设置页。
 *
 * 表单是**数据驱动**的：一个控件 schema 描述所有字段，
 * 渲染、取值、写值共用一套逻辑。两个表面的配置项几乎完全一样，
 * 手写两遍就会立刻开始不一致。
 *
 * 左侧的实时预览不是装饰 —— 调不透明度、主题、构图这些东西，
 * 没有即时反馈就只能在盲调。
 */

import type { Config, SurfaceId } from '../../core/config.js';
import { effectiveSeed } from '../../core/config.js';
import {
  loadConfig,
  saveConfig,
  onConfigChanged,
  storageBackend,
  exportConfig,
  importConfig,
  resetConfig,
  loadWorldSnapshot,
} from '../../core/storage.js';
import { THEME_LABELS, paletteFor, type Palette } from '../../core/theme.js';
import { hashString, randomSeedString } from '../../core/rng.js';
import { msOfDay, warmthAt, lightDirectionAt } from '../../core/clock.js';
import { envView, type EnvView } from '../../core/world.js';
import { allocatePose, computeSchool, type SchoolPose } from '../../core/school.js';
import { createWorld, type WorldState } from '../../core/world.js';
import { encodeTank, decodeTank, describeTank, renderLineage } from '../../core/share.js';
import { saveWorldSnapshot } from '../../core/storage.js';

import type { RenderBudget } from '../../core/quality.js';
import { TankRenderer, type TankFrame } from '../../render/tank.js';

// ————————————————————————————————————————————————————————————
// 表单 schema
// ————————————————————————————————————————————————————————————

type Field =
  | { kind: 'toggle'; path: string; label: string; hint?: string }
  | {
      kind: 'select';
      path: string;
      label: string;
      hint?: string;
      options: ReadonlyArray<readonly [string, string]>;
    }
  | {
      kind: 'range';
      path: string;
      label: string;
      hint?: string;
      min: number;
      max: number;
      step: number;
      format: (v: number) => string;
    }
  | {
      kind: 'text';
      path: string;
      label: string;
      hint?: string;
      placeholder?: string;
      randomizable?: boolean;
    };

interface Section {
  title: string;
  note?: string;
  fields?: Field[];
  layersPrefix?: string;
  buttons?: ReadonlyArray<{ id: string; label: string; danger?: boolean }>;
}

interface Tab {
  id: string;
  label: string;
  surface: SurfaceId | null;
  sections: Section[];
}

const QUALITY_OPTIONS = [
  ['auto', '自动（按设备）'],
  ['high', '高'],
  ['medium', '中'],
  ['low', '低'],
] as const;

const FPS_OPTIONS = [
  ['60', '60 fps'],
  ['30', '30 fps'],
  ['15', '15 fps · 最省电'],
] as const;

const MOTION_OPTIONS = [
  ['full', '正常'],
  ['calm', '舒缓'],
  ['reduced', '很轻微'],
  ['still', '静帧（冻结）'],
] as const;

const FRAMING_OPTIONS = [
  ['fill', '铺满屏幕'],
  ['letterbox', '居中留边'],
  ['bottom', '贴底'],
  ['porthole', '圆窗'],
] as const;

const BACKGROUND_OPTIONS = [
  ['generative', '生成式图形背景'],
  ['tank', '暗色环境'],
  ['transparent', '完全透明'],
  ['page', '留给页面'],
] as const;

const POINTER_OPTIONS = [
  ['none', '不响应'],
  ['ripple', '涟漪'],
  ['full', '完整交互'],
] as const;

const BLEND_OPTIONS = [
  ['normal', '正常'],
  ['screen', '滤色（叠加更亮）'],
  ['multiply', '正片叠底'],
  ['luminosity', '明度'],
] as const;

const ANCHOR_OPTIONS = [
  ['center', '居中'],
  ['top', '顶部'],
  ['bottom', '底部'],
] as const;

const THEME_OPTIONS = (['reef', 'planted', 'blackwater', 'lagoon', 'abyss'] as const).map(
  (t) => [t, THEME_LABELS[t]] as const,
);

/** 两个表面的字段完全同构，只是前缀不同。 */
function surfaceSections(prefix: string, which: SurfaceId): Section[] {
  const isOverlay = which === 'overlay';
  return [
    {
      title: '开关与风格',
      note: isOverlay
        ? '覆盖层默认是「网页上一层几乎看不见的水影」。想让它更实体，把不透明度调高、混合模式改成「正常」。'
        : '新标签页是主缸，默认使用完整画质和开场生长动画。',
      fields: [
        { kind: 'toggle', path: `${prefix}.enabled`, label: '启用这个表面' },
        {
          kind: 'select',
          path: `${prefix}.theme`,
          label: '主题',
          hint: '主题决定水体与光线的基调，具体色相还会被种子再扰动一次',
          options: THEME_OPTIONS,
        },
        {
          kind: 'select',
          path: `${prefix}.background`,
          label: '缸外背景',
          options: BACKGROUND_OPTIONS,
        },
      ],
    },
    {
      title: '呈现',
      fields: [
        {
          kind: 'range',
          path: `${prefix}.opacity`,
          label: '不透明度',
          hint: isOverlay ? '0.35 左右是最舒服的「水影」' : '主缸一般保持 1.0',
          min: 0,
          max: 1,
          step: 0.01,
          format: (v) => `${Math.round(v * 100)}%`,
        },
        {
          kind: 'select',
          path: `${prefix}.blendMode`,
          label: '混合模式',
          hint: '覆盖层用「滤色」能透出下面的网页',
          options: BLEND_OPTIONS,
        },
        { kind: 'select', path: `${prefix}.framing`, label: '构图', options: FRAMING_OPTIONS },
        {
          kind: 'range',
          path: `${prefix}.zoom`,
          label: '缩放',
          min: 0.5,
          max: 2.5,
          step: 0.01,
          format: (v) => `${v.toFixed(2)}×`,
        },
        {
          kind: 'select',
          path: `${prefix}.anchor`,
          label: '对齐',
          hint: '仅在非「贴底」构图下生效',
          options: ANCHOR_OPTIONS,
        },
      ],
    },
    {
      title: '图层',
      note: '关掉用不到的层可以省电。玻璃层是最能卖出「缸」而不是「水下图」的一层 —— 除非有特别理由，别关它。',
      layersPrefix: prefix,
    },
    {
      title: '动态与性能',
      fields: [
        { kind: 'select', path: `${prefix}.quality`, label: '画质', options: QUALITY_OPTIONS },
        {
          kind: 'select',
          path: `${prefix}.fpsCap`,
          label: '帧率上限',
          options: FPS_OPTIONS,
        },
        {
          kind: 'range',
          path: `${prefix}.pixelRatioCap`,
          label: '像素比上限',
          hint: '视网膜屏上按 3 倍渲染是 9 倍的像素量，收益极小',
          min: 1,
          max: 3,
          step: 0.5,
          format: (v) => `${v.toFixed(1)}×`,
        },
        { kind: 'select', path: `${prefix}.motion`, label: '动效', options: MOTION_OPTIONS },
        {
          kind: 'toggle',
          path: `${prefix}.followClock`,
          label: '跟随真实昼夜',
          hint: '关掉会固定成正午的光照',
        },
        ...(which === 'newtab'
          ? [
              {
                kind: 'toggle' as const,
                path: `${prefix}.intro`,
                label: '开场生长动画',
                hint: '每次打开新标签页，看它从种子重新长一遍',
              },
            ]
          : []),
      ],
    },
    {
      title: '交互',
      fields: [
        {
          kind: 'select',
          path: `${prefix}.interaction.pointer`,
          label: '指针响应',
          options: POINTER_OPTIONS,
        },
        {
          kind: 'toggle',
          path: `${prefix}.interaction.clickThrough`,
          label: '点击穿透',
          hint: '开启后鼠标事件会落到下面的网页上',
        },
        {
          kind: 'toggle',
          path: `${prefix}.interaction.feeding`,
          label: '允许投食',
          hint: 'P5 起生效',
        },
      ],
    },
    {
      title: '世界',
      note: '默认两个表面共享同一个世界 —— 你在新标签页喂的鱼，覆盖层里也是同一条。要让它变成不相干的两个世界，就打开下面的开关并填一个新种子。',
      fields: [
        {
          kind: 'toggle',
          path: `${prefix}.separateSeed`,
          label: '使用独立种子',
        },
        {
          kind: 'text',
          path: `${prefix}.seed`,
          label: '这个表面的种子',
          placeholder: '留空则跟随共享种子',
          randomizable: true,
        },
      ],
    },
  ];
}

const TABS: Tab[] = [
  {
    id: 'world',
    label: '共享世界',
    surface: null,
    sections: [
      {
        title: '世界种子',
        note: '一个种子字符串就是这一缸。同样的种子会算出完全一样的鱼缸 —— 换一个就换一片海。',
        fields: [
          {
            kind: 'text',
            path: 'world.seed',
            label: '种子',
            randomizable: true,
          },
          {
            kind: 'toggle',
            path: 'world.shared',
            label: '两个表面共享同一个世界',
          },
        ],
      },
      {
        title: '生态',
        fields: [
          {
            kind: 'toggle',
            path: 'world.ecology',
            label: '启用生态模拟',
            hint: '能量、营养循环、种群涨落。P4 起生效。',
          },
          {
            kind: 'range',
            path: 'world.timeScale',
            label: '时间流速',
            min: 0.1,
            max: 20,
            step: 0.1,
            format: (v) => `${v.toFixed(1)}×`,
          },
        ],
      },
    ],
  },
  { id: 'newtab', label: '新标签页', surface: 'newtab', sections: surfaceSections('surfaces.newtab', 'newtab') },
  { id: 'overlay', label: '页面覆盖层', surface: 'overlay', sections: surfaceSections('surfaces.overlay', 'overlay') },
  {
    id: 'global',
    label: '全局',
    surface: null,
    sections: [
      {
        title: '无障碍与省电',
        fields: [
          {
            kind: 'toggle',
            path: 'respectReducedMotion',
            label: '尊重「减少动态效果」系统设置',
            hint: '开启时，系统偏好会覆盖上面的动效设置',
          },
          {
            kind: 'toggle',
            path: 'pauseWhenHidden',
            label: '标签页隐藏时暂停',
            hint: '强烈建议保持开启 —— 这是这个扩展最主要的一处省电',
          },
          {
            kind: 'toggle',
            path: 'debug',
            label: '调试模式',
            hint: '在新标签页常驻显示帧率、画质档位与种子',
          },
        ],
      },
    ],
  },
  {
    id: 'data',
    label: '数据',
    surface: null,
    sections: [
      {
        title: '鱼缸档案',
        note:
          '把这一缸**此刻**的样子编成一段字符串 —— 包含演化出来的基因组池与鱼群，' +
          '不只是种子。对方粘贴到「从下方导入」就能接着养。\n' +
          '只想分享起点的话，用地址栏的 ?seed= 更短。',
        buttons: [
          { id: 'tank-export', label: '导出鱼缸档案' },
          { id: 'tank-import', label: '从下方导入鱼缸' },
          { id: 'tank-copy', label: '复制档案' },
        ],
      },
      {
        title: '谱系',
        note: '基因组池里的亲子关系。● 表示还有活鱼在用，○ 表示这个基因组只留在池子里了。',
        buttons: [{ id: 'lineage', label: '显示谱系' }],
      },
      {
        title: '导入与导出',
        note: '导出的 JSON 里包含你的种子。把它发给别人，对方就能复现出你这一缸。',
        buttons: [
          { id: 'export', label: '导出到下方' },
          { id: 'import', label: '从下方导入' },
          { id: 'copy', label: '复制' },
          { id: 'reset', label: '恢复默认设置', danger: true },
        ],
      },
    ],
  },
];

// ————————————————————————————————————————————————————————————
// 路径读写
// ————————————————————————————————————————————————————————————

const isObj = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

function getPath(root: unknown, path: string): unknown {
  let cur: unknown = root;
  for (const key of path.split('.')) {
    if (!isObj(cur)) return undefined;
    cur = cur[key];
  }
  return cur;
}

function setPath(root: Record<string, unknown>, path: string, value: unknown): void {
  const parts = path.split('.');
  let cur: Record<string, unknown> = root;
  for (let i = 0; i < parts.length - 1; i++) {
    const key = parts[i] as string;
    if (!isObj(cur[key])) cur[key] = {};
    cur = cur[key] as Record<string, unknown>;
  }
  cur[parts[parts.length - 1] as string] = value;
}

// ————————————————————————————————————————————————————————————
// 实时预览
// ————————————————————————————————————————————————————————————

/**
 * 预览渲染器。
 *
 * 刻意不复用 AquariumRunner：runner 会自己去读存储、订阅变更，
 * 而预览要渲染的是**当前编辑中、可能还没保存**的配置。
 * 强行复用会让「拖滑块」和「写存储」互相打架。
 */
class Preview {
  private renderer: TankRenderer | null = null;
  private raf = 0;
  private time = 0;
  private lastMs = 0;
  private palette: Palette | null = null;
  private paletteKey = '';
  private config: Config | null = null;
  private surface: SurfaceId = 'newtab';
  private disposed = false;
  private frames = 0;
  /**
   * 从世界快照读来的环境状态。
   *
   * 设置页不推进世界（那是各表面自己的事），它只**读**最近一次快照，
   * 所以预览里看到的藻类密度和用户缸里正在发生的事是一致的。
   */
  private env: EnvView | null = null;
  /** 世界内的一天时刻（ms）。预览的昼夜要跟缸里一致，而不是跟「现在」。 */
  private worldMs: number | null = null;
  /**
   * 预览里也有鱼 —— 调配置时想看的就是最终效果。
   *
   * 用一个**独立的小世界**，而不是去读用户缸里的快照：设置页不该
   * 因为用户的缸正处于种群崩溃期就显示一缸死鱼。
   */
  private previewWorld: WorldState | null = null;
  private pose: SchoolPose | null = null;

  /** 预览用的固定预算：小画布，画质拉满才看得出真实效果 */
  private readonly budget: RenderBudget = {
    tier: 'medium',
    renderScale: 1,
    pixelRatio: 1,
    fpsCap: 30,
    detail: 2,
    bloom: true,
    bloomStrength: 0.5,
  };

  constructor(
    private readonly canvas: HTMLCanvasElement,
    private readonly onError: (message: string) => void,
    private readonly onEnv?: (env: EnvView | null) => void,
  ) {}

  start(): void {
    if (this.renderer) return;
    try {
      this.renderer = new TankRenderer(this.canvas);
    } catch (err) {
      this.onError(err instanceof Error ? err.message : String(err));
      return;
    }
    this.lastMs = performance.now();
    this.raf = requestAnimationFrame(this.loop);
  }

  update(config: Config, surface: SurfaceId): void {
    this.config = config;
    this.surface = surface;

    const seed = effectiveSeed(config, surface);
    const theme = config.surfaces[surface].theme;
    const key = `${theme}:${seed}`;
    if (key !== this.paletteKey) {
      this.paletteKey = key;
      this.palette = paletteFor(theme, seed);
      this.previewWorld = createWorld(seed, Date.now());
      this.pose = allocatePose(Math.max(16, this.previewWorld.fish.length + 8));
      this.pose.count = this.previewWorld.fish.length;
      void this.refreshWorld(seed);
    }
  }

  private async refreshWorld(seed: string): Promise<void> {
    const state = await loadWorldSnapshot(seed);
    this.env = state ? envView(state) : null;
    this.worldMs = state ? msOfDay(state.epochMs, state.tick) : null;
    this.onEnv?.(this.env);
  }

  private loop = (now: number): void => {
    if (this.disposed) return;
    this.raf = requestAnimationFrame(this.loop);

    const cfg = this.config;
    const palette = this.palette;
    const renderer = this.renderer;
    if (!cfg || !palette || !renderer) return;

    const dtMs = now - this.lastMs;
    if (dtMs < 30) return;
    this.lastMs = now - (dtMs % 30);
    this.time += Math.min(dtMs, 100) * 0.001;

    const sc = cfg.surfaces[this.surface];
    // 有快照就用**世界里的时刻**（那才是缸里正在发生的天色），
    // 没有快照才退回「现在」
    const worldMs = this.worldMs ?? msOfDay(Date.now(), 0);
    const light = sc.followClock
      ? {
          daylight: this.env?.light ?? 0.9,
          warmth: warmthAt(worldMs),
          dir: lightDirectionAt(worldMs),
        }
      : { daylight: 0.94, warmth: 0.1, dir: lightDirectionAt(12 * 3600000) };

    const frame: TankFrame = {
      time: this.time,
      intro: 1, // 预览跳过开场，直接看长成的样子
      daylight: light.daylight,
      warmth: light.warmth,
      lightDir: [light.dir.x, light.dir.y],
      algae: this.env?.algae ?? 0,
      heat: this.env?.heat ?? 0.4,
      // 设置页的预览给「长成」的状态：调配置时想看的是最终效果，不是生长过程
      growth: 1,
      school:
        this.pose && this.previewWorld
          ? (() => {
              const w = this.previewWorld as WorldState;
              const pose = this.pose as SchoolPose;
              pose.count = w.fish.length;
              computeSchool(w.fish, w.genomes, this.time, pose);
              return { genomes: w.genomes, seeds: w.fish, pose };
            })()
          : null,
      palette,
      layers: sc.layers,
      framing: sc.framing,
      background: sc.background,
      opacity: 1, // 不透明度靠 CSS 叠加显示，避免预览里「水变淡」看不出结构
      zoom: sc.zoom,
      anchor: sc.anchor,
      seed: hashString(effectiveSeed(cfg, this.surface)),
      budget: this.budget,
    };

    renderer.render(frame);

    // 与 runner 同样的就绪钩子，命名区分开以免互相覆盖。
    // 自动化脚本靠它确认预览真的画出来了，而不是只查 DOM 里有没有分区。
    this.frames++;
    if (typeof window !== 'undefined') {
      const w = window as unknown as { __aquaPreview?: Record<string, unknown> };
      if (!w.__aquaPreview) w.__aquaPreview = {};
      w.__aquaPreview['frames'] = this.frames;
      w.__aquaPreview['ready'] = this.frames >= 3;
    }
  };

  dispose(): void {
    this.disposed = true;
    cancelAnimationFrame(this.raf);
    this.renderer?.dispose();
    this.renderer = null;
  }
}

// ————————————————————————————————————————————————————————————
// DOM 构建
// ————————————————————————————————————————————————————————————

const $ = <T extends HTMLElement>(id: string): T => {
  const el = document.getElementById(id);
  if (!el) throw new Error(`缺少元素 #${id}`);
  return el as T;
};

const el = <K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className?: string,
  text?: string,
): HTMLElementTagNameMap[K] => {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
};

const LAYER_LABELS: ReadonlyArray<readonly [string, string, boolean]> = [
  ['backMurk', '远景水雾', false],
  ['hardscape', '硬景观', false],
  ['substrate', '底砂', false],
  ['flora', '水草珊瑚', false],
  ['fauna', '鱼群', false],
  ['particulates', '悬浮物', false],
  ['caustics', '焦散', false],
  ['godRays', '光柱', false],
  ['glass', '前玻璃', true],
  ['hud', '状态栏', false],
];

// ————————————————————————————————————————————————————————————
// 主流程
// ————————————————————————————————————————————————————————————

async function main(): Promise<void> {
  let config = await loadConfig();
  let activeTab = TABS[0] as Tab;

  const tabsEl = $('tabs');
  const sectionsEl = $('sections');
  const saveStateEl = $('save-state');
  const previewCanvas = $<HTMLCanvasElement>('preview-canvas');
  const previewError = $('preview-error');
  const previewWhich = $('preview-which');
  const previewSeed = $('preview-seed');
  const backendBadge = $('backend-badge');

  backendBadge.textContent = `存储：${
    { sync: '同步存储', local: '本地存储', web: '浏览器本地' }[storageBackend()]
  }`;

  // 预览里用 CSS 体现不透明度，让「水影」的观感也能预览到
  const preview = new Preview(previewCanvas, (msg) => {
    previewError.textContent = msg;
    previewError.hidden = false;
  });
  preview.start();

  // ——————— 保存（防抖）———————
  let saveTimer = 0;

  const setSaveState = (text: string, saved = false): void => {
    saveStateEl.textContent = text;
    saveStateEl.classList.toggle('is-saved', saved);
  };

  const scheduleSave = (): void => {
    setSaveState('保存中…');
    clearTimeout(saveTimer);
    saveTimer = window.setTimeout(() => {
      void saveConfig(config).then(
        () => setSaveState('已保存', true),
        (err: unknown) => setSaveState(`保存失败：${String(err)}`),
      );
    }, 160);
  };

  /** 当前/最近一次查看的、带 surface 的标签页 —— 世界、全局、数据页也要有预览对象 */
  let lastSurfaceTab: SurfaceId = 'newtab';

  const refreshPreview = (): void => {
    const surface = activeTab.surface ?? lastSurfaceTab;
    preview.update(config, surface);
    previewWhich.textContent =
      TABS.find((t) => t.surface === surface)?.label ?? '新标签页';
    previewSeed.textContent = effectiveSeed(config, surface);
    previewCanvas.style.opacity = String(
      activeTab.surface ? config.surfaces[surface].opacity : 1,
    );
  };

  /** 值变了之后的统一处理：更新预览、安排保存、必要时通知后台。 */
  const onChanged = (path: string): void => {
    if (activeTab.surface) lastSurfaceTab = activeTab.surface;
    refreshPreview();
    scheduleSave();

    if (path.startsWith('surfaces.overlay.enabled')) {
      void notifyOverlaySync();
    }
  };

  const notifyOverlaySync = async (): Promise<void> => {
    try {
      if (typeof chrome === 'undefined' || !chrome.runtime?.sendMessage) return;

      if (config.surfaces.overlay.enabled && chrome.permissions?.request) {
        // MV3 规定权限请求必须由用户手势触发。这个函数是在开关的 click
        // 处理链里同步调用的，所以 request 必须放在**第一个 await 之前** ——
        // 中间插一个 await 就有可能把用户手势耗尽，权限框就再也不弹了。
        const granted = await chrome.permissions.request({ origins: ['<all_urls>'] });
        if (!granted) {
          setSaveState('需要「在所有网站上读取和更改数据」权限才能启用覆盖层');
          // 权限被拒就把开关退回去，不要让界面显示一个做不到的状态
          config.surfaces.overlay.enabled = false;
          await saveConfig(config);
          renderAll();
          return;
        }
      }

      await chrome.runtime.sendMessage({ t: 'overlay.sync' });
    } catch {
      /* 网页预览模式下没有后台，忽略 */
    }
  };

  // ——————— 控件工厂 ———————

  const buildRange = (field: Extract<Field, { kind: 'range' }>): HTMLElement => {
    const wrap = el('div', 'range');
    const input = el('input');
    input.type = 'range';
    input.min = String(field.min);
    input.max = String(field.max);
    input.step = String(field.step);
    const out = el('span', 'range__value');

    const read = (): number => {
      const v = Number(getPath(config, field.path));
      return Number.isFinite(v) ? v : field.min;
    };

    const apply = (): void => {
      const v = read();
      input.value = String(v);
      out.textContent = field.format(v);
    };
    apply();

    input.addEventListener('input', () => {
      const v = Number(input.value);
      setPath(config as unknown as Record<string, unknown>, field.path, v);
      out.textContent = field.format(v);
      onChanged(field.path);
    });

    wrap.append(input, out);
    return wrap;
  };

  const buildSelect = (field: Extract<Field, { kind: 'select' }>): HTMLElement => {
    const select = el('select');
    for (const [value, label] of field.options) {
      const opt = el('option', undefined, label);
      opt.value = value;
      select.appendChild(opt);
    }
    const current = getPath(config, field.path);
    select.value = String(current ?? field.options[0]?.[0] ?? '');
    select.addEventListener('change', () => {
      const raw = select.value;
      // fpsCap 在配置里是数字，select 给的是字符串
      const value = field.path.endsWith('fpsCap') ? Number(raw) : raw;
      setPath(config as unknown as Record<string, unknown>, field.path, value);
      onChanged(field.path);
    });
    return select;
  };

  const buildToggle = (field: Extract<Field, { kind: 'toggle' }>): HTMLElement => {
    const btn = el('button', 'switch');
    btn.type = 'button';
    const on = Boolean(getPath(config, field.path));
    btn.classList.toggle('is-on', on);
    btn.setAttribute('role', 'switch');
    btn.setAttribute('aria-checked', String(on));
    btn.addEventListener('click', () => {
      const next = !btn.classList.contains('is-on');
      btn.classList.toggle('is-on', next);
      btn.setAttribute('aria-checked', String(next));
      setPath(config as unknown as Record<string, unknown>, field.path, next);
      onChanged(field.path);
    });
    return btn;
  };

  const buildText = (field: Extract<Field, { kind: 'text' }>): HTMLElement => {
    const wrap = el('div', 'field__control');
    const input = el('input');
    input.type = 'text';
    if (field.placeholder) input.placeholder = field.placeholder;
    input.value = String(getPath(config, field.path) ?? '');
    input.addEventListener('change', () => {
      setPath(config as unknown as Record<string, unknown>, field.path, input.value.trim());
      onChanged(field.path);
    });
    wrap.appendChild(input);

    if (field.randomizable) {
      const dice = el('button', 'btn', '随机');
      dice.type = 'button';
      dice.addEventListener('click', () => {
        const seed = randomSeedString();
        input.value = seed;
        setPath(config as unknown as Record<string, unknown>, field.path, seed);
        onChanged(field.path);
      });
      wrap.appendChild(dice);
    }
    return wrap;
  };

  const buildField = (field: Field): HTMLElement => {
    const row = el('div', 'field');
    const labelWrap = el('div', 'field__label');
    labelWrap.appendChild(el('div', 'field__name', field.label));
    if (field.hint) labelWrap.appendChild(el('div', 'field__hint', field.hint));
    row.appendChild(labelWrap);

    let control: HTMLElement;
    switch (field.kind) {
      case 'toggle':
        control = buildToggle(field);
        break;
      case 'select':
        control = buildSelect(field);
        break;
      case 'range':
        control = buildRange(field);
        break;
      case 'text':
        control = buildText(field);
        break;
    }

    row.appendChild(control);
    return row;
  };

  const buildLayers = (prefix: string): HTMLElement => {
    const wrap = el('div', 'layers');
    for (const [key, label, isStar] of LAYER_LABELS) {
      const path = `${prefix}.layers.${key}`;
      const chip = el('button', `chip${isStar ? ' chip--star' : ''}`, label);
      chip.type = 'button';
      const on = Boolean(getPath(config, path));
      chip.classList.toggle('is-on', on);
      chip.addEventListener('click', () => {
        const next = !chip.classList.contains('is-on');
        chip.classList.toggle('is-on', next);
        setPath(config as unknown as Record<string, unknown>, path, next);
        onChanged(path);
      });
      wrap.appendChild(chip);
    }
    return wrap;
  };

  const buildSection = (section: Section): HTMLElement => {
    const box = el('section', 'section');
    const head = el('div', 'section__head');
    head.appendChild(el('div', 'section__title', section.title));
    if (section.note) head.appendChild(el('div', 'section__note', section.note));
    box.appendChild(head);

    for (const field of section.fields ?? []) box.appendChild(buildField(field));
    if (section.layersPrefix) box.appendChild(buildLayers(section.layersPrefix));

    if (section.buttons) {
      const row = el('div', 'row-actions');
      for (const b of section.buttons) {
        const btn = el('button', `btn${b.danger ? ' btn--danger' : ''}`, b.label);
        btn.type = 'button';
        btn.dataset.action = b.id;
        row.appendChild(btn);
      }
      box.appendChild(row);
    }

    return box;
  };

  const buildDataArea = (): HTMLElement => {
    const wrap = el('div');
    wrap.style.padding = '0 17px 17px';
    const area = el('textarea', 'textarea');
    area.id = 'data-area';
    area.placeholder = '导出的配置会出现在这里；粘贴一份配置到这里再点「从下方导入」即可恢复。';
    wrap.appendChild(area);
    return wrap;
  };

  const handleAction = async (id: string): Promise<void> => {
    const area = document.getElementById('data-area') as HTMLTextAreaElement | null;

    // ——— 谱系 ———
    if (id === 'lineage') {
      if (!area) return;
      const seed = effectiveSeed(config, 'newtab');
      const state = await loadWorldSnapshot(seed);
      if (!state) {
        setSaveState('还没有缸 —— 先打开一次新标签页');
        return;
      }
      area.value = renderLineage(state);
      setSaveState('谱系已输出到下方', true);
      return;
    }

    // ——— 鱼缸档案 ———
    if (id === 'tank-export') {
      if (!area) return;
      const seed = effectiveSeed(config, 'newtab');
      const state = await loadWorldSnapshot(seed);
      if (!state) {
        setSaveState('还没有可导出的缸 —— 先打开一次新标签页');
        return;
      }
      area.value = encodeTank(state);
      setSaveState(`已导出：${describeTank(state)}`, true);
      return;
    }

    if (id === 'tank-import') {
      if (!area || !area.value.trim()) {
        setSaveState('文本框是空的');
        return;
      }
      const state = decodeTank(area.value);
      if (!state) {
        // 分享码会经过剪贴板、聊天软件、地址栏 —— 宁可拒绝也不要
        // 让一份被改坏的档案污染这一缸
        setSaveState('档案无效：可能被截断或改坏了');
        return;
      }
      await saveWorldSnapshot(state, Date.now());
      setSaveState(`已导入：${describeTank(state)}（刷新新标签页生效）`, true);
      return;
    }

    if (id === 'tank-copy') {
      try {
        let text = area?.value ?? '';
        if (!text.trim()) {
          const seed = effectiveSeed(config, 'newtab');
          const state = await loadWorldSnapshot(seed);
          if (state) text = encodeTank(state);
        }
        await navigator.clipboard.writeText(text);
        setSaveState('档案已复制到剪贴板', true);
      } catch {
        setSaveState('复制失败，请手动选中');
      }
      return;
    }

    switch (id) {
      case 'export':
        if (area) area.value = await exportConfig();
        break;
      // 注意：'export' 导出的是**配置**（主题、画质、构图），
      // 'tank-export' 导出的是**缸本身**。两件事，别混。
      case 'import': {
        if (!area || !area.value.trim()) {
          setSaveState('文本框是空的');
          return;
        }
        try {
          config = await importConfig(area.value);
          setSaveState('已导入', true);
          renderAll();
        } catch (err) {
          setSaveState(`导入失败：${err instanceof Error ? err.message : String(err)}`);
        }
        break;
      }
      case 'copy':
        if (area) {
          area.select();
          try {
            await navigator.clipboard.writeText(area.value || (await exportConfig()));
            setSaveState('已复制到剪贴板', true);
          } catch {
            setSaveState('复制失败，请手动选中');
          }
        }
        break;
      case 'reset': {
        config = await resetConfig(true);
        setSaveState('已恢复默认（保留了种子）', true);
        renderAll();
        break;
      }
    }
  };

  const renderTabs = (): void => {
    tabsEl.replaceChildren();
    for (const tab of TABS) {
      const btn = el('button', `tab${tab.id === activeTab.id ? ' is-active' : ''}`, tab.label);
      btn.type = 'button';
      btn.setAttribute('role', 'tab');
      btn.addEventListener('click', () => {
        activeTab = tab;
        renderTabs();
        renderSections();
      });
      tabsEl.appendChild(btn);
    }
  };

  const renderSections = (): void => {
    sectionsEl.replaceChildren();
    for (const section of activeTab.sections) sectionsEl.appendChild(buildSection(section));
    if (activeTab.id === 'data') sectionsEl.appendChild(buildDataArea());
    refreshPreview();
  };

  const renderAll = (): void => {
    renderTabs();
    renderSections();
  };

  // ——————— 按钮动作委托 ———————
  sectionsEl.addEventListener('click', (e) => {
    const target = (e.target as HTMLElement).closest('[data-action]');
    if (!target) return;
    const id = (target as HTMLElement).dataset.action;
    if (id) void handleAction(id);
  });

  // ——————— 外部变更 ———————
  onConfigChanged((next) => {
    config = next;
    renderAll();
  });

  renderAll();
  setSaveState('已保存', true);

  window.addEventListener('pagehide', () => preview.dispose(), { once: true });
}

main().catch((err) => {
  console.error('[计算水族箱] 设置页初始化失败', err);
  document.body.append(
    Object.assign(document.createElement('pre'), {
      textContent: `设置页初始化失败：\n${err instanceof Error ? err.stack : String(err)}`,
      style: 'padding:24px;color:#f0a094;white-space:pre-wrap;font-size:12px',
    }),
  );
});
