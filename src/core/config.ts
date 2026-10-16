/**
 * 配置模型。
 *
 * 拆成两层，这是用户明确要求「两个位置独立配置」后的必然结果：
 *
 *   SharedWorldConfig   同一个世界：种子、基因组池、生态状态
 *   SurfaceConfig       每个表面各一份：怎么**呈现**这个世界
 *
 * 默认共享世界（你在新标签页喂的鱼，覆盖层里也是同一条），
 * 但每个表面怎么画它完全独立 —— 新标签页可以是耀眼的礁石，
 * 覆盖层可以只是网页上一层几乎看不见的水影。
 *
 * @see DESIGN.md §1
 */

import { normalizeSeed, randomSeedString } from './rng.js';

export type SurfaceId = 'newtab' | 'overlay';

export const SURFACE_IDS: readonly SurfaceId[] = ['newtab', 'overlay'];

export type Quality = 'auto' | 'low' | 'medium' | 'high';
export type Framing = 'fill' | 'letterbox' | 'bottom' | 'porthole';
export type BackgroundMode = 'tank' | 'generative' | 'transparent' | 'page';
export type MotionMode = 'full' | 'calm' | 'reduced' | 'still';
export type PointerMode = 'none' | 'ripple' | 'full';
export type BlendMode = 'normal' | 'screen' | 'multiply' | 'luminosity';

export interface LayerToggles {
  backMurk: boolean;
  hardscape: boolean;
  substrate: boolean;
  flora: boolean;
  fauna: boolean;
  particulates: boolean;
  caustics: boolean;
  godRays: boolean;
  /** ⭐ 最能卖出「缸」而不是「水下图」的一层。见 DESIGN.md §3.2 */
  glass: boolean;
  hud: boolean;
}

export interface SurfaceConfig {
  enabled: boolean;

  // —— 画质与性能 ——
  quality: Quality;
  fpsCap: 15 | 30 | 60;
  pixelRatioCap: number;

  // —— 呈现 ——
  opacity: number;
  blendMode: BlendMode;
  framing: Framing;
  zoom: number;
  anchor: 'top' | 'center' | 'bottom';

  // —— 风格（两个表面完全独立）——
  theme: import('./theme.js').ThemeName;
  background: BackgroundMode;
  /** 为 true 时这个表面用独立种子，变成一个不相干的世界 */
  separateSeed: boolean;
  /** separateSeed 生效时使用 */
  seed: string;

  // —— 图层 ——
  layers: LayerToggles;

  // —— 动态 ——
  motion: MotionMode;
  followClock: boolean;
  /** 开场生长动画 */
  intro: boolean;

  // —— 交互 ——
  interaction: {
    pointer: PointerMode;
    clickThrough: boolean;
    feeding: boolean;
  };
}

export interface Config {
  version: number;
  world: {
    /** 共享世界的种子 */
    seed: string;
    /** 是否让两个表面共享同一个世界 */
    shared: boolean;
    /** 生态模拟开关（P4 起生效） */
    ecology: boolean;
    /** 时间流速倍率 */
    timeScale: number;
  };
  surfaces: Record<SurfaceId, SurfaceConfig>;
  /** 无障碍与省电 */
  respectReducedMotion: boolean;
  pauseWhenHidden: boolean;
  debug: boolean;
}

export const CONFIG_VERSION = 1;

/**
 * 覆盖层的默认值刻意保守。
 *
 * 它应该像窗玻璃上的一层水影，而不是一块糊住网页的贴纸。
 */
export const OVERLAY_DEFAULTS: SurfaceConfig = {
  enabled: false,
  quality: 'low',
  fpsCap: 30,
  pixelRatioCap: 1.5,
  opacity: 0.35,
  blendMode: 'screen',
  framing: 'fill',
  zoom: 1,
  anchor: 'center',
  theme: 'lagoon',
  background: 'transparent',
  separateSeed: false,
  seed: '',
  layers: {
    backMurk: false,
    hardscape: false,
    substrate: false,
    flora: true,
    fauna: false,
    particulates: true,
    caustics: true,
    godRays: true,
    glass: false,
    hud: false,
  },
  motion: 'calm',
  followClock: true,
  intro: false,
  interaction: {
    pointer: 'none',
    clickThrough: true,
    feeding: false,
  },
};

export const NEWTAB_DEFAULTS: SurfaceConfig = {
  enabled: true,
  quality: 'auto',
  fpsCap: 60,
  pixelRatioCap: 2,
  opacity: 1,
  blendMode: 'normal',
  framing: 'fill',
  zoom: 1,
  anchor: 'center',
  theme: 'reef',
  background: 'generative',
  separateSeed: false,
  seed: '',
  layers: {
    backMurk: true,
    hardscape: true,
    substrate: true,
    flora: true,
    fauna: true,
    particulates: true,
    caustics: true,
    godRays: true,
    glass: true,
    hud: true,
  },
  motion: 'full',
  followClock: true,
  intro: true,
  interaction: {
    pointer: 'full',
    clickThrough: false,
    feeding: true,
  },
};

export function defaultConfig(seed = randomSeedString()): Config {
  return {
    version: CONFIG_VERSION,
    world: {
      seed,
      shared: true,
      ecology: true,
      timeScale: 1,
    },
    surfaces: {
      newtab: structuredClone(NEWTAB_DEFAULTS),
      overlay: structuredClone(OVERLAY_DEFAULTS),
    },
    respectReducedMotion: true,
    pauseWhenHidden: true,
    debug: false,
  };
}

// ————————————————————————————————————————————————————————————
// 合并、迁移与校验
// ————————————————————————————————————————————————————————————

type Json = Record<string, unknown>;

const isPlainObject = (v: unknown): v is Json =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

/**
 * 深合并：只覆盖 `patch` 里显式给出的字段。
 *
 * 数组整体替换而不是逐项合并 —— 部分合并数组几乎总是错的。
 */
export function deepMerge<T>(base: T, patch: unknown): T {
  if (!isPlainObject(patch)) return base;
  if (!isPlainObject(base)) return patch as T;

  const out: Json = { ...base };
  for (const [key, value] of Object.entries(patch)) {
    if (value === undefined) continue;
    const prev = out[key];
    out[key] = isPlainObject(value) && isPlainObject(prev) ? deepMerge(prev, value) : value;
  }
  return out as T;
}

function clamp(v: unknown, lo: number, hi: number, fallback: number): number {
  return typeof v === 'number' && Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : fallback;
}

function oneOf<T extends string>(v: unknown, allowed: readonly T[], fallback: T): T {
  return typeof v === 'string' && (allowed as readonly string[]).includes(v) ? (v as T) : fallback;
}

function bool(v: unknown, fallback: boolean): boolean {
  return typeof v === 'boolean' ? v : fallback;
}

function sanitizeSurface(raw: unknown, fallback: SurfaceConfig): SurfaceConfig {
  const merged = deepMerge(fallback, raw);
  const l = deepMerge(fallback.layers, merged.layers);
  const i = deepMerge(fallback.interaction, merged.interaction);

  return {
    enabled: bool(merged.enabled, fallback.enabled),
    quality: oneOf(merged.quality, ['auto', 'low', 'medium', 'high'] as const, fallback.quality),
    fpsCap: (() => {
      const v = clamp(merged.fpsCap, 15, 60, fallback.fpsCap);
      return (v >= 60 ? 60 : v >= 30 ? 30 : 15) as 15 | 30 | 60;
    })(),
    pixelRatioCap: clamp(merged.pixelRatioCap, 1, 3, fallback.pixelRatioCap),
    opacity: clamp(merged.opacity, 0, 1, fallback.opacity),
    blendMode: oneOf(
      merged.blendMode,
      ['normal', 'screen', 'multiply', 'luminosity'] as const,
      fallback.blendMode,
    ),
    framing: oneOf(
      merged.framing,
      ['fill', 'letterbox', 'bottom', 'porthole'] as const,
      fallback.framing,
    ),
    zoom: clamp(merged.zoom, 0.4, 3, fallback.zoom),
    anchor: oneOf(merged.anchor, ['top', 'center', 'bottom'] as const, fallback.anchor),
    theme: oneOf(
      merged.theme,
      ['reef', 'planted', 'blackwater', 'lagoon', 'abyss'] as const,
      fallback.theme,
    ),
    background: oneOf(
      merged.background,
      ['tank', 'generative', 'transparent', 'page'] as const,
      fallback.background,
    ),
    separateSeed: bool(merged.separateSeed, fallback.separateSeed),
    seed: typeof merged.seed === 'string' ? merged.seed.slice(0, 64) : fallback.seed,
    layers: {
      backMurk: bool(l.backMurk, fallback.layers.backMurk),
      hardscape: bool(l.hardscape, fallback.layers.hardscape),
      substrate: bool(l.substrate, fallback.layers.substrate),
      flora: bool(l.flora, fallback.layers.flora),
      fauna: bool(l.fauna, fallback.layers.fauna),
      particulates: bool(l.particulates, fallback.layers.particulates),
      caustics: bool(l.caustics, fallback.layers.caustics),
      godRays: bool(l.godRays, fallback.layers.godRays),
      glass: bool(l.glass, fallback.layers.glass),
      hud: bool(l.hud, fallback.layers.hud),
    },
    motion: oneOf(
      merged.motion,
      ['full', 'calm', 'reduced', 'still'] as const,
      fallback.motion,
    ),
    followClock: bool(merged.followClock, fallback.followClock),
    intro: bool(merged.intro, fallback.intro),
    interaction: {
      pointer: oneOf(i.pointer, ['none', 'ripple', 'full'] as const, fallback.interaction.pointer),
      clickThrough: bool(i.clickThrough, fallback.interaction.clickThrough),
      feeding: bool(i.feeding, fallback.interaction.feeding),
    },
  };
}

/**
 * 接受任意来源的数据（存储里翻出来的、旧的、被手改坏的），
 * 产出一个一定合法的 Config。宁可退回默认值，也不要让一个坏字段崩掉整个渲染。
 */
export function sanitizeConfig(raw: unknown): Config {
  const base = defaultConfig();
  if (!isPlainObject(raw)) return base;
  const merged = deepMerge(base, raw);

  const seed =
    typeof merged.world?.seed === 'string' && merged.world.seed.trim()
      ? merged.world.seed.trim().slice(0, 64)
      : base.world.seed;

  return {
    version: CONFIG_VERSION,
    world: {
      seed,
      shared: bool(merged.world?.shared, base.world.shared),
      ecology: bool(merged.world?.ecology, base.world.ecology),
      timeScale: clamp(merged.world?.timeScale, 0.1, 20, base.world.timeScale),
    },
    surfaces: {
      newtab: sanitizeSurface(merged.surfaces?.newtab, NEWTAB_DEFAULTS),
      overlay: sanitizeSurface(merged.surfaces?.overlay, OVERLAY_DEFAULTS),
    },
    respectReducedMotion: bool(merged.respectReducedMotion, base.respectReducedMotion),
    pauseWhenHidden: bool(merged.pauseWhenHidden, base.pauseWhenHidden),
    debug: bool(merged.debug, base.debug),
  };
}

/**
 * 这个表面实际使用的种子。
 *
 * 共享世界模式下两个表面拿到同一个种子 —— 于是它们算出来的是同一个世界，
 * 只是渲染方式不同。这正是 DESIGN.md §3.1 那个「不需要仲裁者」的性质。
 */
export function effectiveSeed(config: Config, surface: SurfaceId): string {
  const sc = config.surfaces[surface];
  if (sc.separateSeed && sc.seed.trim()) return sc.seed.trim();
  return config.world.seed || 'default';
}

/** 用户手改了种子输入框里的内容时调用。 */
export function setSurfaceSeed(config: Config, surface: SurfaceId, input: string): void {
  const sc = config.surfaces[surface];
  sc.separateSeed = true;
  sc.seed = normalizeSeed(input);
}
