/**
 * 配置。
 *
 * ## 两个表面各自独立
 *
 * 新标签页和页面覆盖层是两件不同的东西，配置必须分开：
 * 新标签页是「主场」，通常要满、要亮；覆盖层是「客串」，
 * 通常要淡、要小、不能挡住正文。
 *
 * ## 和上一版最大的区别：这里没有「世界」
 *
 * 旧配置里有一大堆和模拟相关的旋钮（种子如何决定基因组、生态参数、
 * 繁殖阈值…）。这一版全部没有 —— 画面只由「主题 + 图层 + 构图」
 * 和**当前打开了哪些标签页**决定。
 */

import type { ThemeName } from './theme.js';
import { isThemeName } from './theme.js';

export type SurfaceId = 'newtab' | 'overlay';
export const SURFACE_IDS: readonly SurfaceId[] = ['newtab', 'overlay'];

export const SURFACE_LABELS: Record<SurfaceId, string> = {
  newtab: '新标签页',
  overlay: '页面覆盖层',
};

export type Quality = 'auto' | 'low' | 'medium' | 'high';

/** 构图。深海场景里「圆窗」这个选项意义不大，去掉了。 */
export type Framing = 'fill' | 'center' | 'letterbox';

export type AnchorY = 'top' | 'center' | 'bottom';

/**
 * 远景。
 *
 * 水体本身只有一个渐变，看久了会觉得「空」或者「平」。
 * 远景给画面一个**纵深参照物**，而且换一个就换一种气氛 ——
 * 这是性价比最高的一种「多变」。
 */
export type Backdrop = 'open' | 'trench' | 'snowfield' | 'vent' | 'ruins';

export const BACKDROP_LABELS: Record<Backdrop, string> = {
  open: '开阔水域 · 什么都没有，最安静',
  trench: '海沟 · 远处一道黑压压的崖壁',
  snowfield: '沉降雪原 · 密集的有机碎屑缓缓落下',
  vent: '热泉喷口 · 远处几缕上升的黑烟',
  ruins: '遗迹 · 远处倾颓的柱状轮廓',
};

export interface LayerToggles {
  /** 水面那条很淡的线 */
  surface: boolean;
  /** 只在顶部可见的焦散 */
  caustics: boolean;
  /** 从上方斜射的光柱 */
  rays: boolean;
  /** 悬浮微粒（海雪）。深色场景里性价比最高的一层 */
  snow: boolean;
  /** 暗角 */
  vignette: boolean;
  /** 发光生物。关掉就只剩一片安静的海 */
  creatures: boolean;
  /** 辉光。这套美术的造型手段，不建议关 */
  bloom: boolean;
}

export interface SurfaceConfig {
  /** 覆盖层是否启用。新标签页忽略这一项（它本身就是页面）。 */
  enabled: boolean;
  /** 整体不透明度 0..1 */
  opacity: number;
  framing: Framing;
  zoom: number;
  anchorY: AnchorY;
  theme: ThemeName;
  quality: Quality;
  /** 帧率上限。省电的关键 —— 深海不需要 60fps */
  fpsCap: number;
  /** 辉光强度倍率 */
  bloom: number;
  /** 同时最多显示多少只生物 */
  maxCreatures: number;
  /**
   * 生物尺寸倍率。
   *
   * 深海里的生物应该是**画面里的点缀**，不是主体。给大了会有压迫感，
   * 在覆盖层上尤其明显 —— 那是盖在别人网页上的东西，
   * 尺寸稍大一点就变成干扰。
   */
  creatureScale: number;
  /** 远景 */
  backdrop: Backdrop;
  layers: LayerToggles;

  // ——— 浏览器特色 ———
  /** 点击生物切换标签页 */
  clickToSwitch: boolean;
  /** 悬停显示标签页标题 */
  hoverTitles: boolean;
  /**
   * 演示模式：不读真实标签页，用一批假数据。
   * 用于「让别人看看长什么样」以及非扩展环境下的预览。
   */
  demoMode: boolean;
}

export interface Config {
  version: number;
  surfaces: Record<SurfaceId, SurfaceConfig>;
}

export const CONFIG_VERSION = 2;

const LAYERS_DEFAULT: LayerToggles = {
  surface: true,
  caustics: true,
  rays: true,
  snow: true,
  vignette: true,
  creatures: true,
  bloom: true,
};

/**
 * 新标签页的默认值：主场，给足画面。
 *
 * 帧率上限刻意设在 30 —— 深海是缓慢的场景，30fps 完全够，
 * 而一个每次开新标签页都跑满 60fps 的插件会很快被用户关掉。
 */
export const NEWTAB_DEFAULTS: SurfaceConfig = {
  enabled: true,
  opacity: 1,
  framing: 'fill',
  zoom: 1,
  anchorY: 'center',
  theme: 'abyss',
  // 默认就给高画质。这个场景的观感极度依赖细碎的辉光与微粒，
  // 省下来的那点帧率不值得让第一印象变差；真跑不动的机器
  // 会因为检测到软件光栅化而自动降档。
  quality: 'high',
  fpsCap: 30,
  bloom: 1,
  maxCreatures: 18,
  creatureScale: 0.62,
  backdrop: 'open',
  layers: { ...LAYERS_DEFAULT },
  clickToSwitch: true,
  hoverTitles: true,
  demoMode: false,
};

/**
 * 覆盖层的默认值：客串，克制。
 *
 * 透明度只有 0.55、生物更少、默认关掉光柱 —— 它是盖在别人网页上的，
 * 第一要务是**不打扰**。
 */
export const OVERLAY_DEFAULTS: SurfaceConfig = {
  enabled: false,
  opacity: 0.5,
  framing: 'center',
  zoom: 0.85,
  anchorY: 'bottom',
  theme: 'abyss',
  quality: 'medium',
  fpsCap: 24,
  // ⚠️ 覆盖层的辉光**恒为 0**，而且不提供开关。
  //
  // 辉光的本质是「往画面上加光」。盖在别人的网页上时，加光就是把正文
  // 冲淡 —— 一个美化插件没有任何理由让人读不清字。
  // 覆盖层只做一件事：**压暗**。见 §1.4。
  bloom: 0,
  maxCreatures: 9,
  // 覆盖层上的生物要比新标签页更小 —— 它是客串
  creatureScale: 0.42,
  backdrop: 'open',
  layers: { ...LAYERS_DEFAULT, rays: false, vignette: false, bloom: false },
  clickToSwitch: false,
  hoverTitles: false,
  demoMode: false,
};

export function defaultConfig(): Config {
  return {
    version: CONFIG_VERSION,
    surfaces: {
      newtab: { ...NEWTAB_DEFAULTS, layers: { ...LAYERS_DEFAULT } },
      overlay: {
        ...OVERLAY_DEFAULTS,
        layers: { ...LAYERS_DEFAULT, rays: false, vignette: false, bloom: false },
      },
    },
  };
}

export function defaultSurface(id: SurfaceId): SurfaceConfig {
  return id === 'newtab' ? NEWTAB_DEFAULTS : OVERLAY_DEFAULTS;
}

// ————————————————————————————————————————————————————————————
// 校验
// ————————————————————————————————————————————————————————————

const isObj = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

function num(v: unknown, lo: number, hi: number, fallback: number): number {
  if (typeof v !== 'number' || !Number.isFinite(v)) return fallback;
  return Math.min(hi, Math.max(lo, v));
}

function bool(v: unknown, fallback: boolean): boolean {
  return typeof v === 'boolean' ? v : fallback;
}

function pick<T extends string>(v: unknown, allowed: readonly T[], fallback: T): T {
  return typeof v === 'string' && (allowed as readonly string[]).includes(v) ? (v as T) : fallback;
}

function sanitizeLayers(raw: unknown, base: LayerToggles): LayerToggles {
  const r = isObj(raw) ? raw : {};
  const out = { ...base };
  for (const k of Object.keys(base) as Array<keyof LayerToggles>) {
    out[k] = bool(r[k], base[k]);
  }
  return out;
}

export function sanitizeSurface(raw: unknown, id: SurfaceId): SurfaceConfig {
  const base = defaultSurface(id);
  const r = isObj(raw) ? raw : {};
  return {
    enabled: bool(r['enabled'], base.enabled),
    opacity: num(r['opacity'], 0.05, 1, base.opacity),
    framing: pick(r['framing'], ['fill', 'center', 'letterbox'] as const, base.framing),
    zoom: num(r['zoom'], 0.4, 2.5, base.zoom),
    anchorY: pick(r['anchorY'], ['top', 'center', 'bottom'] as const, base.anchorY),
    theme: isThemeName(r['theme']) ? r['theme'] : base.theme,
    quality: pick(r['quality'], ['auto', 'low', 'medium', 'high'] as const, base.quality),
    // 帧率上限卡在 5..60：低于 5 看起来是卡死，高于 60 没意义
    fpsCap: Math.round(num(r['fpsCap'], 5, 60, base.fpsCap)),
    bloom: num(r['bloom'], 0, 2.5, base.bloom),
    maxCreatures: Math.round(num(r['maxCreatures'], 1, 40, base.maxCreatures)),
    creatureScale: num(r['creatureScale'], 0.25, 1.6, base.creatureScale),
    backdrop: pick(
      r['backdrop'],
      ['open', 'trench', 'snowfield', 'vent', 'ruins'] as const,
      base.backdrop,
    ),
    layers: sanitizeLayers(r['layers'], base.layers),
    clickToSwitch: bool(r['clickToSwitch'], base.clickToSwitch),
    hoverTitles: bool(r['hoverTitles'], base.hoverTitles),
    demoMode: bool(r['demoMode'], base.demoMode),
  };
}

/**
 * 把任意输入收拾成一份合法配置。
 *
 * 逐字段校验而不是整体丢弃：用户改坏了一个字段，不该让他丢掉其他所有设置。
 */
export function sanitizeConfig(raw: unknown): Config {
  const r = isObj(raw) ? raw : {};
  const surfaces = isObj(r['surfaces']) ? r['surfaces'] : {};
  const newtab = sanitizeSurface(surfaces['newtab'], 'newtab');
  const overlay = sanitizeSurface(surfaces['overlay'], 'overlay');

  // 覆盖层的辉光永远是 0，而且直接从图层里摘掉。
  // 这一条**不通过配置暴露** —— 见 OVERLAY_DEFAULTS 的说明：
  // 往别人的网页上加光是没有正当理由的，所以不给这个旋钮。
  overlay.bloom = 0;
  overlay.layers = { ...overlay.layers, bloom: false };

  return { version: CONFIG_VERSION, surfaces: { newtab, overlay } };
}

// ————————————————————————————————————————————————————————————
// 解析质量档位
// ————————————————————————————————————————————————————————————

export interface ResolvedQuality {
  /** 渲染缩放 0.5..1 */
  renderScale: number;
  /** 细节等级 0..2，影响着色器里的循环次数 */
  detail: 0 | 1 | 2;
}

/**
 * 把 `auto` 解析成具体档位。
 *
 * `auto` 只依据「是不是软件光栅化」判断 —— 更聪明的做法（按实测帧时
 * 动态升降）曾经有，但那需要一套测量与迟滞逻辑，而收益在真实使用里
 * 很小：这台机器要么一直跑得动，要么一直跑不动。
 *
 * 注意这里**不看帧率上限**。帧率是「多久画一帧」，画质是「一帧画多细」，
 * 两者没有关系 —— 把 fpsCap 当画质依据会让「设 30fps 省电」这种
 * 完全合理的操作莫名其妙地降画质。
 */
export function resolveQuality(quality: Quality, software: boolean): ResolvedQuality {
  if (quality === 'auto') {
    // 自动档只在「检测到软件光栅化」时降档。别的猜测（按核数、按内存）
    // 都不如这一条准，而且猜错的方向总是「降得太狠」——
    // 那会让第一印象变差，而用户不会知道是画质设置的问题。
    if (software) return { renderScale: 0.62, detail: 0 };
    return { renderScale: 1, detail: 2 };
  }
  if (quality === 'low') return { renderScale: 0.62, detail: 0 };
  if (quality === 'medium') return { renderScale: 0.85, detail: 1 };
  return { renderScale: 1, detail: 2 };
}

/** 供设置页显示：一份配置有多「重」。 */
export function configWeight(c: SurfaceConfig): number {
  let w = 0;
  if (c.layers.bloom) w += 3;
  if (c.layers.caustics) w += 1;
  if (c.layers.snow) w += 1;
  if (c.layers.rays) w += 1;
  if (c.layers.creatures) w += 2 + c.maxCreatures * 0.2;
  return w;
}
